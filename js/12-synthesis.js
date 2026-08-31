"use strict";

/* =========================================================================
   SYNTHESIS CHECK
   ========================================================================= */
/* human-readable component reference for error messages */
/* keep block labels unique in a sheet. The label is FREE TEXT (Thai included) — it is
   what the student sees on the canvas, so it is stored raw and never sanitised here;
   sanId() is applied only where VHDL needs an identifier. */
function uniqueLabel(sch, want, exclude) {
	const raw = String(want || "").trim();
	if (!raw) return "";
	const used = new Set((sch.components || []).filter(x => x !== exclude && x.label).map(x => x.label.toLowerCase()));
	let cand = raw, k = 2;
	while (used.has(cand.toLowerCase())) cand = raw + "_" + (k++);
	return cand;
}
function compDisplay(c) {
	if (c.type === "IN") return `INPUT '${c.params.name}'`;
	if (c.type === "OUT") return `OUTPUT '${c.params.name}'`;
	const td = typeDef(c);
	// a labelled block is named in messages — far easier to find than coordinates
	if (c.label) return `${td ? td.label : c.type} '${c.label}'`;
	return `${td ? td.label : c.type} (${c.x}, ${c.y})`;
}
/* open the schematic, select the component and centre the view on it */
function focusComp(schId, cid) {
	if (!state.project.schematics[schId]) return;
	openSchTab(schId);
	const c = comp(cid);
	if (!c) return;
	state.selection = new Set([cid]);
	const r = canvas.getBoundingClientRect();
	const sz = getSize(c);
	state.view.x = r.width / 2 - (c.x + sz.w / 2) * state.view.k;
	state.view.y = r.height / 2 - (c.y + sz.h / 2) * state.view.k;
	render(); renderInspector();
}
/* ---- design-rule checks that mirror what Vivado rejects ------------------- */
/* Flip-flops break a feedback path: Q depends on D only across a clock edge, which
   is exactly why every counter and state machine is legal. Anything else passes the
   signal through combinationally. */
const SEQ_TYPES = new Set(["DFF", "JKFF", "TFF", "SRFF"]);
/* Every combinational cycle in the sheet. A cycle with NO register in it is what
   Vivado kills at write_bitstream with "DRC LUTLP-1 combinational loops". */
function combinationalLoops(sch) {
	sch = sch || activeSch();
	const srcOf = (cid, pid, seen) => {
		seen = seen || new Set();
		const k = cid + "." + pid;
		if (seen.has(k)) return null;
		seen.add(k);
		const w = sch.wires.find(x => x.to.cid === cid && x.to.pid === pid);
		if (!w) return null;
		const s = comp(w.from.cid, sch);
		if (!s) return null;
		return s.type === "JUNCTION" ? srcOf(s.id, "j", seen) : s;
	};
	const nodes = sch.components.filter(c => !["IN", "OUT", "VCC", "GND", "JUNCTION"].includes(c.type) && !SEQ_TYPES.has(c.type));
	const idset = new Set(nodes.map(c => c.id));
	const adj = new Map();
	nodes.forEach(c => {
		const td = typeDef(c); if (!td) return;
		const outs = [];
		td.ports(c.params || {}).filter(p => p.dir === "in").forEach(p => {
			const s = srcOf(c.id, p.id);
			if (s && idset.has(s.id)) outs.push(s.id);      // s drives c
		});
		adj.set(c.id, outs);
	});
	const colour = new Map(), stack = [], loops = [], seenKey = new Set();
	const walk = id => {
		colour.set(id, 1); stack.push(id);
		(adj.get(id) || []).forEach(nb => {
			if (colour.get(nb) === 1) {
				const cyc = stack.slice(stack.indexOf(nb));
				const key = [...cyc].sort().join(",");
				if (!seenKey.has(key)) { seenKey.add(key); loops.push(cyc); }
			} else if (!colour.get(nb)) walk(nb);
		});
		stack.pop(); colour.set(id, 2);
	};
	nodes.forEach(c => { if (!colour.get(c.id)) walk(c.id); });
	return loops;
}
/* A sheet used inside itself (directly, or A->B->A) cannot be elaborated. Unlike
   subBlockBlockedWhy (which only stops a NEW direct self-nest at the moment of
   placement), this walks every schematic's whole sub-block tree, so it also catches
   longer cycles (A→B→C→A) built up across several separate, individually-legal drops. */
