"use strict";

/* Remove every placed instance of a type (e.g. "SCH:xxx" or "CUSTOM:name")
   from all schematics and stored customs, together with their wires. */
function removeInstancesOf(typeStr) {
	let n = 0;
	const scrub = sch => {
		if (!sch || !sch.components) return;
		const ids = new Set(sch.components.filter(c => c.type === typeStr).map(c => c.id));
		if (!ids.size) return;
		n += ids.size;
		sch.components = sch.components.filter(c => !ids.has(c.id));
		sch.wires = (sch.wires || []).filter(w => !ids.has(w.from.cid) && !ids.has(w.to.cid));
	};
	Object.values(state.project.schematics).forEach(scrub);
	Object.values(state.project.customs).forEach(cc => scrub(cc.schematic));
	return n;
}
/* Rewrite a component type everywhere (used when renaming a custom component) */
function rewriteInstanceType(from, to) {
	const walk = sch => sch && (sch.components || []).forEach(c => { if (c.type === from) c.type = to; });
	Object.values(state.project.schematics).forEach(walk);
	Object.values(state.project.customs).forEach(cc => walk(cc.schematic));
}
/* Auto-weld: a dangling wire end (free-endpoint junction, 1 wire) that lands
   exactly on top of another wire — or on another dangling end — is what the
   user means to CONNECT. Turn it into a real solid junction (split the host
   wire through it, or merge the two ends), so every point where wires actually
   meet shows a connection square and is electrically joined. Only fires on an
   exact overlap (<2px), so deliberately-parked stubs are never grabbed. */
function weldTouchingEnds(sch) {
	sch = sch || activeSch();
	const jWiresOf = j => sch.wires.filter(w => w.from.cid === j.id || w.to.cid === j.id);
	// flood j's OWN net through junctions → the wires/nodes we must never weld to
	// (welding onto our own net would make a self-loop that heal collapses to a
	//  corrupt from===to wire)
	const ownNet = j => {
		const wires = new Set(), nodes = new Set([j.id]), stack = [j.id];
		while (stack.length) {
			const jid = stack.pop();
			sch.wires.forEach(w => {
				if (w.from.cid !== jid && w.to.cid !== jid) return;
				wires.add(w.id);
				const other = w.from.cid === jid ? w.to : w.from;
				const oc = comp(other.cid, sch);
				if (oc && oc.type === "JUNCTION" && !nodes.has(oc.id)) { nodes.add(oc.id); stack.push(oc.id); }
			});
		}
		return { wires, nodes };
	};
	let welded = false, again = true, guard = 0;
	while (again && guard++ < 60) {
		again = false;
		const ends = sch.components.filter(c => c.type === "JUNCTION"
			&& c.params && c.params.endpoint && !c.params.busName   // plain free ends only
			&& jWiresOf(c).length === 1);
		for (const j of ends) {
			if (state.pendingWire && state.pendingWire.cid === j.id) continue;  // not the wire being drawn
			const jp = portPos(j, "j");
			const net = ownNet(j);
			// width the end "wants": the widest real port on its net (a driverless end
			// reads as 1 via netWidth, but it may connect to a 4-bit port — use that)
			let jWidth = 1;
			net.wires.forEach(wid => {
				const w = sch.wires.find(x => x.id === wid); if (!w) return;
				[w.from, w.to].forEach(ep => {
					const c0 = comp(ep.cid, sch);
					if (c0 && c0.type !== "JUNCTION") { const p = getPort(c0, ep.pid); if (p) jWidth = Math.max(jWidth, p.width || 1); }
				});
				const nwd = netWidth(w, sch); if (nwd > jWidth) jWidth = nwd;   // also honour a bus-def on the net
			});
			// (a) coincides with another junction NOT on our net, same width → merge
			const twin = sch.components.find(c => c !== j && c.type === "JUNCTION" && !net.nodes.has(c.id) && (() => {
				const p = portPos(c, "j"); return Math.abs(p.x - jp.x) < 2 && Math.abs(p.y - jp.y) < 2;
			})());
			if (twin) {
				const tw = sch.wires.find(w => w.from.cid === twin.id || w.to.cid === twin.id);
				const twinWidth = tw ? netWidth(tw, sch) : jWidth;
				if (twinWidth === jWidth) {
					sch.wires.forEach(w => {
						if (w.from.cid === j.id) w.from = { cid: twin.id, pid: "j" };
						if (w.to.cid === j.id) w.to = { cid: twin.id, pid: "j" };
					});
					if (twin.params && twin.params.endpoint) delete twin.params.endpoint;
					sch.components = sch.components.filter(c => c !== j);
					welded = true; again = true; break;
				}
			}
			// (b) lands exactly on another wire (not our own net) of the SAME width →
			// split it through j. Width must match: silently joining an 8-bit bus to a
			// 1-bit wire would be a corrupt net (use a Bus Tap for bus→bit instead).
			let host = null;
			for (const w of sch.wires) {
				if (net.wires.has(w.id)) continue;                 // never weld onto our own net
				const at = nearestOnWire(w, jp, 0, sch);
				if (at && at.d < 2 && netWidth(w, sch) === jWidth) { host = w; break; }
			}
			if (host) {
				delete j.params.endpoint;              // now a real connected junction
				splitWireThroughJunction(host, j, sch);
				welded = true; again = true; break;
			}
		}
	}
	return welded;
}
/* Junctions are managed automatically (created by tapping a wire) — this
   sweeps the ones that no longer serve a purpose:
	 0 wires            → remove the stray dot
	 1 wire             → remove the dangling stub (junction + its wire)
	 1 in + 1 out       → pass-through: merge back into a single wire
   A junction that the live pendingWire starts from is left alone.
   (Auto-welding of touching ends is a LIVE-EDIT action — see weldTouchingEnds,
	called from finishWireInSpace and drag-end — NOT here, so loading a saved
	project never silently alters geometry the user parked on purpose.) */
