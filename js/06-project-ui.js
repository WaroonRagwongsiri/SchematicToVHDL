"use strict";

/* =========================================================================
   PROJECT TREE (left pane "Project")
   ========================================================================= */
function renderProjectTree() {
	const root = $("#projectPane");
	const p = state.project;
	const html = [];
	html.push(`<div class="tree">`);

	/* THE TREE. One list, like a file explorer: a project is a folder, its schematics
	   are the files inside it, and any number of folders can stand open at once — which
	   is the whole point of having several projects. `expanded` lives on the project so
	   the shape of the tree survives a save and a switch. */
	html.push(`<div class="tree-group"><h4>PROJECTS
    <button class="add" title="โปรเจกต์ใหม่" data-act="new-project">+</button></h4>`);
	Object.keys(state.projects).forEach(pid => {
		const pr = state.projects[pid];
		const on = pid === state.activeProjectId;
		const sheets = orderedSchIds(pr);
		const open = pr.expanded !== false && (pr.expanded === true || on);   // the active one starts open
		html.push(`<div class="tree-item prj ${on ? "active" : ""}" data-open-prj="${pid}">
      <span class="tw" data-tw-prj="${pid}">${open ? "▾" : "▸"}</span>
      <span class="ico">\u{1F4C1}</span>
      <span class="label">${esc(pr.name || "project")}</span>
      <span class="cnt">${sheets.length}</span>
      <span class="acts">
        <button title="schematic ใหม่ในโปรเจกต์นี้" data-add-sch="${pid}">＋</button>
        <button title="แยก schematic ออกจากโปรเจกต์นี้" data-split-prj="${pid}">✂</button>
        <button title="เปลี่ยนชื่อ" data-rename-prj="${pid}">✎</button>
        <button title="ลบโปรเจกต์" data-del-prj="${pid}">✕</button>
      </span>
    </div>`);
		if (!open) return;
		if (!sheets.length) {
			html.push(`<div class="tree-empty">— ยังไม่มี schematic —</div>`);
			return;
		}
		html.push(`<div class="sch-group" data-sch-group="${pid}">`);
		sheets.forEach(id => {
			const sch = pr.schematics[id];
			if (!sch) return;
			const isTop = id === pr.topId;
			const isActive = on && id === state.activeId;
			html.push(`<div class="tree-item sch ${isActive ? "active" : ""} ${isTop ? "top" : ""}" data-open="${id}" data-prj="${pid}" draggable="true" data-sch-reorder="${id}">
        <span class="drag-handle" title="ลากเพื่อเรียงลำดับ">⋮⋮</span>
        <span class="star">★</span>
        <span class="ico">◆</span>
        <span class="label">${esc(sch.name)}</span>
        <span class="acts">
          <button title="Set as top" data-settop="${id}" data-prj="${pid}">★</button>
          <button title="แยกแผ่นนี้ออกเป็นโปรเจกต์ใหม่" data-split-sch="${id}" data-prj="${pid}">✂</button>
          <button title="Rename" data-rename-sch="${id}" data-prj="${pid}">✎</button>
          <button title="Delete" data-del-sch="${id}" data-prj="${pid}">✕</button>
        </span>
      </div>`);
		});
		html.push(`</div>`);
	});
	html.push(`</div>`);

	// Import VHDL → schematic  (replaces the old custom-component feature)
	html.push(`<div class="tree-group"><h4>IMPORT VHDL
    <button class="add" title="เปิดไฟล์ .vhd แล้ววาดเป็นวงจร" data-act="import-vhdl">↓</button></h4>`);
	html.push(`<div style="padding:6px 10px;color:var(--muted);font-size:11px;line-height:1.6">
    เปิดไฟล์ <b style="color:var(--ink-dim)">.vhd</b> → แปลงเป็น schematic อัตโนมัติ (วาดเกต + สาย)<br>
    <span style="font-size:10.5px">รองรับ combinational (and/or/not/xor…), <b>process→D-FF</b>, <b>when/else→MUX</b></span></div>`);
	html.push(`</div>`);

	// Sub-schematics (other schematics in the ACTIVE project as hierarchy blocks)
	html.push(`<div class="tree-group"><h4>USE AS SUB-BLOCK</h4>`);
	const others = orderedSchIds().filter(id => id !== state.activeId);
	if (others.length === 0) {
		html.push(`<div style="padding:6px 10px;color:var(--muted);font-size:11px">— ไม่มี schematic อื่น —</div>`);
	} else {
		others.forEach(id => {
			const sch = p.schematics[id];
			const why = subBlockBlockedWhy(id, state.activeId);
			if (why) {
				// still listed, but plainly out of reach and saying why — a silently missing
				// sheet just reads as a bug to whoever went looking for it
				html.push(`<div class="tree-item" style="opacity:.42;cursor:not-allowed" title="${esc(why)}">
          <span class="star"></span>
          <span class="ico">🔒</span>
          <span class="label">${esc(sch.name)}</span>
        </div>`);
			} else {
				html.push(`<div class="tree-item" draggable="true" data-pal="SCH:${id}">
          <span class="star"></span>
          <span class="ico" style="color:#5dd5ff">▣</span>
          <span class="label">${esc(sch.name)}</span>
        </div>`);
			}
		});
	}
	html.push(`</div>`);
	html.push(`</div>`);

	root.innerHTML = html.join("");

	// wire up
	/* a row acts on ITS OWN project, which may not be the one that is open */
	const rowPrj = el => state.projects[el.dataset.prj] || state.project;
	const useProject = pid => { if (pid && pid !== state.activeProjectId) switchProject(pid); };

	root.querySelectorAll("[data-open]").forEach(e => e.addEventListener("click", ev => {
		if (ev.target.closest(".acts")) return;
		useProject(e.dataset.prj);            // opening a sheet opens its project first
		openSchTab(e.dataset.open);
	}));
	root.querySelectorAll("[data-tw-prj]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();                 // the twisty folds; the row opens
		const pr = state.projects[e.dataset.twPrj];
		if (!pr) return;
		const on = e.dataset.twPrj === state.activeProjectId;
		pr.expanded = !(pr.expanded !== false && (pr.expanded === true || on));
		renderProjectTree();
	}));
	root.querySelectorAll("[data-add-sch]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		const pid = e.dataset.addSch, pr = state.projects[pid];
		if (!pr) return;
		const nm = prompt("ชื่อ schematic ใหม่:", "sch_" + (Object.keys(pr.schematics).length + 1));
		if (!nm) return;
		const id = uid("sch");
		pr.schematics[id] = blankSchematic(id, uniqueSchName(nm, id, pr));
		if (!pr.schOrder) pr.schOrder = [];
		pr.schOrder.push(id);
		if (!pr.topId) pr.topId = id;
		pr.expanded = true;
		if (pid === state.activeProjectId) openSchTab(id); else { snapshot(); renderAll(); }
	}));
	root.querySelectorAll("[data-open-prj]").forEach(e => e.addEventListener("click", ev => {
		if (ev.target.closest(".acts") || ev.target.closest(".tw")) return;
		switchProject(e.dataset.openPrj);
	}));
	root.querySelectorAll("[data-split-prj]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();                     // the row itself opens the project
		openSplitDialog(null, e.dataset.splitPrj);
	}));
	root.querySelectorAll("[data-rename-prj]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		const pid = e.dataset.renamePrj;
		const nm = prompt("เปลี่ยนชื่อโปรเจกต์:", state.projects[pid].name);
		if (nm) renameProjectById(pid, nm);
	}));
	root.querySelectorAll("[data-del-prj]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		deleteProjectById(e.dataset.delPrj);
	}));
	root.querySelectorAll("[data-settop]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		const pr = rowPrj(e);
		pr.topId = e.dataset.settop;
		snapshot(); renderAll();
		toast(`ตั้งเป็น top entity ของ "${pr.name}": ` + pr.schematics[pr.topId].name, "ok");
	}));
	root.querySelectorAll("[data-split-sch]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();                       // the row itself opens the sheet
		openSplitDialog(e.dataset.splitSch, e.dataset.prj);
	}));
	root.querySelectorAll("[data-rename-sch]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		const id = e.dataset.renameSch;
		const pr = rowPrj(e);
		const sch = pr.schematics[id];
		const nm = prompt("เปลี่ยนชื่อ schematic:", sch.name);
		if (nm) { sch.name = uniqueSchName(nm, id, pr); snapshot(); renderAll(); }
	}));
	root.querySelectorAll("[data-del-sch]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		const id = e.dataset.delSch;
		const prDel = rowPrj(e);
		if (prDel !== state.project) switchProject(prDel.id);   // delete where you can see it
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
		// heal BEFORE the snapshot: removeInstancesOf leaves dots that no longer join
		// anything, and without this they survived into history and then blinked out on
		// the next empty-canvas click — a change the user could not undo
		Object.values(state.project.schematics).forEach(s => healJunctions(s));
		pruneDeadPinWires();
		snapshot(); renderAll();
		autoFitSheet();
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
		Object.values(state.project.schematics).forEach(s => healJunctions(s));   // same as del-sch
		pruneDeadPinWires();
		snapshot(); renderAll();
	}));
	root.querySelectorAll("[data-pal]").forEach(e => {
		e.addEventListener("dragstart", ev => {
			state.dragType = e.dataset.pal;
			// Firefox aborts drags with an empty data store
			try { ev.dataTransfer.setData("text/plain", e.dataset.pal); ev.dataTransfer.effectAllowed = "copy"; } catch (_) { }
		});
	});

	// --- Schematic reorder drag-and-drop (per project group) ---
	root.querySelectorAll("[data-sch-group]").forEach(schGroup => {
		const pid = schGroup.dataset.schGroup;
		const pr = state.projects[pid];
		if (!pr) return;
		let dragSchId = null;

		schGroup.querySelectorAll("[data-sch-reorder]").forEach(e => {
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

				const order = orderedSchIds(pr);
				const fromIdx = order.indexOf(fromId);
				if (fromIdx < 0) return;

				order.splice(fromIdx, 1);
				const rect = e.getBoundingClientRect();
				const mid = rect.top + rect.height / 2;
				const insertIdx = ev.clientY < mid ? order.indexOf(toId) : order.indexOf(toId) + 1;
				order.splice(insertIdx, 0, fromId);

				pr.schOrder = order;
				snapshot(); renderProjectTree();
			});
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
		["cmp", "COMPARATOR"],
		["ff", "FLIP-FLOPS"],
		["bus", "BUS TAP"],
		["misc", "TEMP BLOCK"],
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
			addComp(e.dataset.pal, cx - 40 + Math.random() * 30, cy - 30 + Math.random() * 30);
		});
	});
}

