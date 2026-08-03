"use strict";

function snapshot() {
	if (state.history.muted) return;

	const serialized = JSON.stringify({
		p: state.project,
		a: state.activeId,
		t: state.openTabs
	});

	const history = state.history;

	history.stack = history.stack.slice(0, history.idx + 1);
	history.stack.push(serialized);

	if (history.stack.length > 80) {
		history.stack.shift();
	}

	history.idx = history.stack.length - 1;
}

function restore(serialized) {
	const data = JSON.parse(serialized);

	state.project = data.p;
	state.activeId = data.a;
	state.openTabs = data.t;
	state.selection.clear();
	state.pendingWire = null;

	renderAll();
}

function undo() {
	if (state.history.idx <= 0) return;

	state.history.idx--;
	restore(state.history.stack[state.history.idx]);
}

function redo() {
	if (state.history.idx >= state.history.stack.length - 1) return;

	state.history.idx++;
	restore(state.history.stack[state.history.idx]);
}
