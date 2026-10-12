"use strict";

/* =========================================================================
   COMPONENT OPERATIONS
   ========================================================================= */
/* Can sheet `id` be dropped INSIDE sheet `hostId` as a sub-block?
   Not if that closes a loop. VHDL lets you write the loop — top instantiates sub and
   sub instantiates top — and Vivado then fails to elaborate it ("recursive
   instantiation"), so the whole design stops building. And never the project's TOP:
   it is the root, so putting it inside anything either makes exactly that loop, or
   buries the root in a sheet nothing reaches. */
function schUsesSheet(id, targetId, seen) {
	if (id === targetId) return true;
	seen = seen || new Set();
	if (seen.has(id)) return false;
	seen.add(id);
	const s = state.project.schematics[id];
	if (!s) return false;
	return (s.components || []).some(c => typeof c.type === "string" && c.type.indexOf("SCH:") === 0
		&& schUsesSheet(c.type.slice(4), targetId, seen));
}
function subBlockBlockedWhy(id, hostId) {
	if (id === hostId) return "ใส่ schematic ลงในตัวเองไม่ได้";
	if (id === state.project.topId) return "นี่คือ top ของโปรเจกต์ — ใช้เป็น sub-block ไม่ได้ (Vivado จะ elaborate ไม่ผ่าน)";
	if (schUsesSheet(id, hostId)) return "จะเกิดวงวน: schematic นี้ใช้แผ่นปัจจุบันอยู่แล้ว";
	return "";
}
function addComp(type, x, y) {
	const sch = activeSch();
	if (!sch) return;
	let typeDef0;
	let params = {};
	if (type.startsWith("CUSTOM:")) {
		const name = type.slice(7);
		if (!state.project.customs[name]) return;
		typeDef0 = customTypeDef(state.project.customs[name]);
	} else if (type.startsWith("SCH:")) {
		if (!state.project.schematics[type.slice(4)]) return;
		const why = subBlockBlockedWhy(type.slice(4), sch.id);
		if (why) { toast(why, "warn", 3600); return; }
		typeDef0 = schTypeDef(state.project.schematics[type.slice(4)]);
	} else {
		if (!TYPES[type]) return;
		typeDef0 = TYPES[type];
		params = JSON.parse(JSON.stringify(typeDef0.defaultParams || {}));
	}
	// unique pin name for IN/OUT
	if (type === "IN") {
		let n = 0; const used = new Set(sch.components.filter(c => c.type === "IN").map(c => c.params.name));
		let nm; do { nm = "in" + (n++); } while (used.has(nm));
		params.name = nm; params.width = 1;
	}
	if (type === "OUT") {
		let n = 0; const used = new Set(sch.components.filter(c => c.type === "OUT").map(c => c.params.name));
		let nm; do { nm = "out" + (n++); } while (used.has(nm));
		params.name = nm; params.width = 1;
	}
	const id = uid("c");
	const nc = { id, type, x: snap(x), y: snap(y), params, label: "" };
	sch.components.push(nc);
	state.selection = new Set([id]);
	snapshot();
	renderAll();
	return id;
}

/* =========================================================================
   ISE-STYLE MODAL TOOLS (Add Wire / Net Name / I/O Marker)
   The active tool stays armed for repeated use; Esc returns to Select.
   ========================================================================= */
