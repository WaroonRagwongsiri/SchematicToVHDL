"use strict";

/* =========================================================================
   CUSTOM COMPONENT WIZARD  (schematic-based)
   - User picks a source schematic in the project.
   - The schematic's IN/OUT ports become the component's ports.
   - A deep-copy of the schematic is stored inside the custom, so it is
	 self-contained and can be exported/imported as a JSON file.
   ========================================================================= */
function openWizard(editName) {
	const isEdit = !!editName;
	const editing = isEdit ? state.project.customs[editName] : null;
	const initialSourceId = isEdit ? null : state.activeId;

	const schematics = Object.values(state.project.schematics);
	if (schematics.length === 0) { toast("ต้องมี schematic อย่างน้อย 1 อันก่อน", "warn"); return; }

	const m = document.createElement("div");
	m.className = "modal-bg";
	const schOptions = schematics.map(s =>
		`<option value="${s.id}" ${s.id === initialSourceId ? "selected" : ""}>${esc(s.name)}</option>`
	).join("");

	m.innerHTML = `
    <div class="modal">
      <h2>🧙 Custom Component Wizard ${isEdit ? `<span style="color:var(--muted);font-weight:400;font-size:12px;margin-left:6px">— editing "${esc(editName)}"</span>` : ""}
        <button class="close">×</button></h2>
      <div class="modal-body">
        <div style="background:#1a2a4a;border:1px solid var(--accent);border-radius:8px;padding:10px 12px;margin-bottom:14px;color:var(--ink-dim);font-size:12px;line-height:1.6">
          💡 <b style="color:var(--ink)">Custom Component สร้างจาก schematic</b> — เลือก schematic ที่จะแปลงเป็น reusable block. ระบบจะคัดลอกข้อมูลทั้งหมด (components + wires + I/O ports) เก็บไว้ใน custom component เพื่อให้สามารถ export/import แชร์ข้ามโปรเจคได้
        </div>
        ${isEdit ? "" : `
          <div class="row">
            <label>Source schematic</label>
            <select id="wSource">${schOptions}</select>
          </div>
        `}
        <div class="row">
          <label>Component name</label>
          <input id="wName" value="${esc(editing ? editing.name : "")}" placeholder="my_block">
        </div>
        <div class="row">
          <label>Description</label>
          <input id="wDesc" value="${esc(editing ? editing.description || "" : "")}" placeholder="(optional)">
        </div>
        <div style="margin:14px 0 6px;font-size:11px;color:var(--ink-dim);letter-spacing:1px;font-weight:600">DERIVED PORTS (จาก IN/OUT ใน schematic)</div>
        <div id="wPortPreview" style="background:var(--bg-2);border:1px solid var(--line);border-radius:6px;padding:10px 12px;max-height:200px;overflow:auto;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.8"></div>
        ${isEdit ? `<div style="margin-top:12px;padding:8px 10px;background:var(--bg-2);border-left:3px solid var(--warn);border-radius:4px;font-size:11.5px;color:var(--ink-dim)">⚠ โหมดแก้ไข: เปลี่ยนได้เฉพาะชื่อและคำอธิบาย — หากต้องการแก้วงจรข้างใน ให้ลบ component นี้แล้วสร้างใหม่จาก schematic</div>` : ""}
      </div>
      <div class="modal-foot">
        <button class="btn" id="wCancel">Cancel</button>
        <button class="btn btn-primary" id="wSave">${isEdit ? "Save Changes" : "Create Component"}</button>
      </div>
    </div>`;
	document.body.appendChild(m);

	function selectedSch() {
		if (isEdit) return editing.schematic ? { components: editing.schematic.components, wires: editing.schematic.wires, name: editing.name } : null;
		const sid = m.querySelector("#wSource").value;
		return state.project.schematics[sid];
	}
	function updatePreview() {
		const sch = selectedSch();
		const root = m.querySelector("#wPortPreview");
		if (!sch) { root.innerHTML = '<span style="color:var(--muted)">— ไม่มี schematic —</span>'; return; }
		const ins = (sch.components || []).filter(c => c.type === "IN");
		const outs = (sch.components || []).filter(c => c.type === "OUT");
		if (ins.length + outs.length === 0) {
			root.innerHTML = '<span style="color:var(--warn)">⚠ ไม่มี INPUT/OUTPUT pin ใน schematic นี้ — ต้องเพิ่มก่อน</span>';
			return;
		}
		let html = "";
		ins.forEach(c => {
			const w = c.params.width || 1;
			const t = w > 1 ? `std_logic_vector(${w - 1} downto 0)` : "std_logic";
			html += `<div><span style="color:var(--in-stroke)">▸ in </span><span style="color:var(--ink)">${esc(c.params.name)}</span> <span style="color:var(--muted)">: ${t}</span></div>`;
		});
		outs.forEach(c => {
			const w = c.params.width || 1;
			const t = w > 1 ? `std_logic_vector(${w - 1} downto 0)` : "std_logic";
			html += `<div><span style="color:var(--out-stroke)">◂ out</span> <span style="color:var(--ink)">${esc(c.params.name)}</span> <span style="color:var(--muted)">: ${t}</span></div>`;
		});
		root.innerHTML = html;
		// auto-fill name
		const nameInp = m.querySelector("#wName");
		if (!isEdit && !nameInp.value) nameInp.value = sch.name + "_blk";
	}
	updatePreview();
	const srcSel = m.querySelector("#wSource");
	if (srcSel) srcSel.onchange = updatePreview;

	m.querySelector(".close").onclick = () => m.remove();
	m.querySelector("#wCancel").onclick = () => m.remove();
	m.querySelector("#wSave").onclick = () => {
		const name = sanId(m.querySelector("#wName").value);
		if (!name) { toast("ต้องมีชื่อ", "err"); return; }
		const desc = m.querySelector("#wDesc").value;
		if (isEdit) {
			// rename if changed
			if (editName !== name) {
				if (state.project.customs[name]) { toast(`มีชื่อ "${name}" อยู่แล้ว`, "err"); return; }
				delete state.project.customs[editName];
				// keep every placed instance pointing at the new name
				rewriteInstanceType("CUSTOM:" + editName, "CUSTOM:" + name);
			}
			editing.name = name;
			editing.description = desc;
			state.project.customs[name] = editing;
		} else {
			if (state.project.customs[name]) { toast(`มีชื่อ "${name}" อยู่แล้ว`, "err"); return; }
			const sch = selectedSch();
			const ins = (sch.components || []).filter(c => c.type === "IN");
			const outs = (sch.components || []).filter(c => c.type === "OUT");
			if (ins.length + outs.length === 0) {
				if (!confirm("Schematic นี้ไม่มี I/O port — สร้างต่อ?")) return;
			}
			state.project.customs[name] = {
				name,
				description: desc,
				sourceSchematicId: sch.id,
				schematic: {
					components: JSON.parse(JSON.stringify(sch.components || [])),
					wires: JSON.parse(JSON.stringify(sch.wires || []))
				}
			};
		}
		snapshot(); renderAll();
		toast(`${isEdit ? "Updated" : "Created"} custom component "${name}"`, "ok");
		m.remove();
	};
}

