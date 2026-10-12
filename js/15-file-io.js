"use strict";

/* =========================================================================
   FILE I/O
   ========================================================================= */
function serialize() {
	// strip only the VHDL-generator scratch fields (never user data, whose keys
	// could legitimately start with "_" after sanId)
	const SCRATCH = new Set(["_net", "_nets", "_netW", "_busSig", "_busW"]);
	stashProjectUi();
	// never write an EMPTY workspace: the active project belongs in the map even if
	// seedWorkspace never ran (a half-built state, a file being repaired)
	if (!Object.keys(state.projects || {}).length || !state.projects[state.activeProjectId]) {
		if (!state.project.id) state.project.id = uid("prj");
		state.projects = { [state.project.id]: state.project };
		state.activeProjectId = state.project.id;
	}
	// version 2 carries the whole workspace. `project` is still written out as the
	// ACTIVE one so a file from here stays readable by anything expecting version 1.
	return JSON.stringify({
		version: 2,
		workspace: { projects: state.projects, activeId: state.activeProjectId },
		project: state.project,
		activeId: state.activeId,
		openTabs: state.openTabs,
	}, (k, v) => SCRATCH.has(k) ? undefined : v, 2);
}
function resetVhdlPanel() {
	_lastAllVhdl = null;
	$("#vhdlEntitySel").innerHTML = "";
	const pre = $("#vhdlOutput");
	pre.dataset.raw = "";
	pre.innerHTML = `<span class="cm">-- กดปุ่ม "⚙ Generate VHDL" ด้านบน เพื่อสร้างโค้ดจากวงจร</span>`;
}
function deserialize(json) {
	// parse + repair on a local object first, commit to state only when valid
	const o = JSON.parse(json);
	/* A version-2 file holds a whole workspace. Rather than a second copy of the
	   repair below, each project is fed back through THIS function as a version-1
	   payload and the healed result is collected — one code path, so a project in a
	   workspace can never be repaired differently from one in a file of its own. */
	// an empty or unreadable workspace falls through to the single project beside it,
	// rather than refusing a file that still holds usable work
	if (o.workspace && o.workspace.projects && typeof o.workspace.projects === "object"
		&& Object.keys(o.workspace.projects).length) {
		const ids = Object.keys(o.workspace.projects);
		const built = {};
		ids.forEach(pid => {
			const raw = o.workspace.projects[pid];
			deserialize(JSON.stringify({
				version: 1, project: raw,
				activeId: raw && raw.activeId, openTabs: raw && raw.openTabs
			}));
			const healed = state.project;
			healed.id = pid;
			healed.openTabs = state.openTabs.slice();
			healed.activeId = state.activeId;
			built[pid] = healed;
		});
		state.projects = built;
		state.activeProjectId = built[o.workspace.activeId] ? o.workspace.activeId : ids[0];
		state.activeProjectId = null;              // make switchProject actually run
		switchProject(built[o.workspace.activeId] ? o.workspace.activeId : ids[0]);
		return;
	}
	if (!o.project || typeof o.project !== "object") throw new Error("Invalid file");
	const proj = o.project;
	if (!proj.schematics || Object.keys(proj.schematics).length === 0) {
		const fresh = blankProject();
		proj.schematics = fresh.schematics;
		proj.topId = fresh.topId;
	}
	if (!proj.customs) proj.customs = {};
	if (!proj.topId || !proj.schematics[proj.topId]) {
		proj.topId = Object.keys(proj.schematics)[0];
	}
	// normalise every sheet's SHAPE up front, so the migrate/heal/fanout passes below
	// can't throw a raw TypeError deep inside on a malformed-but-parseable file
	const fixSheet = (s, sid) => {
		if (!s || typeof s !== "object") throw new Error("Invalid file: schematic is not an object");
		if (!Array.isArray(s.components)) s.components = [];
		if (!Array.isArray(s.wires)) s.wires = [];
		s.wires = s.wires.filter(w => w && w.from && w.to && w.from.cid != null && w.to.cid != null);
		s.id = s.id || sid; s.name = s.name || sid || "sch";
	};
	Object.entries(proj.schematics).forEach(([sid, s]) => fixSheet(s, sid));
	Object.values(proj.customs).forEach(cc => { if (cc && cc.schematic) fixSheet(cc.schematic, cc.schematic.id); });
	// migrate/clean old bus components: TAP→BUSTAP (keep); SPLIT/MERGE/BUSMERGE/SHIFT
	// were removed → strip them and their wires
	const DEAD_TYPES = new Set(["SPLIT", "MERGE", "BUSMERGE", "BUSRIP", "SHIFT"]);
	const migrate = s => {
		if (!s || !s.components) return;
		s.components.forEach(cc => { if (cc.type === "TAP") { cc.type = "BUSTAP"; if (cc.params) delete cc.params.width; } });
		// old BUS TAP params were a hi:lo bit-RANGE (always an output); the current model
		// is a single bit + split/merge mode. Collapse a saved range onto its low bit
		// (a genuine multi-bit range has no equivalent any more) and default to split,
		// since every old tap only ever read OFF the bus.
		s.components.forEach(cc => {
			if (cc.type !== "BUSTAP" || !cc.params) return;
			if (cc.params.bit !== undefined) return;                 // already current format
			if (cc.params.hi === undefined && cc.params.lo === undefined) return;
			cc.params.bit = cc.params.lo ?? cc.params.hi ?? 0;
			cc.params.mode = cc.params.mode || "split";
			delete cc.params.hi; delete cc.params.lo;
		});
		const dead = new Set(s.components.filter(cc => DEAD_TYPES.has(cc.type)).map(cc => cc.id));
		if (dead.size) {
			s.components = s.components.filter(cc => !dead.has(cc.id));
			s.wires = (s.wires || []).filter(x => !dead.has(x.from.cid) && !dead.has(x.to.cid));
		}
	};
	Object.values(proj.schematics).forEach(migrate);
	Object.values(proj.customs || {}).forEach(cc => migrate(cc.schematic));
	// Freeze each dot's host axis from how the file ALREADY looks, before anything
	// below can change the wire set under it. Files written before params.axis existed
	// would otherwise keep deriving it from their current branches, so deleting one
	// branch would re-elbow the others (see junctionExitH). Stamping the derived value
	// is picture-preserving by construction: it records exactly what is drawn today.
	Object.values(proj.schematics).forEach(stampJunctionAxis);
	Object.values(proj.customs || {}).forEach(cc => { if (cc.schematic) stampJunctionAxis(cc.schematic); });
	// sweep junctions that lost their purpose (orphans from old files/edits)
	Object.values(proj.schematics).forEach(s => healJunctions(s));
	Object.values(proj.customs || {}).forEach(cc => { if (cc.schematic) healJunctions(cc.schematic); });
	// MUST precede anything that mints ids below: normalizePortFanout creates junction
	// + wire ids via uid(), and an id colliding with a loaded one silently re-points
	// wires at the wrong component (dead nets, wrong VHDL, saved back into the file)
	reseedUid(proj);
	// parallel same-port fanout (old files) → junction branches with visible dots.
	// Lay out ONLY what that conversion created: a file saved by this app is already
	// fanned out, so nothing happens and the drawing loads exactly as it was saved.
	// (the layout itself is deferred until after the project is committed below, so
	//  sub-block types resolve against the real project)
	const fanoutFixups = [];
	const fanoutFix = s => {
		const before = new Set(s.wires.map(w => w.id));
		normalizePortFanout(s);
		const fresh = s.wires.filter(w => !before.has(w.id));
		if (fresh.length) fanoutFixups.push({ s, fresh });
	};
	Object.values(proj.schematics).forEach(fanoutFix);
	Object.values(proj.customs || {}).forEach(cc => { if (cc.schematic) fanoutFix(cc.schematic); });
	// legacy files may carry duplicate schematic names → entities would collide
	const seenNames = new Set();
	Object.values(proj.schematics).forEach(s => {
		let nm = sanId(s.name || "sch"), k = 2; const root = nm;
		while (seenNames.has(nm)) nm = root + "_" + (k++);
		seenNames.add(nm);
		s.name = nm;
	});
	// commit
	state.project = proj;
	if (!proj.id) proj.id = uid("prj");
	// a plain project file becomes a one-project workspace; when this call is a step
	// of a workspace load the caller replaces the map straight after
	state.projects = { [proj.id]: proj };
	state.activeProjectId = proj.id;
	state.activeId = (o.activeId && proj.schematics[o.activeId]) ? o.activeId : Object.keys(proj.schematics)[0];
	state.openTabs = (o.openTabs || []).filter(id => proj.schematics[id]);
	if (!state.openTabs.length) state.openTabs = [state.activeId];
	state.selection.clear();
	state.pendingWire = null;
	reseedUid();                     // avoid new-id collisions with loaded ids
	// now that the project is live, lay out ONLY the branches the legacy-fanout fix
	// created; a file saved by this app has none, so it loads exactly as it was saved
	fanoutFixups.forEach(({ s, fresh }) => { try { healLayout(s, scopeOf(s, { wires: fresh })); } catch (e) { } });
	resetVhdlPanel();                // stale generated code belongs to the old project
	$("#projectName").value = proj.name || "my_project";
	snapshot(); renderAll();
	autoFitSheet(true);              // a loaded sheet is new content, same id or not
}
function saveProjectToFile() {
	state.project.name = sanId($("#projectName").value || state.project.name || "project");
	$("#projectName").value = state.project.name;
	const data = serialize();
	const b = new Blob([data], { type: "application/json" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u;
	a.download = dlName(state.project.name, ".schproj.json", "project");
	a.click();
	URL.revokeObjectURL(u);
	toast("บันทึกโปรเจกต์แล้ว", "ok");
}
function openProjectFromFile() {
	const inp = document.createElement("input");
	inp.type = "file";
	inp.accept = ".json,application/json";
	inp.onchange = e => {
		const f = e.target.files[0]; if (!f) return;
		const r = new FileReader();
		r.onload = () => {
			try { deserialize(r.result); toast("โหลดโปรเจกต์แล้ว", "ok"); }
			catch (err) { toast("โหลดไม่สำเร็จ: " + err.message, "err"); }
		};
		r.readAsText(f);
	};
	inp.click();
}
/* ---------- WORKSPACE OPERATIONS ---------- */
function uniqueProjectName(base, excludeId) {
	let nm = sanId(base) || "project";
	const taken = () => Object.keys(state.projects)
		.some(id => id !== excludeId && (state.projects[id].name || "") === nm);
	let k = 2; const root = nm;
	while (taken()) nm = root + "_" + (k++);
	return nm;
}
/* the desk is remembered per project, not globally */
function stashProjectUi() {
	const p = state.project;
	if (!p) return;
	p.openTabs = (state.openTabs || []).slice();
	p.activeId = state.activeId;
}
function switchProject(pid) {
	const p = state.projects[pid];
	if (!p || pid === state.activeProjectId) return;
	stashProjectUi();
	state.activeProjectId = pid;
	state.project = p;
	state.activeId = (p.activeId && p.schematics[p.activeId]) ? p.activeId : Object.keys(p.schematics)[0];
	state.openTabs = (p.openTabs || []).filter(id => p.schematics[id]);
	if (!state.openTabs.length && state.activeId) state.openTabs = [state.activeId];
	state.selection.clear();
	state.pendingWire = null;
	// undo does not reach across projects — a stack holding another project's sheets
	// would restore them into this slot
	state.history = { stack: [], idx: -1, muted: false };
	resetVhdlPanel();
	const nameBox = $("#projectName"); if (nameBox) nameBox.value = p.name || "my_project";
	snapshot(); renderAll();
	autoFitSheet(true);              // splitting copies ids, so force rather than compare
}
function addProject(name, opts) {
	opts = opts || {};
	const pid = uid("prj");
	const p = blankProject();
	p.id = pid;
	p.name = uniqueProjectName(name || "project", pid);
	if (opts.empty) { p.schematics = {}; p.topId = null; }
	state.projects[pid] = p;
	if (opts.activate !== false) switchProject(pid);
	else renderAll();
	return p;
}
function renameProjectById(pid, name) {
	const p = state.projects[pid]; if (!p) return;
	p.name = uniqueProjectName(name, pid);
	if (pid === state.activeProjectId) { const b = $("#projectName"); if (b) b.value = p.name; }
	renderAll();
}
function deleteProjectById(pid) {
	const p = state.projects[pid]; if (!p) return;
	if (Object.keys(state.projects).length === 1) { toast("ต้องเหลืออย่างน้อย 1 โปรเจกต์", "warn"); return; }
	const n = Object.keys(p.schematics || {}).length;
	if (!confirm(`ลบโปรเจกต์ "${p.name}" (${n} schematic)?\nการลบนี้ย้อนกลับไม่ได้`)) return;
	delete state.projects[pid];
	if (pid === state.activeProjectId) {
		state.activeProjectId = null;               // force switchProject to do its work
		switchProject(Object.keys(state.projects)[0]);
	} else renderAll();
	toast(`ลบโปรเจกต์ "${p.name}" แล้ว`, "ok");
}
/* Adds a project to the workspace — nothing is thrown away any more, so this needs
   no confirmation. Replacing everything is what opening a file does. */
function newProject() {
	const nm = prompt("ชื่อโปรเจกต์ใหม่:", "project");
	if (!nm) return;
	const p = addProject(nm);
	state.view = { x: 0, y: 0, k: 1 };
	toast(`สร้างโปรเจกต์ "${p.name}" แล้ว`, "ok");
}
/* Build the new project file and, when moving, take the sheets out of this one.
   Ids are kept exactly as they are: the SCH: references inside the exported set
   already point at each other, and the file lands in a project of its own where
   nothing can collide. */
function splitProject(ids, opts) {
	opts = opts || {};
	const P = (opts.from && state.projects[opts.from]) || state.project;
	const keep = [...schClosure(ids, P)];
	if (!keep.length) { toast("ยังไม่ได้เลือก schematic", "warn"); return null; }
	if (opts.move) {
		const hurt = schDependents(keep, P);
		if (hurt.length) {
			toast(`ย้ายออกไม่ได้ — ${hurt.map(s => s.name).join(", ")} ยังใช้แผ่นที่จะย้ายอยู่ (ใช้ "คัดลอก" แทน)`, "err", 6000);
			return null;
		}
	}
	const sheets = keep.map(id => P.schematics[id]);
	const customs = {};
	customsUsedBy(sheets, P).forEach(n => { customs[n] = P.customs[n]; });
	const topId = keep.includes(P.topId) ? P.topId : keep[0];

	/* Destination is a project IN THE APP unless a file was asked for. This is the
	   point of the whole feature: work is organised into Lab01 / Lab02 / … without
	   anything leaving the browser. Into a NEW project the sheets keep their ids (a
	   fresh project cannot collide, and their SCH: references already point at each
	   other); into an EXISTING one adoptSchematics re-mints ids and repoints those
	   references, because the target may already use the same ones. */
	if (opts.dest && opts.dest !== "file") {
		const deep = JSON.parse(JSON.stringify(sheets));
		let target;
		if (opts.dest === "new") {
			target = addProject(opts.name || (P.name + "_part"), { activate: false, empty: true });
			deep.forEach(s => { target.schematics[s.id] = s; });
			target.topId = keep.includes(P.topId) ? P.topId : deep[0].id;
			Object.keys(customs).forEach(n => { target.customs[n] = JSON.parse(JSON.stringify(customs[n])); });
		} else {
			target = state.projects[opts.dest];
			if (!target) { toast("ไม่พบโปรเจกต์ปลายทาง", "err"); return null; }
			if (target === P) { toast("ต้นทางกับปลายทางเป็นโปรเจกต์เดียวกัน", "warn"); return null; }
			adoptSchematics(deep, customs, target);
			if (!target.topId || !target.schematics[target.topId]) target.topId = Object.keys(target.schematics)[0];
		}
		if (opts.move) {
			keep.forEach(id => { delete P.schematics[id]; });
			tidyProjectAfterRemoval(P);
		}
		snapshot(); renderAll();
		autoFitSheet();
		toast(`${opts.move ? "ย้าย" : "คัดลอก"} ${keep.length} schematic ไปที่โปรเจกต์ "${target.name}" แล้ว`, "ok", 4200);
		return { project: target, ids: keep };
	}
	const out = {
		version: 1,
		project: {
			name: sanId(opts.name || (P.name + "_part")) || "project",
			topId, customs,
			schematics: keep.reduce((o, id) => { o[id] = P.schematics[id]; return o; }, {}),
		},
		activeId: topId,
		openTabs: [topId],
	};
	const data = JSON.stringify(out, (k, v) => ["_net", "_nets", "_netW"].includes(k) ? undefined : v, 2);
	const b = new Blob([data], { type: "application/json" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u;
	a.download = dlName(out.project.name, ".schproj.json", "project");
	a.click();
	URL.revokeObjectURL(u);

	if (opts.move) {
		keep.forEach(id => { delete P.schematics[id]; });
		tidyProjectAfterRemoval(P);
		snapshot(); renderAll();
		autoFitSheet();
	}
	toast(`แยก ${keep.length} schematic เป็นโปรเจกต์ "${out.project.name}" แล้ว` +
		(opts.move ? " และย้ายออกจากโปรเจกต์นี้" : " (ต้นฉบับยังอยู่ครบ)"), "ok", 5200);
	return out;
}
/* =========================================================================
   AUTO-SAVE (localStorage)
   ========================================================================= */
function autosave() {
	try {
		localStorage.setItem(AUTOSAVE_KEY, serialize());
		$("#statAutosave").innerHTML = `<span class="ok">autosave: ✓ ${new Date().toLocaleTimeString()}</span>`;
	} catch (e) {
		$("#statAutosave").innerHTML = `<span class="err">autosave failed</span>`;
	}
}
function loadAutosave() {
	const s = localStorage.getItem(AUTOSAVE_KEY);
	if (s) {
		try {
			deserialize(s);   // also syncs #projectName, uid counter, VHDL panel
			return true;
		} catch (e) {
			console.warn("Autosave restore failed:", e);
		}
	}
	return false;
}
function startAutoSave() {
	clearInterval(state.autosaveTimer);
	state.autosaveTimer = setInterval(autosave, AUTOSAVE_MS);
}