const TOOL_INFO = {
	select: {
		cur: "", msg: "โหมดเลือก/ย้าย",
		hint: "<b>เครื่องมือ ≣ (B)</b> = วาง Bus Tap บนสายบัส (ดึงบิตถัดไปอัตโนมัติ) หรือ <b>ดับเบิลคลิก</b>/คลิกขวาบนสายบัสก็ได้ · <b>ลากจากพอร์ต >1 bit</b> ของ component ด้วยเครื่องมือ ╱ = สร้างบัส · <b>ล้อ/Space+ลาก</b> เลื่อนจอ · <b>Ctrl+ล้อ</b> ซูม · <b>Del</b> ลบ · <b>F7</b> ตรวจ"
	},
	wire: {
		cur: "crosshair", msg: "Add Wire — คลิกพอร์ต→พอร์ตเพื่อต่อสาย · คลิกกลางสาย = แยกสาย",
		hint: "<b>คลิกพอร์ต</b> เริ่มสาย → <b>คลิกพื้นว่าง</b> หักมุม → <b>คลิกพอร์ต/สาย</b> จบ · <b>ดับเบิลคลิก/Enter</b> = จบสายในที่ว่าง · <b>Backspace</b> ถอยมุม · <b>Esc</b> ยกเลิก"
	},
	netname: {
		cur: "text", msg: "Add Net Name — คลิกที่สายเพื่อตั้งชื่อ",
		hint: "<b>คลิกสาย</b> ตั้งชื่อ · บัสต้องลากจากพอร์ต >1 bit ของ component (ตั้งชื่อบัสได้ แต่ความกว้างมาจากพอร์ตต้นทาง)"
	},
	bustap: {
		cur: "crosshair", msg: "Bus Tap (B) — คลิกบนสายบัสเพื่อดึงบิตถัดไป",
		hint: "<b>คลิกบนสายบัส</b> = วาง Bus Tap ที่บิตถัดไป (auto-increment) · ต่อขา y เข้า INPUT จะสลับเป็นโหมด merge ให้อัตโนมัติ · ปรับบิต/โหมดใน Inspector · <b>Esc</b> ยกเลิก"
	},
	iomarker: {
		cur: "crosshair", msg: "Add I/O Marker — คลิกขาที่ยังว่างเพื่อติด INPUT/OUTPUT อัตโนมัติ",
		hint: "<b>คลิกขาที่ยังว่าง</b> เพื่อติด INPUT/OUTPUT marker อัตโนมัติ (บัสได้ด้วย)"
	},
};
function setTool(t, silent) {
	if (t === "symbol") { setLeftTab("palette"); toast("ลาก component จากแผง Components ไปวางบน canvas", "info", 2200); return; }
	if (!TOOL_INFO[t]) t = "select";
	state.tool = t;
	if (state.pendingWire) { state.pendingWire = null; healJunctions(); }  // no orphan dots on tool switch
	$$("#canvasToolbar button[data-tool]").forEach(b => b.classList.toggle("active", b.dataset.tool === t));
	canvas.style.cursor = TOOL_INFO[t].cur;
	const ht = $("#canvasHintText"); if (ht) ht.innerHTML = TOOL_INFO[t].hint || TOOL_INFO[t].msg;
	if (!silent) toast(TOOL_INFO[t].msg, "info", 2200);
	render();
}

/* wire naming — supports ISE-style bus syntax: "data[7:0]" or "data(7:0)".
   Names the net; on a net with no source it also DEFINES the bus width by
   upgrading the net's root junction into the bus definition. */
