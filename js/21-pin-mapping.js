"use strict";

/* =========================================================================
   PIN MAPPING — top-entity ports → EDGE Spartan-7 board pins, and the .xdc
   ========================================================================= */
/* The mapping lives on the project (state.project.pins), so Save/Open, undo and
   autosave all carry it without a line of their own:
     { clockMHz: 50, map: { <port>: { sig: "sw", lo: 0 } } }
   A port of width W on { sig, lo } takes board bits lo .. lo+W-1 of `sig`
   (lo is ignored for a scalar board signal such as clk). */
function pinState() {
	const p = state.project;
	if (!p.pins || typeof p.pins !== "object") p.pins = {};
	if (!p.pins.map || typeof p.pins.map !== "object") p.pins.map = {};
	if (!(p.pins.clockMHz > 0)) p.pins.clockMHz = BOARD_S7.defaultClockMHz;
	return p.pins;
}

/* The top entity's ports EXACTLY as the generator declares them — read back out of
   the generated entity itself rather than re-derived, so name dedup (foo / foo_1)
   and an OUT whose width grew from merge taps can never disagree with the .xdc. */
function topEntityPorts() {
	const top = state.project.schematics[state.project.topId];
	if (!top) return [];
	let code;
	try { code = generateSchVhdl(top).code; } catch (e) { return []; }
	return parseEntityPorts(code);
}
function parseEntityPorts(code) {
	const m = /\bentity\s+\w+\s+is\s+Port\s*\(([\s\S]*?)\);\s*end\b/i.exec(code || "");
	if (!m) return [];
	return m[1].split(";").map(s => s.trim()).filter(Boolean).map(decl => {
		const d = /^(\w+)\s*:\s*(in|out)\s+(STD_LOGIC_VECTOR\s*\(\s*(\d+)\s+downto\s+0\s*\)|STD_LOGIC)$/i.exec(decl);
		if (!d) return null;
		return { name: d[1], dir: d[2].toLowerCase(), width: d[4] !== undefined ? +d[4] + 1 : 1 };
	}).filter(Boolean);
}

/* Every (port bit, board bit) pair a mapping produces; bits that fall off the end of
   the board signal come back with pin null so the validator can name them. */
function portPinBits(port, m) {
	const s = m && boardSignal(m.sig);
	if (!s) return [];
	const out = [];
	for (let k = 0; k < port.width; k++) {
		const bi = s.bits ? (m.lo || 0) + k : 0;
		out.push({
			portBit: port.width > 1 ? `${port.name}[${k}]` : port.name,
			boardBit: boardBitName(s, bi),
			pin: (s.bits || k === 0) ? boardPin(s, bi) || null : null,
			sig: s,
		});
	}
	return out;
}
function mappingFits(port, m) {
	const s = m && boardSignal(m.sig);
	if (!s) return false;
	if (!s.bits) return port.width === 1;
	return (m.lo || 0) >= 0 && (m.lo || 0) + port.width <= s.bits.length;
}
function mapLabel(port, m) {
	const s = boardSignal(m.sig);
	if (!s) return m.sig;
	if (!s.bits) return s.name;
	const lo = m.lo || 0;
	return port.width > 1 ? `${s.name}[${lo + port.width - 1}:${lo}]` : `${s.name}[${lo}]`;
}

