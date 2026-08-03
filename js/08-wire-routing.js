"use strict";

function onPortClick(c, p) {
	const sch = activeSch();
	// completing a branch that was started from a wire (deferred junction) →
	// place the junction optimally on the net, nearest this target
	if (state.pendingWire && state.pendingWire.onWire) {
		const wid = state.pendingWire.onWire;
		state.pendingWire = null;
		if (p.dir === "out") { toast("ต่อปลายทางเป็น output ไม่ได้ — เลือกขา input", "warn"); render(); return; }
		const w = sch.wires.find(x => x.id === wid);
		if (w) {
			const driver = netDriverPort(sch, w);
			if (driver) {
				sch.wires = sch.wires.filter(x => !(x.to.cid === c.id && x.to.pid === p.id));  // one driver
				if (!branchFromNet(sch, driver, { cid: c.id, pid: p.id })) {
					sch.wires.push({ id: uid("w"), from: driver, to: { cid: c.id, pid: p.id }, name: "" });
				}
				healLayout(sch);   // align alone would re-take columns separate just freed
			}
		}
		snapshot(); render();
		return;
	}
	if (!state.pendingWire) {
		state.pendingWire = { cid: c.id, pid: p.id, isOut: p.dir === "out", pts: [] };
		render();
		return;
	}
	const A = state.pendingWire;
	const B = { cid: c.id, pid: p.id, isOut: p.dir === "out" };
	if (A.cid === B.cid && A.pid === B.pid) { state.pendingWire = null; healJunctions(sch); render(); return; }
	const ca = comp(A.cid), cb = comp(B.cid);
	const aJunc = ca?.type === "JUNCTION";
	const bJunc = cb?.type === "JUNCTION";
	// Same direction & neither is a junction.
	if (A.isOut === B.isOut && !aJunc && !bJunc) {
		if (!A.isOut) {
			// TWO INPUT (sink) ports → tie them onto ONE shared net (real schematics
			// allow wiring inputs together to carry the same signal). If either side
			// already sits on a driven net, the other TAPS that driver so both get it.
			const wA = sch.wires.find(w => w.to.cid === A.cid && w.to.pid === A.pid);
			const wB = sch.wires.find(w => w.to.cid === B.cid && w.to.pid === B.pid);
			const drv = (wA && netDriverPort(sch, wA)) || (wB && netDriverPort(sch, wB)) || null;
			if (drv) {
				const target = wA ? B : A;                 // attach the not-yet-driven side
				sch.wires = sch.wires.filter(w => !(w.to.cid === target.cid && w.to.pid === target.pid)); // one driver
				if (!branchFromNet(sch, drv, { cid: target.cid, pid: target.pid })) {
					sch.wires.push({ id: uid("w"), from: drv, to: { cid: target.cid, pid: target.pid }, name: "" });
				}
				toast("เชื่อมขา input เข้าเน็ตเดียวกันแล้ว — ใช้สัญญาณร่วมกัน", "ok", 2600);
			} else {
				// neither is driven yet → tie both to a shared NET NODE (a junction), so
				// driving any tied input later (tie-through, below) feeds them all
				const pa = portPos(comp(A.cid, sch), A.pid), pb = portPos(comp(B.cid, sch), B.pid);
				const j = { id: uid("c"), type: "JUNCTION", x: snap((pa.x + pb.x) / 2) - 6, y: snap((pa.y + pb.y) / 2) - 6, params: {} };
				sch.components.push(j);
				sch.wires.push({ id: uid("w"), from: { cid: j.id, pid: "j" }, to: { cid: A.cid, pid: A.pid }, name: "" });
				sch.wires.push({ id: uid("w"), from: { cid: j.id, pid: "j" }, to: { cid: B.cid, pid: B.pid }, name: "" });
				toast("เชื่อมขา input สองขาแล้ว — ต่อ source เข้าขาใดก็ป้อนทั้งคู่", "info", 3000);
			}
			state.pendingWire = null;
			healJunctions(sch); healLayout(sch);
			snapshot(); render();
			return;
		}
		// two OUTPUT / driver ports → can't wire two drivers together; restart from B
		state.pendingWire = B; render(); return;
	}
	// Determine direction. If both are "out" but one is a junction, the
	// junction accepts the wire as an input (it is transparent). Same for
	// both "in".
	let fromPort, toPort;
	if (A.isOut && !B.isOut) { fromPort = A; toPort = B; }
	else if (!A.isOut && B.isOut) { fromPort = B; toPort = A; }
	else if (A.isOut && B.isOut) { fromPort = aJunc ? B : A; toPort = aJunc ? A : B; }
	else { fromPort = aJunc ? A : B; toPort = aJunc ? B : A; }
	// Tie-through: if the sink is already hung off an UNDRIVEN junction (a shared
	// net made by tying inputs together), retarget the driver to that junction so
	// it feeds EVERY tied sink — instead of stealing this one port off the net.
	if (comp(toPort.cid) && comp(toPort.cid).type !== "JUNCTION") {
		const feed = sch.wires.find(w => w.to.cid === toPort.cid && w.to.pid === toPort.pid);
		const fj = feed && comp(feed.from.cid, sch);
		if (fj && fj.type === "JUNCTION" && !sch.wires.some(w => w.to.cid === fj.id)) {
			toPort = { cid: fj.id, pid: "j" };
		}
	}
	// For non-junction targets, ensure only one driver
	if (comp(toPort.cid).type !== "JUNCTION") {
		sch.wires = sch.wires.filter(w => !(w.to.cid === toPort.cid && w.to.pid === toPort.pid));
	}
	const fc = comp(fromPort.cid); const tc = comp(toPort.cid);
	const fp = getPort(fc, fromPort.pid); const tp = getPort(tc, toPort.pid);
	const fw = fp.width || 1, tw = tp.width || 1;
	// a BUS TAP's d pin takes any bus width; junctions are width-transparent
	if (fw !== tw && fc.type !== "JUNCTION" && tc.type !== "JUNCTION" && tc.type !== "BUSTAP") {
		toast(`Width mismatch: ${fw} → ${tw}`, "warn");
	}
	// waypoints drawn by the user → honour the exact route (ordered from source
	// to sink); otherwise auto-route (and fan out through a junction if needed)
	const drawnFromSource = A.cid === fromPort.cid && A.pid === fromPort.pid;
	const pts = (A.pts && A.pts.length)
		? (drawnFromSource ? A.pts.slice() : A.pts.slice().reverse())
		: null;
	if (pts) {
		sch.wires.push({
			id: uid("w"),
			from: { cid: fromPort.cid, pid: fromPort.pid },
			to: { cid: toPort.cid, pid: toPort.pid },
			name: "", pts
		});
	} else if (!branchFromNet(sch, fromPort, toPort)) {
		sch.wires.push({
			id: uid("w"),
			from: { cid: fromPort.cid, pid: fromPort.pid },
			to: { cid: toPort.cid, pid: toPort.pid },
			name: ""
		});
	}
	state.pendingWire = null;
	healLayout(sch);   // full pass — align alone fights separateWireOverlaps (ping-pong)
	snapshot(); render();
}
/* the running "cursor" of the wire being drawn = last committed corner, or the
   start port if none yet */
