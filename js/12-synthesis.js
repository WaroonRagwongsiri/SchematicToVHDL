"use strict";

/* =========================================================================
   SYNTHESIS CHECK
   ========================================================================= */
/* human-readable component reference for error messages */
function compDisplay(c) {
	if (c.type === "IN") return `INPUT '${c.params.name}'`;
	if (c.type === "OUT") return `OUTPUT '${c.params.name}'`;
	const td = typeDef(c);
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
function runSynthesis() {
	const issues = [];
	const top = state.project.schematics[state.project.topId];
	if (!top) { issues.push({ lvl: "err", msg: "ไม่มี top entity" }); }
	if (top && top.components.filter(c => c.type === "IN").length === 0)
		issues.push({ lvl: "warn", msg: "top entity ไม่มี INPUT pin", ref: top.name });
	if (top && top.components.filter(c => c.type === "OUT").length === 0)
		issues.push({ lvl: "warn", msg: "top entity ไม่มี OUTPUT pin", ref: top.name });

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
					const has = sch.wires.some(w => w.to.cid === c.id && w.to.pid === p.id);
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
			// BUS TAP's d pin accepts a bus of ANY width — validate bus-ness + range
			if (tc.type === "BUSTAP" && tp.id === "d") {
				const hi = Math.max(tc.params.hi ?? 0, tc.params.lo ?? 0);
				if (fw < 2) issues.push({
					lvl: "err",
					msg: `Bus Tap ต้องเกาะกับสายบัส (กว้าง > 1 bit) แต่ต่อกับ ${compDisplay(src.c)} (${fw} bit)`, ref: sch.name, schId: sch.id, cid: tc.id
				});
				else if (hi > fw - 1) issues.push({
					lvl: "err",
					msg: `Bus Tap เลือกบิต (${hi}) แต่บัสมีช่วงแค่ (${fw - 1}:0)`, ref: sch.name, schId: sch.id, cid: tc.id
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