function hierarchyCycles() {
	const P = state.project, out = [], seenKey = new Set();
	const subsOf = sch => (sch.components || []).map(c => {
		if (c.type.startsWith("SCH:")) return P.schematics[c.type.slice(4)] || null;
		if (c.type.startsWith("CUSTOM:")) { const cc = (P.customs || {})[c.type.slice(7)]; return cc && cc.schematic ? cc.schematic : null; }
		return null;
	}).filter(Boolean);
	const walk = (sch, path) => {
		const i = path.indexOf(sch);
		if (i >= 0) {
			const cyc = path.slice(i).concat([sch]);
			const key = cyc.map(s => s.id).sort().join(",");
			if (!seenKey.has(key)) { seenKey.add(key); out.push({ sheet: cyc[0], path: cyc.map(s => s.name) }); }
			return;
		}
		if (path.length > 32) return;
		subsOf(sch).forEach(s => walk(s, path.concat([sch])));
	};
	Object.values(P.schematics).forEach(s => walk(s, []));
	return out;
}
function runSynthesis() {
	const issues = [];
	const top = state.project.schematics[state.project.topId];
	if (!top) { issues.push({ lvl: "err", msg: "ไม่มี top entity" }); }
	if (top && top.components.filter(c => c.type === "IN").length === 0)
		issues.push({ lvl: "warn", msg: "top entity ไม่มี INPUT pin", ref: top.name });
	if (top && top.components.filter(c => c.type === "OUT").length === 0)
		issues.push({ lvl: "warn", msg: "top entity ไม่มี OUTPUT pin", ref: top.name });

	// a hierarchy loop: Vivado cannot elaborate it, so say so before the build does
	Object.values(state.project.schematics).forEach(sch => {
		(sch.components || []).forEach(c => {
			if (typeof c.type === "string" && c.type.indexOf("SCH:") === 0
				&& schUsesSheet(c.type.slice(4), sch.id)) {
				const inner = state.project.schematics[c.type.slice(4)];
				issues.push({
					lvl: "err", msg: `วงวนลำดับชั้น: '${sch.name}' ใส่ '${inner ? inner.name : c.type.slice(4)}' ซึ่งย้อนกลับมาใช้ '${sch.name}'`,
					ref: sch.name, schId: sch.id, cid: c.id
				});
			}
		});
	});

	Object.values(state.project.schematics).forEach(sch => {
		// duplicate IN/OUT names
		const inN = new Map(), outN = new Map();
		sch.components.forEach(c => {
			if (c.type === "IN") {
				const n = c.params.name;
				if (inN.has(n)) issues.push({ lvl: "err", msg: `INPUT '${n}' ชื่อซ้ำ`, ref: sch.name, schId: sch.id, cid: c.id });
				inN.set(n, c);
			} else if (c.type === "OUT") {
				const n = c.params.name;
				if (outN.has(n)) issues.push({ lvl: "err", msg: `OUTPUT '${n}' ชื่อซ้ำ`, ref: sch.name, schId: sch.id, cid: c.id });
				outN.set(n, c);
			}
		});
		// unconnected inputs
		sch.components.forEach(c => {
			const td = typeDef(c); if (!td) return;
			td.ports(c.params || {}).forEach(p => {
				if (p.dir === "in") {
					const wIn = sch.wires.find(w => w.to.cid === c.id && w.to.pid === p.id);
					const has = !!wIn;
					// wired, but the far end simply stops in mid-air. Nothing drives the net, so
					// the generator has to invent a value — '0' for a bit, (others => '0') for a
					// bus — and the design quietly computes something else. This used to pass.
					if (has && !netHasDriver(sch, wIn)) {
						issues.push(c.type === "OUT"
							? {
								lvl: "err", msg: `${compDisplay(c)} ต่อสายไว้แต่ปลายสายลอย — ไม่มีตัวขับ VHDL จะได้ (others => '0')`,
								ref: sch.name, schId: sch.id, cid: c.id
							}
							: {
								lvl: "warn", msg: `${compDisplay(c)} ขา '${p.id}' ต่อกับสายที่ปลายลอย — ไม่มีตัวขับ VHDL จะได้ '0'`,
								ref: sch.name, schId: sch.id, cid: c.id
							});
					}
					if (!has && c.type !== "OUT" && c.type !== "GND") {
						issues.push({ lvl: "warn", msg: `${compDisplay(c)} ขา '${p.id}' ยังไม่ได้ต่อสาย`, ref: sch.name, schId: sch.id, cid: c.id });
					} else if (!has && c.type === "OUT") {
						issues.push({ lvl: "err", msg: `${compDisplay(c)} ยังไม่ได้ต่อสาย`, ref: sch.name, schId: sch.id, cid: c.id });
					}
				}
			});
		});
		// multiple drivers on a net (input with >1 incoming wire).
		// A junction may fan OUT freely but accepts only ONE incoming wire —
		// more than one means two drivers shorted on the same net.
		const driven = new Map();
		sch.wires.forEach(w => {
			const k = w.to.cid + "." + w.to.pid;
			driven.set(k, (driven.get(k) || 0) + 1);
		});
		driven.forEach((n, k) => {
			if (n > 1) {
				const [cid, pid] = k.split(".");
				const c = sch.components.find(x => x.id === cid);
				const isJ = c && c.type === "JUNCTION";
				issues.push({
					lvl: "err",
					msg: isJ ? `จุดแยกสาย (junction) มีสายเข้าซ้อนกัน ${n} เส้น — driver ชนกันบน net เดียว`
						: `${c ? compDisplay(c) : k} ขา '${pid}' มีสายเข้าซ้อนกัน ${n} เส้น (multi-driver)`,
					ref: sch.name, schId: sch.id, cid
				});
			}
		});
		// bus width mismatch — every consuming port must receive a signal of its
		// own width. Junctions are width-transparent, so trace back through them
		// to the real driving port; mismatches across a junction are caught too.
		const traceSrc = (w, visited) => {
			visited = visited || new Set();
			const fc = comp(w.from.cid, sch);
			if (!fc) return null;
			if (fc.type !== "JUNCTION") {
				const fp = getPort(fc, w.from.pid);
				return fp ? { c: fc, w: fp.width || 1 } : null;
			}
			if (visited.has(fc.id)) return null;
			visited.add(fc.id);
			const up = sch.wires.find(x => x.to.cid === fc.id);
			if (up) return traceSrc(up, visited);
			if (fc.params && fc.params.busWidth) return { c: fc, w: fc.params.busWidth };  // floating bus
			return null;
		};
		sch.wires.forEach(w => {
			const tc = comp(w.to.cid, sch);
			if (!tc || tc.type === "JUNCTION") return;   // validate at consuming ports
			const tp = getPort(tc, w.to.pid);
			if (!tp) return;
			const src = traceSrc(w);
			if (!src) return;
			const fw = src.w, tw = tp.width || 1;
			// BUS TAP's d pin accepts a bus of ANY width — validate bus-ness + the bit number
			if (tc.type === "BUSTAP" && tp.id === "d") {
				const bit = tc.params.bit ?? 0;
				if (fw < 2) issues.push({
					lvl: "err",
					msg: `Bus Tap ต้องเกาะกับสายบัส (กว้าง > 1 bit) แต่ต่อกับ ${compDisplay(src.c)} (${fw} bit)`, ref: sch.name, schId: sch.id, cid: tc.id
				});
				else if (bit > fw - 1) issues.push({
					lvl: "err",
					msg: `Bus Tap แตะบิต ${bit} แต่บัสมีช่วงแค่ (${fw - 1}:0)`, ref: sch.name, schId: sch.id, cid: tc.id
				});
				return;
			}
			if (fw !== tw) {
				issues.push({
					lvl: "err",
					msg: `สายเชื่อม ${compDisplay(src.c)} (${fw} bit) เข้ากับ ${compDisplay(tc)} (${tw} bit) — ความกว้างบัสไม่ตรงกัน`,
					ref: sch.name, schId: sch.id, cid: tc.id
				});
			}
		});

		// what really drives a pin, looking through junctions
		const srcOfPin = (cid, pid) => {
			const w = sch.wires.find(x => x.to.cid === cid && x.to.pid === pid);
			if (!w) return null;
			let s = comp(w.from.cid, sch), guard = 0;
			while (s && s.type === "JUNCTION" && guard++ < 64) {
				const up = sch.wires.find(x => x.to.cid === s.id);
				s = up ? comp(up.from.cid, sch) : null;
			}
			return s;
		};
		const COMBI = c2 => c2 && !["IN", "VCC", "GND", "JUNCTION"].includes(c2.type) && !SEQ_TYPES.has(c2.type);
		// flip-flop clock must be a real signal — a constant or missing clock makes the
		// generated process unparseable (and the register meaningless); a clock that comes
		// from other logic still builds but is a classic FPGA trap, so it is a warning
		sch.components.filter(c => SEQ_TYPES.has(c.type)).forEach(c => {
			const src = srcOfPin(c.id, "clk");
			if (!src)
				issues.push({ lvl: "err", msg: `${compDisplay(c)} ขา 'clk' ยังไม่ได้ต่อสัญญาณนาฬิกา — flip-flop นี้จะไม่ถูกสร้าง`, ref: sch.name, schId: sch.id, cid: c.id });
			else if (src.type === "VCC" || src.type === "GND")
				issues.push({ lvl: "err", msg: `${compDisplay(c)} ขา 'clk' ต่อกับ ${src.type} (ค่าคงที่) — นาฬิกาต้องเป็นสัญญาณ ไม่ใช่ค่าคงที่`, ref: sch.name, schId: sch.id, cid: c.id });
			else if (SEQ_TYPES.has(src.type))
				issues.push({ lvl: "warn", msg: `${compDisplay(c)} ใช้เอาต์พุตของ ${compDisplay(src)} เป็นนาฬิกา (ripple counter) — บน FPGA สัญญาณนี้ไม่ได้อยู่บน clock network, Vivado จะเตือน CLOCK_DEDICATED_ROUTE และ skew สะสมทีละสเตจ; ทางที่ปลอดภัยคือใช้ clock เส้นเดียวกันทุกตัว แล้วคุมด้วยเงื่อนไข`, ref: sch.name, schId: sch.id, cid: c.id });
			else if (COMBI(src))
				issues.push({ lvl: "warn", msg: `${compDisplay(c)} รับนาฬิกาจาก ${compDisplay(src)} (วงจร combinational = gated clock) — มี glitch ได้ ควรรับนาฬิกาจากขา INPUT โดยตรง`, ref: sch.name, schId: sch.id, cid: c.id });
			// async reset/preset driven by gates: the pulse width is whatever the logic
			// happens to produce (a runt pulse), so some registers may miss it
			[["rst", c.params && c.params.reset], ["pre", c.params && c.params.preset]].forEach(([pid, on]) => {
				if (!on) return;
				const s2 = srcOfPin(c.id, pid);
				if (COMBI(s2))
					issues.push({ lvl: "warn", msg: `${compDisplay(c)} ขา '${pid}' (async) มาจาก ${compDisplay(s2)} — reset ที่สร้างจากลอจิกเองจะมีความกว้าง pulse ไม่แน่นอน (runt pulse) บาง flip-flop อาจ reset ไม่ทัน; ควรใช้ reset แบบ synchronous หรือรับจากขา INPUT`, ref: sch.name, schId: sch.id, cid: c.id });
			});
		});

		// combinational loop = Vivado's DRC LUTLP-1 at write_bitstream
		combinationalLoops(sch).forEach(cyc => {
			const names = cyc.map(id => { const c = comp(id, sch); return c ? compDisplay(c) : id; });
			issues.push({
				lvl: "err",
				msg: `สายป้อนกลับแบบไม่มี flip-flop (combinational loop): ${names.join(" → ")} → ${names[0]} — Vivado จะ error DRC LUTLP-1 ตอน build; ถ้าต้องการวงจรที่จำค่า ให้ใส่ flip-flop คั่นในลูป`,
				ref: sch.name, schId: sch.id, cid: cyc[0]
			});
		});
	});

	// a sheet that (transitively) contains itself cannot be elaborated
	hierarchyCycles().forEach(h => {
		issues.push({
			lvl: "err",
			msg: `schematic วนกลับมาหาตัวเอง: ${h.path.join(" → ")} — Vivado elaborate ไม่ได้ (บล็อกหนึ่งใส่ตัวเองซ้อนกันไม่จำกัด)`,
			ref: h.sheet.name, schId: h.sheet.id
		});
	});
	renderErrors(issues);
	setRightTab("errors");
	if (issues.filter(i => i.lvl === "err").length === 0) {
		toast("Synthesis check ผ่าน ✓", "ok");
	} else {
		toast("พบ error — คลิกรายการใน Issues เพื่อไปยังจุดที่มีปัญหา", "err");
	}
	return issues;
}
function renderErrors(list) {
	const root = $("#errorsPane");
	if (!list || !list.length) {
		root.innerHTML = `<div class="err-empty">✓ ไม่พบปัญหา — schematic พร้อมสำหรับ Vivado</div>`;
		return;
	}
	const html = [`<div class="err-list">`];
	list.forEach((i, idx) => {
		const lvl = i.lvl === "err" ? "" : i.lvl === "warn" ? "warn" : "info";
		const ico = i.lvl === "err" ? "✕" : i.lvl === "warn" ? "⚠" : "ℹ";
		const jump = i.schId && i.cid ? `data-jump="${idx}" style="cursor:pointer" title="คลิกเพื่อไปยังตำแหน่ง"` : "";
		html.push(`<div class="err-item ${lvl}" ${jump}>
      <span class="ico">${ico}</span>
      <div class="msg">${esc(i.msg)}${i.ref ? `<div class="ref">ใน ${esc(i.ref)}</div>` : ""}</div>
    </div>`);
	});
	html.push(`</div>`);
	root.innerHTML = html.join("");
	root.querySelectorAll("[data-jump]").forEach(e => e.addEventListener("click", () => {
		const i = list[+e.dataset.jump];
		if (i && i.schId && i.cid) focusComp(i.schId, i.cid);
	}));
}