function pendingLastPoint(sch) {
	const pw = state.pendingWire;
	if (!pw) return null;
	if (pw.pts && pw.pts.length) return pw.pts[pw.pts.length - 1];
	if (pw.onWire) { return pw.anchor; }
	const c = comp(pw.cid, sch); return c ? portPos(c, pw.pid) : null;
}
/* add an orthogonal corner at the cursor while drawing a wire */
function addWireCorner() {
	const pw = state.pendingWire;
	if (!pw || !pw.pts) return;
	const last = pendingLastPoint(activeSch());
	if (!last) return;
	const pt = orthoStep(last, state.mouse);
	if (pt.x !== last.x || pt.y !== last.y) { pw.pts.push(pt); render(); }
}
/* finish the wire being drawn in OPEN SPACE — leaves a free endpoint (an
   "endpoint" junction) so a bus stub can be routed first and tapped later */
function finishWireInSpace() {
	const pw = state.pendingWire;
	if (!pw || !pw.pts) { return; }
	const sch = activeSch();
	const src = comp(pw.cid, sch);
	if (!src) { state.pendingWire = null; render(); return; }
	const srcPos = portPos(src, pw.pid);
	// endpoint = the last committed corner, else one orthogonal step from source
	let endPt, pts;
	if (pw.pts.length) { endPt = pw.pts[pw.pts.length - 1]; pts = pw.pts.slice(0, -1); }
	else { endPt = orthoStep(srcPos, state.mouse); pts = []; }
	if (endPt.x === srcPos.x && endPt.y === srcPos.y) {
		state.pendingWire = null; healJunctions(sch); render(); return;   // drop a 0-wire orphan (e.g. bus node)
	}
	const j = { id: uid("c"), type: "JUNCTION", x: endPt.x - 6, y: endPt.y - 6, params: { endpoint: true } };
	sch.components.push(j);
	const ordered = pw.isOut ? pts : pts.slice().reverse();
	const nw = { id: uid("w"), name: "", pts: ordered };
	if (pw.isOut) { nw.from = { cid: pw.cid, pid: pw.pid }; nw.to = { cid: j.id, pid: "j" }; }
	else { nw.from = { cid: j.id, pid: "j" }; nw.to = { cid: pw.cid, pid: pw.pid }; }
	sch.wires.push(nw);
	state.pendingWire = null;
	// if the end landed on an existing wire, weld a real junction there
	const welded = weldTouchingEnds(sch);
	if (welded) healJunctions(sch);   // tidy any pass-throughs the weld produced
	snapshot(); render();
	toast(welded
		? "ต่อสายเข้ากับสายเดิมแล้ว — จุดต่อขึ้นสี่เหลี่ยมทึบ"
		: (netWidth(nw, sch) > 1
			? "จบสายบัสในที่ว่างแล้ว — ใช้เครื่องมือ ≣ หรือคลิกขวาที่สายเพื่อดึงบิต"
			: "จบสายในที่ว่างแล้ว — คลิกปลายสายด้วยเครื่องมือ ╱ เพื่อต่อทีหลัง"), "ok", 3200);
}

/* =========================================================================
   WIRE ROUTING  (Manhattan / 90-degree)
   A wire may carry a user-adjusted bend position:
	 w.mx — x of the vertical middle segment (staircase route)
	 w.my — y of the middle horizontal segment (S / wrap-around route)
   Both persist in the project file; when absent the route defaults to the
   midpoint and render() shifts it automatically to avoid overlapping runs.
   ========================================================================= */
const WIRE_MINLEG = 22;   // = 2*GRID, so every jog leg lands on a grid column (ISE-like)
/* project `to` onto a horizontal or vertical step from `from` (grid-snapped) */
function orthoStep(from, to) {
	const dx = to.x - from.x, dy = to.y - from.y;
	return Math.abs(dx) >= Math.abs(dy) ? { x: snap(to.x), y: from.y } : { x: from.x, y: snap(to.y) };
}
/* force a point list into an orthogonal polyline, inserting elbows where two
   consecutive points differ on both axes. fromH/toH pick the elbow orientation
   at the two port ends so wires leave/enter along the port's natural side. */
function orthoPolyline(points, fromH = true, toH = true) {
	const out = [points[0]];
	for (let i = 1; i < points.length; i++) {
		const a = out[out.length - 1], b = points[i];
		if (Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5) {
			const horizFirst = i === 1 ? fromH : i === points.length - 1 ? !toH : true;
			out.push(horizFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
		}
		if (Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5) out.push({ x: b.x, y: b.y });
	}
	// tidy: drop straight-through midpoints and collapse A→B→A backtracks
	let changed = true;
	while (changed && out.length > 2) {
		changed = false;
		for (let i = 1; i < out.length - 1; i++) {
			const a = out[i - 1], b = out[i], c = out[i + 1];
			if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) { out.splice(i, 1); changed = true; break; }
			if (a.x === c.x && a.y === c.y) { out.splice(i, 2); changed = true; break; }
		}
	}
	return out;
}
/* is a port on the left/right edge (horizontal entry) vs top/bottom (vertical)? */
function portSideH(c, pid) {
	const p = getPort(c, pid); if (!p) return true;
	const sz = getSize(c);
	const origH = p.dx <= 1 || p.dx >= sz.w - 1;    // left/right edge → horizontal at 0°
	const r = ((c.rot || 0) % 360 + 360) % 360;           // 90/270 swap H<->V; mirror keeps it
	return (r === 90 || r === 270) ? !origH : origH;
}
/* a junction has no fixed side — a wire attached to it should leave/enter
   PERPENDICULAR to the host wire passing through (horizontal host → the branch
   exits vertically out of the top/bottom of the square, and vice-versa).
   Returns true if the attached wire should be horizontal at the junction. */
function junctionExitH(j, self, sch) {
	const jp = portPos(j, "j");
	let horiz = false, vert = false;
	sch.wires.forEach(w => {
		if (w === self || (w.from.cid !== j.id && w.to.cid !== j.id)) return;
		const oc = comp(w.from.cid === j.id ? w.to.cid : w.from.cid, sch);
		const op = oc && portPos(oc, w.from.cid === j.id ? w.to.pid : w.from.pid);
		if (!op) return;
		if (Math.abs(op.y - jp.y) < 0.5) horiz = true;   // a host runs horizontally
		if (Math.abs(op.x - jp.x) < 0.5) vert = true;   // a host runs vertically
	});
	// exit perpendicular: horizontal host → false (exit vertical); vertical → true
	if (horiz && !vert) return false;
	if (vert && !horiz) return true;
	return false;   // ambiguous → exit vertical (down/up out of the square)
}
/* a Bus Tap / Ripper bus-side pin ("d") accepts the bus from ANY direction, like a
   junction — the wire approaches along whichever axis it mostly runs, so the thick
   bus never has to bend perpendicular INTO the tap (the classic "เส้นหัก"). */
