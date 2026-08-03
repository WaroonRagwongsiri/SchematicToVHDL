"use strict";

/* =========================================================================
   VHDL GENERATION
   ========================================================================= */
/* Walk top schematic recursively and collect every entity it depends on
   (sub-schematics and custom components). Returns a Set of keys like
   "sch:<name>" and "custom:<name>". The top is always included. */
function collectReachable() {
	const seen = new Set();
	const top = state.project.schematics[state.project.topId];
	if (!top) return seen;
	function walkComps(components) {
		(components || []).forEach(c => {
			const t = c.type || "";
			if (t.startsWith("CUSTOM:")) {
				const n = t.slice(7);
				const key = "custom:" + n;
				if (seen.has(key)) return;
				seen.add(key);
				const cc = state.project.customs[n];
				if (cc && cc.schematic) walkComps(cc.schematic.components);
			} else if (t.startsWith("SCH:")) {
				const id = t.slice(4);
				const sub = state.project.schematics[id];
				if (!sub) return;
				const key = "sch:" + sub.name;
				if (seen.has(key)) return;
				seen.add(key);
				walkComps(sub.components);
			}
		});
	}
	seen.add("sch:" + top.name);
	walkComps(top.components);
	return seen;
}

function generateAllVhdl() {
	const out = {};
	const reach = collectReachable();
	// two design units whose names sanId to the SAME entity identifier would emit two
	// `entity foo is` in one bundle (won't compile) — and, worse, a custom keyed by the
	// same display name used to silently OVERWRITE the schematic's entry (one entity
	// vanished). Track claimed entity names, never clobber an out key, and warn.
	const entOwner = new Map();
	const clashWarn = disp => {
		const e = sanId(disp);
		if (entOwner.has(e) && entOwner.get(e) !== disp)
			return `ชื่อ entity '${e}' ซ้ำกับ '${entOwner.get(e)}' — VHDL จะ compile ไม่ผ่าน (เปลี่ยนชื่อ block ให้ไม่ซ้ำ)`;
		entOwner.set(e, disp); return null;
	};
	const stash = (disp, r) => {
		const cw = clashWarn(disp);
		if (cw && r && Array.isArray(r.warns)) r.warns.push(cw);
		let key = disp; while (out[key] !== undefined) key += "*";   // never drop an entity
		out[key] = r;
	};
	// top schematic + any sub-schematics referenced
	Object.values(state.project.schematics).forEach(sch => {
		if (reach.has("sch:" + sch.name)) stash(sch.name, generateSchVhdl(sch));
	});
	// only customs actually used somewhere below top
	Object.values(state.project.customs).forEach(cc => {
		if (!reach.has("custom:" + cc.name)) return;
		if (cc.schematic) {
			const fakeSch = {
				id: "cc_" + cc.name, name: sanId(cc.name),
				components: cc.schematic.components || [],
				wires: cc.schematic.wires || []
			};
			stash(cc.name, generateSchVhdl(fakeSch));
		} else if (cc.vhdl) {
			stash(cc.name, cc.vhdl);
		}
	});
	return out;
}