function applyWireName(w, raw) {
	if (raw === null) return;
	const sch = activeSch();
	const m = /^\s*(.+?)\s*[\[\(]\s*(\d+)\s*:\s*(\d+)\s*[\]\)]\s*$/.exec(raw);
	if (m) {
		// ===== BUS DISABLED (commented out) — naming "name(hi:0)" no longer makes a bus;
		// just take the base name (range ignored). Re-enable by deleting the 4 lines below
		// and uncommenting the ORIGINAL block. =====
		w.name = sanId(m[1]);
		toast("ปิดฟีเจอร์บัสไว้ชั่วคราว — ตั้งชื่อสายได้ แต่ไม่สร้างบัส", "info", 2800);
		snapshot(); render(); renderInspector();
		return;
		/* ORIGINAL bus-by-naming:
		let base = sanId(m[1]); const hi = +m[2], lo = +m[3];
		if(lo !== 0){ toast("รองรับเฉพาะช่วงที่ลงท้าย :0 เช่น data(7:0)","warn",3200); renderInspector(); return; }
		if(hi < 1 || hi > 63){ toast("ความกว้างบัสต้องอยู่ระหว่าง 2–64 bit","warn"); renderInspector(); return; }
		if(netWidth(w, sch) > 1){
		  w.name = base;
		  toast("ตั้งชื่อบัส '"+base+"("+hi+":0)' แล้ว","ok",3000);
		  snapshot(); render(); renderInspector(); return;
		}
		const root = netDriverPort(sch, w);
		const rc = root && comp(root.cid, sch);
		if(rc && rc.type==="JUNCTION"){
		  const taken = new Set(sch.components
			.filter(x=>x.type==="JUNCTION" && x.id!==rc.id && x.params && x.params.busName)
			.map(x=>sanId(x.params.busName)));
		  const want = base; let k = 1;
		  while(taken.has(base)) base = want + "_" + (k++);
		  w.name = base;
		  rc.params = rc.params || {};
		  rc.params.busName  = base;
		  rc.params.busWidth = hi+1;
		} else {
		  w.name = base;
		}
		snapshot(); render(); renderInspector();
		return;
		*/
	}
	w.name = sanId(raw);
	snapshot(); render(); renderInspector();
}

/* Which bits of this bus already have a tap? (union over the whole net, both
   directions — a merged bus must not have two taps writing the same bit) */
function tappedBitsOnNet(w, sch) {
	sch = sch || activeSch();
	const used = new Set();
	netWires(sch, w).forEach(id => {
		const x = sch.wires.find(y => y.id === id); if (!x) return;
		[x.from, x.to].forEach(ep => {
			const c = comp(ep.cid, sch);
			if (c && c.type === "BUSTAP") used.add(c.params.bit ?? 0);
		});
	});
	return used;
}
/* A free wire end (an "endpoint" junction carrying exactly one wire) near `pt` —
   this is the end of the thin wire the user drew BEFORE reaching for the tap. */
function freeEndNear(sch, pt, tol) {
	let best = null;
	sch.components.forEach(c => {
		if (c.type !== "JUNCTION" || !(c.params && c.params.endpoint)) return;
		if (sch.wires.filter(w => w.from.cid === c.id || w.to.cid === c.id).length !== 1) return;
		const p = portPos(c, "j");
		const d = Math.hypot(p.x - pt.x, p.y - pt.y);
		if (d <= tol && (!best || d < best.d)) best = { c, p, d };
	});
	return best;
}
/* Add Bus Tap: click a bus wire → drop a tap flush on it (junction + triangle),
   inheriting the bus width. ISE-style auto-increment: each new tap takes the
   lowest bit not tapped yet on this net; when all bits are taken it wraps to 0
   (tapping the same bit twice is legal fan-out).
   THE GESTURE: draw a thin wire and leave its end in open space, then drop a Bus
   Tap on the bus where the two meet — the tap seats flush on the bus, takes the
   next free bit, and swallows the waiting free end so the two nets become one. */