function portExitH(c, pid, w, sch) {
	if (c.type === "JUNCTION") return junctionExitH(c, w, sch);
	if (c.type === "BUSTAP" && pid === "d") {
		const oCid = w.from.cid === c.id ? w.to.cid : w.from.cid;
		const oPid = w.from.cid === c.id ? w.to.pid : w.from.pid;
		const op = portPos(comp(oCid, sch), oPid), dp = portPos(c, "d");
		if (op && dp) return Math.abs(op.x - dp.x) >= Math.abs(op.y - dp.y);   // run along the wire
	}
	return portSideH(c, pid);
}
/* the fromH/toH routing hints for a wire, from its two ports' sides */
function wireOpts(w, sch) {
	sch = sch || activeSch();
	const a = comp(w.from.cid, sch), b = comp(w.to.cid, sch);
	const fromH = a ? portExitH(a, w.from.pid, w, sch) : true;
	const toH = b ? portExitH(b, w.to.pid, w, sch) : true;
	// a bus tap/ripper bus-pin as the DESTINATION may force a straight perpendicular
	// entry so the thick bus never bends INTO it. Kept localized to tap "d" pins so
	// junction routing (which has always ignored toH) is completely unaffected.
	const endTapV = !!(b && b.type === "BUSTAP" && w.to.pid === "d" && toH === false);
	return { fromH, toH, endTapV };
}
function wireRoute(w, p1, p2, opts) {
	const x1 = Math.round(p1.x), y1 = Math.round(p1.y);
	const x2 = Math.round(p2.x), y2 = Math.round(p2.y);
	// explicit user route (waypoints) — draw straight through the corners, any
	// direction; only auto-elbow the connections to the two ports
	if (w && w.pts && w.pts.length) {
		const raw = [{ x: x1, y: y1 }, ...w.pts.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })), { x: x2, y: y2 }];
		const pts = orthoPolyline(raw, opts ? opts.fromH !== false : true, opts ? opts.toH !== false : true);
		return { kind: "poly", x1, y1, x2, y2, pts, d: "M" + pts.map(p => `${p.x},${p.y}`).join("L") };
	}
	if (Math.abs(y2 - y1) < 0.5) return { kind: "h", x1, y1, x2, y2, d: `M${x1},${y1}H${x2}` };
	if (Math.abs(x2 - x1) < 0.5) return { kind: "v", x1, y1, x2, y2, d: `M${x1},${y1}V${y2}` };
	// destination is a bus tap wanting a straight VERTICAL entry → exit the source
	// horizontally, cross, then drop straight into the tap (no perpendicular bend on
	// the thick bus). Only when the source itself isn't vertical-exiting.
	if (opts && opts.endTapV && opts.fromH !== false) {
		return { kind: "lh", x1, y1, x2, y2, d: `M${x1},${y1}H${x2}V${y2}` };
	}
	// source wants a vertical exit (e.g. a branch leaving the bottom/top of a
	// junction on a horizontal wire) → L that goes straight out then across.
	// EXCEPT the degenerate case: a mostly-horizontal FORWARD branch whose row change
	// is under one leg (e.g. 1 grid) — an L would pin the kink right AT the junction
	// square (renders as a fat "broken wire" blob). Fall through so the jog lands
	// mid-span (z) or at the sink (lh) instead.
	if (opts && opts.fromH === false) {
		// "degenerate" = a tiny row change pinned as a stub right at the junction, better
		// jogged MID-SPAN. But mid-span means the z below, which needs 2*WIRE_MINLEG of
		// run — so only defer when that z actually exists. Without this width test a
		// short branch falls through to "lh" (horizontal-first), which is strictly worse:
		// it pins the kink at the SINK, and when a dot feeds two pins on one symbol BOTH
		// branches then share the run and split against the symbol, leaving the dot
		// stranded on a bare stub with a bare T at the gate.
		const degen = Math.abs(y2 - y1) < WIRE_MINLEG && (x2 - x1) >= 2 * WIRE_MINLEG;
		// w.zjog (set by separateWireOverlaps): this L's horizontal tail lay along
		// another net's run on the destination-pin row — take the z shape instead
		// (head rides its own trunk row, tail drops in past the conflict).
		if (!degen && !(w && w.zjog)) return { kind: "l", x1, y1, x2, y2, d: `M${x1},${y1}V${y2}H${x2}` };
	}
	if (x2 - x1 >= 2 * WIRE_MINLEG) {
		// Staircase through an adjustable vertical leg. Default: a column CENTRED on the
		// span (ISE-like, stable while dragging), fanned over <=5 nearby columns by the
		// source row so stacked parallel wires don't share a leg — and never hugging
		// either end, so the jog can't sit against a pin/junction square. A user drag
		// (w.mx) always wins; real collisions are resolved by separateWireOverlaps.
		let mx;
		if (w && typeof w.mx === "number") { mx = w.mx; }
		else {
			const loX = x1 + WIRE_MINLEG, hiX = x2 - WIRE_MINLEG;
			const cols = Math.max(1, Math.floor((hiX - loX) / GRID) + 1);
			const row = Math.round(y1 / GRID);
			const fan = Math.max(1, Math.min(5, cols - 2));
			const off = (((row % fan) + fan) % fan) - (fan >> 1);
			const mid = loX + Math.round((hiX - loX) / (2 * GRID)) * GRID;
			mx = mid + off * GRID;
		}
		mx = snap(clamp(mx, x1 + WIRE_MINLEG, x2 - WIRE_MINLEG));
		return { kind: "z", x1, y1, x2, y2, mx, d: `M${x1},${y1}H${mx}V${y2}H${x2}` };
	}
	// source exits HORIZONTAL here (the fromH===false L already returned above). When
	// the target is AHEAD (or level), leave the port horizontally then drop STRAIGHT
	// down/up into it — a clean H-then-V L. This is what makes a bus land square on a
	// tap/pin instead of running down off-axis and jogging sideways into it.
	if (x2 >= x1) {
		return { kind: "lh", x1, y1, x2, y2, d: `M${x1},${y1}H${x2}V${y2}` };
	}
	// target is BEHIND (to the left) but the run is mostly vertical → a V-then-H L
	// still reads cleanly without doubling back.
	if (Math.abs(y2 - y1) > Math.abs(x2 - x1)) {
		return { kind: "l", x1, y1, x2, y2, d: `M${x1},${y1}V${y2}H${x2}` };
	}
	// wrap-around: source is to the right of target → S-route, middle leg adjustable
	const my = snap((w && typeof w.my === "number") ? w.my : (y1 + y2) / 2);
	return { kind: "s", x1, y1, x2, y2, my, d: `M${x1},${y1}H${x1 + WIRE_MINLEG}V${my}H${x2 - WIRE_MINLEG}V${y2}H${x2}` };
}
function wirePath(p1, p2) { return wireRoute(null, p1, p2).d; }

/* Break a route into ordered orthogonal parts (as the pen walks it) so we can
   insert crossing "hops" on horizontal runs. */
