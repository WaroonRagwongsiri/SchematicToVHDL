"use strict";

/* =========================================================================
   FILE I/O
   ========================================================================= */
function serialize() {
	// strip only the VHDL-generator scratch fields (never user data, whose keys
	// could legitimately start with "_" after sanId)
	const SCRATCH = new Set(["_net", "_nets", "_netW", "_busSig", "_busW"]);
	return JSON.stringify({
		version: 1,
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
	// migrate/clean old bus components: TAP→BUSTAP (keep); SPLIT/MERGE/BUSMERGE
	// were removed → strip them and their wires
	const DEAD_TYPES = new Set(["SPLIT", "MERGE", "BUSMERGE", "BUSRIP"]);
	const migrate = s => {
		if (!s || !s.components) return;
		s.components.forEach(cc => { if (cc.type === "TAP") { cc.type = "BUSTAP"; if (cc.params) delete cc.params.width; } });
		const dead = new Set(s.components.filter(cc => DEAD_TYPES.has(cc.type)).map(cc => cc.id));
		if (dead.size) {
			s.components = s.components.filter(cc => !dead.has(cc.id));
			s.wires = (s.wires || []).filter(x => !dead.has(x.from.cid) && !dead.has(x.to.cid));
		}
	};
	Object.values(proj.schematics).forEach(migrate);
	Object.values(proj.customs || {}).forEach(cc => migrate(cc.schematic));
	// sweep junctions that lost their purpose (orphans from old files/edits)
	Object.values(proj.schematics).forEach(s => healJunctions(s));
	Object.values(proj.customs || {}).forEach(cc => { if (cc.schematic) healJunctions(cc.schematic); });
	// MUST precede anything that mints ids below: normalizePortFanout creates junction
	// + wire ids via uid(), and an id colliding with a loaded one silently re-points
	// wires at the wrong component (dead nets, wrong VHDL, saved back into the file)
	reseedUid(proj);
	// parallel same-port fanout (old files) → junction branches with visible dots
	Object.values(proj.schematics).forEach(s => normalizePortFanout(s));
	Object.values(proj.customs || {}).forEach(cc => { if (cc.schematic) normalizePortFanout(cc.schematic); });
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
	state.activeId = (o.activeId && proj.schematics[o.activeId]) ? o.activeId : Object.keys(proj.schematics)[0];
	state.openTabs = (o.openTabs || []).filter(id => proj.schematics[id]);
	if (!state.openTabs.length) state.openTabs = [state.activeId];
	state.selection.clear();
	state.pendingWire = null;
	reseedUid();                     // avoid new-id collisions with loaded ids
	resetVhdlPanel();                // stale generated code belongs to the old project
	$("#projectName").value = proj.name || "my_project";
	snapshot(); renderAll();
}
function saveProjectToFile() {
	state.project.name = sanId($("#projectName").value || state.project.name || "project");
	$("#projectName").value = state.project.name;
	const data = serialize();
	const b = new Blob([data], { type: "application/json" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u;
	a.download = state.project.name + ".schproj.json";
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
function newProject() {
	if (!confirm("สร้างโปรเจกต์ใหม่? โปรเจกต์ปัจจุบันที่ยังไม่ได้ Save เป็นไฟล์จะหายไป")) return;
	state.project = blankProject();
	state.activeId = Object.keys(state.project.schematics)[0];
	state.openTabs = [state.activeId];
	state.selection.clear();
	state.pendingWire = null;
	state.view = { x: 0, y: 0, k: 1 };
	state.history = { stack: [], idx: -1, muted: false };
	resetVhdlPanel();
	$("#projectName").value = "my_project";
	snapshot(); renderAll();
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