function stampTapOnWire(w, point) {
	const sch = activeSch();
	// an earlier tap may have split this very wire in two — the object handed in is
	// then dead, and splitting it again would leave the tap dangling off the bus
	if (!sch.wires.includes(w)) {
		const at0 = nearestOnWire(w, point, 0, sch);
		w = at0 ? (sch.wires.find(x => { const a = nearestOnWire(x, at0, 0, sch); return a && a.d < 1; }) || null) : null;
		if (!w) { toast("คลิกบนสายบัสอีกครั้ง", "warn", 2400); return false; }
	}
	const sw = netWidth(w, sch);
	if (sw <= 1) { toast("Bus Tap ใช้กับสายบัส (กว้าง > 1 bit) เท่านั้น", "warn"); return false; }
	const at = nearestOnWire(w, point, 0, sch);
	if (!at) return false;
	let free = freeEndNear(sch, at, 10 * GRID);
	// never swallow the BUS'S OWN open end: a free end only counts when it belongs
	// to a DIFFERENT net than the wire being tapped (else self-loop + width error)
	if (free) {
		const fw0 = sch.wires.find(x => x.from.cid === free.c.id || x.to.cid === free.c.id);
		if (fw0 && netWires(sch, w).has(fw0.id)) free = null;
	}
	// the thin wire decides the direction: if something already drives it, this tap
	// is writing that signal INTO the bus; otherwise it is reading a bit out
	let mode = "split";
	if (free) {
		const fw = sch.wires.find(x => x.from.cid === free.c.id || x.to.cid === free.c.id);
		const other = fw && comp(fw.from.cid === free.c.id ? fw.to.cid : fw.from.cid, sch);
		const op = other && getPort(other, fw.from.cid === free.c.id ? fw.to.pid : fw.from.pid);
		if (op && op.dir === "out") mode = "merge";
	}
	// point the rip at the waiting wire end (or fall back to orientation-based)
	let dir;
	if (free) {
		const dx = free.p.x - at.x, dy = free.p.y - at.y;
		dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : (dy >= 0 ? "down" : "up");
	} else dir = at.seg === "v" ? "right" : "down";
	const used = tappedBitsOnNet(w, sch);
	let bit = 0; while (bit < sw && used.has(bit)) bit++;
	const full = bit >= sw;
	if (full) bit = 0;
	const tap = { id: uid("c"), type: "BUSTAP", x: 0, y: 0, label: "", params: { bit, dir, mode } };
	const dp0 = TYPES.BUSTAP.ports(tap.params).find(p => p.id === "d");
	tap.x = at.x - dp0.dx;   // seat so the d pin lands EXACTLY on the bus point (any tap size)
	tap.y = at.y - dp0.dy;
	sch.components.push(tap);
	const j = { id: uid("c"), type: "JUNCTION", x: at.x - 6, y: at.y - 6, params: { fixed: true } };
	sch.components.push(j);
	splitWireThroughJunction(w, j, sch);
	sch.wires.push({ id: uid("w"), from: { cid: j.id, pid: "j" }, to: { cid: tap.id, pid: "d" }, name: "" });
	if (free) {
		// re-point the thin wire off its free end and onto the tap's bit pin
		const fw = sch.wires.find(x => x.from.cid === free.c.id || x.to.cid === free.c.id);
		if (fw) {
			if (mode === "merge") {
				if (fw.to.cid === free.c.id) fw.to = { cid: tap.id, pid: "y" };
				else { fw.to = fw.from; fw.from = { cid: tap.id, pid: "y" }; }   // keep source→sink
			} else {
				if (fw.from.cid === free.c.id) fw.from = { cid: tap.id, pid: "y" };
				else { fw.from = { cid: tap.id, pid: "y" }; }
			}
			sch.components = sch.components.filter(c => c !== free.c);
		}
	}
	healJunctions(sch);
	healLayout(sch);
	state.selection = new Set([tap.id]);
	snapshot(); render(); renderInspector();
	if (full) toast(`ครบทุกบิตแล้ว — วางซ้ำที่บิต [0] (ปรับบิตได้ใน Inspector)`, "info", 3200);
	else toast(free ? `แตะบิต [${bit}] ของบัส แล้วต่อเข้ากับสายที่ลากไว้` : `วาง Bus Tap บิต [${bit}] แล้ว — คลิกต่อ = บิตถัดไป · ปรับบิต/โหมดใน Inspector`, "ok", 2800);
	return true;
}

