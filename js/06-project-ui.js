"use strict";

/* =========================================================================
   PROJECT TREE (left pane "Project")
   ========================================================================= */
function renderProjectTree() {
	const root = $("#projectPane");
	const p = state.project;
	const html = [];
	html.push(`<div class="tree">`);

	// Schematics (draggable for reorder)
	html.push(`<div class="tree-group"><h4>SCHEMATICS
    <button class="add" title="New schematic" data-act="new-sch">+</button></h4>`);
	const schIds = orderedSchIds();
	for (const id of schIds) {
		const sch = p.schematics[id];
		if (!sch) continue;
		const isTop = id === p.topId;
		const isActive = id === state.activeId;
		html.push(`<div class="tree-item ${isActive ? "active" : ""} ${isTop ? "top" : ""}" data-open="${id}" draggable="true" data-sch-reorder="${id}">
      <span class="drag-handle" title="ลากเพื่อเรียงลำดับ">⋮⋮</span>
      <span class="star">★</span>
      <span class="ico">◆</span>
      <span class="label">${esc(sch.name)}</span>
      <span class="acts">
        <button title="Set as top" data-settop="${id}">★</button>
        <button title="Rename" data-rename-sch="${id}">✎</button>
        <button title="Delete" data-del-sch="${id}">✕</button>
      </span>
    </div>`);
	}
	html.push(`</div>`);

	// Import VHDL → schematic  (replaces the old custom-component feature)
	html.push(`<div class="tree-group"><h4>IMPORT VHDL
    <button class="add" title="เปิดไฟล์ .vhd แล้ววาดเป็นวงจร" data-act="import-vhdl">↓</button></h4>`);
	html.push(`<div style="padding:6px 10px;color:var(--muted);font-size:11px;line-height:1.6">
    เปิดไฟล์ <b style="color:var(--ink-dim)">.vhd</b> → แปลงเป็น schematic อัตโนมัติ (วาดเกต + สาย)<br>
    <span style="font-size:10.5px">รองรับ combinational (and/or/not/xor…), <b>process→D-FF</b>, <b>when/else→MUX</b></span></div>`);
	html.push(`</div>`);

	// Sub-schematics (other schematics in project as hierarchy blocks)
	html.push(`<div class="tree-group"><h4>USE AS SUB-BLOCK</h4>`);
	const others = Object.keys(p.schematics).filter(id => id !== state.activeId);
	if (others.length === 0) {
		html.push(`<div style="padding:6px 10px;color:var(--muted);font-size:11px">— ไม่มี schematic อื่น —</div>`);
	} else {
		others.forEach(id => {
			const sch = p.schematics[id];
			html.push(`<div class="tree-item" draggable="true" data-pal="SCH:${id}">
        <span class="star"></span>
        <span class="ico" style="color:#5dd5ff">▣</span>
        <span class="label">${esc(sch.name)}</span>
      </div>`);
		});
	}
	html.push(`</div>`);
	html.push(`</div>`);

	root.innerHTML = html.join("");

	// wire up
	root.querySelectorAll("[data-open]").forEach(e => e.addEventListener("click", ev => {
		if (ev.target.closest(".acts")) return;
		const id = e.dataset.open;
		openSchTab(id);
	}));
	root.querySelectorAll("[data-settop]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		state.project.topId = e.dataset.settop;
		snapshot(); renderAll();
		toast("ตั้งเป็น top entity: " + state.project.schematics[state.project.topId].name, "ok");
	}));
	root.querySelectorAll("[data-rename-sch]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		const id = e.dataset.renameSch;
		const sch = state.project.schematics[id];
		const nm = prompt("เปลี่ยนชื่อ schematic:", sch.name);
		if (nm) { sch.name = uniqueSchName(nm, id); snapshot(); renderAll(); }
	}));
	root.querySelectorAll("[data-del-sch]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		const id = e.dataset.delSch;
		if (Object.keys(state.project.schematics).length === 1) { toast("ต้องเหลืออย่างน้อย 1 schematic", "warn"); return; }
		if (!confirm("ลบ schematic นี้?")) return;
		delete state.project.schematics[id];
		if (state.project.schOrder) state.project.schOrder = state.project.schOrder.filter(x => x !== id);
		// remove any placed instances of this schematic used as a sub-block
		const nInst = removeInstancesOf("SCH:" + id);
		if (nInst) toast(`ลบ instance ที่ใช้ schematic นี้ไปด้วย ${nInst} ตัว`, "warn");
		state.openTabs = state.openTabs.filter(t => t !== id);
		if (state.activeId === id) {
			state.activeId = state.openTabs[0] || Object.keys(state.project.schematics)[0];
			state.selection.clear();
			state.pendingWire = null;
		}
		if (!state.openTabs.includes(state.activeId)) state.openTabs.push(state.activeId);
		if (state.project.topId === id) {
			state.project.topId = Object.keys(state.project.schematics)[0];
		}
		snapshot(); renderAll();
	}));
	root.querySelectorAll("[data-edit-custom]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		openWizard(e.dataset.editCustom);
	}));
	root.querySelectorAll("[data-export-custom]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		exportCustomComponent(e.dataset.exportCustom);
	}));
	root.querySelectorAll("[data-del-custom]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		const name = e.dataset.delCustom;
		if (!confirm(`ลบ component "${name}"?`)) return;
		delete state.project.customs[name];
		const nInst = removeInstancesOf("CUSTOM:" + name);
		if (nInst) toast(`ลบ instance ของ "${name}" ไปด้วย ${nInst} ตัว`, "warn");
		snapshot(); renderAll();
	}));
	root.querySelectorAll("[data-pal]").forEach(e => {
		e.addEventListener("dragstart", ev => {
			state.dragType = e.dataset.pal;
			// Firefox aborts drags with an empty data store
			try { ev.dataTransfer.setData("text/plain", e.dataset.pal); ev.dataTransfer.effectAllowed = "copy"; } catch (_) { }
		});
	});

	// --- Schematic reorder drag-and-drop ---
	const schGroup = root.querySelector(".tree-group");
	const schItems = () => schGroup.querySelectorAll("[data-sch-reorder]");
	let dragSchId = null;

	schItems().forEach(e => {
		e.addEventListener("dragstart", ev => {
			dragSchId = e.dataset.schReorder;
			ev.dataTransfer.effectAllowed = "move";
			try { ev.dataTransfer.setData("text/plain", dragSchId); } catch (_) { }
			requestAnimationFrame(() => e.classList.add("sch-dragging"));
		});
		e.addEventListener("dragend", () => {
			dragSchId = null;
			e.classList.remove("sch-dragging");
			schGroup.querySelectorAll(".sch-drop-above, .sch-drop-below").forEach(el => {
				el.classList.remove("sch-drop-above", "sch-drop-below");
			});
		});
		e.addEventListener("dragover", ev => {
			if (!dragSchId || e.dataset.schReorder === dragSchId) return;
			ev.preventDefault();
			ev.dataTransfer.dropEffect = "move";
			const rect = e.getBoundingClientRect();
			const mid = rect.top + rect.height / 2;
			e.classList.remove("sch-drop-above", "sch-drop-below");
			if (ev.clientY < mid) {
				e.classList.add("sch-drop-above");
			} else {
				e.classList.add("sch-drop-below");
			}
		});
		e.addEventListener("dragleave", () => {
			e.classList.remove("sch-drop-above", "sch-drop-below");
		});
		e.addEventListener("drop", ev => {
			ev.preventDefault();
			e.classList.remove("sch-drop-above", "sch-drop-below");
			const fromId = dragSchId;
			const toId = e.dataset.schReorder;
			if (!fromId || fromId === toId) return;

			const order = orderedSchIds();
			const fromIdx = order.indexOf(fromId);
			if (fromIdx < 0) return;

			order.splice(fromIdx, 1);
			const rect = e.getBoundingClientRect();
			const mid = rect.top + rect.height / 2;
			const insertIdx = ev.clientY < mid ? order.indexOf(toId) : order.indexOf(toId) + 1;
			order.splice(insertIdx, 0, fromId);

			if (!state.project.schOrder) state.project.schOrder = [];
			state.project.schOrder = order;
			snapshot(); renderProjectTree();
		});
	});
}

