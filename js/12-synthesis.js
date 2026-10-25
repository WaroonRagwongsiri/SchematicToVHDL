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
/* The sheet a SCH:/CUSTOM: block instantiates, or null for any other block (or a
   reference whose sheet/custom has been deleted). */
function subSheetOf(c) {
	if (typeof c.type !== "string") return null;
	if (c.type.indexOf("SCH:") === 0) return state.project.schematics[c.type.slice(4)] || null;
	if (c.type.indexOf("CUSTOM:") === 0) return ((state.project.customs || {})[c.type.slice(7)] || {}).schematic || null;
	return null;
}
/* The net a MERGE tap writes into: a stable key for grouping the taps that share one
   bus, and its width — the widest REAL port on the net, since junctions and the taps
   themselves carry no width of their own. The generator declares the bus signal by
   the same rule, so the check and the emitted code cannot disagree. Needs no driving
   port and no generation pass, so the synthesis check can use it on its own. */
function mergeBusInfo(sch, tap) {
	const dw = (sch.wires || []).find(w => (w.to.cid === tap.id && w.to.pid === "d")
		|| (w.from.cid === tap.id && w.from.pid === "d"));
	if (!dw) return null;
	const net = netWires(sch, dw);
	let width = 0, taps = 0;
	net.forEach(id => {
		const w = (sch.wires || []).find(x => x.id === id);
		if (!w) return;
		[w.from, w.to].forEach(ep => {
			const oc = comp(ep.cid, sch);
			if (!oc || oc.type === "JUNCTION") return;
			if (oc.type === "BUSTAP") {
				if ((oc.params || {}).mode === "merge" && ep.pid === "d")
					taps = Math.max(taps, (oc.params.bit ?? 0) + Math.max(1, oc.params.width || 1));
				return;
			}
			const p = getPort(oc, ep.pid);
			if (p) width = Math.max(width, p.width || 1);
		});
	});
	/* `width` is what the DESTINATION says; `tapWidth` is what the taps need. With no
	   real port on the net — the destination deleted, the bus left dangling — there is
	   nothing to compare against, so the bus takes the taps' own extent and the sheet
	   is reported as having no destination. */
	return { key: [...net].sort().join("|"), net, width: width || null, tapWidth: taps || null };
}
/* A sub-block is as opaque as a flip-flop when EVERY path from its inputs to EVERY
   one of its outputs crosses a register — no combinational cycle can run through it.
   Walk back from each OUT marker: a path that ends on a register, a constant rail or
   nothing at all is registered; one that reaches an IN marker is not. A merge bus has
   no driving wire — its taps are its drivers, which is exactly how a registered byte
   leaves a sheet. Anything this walk cannot follow (an unknown type, a cycle inside
   the sheet, a sub-block that is not itself fully registered) answers NO, so the only
   effect of doubt is that a loop stays reported. Without this, `acc → alu → acc` was
   a false combinational-loop error. */