/* Add I/O Marker: click an unconnected pin → matching IN/OUT flag, wired straight */
function addIOMarkerAt(c, p) {
	const sch = activeSch();
	const used = sch.wires.some(w => (w.to.cid === c.id && w.to.pid === p.id) || (w.from.cid === c.id && w.from.pid === p.id));
	if (used) { toast("ขานี้มีสายต่ออยู่แล้ว", "warn"); return; }
	const pos = portPos(c, p.id);
	const wdt = p.width || 1;
	if (p.dir === "in") {
		let n = 0; const names = new Set(sch.components.filter(x => x.type === "IN").map(x => x.params.name));
		let nm; do { nm = "in" + (n++); } while (names.has(nm));
		const params = { name: nm, width: wdt };
		const ic = { id: uid("c"), type: "IN", x: pos.x - ioShapeW(params) - 44, y: pos.y - 22, params, label: "" };
		sch.components.push(ic);
		sch.wires.push({ id: uid("w"), from: { cid: ic.id, pid: "o" }, to: { cid: c.id, pid: p.id }, name: "", width: wdt });
	} else {
		let n = 0; const names = new Set(sch.components.filter(x => x.type === "OUT").map(x => x.params.name));
		let nm; do { nm = "out" + (n++); } while (names.has(nm));
		const params = { name: nm, width: wdt };
		const oc = { id: uid("c"), type: "OUT", x: pos.x + 44, y: pos.y - 22, params, label: "" };
		sch.components.push(oc);
		sch.wires.push({ id: uid("w"), from: { cid: c.id, pid: p.id }, to: { cid: oc.id, pid: "i" }, name: "", width: wdt });
	}
	snapshot(); render();
}

function deleteSelection() {
	const sch = activeSch();
	const ids = new Set(state.selection);
	// deleting a bus label removes the net's width definition — say so
	const lostBus = sch.components.some(c => ids.has(c.id) && c.type === "JUNCTION"
		&& c.params && c.params.busName && !sch.wires.some(w => w.to.cid === c.id));
	// freeze every surviving fan-out dot's exit direction BEFORE the cut — otherwise
	// losing one branch lets junctionExitH re-derive from whatever's left and re-elbow
	// the siblings the user never touched
	stampJunctionAxis(sch);
	// deleting an IN/OUT changes this sheet's PORT LIST, so every parent sheet that
	// instantiates it now has wires hanging off pins that no longer exist
	const droppedPorts = sch.components.some(c => ids.has(c.id) && (c.type === "IN" || c.type === "OUT"));
	const portsBefore = droppedPorts ? schPortList(sch) : null;
	sch.components = sch.components.filter(c => !ids.has(c.id));
	// removing one port renumbers the others (foo_1 → foo); without this the parent's
	// wire still resolves — to a DIFFERENT pin, silently
	const portSync = portsBefore ? remapSubBlockPins(sch.id, portsBefore, schPortList(sch)) : { moved: 0, dropped: 0 };
	sch.wires = sch.wires.filter(w => !ids.has(w.id) && !ids.has(w.from.cid) && !ids.has(w.to.cid));
	state.selection.clear();
	// a wire being drawn FROM a component we just deleted must die with it — else the
	// next port click dereferences the dead cid and throws, but only AFTER the
	// one-driver filter has already removed that sink's existing wire (silent loss)
	if (state.pendingWire && !comp(state.pendingWire.cid, sch)) state.pendingWire = null;
	healJunctions(sch);   // junctions clean themselves up when no longer needed
	const orphans = (droppedPorts ? pruneDeadPinWires() : 0) + portSync.dropped;
	snapshot(); renderAll();
	if (lostBus) toast("ลบป้ายชื่อบัสแล้ว — สายนี้ไม่เป็นบัสอีกต่อไป (Bus Tap ที่เหลือจะฟ้องตอนตรวจ)", "warn", 3600);
	if (orphans) toast(`ลบขาเข้า/ออกของวงจรนี้ — สายในแผ่นที่เรียกใช้วงจรนี้ถูกตัดออก ${orphans} เส้น`, "warn", 4200);
}
/* A TIE-OFF IS PART OF THE BLOCK, not part of the drawing around it. Copying four
   flip-flops without the VCC on their J/K pins gives four registers that can never
   change — the generator writes `null; -- J=K='0' → hold` and the counter silently
   does nothing. VCC / GND / CONST are pure sources with no other meaning, so a copy
   takes them with it, following junctions so a shared tie-off rail comes too.
   Anything else whose driver is outside the selection is REPORTED instead: the wire
   genuinely cannot come, and finding that out after the paste is too late.

   But a tie-off must not be copied WHERE IT SAT. One VCC usually feeds a whole rail
   through junctions somewhere off to the side, so cloning it with its geometry pasted
   a flip-flop with a metre of wire trailing back to where the rail used to be. The
   copy does not need that rail — it needs its own tie, next to the pin. So an
   unselected tie-off is not copied at all: the plan records "this pin wants a VCC"
   and the paste builds a fresh one against the pin.

   If the user DID select the tie-off, they chose that geometry: the junction chain in
   between comes along so the wire arrives exactly as drawn. */
