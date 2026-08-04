"use strict";

/* =========================================================================
   CANVAS RENDER
   ========================================================================= */
/* The dot grid is a CSS layer on .canvas-host, so it must be driven by the view:
   scale the tile with the zoom and offset it by the pan, and step the spacing up or
   down by powers of two so the dots stay a readable density instead of turning into
   noise when zoomed out (or disappearing when zoomed in). Dots then always sit on
   real grid points under the schematic at ANY zoom. */
function syncGridBg() {
	const host = document.querySelector(".canvas-host");
	if (!host) return;
	const k = state.view.k;
	let base = 2 * GRID;                                  // the lattice the dots mark
	while (base * k < 12) base *= 2;         // zoomed OUT → coarser lattice
	while (base * k > 48 && base > GRID) base /= 2;        // zoomed IN  → finer lattice
	const s = base * k;
	const mod = (v, m) => ((v % m) + m) % m;             // the dot sits 1px into its tile
	host.style.backgroundSize = `${s}px ${s}px, auto`;
	host.style.backgroundPosition = `${mod(state.view.x - 1, s)}px ${mod(state.view.y - 1, s)}px, 0 0`;
}
function render() {
	const sch = activeSch();
	while (canvas.firstChild) canvas.removeChild(canvas.firstChild);
	syncGridBg();
	if (!sch) return;

	const root = el("g", { transform: `translate(${state.view.x},${state.view.y}) scale(${state.view.k})` });
	canvas.appendChild(root);

	// wires — resolve routes in two passes so automatic routes dodge both
	// manually-adjusted segments and each other (no overlapping vertical runs)
	const wireEnds = w => {
		const a = comp(w.from.cid, sch); const b = comp(w.to.cid, sch);
		if (!a || !b) return null;
		const p1 = portPos(a, w.from.pid); const p2 = portPos(b, w.to.pid);
		return (p1 && p2) ? [p1, p2] : null;
	};
	const wireRoutes = new Map();
	const usedV = [];   // occupied vertical runs: {x, y1, y2}
	const addV = r => routeParts(r).forEach(part => {
		if (part.t === "v") usedV.push({ x: part.x, y1: Math.min(part.y1, part.y2), y2: Math.max(part.y1, part.y2) });
	});
	// pass 1: straight, waypoint, and manually-routed wires are fixed obstacles
	sch.wires.forEach(w => {
		const pp = wireEnds(w); if (!pp) return;
		const r = wireRoute(w, pp[0], pp[1], wireOpts(w));
		if (r.kind !== "z" || typeof w.mx === "number") { wireRoutes.set(w.id, r); addV(r); }
	});
	// pass 2: default staircases slide sideways to a free column
	sch.wires.forEach(w => {
		if (wireRoutes.has(w.id)) return;
		const pp = wireEnds(w); if (!pp) return;
		const r = wireRoute(w, pp[0], pp[1], wireOpts(w));
		if (AUTO_ARRANGE) {
			const lo = r.x1 + WIRE_MINLEG, hi = r.x2 - WIRE_MINLEG;
			const yA = Math.min(r.y1, r.y2), yB = Math.max(r.y1, r.y2);
			const collide = x => usedV.some(s => Math.abs(s.x - x) < 8 && yA < s.y2 && yB > s.y1);
			if (collide(r.mx)) {
				for (let k = 1; k <= 10; k++) {
					const cand = [r.mx + k * GRID, r.mx - k * GRID].filter(x => x >= lo && x <= hi && !collide(x));
					if (cand.length) { r.mx = cand[0]; r.d = `M${r.x1},${r.y1}H${r.mx}V${r.y2}H${r.x2}`; break; }
				}
			}
		}
		wireRoutes.set(w.id, r); addV(r);
	});
	// all vertical runs across every wire — used to place crossing hops
	// Crossing hops cost O(wires²) per frame. Skip them when the plain style is
	// selected, while the user is actively dragging/panning (redraws every
	// mousemove), and in very large schematics.
	const fastRender = HOP_STYLE !== "hop" || !!(state.drag || state.wireDrag || state.pan) || sch.wires.length > 160;
	const allV = [];
	if (!fastRender) wireRoutes.forEach((r, wid) => {
		routeParts(r).forEach(part => {
			if (part.t === "v") allV.push({ x: part.x, y1: part.y1, y2: part.y2, wid });
		});
	});
	// wire widths derived once per frame from the driving ports (never cached)
	const wWidth = new Map();
	sch.wires.forEach(w => wWidth.set(w.id, netWidth(w, sch)));
	const drawWire = w => {
		const r = wireRoutes.get(w.id); if (!r) return;
		const isBus = (wWidth.get(w.id) || 1) > 1;
		const isSel = state.selection.has(w.id);
		const g = el("g", { class: "wire-group" + (isSel ? " sel" : "") });
		// visible path carries hops over crossings so overlaps read clearly
		const D = fastRender ? r.d : hoppedPathD(r, allV, w.id);
		const path = el("path", {
			d: D,
			class: "wire" + (isBus ? " bus" : "") + (isSel ? " selected" : ""),
			stroke: isSel ? "var(--wire-sel)" : (isBus ? "var(--wire-bus)" : "var(--wire)")
		});
		g.appendChild(path);
		// wide invisible hit path (straight route): easy clicking + drag rerouting
		const hit = el("path", { d: r.d, class: "wire-hit" });
		hit.style.cursor = state.tool !== "select" ? "inherit"
			: r.kind === "z" ? "ew-resize"
				: r.kind === "s" ? "ns-resize"
					: r.kind === "h" ? "ns-resize"     // straight horizontal — drag vertically to bend it
						: r.kind === "v" ? "ew-resize"     // straight vertical — drag horizontally to bend it
							: (r.kind === "l" || r.kind === "lh") ? "move"   // single elbow — drag to reshape
								: "pointer";
		hit.addEventListener("mousedown", ev => {
			if (ev.button !== 0) return;
			ev.stopPropagation();
			if (state.spaceDown) { startPan(ev); return; }
			// ISE modal tools act on wires directly
			if (state.tool === "netname") { applyWireName(w, prompt("ตั้งชื่อสาย (บัสต้องลากจากพอร์ต >1 bit ของ component):", w.name || "")); return; }
			if (state.tool === "bus") {
				// Bus tool on a wire: bus → tap the next bit; a non-bus wire is NOT
				// converted — a bus must originate from a component port (drag from a
				// >1-bit pin), never be conjured onto a plain wire.
				if (netWidth(w) > 1) stampTapOnWire(w, svgPoint(ev));
				else toast("สายนี้ไม่ใช่บัส — สร้างบัสโดยลากจากพอร์ต >1 bit ของ component", "info", 3000);
				return;
			}
			if (state.tool === "iomarker") return;
			if (state.tool === "wire") { tapWire(w, svgPoint(ev)); return; }   // branch from / finish at this wire
			// tap-on-wire: if user is currently drawing a wire, clicking on an
			// existing wire creates a junction at that point and continues the route
			if (state.pendingWire) { tapWire(w, svgPoint(ev)); return; }
			// shift+alt+click → tap (start a new wire from this point on the wire)
			if (ev.shiftKey && ev.altKey) { tapWire(w, svgPoint(ev)); return; }
			// click = select (on mouseup); drag = move the adjustable segment
			state.wireDrag = { w, kind: r.kind, m0: svgPoint(ev), moved: false, shift: ev.shiftKey };
		});
		hit.addEventListener("dblclick", ev => {
			// rename only when not mid-gesture (drawing/branching)
			if (state.pendingWire) return;
			applyWireName(w, prompt("ตั้งชื่อสาย (บัสต้องลากจากพอร์ต >1 bit ของ component):", w.name || ""));
		});
		// right-click a wire = tap it (only if it is already a bus); a plain wire is
		// never turned into a bus — buses come from a component port only
		hit.addEventListener("contextmenu", ev => {
			ev.preventDefault(); ev.stopPropagation();
			if (state.pendingWire) return;                 // never mutate mid-draw
			if (netWidth(w) > 1) stampTapOnWire(w, svgPoint(ev));
		});
		g.appendChild(hit);
		// endpoint markers when selected → the exact path is unambiguous
		if (isSel) {
			[[r.x1, r.y1], [r.x2, r.y2]].forEach(([ex, ey]) => {
				g.appendChild(el("circle", { cx: ex, cy: ey, r: 3.5, fill: "var(--wire-sel)", stroke: "var(--bg-0)", "stroke-width": 1, "pointer-events": "none" }));
			});
			// draggable corner handles for a manually-routed (waypoint) wire
			if (w.pts) w.pts.forEach((pt, idx) => {
				const h = el("rect", {
					x: pt.x - 4, y: pt.y - 4, width: 8, height: 8, rx: 1,
					fill: "var(--bg-1)", stroke: "var(--wire-sel)", "stroke-width": 1.5
				});
				h.style.cursor = "move";
				h.addEventListener("mousedown", ev => {
					if (ev.button !== 0) return; ev.stopPropagation();
					state.cornerDrag = { w, index: idx };
				});
				g.appendChild(h);
			});
		}
		root.appendChild(g);

		if (w.name) {
			// label follows the actual route (sits on the adjustable segment);
			// bus wires show the range like OP3[7:0] (same notation as I/O markers)
			let labText = w.name;
			if (isBus) labText = `${w.name}(${(wWidth.get(w.id) || 1) - 1}:0)`;
			let lx, ly;
			if (r.kind === "poly") { const m = r.pts[Math.floor(r.pts.length / 2)]; lx = m.x; ly = m.y - 6; }
			else {
				lx = r.kind === "z" ? r.mx : r.kind === "l" ? r.x1 : (r.x1 + r.x2) / 2;
				ly = (r.kind === "s" ? r.my : r.kind === "h" ? r.y1 : (r.y1 + r.y2) / 2) - 6;
			}
			const bw = Math.max(44, labText.length * 6.5 + 10);   // fit the text
			const bg = el("rect", { x: lx - bw / 2, y: ly - 10, width: bw, height: 14, rx: 3, fill: "#0008", "pointer-events": "none" });
			root.appendChild(bg);
			const lbl = txt(lx, ly, labText, { anchor: "middle", fill: "var(--ink-dim)", size: 10 });
			lbl.setAttribute("class", "wire-label");
			root.appendChild(lbl);
		}
	};
	// draw unselected first, selected last so the highlighted wire sits on top
	sch.wires.forEach(w => { if (!state.selection.has(w.id)) drawWire(w); });
	sch.wires.forEach(w => { if (state.selection.has(w.id)) drawWire(w); });

	// wire being drawn — show committed corners plus the live orthogonal segment
	if (state.pendingWire) {
		const pw = state.pendingWire;
		let start = null;
		if (pw.onWire) {
			const bw = sch.wires.find(x => x.id === pw.onWire);
			const at = bw && nearestOnWire(bw, state.mouse, 0, sch);
			start = at ? { x: at.x, y: at.y } : pw.anchor;
		} else {
			const c = comp(pw.cid, sch);
			if (c) start = portPos(c, pw.pid);
		}
		if (start) {
			const chain = [start, ...(pw.pts || [])];
			const last = chain[chain.length - 1];
			const step = orthoStep(last, state.mouse);          // current H/V segment
			const pts = orthoPolyline([...chain, step, state.mouse], true, true);
			root.appendChild(el("path", {
				d: "M" + pts.map(p => `${p.x},${p.y}`).join("L"), fill: "none",
				stroke: "var(--accent-2)", "stroke-width": 2, "stroke-dasharray": "6 4",
				"pointer-events": "none"   // never swallow the click that places the next corner
			}));
			// committed corner dots
			(pw.pts || []).forEach(p => root.appendChild(el("circle", { cx: p.x, cy: p.y, r: 2.5, fill: "var(--accent-2)", "pointer-events": "none" })));
		}
	}

	// marquee (rectangle selection)
	if (state.marquee && state.marquee.moved) {
		const x = Math.min(state.marquee.sx, state.marquee.ex);
		const y = Math.min(state.marquee.sy, state.marquee.ey);
		const w = Math.abs(state.marquee.ex - state.marquee.sx);
		const h = Math.abs(state.marquee.ey - state.marquee.sy);
		root.appendChild(el("rect", {
			x, y, width: w, height: h,
			fill: "rgba(91,141,239,0.13)", stroke: "var(--accent)",
			"stroke-width": 1.2 / state.view.k, "stroke-dasharray": `${5 / state.view.k} ${4 / state.view.k}`
		}));
	}

	// components
	sch.components.forEach(c => {
		const td = typeDef(c); if (!td) return;
		const sz = td.size(c.params || {});
		const isSel = state.selection.has(c.id);
		const rot = ((c.rot || 0) % 360 + 360) % 360;
		let ntf = `translate(${c.x},${c.y})`;
		if (rot) ntf += ` rotate(${rot} ${sz.w / 2} ${sz.h / 2})`;
		if (c.mirror) ntf += ` translate(${sz.w} 0) scale(-1 1)`;
		const g = el("g", { class: "node" + (isSel ? " selected" : ""), transform: ntf });
		const body = el("g", { class: "body" });
		body.innerHTML = td.shape(c.params || {});
		// a junction joining bus wires takes the bus colour so it blends in
		// instead of standing out cyan
		if (c.type === "JUNCTION") {
			const jWires = sch.wires.filter(w => w.from.cid === c.id || w.to.cid === c.id);
			const busJ = jWires.some(w => (wWidth.get(w.id) || 1) > 1);
			const isBusDef = c.params && c.params.busName && c.params.busWidth;
			const dot = body.querySelector("rect,circle");
			// ISE bus RIPPER: where a bit taps a bus, ISE draws a short 45° "rip"
			// slash (not a perpendicular dot). Detect a junction feeding a BUS TAP and
			// draw the ripper, oriented from the bus toward the tap branch.
			const tapW = jWires.find(w => {
				const oc = comp(w.from.cid === c.id ? w.to.cid : w.from.cid, sch);
				return oc && oc.type === "BUSTAP";
			});
			if (tapW && dot) {
				dot.remove();
				// a short 45° "/" rip slash in bus colour, centred on the join
				body.appendChild(el("line", {
					x1: -2, y1: 14, x2: 14, y2: -2,
					stroke: "var(--wire-bus)", "stroke-width": 2.6, "stroke-linecap": "round"
				}));
			} else if (dot && (busJ || isBusDef)) dot.setAttribute("fill", "var(--wire-bus)");
			// a free wire end reads as a hollow marker — judged LIVE (exactly one
			// wire attached), so a later-connected end goes back to a solid join;
			// a bus-definition node always stays solid + gets its ISE-style label
			if (dot && c.params && c.params.endpoint && jWires.length === 1 && !isBusDef) {
				dot.setAttribute("fill", "var(--bg-0)");
				dot.setAttribute("stroke", busJ ? "var(--wire-bus)" : "var(--wire)");
				dot.setAttribute("stroke-width", "1.6");
			}
			if (isBusDef) {
				// label shows the REAL net width (from the source if driven)
				const jw = jWires[0];
				const eff = jw ? (wWidth.get(jw.id) || c.params.busWidth) : c.params.busWidth;
				const text = sanId(c.params.busName) + "(" + (eff - 1) + ":0)";
				// place the label on the clear side of the host wire: above a
				// horizontal run, beside a vertical one (never through the stroke)
				let horiz = true, sign = 1;
				if (jw) {
					const oc = comp(jw.from.cid === c.id ? jw.to.cid : jw.from.cid, sch);
					const op = oc && portPos(oc, jw.from.cid === c.id ? jw.to.pid : jw.from.pid);
					if (op) { const dx = op.x - (c.x + 6), dy = op.y - (c.y + 6); horiz = Math.abs(dx) >= Math.abs(dy); sign = (horiz ? dx : dy) >= 0 ? 1 : -1; }
				}
				const tw = text.length * 6.6 + 8;
				let lx, anchor, ly;
				if (horiz) { ly = -7; lx = sign > 0 ? 2 : 10; anchor = sign > 0 ? "start" : "end"; }
				else { ly = 4; lx = 14; anchor = "start"; }
				const bgx = anchor === "start" ? lx - 3 : lx - tw + 3;
				body.appendChild(el("rect", {
					x: bgx, y: ly - 11, width: tw, height: 14, rx: 3,
					fill: "#0008", "pointer-events": "none"
				}));
				const lbl = txt(lx, ly, text, { anchor, fill: "var(--wire-bus)", size: 11 });
				lbl.setAttribute("font-family", "monospace");
				body.appendChild(lbl);
			}
			// junctions have no port overlay → give the 9px square a real hit area,
			// but ONLY in tools that act on junctions (select: move/inspect, wire:
			// connect). In the bus/netname tools an enlarged rect would eclipse the
			// wire underneath and swallow tap/rename clicks near every junction.
			if (state.tool === "select" || state.tool === "wire") {
				body.appendChild(el("rect", { x: -3, y: -3, width: 18, height: 18, fill: "transparent" }));
			}
		}
		body.addEventListener("mousedown", ev => startDrag(ev, c));
		if (c.type === "IN" || c.type === "OUT") {
			body.addEventListener("dblclick", ev => openInspectorFor(c));
		} else {
			body.addEventListener("dblclick", ev => openInspectorFor(c));
		}
		body.addEventListener("contextmenu", ev => {
			ev.preventDefault();
			openInspectorFor(c);
		});
		g.appendChild(body);

		// ports — a JUNCTION keeps only its body dot: click = wire, drag = move
		// (handled in startDrag/mouseup), so no port overlay is added for it
		if (c.type !== "JUNCTION") td.ports(c.params || {}).forEach(p => {
			const isOut = p.dir === "out";
			const isPending = state.pendingWire && state.pendingWire.cid === c.id && state.pendingWire.pid === p.id;
			const pg = el("g", { class: "port" + (isPending ? " pending" : "") });
			// bus ports show the ISE-style rectangle marker; scalar ports a dot.
			// Both get a larger invisible hit circle for easy clicking.
			// EXCEPTION: a BUS TAP's d pin sits directly ON the bus junction — an
			// opaque marker there would punch a hole in the bus stroke and make the
			// tap look disconnected, so it gets no marker (the junction square + the
			// purple triangle already show the joint).
			if (c.type === "BUSTAP" && p.id === "d") {
				pg.appendChild(el("circle", { class: "hit", cx: p.dx, cy: p.dy, r: 9 }));
				pg.addEventListener("mousedown", ev => {
					if (ev.button !== 0) return;
					ev.stopPropagation();
					if (state.spaceDown) { startPan(ev); return; }
					if (state.tool === "netname") return;
					if (state.tool === "iomarker") { toast("ขานี้มีสายต่ออยู่แล้ว", "warn"); return; }
					if (state.tool === "bus") { toast("คลิกบนตัวสายบัส (เยื้องจากจุดต่อ) เพื่อวาง Bus Tap", "info", 2400); return; }
					onPortClick(c, p);
				});
				g.appendChild(pg);
				return;
			}
			if ((p.width || 1) > 1) {
				pg.appendChild(el("rect", {
					class: "port-dot", x: p.dx - 7, y: p.dy - 5, width: 14, height: 10, rx: 1,
					fill: "var(--bg-1)", stroke: "var(--wire-bus)", "stroke-width": 2
				}));
			} else {
				pg.appendChild(el("circle", {
					class: "port-dot", cx: p.dx, cy: p.dy, r: 3.5,
					fill: isOut ? "var(--in-stroke)" : "var(--accent)",
					stroke: "var(--bg-0)", "stroke-width": 1.2
				}));
			}
			pg.appendChild(el("circle", { class: "hit", cx: p.dx, cy: p.dy, r: 9 }));
			pg.addEventListener("mousedown", ev => {
				if (ev.button !== 0) return;
				ev.stopPropagation();
				if (state.spaceDown) { startPan(ev); return; }
				if (state.tool === "iomarker") { addIOMarkerAt(c, p); return; }
				if (state.tool === "netname") return;
				// Bus tool: drag a wire OUT from this component port — the ONLY way to
				// make a bus (a >1-bit port yields a bus wire; a 1-bit port a plain wire)
				if (state.tool === "bus") { onPortClick(c, p); if (state.pendingWire && (p.width || 1) > 1) toast("ลากสายบัสออกจากพอร์ต — คลิกวางมุม/พอร์ตปลายทาง", "info", 2600); return; }
				onPortClick(c, p);   // select & wire modes
			});
			g.appendChild(pg);
			if (p.label) {
				const lx = isOut ? p.dx - 8 : p.dx + 8;
				const an = isOut ? "end" : "start";
				g.appendChild(txt(lx, p.dy + 3, p.label, { anchor: an, size: 9, fill: "var(--ink-dim)" }));
			}
		});

		root.appendChild(g);
	});

	updateStatus();
}
/* dragging */
function svgPoint(ev) {
	const r = canvas.getBoundingClientRect();
	return {
		x: (ev.clientX - r.left - state.view.x) / state.view.k,
		y: (ev.clientY - r.top - state.view.y) / state.view.k
	};
}
function updateMouseStat() {
	$("#statMouse").textContent = `x:${Math.round(state.mouse.x)}, y:${Math.round(state.mouse.y)}  ·  zoom ${Math.round(state.view.k * 100)}%`;
}
/* =========================================================================
   ZOOM / VIEW
   ========================================================================= */