function routeParts(r) {
	if (r.kind === "poly") {
		const segs = [];
		for (let i = 1; i < r.pts.length; i++) {
			const a = r.pts[i - 1], b = r.pts[i];
			if (Math.abs(a.y - b.y) < 0.5) segs.push({ t: "h", x1: a.x, x2: b.x, y: a.y });
			else segs.push({ t: "v", x: a.x, y1: a.y, y2: b.y });
		}
		return segs;
	}
	if (r.kind === "h") return [{ t: "h", x1: r.x1, x2: r.x2, y: r.y1 }];
	if (r.kind === "v") return [{ t: "v", x: r.x1, y1: r.y1, y2: r.y2 }];
	if (r.kind === "l") return [
		{ t: "v", x: r.x1, y1: r.y1, y2: r.y2 },
		{ t: "h", x1: r.x1, x2: r.x2, y: r.y2 },
	];
	if (r.kind === "lh") return [
		{ t: "h", x1: r.x1, x2: r.x2, y: r.y1 },
		{ t: "v", x: r.x2, y1: r.y1, y2: r.y2 },
	];
	if (r.kind === "z") return [
		{ t: "h", x1: r.x1, x2: r.mx, y: r.y1 },
		{ t: "v", x: r.mx, y1: r.y1, y2: r.y2 },
		{ t: "h", x1: r.mx, x2: r.x2, y: r.y2 },
	];
	const L = WIRE_MINLEG;   // s-route
	return [
		{ t: "h", x1: r.x1, x2: r.x1 + L, y: r.y1 },
		{ t: "v", x: r.x1 + L, y1: r.y1, y2: r.my },
		{ t: "h", x1: r.x1 + L, x2: r.x2 - L, y: r.my },
		{ t: "v", x: r.x2 - L, y1: r.my, y2: r.y2 },
		{ t: "h", x1: r.x2 - L, x2: r.x2, y: r.y2 },
	];
}
/* Build an SVG path for a route, drawing a small semicircular hop wherever a
   horizontal run crosses another wire's vertical run — so crossings that are
   NOT electrical connections read clearly instead of looking joined. */
function hoppedPathD(r, allV, wid) {
	const HR = 5;
	const parts = routeParts(r);
	if (!parts.length) return r.d;   // degenerate (single-point) route
	const p0 = parts[0];
	let d = `M${p0.t === "h" ? p0.x1 : p0.x},${p0.t === "h" ? p0.y : p0.y1}`;
	for (const part of parts) {
		if (part.t === "v") { d += `V${part.y2}`; continue; }
		const dir = part.x2 >= part.x1 ? 1 : -1;
		const y = part.y, hlo = Math.min(part.x1, part.x2), hhi = Math.max(part.x1, part.x2);
		const xs = [];
		for (const v of allV) {
			if (v.wid === wid) continue;
			const vlo = Math.min(v.y1, v.y2), vhi = Math.max(v.y1, v.y2);
			if (v.x > hlo + HR && v.x < hhi - HR && y > vlo + 2 && y < vhi - 2) xs.push(v.x);
		}
		// de-dupe near-coincident crossings, order along travel direction
		xs.sort((a, b) => a - b);
		const uniq = xs.filter((x, i) => i === 0 || x - xs[i - 1] > 2 * HR);
		if (dir < 0) uniq.reverse();
		for (const hx of uniq) {
			d += `H${hx - dir * HR}A${HR},${HR} 0 0 ${dir > 0 ? 1 : 0} ${hx + dir * HR},${y}`;
		}
		d += `H${part.x2}`;
	}
	return d;
}

/* Junction helpers — wire-to-wire connections via a transparent dot */
/* nearest point ON a wire's rendered route: the cross-axis coordinate stays
   exactly on the wire (no kink), only the along-axis coordinate grid-snaps */
function nearestOnWire(w, pt, margin = 0, sch = activeSch()) {
	const a = comp(w.from.cid, sch), b = comp(w.to.cid, sch);
	if (!a || !b) return null;
	const p1 = portPos(a, w.from.pid), p2 = portPos(b, w.to.pid);
	if (!p1 || !p2) return null;
	let best = null;
	routeParts(wireRoute(w, p1, p2, wireOpts(w, sch))).forEach(part => {
		let px, py, lo, hi;
		if (part.t === "h") { lo = Math.min(part.x1, part.x2) + margin; hi = Math.max(part.x1, part.x2) - margin; }
		else { lo = Math.min(part.y1, part.y2) + margin; hi = Math.max(part.y1, part.y2) - margin; }
		if (hi < lo) return;   // segment too short for the requested margin
		if (part.t === "h") { px = clamp(pt.x, lo, hi); py = part.y; }
		else { px = part.x; py = clamp(pt.y, lo, hi); }
		const d = Math.hypot(pt.x - px, pt.y - py);
		if (!best || d < best.d) best = { d, seg: part.t, px, py, lo, hi };
	});
	if (!best) return null;
	// lo/hi = how far the tap may still slide ALONG this segment; callers that must
	// keep a dot clear of a symbol need the span, not just the ideal point
	if (best.seg === "h") return { seg: "h", d: best.d, x: clamp(snap(best.px), best.lo, best.hi), y: best.py, lo: best.lo, hi: best.hi };
	return { seg: "v", d: best.d, x: best.px, y: clamp(snap(best.py), best.lo, best.hi), lo: best.lo, hi: best.hi };
}
/* A connection dot must be GRABBABLE. "Nearest point on the net" alone parks it
   against the symbol edge — 1 grid off the input pin — where the pin's own hit
   circle eats the mousedown and the dot can't be picked up. ISE never seats a dot
   on a symbol; it taps the trunk a clear leg away and runs the branch in.
   GRAB_CLEAR: the dot's hit square is 18px (±9) and a port's is r=9, so 22px of
   body clearance both separates the two hit shapes and leaves a visible leg. */
const GRAB_CLEAR = WIRE_MINLEG;
function bodyClearance(pt, sch) {
	let d = Infinity;
	for (const c of sch.components) {
		if (c.type === "JUNCTION") continue;            // dots may meet dots; only symbols push back
		const td = typeDef(c); if (!td || !td.size) continue;
		const s = td.size(c.params || {});
		const dx = Math.max(c.x - pt.x, 0, pt.x - (c.x + s.w));
		const dy = Math.max(c.y - pt.y, 0, pt.y - (c.y + s.h));
		d = Math.min(d, Math.hypot(dx, dy));
	}
	return d;
}
/* slide a tap along its own segment to the closest grid spot that clears every
   symbol; null = this segment has nowhere legal, so the caller must not tap here */
function tapClearOfBodies(at, sch) {
	if (!at) return null;
	const horiz = at.seg === "h";
	const v0 = horiz ? at.x : at.y;
	const put = v => horiz ? { x: v, y: at.y } : { x: at.x, y: v };
	const cands = [];
	for (let v = Math.ceil(at.lo / GRID) * GRID; v <= at.hi; v += GRID) cands.push(v);
	cands.sort((a, b) => Math.abs(a - v0) - Math.abs(b - v0));   // nearest-to-ideal first
	for (const v of cands) {
		const p = put(v);
		if (bodyClearance(p, sch) >= GRAB_CLEAR)
			return { seg: at.seg, d: at.d + Math.abs(v - v0), x: p.x, y: p.y, lo: at.lo, hi: at.hi };
	}
	return null;
}
/* Closest take-off on wire w to pt that still clears every symbol. nearestOnWire
   commits to the single nearest SEGMENT — which is usually the leg hugging the very
   symbol we need clearance from, so sliding along it finds nothing and we'd give up
   and seat the dot on the pin anyway. Search every segment instead: the leg before
   the last turn nearly always has room. */
