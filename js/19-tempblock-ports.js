"use strict";

/* =========================================================================
   TEMP BLOCK — Inputs / Outputs editor
   Live-edits c.params.ins / c.params.outs (add/remove/rename/reorder/width),
   same live-edit model as the rest of the inspector: every change snapshots,
   re-renders the canvas, and re-runs the inspector's wire-pruning filter so
   wires to vanished ports are dropped immediately.
   ========================================================================= */
function tempBlockNameTaken(c, name, exceptId) {
	const all = [...(c.params.ins || []), ...(c.params.outs || [])];
	return all.some(p => p.id !== exceptId && p.name === name);
}
function tempBlockUniqueName(c, raw, exceptId) {
	let v = sanId(raw) || "p";
	const base = v; let k = 1;
	while (tempBlockNameTaken(c, v, exceptId)) v = base + "_" + (k++);
	return v;
}
function openTempBlockPortsEditor(c) {
	const sch = activeSch();
	c.params.ins = c.params.ins || [];
	c.params.outs = c.params.outs || [];
	if (typeof c.params._portSeq !== "number") {
		const nums = [...c.params.ins, ...c.params.outs]
			.map(p => +String(p.id).replace(/^p/, "")).filter(Number.isFinite);
		c.params._portSeq = (nums.length ? Math.max(...nums) : 0) + 1;
	}

	const m = document.createElement("div");
	m.className = "modal-bg";
	m.innerHTML = `
    <div class="modal">
      <h2>✎ Temp Block Ports <span style="color:var(--muted);font-weight:400;font-size:12px;margin-left:6px">— ${esc(c.label || c.id)}</span>
        <button class="close">×</button></h2>
      <div class="modal-body">
        <div style="display:flex;gap:16px">
          <div style="flex:1;min-width:0">
            <div style="margin:0 0 6px;font-size:11px;color:var(--ink-dim);letter-spacing:1px;font-weight:600">INPUTS</div>
            <div id="tbIns"></div>
            <button class="btn" id="tbAddIn">+ Add Input</button>
          </div>
          <div style="flex:1;min-width:0">
            <div style="margin:0 0 6px;font-size:11px;color:var(--ink-dim);letter-spacing:1px;font-weight:600">OUTPUTS</div>
            <div id="tbOuts"></div>
            <button class="btn" id="tbAddOut">+ Add Output</button>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="tbClose">Close</button>
      </div>
    </div>`;
	document.body.appendChild(m);

	function commit() {
		sch.wires = sch.wires.filter(w => {
			const a = comp(w.from.cid), b = comp(w.to.cid);
			return a && b && getPort(a, w.from.pid) && getPort(b, w.to.pid);
		});
		snapshot(); render(); renderInspector();
		renderList();
	}
	function rowHtml(p, kind, idx, len) {
		return `<div class="row" data-id="${esc(p.id)}" data-kind="${kind}" style="gap:4px">
      <input class="tbName" style="flex:1;min-width:0" value="${esc(p.name)}">
      <input class="tbWidth" type="number" min="1" max="32" value="${p.width || 1}" style="width:52px">
      <button class="btn tbUp" ${idx === 0 ? "disabled" : ""} title="เลื่อนขึ้น">↑</button>
      <button class="btn tbDown" ${idx === len - 1 ? "disabled" : ""} title="เลื่อนลง">↓</button>
      <button class="btn tbDel" title="ลบ">🗑</button>
    </div>`;
	}
	function renderList() {
		const ins = c.params.ins, outs = c.params.outs;
		m.querySelector("#tbIns").innerHTML = ins.map((p, i) => rowHtml(p, "in", i, ins.length)).join("") || `<div style="color:var(--muted);font-size:12px">— ไม่มี —</div>`;
		m.querySelector("#tbOuts").innerHTML = outs.map((p, i) => rowHtml(p, "out", i, outs.length)).join("") || `<div style="color:var(--muted);font-size:12px">— ไม่มี —</div>`;
		wireRows();
	}
	function listFor(kind) { return kind === "in" ? c.params.ins : c.params.outs; }
	function wireRows() {
		m.querySelectorAll(".row[data-id]").forEach(row => {
			const kind = row.dataset.kind, id = row.dataset.id;
			const list = listFor(kind);
			const idx = list.findIndex(p => p.id === id);
			if (idx < 0) return;
			row.querySelector(".tbName").addEventListener("change", ev => {
				const v = tempBlockUniqueName(c, ev.target.value, id);
				if (v !== sanId(ev.target.value || "")) toast(`ชื่อ '${ev.target.value}' ถูกใช้แล้ว → เปลี่ยนเป็น '${v}'`, "warn");
				list[idx].name = v;
				commit();
			});
			row.querySelector(".tbWidth").addEventListener("change", ev => {
				const nv = clamp(Math.round(+ev.target.value) || 1, 1, 32);
				list[idx].width = nv;
				commit();
			});
			row.querySelector(".tbUp").addEventListener("click", () => {
				if (idx === 0) return;
				[list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
				commit();
			});
			row.querySelector(".tbDown").addEventListener("click", () => {
				if (idx === list.length - 1) return;
				[list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
				commit();
			});
			row.querySelector(".tbDel").addEventListener("click", () => {
				list.splice(idx, 1);
				commit();
			});
		});
	}
	m.querySelector("#tbAddIn").addEventListener("click", () => {
		const n = c.params.ins.length;
		const id = "p" + (c.params._portSeq++);
		c.params.ins.push({ id, name: tempBlockUniqueName(c, "in" + n), width: 1 });
		commit();
	});
	m.querySelector("#tbAddOut").addEventListener("click", () => {
		const n = c.params.outs.length;
		const id = "p" + (c.params._portSeq++);
		c.params.outs.push({ id, name: tempBlockUniqueName(c, "out" + n), width: 1 });
		commit();
	});
	m.querySelector(".close").addEventListener("click", () => m.remove());
	m.querySelector("#tbClose").addEventListener("click", () => m.remove());

	renderList();
}