/* =========================================================================
   SCH TABS
   ========================================================================= */
function openSchTab(id) {
	if (!state.project.schematics[id]) return;
	const switched = state.activeId !== id;
	state.activeId = id;
	if (!state.openTabs.includes(id)) state.openTabs.push(id);
	state.selection.clear();
	state.pendingWire = null;
	renderAll();
	if (switched) { try { autoFitSheet(); } catch (_) { } }
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
function closeAllTabs() {
	state.openTabs = [];
	state.activeId = Object.keys(state.project.schematics)[0] || null;
	if (state.activeId) state.openTabs.push(state.activeId);
	state.selection.clear();
	state.pendingWire = null;
	renderAll();
}
function showTabContextMenu(ev, id) {
	ev.preventDefault();
	const existing = document.querySelector(".ctx-menu");
	if (existing) existing.remove();

	const menu = document.createElement("div");
	menu.className = "dd ctx-menu";
	menu.style.left = ev.clientX + "px";
	menu.style.top = ev.clientY + "px";
	menu.innerHTML = `
    <button data-ctx="close">✕ Close Tab</button>
    <hr>
    <button data-ctx="close-all">⛔ Close All Tabs</button>
  `;
	document.body.appendChild(menu);

	function closeMenu() {
		menu.remove();
		document.removeEventListener("click", closeMenu);
		document.removeEventListener("contextmenu", onOtherContextMenu);
		document.removeEventListener("keydown", onKeyDown);
	}
	function onOtherContextMenu(e2) {
		if (e2 === ev) return;
		closeMenu();
	}
	function onKeyDown(e2) {
		if (e2.key === "Escape") closeMenu();
	}

	menu.querySelector('[data-ctx="close"]').addEventListener("click", () => {
		closeMenu();
		closeSchTab(id);
	});
	menu.querySelector('[data-ctx="close-all"]').addEventListener("click", () => {
		closeMenu();
		closeAllTabs();
	});

	setTimeout(() => {
		document.addEventListener("click", closeMenu);
		document.addEventListener("contextmenu", onOtherContextMenu);
		document.addEventListener("keydown", onKeyDown);
	}, 0);
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
	root.querySelectorAll("[data-tab]").forEach(e => e.addEventListener("contextmenu", ev => showTabContextMenu(ev, e.dataset.tab)));
}

/* =========================================================================
   SPLIT A PROJECT (dialog)
   ========================================================================= */
/* Pick the sheets, see what comes with them, then save them out. */
function openSplitDialog(startId, srcPid) {
	const P = (srcPid && state.projects[srcPid]) || state.project;
	const from = P.id || state.activeProjectId;
	const all = Object.values(P.schematics);
	if (all.length < 2) { toast(`"${P.name}" มี schematic เดียว — ยังไม่มีอะไรให้แยก`, "warn"); return; }
	const m = document.createElement("div");
	m.className = "modal-bg";
	const rows = all.map(s => `
    <label class="split-row">
      <input type="checkbox" value="${s.id}" ${s.id === (startId || (P === state.project ? state.activeId : null)) ? "checked" : ""}>
      <span class="nm">${esc(s.name)}</span>
      ${s.id === P.topId ? `<span class="tag">top</span>` : ""}
      <span class="cnt">${(s.components || []).length} ชิ้น</span>
    </label>`).join("");
	m.innerHTML = `
    <div class="modal">
      <h2>✂ แยก schematic จาก "${esc(P.name)}"
        <button class="close">×</button></h2>
      <div class="modal-body">
        <div class="row"><label>ย้ายไปที่</label>
          <select id="spDest">
            <option value="new">➕ โปรเจกต์ใหม่ในแอป</option>
            ${Object.keys(state.projects).filter(id => id !== from)
			.map(id => `<option value="${id}">โปรเจกต์ "${esc(state.projects[id].name)}"</option>`).join("")}
            <option value="file">ดาวน์โหลดเป็นไฟล์ .schproj.json</option>
          </select></div>
        <div class="row" id="spNameRow"><label>ชื่อโปรเจกต์ใหม่</label>
          <input id="spName" value="${esc(sanId(P.name || "project"))}_part" spellcheck="false"></div>
        <div class="row"><label>ทำอะไรกับต้นฉบับ</label>
          <select id="spMode">
            <option value="copy">คัดลอก — เก็บไว้ทั้งสองที่</option>
            <option value="move">ย้ายออก — ลบออกจากโปรเจกต์นี้</option>
          </select></div>
        <div style="margin:14px 0 6px;font-size:11px;color:var(--ink-dim);letter-spacing:1px;font-weight:600">เลือก SCHEMATIC</div>
        <div id="spList" style="background:var(--bg-2);border:1px solid var(--line);border-radius:8px;padding:6px;max-height:34vh;overflow:auto">${rows}</div>
        <div id="spInfo" style="margin-top:12px;font-size:12px;line-height:1.7;color:var(--ink-dim)"></div>
      </div>
      <div class="modal-foot">
        <button class="btn" id="spCancel">ยกเลิก</button>
        <button class="btn btn-primary" id="spGo">แยกออกเป็นไฟล์</button>
      </div>
    </div>`;
	document.body.appendChild(m);
	const picked = () => [...m.querySelectorAll("#spList input:checked")].map(i => i.value);
	const refresh = () => {
		const sel = picked();
		const info = m.querySelector("#spInfo");
		const go = m.querySelector("#spGo");
		if (!sel.length) { info.innerHTML = `<span style="color:var(--warn)">ยังไม่ได้เลือก schematic</span>`; go.disabled = true; return; }
		const closure = [...schClosure(sel, P)];
		const extra = closure.filter(id => !sel.includes(id)).map(id => P.schematics[id].name);
		const moving = m.querySelector("#spMode").value === "move";
		const hurt = moving ? schDependents(closure, P).map(s => s.name) : [];
		const cust = [...customsUsedBy(closure.map(id => P.schematics[id]), P)];
		const dest = m.querySelector("#spDest").value;
		m.querySelector("#spNameRow").style.display = (dest === "new" || dest === "file") ? "" : "none";
		m.querySelector("#spGo").textContent = dest === "file" ? "แยกออกเป็นไฟล์"
			: dest === "new" ? "แยกเป็นโปรเจกต์ใหม่" : "ย้ายไปโปรเจกต์นี้";
		const where = dest === "file" ? "ไฟล์" : dest === "new" ? "โปรเจกต์ใหม่"
			: `โปรเจกต์ "${esc(state.projects[dest].name)}"`;
		let html = `จะแยก <b style="color:var(--ink)">${closure.length}</b> schematic ไปที่${where}`;
		if (extra.length) html += `<br>พ่วงไปด้วยเพราะถูกใช้เป็นบล็อกย่อย: <b style="color:var(--ink)">${esc(extra.join(", "))}</b>`;
		if (cust.length) html += `<br>แนบ custom component: ${esc(cust.join(", "))}`;
		if (hurt.length) {
			html += `<br><span style="color:var(--err)">✖ ย้ายออกไม่ได้ — <b>${esc(hurt.join(", "))}</b> ยังใช้แผ่นที่จะย้ายอยู่ ให้เลือก "คัดลอก" หรือเลือกแผ่นเหล่านั้นด้วย</span>`;
		}
		info.innerHTML = html;
		go.disabled = hurt.length > 0;
	};
	m.querySelectorAll("#spList input").forEach(i => i.addEventListener("change", refresh));
	m.querySelector("#spMode").addEventListener("change", refresh);
	m.querySelector("#spDest").addEventListener("change", refresh);
	const close = () => m.remove();
	m.querySelector(".close").addEventListener("click", close);
	m.querySelector("#spCancel").addEventListener("click", close);
	m.addEventListener("mousedown", ev => { if (ev.target === m) close(); });
	m.querySelector("#spGo").addEventListener("click", () => {
		const r = splitProject(picked(), {
			name: m.querySelector("#spName").value,
			move: m.querySelector("#spMode").value === "move",
			dest: m.querySelector("#spDest").value,
			from,
		});
		if (r) close();
	});
	refresh();
}