function healJunctions(sch) {
	sch = sch || activeSch();
	if (!sch) return;
	let changed = true;
	while (changed) {
		changed = false;
		for (const j of sch.components.filter(c => c.type === "JUNCTION")) {
			if (!sch.components.includes(j)) continue;   // already merged away this pass
			if (state.pendingWire && state.pendingWire.cid === j.id) continue;
			const ins = sch.wires.filter(w => w.to.cid === j.id);
			const outs = sch.wires.filter(w => w.from.cid === j.id);
			const total = ins.length + outs.length;
			// a floating-bus definition node holds the bus name+width — keep it intact
			// (never stub-drop or merge) as long as it still carries a wire
			if (j.params && j.params.busName && total > 0) continue;
			if (total === 0) {
				sch.components = sch.components.filter(c => c !== j);
				changed = true;
			} else if (total === 1 && j.params && j.params.endpoint) {
				// a deliberate free wire end (drawn into open space) — keep the stub
				continue;
			} else if (total === 1) {
				sch.components = sch.components.filter(c => c !== j);
				sch.wires = sch.wires.filter(w => w.from.cid !== j.id && w.to.cid !== j.id);
				changed = true;
			} else if (ins.length === 1 && outs.length === 1) {
				const a = ins[0], b = outs[0];
				const jp = portPos(j, "j");
				sch.components = sch.components.filter(c => c !== j);
				sch.wires = sch.wires.filter(w => w !== a && w !== b);
				const merged = { id: uid("w"), from: a.from, to: b.to, name: a.name || b.name || "" };
				// preserve manual waypoints through the removed junction point
				if (a.pts || b.pts) merged.pts = [...(a.pts || []), { x: jp.x, y: jp.y }, ...(b.pts || [])];
				sch.wires.push(merged);
				changed = true;
			} else {
				// ISE has ONE dot per branch point — never two a grid apart joined by a
				// stub. Collapse a fan-out junction that sits on top of another junction,
				// or is joined to one by a single short straight stub, into a single dot.
				const jp = portPos(j, "j");
				if (j.params && j.params.busName) continue;   // keep bus-def nodes distinct
				const twin = sch.components.find(k => {
					if (k === j || k.type !== "JUNCTION") return false;
					if (k.params && k.params.busName) return false;
					const kp = portPos(k, "j");
					if (Math.abs(kp.x - jp.x) < 2 && Math.abs(kp.y - jp.y) < 2) return true;   // coincident
					const stub = sch.wires.find(w => (w.from.cid === j.id && w.to.cid === k.id) || (w.from.cid === k.id && w.to.cid === j.id));
					if (!stub || (stub.pts && stub.pts.length)) return false;         // must be a plain stub
					const straight = Math.abs(kp.x - jp.x) < 1 || Math.abs(kp.y - jp.y) < 1;  // collinear H or V
					return straight && (Math.abs(kp.x - jp.x) + Math.abs(kp.y - jp.y)) <= 1.5 * GRID;
				});
				if (twin) {
					// A dot the user dragged is pinned (params.fixed) so it stays exactly
					// where they parked it — this merge must not silently delete it in
					// favor of whichever junction happened to be iterated first. If both
					// sides were parked by hand, leave them both alone; we can't guess
					// which placement wins. Otherwise the pinned one (if any) survives
					// and the unpinned one is the one folded away.
					const jFixed = !!(j.params && j.params.fixed);
					const twinFixed = !!(twin.params && twin.params.fixed);
					if (jFixed && twinFixed) continue;
					const keep = twinFixed ? twin : j;
					const drop = twinFixed ? j : twin;
					const wA = sch.wires.find(w => w.from.cid === keep.id || w.to.cid === keep.id);
					const wB = sch.wires.find(w => w.from.cid === drop.id || w.to.cid === drop.id);
					// CRITICAL: two coincident dots of DIFFERENT nets (both scalar) would weld
					// and SHORT the nets — silently wrong VHDL. Weld only when they are already
					// electrically one net: joined by the stub, or tracing to the same driver.
					const drvKey = jj => { const wf = sch.wires.find(w => w.from.cid === jj.id); if (!wf) return "solo:" + jj.id; const d = netDriverPort(sch, wf); return d ? d.cid + "." + d.pid : "solo:" + jj.id; };
					const joinedByStub = sch.wires.some(w => (w.from.cid === keep.id && w.to.cid === drop.id) || (w.from.cid === drop.id && w.to.cid === keep.id));
					const sameNet = joinedByStub || drvKey(keep) === drvKey(drop);
					if (sameNet && (!wA || !wB || netWidth(wA, sch) === netWidth(wB, sch))) {   // don't weld across a width boundary
						sch.wires.forEach(w => {
							if (w.from.cid === drop.id) w.from = { cid: keep.id, pid: "j" };
							if (w.to.cid === drop.id) w.to = { cid: keep.id, pid: "j" };
						});
						sch.components = sch.components.filter(c => c !== drop);
						sch.wires = sch.wires.filter(w => w.from.cid !== w.to.cid);   // drop the collapsed stub
						changed = true;
					}
				}
			}
		}
	}
}
/* Re-seed the uid counter after loading external data so new ids never collide */
/* Lift the uid counter above every id in p (default: the live project). Takes p so
   deserialize can seed from a project it has NOT committed yet — anything that mints
   ids before this runs (normalizePortFanout's junctions) would collide with loaded
   ids, and a duplicate cid silently re-points wires at the wrong component. */