/* ---------- validation (feeds the Issues list) ---------- */
function pinIssues(ports) {
	ports = ports || topEntityPorts();
	const { map } = pinState();
	const issues = [];
	const ref = "Pin map (" + BOARD_S7.name + ")";
	const byPin = new Map();     // pin -> [{portBit, boardBit}]
	const usedSigs = new Map();  // board signal name -> port names on it
	ports.forEach(p => {
		const m = map[p.name];
		if (!m) { issues.push({ lvl: "err", msg: `พอร์ต '${p.name}' ยังไม่ได้กำหนดขาบนบอร์ด`, ref }); return; }
		const s = boardSignal(m.sig);
		if (!s) { issues.push({ lvl: "err", msg: `พอร์ต '${p.name}' ผูกกับ '${m.sig}' ซึ่งไม่มีบนบอร์ดนี้`, ref }); return; }
		if (!mappingFits(p, m)) {
			issues.push({ lvl: "err", msg: `พอร์ต '${p.name}' กว้าง ${p.width} bit แต่ ${mapLabel(p, m)} บนบอร์ดมีไม่พอ (${boardSigWidth(s)} bit) — ความกว้างไม่ตรงกัน`, ref });
			return;
		}
		if (p.dir === "out" && s.dir === "in")
			issues.push({ lvl: "warn", msg: `OUTPUT '${p.name}' ขับขา ${mapLabel(p, m)} ซึ่งต่อกับ${s.group}บนบอร์ด (เป็นขาเข้า) — สัญญาณจะชนกัน`, ref });
		if (p.dir === "in" && s.dir === "out")
			issues.push({ lvl: "warn", msg: `INPUT '${p.name}' อ่านจาก ${mapLabel(p, m)} ซึ่งเป็นขาออกของ${s.group} — ค่าที่อ่านได้ไม่มีความหมาย`, ref });
		if (!usedSigs.has(s.name)) usedSigs.set(s.name, []);
		usedSigs.get(s.name).push(p.name);
		portPinBits(p, m).forEach(b => {
			if (!byPin.has(b.pin)) byPin.set(b.pin, []);
			byPin.get(b.pin).push(b);
		});
	});
	byPin.forEach((list, pin) => {
		if (list.length < 2) return;
		issues.push({ lvl: "err", msg: `ขา ${pin} ถูกใช้ซ้ำ: ${list.map(b => `${b.portBit} → ${b.boardBit}`).join(", ")}`, ref });
	});
	// two board signals wired to the SAME package pins (LEDs under the 7-segment
	// display, the LCD bus, the TFT) — even with no bit actually shared, driving one
	// lights the other, so the pairing is worth a warning on its own
	const names = Array.from(usedSigs.keys());
	for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) {
		const sa = boardSignal(names[a]), sb = boardSignal(names[b]);
		const pa = new Set(sa.bits ? sa.bits.map(x => x.pin) : [sa.pin]);
		const shared = (sb.bits ? sb.bits.map(x => x.pin) : [sb.pin]).filter(x => pa.has(x));
		if (!shared.length) continue;
		issues.push({ lvl: "warn", msg: `'${sa.name}' (${sa.group}) กับ '${sb.name}' (${sb.group}) ใช้ขาร่วมกันบนบอร์ด (${shared.join(", ")}) — ใช้พร้อมกันแล้วอุปกรณ์หนึ่งจะติดตามอีกอันไปด้วย`, ref });
	}
	return issues;
}
/* runSynthesis() only asks once the user has started mapping — a schematic that
   never goes near the board should not grow a list of "unmapped port" errors */
function pinIssuesForSynthesis() {
	const p = state.project.pins;
	if (!p || !p.map || !Object.keys(p.map).length) return [];
	return pinIssues();
}

/* ---------- auto-map ---------- */
const PIN_ALIASES = {
	clock: "clk", clk_in: "clk", sysclk: "clk", sys_clk: "clk", mclk: "clk",
	btn: "pb", btns: "pb", button: "pb", buttons: "pb", push: "pb",
	leds: "led", ld: "led",
	switch: "sw", switches: "sw", sws: "sw",
	seg: "seven_segment", segs: "seven_segment", segment: "seven_segment", segments: "seven_segment", sseg: "seven_segment", seven_seg: "seven_segment",
	an: "digit", anode: "digit", anodes: "digit", digits: "digit",
	buzz: "buzzer", lcd_data: "data",
};
/* Fill every UNMAPPED port (existing choices are kept): first by name — clk, sw,
   led, pb[…], sw3 / led_2 for single bits — then whatever is left goes to the next
   free switches (inputs) or LEDs (outputs), in entity order. Returns how many
   ports it placed. */
function autoMapPins(ports) {
	ports = ports || topEntityPorts();
	const { map } = pinState();
	const taken = new Set();
	ports.forEach(p => { if (map[p.name]) portPinBits(p, map[p.name]).forEach(b => taken.add(b.pin)); });
	const free = (p, m) => mappingFits(p, m) && portPinBits(p, m).every(b => !taken.has(b.pin));
	const take = (p, m) => { map[p.name] = m; portPinBits(p, m).forEach(b => taken.add(b.pin)); placed++; };
	let placed = 0;
	const sigFor = n => boardSignal(PIN_ALIASES[n] || n);
	ports.forEach(p => {
		if (map[p.name]) return;
		const n = p.name.toLowerCase();
		let s = sigFor(n);
		if (s && free(p, { sig: s.name, lo: 0 })) { take(p, { sig: s.name, lo: 0 }); return; }
		const ix = /^([a-z_]*?[a-z])_?(\d+)$/.exec(n);   // sw3, led_2, pb0
		if (ix && p.width === 1) {
			s = sigFor(ix[1]);
			if (s && s.bits && free(p, { sig: s.name, lo: +ix[2] })) take(p, { sig: s.name, lo: +ix[2] });
		}
	});
	ports.forEach(p => {
		if (map[p.name]) return;
		const s = boardSignal(p.dir === "in" ? "sw" : "led");
		for (let lo = 0; lo + p.width <= s.bits.length; lo++) {
			if (free(p, { sig: s.name, lo })) { take(p, { sig: s.name, lo }); break; }
		}
	});
	return placed;
}