function copyPlan(sch, sel) {
	const TIE = new Set(["VCC", "GND", "CONST"]);
	const ids = new Set(sel);
	const ties = [];
	let lost = 0;
	/* pull in the dots between a selected sink and a selected source, or the wire that
	   joins them cannot be copied (both ends must be inside the set) */
	const addChain = w => {
		let cur = w, guard = 0;
		while (cur && guard++ < 64) {
			const f = comp(cur.from.cid, sch);
			if (!f || f.type !== "JUNCTION") return;
			ids.add(f.id);
			cur = sch.wires.find(x => x.to.cid === f.id);
		}
	};
	sch.wires.forEach(w => {
		if (!sel.has(w.to.cid) || sel.has(w.from.cid)) return;
		const d = netDriverPort(sch, w);
		const src = d && comp(d.cid, sch);
		if (src && TIE.has(src.type)) {
			if (sel.has(src.id)) addChain(w);
			else ties.push({
				cid: w.to.cid, pid: w.to.pid, type: src.type,
				params: JSON.parse(JSON.stringify(src.params || {}))
			});
			return;
		}
		lost++;                          // a real signal from outside; it cannot come
	});
	return { ids, ties, lost };
}
/* Build the recorded tie-offs against the pasted pins. Each pin gets its own block —
   independent, so moving one copy can never disturb another — stepped further left
   for each extra tie on the same component so two of them never land on top of
   each other. */
function placeTies(sch, ties, idMap, newSel) {
	const placed = new Map();
	(ties || []).forEach(t => {
		const cid = idMap.get(t.cid); if (!cid) return;
		const target = comp(cid, sch); if (!target) return;
		const pp = portPos(target, t.pid); if (!pp) return;
		const td = TYPES[t.type]; if (!td) return;
		const params = JSON.parse(JSON.stringify(t.params || {}));
		const op = (td.ports(params) || []).find(p => p.dir === "out"); if (!op) return;
		const k = placed.get(cid) || 0; placed.set(cid, k + 1);
		const nc = {
			id: uid("c"), type: t.type, label: "", params,
			x: snap(pp.x - (3 + k * 5) * GRID - op.dx),
			y: snap(pp.y - op.dy)
		};
		sch.components.push(nc);
		sch.wires.push({ id: uid("w"), from: { cid: nc.id, pid: op.id }, to: { cid, pid: t.pid }, name: "" });
		if (newSel) newSel.add(nc.id);
	});
}
function duplicateSelection() {
	const sch = activeSch();
	const grab = copyPlan(sch, state.selection);      // the copy needs its own tie-offs
	const ids = grab.ids;
	const newSel = new Set();
	const idMap = new Map();
	sch.components.filter(c => ids.has(c.id)).forEach(c => {
		const nc = JSON.parse(JSON.stringify(c));
		// +2*GRID keeps every component (and a junction's box+6 dot) ON the grid; the
		// old +24 (24%11=2) shoved every copy — and every copied dot — off-grid, the
		// classic "สายหัก" source the moment anything connects to or nudges the copy
		nc.id = uid("c"); nc.x += 2 * GRID; nc.y += 2 * GRID;
		if (nc.label) nc.label = uniqueLabel(sch, nc.label);
		if (nc.type === "IN" || nc.type === "OUT") {
			const used = new Set(sch.components.filter(x => x.type === nc.type).map(x => x.params.name));
			let base = nc.params.name || (nc.type === "IN" ? "in" : "out");
			let nm = base, k = 1;
			while (used.has(nm)) nm = base + "_" + (k++);
			nc.params.name = nm;
		}
		sch.components.push(nc);
		idMap.set(c.id, nc.id);
		newSel.add(nc.id);
	});
	// copy wires between selected components — deep-clone so the user's manual route
	// (pts waypoints, dragged z/s bends mx/my, zjog) survives the duplicate. pts/autoPts/
	// mx/my are ABSOLUTE canvas coordinates, so freeze the auto jog onto the clone first
	// (else it recomputes from the copy's new row) and then shift everything with it.
	sch.wires.filter(w => ids.has(w.from.cid) && ids.has(w.to.cid)).forEach(w => {
		const nw = translateWire(freezeAutoRoute(JSON.parse(JSON.stringify(w)), w, sch), 2 * GRID, 2 * GRID);
		nw.id = uid("w");
		nw.from = { cid: idMap.get(w.from.cid), pid: w.from.pid };
		nw.to = { cid: idMap.get(w.to.cid), pid: w.to.pid };
		sch.wires.push(nw);
	});
	placeTies(sch, grab.ties, idMap, newSel);
	state.selection = newSel;
	snapshot(); renderAll();
	if (grab.lost) toast(`ทำซ้ำแล้ว — มี ${grab.lost} ขาที่ตัวขับอยู่นอกสิ่งที่เลือก ตัวที่คัดลอกจึงยังไม่มีสายที่ขานั้น`, "warn", 4600);
}

