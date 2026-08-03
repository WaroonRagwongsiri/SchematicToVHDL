"use strict";

function setLeftTab(name) {
	$$(".pane:not(.right) .pane-tabs button").forEach(button => {
		button.classList.toggle("active", button.dataset.ltab === name);
	});

	$("#projectPane").classList.toggle("hidden", name !== "project");
	$("#palettePane").classList.toggle("hidden", name !== "palette");
}

function setRightTab(name) {
	$$(".pane.right .pane-tabs button").forEach(button => {
		button.classList.toggle("active", button.dataset.rtab === name);
	});

	$("#inspectorPane").classList.toggle("hidden", name !== "inspector");
	$("#errorsPane").classList.toggle("hidden", name !== "errors");
	$("#vhdlPane").classList.toggle("hidden", name !== "vhdl");
}

function updateHopMenuLabel() {
	const button = $("#miHops");
	if (!button) return;

	button.textContent =
		HOP_STYLE === "hop"
			? "⤴ จุดตัดสาย: สะพานข้าม (คลิกเพื่อสลับ)"
			: "⤴ จุดตัดสาย: เรียบ แบบ ISE (คลิกเพื่อสลับ)";
}

function bindTabs() {
	$$(".pane:not(.right) .pane-tabs button").forEach(button => {
		button.addEventListener("click", () => {
			setLeftTab(button.dataset.ltab);
		});
	});

	$$(".pane.right .pane-tabs button").forEach(button => {
		button.addEventListener("click", () => {
			setRightTab(button.dataset.rtab);
		});
	});
}

function bindMenus() {
	$$(".menu .mi").forEach(menuItem => {
		const button = menuItem.querySelector("button");

		button.addEventListener("click", event => {
			event.stopPropagation();

			const wasOpen = menuItem.classList.contains("open");

			$$(".menu .mi").forEach(item => {
				item.classList.remove("open");
			});

			if (!wasOpen) menuItem.classList.add("open");
		});

		menuItem.addEventListener("mouseenter", () => {
			if (menuItem.classList.contains("open")) return;
			if (!$$(".menu .mi.open").length) return;

			$$(".menu .mi").forEach(item => {
				item.classList.remove("open");
			});

			menuItem.classList.add("open");
		});
	});

	document.addEventListener("click", () => {
		$$(".menu .mi").forEach(item => {
			item.classList.remove("open");
		});
	});
}

function bindToolbar() {
	$$("#canvasToolbar button").forEach(button => {
		button.addEventListener("click", () => {
			setTool(button.dataset.tool);
		});
	});
}

function bindActionDispatcher() {
	document.addEventListener("click", event => {
		const actionElement = event.target.closest("[data-act]");
		if (!actionElement) return;

		const action = actionElement.dataset.act;

		switch (action) {
			// Move the existing switch cases here unchanged.
		}
	});
}
