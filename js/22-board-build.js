"use strict";

/* =========================================================================
   BUILD & PROGRAM — through the local helper (helper/server.js → Vivado)
   ========================================================================= */
/* The page cannot start Vivado itself, so Build / Program SRAM / Program Flash go
   to a small server on 127.0.0.1:7357 that does (see helper/server.js). It wants
   the token it prints at start-up: opening http://127.0.0.1:7357/#token=… hands it
   over automatically, otherwise the page asks once and remembers it.
   With no helper running, Build falls back to a .zip of everything needed to run
   the same flow by hand (vhd + xdc + build.tcl + program.tcl + program.sh). */
const HELPER_PORT = 7357;
const HELPER_TOKEN_KEY = "schstudio.helperToken";
// served BY the helper (it adds this meta), the API is same-origin on whatever port
// it runs; opened from file:// or anywhere else, the helper is on its default port
const HELPER_URL = document.querySelector('meta[name="s2v-helper"]') ? "" : `http://127.0.0.1:${HELPER_PORT}`;

let helperToken = "";
try { helperToken = localStorage.getItem(HELPER_TOKEN_KEY) || ""; } catch (_) { }
(function takeTokenFromUrl() {
	const m = /(?:^#|&)token=([0-9a-f]{8,})/i.exec(location.hash || "");
	if (!m) return;
	helperToken = m[1];
	try { localStorage.setItem(HELPER_TOKEN_KEY, helperToken); } catch (_) { }
	history.replaceState(null, "", location.pathname + location.search);   // keep it out of the address bar
})();
function askHelperToken() {
	const t = prompt("ใส่ token ของ helper (แสดงในเทอร์มินัลตอนรัน node helper/server.js หรืออยู่ในไฟล์ ~/.schem2vhdl/token):", "");
	if (!t || !t.trim()) return false;
	helperToken = t.trim();
	try { localStorage.setItem(HELPER_TOKEN_KEY, helperToken); } catch (_) { }
	return true;
}

/* fetch that answers 403 by asking for the token once and trying again. A network
   failure (nothing listening) comes back as { offline: true } instead of throwing. */
async function helperFetch(pathName, opts = {}, retried) {
	let res;
	try {
		res = await fetch(HELPER_URL + pathName, {
			...opts,
			headers: { ...(opts.headers || {}), "X-S2V-Token": helperToken, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
		});
	} catch (e) {
		return { offline: true, error: e };
	}
	if (res.status === 403 && !retried && askHelperToken()) return helperFetch(pathName, opts, true);
	return { res };
}

/* read an SSE stream off a fetch() response, calling on[event](data) per event */
async function readSse(res, on) {
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	for (; ;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let i;
		while ((i = buf.indexOf("\n\n")) >= 0) {
			const block = buf.slice(0, i);
			buf = buf.slice(i + 2);
			let ev = "message";
			const data = [];
			block.split("\n").forEach(l => {
				if (l.startsWith("event: ")) ev = l.slice(7);
				else if (l.startsWith("data: ")) data.push(l.slice(6));
			});
			const raw = data.join("\n");
			let val = raw;
			if (ev !== "log") { try { val = JSON.parse(raw); } catch (_) { } }
			if (on[ev]) on[ev](val);
		}
	}
}

/* ---------- what gets built ---------- */
/* Everything Vivado needs from the page, or null after showing why not: the
   design checks and the pin map must both be free of errors first — a design
   Vivado would reject anyway should not cost a minute of build to find out. */
function collectBuildInputs() {
	const top = state.project.schematics[state.project.topId];
	if (!top) { toast("ไม่มี top entity", "err"); return null; }
	const ports = topEntityPorts();
	const issues = runSynthesis() || [];
	// pinIssuesForSynthesis() already added these once mapping started; add them here
	// regardless, an unmapped port is fatal for a bitstream
	const seen = new Set(issues.map(i => i.msg));
	pinIssues(ports).forEach(i => { if (!seen.has(i.msg)) issues.push(i); });
	const errs = issues.filter(i => i.lvl === "err");
	if (errs.length) {
		renderErrors(issues);
		setRightTab("errors");
		toast(`ยัง build ไม่ได้ — มี error ${errs.length} รายการ (ดูแท็บ Issues)`, "err", 3600);
		return null;
	}
	const all = generateAllVhdl();
	const files = {};
	Object.keys(all).forEach(k => {
		const entry = all[k];
		const code = typeof entry === "string" ? entry : (entry && entry.code) || "";
		let base = sanId(k.replace(/\*+$/, "")) || "entity", n = base, i = 2;
		while (files[n + ".vhd"]) n = base + "_" + (i++);
		files[n + ".vhd"] = code;
	});
	const topName = sanId(top.name) || "my_circuit";
	return { top: topName, files, xdc: generateXdc(ports, topName), ports };
}
/* what the page asked for, as Vivado names it in pins.json: { "sw[0]": "K11" } */
function expectedPins(ports) {
	const { map } = pinState();
	const out = {};
	ports.forEach(p => portPinBits(p, map[p.name]).forEach(b => { out[b.portBit] = b.pin; }));
	return out;
}

/* ---------- the Build panel ---------- */
const buildUi = { running: false, lastOk: false, lastResult: null, lines: 0 };
function buildLogClear() {
	const pre = $("#buildLog");
	if (pre) pre.textContent = "";
	buildUi.lines = 0;
}
function buildLog(line, cls) {
	const pre = $("#buildLog");
	if (!pre) return;
	if (buildUi.lines > 6000) pre.removeChild(pre.firstChild);   // keep the DOM bounded
	const span = document.createElement("span");
	span.className = cls || (/^(ERROR|S2V_ERROR)/.test(line) ? "e" : /^CRITICAL WARNING/.test(line) ? "c" : /^WARNING/.test(line) ? "w" : /^S2V_/.test(line) ? "s" : "");
	span.textContent = line + "\n";
	pre.appendChild(span);
	buildUi.lines++;
	const nearEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 80;
	if (nearEnd) pre.scrollTop = pre.scrollHeight;
}
function setBuildStatus(html, kind) {
	const el2 = $("#buildStatus");
	if (!el2) return;
	el2.className = "build-status " + (kind || "");
	el2.innerHTML = html;
}
function setBuildBusy(on) {
	buildUi.running = on;
	$$("#buildPane [data-act^='board-']").forEach(b => { b.disabled = on; });
}
function renderBuildSummary(r, ports) {
	const box = $("#buildSummary");
	if (!box) return;
	const u = r.utilization || {}, t = r.timing;
	const cell = x => x ? `${x.used} / ${x.avail} (${x.pct}%)` : "—";
	const want = expectedPins(ports || []);
	const got = r.pins || {};
	const wrong = Object.keys(want).filter(k => got[k] !== want[k]);
	box.innerHTML = `<table class="pin-table sum"><tbody>
      <tr><td>LUTs</td><td>${cell(u.luts)}</td></tr>
      <tr><td>Registers</td><td>${cell(u.regs)}</td></tr>
      <tr><td>I/O pins</td><td>${cell(u.iob)}</td></tr>
      <tr><td>Timing</td><td>${!t ? "—" : !t.constrained ? "ไม่มี clock constraint" : t.met ? `✓ ผ่าน (WNS ${esc(t.wns)} ns)` : `✕ ไม่ผ่าน (WNS ${esc(t.wns)} ns)`}</td></tr>
      <tr><td>Pins</td><td>${!r.pins ? "—" : wrong.length ? `✕ ไม่ตรง: ${esc(wrong.map(k => `${k} ${got[k] || "?"}≠${want[k]}`).join(", "))}` : `✓ ตรงกับที่กำหนด (${Object.keys(want).length} ขา)`}</td></tr>
      <tr><td>Critical</td><td>${r.criticalWarnings && r.criticalWarnings.length ? `⚠ ${r.criticalWarnings.length}` : "0"}</td></tr>
    </tbody></table>`;
}

async function boardBuild() {
	if (buildUi.running) return;
	const inp = collectBuildInputs();
	if (!inp) return;
	setRightTab("build");
	buildLogClear();
	$("#buildSummary").innerHTML = "";
	setBuildStatus("กำลังติดต่อ helper…");
	setBuildBusy(true);
	try {
		const { res, offline } = await helperFetch("/build", { method: "POST", body: JSON.stringify({ top: inp.top, files: inp.files, xdc: inp.xdc }) });
		if (offline) { helperOffline(inp); return; }
		if (!res.ok) { const j = await res.json().catch(() => ({})); setBuildStatus("✕ " + esc(j.error || res.status), "err"); toast("Build ไม่สำเร็จ: " + (j.error || res.status), "err", 4000); return; }
		const t0 = Date.now();
		let result = null;
		await readSse(res, {
			queued: q => setBuildStatus(q.ahead ? `รอคิว (ก่อนหน้า ${q.ahead} งาน)…` : "เริ่ม build…"),
			start: () => setBuildStatus("⏳ Vivado กำลัง build (synth → place → route → bitstream) ประมาณ 1 นาที…"),
			log: l => buildLog(l),
			done: r => { result = r; },
		});
		if (!result) { setBuildStatus("✕ การเชื่อมต่อขาดก่อน build เสร็จ", "err"); return; }
		buildUi.lastOk = result.ok;
		buildUi.lastResult = result;
		renderBuildSummary(result, inp.ports);
		const sec = Math.round((Date.now() - t0) / 1000);
		if (result.ok) {
			setBuildStatus(`✓ Build สำเร็จ ใน ${sec} วินาที — <span class="mono">${esc(result.id)}</span>`, "ok");
			toast("Build สำเร็จ ✓ — กด Program SRAM หรือ Program Flash ได้เลย", "ok", 3600);
		} else {
			const first = (result.errors || [])[0] || "ดู log ด้านล่าง";
			setBuildStatus(`✕ Build ไม่ผ่าน: ${esc(first)}`, "err");
			toast("Build ไม่ผ่าน — " + first, "err", 5000);
		}
	} finally {
		setBuildBusy(false);
	}
}

async function boardProgram(target) {
	if (buildUi.running) return;
	setRightTab("build");
	if (target === "flash" && !confirm("เขียนลง SPI flash (ลบ + เขียน + ตรวจสอบ) — ใช้เวลาประมาณ 1 นาที และแทนที่ของเดิมในแฟลช ทำต่อไหม?")) return;
	buildLog(`—— Program ${target === "sram" ? "SRAM" : "Flash"} ——`, "s");
	setBuildStatus("กำลังติดต่อ helper…");
	setBuildBusy(true);
	try {
		const { res, offline } = await helperFetch("/program", { method: "POST", body: JSON.stringify({ target }) });
		if (offline) { setBuildStatus("✕ ไม่พบ helper", "err"); toast("ไม่พบ helper — รัน node helper/server.js ก่อน (หรือใช้ program.sh ในไฟล์ zip)", "err", 5000); return; }
		if (!res.ok) { const j = await res.json().catch(() => ({})); setBuildStatus("✕ " + esc(j.error || res.status), "err"); toast(j.error || "Program ไม่สำเร็จ", "err", 4000); return; }
		let result = null;
		await readSse(res, {
			start: () => setBuildStatus(target === "sram" ? "⏳ กำลังโหลด bitstream ลง FPGA…" : "⏳ กำลังเขียน flash (ลบ → เขียน → ตรวจสอบ)…"),
			log: l => buildLog(l),
			done: r => { result = r; },
		});
		if (result && result.ok) {
			const done = result.donePin === 1 ? " · DONE=1" : "";
			setBuildStatus(target === "sram" ? `✓ โหลดลง FPGA แล้ว${done}` : `✓ เขียน flash และตรวจสอบแล้ว${done} — ถอดสายแล้วเปิดใหม่ วงจรจะยังอยู่`, "ok");
			toast(target === "sram" ? "Program SRAM สำเร็จ ✓" : "Program Flash สำเร็จ ✓", "ok", 3600);
		} else {
			const first = (result && result.errors && result.errors[0]) || "ดู log ด้านล่าง";
			setBuildStatus("✕ Program ไม่สำเร็จ: " + esc(first), "err");
			toast("Program ไม่สำเร็จ — " + first, "err", 5000);
		}
	} finally {
		setBuildBusy(false);
	}
}

async function boardCheckHelper() {
	setBuildStatus("กำลังตรวจ helper และสาย JTAG…");
	const { res, offline } = await helperFetch("/status?probe=1");
	if (offline) { setBuildStatus("✕ ไม่พบ helper — รัน <span class=\"mono\">node helper/server.js</span>", "err"); return null; }
	if (!res.ok) { setBuildStatus("✕ helper ตอบ " + res.status, "err"); return null; }
	const s = await res.json();
	const viv = s.vivado.found ? "✓ Vivado" : "✕ ไม่พบ Vivado";
	const cab = !s.cable ? "สาย JTAG: ยังไม่ได้ตรวจ (helper กำลังทำงาน)"
		: s.cable.devices.some(d => /xc7s15/.test(d)) ? `✓ เจอบอร์ด (${esc(s.cable.devices.join(", "))})`
			: s.cable.targets ? `⚠ เจอสาย JTAG แต่ไม่เจอ xc7s15 (${esc(s.cable.devices.join(", ") || "-")})`
				: "✕ ไม่เจอสาย JTAG";
	setBuildStatus(`${viv} · ${cab}`, s.vivado.found && s.cable && s.cable.devices.length ? "ok" : "warn");
	return s;
}

/* ---------- no helper: hand over a zip to run by hand ---------- */
function helperOffline(inp) {
	setBuildStatus("✕ ไม่พบ helper — ดาวน์โหลดชุดไฟล์ .zip ให้แทน (รัน ./program.sh build)", "err");
	toast("ไม่พบ helper (node helper/server.js) — ดาวน์โหลดชุดไฟล์ .zip ให้ build เองแทน", "warn", 5000);
	downloadBuildBundle(inp);
}
function bundleProgramSh(top) {
	return `#!/bin/sh
# Schematic Studio — build and program the EDGE Spartan-7 without the helper.
#   ./program.sh build   synthesize → top.bit + top.mcs
#   ./program.sh sram    load top.bit into the FPGA (until power-off)
#   ./program.sh flash   write top.mcs to the SPI flash (survives power-off)
set -e
VIVADO="\${VIVADO_BIN:-$HOME/Vivado/2025.2/Vivado/bin/vivado}"
cd "$(dirname "$0")"
case "$1" in
	build)       exec "$VIVADO" -mode batch -nojournal -nolog -source build.tcl -tclargs ${top} ;;
	sram|flash)  exec "$VIVADO" -mode batch -nojournal -nolog -source program.tcl -tclargs "$1" ;;
	*)           echo "usage: $0 build|sram|flash" >&2; exit 2 ;;
esac
`;
}
function downloadBuildBundle(inp) {
	inp = inp || collectBuildInputs();
	if (!inp) return;
	const entries = Object.keys(inp.files).map(n => ({ name: n, data: inp.files[n] }));
	entries.push(
		{ name: "top.xdc", data: inp.xdc },
		{ name: "build.tcl", data: VIVADO_TCL.build },
		{ name: "program.tcl", data: VIVADO_TCL.program },
		{ name: "program.sh", data: bundleProgramSh(inp.top), exec: true },
		{ name: "README.txt", data: `Top entity: ${inp.top}\nBoard: ${BOARD_S7.name} (${BOARD_S7.part}), flash ${BOARD_S7.flash.part}\n\n  sh program.sh build\n  sh program.sh sram     (or: flash)\n` });
	const folder = (sanId(state.project.name || "project") || "project") + "_board/";
	const blob = makeZip(entries.map(e => ({ ...e, name: folder + e.name })));
	const fname = dlName(state.project.name || "project", "_board.zip", "project");
	const u = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = u; a.download = fname; a.click();
	URL.revokeObjectURL(u);
	return fname;
}
/* A minimal "stored" (uncompressed) zip — a few text files do not need deflate,
   and this keeps the page free of libraries. */
const _crcTable = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
	return t;
})();
function crc32(bytes) {
	let c = 0xFFFFFFFF;
	for (let i = 0; i < bytes.length; i++) c = _crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
	return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(entries) {
	const enc = new TextEncoder();
	const parts = [], central = [];
	let offset = 0;
	const d = new Date();
	const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
	const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
	entries.forEach(e => {
		const name = enc.encode(e.name), data = enc.encode(e.data), crc = crc32(data);
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
		local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
		local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
		local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
		parts.push(local, name, data);
		const cen = new DataView(new ArrayBuffer(46));
		cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 0x0314, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
		cen.setUint16(10, 0, true); cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true);
		cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
		cen.setUint16(28, name.length, true);
		cen.setUint32(38, ((e.exec ? 0o100755 : 0o100644) << 16) >>> 0, true);   // unix mode, so program.sh stays executable
		cen.setUint32(42, offset, true);
		central.push(cen, name);
		offset += 30 + name.length + data.length;
	});
	const cenSize = central.reduce((n, p) => n + p.byteLength, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
	end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
	return new Blob([...parts, ...central, end], { type: "application/zip" });
}