/* ---------- the .xdc ---------- */
/* Only the mapped ports go in (an unused line would otherwise reach Vivado as an
   unmatched get_ports — a CRITICAL WARNING), in entity order, one line per bit,
   in the same set_property -dict form as the board's own spartan7.xdc. */
function generateXdc(ports, topName) {
	ports = ports || topEntityPorts();
	const pins = pinState();
	if (topName === undefined) topName = sanId((state.project.schematics[state.project.topId] || {}).name || "top");
	const L = [
		`## Generated by Schematic Studio for the ${BOARD_S7.name} (${BOARD_S7.part})`,
		`## Top entity: ${topName}`,
		"",
	];
	const clocks = [];
	ports.forEach(p => {
		const m = pins.map[p.name];
		if (!m || !mappingFits(p, m)) return;
		const s = boardSignal(m.sig);
		L.push(`## ${p.name} -> ${mapLabel(p, m)} (${s.group})`);
		portPinBits(p, m).forEach(b => {
			const extra = s.pulldown ? " PULLDOWN true" : "";
			L.push(`set_property -dict { PACKAGE_PIN ${b.pin} IOSTANDARD LVCMOS33${extra} } [get_ports { ${b.portBit} }];`);
		});
		if (s.name === BOARD_S7.clockSig && p.width === 1) clocks.push(p.name);
	});
	if (clocks.length) {
		const period = (1000 / pins.clockMHz).toFixed(3);
		L.push("", `## ${pins.clockMHz} MHz board clock`);
		clocks.forEach(c => L.push(`create_clock -period ${period} -name sys_clk [get_ports { ${c} }];`));
	}
	L.push("",
		"## Configuration: 3.3 V bank, boot from the s25fl064l SPI flash in x4 mode",
		"set_property CFGBVS VCCO [current_design]",
		"set_property CONFIG_VOLTAGE 3.3 [current_design]",
		"set_property BITSTREAM.CONFIG.SPI_BUSWIDTH 4 [current_design]",
		"set_property CONFIG_MODE SPIx4 [current_design]",
		"set_property BITSTREAM.GENERAL.COMPRESS TRUE [current_design]",
		"");
	return L.join("\n");
}
function downloadText(name, text) {
	const b = new Blob([text], { type: "text/plain" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u; a.download = name; a.click();
	URL.revokeObjectURL(u);
}
function exportXdcFile() {
	const ports = topEntityPorts();
	if (!ports.length) { toast("top entity ยังไม่มีพอร์ต — เพิ่ม INPUT/OUTPUT ก่อน", "warn"); return; }
	const errs = pinIssues(ports).filter(i => i.lvl === "err");
	const fname = dlName(state.project.name || "project", ".xdc", "project");
	downloadText(fname, generateXdc(ports));
	if (errs.length) toast(`ดาวน์โหลด ${fname} แล้ว แต่ยังมีปัญหาขา ${errs.length} รายการ (ดูแท็บ Issues)`, "warn", 3600);
	else toast("Downloaded " + fname, "ok");
}

/* ---------- the Pins panel ---------- */
function pinOptionsFor(port, cur) {
	const groups = new Map();
	BOARD_S7.signals.forEach(s => {
		const opts = [];
		if (!s.bits) {
			if (port.width === 1) opts.push({ v: s.name, t: `${s.name} (${s.pin})` });
		} else if (port.width === 1) {
			s.bits.forEach(b => opts.push({ v: `${s.name}:${b.i}`, t: `${s.name}[${b.i}] (${b.pin})` }));
		} else {
			// a bus slot lists its package pins MSB first
			for (let lo = 0; lo + port.width <= s.bits.length; lo++) {
				const pinList = s.bits.slice(lo, lo + port.width).map(b => b.pin).reverse().join(" ");
				opts.push({ v: `${s.name}:${lo}`, t: `${s.name}[${lo + port.width - 1}:${lo}] (${pinList})` });
			}
		}
		if (!opts.length) return;
		if (!groups.has(s.group)) groups.set(s.group, []);
		groups.get(s.group).push(...opts);
	});
	const curV = cur ? (boardSignal(cur.sig) && boardSignal(cur.sig).bits ? `${cur.sig}:${cur.lo || 0}` : cur.sig) : "";
	let html = `<option value="">— ไม่ได้กำหนด —</option>`;
	let found = !curV;
	groups.forEach((opts, g) => {
		html += `<optgroup label="${esc(g)}">` + opts.map(o => {
			if (o.v === curV) found = true;
			return `<option value="${esc(o.v)}"${o.v === curV ? " selected" : ""}>${esc(o.t)}</option>`;
		}).join("") + `</optgroup>`;
	});
	// a saved choice that no longer fits (the port got wider) stays visible, flagged
	if (!found) html += `<option value="${esc(curV)}" selected>⚠ ${esc(mapLabel(port, cur))} (ไม่พอดี)</option>`;
	return html;
}
function renderPinPanel() {
	const root = $("#pinsPane");
	if (!root || root.classList.contains("hidden")) return;
	const ports = topEntityPorts();
	const pins = pinState();
	const topName = (state.project.schematics[state.project.topId] || {}).name || "top";
	const rows = ports.map(p => {
		const m = pins.map[p.name];
		return `<tr>
        <td class="pn" title="${esc(p.name)}">${esc(p.name)}${p.width > 1 ? `<span class="pw">[${p.width - 1}:0]</span>` : ""}</td>
        <td class="pd ${p.dir}">${p.dir === "in" ? "IN" : "OUT"}</td>
        <td><select data-pin-port="${esc(p.name)}">${pinOptionsFor(p, m)}</select></td>
      </tr>`;
	}).join("");
	const issues = ports.length ? pinIssues(ports) : [];
	const nErr = issues.filter(i => i.lvl === "err").length, nWarn = issues.length - nErr;
	root.innerHTML = `<div class="insp pins">
      <h3>ขาบนบอร์ด <span class="sub">${esc(BOARD_S7.name)} · ${esc(BOARD_S7.part)}</span></h3>
      <div class="row"><label>Top entity</label><span class="mono">${esc(sanId(topName))}</span></div>
      <div class="row"><label>Clock (MHz)</label><input type="number" id="pinClockMHz" min="1" max="800" step="any" value="${pins.clockMHz}"></div>
      <div class="pin-tools">
        <button class="btn" data-act="auto-pins" title="กำหนดขาที่ยังว่างตามชื่อ (clk, sw, led, pb…) ที่เหลือลง switch/LED">⚡ Auto-map</button>
        <button class="btn" data-act="clear-pins">ล้าง</button>
        <span class="grow"></span>
        <button class="btn" data-act="download-xdc">.xdc</button>
      </div>
      ${ports.length ? `<table class="pin-table"><tbody>${rows}</tbody></table>`
		: `<div class="empty">top entity ยังไม่มีพอร์ต — วาง INPUT/OUTPUT ใน schematic ก่อน</div>`}
      ${ports.length ? `<div class="pin-status ${nErr ? "err" : nWarn ? "warn" : "ok"}">${nErr ? `✕ ปัญหา ${nErr} รายการ` : "✓ กำหนดขาครบ"}${nWarn ? ` · ⚠ คำเตือน ${nWarn}` : ""}${issues.length ? ` — <a href="#" data-pin-issues>ดูใน Issues</a>` : ""}</div>` : ""}
    </div>`;
	root.querySelectorAll("select[data-pin-port]").forEach(sel => sel.addEventListener("change", ev => {
		const name = ev.target.dataset.pinPort, v = ev.target.value;
		if (!v) delete pins.map[name];
		else { const [sig, lo] = v.split(":"); pins.map[name] = lo === undefined ? { sig } : { sig, lo: +lo }; }
		snapshot(); renderPinPanel();
	}));
	$("#pinClockMHz").addEventListener("change", ev => {
		const v = +ev.target.value;
		if (v > 0) { pins.clockMHz = v; snapshot(); } else ev.target.value = pins.clockMHz;
	});
	root.querySelector("[data-pin-issues]")?.addEventListener("click", ev => {
		ev.preventDefault();
		renderErrors(issues);
		setRightTab("errors");
	});
}