function reseedUid(p) {
	let mx = 0;
	const scan = id => { const m = /(\d+)$/.exec(id || ""); if (m) mx = Math.max(mx, +m[1]); };
	p = p || state.project;
	Object.keys(p.schematics).forEach(sid => {
		scan(sid);
		const s = p.schematics[sid];
		(s.components || []).forEach(c => scan(c.id));
		(s.wires || []).forEach(w => scan(w.id));
	});
	Object.values(p.customs || {}).forEach(cc => {
		if (!cc.schematic) return;
		(cc.schematic.components || []).forEach(c => scan(c.id));
		(cc.schematic.wires || []).forEach(w => scan(w.id));
	});
	if (mx >= _uidN) _uidN = mx + 1;
}
/* THE single source of truth for a wire's width: the width of the port that
   ultimately drives its net, traced through width-transparent junctions.
   Never cached — always derived, so it can never go stale. */
function netWidth(w, sch, visited) {
	sch = sch || activeSch();
	visited = visited || new Set();
	if (visited.has(w.id)) return 1;          // cycle guard
	visited.add(w.id);
	const src = comp(w.from.cid, sch);
	if (!src) return 1;
	if (src.type === "JUNCTION") {
		const up = sch.wires.find(x => x.to.cid === src.id);
		if (up) return netWidth(up, sch, visited);
		if (src.params && src.params.busWidth) return src.params.busWidth;  // floating bus def
		return 1;
	}
	const fp = getPort(src, w.from.pid);
	return fp ? (fp.width || 1) : 1;
}
/* Ensure a schematic name is unique in the project (excluding one id) */
function uniqueSchName(base, excludeId) {
	let nm = sanId(base) || "sch";
	const taken = () => Object.keys(state.project.schematics)
		.some(id => id !== excludeId && state.project.schematics[id].name === nm);
	let k = 2; const root = nm;
	while (taken()) nm = root + "_" + (k++);
	return nm;
}