/* =========================================================================
   EXPORT / IMPORT CUSTOM COMPONENTS  (JSON files)
   ========================================================================= */
function collectCustomDeps(cc, acc = new Set()) {
	if (!cc || !cc.schematic) return acc;
	cc.schematic.components.forEach(c => {
		if (c.type && c.type.startsWith("CUSTOM:")) {
			const n = c.type.slice(7);
			if (!acc.has(n) && state.project.customs[n]) {
				acc.add(n);
				collectCustomDeps(state.project.customs[n], acc);
			}
		}
	});
	return acc;
}
function exportCustomComponent(name) {
	const cc = state.project.customs[name];
	if (!cc) { toast("ไม่พบ component", "err"); return; }
	const deps = collectCustomDeps(cc);
	const pkg = {
		type: "schstudio-custom-pkg",
		version: 1,
		root: name,
		customs: { [name]: cc }
	};
	deps.forEach(n => { if (state.project.customs[n]) pkg.customs[n] = state.project.customs[n]; });
	const data = JSON.stringify(pkg, null, 2);
	const b = new Blob([data], { type: "application/json" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u;
	a.download = sanId(name) + ".sccomp.json";
	a.click();
	URL.revokeObjectURL(u);
	toast(`Exported "${name}"${deps.size ? ` (+ ${deps.size} dependencies)` : ""}`, "ok");
}
function importCustomComponent() {
	const inp = document.createElement("input");
	inp.type = "file";
	inp.accept = ".json,application/json";
	inp.multiple = true;
	inp.onchange = e => {
		const files = Array.from(e.target.files || []);
		let okCount = 0;
		let pending = files.length;
		if (pending === 0) return;
		files.forEach(f => {
			const r = new FileReader();
			r.onload = () => {
				try {
					const o = JSON.parse(r.result);
					// package format
					if (o.type === "schstudio-custom-pkg" && o.customs) {
						const renames = new Map();          // original name → imported name
						const imported = [];
						Object.values(o.customs).forEach(cc => {
							let nm = cc.name, k = 1;
							while (state.project.customs[nm]) nm = cc.name + "_" + (k++);
							if (nm !== cc.name) renames.set(cc.name, nm);
							cc.name = nm;
							state.project.customs[nm] = cc;
							imported.push(cc);
							okCount++;
						});
						// fix nested CUSTOM: references that pointed at the original names
						if (renames.size) imported.forEach(cc => {
							if (!cc.schematic) return;
							(cc.schematic.components || []).forEach(c => {
								if (c.type && c.type.startsWith("CUSTOM:")) {
									const dep = c.type.slice(7);
									if (renames.has(dep)) c.type = "CUSTOM:" + renames.get(dep);
								}
							});
						});
					}
					// single-component format (legacy)
					else if (o.type === "schstudio-custom" && o.custom) {
						const cc = o.custom;
						let nm = cc.name, k = 1;
						while (state.project.customs[nm]) nm = cc.name + "_" + (k++);
						cc.name = nm;
						state.project.customs[nm] = cc;
						okCount++;
					} else {
						toast(`${f.name}: ไม่ใช่ component file`, "err");
					}
				} catch (err) {
					toast(`${f.name}: parse error`, "err");
				}
				if (--pending === 0) {
					if (okCount) {
						reseedUid();
						snapshot(); renderAll();
						toast(`นำเข้า ${okCount} component แล้ว`, "ok");
					}
				}
			};
			r.readAsText(f);
		});
	};
	inp.click();
}
function exportActiveAsCustom() {
	const sch = activeSch();
	if (!sch) { toast("ไม่มี schematic", "err"); return; }
	const ins = sch.components.filter(c => c.type === "IN");
	const outs = sch.components.filter(c => c.type === "OUT");
	if (ins.length + outs.length === 0) {
		if (!confirm("Schematic นี้ไม่มี I/O port — export ต่อ?")) return;
	}
	const cc = {
		name: sch.name,
		description: "Exported from schematic",
		schematic: {
			components: JSON.parse(JSON.stringify(sch.components)),
			wires: JSON.parse(JSON.stringify(sch.wires))
		}
	};
	const pkg = {
		type: "schstudio-custom-pkg", version: 1, root: cc.name,
		customs: { [cc.name]: cc }
	};
	const b = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u; a.download = sanId(cc.name) + ".sccomp.json"; a.click();
	URL.revokeObjectURL(u);
	toast(`Exported "${cc.name}" as component file`, "ok");
}
