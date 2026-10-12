"use strict";

function blankSchematic(id, name) {
	return {
		id,
		name,
		components: [],
		wires: [],
		locked: false
	};
}

function blankProject() {
	const id = uid("sch");

	return {
		name: "my_project",
		topId: id,
		schOrder: [id],
		schematics: {
			[id]: blankSchematic(id, "top")
		},
		customs: {}
	};
}

const state = {
	/* WORKSPACE. Work is organised in several projects at once (Lab01, Lab02, …)
	   exactly like a tool's project list, so one term does not become one giant
	   sheet list. `state.project` remains the ACTIVE project object and every other
	   line in this file keeps reading it — the workspace only decides WHICH object
	   that is. Each project also remembers its own open tabs and active sheet, so
	   switching back finds the desk as it was left. */
	projects: {},             // {pid: project}
	activeProjectId: null,
	project: blankProject(),
	activeId: null,
	openTabs: [],
	selection: new Set(),
	pendingWire: null,
	wireDrag: null,
	cornerDrag: null,
	spaceDown: false,
	tool: "select",
	drag: null,
	pan: null,
	view: { x: 0, y: 0, k: 1 },
	mouse: { x: 0, y: 0 },
	hover: null,
	history: {
		stack: [],
		idx: -1,
		muted: false
	},
	autosaveTimer: null,
	clipboard: null,
	dragType: null,
	marquee: null
};

/* the one project the state literal starts with becomes the first of the workspace */
function seedWorkspace() {
	const pid = uid("prj");
	state.project.id = pid;
	state.projects = { [pid]: state.project };
	state.activeProjectId = pid;
}

function activeSch() {
	return state.project.schematics[state.activeId];
}

function orderedSchIds(p) {
	p = p || state.project;
	const order = p.schOrder || [];
	const ids = order.filter(id => p.schematics[id]);
	Object.keys(p.schematics).forEach(id => { if (!ids.includes(id)) ids.push(id); });
	return ids;
}

const _compIndexCache = new WeakMap();

function comp(cid, sch = activeSch()) {
	if (!sch || !Array.isArray(sch.components)) return null;
	let idx = _compIndexCache.get(sch.components);
	if (!idx) {
		idx = new Map();
		for (const c of sch.components) idx.set(c.id, c);
		_compIndexCache.set(sch.components, idx);
	}
	const found = idx.get(cid);
	if (found !== undefined) return found;
	return sch.components.find(component => component.id === cid);
}
