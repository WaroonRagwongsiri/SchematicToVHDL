"use strict";

function blankSchematic(id, name) {
	return {
		id,
		name,
		components: [],
		wires: []
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

function comp(cid, sch = activeSch()) {
	if (!sch || !Array.isArray(sch.components)) return null;
	return sch.components.find(component => component.id === cid);
}
