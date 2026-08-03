"use strict";

function renderAll() {
	renderSchTabs();
	renderProjectTree();
	renderPalette();
	render();
	renderInspector();
}

function seedHalfAdder() {
	const sch = activeSch();

	const inputA = {
		id: uid("c"),
		type: "IN",
		x: 88,
		y: 110,
		params: { name: "a", width: 1 }
	};

	const inputB = {
		id: uid("c"),
		type: "IN",
		x: 88,
		y: 132,
		params: { name: "b", width: 1 }
	};

	const xorGate = {
		id: uid("c"),
		type: "XOR",
		x: 264,
		y: 110,
		params: { inputs: 2 }
	};

	const andGate = {
		id: uid("c"),
		type: "AND",
		x: 264,
		y: 220,
		params: { inputs: 2 }
	};

	const sumOutput = {
		id: uid("c"),
		type: "OUT",
		x: 484,
		y: 121,
		params: { name: "sum", width: 1 }
	};

	const carryOutput = {
		id: uid("c"),
		type: "OUT",
		x: 484,
		y: 231,
		params: { name: "cout", width: 1 }
	};

	sch.components.push(
		inputA,
		inputB,
		xorGate,
		andGate,
		sumOutput,
		carryOutput
	);

	sch.wires.push(
		{
			id: uid("w"),
			from: { cid: inputA.id, pid: "o" },
			to: { cid: xorGate.id, pid: "i0" },
			name: "",
			width: 1
		},
		{
			id: uid("w"),
			from: { cid: inputB.id, pid: "o" },
			to: { cid: xorGate.id, pid: "i1" },
			name: "",
			width: 1
		},
		{
			id: uid("w"),
			from: { cid: inputA.id, pid: "o" },
			to: { cid: andGate.id, pid: "i0" },
			name: "",
			width: 1
		},
		{
			id: uid("w"),
			from: { cid: inputB.id, pid: "o" },
			to: { cid: andGate.id, pid: "i1" },
			name: "",
			width: 1
		},
		{
			id: uid("w"),
			from: { cid: xorGate.id, pid: "o" },
			to: { cid: sumOutput.id, pid: "i" },
			name: "sum_w",
			width: 1
		},
		{
			id: uid("w"),
			from: { cid: andGate.id, pid: "o" },
			to: { cid: carryOutput.id, pid: "i" },
			name: "carry",
			width: 1
		}
	);

	normalizePortFanout(sch);
}

function init() {
	bindTabs();
	bindMenus();
	bindToolbar();
	bindActionDispatcher();
	updateHopMenuLabel();

	let restored = false;

	try {
		restored = loadAutosave();
	} catch (error) {
		console.warn("Autosave loading failed:", error);
	}

	if (!restored) {
		state.activeId = Object.keys(state.project.schematics)[0];
		state.openTabs = [state.activeId];

		seedHalfAdder();
		snapshot();
	} else {
		try {
			healLayout();
		} catch (error) {
			console.warn("Layout healing failed:", error);
		}
	}

	renderAll();
	startAutoSave();

	toast("Schematic Studio — พร้อมใช้งาน", "ok", 1800);
}

init();