function copySelection() {
	const sch = activeSch();
	const grab = copyPlan(sch, state.selection);
	const ids = grab.ids;
	const comps = sch.components.filter(c => ids.has(c.id))
		.map(c => JSON.parse(JSON.stringify(c)));
	if (!comps.length) { toast("ไม่มี component ที่เลือก", "warn"); return; }
	const wires = sch.wires.filter(w => ids.has(w.from.cid) && ids.has(w.to.cid))
		.map(w => freezeAutoRoute(JSON.parse(JSON.stringify(w)), w, sch));
	state.clipboard = { components: comps, wires, ties: grab.ties };
	toast(`คัดลอก ${comps.length} บล็อกแล้ว`
		+ (grab.ties.length ? ` (พ่วง VCC/GND/CONST ที่ต่ออยู่มาด้วย ${grab.ties.length} ขา)` : "")
		+ (grab.lost ? ` — มี ${grab.lost} ขาที่ตัวขับอยู่นอกสิ่งที่เลือก จะไม่มีสายตอนวาง` : ""),
		grab.lost ? "warn" : "ok", grab.lost ? 4600 : 2200);
}

function pasteClipboard() {
	if (!state.clipboard || !state.clipboard.components.length) {
		toast("clipboard ว่าง", "warn"); return;
	}
	const sch = activeSch();
	// origin = top-left of clipboard
	let minX = Infinity, minY = Infinity;
	state.clipboard.components.forEach(c => {
		minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
	});
	const ox = snap(state.mouse.x - 30) - minX;
	const oy = snap(state.mouse.y - 20) - minY;
	const idMap = new Map();
	const newSel = new Set();
	state.clipboard.components.forEach(c => {
		const nc = JSON.parse(JSON.stringify(c));
		nc.id = uid("c");
		// snap what the user SEES — a junction's dot sits at box+6 and 6%GRID!=0, so
		// snapping the box lands the dot off-grid (a 5px kink); match the drag handler
		const q = nc.type === "JUNCTION" ? 6 : 0;
		nc.x = snap(c.x + ox + q) - q;
		nc.y = snap(c.y + oy + q) - q;
		if (nc.label) nc.label = uniqueLabel(sch, nc.label);
		if (nc.type === "IN" || nc.type === "OUT") {
			const used = new Set(sch.components.filter(x => x.type === nc.type).map(x => x.params.name));
			let base = nc.params.name || (nc.type === "IN" ? "in" : "out");
			let nm = base, k = 1;
			while (used.has(nm)) nm = base + "_" + (k++);
			nc.params.name = nm;
		}
		sch.components.push(nc);
		idMap.set(c.id, nc.id);
		newSel.add(nc.id);
	});
	state.clipboard.wires.forEach(w => {
		if (!idMap.has(w.from.cid) || !idMap.has(w.to.cid)) return;
		// deep-clone to keep the user's manual route (pts/mx/my/zjog), then move that
		// route by the same delta as the parts it connects
		const nw = translateWire(JSON.parse(JSON.stringify(w)), ox, oy);
		nw.id = uid("w");
		nw.from = { cid: idMap.get(w.from.cid), pid: w.from.pid };
		nw.to = { cid: idMap.get(w.to.cid), pid: w.to.pid };
		sch.wires.push(nw);
	});
	placeTies(sch, state.clipboard.ties, idMap, newSel);
	state.selection = newSel;
	snapshot(); render(); renderInspector();
	const nTie = (state.clipboard.ties || []).length;
	toast(`วาง ${state.clipboard.components.length} บล็อกแล้ว`
		+ (nTie ? ` พร้อม VCC/GND/CONST ติดขาใหม่ ${nTie} ตัว` : ""), "ok");
}

