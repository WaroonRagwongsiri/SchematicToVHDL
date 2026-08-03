"use strict";

/* =========================================================================
   INSPECTOR PANEL
   ========================================================================= */
function openInspectorFor(c) {
	state.selection = new Set([c.id]);
	// also switch to inspector tab
	setRightTab("inspector");
	render(); renderInspector();
}
function renderInspector() {
	const root = $("#inspectorPane");
	const sch = activeSch();
	if (!sch) { root.innerHTML = ""; return; }

	if (state.selection.size === 0) {
		root.innerHTML = `<div class="insp">
      <h3>Schematic Properties</h3>
      <div class="row"><label>Name</label><input id="iSchName" value="${esc(sch.name)}"></div>
      <div class="row"><label>Top entity</label>
        <select id="iTopSel">
          ${Object.keys(state.project.schematics).map(id =>
			`<option value="${id}" ${id === state.project.topId ? "selected" : ""}>${esc(state.project.schematics[id].name)}</option>`
		).join("")}
        </select>
      </div>
      <div class="empty">เลือก component หรือ wire เพื่อปรับ properties</div>
    </div>`;
		$("#iSchName").addEventListener("change", ev => {
			sch.name = uniqueSchName(ev.target.value, sch.id); snapshot(); renderAll();
		});
		$("#iTopSel").addEventListener("change", ev => {
			state.project.topId = ev.target.value; snapshot(); renderAll();
			toast("ตั้งเป็น top entity: " + state.project.schematics[ev.target.value].name, "ok");
		});
		return;
	}

	// single component
	if (state.selection.size === 1) {
		const id = Array.from(state.selection)[0];
		const c = comp(id);
		if (c && c.type === "JUNCTION" && c.params && c.params.busWidth) {
			// bus label (definition node) — edit its name; width is editable only
			// when the net has NO source (otherwise it's inherited from the driver)
			const driven = sch.wires.some(x => x.to.cid === c.id);
			const jw = sch.wires.find(x => x.from.cid === c.id || x.to.cid === c.id);
			const eff = jw ? netWidth(jw, sch) : c.params.busWidth;
			const widthRow = driven
				? `<div class="row"><label>ความกว้าง (bit)</label><span style="color:var(--muted)">${eff} bit (จาก source)</span></div>`
				: `<div class="row"><label>ความกว้าง (bit)</label><input type="number" id="iBusW" min="2" max="64" value="${c.params.busWidth}"></div>`;
			// bit map of the net: which bits are already tapped
			const used = jw ? tappedBitsOnNet(jw, sch) : new Set();
			const chips = Array.from({ length: eff }, (_, b) =>
				`<span style="display:inline-block;min-width:16px;text-align:center;margin:1px;padding:1px 2px;border-radius:3px;font-size:10px;font-family:monospace;${used.has(b) ? "background:var(--wire-bus);color:#000" : "background:var(--bg-1);color:var(--muted)"}">${b}</span>`
			).reverse().join("");
			root.innerHTML = `<div class="insp">
        <h3>ป้ายชื่อบัส <span style="color:var(--wire-bus)">(${eff - 1}:0)</span></h3>
        <div class="row"><label>Position</label>
          <span><input style="width:62px" id="iX" value="${c.x}"> <input style="width:62px" id="iY" value="${c.y}"></span></div>
        <div class="row"><label>ชื่อบัส</label><input id="iBusName" value="${esc(c.params.busName || "bus")}"></div>
        ${widthRow}
        <div class="row"><label>บิตที่ดึงแล้ว</label><span>${chips}</span></div>
        <div class="row"><label></label><button class="btn" id="iBusTapNext" ${jw && eff > 1 ? "" : "disabled"}>▷ ดึงบิตถัดไป (Bus Tap)</button></div>
        <div class="row"><label></label><button class="btn" data-act="delete-sel">🗑 Delete</button></div>
        <div style="padding:4px 2px;font-size:11px;color:var(--muted)">${driven ? "บัสนี้มี source แล้ว — คลิกสายด้วยเครื่องมือ ≣ เพื่อดึงบิต" : "บัสลอย (ยังไม่มี source) — ดึงบิตได้เลย แล้วค่อยต่อ source ทีหลัง"}</div>
      </div>`;
			$("#iX").addEventListener("change", ev => { c.x = snap(+ev.target.value || 0); snapshot(); render(); renderInspector(); });
			$("#iY").addEventListener("change", ev => { c.y = snap(+ev.target.value || 0); snapshot(); render(); renderInspector(); });
			$("#iBusName").addEventListener("change", ev => {
				let v = sanId(ev.target.value) || "bus";
				const used2 = new Set(sch.components
					.filter(x => x.type === "JUNCTION" && x.id !== c.id && x.params && x.params.busName)
					.map(x => sanId(x.params.busName)));
				const base = v; let k = 1; while (used2.has(v)) v = base + "_" + (k++);
				if (v !== base) toast(`ชื่อ '${base}' ถูกใช้แล้ว → เปลี่ยนเป็น '${v}'`, "warn");
				c.params.busName = v; snapshot(); render(); renderInspector();
			});
			if ($("#iBusW")) $("#iBusW").addEventListener("change", ev => {
				const nv = clamp(Math.round(+ev.target.value) || 8, 2, 64);
				c.params.busWidth = nv; snapshot(); render(); renderInspector();
			});
			if ($("#iBusTapNext")) $("#iBusTapNext").addEventListener("click", () => {
				if (!jw) return;
				// stamp at the midpoint of the attached wire segment
				const a = comp(jw.from.cid, sch), b = comp(jw.to.cid, sch);
				const p1 = a && portPos(a, jw.from.pid), p2 = b && portPos(b, jw.to.pid);
				if (!p1 || !p2) return;
				const sel = new Set(state.selection);
				if (stampTapOnWire(jw, { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 })) {
					state.selection = sel;   // keep the label selected so the panel refreshes
					render(); renderInspector();
				}
			});
			return;
		}
		if (c && c.type === "BUSTAP") {
			// dedicated Bus Tap panel: live context of the tapped bus + clamped bits
			const dw = sch.wires.find(x => x.to.cid === c.id && x.to.pid === "d");
			const sw = dw ? netWidth(dw, sch) : 0;              // attached bus width (0 = detached)
			const hi = Math.max(c.params.hi ?? 0, c.params.lo ?? 0);
			const lo = Math.min(c.params.hi ?? 0, c.params.lo ?? 0);
			const outOfRange = sw > 1 && hi > sw - 1;
			const srcTxt = sw > 1 ? `บัสกว้าง ${sw} bit (${sw - 1}:0)` : (dw ? "สายที่เกาะไม่ใช่บัส!" : "ยังไม่ได้เกาะบัส!");
			const slice = hi === lo ? `(${hi})` : `(${hi}:${lo})`;
			const dirOpt = d => `<option value="${d}" ${(c.params.dir || "right") === d ? "selected" : ""}>${d}</option>`;
			root.innerHTML = `<div class="insp">
        <h3>Bus Tap <span style="color:${outOfRange || sw <= 1 ? "var(--err,#f66)" : "var(--wire-bus)"}">${slice}</span></h3>
        <div class="row"><label>Position</label>
          <span><input style="width:62px" id="iX" value="${c.x}"> <input style="width:62px" id="iY" value="${c.y}"></span></div>
        <div class="row"><label>ต้นทาง</label><span style="color:${sw > 1 ? "var(--muted)" : "var(--err,#f66)"}">${srcTxt}</span></div>
        <div class="row"><label>บิตบน (hi)</label><input type="number" id="iTapHi" min="0" max="${sw > 1 ? sw - 1 : 63}" value="${c.params.hi ?? 0}"></div>
        <div class="row"><label>บิตล่าง (lo)</label><input type="number" id="iTapLo" min="0" max="${sw > 1 ? sw - 1 : 63}" value="${c.params.lo ?? 0}"></div>
        <div class="row"><label>ทิศทาง</label><select id="iTapDir">${["right", "down", "left", "up"].map(dirOpt).join("")}</select></div>
        <div class="row"><label>ผลลัพธ์</label><span style="font-family:monospace;color:${outOfRange ? "var(--err,#f66)" : "var(--wire-bus)"}">y ⇐ บัส${slice}${outOfRange ? ` — เกินช่วง (${sw - 1}:0)!` : ""}</span></div>
        <div class="row"><label></label><button class="btn" data-act="delete-sel">🗑 Delete</button></div>
        <div style="padding:4px 2px;font-size:11px;color:var(--muted)">hi = lo → ดึงบิตเดียว · hi > lo → ดึงช่วงเป็นบัสย่อย</div>
      </div>`;
			$("#iX").addEventListener("change", ev => { c.x = snap(+ev.target.value || 0); snapshot(); render(); renderInspector(); });
			$("#iY").addEventListener("change", ev => { c.y = snap(+ev.target.value || 0); snapshot(); render(); renderInspector(); });
			const clampBit = v => clamp(Math.round(+v) || 0, 0, sw > 1 ? sw - 1 : 63);
			$("#iTapHi").addEventListener("change", ev => { c.params.hi = clampBit(ev.target.value); snapshot(); render(); renderInspector(); });
			$("#iTapLo").addEventListener("change", ev => { c.params.lo = clampBit(ev.target.value); snapshot(); render(); renderInspector(); });
			$("#iTapDir").addEventListener("change", ev => {
				// keep the d pin ON its junction when the orientation flips
				const oldPorts = TYPES.BUSTAP.ports(c.params);
				const oldD = oldPorts.find(p => p.id === "d");
				const ax = c.x + oldD.dx, ay = c.y + oldD.dy;   // absolute d position
				c.params.dir = ev.target.value;
				const newD = TYPES.BUSTAP.ports(c.params).find(p => p.id === "d");
				c.x = ax - newD.dx; c.y = ay - newD.dy;
				snapshot(); render(); renderInspector();
			});
			return;
		}
		if (c) {
			const td = typeDef(c);
			const schema = td && td.paramSchema || [];
			let html = `<div class="insp"><h3>${esc(td ? td.label : c.type)} <span style="font-size:11px;color:var(--muted);font-weight:normal">${esc(c.id)}</span></h3>`;
			html += `<div class="row"><label>Position</label>
        <span><input style="width:62px" id="iX" value="${c.x}"> <input style="width:62px" id="iY" value="${c.y}"></span></div>`;
			schema.forEach(f => {
				const v = (c.params || {})[f.key];
				if (f.type === "string") {
					html += `<div class="row"><label>${esc(f.label)}</label><input data-pk="${f.key}" value="${esc(v || "")}" placeholder="${esc(f.placeholder || "")}"></div>`;
				} else if (f.type === "int") {
					html += `<div class="row"><label>${esc(f.label)}</label><input type="number" data-pk="${f.key}" min="${f.min ?? 1}" max="${f.max ?? 64}" value="${v}"></div>`;
				} else if (f.type === "bool") {
					html += `<div class="row"><label>${esc(f.label)}</label><input type="checkbox" data-pk="${f.key}" ${v ? "checked" : ""}></div>`;
				} else if (f.type === "select") {
					html += `<div class="row"><label>${esc(f.label)}</label><select data-pk="${f.key}">
            ${f.options.map(o => `<option value="${o}" ${o == v ? "selected" : ""}>${o}</option>`).join("")}
          </select></div>`;
				}
			});
			if (orientable(c)) html += `<div class="row"><label>ทิศทาง</label><span style="display:flex;gap:4px">
        <button class="btn" id="iRotate" title="หมุน 90° (R · Shift+R = ทวนเข็ม)">↻ หมุน</button>
        <button class="btn" id="iMirror" title="พลิกซ้าย-ขวา (M)">⇋ พลิก</button></span></div>`;
			html += `<div class="row"><label></label><button class="btn" data-act="delete-sel">🗑 Delete</button></div>`;
			html += `</div>`;
			root.innerHTML = html;
			$("#iX").addEventListener("change", ev => { c.x = snap(+ev.target.value || 0); snapshot(); render(); renderInspector(); });
			$("#iY").addEventListener("change", ev => { c.y = snap(+ev.target.value || 0); snapshot(); render(); renderInspector(); });
			if ($("#iRotate")) $("#iRotate").addEventListener("click", () => rotateSelection(1));
			if ($("#iMirror")) $("#iMirror").addEventListener("click", () => mirrorSelection());
			root.querySelectorAll("[data-pk]").forEach(e => {
				e.addEventListener("change", ev => {
					const k = e.dataset.pk;
					const f = schema.find(s => s.key === k) || {};
					let v = e.type === "checkbox" ? e.checked
						: e.type === "number" ? (() => {        // 0 is a legal value (e.g. TAP lo=0) — no || here
							const mn = f.min ?? 1, mx = f.max ?? 64;
							const nv = e.value.trim() === "" ? NaN : Math.round(+e.value);
							return clamp(Number.isFinite(nv) ? nv : mn, mn, mx);
						})()
							: e.tagName === "SELECT" && /^\d+$/.test(e.value) ? +e.value
								: e.value;
					if (k === "name") {
						v = sanId(v);
						// keep IN/OUT pin names unique inside the schematic (they become VHDL ports)
						if (c.type === "IN" || c.type === "OUT") {
							const used = new Set(sch.components.filter(x => x.type === c.type && x.id !== c.id).map(x => x.params.name));
							const base = v; let kk = 1;
							while (used.has(v)) v = base + "_" + (kk++);
							if (v !== base) toast(`ชื่อ '${base}' ถูกใช้แล้ว → เปลี่ยนเป็น '${v}'`, "warn");
						}
					}
					c.params = c.params || {};
					c.params[k] = v;
					// ports may have changed (count/width): drop wires to vanished pins
					sch.wires = sch.wires.filter(w => {
						const a = comp(w.from.cid), b = comp(w.to.cid);
						return a && b && getPort(a, w.from.pid) && getPort(b, w.to.pid);
					});
					// wire widths are derived live (netWidth) — nothing to refresh
					snapshot(); render(); renderInspector();
				});
			});
			return;
		}
		// wire?
		const w = sch.wires.find(x => x.id === id);
		if (w) {
			const hasCustomRoute = (typeof w.mx === "number") || (typeof w.my === "number") || !!(w.pts && w.pts.length);
			const nw = netWidth(w, sch);
			root.innerHTML = `<div class="insp">
        <h3>Wire ${nw > 1 ? `<span style="color:var(--wire-bus)">bus (${nw - 1}:0)</span>` : ""}</h3>
        <div class="row"><label>Net name</label><input id="iWireName" value="${esc(w.name || "")}" placeholder="เช่น data หรือ data(7:0)"></div>
        <div class="row"><label>เส้นทาง</label><button class="btn" id="iWireRoute" ${hasCustomRoute ? "" : "disabled"} title="ลบตำแหน่งที่ลากไว้ ให้ระบบจัดแนวเอง">↺ จัดแนวอัตโนมัติ</button></div>
        <div class="row"><label></label><button class="btn" data-act="delete-sel">🗑 Delete</button></div>
        <div style="padding:4px 2px;font-size:11px;color:var(--muted)">${nw > 1 ? "สายบัส — ใช้เครื่องมือ ≣ (หรือคลิกขวา) คลิกสายเพื่อดึงบิต · หรือลาก Bus Ripper มาวางบนสาย" : "ลากที่ตัวสายเพื่อเลื่อนแนวท่อนกลางได้ · บัสต้องลากจากพอร์ต >1 bit ของ component (ตั้งชื่อบัสได้แต่ความกว้างมาจากต้นทาง)"}</div>
      </div>`;
			$("#iWireName").addEventListener("change", ev => { applyWireName(w, ev.target.value); });
			$("#iWireRoute").addEventListener("click", () => {
				delete w.mx; delete w.my; delete w.pts;
				snapshot(); render(); renderInspector();
				toast("จัดแนวสายอัตโนมัติแล้ว", "ok");
			});
			return;
		}
	}
	root.innerHTML = `<div class="insp"><div class="empty">${state.selection.size} items selected</div>
    <div style="display:flex;gap:6px;padding:0 12px"><button class="btn" data-act="duplicate">⎘ Duplicate</button><button class="btn" data-act="delete-sel">🗑 Delete</button></div></div>`;
}