function generateSchVhdl(sch) {
	const warns = [];
	const ename = sanId(sch.name) || "my_circuit";

	const inputs = sch.components.filter(c => c.type === "IN");
	const outputs = sch.components.filter(c => c.type === "OUT");
	const inners = sch.components.filter(c => !["IN", "OUT", "VCC", "GND"].includes(c.type));

	// assign net names
	const used = {};
	function uniq(b) { let n = sanId(b) || "net", i = 1; while (used[n]) n = sanId(b) + "_" + (i++); used[n] = 1; return n; }
	inputs.forEach(c => { c._net = uniq(c.params.name || "in"); });
	outputs.forEach(c => { c._net = uniq(c.params.name || "out"); });
	inners.forEach((c, i) => {
		// every output port gets a signal (width recorded for the declaration)
		const td = typeDef(c);
		if (!td) { warns.push("Unknown type " + c.type); return; }
		c._nets = {};
		c._netW = {};
		if (c.type === "JUNCTION") {
			delete c._busSig; delete c._busW;  // never reuse stale scratch from a prior run
			// a floating-bus definition node (no upstream driver) becomes its own signal
			if (c.params && c.params.busName && c.params.busWidth && !sch.wires.some(x => x.to.cid === c.id)) {
				c._busSig = uniq(c.params.busName);
				c._busW = c.params.busWidth;
				warns.push(`บัส '${c._busSig}' ยังไม่มี source — สัญญาณจะไม่ถูก drive (ต่อ source ก่อนใช้งานจริง)`);
			}
			return;                           // otherwise transparent — no signal allocation
		}
		td.ports(c.params || {}).forEach(p => {
			if (p.dir === "out") {
				c._nets[p.id] = uniq(`n${i + 1}_${p.id}`);
				c._netW[p.id] = p.width || 1;
			}
		});
	});

	// explicit wire names override — via uniq() so a duplicate name or a name
	// colliding with a port never produces two identical signal declarations
	const renamedPorts = new Set();
	sch.wires.forEach(w => {
		if (!w.name) return;
		const src = comp(w.from.cid, sch);
		if (!src) return;
		if (src.type === "IN") { /* skip, source is the input itself */ }
		else if (src._nets && src._nets[w.from.pid]) {
			const key = w.from.cid + "." + w.from.pid;
			if (renamedPorts.has(key)) return;   // rename each source port once only
			renamedPorts.add(key);
			src._nets[w.from.pid] = uniq(w.name);
		}
	});

	// width-aware zero literal
	const zlit = w => (w || 1) > 1 ? "(others => '0')" : "STD_LOGIC'('0')";

	function driver(cid, pid, visited) {
		visited = visited || new Set();
		const k = cid + "." + pid;
		if (visited.has(k)) return null;            // protect against loops
		visited.add(k);
		const w = sch.wires.find(w => w.to.cid === cid && w.to.pid === pid);
		if (!w) return null;
		const src = comp(w.from.cid, sch);
		if (!src) return null;
		if (src.type === "IN") return src._net;
		if (src.type === "VCC") return "STD_LOGIC'('1')";
		if (src.type === "GND") return "STD_LOGIC'('0')";
		if (src.type === "JUNCTION") {
			if (src._busSig) return src._busSig;                            // floating named bus
			return driver(src.id, "j", visited);                          // transparent
		}
		if (src._nets) return src._nets[w.from.pid] || null;
		return null;
	}
	// width of the ultimate driving port (traces through junctions) — used to
	// reject indexing a scalar as if it were a bus
	function driverWidth(cid, pid, visited) {
		visited = visited || new Set();
		const k = cid + "." + pid;
		if (visited.has(k)) return null;
		visited.add(k);
		const w = sch.wires.find(w => w.to.cid === cid && w.to.pid === pid);
		if (!w) return null;
		const src = comp(w.from.cid, sch);
		if (!src) return null;
		if (src.type === "JUNCTION") {
			if (src._busW) return src._busW;                               // floating named bus
			return driverWidth(src.id, "j", visited);
		}
		const sp = getPort(src, w.from.pid);
		return sp ? (sp.width || 1) : null;
	}
	const concurrent = [];
	const processes = [];
	const subInstances = [];

	inners.forEach(c => {
		const td = typeDef(c); if (!td) return;
		if (c.type === "JUNCTION") return;     // transparent — no VHDL statement
		const portsArr = td.ports(c.params || {});
		const inputsPorts = portsArr.filter(p => p.dir === "in");
		const driverFor = pid => {
			const v = driver(c.id, pid);
			if (!v) {
				const pw = (portsArr.find(p => p.id === pid) || {}).width || 1;
				warns.push(`${compDisplay(c)} ขา '${pid}' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน`);
				return zlit(pw);
			}
			return v;
		};

		/* ----- gates ----- */
		if (["AND", "OR", "NAND", "NOR", "XOR", "XNOR", "NOT", "BUF"].includes(c.type)) {
			const ins = inputsPorts.map(p => driverFor(p.id));
			concurrent.push(`  ${c._nets.o} <= ${TYPES[c.type].expr(ins)};`);
			return;
		}
		/* ----- MUX ----- */
		if (c.type === "MUX") {
			const n = c.params.inputs;
			const selW = Math.ceil(Math.log2(n));
			const dataIns = []; for (let i = 0; i < n; i++) dataIns.push(driverFor("d" + i));
			const selIns = []; for (let i = 0; i < selW; i++) selIns.push(driverFor("s" + i));
			// build: y <= dataIns[ to_integer(sel) ];
			const selExpr = selIns.length === 1 ? selIns[0]
				: selIns.slice().reverse().map(s => s).join(" & ");
			const condChain = [];
			for (let i = 0; i < n; i++) {
				const bits = i.toString(2).padStart(selW, "0");
				const cond = selIns.length === 1
					? `${selIns[0]} = '${bits}'`
					: `(${selIns.slice().reverse().map((s, k) => `${s} = '${bits[k]}'`).join(" and ")})`;
				condChain.push(`${dataIns[i]} when ${cond}`);
			}
			concurrent.push(`  ${c._nets.y} <= ${condChain.join(" else\n             ")} else '0';`);
			return;
		}
		/* ----- DEMUX ----- */
		if (c.type === "DEMUX") {
			const n = c.params.outputs;
			const selW = Math.ceil(Math.log2(n));
			const d = driverFor("d");
			const selIns = []; for (let i = 0; i < selW; i++) selIns.push(driverFor("s" + i));
			for (let i = 0; i < n; i++) {
				const bits = i.toString(2).padStart(selW, "0");
				const cond = selIns.length === 1
					? `${selIns[0]} = '${bits}'`
					: `(${selIns.slice().reverse().map((s, k) => `${s} = '${bits[k]}'`).join(" and ")})`;
				concurrent.push(`  ${c._nets["y" + i]} <= ${d} when ${cond} else '0';`);
			}
			return;
		}
		/* ----- BUS TAP (slice a hi:lo range off the attached bus) ----- */
		if (c.type === "BUSTAP") {
			const hi = Math.max(c.params.hi ?? 0, c.params.lo ?? 0);
			const lo = Math.min(c.params.hi ?? 0, c.params.lo ?? 0);
			const ow = hi - lo + 1;
			const src = driver(c.id, "d");
			const sw = driverWidth(c.id, "d");   // real bus width, traced live
			let expr = null;
			if (!src) {
				warns.push(`${compDisplay(c)} ยังไม่ได้เกาะกับสายบัส — ใช้ค่า '0' แทน`);
			} else if (!sw || sw <= 1) {
				warns.push(`${compDisplay(c)} ต้องเกาะกับสายบัส (กว้าง > 1 bit) แต่ได้สัญญาณ ${sw || 1} bit — ใช้ค่า '0' แทน`);
			} else if (hi > sw - 1) {
				warns.push(`${compDisplay(c)} เลือกบิต (${hi}${hi === lo ? "" : ":" + lo}) เกินช่วงบัสต้นทาง (${sw - 1}:0) — ใช้ค่า '0' แทน`);
			} else {
				expr = hi === lo ? `${src}(${hi})` : `${src}(${hi} downto ${lo})`;
			}
			concurrent.push(`  ${c._nets.y} <= ${expr || zlit(ow)};`);
			return;
		}
		/* ----- ENCODER (priority) ----- */
		if (c.type === "ENC") {
			const n = c.params.inputs;
			const ow = Math.ceil(Math.log2(n));
			const ins = []; for (let i = 0; i < n; i++) ins.push(driverFor("i" + i));
			// priority: highest index wins
			for (let b = 0; b < ow; b++) {
				// y_b = OR of i_k where bit b of k = 1, and no higher i is active
				const terms = [];
				for (let k = n - 1; k >= 0; k--) {
					if (((k >> b) & 1) === 1) {
						const higher = [];
						for (let m = k + 1; m < n; m++) higher.push(`not ${ins[m]}`);
						terms.push(higher.length ? `(${ins[k]} and ${higher.join(" and ")})` : ins[k]);
					}
				}
				concurrent.push(`  ${c._nets["y" + b]} <= ${terms.length ? terms.join(" or ") : "'0'"};`);
			}
			return;
		}
		/* ----- DECODER ----- */
		if (c.type === "DEC") {
			const n = c.params.outputs;
			const iw = Math.ceil(Math.log2(n));
			const a = []; for (let i = 0; i < iw; i++) a.push(driverFor("a" + i));
			const en = driverFor("en");
			for (let i = 0; i < n; i++) {
				const bits = i.toString(2).padStart(iw, "0");
				const cond = a.slice().reverse().map((s, k) => `${s} = '${bits[k]}'`).join(" and ");
				concurrent.push(`  ${c._nets["y" + i]} <= ${en} when (${cond}) else '0';`);
			}
			return;
		}
		/* ----- D-FF ----- */
		if (c.type === "DFF") {
			const D = driverFor("d");
			// clk must NEVER fall back to a literal: process('0') / rising_edge('0')
			// is not valid VHDL (rising_edge requires an actual signal, not a
			// constant). If clk isn't wired, skip this flip-flop instead of
			// emitting a literal into the sensitivity list.
			const CLK = driver(c.id, "clk");
			if (!CLK) { warns.push(`${compDisplay(c)} ขา 'clk' ยังไม่ได้ต่อสาย — ข้าม flip-flop นี้ในโค้ด (ต่อสัญญาณนาฬิกาก่อนสร้าง VHDL)`); return; }
			// unwired rst/pre must NOT reach the sensitivity list as a literal
			const RST = c.params.reset ? driver(c.id, "rst") : null;
			const PRE = c.params.preset ? driver(c.id, "pre") : null;
			if (c.params.reset && !RST) warns.push(`${compDisplay(c)} เปิด async reset แต่ขา rst ไม่ได้ต่อสาย — ข้าม reset ในโค้ด`);
			if (c.params.preset && !PRE) warns.push(`${compDisplay(c)} เปิด async preset แต่ขา pre ไม่ได้ต่อสาย — ข้าม preset ในโค้ด`);
			processes.push({
				clk: CLK, edge: c.params.edge,
				rst: RST, pre: PRE,
				body: `      ${c._nets.q}  <= ${D};\n      ${c._nets.qn} <= not (${D});`,
				rstAssign: `      ${c._nets.q}  <= '0';\n      ${c._nets.qn} <= '1';`,
				preAssign: `      ${c._nets.q}  <= '1';\n      ${c._nets.qn} <= '0';`,
			});
			return;
		}
		/* ----- JK-FF ----- */
		if (c.type === "JKFF") {
			const J = driverFor("j");
			const K = driverFor("k");
			const CLK = driver(c.id, "clk");
			if (!CLK) { warns.push(`${compDisplay(c)} ขา 'clk' ยังไม่ได้ต่อสาย — ข้าม flip-flop นี้ในโค้ด (ต่อสัญญาณนาฬิกาก่อนสร้าง VHDL)`); return; }
			const RST = c.params.reset ? driver(c.id, "rst") : null;
			const PRE = c.params.preset ? driver(c.id, "pre") : null;
			if (c.params.reset && !RST) warns.push(`${compDisplay(c)} เปิด async reset แต่ขา rst ไม่ได้ต่อสาย — ข้าม reset ในโค้ด`);
			if (c.params.preset && !PRE) warns.push(`${compDisplay(c)} เปิด async preset แต่ขา pre ไม่ได้ต่อสาย — ข้าม preset ในโค้ด`);
			const qsig = c._nets.q;
			processes.push({
				clk: CLK, edge: c.params.edge,
				rst: RST, pre: PRE,
				// qn is assigned in every branch from the same pre-edge value of q,
				// so q/qn always stay complementary after the edge
				body:
					`      if    (${J}='0' and ${K}='1') then ${qsig} <= '0'; ${c._nets.qn} <= '1';
      elsif (${J}='1' and ${K}='0') then ${qsig} <= '1'; ${c._nets.qn} <= '0';
      elsif (${J}='1' and ${K}='1') then ${qsig} <= not ${qsig}; ${c._nets.qn} <= ${qsig};
      end if;`,
				rstAssign: `      ${qsig} <= '0';\n      ${c._nets.qn} <= '1';`,
				preAssign: `      ${qsig} <= '1';\n      ${c._nets.qn} <= '0';`
			});
			return;
		}
		/* ----- T-FF ----- */
		if (c.type === "TFF") {
			const T = driverFor("t");
			const CLK = driver(c.id, "clk");
			if (!CLK) { warns.push(`${compDisplay(c)} ขา 'clk' ยังไม่ได้ต่อสาย — ข้าม flip-flop นี้ในโค้ด (ต่อสัญญาณนาฬิกาก่อนสร้าง VHDL)`); return; }
			const RST = c.params.reset ? driver(c.id, "rst") : null;
			const PRE = c.params.preset ? driver(c.id, "pre") : null;
			if (c.params.reset && !RST) warns.push(`${compDisplay(c)} เปิด async reset แต่ขา rst ไม่ได้ต่อสาย — ข้าม reset ในโค้ด`);
			if (c.params.preset && !PRE) warns.push(`${compDisplay(c)} เปิด async preset แต่ขา pre ไม่ได้ต่อสาย — ข้าม preset ในโค้ด`);
			const qsig = c._nets.q;
			processes.push({
				clk: CLK, edge: c.params.edge,
				rst: RST, pre: PRE,
				body: `      if (${T}='1') then ${qsig} <= not ${qsig}; end if;`,
				rstAssign: `      ${qsig} <= '0';`,
				preAssign: `      ${qsig} <= '1';`,
			});
			return;
		}
		/* ----- SR-FF ----- */
		if (c.type === "SRFF") {
			const S = driverFor("s");
			const R = driverFor("r");
			const CLK = driver(c.id, "clk");
			if (!CLK) { warns.push(`${compDisplay(c)} ขา 'clk' ยังไม่ได้ต่อสาย — ข้าม flip-flop นี้ในโค้ด (ต่อสัญญาณนาฬิกาก่อนสร้าง VHDL)`); return; }
			const qsig = c._nets.q;
			processes.push({
				clk: CLK, edge: c.params.edge,
				body:
					`      if    (${S}='1' and ${R}='0') then ${qsig} <= '1'; ${c._nets.qn} <= '0';
      elsif (${S}='0' and ${R}='1') then ${qsig} <= '0'; ${c._nets.qn} <= '1';
      end if;`
			});
			return;
		}
		/* ----- Custom component (component instantiation) ----- */
		if (c.type.startsWith("CUSTOM:")) {
			const td = typeDef(c);
			const cc = td._custom;
			const maps = [];
			customPorts(cc).forEach(p => {
				if (p.dir === "in") {
					const v = driver(c.id, p.name);
					if (!v) warns.push(`${compDisplay(c)} ขา '${p.name}' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน`);
					maps.push(`${p.name} => ${v || zlit(p.width)}`);
				} else {
					maps.push(`${p.name} => ${c._nets[p.name]}`);
				}
			});
			subInstances.push({ entity: sanId(cc.name), inst: c.id, maps });
			return;
		}
		/* ----- Sub-schematic instance ----- */
		if (c.type.startsWith("SCH:")) {
			const td = typeDef(c);
			const subSch = td._sch;
			const maps = [];
			td.ports({}).forEach(p => {
				if (p.dir === "in") {
					const v = driver(c.id, p.id);
					if (!v) warns.push(`${compDisplay(c)} ขา '${p.id}' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน`);
					maps.push(`${p.id} => ${v || zlit(p.width)}`);
				} else {
					maps.push(`${p.id} => ${c._nets[p.id]}`);
				}
			});
			subInstances.push({ entity: sanId(subSch.name), inst: c.id, maps });
			return;
		}
	});

	// output assignments
	const outLines = [];
	outputs.forEach(c => {
		const v = driver(c.id, "i");
		if (!v) { warns.push(`OUTPUT '${c._net}' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน`); outLines.push(`  ${c._net} <= ${zlit(c.params.width)};`); }
		else outLines.push(`  ${c._net} <= ${v};`);
	});

	/* ---- assemble ---- */
	const portDecls = [];
	inputs.forEach(c => {
		const t = c.params.width > 1 ? `STD_LOGIC_VECTOR(${c.params.width - 1} downto 0)` : "STD_LOGIC";
		portDecls.push(`    ${c._net} : in  ${t}`);
	});
	outputs.forEach(c => {
		const t = c.params.width > 1 ? `STD_LOGIC_VECTOR(${c.params.width - 1} downto 0)` : "STD_LOGIC";
		portDecls.push(`    ${c._net} : out ${t}`);
	});

	// collect internal signals (scalars grouped, vectors declared individually)
	const sigScalars = [];
	const sigVectors = [];
	inners.forEach(c => {
		if (c.type === "JUNCTION" && c._busSig) { sigVectors.push({ name: c._busSig, w: c._busW }); return; }
		if (!c._nets) return;
		Object.keys(c._nets).forEach(pid => {
			const wdt = (c._netW && c._netW[pid]) || 1;
			if (wdt > 1) sigVectors.push({ name: c._nets[pid], w: wdt });
			else sigScalars.push(c._nets[pid]);
		});
	});

	// component declarations for sub-entities used (match by sanitized name)
	const compDecls = [];
	const seen = new Set();
	subInstances.forEach(si => {
		if (seen.has(si.entity)) return;
		seen.add(si.entity);
		// find the source: custom or sub-sch
		const cc = Object.values(state.project.customs).find(x => sanId(x.name) === si.entity);
		if (cc) {
			compDecls.push(formatComponentDecl(si.entity, customPorts(cc)));
		} else {
			const sub = Object.values(state.project.schematics).find(s => sanId(s.name) === si.entity);
			if (sub) {
				// shared deduped list → component decl matches the sub-entity's ports exactly
				const cps = schPortList(sub).map(p => ({ name: p.id, dir: p.dir, width: p.width }));
				compDecls.push(formatComponentDecl(si.entity, cps));
			}
		}
	});

	let code = "";
	code += `library IEEE;\n`;
	code += `use IEEE.STD_LOGIC_1164.ALL;\n`;
	code += `use IEEE.NUMERIC_STD.ALL;\n\n`;
	code += `-- Generated by Schematic Studio  (target: Xilinx Spartan-7 / Vivado)\n`;
	code += `-- Schematic: ${sch.name}\n\n`;
	code += `entity ${ename} is\n`;
	if (portDecls.length) code += `  Port (\n` + portDecls.join(";\n") + `\n  );\n`;   // empty Port() is invalid VHDL
	code += `end ${ename};\n\n`;
	code += `architecture Behavioral of ${ename} is\n`;
	if (compDecls.length) code += compDecls.join("\n") + "\n";
	if (sigScalars.length) code += `  signal ${sigScalars.join(", ")} : STD_LOGIC;\n`;
	sigVectors.forEach(s => { code += `  signal ${s.name} : STD_LOGIC_VECTOR(${s.w - 1} downto 0);\n`; });
	code += `begin\n`;
	if (concurrent.length) {
		code += `\n  -- combinational logic\n` + concurrent.join("\n") + "\n";
	}
	if (processes.length) {
		code += `\n  -- sequential logic (flip-flops)\n`;
		processes.forEach((pr, idx) => {
			const sens = [pr.clk];
			if (pr.rst) sens.push(pr.rst);
			if (pr.pre) sens.push(pr.pre);
			const edgeFn = pr.edge === "falling" ? "falling_edge" : "rising_edge";
			code += `  process(${sens.join(", ")})\n  begin\n`;
			const indent = "    ";
			if (pr.rst && pr.pre) {
				// async reset has priority over async preset
				code += `${indent}if ${pr.rst} = '1' then\n${pr.rstAssign}\n${indent}elsif ${pr.pre} = '1' then\n${pr.preAssign}\n${indent}elsif ${edgeFn}(${pr.clk}) then\n`;
			} else if (pr.rst) {
				code += `${indent}if ${pr.rst} = '1' then\n${pr.rstAssign}\n${indent}elsif ${edgeFn}(${pr.clk}) then\n`;
			} else if (pr.pre) {
				code += `${indent}if ${pr.pre} = '1' then\n${pr.preAssign}\n${indent}elsif ${edgeFn}(${pr.clk}) then\n`;
			} else {
				code += `${indent}if ${edgeFn}(${pr.clk}) then\n`;
			}
			code += pr.body + "\n";
			code += `${indent}end if;\n  end process;\n`;
		});
	}
	if (subInstances.length) {
		code += `\n  -- sub-component instantiations\n`;
		subInstances.forEach((si, idx) => {
			// a port-less instance takes no port map clause — "port map ( )" is invalid
			if (!si.maps.length) { code += `  u_${idx}_${si.inst} : ${si.entity};\n`; return; }
			code += `  u_${idx}_${si.inst} : ${si.entity} port map (\n    ` +
				si.maps.join(",\n    ") + `\n  );\n`;
		});
	}
	if (outLines.length) {
		code += `\n  -- output drivers\n` + outLines.join("\n") + "\n";
	}
	code += `\nend Behavioral;\n`;

	return { code, warns };
}
function formatComponentDecl(name, ports) {
	// a port-less component must have NO Port clause — "Port ( );" is invalid VHDL
	if (!ports.length) return `  component ${name}\n  end component;`;
	const decls = ports.map(p => {
		const t = (p.width || 1) > 1 ? `STD_LOGIC_VECTOR(${p.width - 1} downto 0)` : "STD_LOGIC";
		return `      ${p.name} : ${p.dir === "in" ? "in " : "out"} ${t}`;
	});
	return `  component ${name}\n    Port (\n${decls.join(";\n")}\n    );\n  end component;`;
}

