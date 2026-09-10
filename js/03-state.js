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

function activeSch() {
	return state.project.schematics[state.activeId];
}

function orderedSchIds() {
	const p = state.project;
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
