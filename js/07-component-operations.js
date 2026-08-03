"use strict";

/* =========================================================================
   COMPONENT OPERATIONS
   ========================================================================= */
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
		hint: "<b>เครื่องมือ ≣ (B)</b> = ลากจากพอร์ต >1 bit ของ component สร้างบัส · <b>คลิกสายบัส</b> = วาง Bus Tap · <b>ล้อ/Space+ลาก</b> เลื่อนจอ · <b>Ctrl+ล้อ</b> ซูม · <b>Del</b> ลบ · <b>F7</b> ตรวจ"
	},
	wire: {
		cur: "crosshair", msg: "Add Wire — คลิกพอร์ต→พอร์ตเพื่อต่อสาย · คลิกกลางสาย = แยกสาย",
		hint: "<b>คลิกพอร์ต</b> เริ่มสาย → <b>คลิกพื้นว่าง</b> หักมุม → <b>คลิกพอร์ต/สาย</b> จบ · <b>ดับเบิลคลิก/Enter</b> = จบสายในที่ว่าง · <b>Backspace</b> ถอยมุม · <b>Esc</b> ยกเลิก"
	},
	netname: {
		cur: "text", msg: "Add Net Name — คลิกที่สายเพื่อตั้งชื่อ",
		hint: "<b>คลิกสาย</b> ตั้งชื่อ · บัสต้องลากจากพอร์ต >1 bit ของ component (ตั้งชื่อบัสได้ แต่ความกว้างมาจากพอร์ตต้นทาง)"
	},
	bus: {
		cur: "crosshair", msg: "Add Bus — ลากจากพอร์ต >1 bit ของ component เพื่อสร้างบัส · คลิกสายบัส = ดึงบิต (Bus Tap)",
		hint: "<b>ลากจากพอร์ต >1 bit</b> ของ component = สร้างสายบัส (ตั้งความกว้างพอร์ตใน Inspector) · <b>คลิกสายบัส</b> = วาง Bus Tap ดึงบิตถัดไป · <b>Esc</b> ยกเลิก · สร้างบัสลอยจากพื้นที่ว่างไม่ได้"
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
	$$("#canvasToolbar button").forEach(b => b.classList.toggle("active", b.dataset.tool === t));
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

/* bits already taken by Bus Taps on this wire's net (union of hi..lo ranges).
   The sweep is UNDIRECTED — a source connected INTO a free endpoint later gives
   the net wires of both orientations, and every tap must still be counted. */
function tappedBitsOnNet(w, sch) {
	sch = sch || activeSch();
	const used = new Set();
	const seenW = new Set(), seenJ = new Set(), stack = [];
	const noteTap = x => {
		const tc = comp(x.to.cid, sch);
		if (tc && tc.type === "BUSTAP" && x.to.pid === "d") {
			const hi = Math.max(tc.params.hi ?? 0, tc.params.lo ?? 0);
			const lo = Math.min(tc.params.hi ?? 0, tc.params.lo ?? 0);
			for (let b = lo; b <= hi; b++) used.add(b);
		}
	};
	const pushJ = cid => {
		const c0 = comp(cid, sch);
		if (c0 && c0.type === "JUNCTION" && !seenJ.has(c0.id)) { seenJ.add(c0.id); stack.push(c0.id); }
	};
	seenW.add(w.id); noteTap(w); pushJ(w.from.cid); pushJ(w.to.cid);
	while (stack.length) {
		const jid = stack.pop();
		sch.wires.forEach(x => {
			if (seenW.has(x.id)) return;
			if (x.from.cid === jid || x.to.cid === jid) {
				seenW.add(x.id); noteTap(x);
				pushJ(x.from.cid); pushJ(x.to.cid);
			}
		});
	}
	return used;
}
/* Add Bus Tap: click a bus wire → drop a tap flush on it (junction + triangle),
   inheriting the bus width. ISE-style auto-increment: each new tap takes the
   lowest bit not tapped yet on this net; when all bits are taken it wraps to 0
   (tapping the same bit twice is legal fan-out). */
function stampTapOnWire(w, point) {
	const sch = activeSch();
	const sw = netWidth(w, sch);
	if (sw <= 1) { toast("Bus Tap ใช้กับสายบัส (กว้าง > 1 bit) เท่านั้น", "warn"); return false; }
	const at = nearestOnWire(w, point, 0, sch);
	if (!at) return false;
	const used = tappedBitsOnNet(w, sch);
	let bit = 0; while (bit < sw && used.has(bit)) bit++;
	const full = bit >= sw;
	if (full) bit = 0;
	const j = { id: uid("c"), type: "JUNCTION", x: at.x - 6, y: at.y - 6, params: {} };
	sch.components.push(j);
	splitWireThroughJunction(w, j, sch);
	const tap = {
		id: uid("c"), type: "BUSTAP", x: 0, y: 0, label: "",
		params: { hi: bit, lo: bit, dir: at.seg === "v" ? "right" : "down" }
	};
	const dp0 = TYPES.BUSTAP.ports(tap.params).find(p => p.id === "d");
	tap.x = at.x - dp0.dx;   // seat so the d pin lands EXACTLY on the bus point (any tap size)
	tap.y = at.y - dp0.dy;
	sch.components.push(tap);
	sch.wires.push({ id: uid("w"), from: { cid: j.id, pid: "j" }, to: { cid: tap.id, pid: "d" }, name: "" });
	state.selection = new Set([tap.id]);
	snapshot(); render(); renderInspector();
	if (full) toast(`ครบทุกบิตแล้ว — วางซ้ำที่บิต [0] (ปรับช่วงได้ใน Inspector)`, "info", 3200);
	else toast(`วาง Bus Tap บิต [${bit}] แล้ว — คลิกต่อ = บิตถัดไป · ปรับช่วงใน Inspector`, "ok", 2800);
	return true;
}

/* the bus-side INPUT pin of a bus component (Bus Tap / Bus Ripper), or null */
function busInPin(c) {
	const td = typeDef(c);
	if (!td) return null;
	return td.ports(c.params || {}).find(p => p.dir === "in" && (p.bus || (p.width || 1) > 1)) || null;
}
/* AUTO-CONNECT a freshly placed bus component to a bus it was dropped on: if its
   bus-side pin lands within tol of a bus wire (netWidth>1), snap the pin onto that
   bus, split the bus with a junction, and wire the pin to it — so merely DROPPING
   the part on a bus connects it, no wire to route. A Bus Ripper with its untouched
   default slice is also seeded to a sensible half-split of the bus width. */
function attachBusPinToWire(c, tol = 44) {
	const sch = activeSch();
	let pin = busInPin(c);
	if (!pin) return false;
	// already wired to that pin? leave it alone
	if (sch.wires.some(w => (w.to.cid === c.id && w.to.pid === pin.id) || (w.from.cid === c.id && w.from.pid === pin.id))) return false;
	const dpos0 = { x: c.x + pin.dx, y: c.y + pin.dy };
	let best = null;
	for (const w of sch.wires) {
		if (netWidth(w, sch) <= 1) continue;                 // buses only
		const at = nearestOnWire(w, dpos0, 0, sch);
		if (at && (!best || at.d < best.at.d)) best = { w, at };
	}
	if (!best || best.at.d > tol) return false;
	const at = best.at;
	// orient a Bus Tap to point out the side it was dropped on, so it can ride the
	// left/right or top/bottom of the trunk; the Ripper stays horizontal.
	if (c.type === "BUSTAP") {
		const szT = getSize(c); const cenX = c.x + szT.w / 2, cenY = c.y + szT.h / 2;   // body centre (any size)
		c.params.dir = at.seg === "v" ? (cenX >= at.x ? "right" : "left")
			: (cenY >= at.y ? "down" : "up");
	}
	pin = busInPin(c);                                    // a dir change moves the pin
	const pp = { x: c.x + pin.dx, y: c.y + pin.dy };
	// seat the part so its bus pin sits EXACTLY on the tap point → the connector is
	// zero-length and it rides FLUSH on the bus, exactly like a clicked Bus Tap. If
	// instead we left it offset, that connector would carry the full bus width and
	// render as a THICK purple stub branching off the trunk (the "extra bent wire").
	// NOTE: do NOT snap() here — the bus coord (at) may sit off the 11px grid (ports
	// can), and snapping would nudge the pin off the junction, re-opening a stub.
	c.x = c.x + (at.x - pp.x);
	c.y = c.y + (at.y - pp.y);
	const j = { id: uid("c"), type: "JUNCTION", x: at.x - 6, y: at.y - 6, params: {} };
	sch.components.push(j);
	splitWireThroughJunction(best.w, j, sch);
	sch.wires.push({ id: uid("w"), from: { cid: j.id, pid: "j" }, to: { cid: c.id, pid: pin.id }, name: "" });
	snapshot(); render(); renderInspector();
	return true;
}
/* Called after a bus component is MOVED: keep it glued to the bus under its pin —
   snap ONTO a bus when dragged close, drop OFF when dragged well clear of every
   bus (the junction it sat on then heals back into the trunk). */
function syncBusAttachment(c) {
	const sch = activeSch();
	const pin = busInPin(c);
	if (!pin) return;
	const label = "Bus Tap";
	// Detach any existing bus connector first, then RE-SEAT flush at the current
	// nearest point — so moving the part SLIDES it along the bus (instead of leaving
	// its junction behind and stretching a thick stub). Moved clear → stays off.
	const links = sch.wires.filter(w => (w.to.cid === c.id && w.to.pid === pin.id) || (w.from.cid === c.id && w.from.pid === pin.id));
	const wasAttached = links.length > 0;
	if (wasAttached) { sch.wires = sch.wires.filter(w => !links.includes(w)); healJunctions(sch); }
	if (attachBusPinToWire(c)) {                             // near a bus → (re)seat flush
		if (!wasAttached) toast(`เกาะ ${label} เข้าสายบัสแล้ว`, "ok", 2000);
	} else if (wasAttached) {
		toast(`ปลด ${label} ออกจากบัสแล้ว`, "info", 2200);
	}
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
	sch.components = sch.components.filter(c => !ids.has(c.id));
	sch.wires = sch.wires.filter(w => !ids.has(w.id) && !ids.has(w.from.cid) && !ids.has(w.to.cid));
	state.selection.clear();
	// a wire being drawn FROM a component we just deleted must die with it — else the
	// next port click dereferences the dead cid and throws, but only AFTER the
	// one-driver filter has already removed that sink's existing wire (silent loss)
	if (state.pendingWire && !comp(state.pendingWire.cid, sch)) state.pendingWire = null;
	healJunctions(sch);   // junctions clean themselves up when no longer needed
	snapshot(); renderAll();
	if (lostBus) toast("ลบป้ายชื่อบัสแล้ว — สายนี้ไม่เป็นบัสอีกต่อไป (Bus Tap ที่เหลือจะฟ้องตอนตรวจ)", "warn", 3600);
}
function duplicateSelection() {
	const sch = activeSch();
	const ids = new Set(state.selection);
	const newSel = new Set();
	const idMap = new Map();
	sch.components.filter(c => ids.has(c.id)).forEach(c => {
		const nc = JSON.parse(JSON.stringify(c));
		// +2*GRID keeps every component (and a junction's box+6 dot) ON the grid; the
		// old +24 (24%11=2) shoved every copy — and every copied dot — off-grid, the
		// classic "สายหัก" source the moment anything connects to or nudges the copy
		nc.id = uid("c"); nc.x += 2 * GRID; nc.y += 2 * GRID;
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
	// (pts waypoints, dragged z/s bends mx/my, zjog) survives the duplicate
	sch.wires.filter(w => ids.has(w.from.cid) && ids.has(w.to.cid)).forEach(w => {
		const nw = JSON.parse(JSON.stringify(w));
		nw.id = uid("w");
		nw.from = { cid: idMap.get(w.from.cid), pid: w.from.pid };
		nw.to = { cid: idMap.get(w.to.cid), pid: w.to.pid };
		sch.wires.push(nw);
	});
	state.selection = newSel;
	snapshot(); renderAll();
}

function copySelection() {
	const sch = activeSch();
	const ids = new Set(state.selection);
	const comps = sch.components.filter(c => ids.has(c.id))
		.map(c => JSON.parse(JSON.stringify(c)));
	if (!comps.length) { toast("ไม่มี component ที่เลือก", "warn"); return; }
	const wires = sch.wires.filter(w => ids.has(w.from.cid) && ids.has(w.to.cid))
		.map(w => JSON.parse(JSON.stringify(w)));
	state.clipboard = { components: comps, wires };
	toast(`คัดลอก ${comps.length} บล็อกแล้ว`, "ok");
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
		// deep-clone to keep the user's manual route (pts/mx/my/zjog)
		const nw = JSON.parse(JSON.stringify(w));
		nw.id = uid("w");
		nw.from = { cid: idMap.get(w.from.cid), pid: w.from.pid };
		nw.to = { cid: idMap.get(w.to.cid), pid: w.to.pid };
		sch.wires.push(nw);
	});
	state.selection = newSel;
	snapshot(); render(); renderInspector();
	toast(`วาง ${state.clipboard.components.length} บล็อกแล้ว`, "ok");
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
	cs.forEach(c => { c.rot = (((c.rot || 0) + step * 90) % 360 + 360) % 360; });
	snapshot(); render(); renderInspector();
}
function mirrorSelection() {
	const sch = activeSch();
	const cs = [...state.selection].map(id => comp(id, sch)).filter(orientable);
	if (!cs.length) { toast("เลือก component ที่จะพลิกก่อน", "warn"); return; }
	cs.forEach(c => { c.mirror = !c.mirror; });
	snapshot(); render(); renderInspector();
}
