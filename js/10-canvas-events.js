"use strict";

function startDrag(ev, c) {
	if (ev.button !== 0) return;          // only respond to left mouse button
	ev.stopPropagation();
	if (state.spaceDown) { startPan(ev); return; }   // Space+drag pans from anywhere
	if (state.tool !== "select") {
		// drawing tools don't move parts; a junction still acts as a wire source
		if (state.tool === "wire" && c.type === "JUNCTION") onPortClick(c, { id: "j", dir: "out" });
		return;
	}
	let prevMulti = null;
	if (ev.shiftKey) {
		if (state.selection.has(c.id)) {
			// shift+click on selected → toggle off, no drag
			state.selection.delete(c.id);
			render(); renderInspector();
			return;
		}
		// shift+click on unselected → add
		state.selection.add(c.id);
	} else {
		// remember if c was part of a multi-selection so we can restore on actual drag
		if (state.selection.has(c.id) && state.selection.size > 1) {
			prevMulti = new Set(state.selection);
		}
		// optimistic: visually single-select right now
		state.selection.clear();
		state.selection.add(c.id);
	}
	const m = svgPoint(ev);
	const items = Array.from(state.selection)
		.map(id => comp(id))
		.filter(Boolean)
		.map(cc => ({ c: cc, ox: m.x - cc.x, oy: m.y - cc.y }));
	state.drag = { items, anchor: c.id, sx: m.x, sy: m.y, moved: false, shift: ev.shiftKey, prevMulti };
	render(); renderInspector();
}
canvas.addEventListener("mousemove", ev => {
	state.mouse = svgPoint(ev);
	updateMouseStat();
	if (state.drag) {
		const dx = state.mouse.x - state.drag.sx, dy = state.mouse.y - state.drag.sy;
		// 6-pixel threshold avoids accidental drags from tiny hand jitter
		if (!state.drag.moved && Math.abs(dx) + Math.abs(dy) > 6) {
			state.drag.moved = true;
			// user clearly wants to drag → if anchor was originally part of a multi-
			// selection, restore that selection so the whole group moves together
			if (state.drag.prevMulti) {
				state.selection = new Set(state.drag.prevMulti);
				state.drag.items = Array.from(state.selection)
					.map(id => comp(id)).filter(Boolean)
					.map(cc => ({ c: cc, ox: state.mouse.x - cc.x, oy: state.mouse.y - cc.y }));
			}
		}
		if (state.drag.moved) {
			state.drag.items.forEach(d => {
				// snap what the user SEES. A junction's dot is drawn at its box + 6, and 6
				// is not a multiple of GRID(11) — snapping the box lands the dot at 11k+6,
				// half a grid off every line, which is exactly what kinks its wires. Every
				// creation site already does `<on-grid point> - 6`; match them.
				const q = d.c.type === "JUNCTION" ? 6 : 0;
				d.c.x = snap(state.mouse.x - d.ox + q) - q;
				d.c.y = snap(state.mouse.y - d.oy + q) - q;
			});
			render();
		}
	} else if (state.cornerDrag) {
		const cd = state.cornerDrag;
		cd.w.pts[cd.index] = { x: snap(state.mouse.x), y: snap(state.mouse.y) };
		cd.moved = true;
		render();
	} else if (state.wireDrag) {
		const wd = state.wireDrag;
		if (!wd.moved && Math.abs(state.mouse.x - wd.m0.x) + Math.abs(state.mouse.y - wd.m0.y) > 4) wd.moved = true;
		if (wd.moved) {
			if (wd.kind === "z") { wd.w.mx = snap(state.mouse.x); render(); }
			else if (wd.kind === "s") { wd.w.my = snap(state.mouse.y); render(); }
			else if (wd.kind === "h" || wd.kind === "v" || wd.kind === "l" || wd.kind === "lh") {
				// these shapes have no free/adjustable leg of their own — the FIRST drag
				// plants a manual waypoint at the drag point, switching the wire onto the
				// same user-routed (poly) path used by hand-drawn multi-corner wires. From
				// then on it's a normal draggable corner (see cornerDrag / w.pts above).
				if (!wd.w.pts) wd.w.pts = [{ x: 0, y: 0 }];
				wd.w.pts[0] = { x: snap(state.mouse.x), y: snap(state.mouse.y) };
				render();
			}
		}
	} else if (state.pendingWire) {
		render();
	} else if (state.pan) {
		state.view.x = ev.clientX - state.pan.x;
		state.view.y = ev.clientY - state.pan.y;
		state.pan.moved = true;
		render();
	} else if (state.marquee) {
		state.marquee.ex = state.mouse.x;
		state.marquee.ey = state.mouse.y;
		const dx = state.marquee.ex - state.marquee.sx, dy = state.marquee.ey - state.marquee.sy;
		if (!state.marquee.moved && Math.abs(dx) + Math.abs(dy) > 3) state.marquee.moved = true;
		render();
	}
});
window.addEventListener("mouseup", ev => {
	if (state.cornerDrag) {
		if (state.cornerDrag.moved) snapshot();
		state.cornerDrag = null;
		render();
		return;
	}
	if (state.drag) {
		// junction: a click without movement acts as a port click (start/finish a
		// wire) — but ONLY in the wire tool or when completing a pending wire.
		// In select mode a click on a junction (e.g. a bus label) just selects it,
		// so inspecting a bus never arms a phantom wire.
		if (!state.drag.moved && !state.drag.shift) {
			const anchor = comp(state.drag.anchor);
			if (anchor && anchor.type === "JUNCTION") {
				state.drag = null;
				if (state.tool === "wire" || state.pendingWire) {
					onPortClick(anchor, { id: "j", dir: "out" });
				} else {
					state.selection = new Set([anchor.id]);
					if (anchor.params && anchor.params.busName) setRightTab("inspector");
					render(); renderInspector();
				}
				return;
			}
		}
		if (state.drag.moved) {
			// a dangling end dragged onto a wire welds into a real junction (and its
			// square then tracks the connection); also cleans up any freed junctions
			const movedComps = state.drag.items.map(d => d.c);
			const draggedJunction = state.drag.items.some(d => d.c.type === "JUNCTION");
			const anchor = comp(state.drag.anchor);
			state.drag = null;
			// A dot the user dragged by hand is THEIRS: pin it, or the auto re-tap below
			// recomputes the "nearest take-off" and drags it straight back — which reads
			// as the dot being unmovable. Delete the dot to hand the net back to auto.
			// ONLY the grabbed dot: junctions swept along in a block/marquee drag were
			// never aimed at, and freezing those would silently kill auto-layout there.
			if (anchor && anchor.type === "JUNCTION") (anchor.params || (anchor.params = {})).fixed = true;
			if (draggedJunction) { weldTouchingEnds(); healJunctions(); }
			// a Bus Tap / Bus Ripper dragged onto a bus snaps on (or off, when dragged
			// clear) — so you can position it and let it grab the bus, no manual wire
			movedComps.forEach(c => { if (busInPin(c)) syncBusAttachment(c); });
			// moving a component/junction reroutes wires — re-slide branch junctions so
			// the connection square stays exactly where the wires diverge (not left
			// behind, and not stranded below a long shared stub of overlapping branches)
			healLayout();
			snapshot();
		} else {
			state.drag = null;
		}
		render();   // redraw with crossing hops now that the drag ended
	}
	if (state.wireDrag) {
		const wd = state.wireDrag;
		state.wireDrag = null;
		if (wd.moved) {
			if (wd.kind === "z" || wd.kind === "s" || wd.kind === "h" || wd.kind === "v" || wd.kind === "l" || wd.kind === "lh") snapshot();   // these all actually reroute now
		} else {
			// plain click on a wire → select it (shift toggles)
			if (!wd.shift) { state.selection.clear(); state.selection.add(wd.w.id); }
			else if (state.selection.has(wd.w.id)) state.selection.delete(wd.w.id);
			else state.selection.add(wd.w.id);
			renderInspector();
		}
		render();
	}
	if (state.pan) { state.pan = null; canvas.style.cursor = state.spaceDown ? "grab" : (TOOL_INFO[state.tool]?.cur || ""); render(); }
	if (state.marquee) {
		if (state.marquee.moved) {
			const sch = activeSch();
			const x1 = Math.min(state.marquee.sx, state.marquee.ex);
			const x2 = Math.max(state.marquee.sx, state.marquee.ex);
			const y1 = Math.min(state.marquee.sy, state.marquee.ey);
			const y2 = Math.max(state.marquee.sy, state.marquee.ey);
			// a component (incl. junctions) is selected if its bounding box intersects
			sch.components.forEach(c => {
				const sz = getSize(c);
				if (c.x + sz.w >= x1 && c.x <= x2 && c.y + sz.h >= y1 && c.y <= y2) {
					state.selection.add(c.id);
				}
			});
			// a wire is selected if ANY part of its routed path touches the rectangle
			// (not only when both endpoints are enclosed) — so a drag-box grabs every
			// wire it crosses, letting you select everything in an area at once
			const segHitsRect = part => {
				if (part.t === "h") {
					const xa = Math.min(part.x1, part.x2), xb = Math.max(part.x1, part.x2);
					return part.y >= y1 && part.y <= y2 && xb >= x1 && xa <= x2;
				}
				const ya = Math.min(part.y1, part.y2), yb = Math.max(part.y1, part.y2);
				return part.x >= x1 && part.x <= x2 && yb >= y1 && ya <= y2;
			};
			sch.wires.forEach(w => {
				const a = comp(w.from.cid, sch), b = comp(w.to.cid, sch);
				if (!a || !b) return;
				const p1 = portPos(a, w.from.pid), p2 = portPos(b, w.to.pid);
				if (!p1 || !p2) return;
				const parts = routeParts(wireRoute(w, p1, p2, wireOpts(w, sch)));
				if (parts.some(segHitsRect)) state.selection.add(w.id);
			});
			if (state.selection.size) toast(`Selected ${state.selection.size} item${state.selection.size > 1 ? "s" : ""}`, "info", 1200);
		}
		state.marquee = null;
		render(); renderInspector();
	}
});
function startPan(ev) {
	state.pan = {
		x: ev.clientX - state.view.x,
		y: ev.clientY - state.view.y,
		sx: ev.clientX, sy: ev.clientY,
		moved: false
	};
	canvas.style.cursor = "grabbing";
}
canvas.addEventListener("mousedown", ev => {
	// release focus from any input so keyboard shortcuts (Ctrl+C/V, Del, etc.) work
	if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
		document.activeElement.blur();
	}
	if (ev.target === canvas) {
		if (ev.button === 2) return;                  // ignore right-click
		if (ev.ctrlKey || ev.button === 1 || state.spaceDown) {
			// Ctrl+drag, middle-button, or Space+drag = pan
			startPan(ev);
		} else if (state.pendingWire && state.pendingWire.pts) {
			// drawing a wire → clicking empty canvas drops an orthogonal corner
			addWireCorner();
		} else if (state.pendingWire) {
			// a deferred branch (onWire) → empty click cancels it
			state.pendingWire = null; render();
		} else if (state.tool === "bus") {
			// a bus can NOT be started from empty space — it must be dragged out from a
			// component's port (a >1-bit pin). Guide the user to a port.
			toast("สร้างบัสจากพอร์ตของ component เท่านั้น — ลากออกจากขา >1 bit (สร้างบัสลอยจากพื้นที่ว่างไม่ได้)", "warn", 3600);
		} else if (state.tool === "select") {
			// plain left-drag = marquee (rectangle) selection
			const m = svgPoint(ev);
			state.marquee = { sx: m.x, sy: m.y, ex: m.x, ey: m.y, shift: ev.shiftKey, moved: false };
			if (!ev.shiftKey) { state.selection.clear(); healJunctions(); }
			render(); renderInspector();
		}
	}
});
// right-click on empty canvas while drawing = finish the wire in space
// (ISE-style "Done"); otherwise nothing (buses start from a port, not empty space)
canvas.addEventListener("contextmenu", ev => {
	if (ev.target !== canvas) return;
	ev.preventDefault();
	if (state.pendingWire) {
		if (state.pendingWire.pts) finishWireInSpace();
		else { state.pendingWire = null; healJunctions(); render(); }
	}
});
// double-click empty canvas while drawing → finish the wire in open space
canvas.addEventListener("dblclick", ev => {
	if (ev.target === canvas && state.pendingWire && state.pendingWire.pts) {
		ev.preventDefault();
		finishWireInSpace();
	}
});
canvas.addEventListener("wheel", ev => {
	ev.preventDefault();
	if (ev.ctrlKey || ev.metaKey) {
		// Ctrl+wheel (and trackpad pinch, which arrives as ctrl+wheel) = zoom at cursor
		const k0 = state.view.k;
		const k1 = clamp(k0 * (ev.deltaY < 0 ? 1.12 : 1 / 1.12), 0.3, 3);
		const r = canvas.getBoundingClientRect();
		const mx = ev.clientX - r.left, my = ev.clientY - r.top;
		state.view.x = mx - (mx - state.view.x) * (k1 / k0);
		state.view.y = my - (my - state.view.y) * (k1 / k0);
		state.view.k = k1;
	} else {
		// plain wheel / two-finger trackpad scroll = pan the view
		const unit = ev.deltaMode === 1 ? 16 : 1;   // Firefox line-mode
		let dx = ev.deltaX * unit, dy = ev.deltaY * unit;
		if (ev.shiftKey && !dx) { dx = dy; dy = 0; }   // shift+wheel = horizontal
		state.view.x -= dx;
		state.view.y -= dy;
	}
	render();
}, { passive: false });