function sheetIsFullyRegistered(sch, memo, visiting) {
	memo = memo || new Map();                  // keyed by the sheet OBJECT: a custom
	visiting = visiting || new Set();           // component's schematic has no id
	if (!sch) return false;
	if (memo.has(sch)) return memo.get(sch);
	if (visiting.has(sch)) return false;        // hierarchy cycle — reported on its own
	visiting.add(sch);
	const byId = {};
	(sch.components || []).forEach(c => { byId[c.id] = c; });
	const outs = (sch.components || []).filter(c => c.type === "OUT");
	const done = new Map(), onStack = new Set();
	const back = (cid, pid) => {
		const key = cid + "." + pid;
		if (done.has(key)) return done.get(key);   // shared fan-in, already settled
		if (onStack.has(key)) return false;        // a cycle in here — make no claim
		onStack.add(key);
		const r = step(cid, pid);
		onStack.delete(key); done.set(key, r);
		return r;
	};
	// a merge bus has no driving wire: the MERGE taps on its net are its drivers
	const viaMergeTaps = host => {
		const net = netWires(sch, host);
		const taps = (sch.components || []).filter(c => c.type === "BUSTAP"
			&& (c.params || {}).mode === "merge"
			&& (sch.wires || []).some(x => net.has(x.id)
				&& ((x.from.cid === c.id && x.from.pid === "d") || (x.to.cid === c.id && x.to.pid === "d"))));
		return taps.length ? taps.every(t => back(t.id, "y")) : null;
	};
	const step = (cid, pid) => {
		const w = (sch.wires || []).find(x => x.to.cid === cid && x.to.pid === pid);
		const src = w ? byId[w.from.cid] : null;
		if (!src) {
			const self = byId[cid];
			if (self && (self.type === "JUNCTION" || self.type === "OUT")) {
				const host = (sch.wires || []).find(x => x.from.cid === cid || x.to.cid === cid);
				const r = host ? viaMergeTaps(host) : null;
				if (r !== null) return r;
			}
			return true;                            // nothing arrives — reads as a constant
		}
		if (src.type === "BUSTAP" && (src.params || {}).mode === "merge" && w.from.pid === "d") {
			const r = viaMergeTaps(w);
			return r === null ? false : r;
		}
		if (src.type === "IN") return false;         // a live path from this sheet's own port
		if (["VCC", "GND", "CONST"].includes(src.type)) return true;
		if (src.type === "JUNCTION") return back(src.id, "j");
		if (SEQ_TYPES.has(src.type)) return true;  // register boundary — the path stops here
		if (src.type.indexOf("SCH:") === 0 || src.type.indexOf("CUSTOM:") === 0)
			return sheetIsFullyRegistered(subSheetOf(src), memo, visiting);
		const td = typeDef(src);
		if (!td) return false;                     // unknown type — no claim
		if (src.type === "BUSTAP") return back(src.id, "d");
		return td.ports(src.params || {}).filter(p => p.dir === "in").every(p => back(src.id, p.id));
	};
	const ok = outs.length > 0 && outs.every(o => back(o.id, "i"));
	visiting.delete(sch);
	memo.set(sch, ok);
	return ok;
}
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
	/* A fully registered sub-block leaves the graph for the same reason a flip-flop does:
	   nothing combinational passes through it, so no cycle through it is combinational. */
	const regMemo = new Map();
	const registeredBlock = c => (c.type.indexOf("SCH:") === 0 || c.type.indexOf("CUSTOM:") === 0)
		&& sheetIsFullyRegistered(subSheetOf(c), regMemo);
	const nodes = sch.components.filter(c => !["IN", "OUT", "VCC", "GND", "CONST", "JUNCTION"].includes(c.type)
		&& !SEQ_TYPES.has(c.type) && !registeredBlock(c));
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

	/* A block whose sub-sheet (or custom component) has been DELETED still holds its
	   wires and looks like part of the circuit — but the generator has no ports for it,
	   so it emits no instance and the VHDL silently stops matching the drawing. A
	   custom component's own sheet is emitted as an entity too, so it is scanned as
	   well; it has no sheet tab to jump to, hence no schId/cid there. */
	const deadScan = [];
	Object.values(state.project.schematics).forEach(sch => { deadScan.push({ sch, ref: sch.name, jump: true }); });
	Object.values(state.project.customs || {}).forEach(cc => {
		if (cc && cc.schematic) deadScan.push({ sch: cc.schematic, ref: `custom component "${cc.name}"`, jump: false });
	});
	deadScan.forEach(({ sch, ref, jump }) => {
		(sch.components || []).forEach(c => {
			if (typeof c.type !== "string") return;
			if (typeDef(c)) return;
			const what = c.type.indexOf("SCH:") === 0 ? "schematic"
				: c.type.indexOf("CUSTOM:") === 0 ? "custom component" : null;
			const at = jump ? { schId: sch.id, cid: c.id } : {};
			issues.push(Object.assign({ lvl: "err", ref }, at, {
				msg: what
					? `บล็อก '${c.label || c.id}' เรียก ${what} ที่ไม่มีอยู่แล้ว (อาจลบทิ้งไป) — บล็อกนี้ไม่ถูกวาดบนผัง และจะหายจาก VHDL ทั้งหมด คลิกบรรทัดนี้แล้วกด Delete เพื่อลบ หรือสร้าง ${what} กลับมา`
					: `ไม่รู้จักอุปกรณ์ '${c.type}' — บล็อกนี้จะหายจาก VHDL ทั้งหมด`
			}));
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
				const width = Math.max(1, tc.params.width || 1);
				const hi = bit + width - 1;
				if (fw < 2) issues.push({
					lvl: "err",
					msg: `Bus Tap ต้องเกาะกับสายบัส (กว้าง > 1 bit) แต่ต่อกับ ${compDisplay(src.c)} (${fw} bit)`, ref: sch.name, schId: sch.id, cid: tc.id
				});
				else if (hi > fw - 1) issues.push({
					lvl: "err",
					msg: width > 1
						? `Bus Tap แตะช่วงบิต (${hi}:${bit}) แต่บัสมีช่วงแค่ (${fw - 1}:0)`
						: `Bus Tap แตะบิต ${bit} แต่บัสมีช่วงแค่ (${fw - 1}:0)`, ref: sch.name, schId: sch.id, cid: tc.id
				});
				return;
			}
			// Two ways a 1-bit driver legitimately feeds a wider pin:
			//   · a CONSTANT RAIL (VCC / GND / a 1-bit CONST) — it has no width of its own,
			//     so it means every bit of whatever it feeds;
			//   · a 1-bit SIGNAL into a WIDE GATE — one select or enable line masking a bus.
			// Everything else is still an error, including a wide driver into a narrow pin
			// and a CONST whose DECLARED width disagrees with the pin.
			const railSrc = src.c && (src.c.type === "VCC" || src.c.type === "GND"
				|| (src.c.type === "CONST" && constWidth(src.c.params || {}) === 1));
			if (fw === 1 && tw > 1 &&
				(railSrc || ["AND", "OR", "NAND", "NOR", "XOR", "XNOR", "NOT", "BUF"].includes(tc.type))) return;
			if (fw !== tw) {
				issues.push({
					lvl: "err",
					msg: `สายเชื่อม ${compDisplay(src.c)} (${fw} bit) เข้ากับ ${compDisplay(tc)} (${tw} bit) — ความกว้างบัสไม่ตรงกัน`,
					ref: sch.name, schId: sch.id, cid: tc.id
				});
			}
		});

		/* A `component add` declaration HIDES an entity port also named `add`, so the
		   generator renames the port to `add_1` — but the caller's component declaration,
		   port map and drawn pins all come from schPortList() and keep `add`, so Vivado
		   rejects both sides. Nothing can fix that silently, so report it like any other
		   name clash: one rename and everything agrees again. */
		{
			const subNames = new Map();
			(sch.components || []).forEach(c => {
				if (typeof c.type !== "string") return;
				if (c.type.indexOf("SCH:") === 0) {
					const s = state.project.schematics[c.type.slice(4)];
					if (s) subNames.set(sanId(s.name), s.name);
				} else if (c.type.indexOf("CUSTOM:") === 0) {
					const cc = (state.project.customs || {})[c.type.slice(7)];
					if (cc) subNames.set(sanId(cc.name), cc.name);
				}
			});
			if (subNames.size) schPortList(sch).forEach(p => {
				if (!subNames.has(p.id)) return;
				issues.push({
					lvl: "err", ref: sch.name, schId: sch.id, cid: p.cid,
					msg: `พอร์ต '${p.id}' ชื่อเดียวกันกับ '${subNames.get(p.id)}' ที่เรียกใช้ในแผ่นนี้ — ใน VHDL ชื่อนี้จะกลายเป็น component ทับชื่อพอร์ต โปรแกรมจะเปลี่ยนพอร์ตเป็น '${p.id}_1' ให้เอง แต่แผ่นที่เรียกแผ่นนี้ยังเรียก '${p.id}' — Vivado จะ error ทั้งสองฝั่ง ให้เปลี่ยนชื่อพอร์ต`
				});
			});
		}

		/* MERGE taps: the width loop above reaches its bus-tap errors through traceSrc(),
		   which walks upstream for a driving port — a merge bus has none (the taps are
		   its drivers), so merge taps escaped the range check. Narrowing the destination
		   port after the taps were stamped is all it takes. Two taps on one bit are two
		   concurrent drivers; a bus with no real port on it has no destination at all. */
		const mergeNets = new Map();
		(sch.components || []).filter(c => c.type === "BUSTAP" && (c.params || {}).mode === "merge").forEach(tap => {
			const info = mergeBusInfo(sch, tap);
			if (!info) return;
			if (!mergeNets.has(info.key))
				mergeNets.set(info.key, { w: info.width, dangling: !info.width, taps: [] });
			mergeNets.get(info.key).taps.push(tap);
		});
		mergeNets.forEach(({ w, taps, dangling }) => {
			if (dangling) {
				issues.push({
					lvl: "err", ref: sch.name, schId: sch.id, cid: taps[0].id,
					msg: `สายบัสที่ Bus Tap ${taps.length} ตัวรวมบิตเข้าไม่มีปลายทาง — ไม่มีพอร์ตหรือขาของบล็อกใดอยู่บนสายนี้เลย (ปลายทางอาจถูกลบไป) บิตทั้งหมดจะไม่มีอะไรอ่าน`
				});
			}
			const claimed = new Map();                       // bit → the tap that took it
			taps.forEach(tap => {
				const bit = tap.params.bit ?? 0;
				const width = Math.max(1, tap.params.width || 1);
				const hi = bit + width - 1;
				const range = width > 1 ? `${hi}:${bit}` : `${bit}`;
				if (w && hi > w - 1) {
					issues.push({
						lvl: "err", ref: sch.name, schId: sch.id, cid: tap.id,
						msg: `${compDisplay(tap)} แตะบิต ${range} แต่บัสที่รวมเข้ากว้างแค่ (${w - 1}:0) — VHDL จะอ้างบิตเกินขอบเขต Vivado จะ error`
					});
					return;
				}
				for (let b = bit; b <= hi; b++) {
					const first = claimed.get(b);
					if (first) {
						issues.push({
							lvl: "err", ref: sch.name, schId: sch.id, cid: tap.id,
							msg: `${compDisplay(tap)} แตะบิต ${range} ทับกับ ${compDisplay(first)} — บิต ${b} จะมีตัวขับสองตัว (driver ชนกัน)`
						});
						break;
					}
					claimed.set(b, tap);
				}
			});
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
		const COMBI = c2 => c2 && !["IN", "VCC", "GND", "CONST", "JUNCTION"].includes(c2.type) && !SEQ_TYPES.has(c2.type);
		// flip-flop clock must be a real signal — a constant or missing clock makes the
		// generated process unparseable (and the register meaningless); a clock that comes
		// from other logic still builds but is a classic FPGA trap, so it is a warning
		sch.components.filter(c => SEQ_TYPES.has(c.type)).forEach(c => {
			const src = srcOfPin(c.id, "clk");
			if (!src)
				issues.push({ lvl: "err", msg: `${compDisplay(c)} ขา 'clk' ยังไม่ได้ต่อสัญญาณนาฬิกา — flip-flop นี้จะไม่ถูกสร้าง`, ref: sch.name, schId: sch.id, cid: c.id });
			else if (src.type === "VCC" || src.type === "GND" || src.type === "CONST")
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
	// board pin map (21-pin-mapping.js) — only once the user has started mapping
	if (typeof pinIssuesForSynthesis === "function") pinIssuesForSynthesis().forEach(i => issues.push(i));
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