/* =========================================================================
   WIRE OPERATIONS
   ========================================================================= */
/* map a component's 0° local port offset (dx,dy) to its ORIENTED local offset —
   mirror (horizontal flip) then rotate about the body centre, the SAME transform
   the render group applies, so ports and the symbol always agree. */
function orientLocal(c, dx, dy) {
	const sz = getSize(c), w = sz.w, h = sz.h;
	let x = dx, y = dy;
	if (c.mirror) x = w - x;                       // flip left-right about the centre
	const cx = w / 2, cy = h / 2, rx = x - cx, ry = y - cy;
	let nx, ny;
	switch (((c.rot || 0) % 360 + 360) % 360) {
		case 90: nx = -ry; ny = rx; break;        // SVG rotate() is clockwise (y-down)
		case 180: nx = -rx; ny = -ry; break;
		case 270: nx = ry; ny = -rx; break;
		default: nx = rx; ny = ry; break;
	}
	return { x: cx + nx, y: cy + ny };
}
function portPos(c, pid) {
	const p = getPort(c, pid);
	if (!p) return null;
	const o = orientLocal(c, p.dx, p.dy);
	return { x: c.x + o.x, y: c.y + o.y };
}
/* Rotate / mirror placed symbols (ISE ECS-style). Bus taps/rippers carry their
   own orientation and junctions have none, so they are skipped. */
function orientable(c) { return !!c && c.type !== "JUNCTION" && c.type !== "BUSTAP"; }
function rotateSelection(step) {       // step +1 = CW 90°, -1 = CCW 90°
	const sch = activeSch();
	const cs = [...state.selection].map(id => comp(id, sch)).filter(orientable);
	if (!cs.length) { toast("เลือก component ที่จะหมุนก่อน", "warn"); return; }
	if (layoutLocked(sch)) { lockedNudge(); return; }   // turning a symbol re-aims its pins
	cs.forEach(c => { c.rot = (((c.rot || 0) + step * 90) % 360 + 360) % 360; });
	snapshot(); render(); renderInspector();
}
function mirrorSelection() {
	const sch = activeSch();
	const cs = [...state.selection].map(id => comp(id, sch)).filter(orientable);
	if (!cs.length) { toast("เลือก component ที่จะพลิกก่อน", "warn"); return; }
	if (layoutLocked(sch)) { lockedNudge(); return; }
	cs.forEach(c => { c.mirror = !c.mirror; });
	snapshot(); render(); renderInspector();
}