/* ---- Generate & show in VHDL panel ---- */
let _lastAllVhdl = null;
function bundleAll(all) {
	return Object.keys(all).map(n => {
		const entry = all[n];
		const c = (typeof entry === "string") ? entry : (entry?.code || "-- no code");
		return `-- ============================================================\n-- Entity: ${n}\n-- ============================================================\n${c}`;
	}).join("\n");
}
function generateVHDL() {
	try {
		const issues = runSynthesis() || [];
		const all = generateAllVhdl();
		_lastAllVhdl = all;
		const sel = $("#vhdlEntitySel");
		const topName = state.project.schematics[state.project.topId]?.name;
		const opts = [`<option value="__all__">★ All entities (bundle for Vivado)</option>`];
		Object.keys(all).forEach(n => {
			const isTop = n === topName;
			opts.push(`<option value="${esc(n)}">📄 ${esc(n)}${isTop ? "  (top)" : ""}</option>`);
		});
		sel.innerHTML = opts.join("");
		sel.value = "__all__";
		showVhdlFor("__all__", all);
		setRightTab("vhdl");
		// surface generator warnings in the Issues tab instead of dropping them
		const warnItems = [];
		Object.keys(all).forEach(n => {
			const entry = all[n];
			if (entry && entry.warns) entry.warns.forEach(m => warnItems.push({ lvl: "warn", msg: m, ref: n }));
		});
		if (warnItems.length) renderErrors(issues.concat(warnItems));
		const nEnt = Object.keys(all).length;
		if (warnItems.length) {
			toast(`สร้าง ${nEnt} entity แล้ว — มีคำเตือน ${warnItems.length} รายการในแท็บ Issues`, "warn");
		} else {
			toast(`สร้าง ${nEnt} entity เรียบร้อย ✓`, "ok");
		}
		return all;
	} catch (err) {
		console.error("VHDL gen failed:", err);
		toast("VHDL gen error: " + (err.message || err), "err");
		return null;
	}
}
function showVhdlFor(name, all) {
	if (!all) all = _lastAllVhdl || generateAllVhdl();
	let code;
	if (name === "__all__") {
		code = bundleAll(all);
	} else {
		const entry = all[name];
		code = (typeof entry === "string") ? entry : (entry?.code || "-- no code");
	}
	const pre = $("#vhdlOutput");
	pre.dataset.raw = code;
	pre.innerHTML = vhdlHighlight(code);
}
function vhdlHighlight(code) {
	const escd = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return escd.split("\n").map(line => {
		const ci = line.indexOf("--");
		let head = ci >= 0 ? line.slice(0, ci) : line;
		const tail = ci >= 0 ? `<span class="cm">${line.slice(ci)}</span>` : "";
		head = head
			.replace(/\b(library|use|entity|is|Port|in|out|inout|end|architecture|of|begin|signal|process|if|then|elsif|else|when|others|null|component|port|map|rising_edge|falling_edge|and|or|not|xor|nand|nor|downto)\b/gi, '<span class="kw">$1</span>')
			.replace(/\b(STD_LOGIC|STD_LOGIC_VECTOR|STD_LOGIC_1164|NUMERIC_STD|IEEE|Behavioral|UNSIGNED|SIGNED)\b/g, '<span class="ty">$1</span>');
		return head + tail;
	}).join("\n");
}
$("#vhdlEntitySel")?.addEventListener("change", ev => {
	showVhdlFor(ev.target.value);
});
function exportVhdlFile() {
	if (!_lastAllVhdl) generateVHDL();
	const code = $("#vhdlOutput").dataset.raw || "";
	if (!code) { toast("ยังไม่มีโค้ดให้ดาวน์โหลด — กด Generate VHDL ก่อน", "warn"); return; }
	const v = $("#vhdlEntitySel").value || "top";
	let fname;
	if (v === "__all__") fname = sanId(state.project.name || "project") + "_all.vhd";
	else fname = sanId(v) + ".vhd";
	const b = new Blob([code], { type: "text/plain" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u; a.download = fname; a.click();
	URL.revokeObjectURL(u);
	toast("Downloaded " + fname, "ok");
}
function exportAllVhdl() {
	const all = generateAllVhdl();
	// pack as a single file with sections
	let bundle = "";
	for (const name in all) {
		bundle += `-- ============================================================\n-- Entity: ${name}\n-- ============================================================\n`;
		bundle += (typeof all[name] === "string" ? all[name] : all[name].code) + "\n\n";
	}
	const b = new Blob([bundle], { type: "text/plain" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u; a.download = sanId($("#projectName").value) + "_all.vhd"; a.click();
	URL.revokeObjectURL(u);
}