function zoomBy(f) {
	// zoom around the viewport centre so panned content stays in view
	const r = canvas.getBoundingClientRect();
	const cx = r.width / 2, cy = r.height / 2;
	const k0 = state.view.k;
	const k1 = clamp(k0 * f, 0.3, 3);
	state.view.x = cx - (cx - state.view.x) * (k1 / k0);
	state.view.y = cy - (cy - state.view.y) * (k1 / k0);
	state.view.k = k1;
	render();
}
function zoom100() { state.view = { x: 0, y: 0, k: 1 }; render(); }
function zoomFit() {
	const sch = activeSch(); if (!sch || !sch.components.length) { zoom100(); return; }
	let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
	sch.components.forEach(c => {
		const sz = getSize(c);
		minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
		maxX = Math.max(maxX, c.x + sz.w); maxY = Math.max(maxY, c.y + sz.h);
	});
	const r = canvas.getBoundingClientRect();
	const pad = 80;
	const kx = (r.width - pad * 2) / (maxX - minX);
	const ky = (r.height - pad * 2) / (maxY - minY);
	const k = clamp(Math.min(kx, ky), 0.3, 2);
	state.view.k = k;
	state.view.x = pad - minX * k + (r.width - pad * 2 - (maxX - minX) * k) / 2;
	state.view.y = pad - minY * k + (r.height - pad * 2 - (maxY - minY) * k) / 2;
	render();
}
function updateStatus() {
	updateMouseStat();   // keep the zoom % current after wheel/button zoom
	const sch = activeSch();
	if (!sch) { $("#statCounts").textContent = "no schematic"; return; }
	$("#statCounts").textContent = `${sch.components.length} components · ${sch.wires.length} wires · top: ${state.project.schematics[state.project.topId]?.name || "-"}`;
}