function nearestClearOnWire(w, pt, sch) {
	const a = comp(w.from.cid, sch), b = comp(w.to.cid, sch);
	if (!a || !b) return null;
	const p1 = portPos(a, w.from.pid), p2 = portPos(b, w.to.pid);
	if (!p1 || !p2) return null;
	let best = null;
	routeParts(wireRoute(w, p1, p2, wireOpts(w, sch))).forEach(part => {
		const horiz = part.t === "h";
		const lo = (horiz ? Math.min(part.x1, part.x2) : Math.min(part.y1, part.y2)) + GRID;
		const hi = (horiz ? Math.max(part.x1, part.x2) : Math.max(part.y1, part.y2)) - GRID;
		if (hi < lo) return;                       // leg too short to tap
		const at = tapClearOfBodies({
			seg: part.t, d: 0, lo, hi,
			x: horiz ? clamp(snap(pt.x), lo, hi) : part.x,
			y: horiz ? part.y : clamp(snap(pt.y), lo, hi)
		}, sch);
		if (!at) return;
		const d = Math.hypot(pt.x - at.x, pt.y - at.y);
		if (!best || d < best.d) best = { seg: at.seg, d, x: at.x, y: at.y, lo, hi };
	});
	return best;
}
function createJunctionOnWire(w, point) {
	const sch = activeSch();
	const at = nearestOnWire(w, point) || { x: snap(point.x), y: snap(point.y), seg: "h" };
	const j = { id: uid("c"), type: "JUNCTION", x: at.x - 6, y: at.y - 6, params: {} };
	sch.components.push(j);
	return { j, seg: at.seg };
}
function splitWireThroughJunction(w, j, sch = activeSch()) {
	const idx = sch.wires.indexOf(w);
	if (idx < 0) return;
	sch.wires.splice(idx, 1);
	// the net name stays on the FIRST half only — one label per net, not one
	// per segment (healJunctions' merge restores it via a.name||b.name)
	sch.wires.push({
		id: uid("w"),
		from: w.from,
		to: { cid: j.id, pid: "j" },
		name: w.name, width: w.width
	});
	sch.wires.push({
		id: uid("w"),
		from: { cid: j.id, pid: "j" },
		to: w.to,
		name: "", width: w.width
	});
}
/* all wires belonging to the net driven by (cid,pid), following junctions */
function netWiresFrom(sch, cid, pid) {
	const res = [];
	const stack = [[cid, pid]];
	const seen = new Set();
	while (stack.length) {
		const [c0, p0] = stack.pop();
		const key = c0 + "." + p0;
		if (seen.has(key)) continue;
		seen.add(key);
		sch.wires.forEach(w => {
			if (w.from.cid === c0 && w.from.pid === p0) {
				res.push(w);
				const tc = comp(w.to.cid, sch);
				if (tc && tc.type === "JUNCTION") stack.push([tc.id, "j"]);
			}
		});
	}
	return res;
}
/* Slide a junction along its (collinear) host wires so a single branch leaves
   it PERPENDICULAR — i.e. straight out of the top/bottom of the square for a
   junction on a horizontal wire, or the side for a vertical one. Keeps the dot
   on the host line; only runs when the junction is a clean 2-host + branches
   point (never disturbs a deliberate corner). */
function alignJunctionBranch(sch) {
	sch = sch || activeSch();
	sch.components.filter(c => c.type === "JUNCTION").forEach(j => {
		if (state.pendingWire && state.pendingWire.cid === j.id) return;
		if (j.params && j.params.fixed) return;        // user parked this dot — hands off
		const jp = portPos(j, "j");
		const legs = sch.wires
			.filter(w => w.from.cid === j.id || w.to.cid === j.id)
			.map(w => {
				const isFrom = w.from.cid === j.id;
				const oc = comp(isFrom ? w.to.cid : w.from.cid, sch);
				const op = oc && portPos(oc, isFrom ? w.to.pid : w.from.pid);
				return op ? { op } : null;
			}).filter(Boolean);
		if (legs.length < 3) return;
		const host = {
			h: legs.filter(l => Math.abs(l.op.y - jp.y) < 0.5),
			v: legs.filter(l => Math.abs(l.op.x - jp.x) < 0.5)
		};
		// horizontal host (≥2 collinear on x-axis) with exactly one off-axis branch
		if (host.h.length >= 2 && legs.length - host.h.length === 1) {
			const branch = legs.find(l => Math.abs(l.op.y - jp.y) >= 0.5);
			const xs = host.h.map(l => l.op.x);
			// move ONLY when the branch column really falls inside the host span —
			// clamping an outside column would teleport the dot onto/past a sink pin
			// (zero-length wire + square-on-port blob)
			// the branch column is the IDEAL, but it is usually a SINK PIN's column — so
			// slide to the nearest slot on the host that still clears every symbol
			const lo = Math.min(...xs) + GRID, hi = Math.max(...xs) - GRID;
			const nx = snap(branch.op.x);
			if (!Number.isFinite(nx) || nx < lo || nx > hi) return;
			const at = tapClearOfBodies({ seg: "h", d: 0, x: nx, y: jp.y, lo, hi }, sch);
			if (at) j.x = at.x - 6;
		} else if (host.v.length >= 2 && legs.length - host.v.length === 1) {
			const branch = legs.find(l => Math.abs(l.op.x - jp.x) >= 0.5);
			const ys = host.v.map(l => l.op.y);
			const lo = Math.min(...ys) + GRID, hi = Math.max(...ys) - GRID;
			const ny = snap(branch.op.y);
			if (!Number.isFinite(ny) || ny < lo || ny > hi) return;
			const at = tapClearOfBodies({ seg: "v", d: 0, x: jp.x, y: ny, lo, hi }, sch);
			if (at) j.y = at.y - 6;
		}
	});
}
/* The first routed segment LEAVING junction j along wire w: which way it exits
   (up/down/left/right) and where it first turns. Used to detect fan-out wires
   that leave the square in the SAME direction and overlap. */
function firstSegFromJunction(j, w, sch) {
	const a = comp(w.from.cid, sch), b = comp(w.to.cid, sch);
	if (!a || !b) return null;
	const p1 = portPos(a, w.from.pid), p2 = portPos(b, w.to.pid);
	if (!p1 || !p2) return null;
	const jp = portPos(j, "j");
	const parts = routeParts(wireRoute(w, p1, p2, wireOpts(w, sch)));
	for (const part of parts) {
		if (part.t === "v" && Math.abs(part.x - jp.x) < 1) {
			if (Math.abs(part.y1 - jp.y) < 1) { return { dir: part.y2 < jp.y ? "up" : "down", axis: "y", turn: part.y2 }; }
			if (Math.abs(part.y2 - jp.y) < 1) { return { dir: part.y1 < jp.y ? "up" : "down", axis: "y", turn: part.y1 }; }
		} else if (part.t === "h" && Math.abs(part.y - jp.y) < 1) {
			if (Math.abs(part.x1 - jp.x) < 1) { return { dir: part.x2 < jp.x ? "left" : "right", axis: "x", turn: part.x2 }; }
			if (Math.abs(part.x2 - jp.x) < 1) { return { dir: part.x1 < jp.x ? "left" : "right", axis: "x", turn: part.x1 }; }
		}
	}
	return null;
}
/* Keep a fan-out junction's square at the point where its wires actually DIVERGE.
   With no collinear host the router sends every branch out the SAME side (e.g.
   straight up), so 2+ wires overlap along a shared segment and the visible split
   happens far from the square. Slide the junction to the nearest turn of an
   overlapping group until no two wires leave it the same way. */
