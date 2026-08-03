"use strict";

/* ==========================================================================
   VHDL  →  SCHEMATIC  import   (combinational gates + MUX + D flip-flop)
   Parses a .vhd file's entity/architecture and rebuilds a drawn circuit:
   ports→IN/OUT, boolean expressions→gate trees, when/else→MUX, rising_edge
   process→D-FF; then columns the parts by logic depth and lets the router wire.
   ========================================================================== */
function vhStrip(t) { return String(t).replace(/--[^\n]*/g, " ").replace(/\r/g, " "); }
function vhSplitTop(s, delim) {
	const out = []; let d = 0, cur = "";
	for (const ch of s) {
		if (ch === "(") d++; else if (ch === ")") d--;
		if (ch === delim && d === 0) { out.push(cur); cur = ""; } else cur += ch;
	}
	if (cur.trim()) out.push(cur); return out;
}
function vhTypeWidth(ts) {
	const m = /\(\s*(\d+)\s+downto\s+(\d+)\s*\)/i.exec(ts) || /\(\s*(\d+)\s+to\s+(\d+)\s*\)/i.exec(ts);
	return m ? Math.abs((+m[1]) - (+m[2])) + 1 : 1;
}
const vhBase = s => sanId(String(s).replace(/\(.*\)/, "").trim());
function vhTokenize(s) { const out = []; const re = /\s*('[01]'|"[01]+"|[A-Za-z_]\w*(?:\([^)]*\))?|\(|\)|<=)\s*/g; let m; while (m = re.exec(s)) out.push(m[1]); return out; }
function vhParseExpr(str) {
	// "(others => '0')" is a constant fill, not a signal — without this it tokenises
	// to a phantom 'others' net reported as a missing source
	const agg = /^\(\s*others\s*=>\s*'([01])'\s*\)$/i.exec(String(str).trim());
	if (agg) return { lit: agg[1] };
	const toks = vhTokenize(str); let pos = 0;
	const peek = () => toks[pos], nx = () => toks[pos++];
	function primary() {
		const t = peek();
		if (t === "(") { nx(); const e = orExpr(); if (peek() === ")") nx(); return e; }
		if (/^not$/i.test(t)) { nx(); return { op: "not", args: [primary()] }; }
		nx();
		if (/^'0'$/.test(t)) return { lit: "0" };
		if (/^'1'$/.test(t)) return { lit: "1" };
		return { sig: vhBase(t) };
	}
	function orExpr() {
		let left = primary();
		while (peek() && /^(and|or|xor|nand|nor|xnor)$/i.test(peek())) {
			const op = nx().toLowerCase(); const right = primary();
			if (left.op === op) left.args.push(right); else left = { op, args: [left, right] };
		}
		return left;
	}
	return orExpr();
}
function vhParseProcess(p, warns) {
	const em = /(rising|falling)_edge\s*\(\s*(\w+)\s*\)/i.exec(p);
	if (!em) { warns.push("ข้าม process ที่ไม่ใช่ flip-flop"); return null; }
	const asn = [...p.matchAll(/(\w+)\s*<=\s*([^;]+);/gi)];
	const clocked = asn.find(a => a.index > em.index) || asn[asn.length - 1];
	if (!clocked) return null;
	const ff = { kind: "ff", q: sanId(clocked[1]), d: vhParseExpr(clocked[2].trim()), clk: sanId(em[2]), edge: em[1].toLowerCase() };
	const rm = /if\s+(\w+)\s*=\s*'1'\s*then\s+\w+\s*<=\s*'0'/i.exec(p);
	const pm = /if\s+(\w+)\s*=\s*'1'\s*then\s+\w+\s*<=\s*'1'/i.exec(p);
	if (rm) ff.rst = sanId(rm[1]); if (pm) ff.pre = sanId(pm[1]);
	return ff;
}
function vhParseWhenElse(target, rhs) {
	const cases = []; let deflt = null;
	rhs.split(/\belse\b/i).forEach(seg => {
		const wm = /^([\s\S]+?)\s+when\s+([\s\S]+)$/i.exec(seg.trim());
		if (wm) cases.push({ value: vhParseExpr(wm[1]), cond: wm[2].trim() }); else deflt = vhParseExpr(seg.trim());
	});
	const sm = cases.length && /(\w+)\s*=\s*['"]/.exec(cases[0].cond);
	return { kind: "mux", target, cases, deflt, sel: sm ? sanId(sm[1]) : null };
}
/* Decode a MUX when-condition into {idx, sels}: idx = the binary value it selects,
   sels = the select net name(s) MSB-first. Handles "sel = '01'" (vector or 1-bit,
   one net) and "(a = '1' and b = '0')" (per-bit, MSB listed first — the app's form).
   idx=null when neither shape matches (caller falls back to source order + warns). */
function vhMuxSel(cond) {
	if (!cond) return { idx: null, sels: [] };
	const c = cond.trim().replace(/^\(+|\)+$/g, "").trim();
	const one = /^(\w+)\s*=\s*['"]([01]+)['"]$/.exec(c);
	if (one && !/\band\b/i.test(c)) return { idx: parseInt(one[2], 2), sels: [sanId(one[1])] };
	const eqs = [...c.matchAll(/(\w+)\s*=\s*['"]([01])['"]/g)];
	if (eqs.length) return { idx: parseInt(eqs.map(m => m[2]).join(""), 2), sels: eqs.map(m => sanId(m[1])) };
	return { idx: null, sels: [] };
}
function vhParseBody(body, stmts, warns) {
	const procRe = /process\s*(\([^)]*\))?\s*([\s\S]*?)end\s+process\s*;/gi;
	let pm, rest = body; const procs = [];
	while (pm = procRe.exec(body)) procs.push(pm[0]);
	procs.forEach(p => { rest = rest.replace(p, " "); const ff = vhParseProcess(p, warns); if (ff) stmts.push(ff); });
	vhSplitTop(rest, ";").forEach(raw => {
		const s = raw.trim(); if (!s) return;
		const m = /^([\w()]+?)\s*<=\s*([\s\S]+)$/.exec(s);
		if (!m) { if (/[a-z]/i.test(s)) warns.push("ข้ามคำสั่งที่อ่านไม่ได้: " + s.slice(0, 40)); return; }
		const target = vhBase(m[1]), rhs = m[2].trim();
		if (/\bwhen\b/i.test(rhs)) stmts.push(vhParseWhenElse(target, rhs));
		else stmts.push({ kind: "assign", target, expr: vhParseExpr(rhs) });
	});
}
function parseVhdl(src) {
	const t = vhStrip(src); const ports = [], signals = [], stmts = [], warns = [];
	const ent = /entity\s+(\w+)\s+is([\s\S]*?)end\b/i.exec(t);
	const entity = ent ? ent[1] : "imported";
	if (ent) {
		const pm = /port\s*\(([\s\S]*)\)\s*;\s*(?:end)?/i.exec(ent[2]);
		if (pm) vhSplitTop(pm[1], ";").forEach(decl => {
			const m = /^\s*([\w\s,]+?)\s*:\s*(in|out|inout)\b\s*(.+?)\s*$/i.exec(decl);
			if (!m) return;
			const dir = m[2].toLowerCase() === "in" ? "in" : "out", width = vhTypeWidth(m[3]);
			m[1].split(",").map(s => s.trim()).filter(Boolean).forEach(n => ports.push({ name: n, dir, width }));
		});
	}
	const arch = /architecture\s+\w+\s+of\s+\w+\s+is([\s\S]*?)\bbegin\b([\s\S]*)end\b/i.exec(t);
	if (arch) {
		let sm; const sigRe = /signal\s+([\w\s,]+?)\s*:\s*([^;]+?);/gi;
		while (sm = sigRe.exec(arch[1])) { const width = vhTypeWidth(sm[2]); sm[1].split(",").map(s => s.trim()).filter(Boolean).forEach(n => signals.push({ name: n, width })); }
		vhParseBody(arch[2], stmts, warns);
	}
	if ([...ports, ...signals].some(x => x.width > 1)) warns.push("มีสัญญาณบัส (>1 bit) — วาดลอจิกระดับบิตอาจไม่ครบ");
	return { entity, ports, signals, stmts, warns };
}
const VH_OPGATE = { and: "AND", or: "OR", xor: "XOR", nand: "NAND", nor: "NOR", xnor: "XNOR", not: "NOT", buf: "BUF" };
function buildSchematicFromVhdl(ast) {
	const comps = [], wires = [], driver = {}, need = [], depthOf = {};
	const warns = ast.warns || (ast.warns = []);   // import surfaces ast.warns to the user
	const add = (type, params) => { const id = uid("c"); comps.push({ id, type, x: 0, y: 0, params: params || {}, label: "" }); return id; };
	const outNames = new Set(ast.ports.filter(p => p.dir === "out").map(p => sanId(p.name)));
	const outAlias = {};
	function registerDriver(target, src) {
		if (src.cid !== undefined) { driver[target] = { cid: src.cid, pid: src.pid }; depthOf[target] = src.depth || 1; }
		else if (outNames.has(target)) { outAlias[target] = src.net; }
		else { const id = add("BUF", { inputs: 1 }); need.push({ cid: id, pid: "i0", net: src.net }); driver[target] = { cid: id, pid: "o" }; depthOf[target] = (depthOf[src.net] || 0) + 1; }
	}
	const outPorts = [];
	ast.ports.forEach(p => {
		if (p.dir === "in") { const id = add("IN", { name: sanId(p.name), width: p.width }); driver[sanId(p.name)] = { cid: id, pid: "o" }; depthOf[sanId(p.name)] = 0; }
		else outPorts.push({ name: sanId(p.name), width: p.width });
	});
	function emitExpr(node) {
		if (node.sig !== undefined) return { net: node.sig };
		if (node.lit !== undefined) { if (node.lit === "1") { const id = add("VCC", {}); return { cid: id, pid: "o", depth: 0 }; } return { open: true }; }
		const type = VH_OPGATE[node.op], ins = node.args.map(emitExpr);
		const params = (node.op === "not" || node.op === "buf") ? { inputs: 1 } : { inputs: ins.length };
		const gid = add(type, params);
		ins.forEach((src, i) => { if (src.net !== undefined) need.push({ cid: gid, pid: "i" + i, net: src.net }); else if (src.cid !== undefined) wires.push({ id: uid("w"), from: { cid: src.cid, pid: src.pid }, to: { cid: gid, pid: "i" + i }, name: "" }); });
		const d = 1 + Math.max(0, ...ins.map(s => s.net !== undefined ? (depthOf[s.net] || 0) : (s.depth || 0)));
		comps.find(c => c.id === gid).depth = d;
		return { cid: gid, pid: "o", depth: d };
	}
	ast.stmts.forEach(st => {
		if (st.kind === "assign") { registerDriver(st.target, emitExpr(st.expr)); }
		else if (st.kind === "ff") {
			const id = add("DFF", { edge: st.edge, reset: !!st.rst, preset: !!st.pre });
			const dsrc = emitExpr(st.d);
			if (dsrc.net !== undefined) need.push({ cid: id, pid: "d", net: dsrc.net }); else if (dsrc.cid !== undefined) wires.push({ id: uid("w"), from: { cid: dsrc.cid, pid: dsrc.pid }, to: { cid: id, pid: "d" }, name: "" });
			need.push({ cid: id, pid: "clk", net: st.clk });
			if (st.rst) need.push({ cid: id, pid: "rst", net: st.rst });
			if (st.pre) need.push({ cid: id, pid: "pre", net: st.pre });
			driver[st.q] = { cid: id, pid: "q" }; depthOf[st.q] = 2;
		} else if (st.kind === "mux") {
			// Each "... when <cond>" picks a data input; the cond's constant IS the binary
			// index of that input (the app's MUX drives d<idx> when sel = idx). Mapping by
			// SOURCE ORDER silently mis-wires any design whose whens aren't listed 0,1,2…
			// (incl. the app's own re-imported output), so decode the index from the cond.
			const parsed = st.cases.map(c => Object.assign({ v: c.value }, vhMuxSel(c.cond)));
			const maxIdx = parsed.reduce((m, p) => p.idx != null ? Math.max(m, p.idx) : m, 0);
			// size by the highest select index (or case count if indices didn't parse) —
			// the trailing "else '0'" is a fill for unused slots, NOT an extra data input
			const nCase = Math.max(2, maxIdx + 1, st.cases.length);
			const inputs = nCase <= 2 ? 2 : nCase <= 4 ? 4 : nCase <= 8 ? 8 : 16;
			const selW = Math.ceil(Math.log2(inputs));
			const id = add("MUX", { inputs });
			const used = new Set();
			const place = (idx, v) => {
				used.add(idx); const s = emitExpr(v);
				if (s.net !== undefined) need.push({ cid: id, pid: "d" + idx, net: s.net });
				else if (s.cid !== undefined) wires.push({ id: uid("w"), from: { cid: s.cid, pid: s.pid }, to: { cid: id, pid: "d" + idx }, name: "" });
			};
			parsed.forEach(p => {
				let idx = p.idx;
				if (idx == null || idx < 0 || idx >= inputs || used.has(idx)) {
					warns.push("MUX (" + st.target + "): อ่านค่า select ไม่ได้ วางตามลำดับแทน");
					for (idx = 0; idx < inputs && used.has(idx); idx++);
				}
				if (idx < inputs) place(idx, p.v);
			});
			if (st.deflt) { let idx = 0; for (; idx < inputs && used.has(idx); idx++); if (idx < inputs) place(idx, st.deflt); }
			// wire the select signal(s). vhMuxSel lists them MSB-first (the app emits
			// s_{hi}=MSB … s0=LSB), so the k-th listed maps to pin s{selW-1-k}.
			const sels = (parsed.find(p => p.sels && p.sels.length) || {}).sels || (st.sel ? [st.sel] : []);
			if (sels.length === 1 && selW > 1) { need.push({ cid: id, pid: "s0", net: sels[0] }); warns.push("MUX (" + st.target + "): select เป็นเวกเตอร์ ต่อ s0 เท่านั้น"); }
			else sels.forEach((netName, k) => { const b = selW - 1 - k; if (b >= 0 && b < selW) need.push({ cid: id, pid: "s" + b, net: netName }); });
			driver[st.target] = { cid: id, pid: "y" }; depthOf[st.target] = 2;
		}
	});
	outPorts.forEach(p => { const id = add("OUT", { name: p.name, width: p.width }); need.push({ cid: id, pid: "i", net: outAlias[p.name] || p.name }); });
	comps.forEach(c => { if (c.type === "IN") c.depth = 0; if ((c.type === "DFF" || c.type === "MUX") && c.depth == null) c.depth = 2; });
	need.forEach(nd => { const drv = driver[nd.net]; if (drv) wires.push({ id: uid("w"), from: { cid: drv.cid, pid: drv.pid }, to: { cid: nd.cid, pid: nd.pid }, name: "" }); });
	const maxD = Math.max(0, ...comps.filter(c => c.type !== "OUT").map(c => c.depth || 0));
	comps.forEach(c => { if (c.type === "OUT") c.depth = maxD + 1; });
	const COLW = 176, ROWH = 88, X0 = 66, Y0 = 55, cols = {};
	comps.forEach(c => { const d = c.depth || 0; (cols[d] = cols[d] || []).push(c); });
	Object.keys(cols).forEach(d => { cols[d].forEach((c, i) => { c.x = snap(X0 + (+d) * COLW); c.y = snap(Y0 + i * ROWH); delete c.depth; }); });
	return { comps, wires, unresolved: [...new Set(need.filter(nd => !driver[nd.net]).map(nd => nd.net))] };
}
function importVhdlFile() {
	const inp = document.createElement("input");
	inp.type = "file"; inp.accept = ".vhd,.vhdl,.txt";
	inp.onchange = e => {
		const f = (e.target.files || [])[0]; if (!f) return;
		const r = new FileReader();
		r.onload = () => {
			try {
				const ast = parseVhdl(r.result);
				if (!ast.ports.length && !ast.stmts.length) { toast("ไม่พบ entity/logic ในไฟล์นี้", "err", 3500); return; }
				const built = buildSchematicFromVhdl(ast);
				if (!built.comps.length) { toast("สร้าง schematic ไม่ได้", "err", 3500); return; }
				const id = uid("sch"), name = uniqueSchName(ast.entity || "imported", id);
				const sch = blankSchematic(id, name);
				sch.components = built.comps; sch.wires = built.wires;
				state.project.schematics[id] = sch;
				// same as deserialize: turn a driver's parallel sinks into junction-branch
				// fan-out (visible dots) and run the full layout — without this every
				// imported fan-out drew as a bare T with no connection dot until save+reload
				normalizePortFanout(sch);
				openSchTab(id); healLayout(sch); snapshot(); renderAll();
				try { zoomFit(); } catch (_) { }
				const parts = [`นำเข้า "${name}" — ${built.comps.length} components`];
				if (built.unresolved.length) parts.push("สัญญาณไม่พบต้นทาง: " + built.unresolved.join(", "));
				(ast.warns || []).forEach(w => parts.push("⚠ " + w));
				toast(parts.join(" · "), (built.unresolved.length || ast.warns.length) ? "warn" : "ok", 5200);
			} catch (err) { toast("Import VHDL error: " + (err && err.message || err), "err", 4000); }
		};
		r.readAsText(f);
	};
	inp.click();
}
