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
			case "new-project": newProject(); break;
			case "open-project": openProjectFromFile(); break;
			case "save-project": saveProjectToFile(); break;
			case "save-as-project": {
				const nm = prompt("บันทึกเป็นชื่อโปรเจกต์:", state.project.name || "my_project");
				if (nm === null || !nm.trim()) return;
				$("#projectName").value = sanId(nm.trim());
				saveProjectToFile();
				break;
			}
			case "new-sch": {
				const nm = prompt("ชื่อ schematic ใหม่:", "sch_" + (Object.keys(state.project.schematics).length + 1));
				if (!nm) return;
				const id = uid("sch");
				state.project.schematics[id] = blankSchematic(id, uniqueSchName(nm, id));
				openSchTab(id);
				snapshot(); renderAll();
				break;
			}
			case "rename-sch": {
				const sch = activeSch(); if (!sch) return;
				const nm = prompt("เปลี่ยนชื่อ schematic:", sch.name);
				if (nm) { sch.name = uniqueSchName(nm, sch.id); snapshot(); renderAll(); }
				break;
			}
			case "set-top": {
				if (!state.activeId) return;
				state.project.topId = state.activeId;
				snapshot(); renderAll();
				toast("ตั้งเป็น top entity: " + activeSch().name, "ok");
				break;
			}
			case "gen-vhdl": generateVHDL(); break;
			case "export-vhdl": exportVhdlFile(); break;
			case "export-all": exportAllVhdl(); break;
			case "wizard": openWizard(); break;
			case "synth": runSynthesis(); break;
			case "rename-wire": {
				const id = Array.from(state.selection)[0];
				const w = activeSch().wires.find(x => x.id === id);
				if (!w) { toast("เลือกสายก่อน", "warn"); return; }
				applyWireName(w, prompt("ตั้งชื่อสาย (บัสต้องลากจากพอร์ต >1 bit ของ component):", w.name || ""));
				break;
			}
			case "undo": undo(); break;
			case "redo": redo(); break;
			case "duplicate": duplicateSelection(); break;
			case "copy": copySelection(); break;
			case "paste": pasteClipboard(); break;
			case "cut": copySelection(); deleteSelection(); break;
			case "import-custom": importCustomComponent(); break;
			case "import-vhdl": importVhdlFile(); break;
			case "export-active-custom": exportActiveAsCustom(); break;
			case "delete-sel": deleteSelection(); break;
			case "clear-sch": {
				if (!confirm("ล้าง schematic นี้?")) return;
				const sch = activeSch(); sch.components = []; sch.wires = [];
				state.selection.clear(); snapshot(); renderAll();
				break;
			}
			case "zoom-in": zoomBy(1.2); break;
			case "zoom-out": zoomBy(1 / 1.2); break;
			case "zoom-100": zoom100(); break;
			case "zoom-fit": zoomFit(); break;
			case "toggle-hops": {
				HOP_STYLE = HOP_STYLE === "hop" ? "plain" : "hop";
				try { localStorage.setItem("schstudio.hopStyle", HOP_STYLE); } catch (_) { }
				updateHopMenuLabel();
				render();
				toast(HOP_STYLE === "hop" ? "จุดตัดสาย: สะพานข้าม (hop)" : "จุดตัดสาย: เรียบ (แบบ ISE)", "ok");
				break;
			}
			case "show-hint": {
				try { localStorage.removeItem(HINT_KEY); } catch (_) { }
				$("#canvasHint").style.display = "";
				break;
			}
			case "copy-vhdl": {
				if (!$("#vhdlOutput").dataset.raw) generateVHDL();   // never copy empty
				const t = $("#vhdlOutput").dataset.raw || "";
				if (!t) { toast("ยังไม่มีโค้ดให้คัดลอก", "warn"); break; }
				navigator.clipboard.writeText(t).then(() => toast("คัดลอกแล้ว", "ok"));
				break;
			}
			case "download-vhdl": exportVhdlFile(); break;
		}
	});
}

const HINT_KEY = "schstudio.hintDismissed";
try { if (localStorage.getItem(HINT_KEY) === "1") $("#canvasHint").style.display = "none"; } catch (_) { }
$("#hintClose").addEventListener("click", () => {
	$("#canvasHint").style.display = "none";
	try { localStorage.setItem(HINT_KEY, "1"); } catch (_) { }
});

$("#projectName").addEventListener("change", ev => {
	state.project.name = sanId(ev.target.value);
});