function reflowJunctions(sch) {
	sch = sch || activeSch();
	let guard = 0, moved = true;
	while (moved && guard++ < 40) {
		moved = false;
		for (const j of sch.components.filter(c => c.type === "JUNCTION")) {
			if (state.pendingWire && state.pendingWire.cid === j.id) continue;
			if (j.params && j.params.fixed) continue;       // user parked this dot — hands off
			const wires = sch.wires.filter(w => w.from.cid === j.id || w.to.cid === j.id);
			if (wires.length < 3) continue;                 // only genuine fan-out points
			const jp = portPos(j, "j");
			const segs = wires.map(w => firstSegFromJunction(j, w, sch)).filter(Boolean);
			const byDir = {};
			segs.forEach(s => { (byDir[s.dir] = byDir[s.dir] || []).push(s); });
			// a dot sitting ON a straight host line must stay ON it: pulling it off the
			// line kinks BOTH host wires at the square (the "broken wire" fat-blob)
			const ends = wires.map(w => {
				const oc = comp(w.from.cid === j.id ? w.to.cid : w.from.cid, sch);
				return oc && portPos(oc, w.from.cid === j.id ? w.to.pid : w.from.pid);
			}).filter(Boolean);
			const hostH = ends.filter(op => Math.abs(op.y - jp.y) < 0.5).length;
			const hostV = ends.filter(op => Math.abs(op.x - jp.x) < 0.5).length;
			let best = null;
			Object.keys(byDir).forEach(dir => {
				const g = byDir[dir];
				if (g.length < 2) return;                     // no overlap on this side
				if (g[0].axis === "y" && hostH >= 2) return;      // would leave a horizontal host line
				if (g[0].axis === "x" && hostV >= 2) return;      // would leave a vertical host line
				const cur = g[0].axis === "y" ? jp.y : jp.x;
				// nearest turn = where the first of the overlapping wires diverges
				let near = g[0].turn;
				g.forEach(s => { if (Math.abs(s.turn - cur) < Math.abs(near - cur)) near = s.turn; });
				// landing on an attached pin (zero-length wire) or on another dot (double
				// square) trades one artifact for a worse one — skip such turns
				const nx = g[0].axis === "x" ? snap(near) : jp.x;
				const ny = g[0].axis === "y" ? snap(near) : jp.y;
				if (ends.some(op => Math.hypot(op.x - nx, op.y - ny) < GRID)) return;
				if (sch.components.some(k => k !== j && k.type === "JUNCTION" && Math.hypot((k.x + 6) - nx, (k.y + 6) - ny) < GRID)) return;
				// …and landing ON a symbol is the worst artifact of all: the dot becomes
				// unclickable behind the gate's own hit shapes. The pin guard above is not
				// enough — a turn can clear every pin and still sit on the body.
				if (bodyClearance({ x: nx, y: ny }, sch) < GRAB_CLEAR) return;
				const dist = Math.abs(near - cur);
				if (dist > 0.5 && (!best || dist < best.dist)) best = { axis: g[0].axis, val: near, dist };
			});
			if (best) {
				if (best.axis === "y") j.y = snap(best.val) - 6; else j.x = snap(best.val) - 6;
				moved = true;
			}
		}
	}
}

/* DIFFERENT nets must never share a drawn run ("สายคนละเส้นห้ามทับกัน") — wires of
   the SAME net legitimately share trunks (fan-out), but when a z-staircase leg or an
   s-route middle lands on another net's segment, nudge it to the nearest FREE grid
   column/row. Runs after wiring edits/moves; a persisted w.mx/w.my is updated so the
   choice sticks. */