/* keyboard */
window.addEventListener("keydown", ev => {
	if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
	// use ev.code (keyboard-layout independent) AND ev.key (for fallback) so Thai
	// and other non-Latin layouts still respond to Ctrl+C / Ctrl+V etc.
	const code = ev.code;
	const k = (ev.key || "").toLowerCase();
	const ctl = ev.ctrlKey || ev.metaKey;
	if (ev.key === "Enter" && state.pendingWire && state.pendingWire.pts) {
		finishWireInSpace();   // end the wire in open space (free bus stub)
		ev.preventDefault();
	} else if (ev.key === "Backspace" && state.pendingWire && state.pendingWire.pts && state.pendingWire.pts.length) {
		state.pendingWire.pts.pop();   // undo the last corner while drawing
		render(); ev.preventDefault();
	} else if (ev.key === "Delete" || ev.key === "Backspace") {
		if (state.selection.size) { deleteSelection(); ev.preventDefault(); }
	} else if (ev.key === "Escape") {
		if (state.pendingWire) {
			// 1st Esc: cancel only the wire being drawn — keep the tool & selection
			state.pendingWire = null; state.wireDrag = null;
			healJunctions(); render();
		} else {
			// 2nd Esc: clear selection and return to the select tool (ISE behaviour)
			state.wireDrag = null; state.selection.clear();
			healJunctions();
			setTool("select", true);
			renderInspector();
		}
	} else if (!ctl && (code === "KeyW" || k === "w")) { setTool("wire"); ev.preventDefault(); }
	/* BUS DISABLED (commented out): else if(!ctl && (code==="KeyB" || k==="b")){ setTool("bus"); ev.preventDefault(); } */
	else if (!ctl && (code === "KeyN" || k === "n")) { setTool("netname"); ev.preventDefault(); }
	else if (!ctl && (code === "KeyI" || k === "i")) { setTool("iomarker"); ev.preventDefault(); }
	else if (!ctl && (code === "KeyR" || k === "r")) { rotateSelection(ev.shiftKey ? -1 : 1); ev.preventDefault(); }
	else if (!ctl && (code === "KeyM" || k === "m")) { mirrorSelection(); ev.preventDefault(); }
	else if (ctl && (code === "KeyZ" || k === "z")) {
		if (ev.shiftKey) redo(); else undo(); ev.preventDefault();
	} else if (ctl && (code === "KeyY" || k === "y")) { redo(); ev.preventDefault(); }
	else if (ctl && (code === "KeyA" || k === "a")) {   // select EVERYTHING on the sheet
		const sch = activeSch();
		state.selection = new Set([...sch.components.map(c => c.id), ...sch.wires.map(w => w.id)]);
		render(); renderInspector(); ev.preventDefault();
	}
	else if (ctl && (code === "KeyD" || k === "d")) { duplicateSelection(); ev.preventDefault(); }
	else if (ctl && (code === "KeyC" || k === "c")) { copySelection(); ev.preventDefault(); }
	else if (ctl && (code === "KeyV" || k === "v")) { pasteClipboard(); ev.preventDefault(); }
	else if (ctl && (code === "KeyX" || k === "x")) { copySelection(); deleteSelection(); ev.preventDefault(); }
	else if (ctl && (code === "KeyS" || k === "s")) { saveProjectToFile(); ev.preventDefault(); }
	else if (ctl && (code === "KeyO" || k === "o")) { openProjectFromFile(); ev.preventDefault(); }
	else if (ctl && (code === "KeyN" || k === "n")) { newProject(); ev.preventDefault(); }
	else if (code === "Space") {
		// hold Space = grab-to-pan mode (like design tools)
		if (!state.spaceDown) { state.spaceDown = true; if (!state.pan) canvas.style.cursor = "grab"; }
		ev.preventDefault();
	}
	else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key)) {
		const dx = ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowRight" ? 1 : 0;
		const dy = ev.key === "ArrowUp" ? -1 : ev.key === "ArrowDown" ? 1 : 0;
		const selComps = Array.from(state.selection).map(id => comp(id)).filter(Boolean);
		if (selComps.length) {
			// nudge selected components one grid step (a junction snaps by its DOT, which
			// sits at box+6 — snapping the box would drift it half a grid off the lines)
			selComps.forEach(c => {
				const q = c.type === "JUNCTION" ? 6 : 0;
				c.x = snap(c.x + q + dx * GRID) - q;
				c.y = snap(c.y + q + dy * GRID) - q;
			});
			// same pact as the mouse drag: a dot the user placed is theirs, so healLayout
			// below must not re-tap it back (it would silently undo the nudge). Only when
			// dots are what's selected — nudging a mixed block isn't aiming at its dots.
			if (selComps.every(c => c.type === "JUNCTION"))
				selComps.forEach(c => { (c.params || (c.params = {})).fixed = true; });
			healLayout();   // keep branch squares at the divergence point (heal runs last)
			snapshot(); render();
		} else {
			// nothing selected → pan the view
			state.view.x -= dx * 60;
			state.view.y -= dy * 60;
			render();
		}
		ev.preventDefault();
	}
	else if (ev.key === "Home") { zoomFit(); ev.preventDefault(); }
	else if (ev.key === "F7") { runSynthesis(); ev.preventDefault(); }
});
window.addEventListener("keyup", ev => {
	if (ev.code === "Space") {
		state.spaceDown = false;
		if (!state.pan) canvas.style.cursor = TOOL_INFO[state.tool]?.cur || "";
	}
});
window.addEventListener("blur", () => { state.spaceDown = false; if (!state.pan) canvas.style.cursor = TOOL_INFO[state.tool]?.cur || ""; });

/* canvas drag-drop from palette */
canvas.addEventListener("dragover", ev => ev.preventDefault());
canvas.addEventListener("drop", ev => {
	ev.preventDefault();
	const t = state.dragType || (ev.dataTransfer && ev.dataTransfer.getData("text/plain"));
	if (t) {
		const m = svgPoint(ev);
		const id = addComp(t, m.x - 20, m.y - 15);
		const nc = id && comp(id);
		if (nc && busInPin(nc) && attachBusPinToWire(nc))
			toast("เกาะสายบัสให้อัตโนมัติแล้ว — ปรับ slice ได้ใน Inspector", "ok", 2600);
	}
	state.dragType = null;
});
// clear the pending palette type when a drag ends anywhere but the canvas,
// so a stale value never spawns a phantom component later
document.addEventListener("dragend", () => { state.dragType = null; });