/* =========================================================================
   PALETTE (left pane "Components")
   ========================================================================= */
function renderPalette() {
	const root = $("#palettePane");
	const groups = [
		["io", "I/O PORTS"],
		["gate", "LOGIC GATES"],
		["mux", "MUX / DEMUX"],
		["code", "ENCODER / DECODER"],
		["ff", "FLIP-FLOPS"],
		// BUS DISABLED (commented out): ["bus",  "BUS TOOLS"],
	];
	const html = [`<div class="palette">`];
	for (const [cat, name] of groups) {
		html.push(`<div class="pal-group"><h4>${name}</h4><div class="pal-grid">`);
		for (const t in TYPES) {
			if (TYPES[t].category !== cat) continue;
			const p = TYPES[t].defaultParams || {};
			const sz = TYPES[t].size(p);
			const sc = Math.min(60 / sz.w, 36 / sz.h, 1);
			html.push(`<div class="ptile" draggable="true" data-pal="${t}">
        <svg width="60" height="40" viewBox="0 0 ${sz.w} ${sz.h}" preserveAspectRatio="xMidYMid meet">
          ${TYPES[t].shape(p)}
        </svg>
        <span>${TYPES[t].label}</span>
      </div>`);
		}
		html.push(`</div></div>`);
	}
	html.push(`</div>`);
	root.innerHTML = html.join("");

	root.querySelectorAll(".ptile").forEach(e => {
		e.addEventListener("dragstart", ev => {
			state.dragType = e.dataset.pal;
			try { ev.dataTransfer.setData("text/plain", e.dataset.pal); ev.dataTransfer.effectAllowed = "copy"; } catch (_) { }
		});
		e.addEventListener("click", ev => {
			// place at the centre of the current view (not a fixed corner)
			const r = canvas.getBoundingClientRect();
			const cx = (r.width / 2 - state.view.x) / state.view.k;
			const cy = (r.height / 2 - state.view.y) / state.view.k;
			const id = addComp(e.dataset.pal, cx - 40 + Math.random() * 30, cy - 30 + Math.random() * 30);
			const nc = id && comp(id);
			if (nc && busInPin(nc)) attachBusPinToWire(nc);
		});
	});
}