function separateWireOverlaps(sch) {
	sch = sch || activeSch();
	const key = new Map();     // wire id → net identity (driver port)
	sch.wires.forEach(w => {
		const d = netDriverPort(sch, w);
		key.set(w.id, d ? d.cid + "." + d.pid : "w:" + w.id);
	});
	const calc = w => {
		const a = comp(w.from.cid, sch), b = comp(w.to.cid, sch);
		const p1 = a && portPos(a, w.from.pid), p2 = b && portPos(b, w.to.pid);
		if (!p1 || !p2) return null;
		const r = wireRoute(w, p1, p2, wireOpts(w, sch));
		return { w, r, parts: routeParts(r) };
	};
	const ov = (a1, a2, b1, b2) => Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));
	let guard = 0;
	while (guard++ < 4) {
		const all = sch.wires.map(calc).filter(Boolean);
		let moved = false;
		for (const A of all) {
			const others = all.filter(B => B.w !== A.w && key.get(B.w.id) !== key.get(A.w.id));
			// a JUNCTION BRANCH drop ("l" leaving a junction — a bent leg only, never a
			// straight "v" whose both ends are pinned): its vertical leg sits AT the
			// junction x — when two stacked fan-outs drop side-by-side into the same
			// column, slide the JUNCTION itself along its horizontal host to a free column.
			if (A.r.kind === "l") {
				const j = comp(A.w.from.cid, sch);
				if (!j || j.type !== "JUNCTION") continue;
				if (j.params && j.params.fixed) continue;     // user parked this dot — hands off
				const yLo = Math.min(A.r.y1, A.r.y2), yHi = Math.max(A.r.y1, A.r.y2);
				const busy = x => others.some(B => B.parts.some(s => s.t === "v" && Math.abs(s.x - x) < 0.5 && ov(s.y1, s.y2, yLo, yHi) > 2));
				const hBusyAt = (y, a, b) => others.some(B => B.parts.some(s => s.t === "h" && Math.abs(s.y - y) < 0.5 && ov(s.x1, s.x2, a, b) > 2));
				// (1) an L's horizontal TAIL rides the destination-pin row for its whole
				// length — when that row also carries ANOTHER net (pins sharing a row is
				// common), re-route this branch as a z: head rides its own trunk row and
				// only drops onto the pin row PAST the conflict. Prefer the latest drop.
				if (hBusyAt(A.r.y2, Math.min(A.r.x1, A.r.x2), Math.max(A.r.x1, A.r.x2))
					&& (A.r.x2 - A.r.x1) >= 2 * WIRE_MINLEG) {
					const lo = A.r.x1 + WIRE_MINLEG, hi = A.r.x2 - WIRE_MINLEG;
					let pick;
					for (let x = hi; x >= lo; x -= GRID) {
						const xx = snap(x); if (xx < lo || xx > hi) continue;
						if (busy(xx)) continue;
						if (hBusyAt(A.r.y1, Math.min(A.r.x1, xx), Math.max(A.r.x1, xx))) continue;
						if (hBusyAt(A.r.y2, Math.min(xx, A.r.x2), Math.max(xx, A.r.x2))) continue;
						pick = xx; break;
					}
					if (pick !== undefined) {
						A.w.zjog = 1; A.w.mx = pick; moved = true;
						const u = calc(A.w); if (u) { A.r = u.r; A.parts = u.parts; }
						continue;
					}
				}
				if (!busy(A.r.x1)) continue;
				// allowed span: stay strictly between the horizontal hosts' far endpoints;
				// any VERTICAL host pins the junction column — sliding would kink it
				const jp = portPos(j, "j");
				let lo = -Infinity, hi = Infinity, onHost = false, vHost = false;
				sch.wires.forEach(w2 => {
					if (w2 === A.w || (w2.from.cid !== j.id && w2.to.cid !== j.id)) return;
					const oc = comp(w2.from.cid === j.id ? w2.to.cid : w2.from.cid, sch);
					const op = oc && portPos(oc, w2.from.cid === j.id ? w2.to.pid : w2.from.pid);
					if (!op) return;
					if (Math.abs(op.x - jp.x) < 0.5 && Math.abs(op.y - jp.y) >= 0.5) { vHost = true; return; }
					if (Math.abs(op.y - jp.y) >= 0.5) return;             // horizontal hosts only
					onHost = true;
					if (op.x < jp.x) lo = Math.max(lo, op.x + GRID); else hi = Math.min(hi, op.x - GRID);
				});
				if (!onHost || vHost) continue;
				if (!isFinite(lo)) lo = jp.x - 8 * GRID;
				if (!isFinite(hi)) hi = jp.x + 8 * GRID;
				// the landing column must be clear of every other junction square and of any
				// component pin on this row — else we mint a double-square blob or a fake
				// connection dot on a foreign port
				const clearAt = xx => sch.components.every(k => {
					if (k === j) return true;
					if (k.type === "JUNCTION")
						return Math.abs((k.x + 6) - xx) >= 1.5 * GRID || Math.abs((k.y + 6) - jp.y) >= 1.5 * GRID;
					const td = typeDef(k); if (!td || !td.ports) return true;
					return td.ports(k.params || {}).every(p => {
						const pp = portPos(k, p.id);
						return !pp || Math.abs(pp.x - xx) >= GRID || Math.abs(pp.y - jp.y) >= GRID;
					});
				});
				let slid = false;
				for (let d = 1; d <= Math.ceil((hi - lo) / GRID); d++) {
					const cands = [snap(jp.x - d * GRID), snap(jp.x + d * GRID)].filter(xx => xx >= lo && xx <= hi && clearAt(xx));
					const free = cands.find(xx => !busy(xx));
					if (free !== undefined) { j.x = free - 6; moved = true; slid = true; break; }
				}
				// sibling wires attached to this junction now have STALE routes — restart
				// the sweep instead of sliding again off stale data (junction walk-off)
				if (slid) break;
				continue;
			}
			if (A.r.kind !== "z" && A.r.kind !== "s") continue;      // only these have a free leg
			if (A.r.kind === "z") {
				// moving the leg (mx) changes all three runs — a candidate is bad if the
				// vertical leg lands on another net's vertical, OR either horizontal run
				// (y1: x1..mx, y2: mx..x2) would still lie along another net's horizontal
				const yLo = Math.min(A.r.y1, A.r.y2), yHi = Math.max(A.r.y1, A.r.y2);
				const busy = x =>
					others.some(B => B.parts.some(s => s.t === "v" && Math.abs(s.x - x) < 0.5 && ov(s.y1, s.y2, yLo, yHi) > 2)) ||
					others.some(B => B.parts.some(s => s.t === "h" && Math.abs(s.y - A.r.y1) < 0.5 && ov(s.x1, s.x2, Math.min(A.r.x1, x), Math.max(A.r.x1, x)) > 2)) ||
					others.some(B => B.parts.some(s => s.t === "h" && Math.abs(s.y - A.r.y2) < 0.5 && ov(s.x1, s.x2, Math.min(x, A.r.x2), Math.max(x, A.r.x2)) > 2));
				if (!busy(A.r.mx)) continue;
				const lo = A.r.x1 + WIRE_MINLEG, hi = A.r.x2 - WIRE_MINLEG;
				for (let d = 1; d <= Math.ceil((hi - lo) / GRID); d++) {
					const cands = [snap(A.r.mx + d * GRID), snap(A.r.mx - d * GRID)].filter(x => x >= lo && x <= hi);
					const free = cands.find(x => !busy(x));
					if (free !== undefined) { A.w.mx = free; moved = true; break; }
				}
			} else {
				// s-route: middle horizontal at my — collides with another net's horizontal?
				const xLo = Math.min(A.r.x1, A.r.x2) + WIRE_MINLEG, xHi = Math.max(A.r.x1, A.r.x2) - WIRE_MINLEG;
				const busy = y => others.some(B => B.parts.some(s => s.t === "h" && Math.abs(s.y - y) < 0.5 && ov(s.x1, s.x2, xLo, xHi) > 2));
				if (!busy(A.r.my)) continue;
				for (let d = 1; d <= 8; d++) {
					const free = [snap(A.r.my + d * GRID), snap(A.r.my - d * GRID)].find(y => !busy(y));
					if (free !== undefined) { A.w.my = free; moved = true; break; }
				}
			}
			if (moved) { const u = calc(A.w); if (u) { A.r = u.r; A.parts = u.parts; } }
		}
		if (!moved) break;
	}
}
/* ISE fan-out rule: a branch leaves the net at the take-off point CLOSEST to its own
   sink, so the connection dot sits where the wires REALLY diverge. Without this, a
   sink wired early keeps its tap far up the trunk while a later branch runs the whole
   way down beside it — two long parallel same-net runs and a dot stranded "ข้างบน"
   instead of at the split. Re-tap any branch the net can serve materially closer. */
function retapBranches(sch) {
	sch = sch || activeSch();
	if (state.pendingWire) return;
	for (let pass = 0; pass < 3; pass++) {
		let moved = false;
		for (const w of [...sch.wires]) {
			if (!sch.wires.includes(w)) continue;
			const j = comp(w.from.cid, sch), sink = comp(w.to.cid, sch);
			if (!j || j.type !== "JUNCTION") continue;            // only a branch off a dot
			if (!sink || sink.type === "JUNCTION") continue;      // …that ends at a real pin
			if (j.params && j.params.fixed) continue;           // user parked this dot — hands off
			const sp = portPos(sink, w.to.pid), jp = portPos(j, "j");
			if (!sp || !jp) continue;
			const drv = netDriverPort(sch, w); if (!drv) continue;
			const others = netWiresFrom(sch, drv.cid, drv.pid).filter(x => x !== w);
			let best = null;
			for (const cand of others) {
				// clear of every symbol, else the dot lands on the pin and can't be grabbed
				const at = nearestClearOnWire(cand, sp, sch);
				if (at && (!best || at.d < best.at.d)) best = { w: cand, at };
			}
			if (!best) continue;
			// only move for a real gain, so this can never fight itself into a loop
			if (Math.hypot(jp.x - sp.x, jp.y - sp.y) - best.at.d < 3 * GRID) continue;
			// reuse a dot already sitting there, else split that wire to make one
			let nj = sch.components.find(c => {
				if (c.type !== "JUNCTION" || c === j) return false;
				if (!others.some(x => x.from.cid === c.id || x.to.cid === c.id)) return false;
				const cp = portPos(c, "j");
				return Math.hypot(cp.x - best.at.x, cp.y - best.at.y) <= 1.5 * GRID;
			});
			if (!nj) {
				nj = { id: uid("c"), type: "JUNCTION", x: best.at.x - 6, y: best.at.y - 6, params: {} };
				sch.components.push(nj);
				splitWireThroughJunction(best.w, nj, sch);
			}
			w.from = { cid: nj.id, pid: "j" };                 // the old dot heals away
			moved = true;
		}
		if (!moved) break;
	}
	healJunctions(sch);
}
/* the ONE canonical layout pass, always in this order: put each branch's dot at the
   real divergence, align fan-out dots, reflow overlapping exits, separate
   different-net runs, then HEAL LAST so any adjacency the movers created (coincident
   dots, zero-length stubs) is merged before render — never leave a healer artifact on
   screen waiting for the "next edit". */
function healLayout(sch) {
	sch = sch || activeSch();
	retapBranches(sch);
	alignJunctionBranch(sch);
	reflowJunctions(sch);
	separateWireOverlaps(sch);
	healJunctions(sch);
}

/* ISE behaviour: a port drives ONE wire; further connections branch off the
   existing net through a junction, so every connection point shows a dot
   (and is itself connectable). Returns true if it branched. */
function branchFromNet(sch, fromPort, toPort) {
	const fc = comp(fromPort.cid, sch);
	if (!fc || fc.type === "JUNCTION") return false;         // junction fanout is already a dot
	const candidates = netWiresFrom(sch, fromPort.cid, fromPort.pid);
	if (!candidates.length) return false;                  // first wire from this port
	const sink = comp(toPort.cid, sch);
	const sinkPos = sink && portPos(sink, toPort.pid);
	if (!sinkPos) return false;
	// The dot is BORN here, and no later pass rescues it: retapBranches only moves a
	// branch that gains 3*GRID, and a dot minted at the nearest point is already ~GRID
	// from its sink — so if we seat it on the symbol here, it stays on the symbol and
	// can never be grabbed. Pick the closest take-off that still clears every body.
	let best = null, raw = null;
	for (const w of candidates) {
		const at0 = nearestOnWire(w, sinkPos, GRID, sch);
		if (at0 && (!raw || at0.d < raw.at.d)) raw = { w, at: at0 };
		const at = nearestClearOnWire(w, sinkPos, sch);
		if (at && (!best || at.d < best.at.d)) best = { w, at };
	}
	if (!best) best = raw;         // nowhere clear on this net — a tight dot beats no connection
	if (!best) return false;                               // net too short to tap
	// ISE puts ONE dot per branch point — if the tap lands within a grid of an
	// existing junction on this net, REUSE it instead of dropping a 2nd square
	// beside it (the "two adjacent squares" defect).
	const near = sch.components.find(c => {
		if (c.type !== "JUNCTION") return false;
		if (!candidates.some(w => w.from.cid === c.id || w.to.cid === c.id)) return false;   // must be on this net
		const cp = portPos(c, "j");
		return Math.hypot(cp.x - best.at.x, cp.y - best.at.y) <= 1.5 * GRID;
	});
	if (near) {
		sch.wires.push({ id: uid("w"), from: { cid: near.id, pid: "j" }, to: { cid: toPort.cid, pid: toPort.pid }, name: "" });
		return true;
	}
	const j = { id: uid("c"), type: "JUNCTION", x: best.at.x - 6, y: best.at.y - 6, params: {} };
	sch.components.push(j);
	splitWireThroughJunction(best.w, j, sch);
	sch.wires.push({ id: uid("w"), from: { cid: j.id, pid: "j" }, to: { cid: toPort.cid, pid: toPort.pid }, name: "" });
	return true;
}
/* the ultimate driving port of the net that wire w belongs to (traces w.from
   back through junctions to a real output port) */
function netDriverPort(sch, w, seen) {
	seen = seen || new Set();
	const src = comp(w.from.cid, sch);
	if (!src) return null;
	if (src.type !== "JUNCTION") return { cid: w.from.cid, pid: w.from.pid };
	if (seen.has(src.id)) return null;
	seen.add(src.id);
	const up = sch.wires.find(x => x.to.cid === src.id);
	return up ? netDriverPort(sch, up, seen) : { cid: src.id, pid: "j" };
}
/* start a branch FROM a wire without committing a junction yet — the junction
   is placed optimally (nearest the chosen target) once the target is clicked,
   so tapping anywhere on a net still yields clean, detour-free routing */
function startWireBranch(w, point) {
	const at = nearestOnWire(w, point);
	state.pendingWire = {
		onWire: w.id,
		anchor: at ? { x: at.x, y: at.y } : { x: snap(point.x), y: snap(point.y) }, isOut: true
	};
	render();
}
/* rewrite parallel same-port fanout wires (old files, seeds) into junction
   branches so connection dots appear everywhere wires join */
function normalizePortFanout(sch) {
	const failed = new Set();
	for (let guard = 0; guard < 200; guard++) {
		const groups = new Map();
		sch.wires.forEach(w => {
			const src = comp(w.from.cid, sch);
			if (!src || src.type === "JUNCTION") return;
			const k = w.from.cid + "." + w.from.pid;
			if (!groups.has(k)) groups.set(k, []);
			groups.get(k).push(w);
		});
		let extra = null;
		for (const [k, ws] of groups) {
			if (ws.length > 1 && !failed.has(k)) { extra = { k, w: ws[1] }; break; }
		}
		if (!extra) break;
		sch.wires = sch.wires.filter(w => w !== extra.w);
		if (!branchFromNet(sch, extra.w.from, extra.w.to)) {
			sch.wires.push(extra.w);            // couldn't branch — keep as-is
			failed.add(extra.k);
		}
	}
}
function tapWire(w, point) {
	// no wire being drawn yet → START a branch from this wire (junction deferred
	// until the target is chosen, so it lands at the optimal spot). Also used to
	// re-pick the source wire while a branch is pending.
	if (!state.pendingWire || state.pendingWire.onWire) {
		startWireBranch(w, point);
		return;
	}
	// completing a wire being drawn from a port/junction ONTO this wire →
	// block outputs (would make two drivers on one net)
	const pc = comp(state.pendingWire.cid);
	if (pc) {
		const pp = getPort(pc, state.pendingWire.pid);
		const drives = pc.type === "JUNCTION"
			? activeSch().wires.some(x => x.to.cid === pc.id)
			: (pp && pp.dir === "out");
		if (drives) {
			toast("แตะ (tap) สายด้วย output ไม่ได้ — จะทำให้มี driver ชนกันบน net เดียว", "warn");
			return;
		}
	}
	const { j } = createJunctionOnWire(w, point);
	splitWireThroughJunction(w, j);
	onPortClick(j, { id: "j", dir: "out" });   // complete the pending wire to the new junction
}

/* =========================================================================
   CANVAS RENDER
   ========================================================================= */
/* The dot grid is a CSS layer on .canvas-host, so it must be driven by the view:
   scale the tile with the zoom and offset it by the pan, and step the spacing up or
   down by powers of two so the dots stay a readable density instead of turning into
   noise when zoomed out (or disappearing when zoomed in). Dots then always sit on
   real grid points under the schematic at ANY zoom. */