/* =========================================================================
   SCH TABS
   ========================================================================= */
function openSchTab(id) {
	if (!state.project.schematics[id]) return;
	state.activeId = id;
	if (!state.openTabs.includes(id)) state.openTabs.push(id);
	state.selection.clear();
	state.pendingWire = null;
	renderAll();
}
function closeSchTab(id) {
	state.openTabs = state.openTabs.filter(t => t !== id);
	if (state.activeId === id) {
		state.activeId = state.openTabs[state.openTabs.length - 1] || Object.keys(state.project.schematics)[0];
		if (!state.openTabs.length) state.openTabs.push(state.activeId);
		state.selection.clear();
		state.pendingWire = null;
	}
	renderAll();
}
function renderSchTabs() {
	const root = $("#schTabs");
	const html = [];
	state.openTabs.forEach(id => {
		const sch = state.project.schematics[id]; if (!sch) return;
		const isTop = id === state.project.topId;
		const isA = id === state.activeId;
		html.push(`<button class="sch-tab ${isA ? "active" : ""} ${isTop ? "top" : ""}" data-tab="${id}">
      ${esc(sch.name)}
      <span class="close" data-close="${id}">✕</span>
    </button>`);
	});
	html.push(`<button class="sch-newbtn" data-act="new-sch" title="New schematic">＋</button>`);
	root.innerHTML = html.join("");
	root.querySelectorAll("[data-tab]").forEach(e => e.addEventListener("click", ev => {
		if (ev.target.dataset.close) return;
		openSchTab(e.dataset.tab);
	}));
	root.querySelectorAll("[data-close]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		closeSchTab(e.dataset.close);
	}));
}
