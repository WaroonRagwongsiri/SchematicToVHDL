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

/* The generator hangs the names it allocates on the component objects themselves so
   driver(), busSignalOf() and the port maps can find them again. Those fields are
   SCRATCH — true only for the run that wrote them — and they used to outlive it: a
   COPY carried them to the pasted component, and the layout stamp wrote them into the
   exported .vhd. Pasted blocks whose sub-sheet had been deleted hit `Unknown type`
   before _nets was reset and declared the clone's stale net names a second time. So
   every run starts by wiping them, and nothing writes them to a file. */
const NET_SCRATCH = ["_net", "_nets", "_netW", "_busSig", "_busNet", "_busW"];
const dropScratch = (k, v) => NET_SCRATCH.indexOf(k) >= 0 ? undefined : v;
function clearNetScratch(sch) {
	(sch.components || []).forEach(c => { NET_SCRATCH.forEach(k => { delete c[k]; }); });
}

function generateSchVhdl(sch) {
	const warns = [];
	clearNetScratch(sch);          // never inherit another run's (or another copy's) names
	const ename = sanId(sch.name) || "my_circuit";

	// the ENTITY lists its ports in the order the parent's COMPONENT declaration does,
	// which comes from schPortList (top to bottom on the sheet)
	const byPortOrder = schPortList(sch).map(p => p.cid);
	const inSheetOrder = list => list.slice().sort((a, b) => byPortOrder.indexOf(a.id) - byPortOrder.indexOf(b.id));
	const inputs = inSheetOrder(sch.components.filter(c => c.type === "IN"));
	const outputs = inSheetOrder(sch.components.filter(c => c.type === "OUT"));
	// CONST joins VCC/GND here: its output IS a literal, so allocating a signal for it
	// would declare something nothing ever assigns
	const inners = sch.components.filter(c => !["IN", "OUT", "VCC", "GND", "CONST"].includes(c.type));

	// assign net names
	const used = {};
	function uniq(b) { let n = sanId(b) || "net", i = 1; while (used[n]) n = sanId(b) + "_" + (i++); used[n] = 1; return n; }
	// PORTS FIRST: a port name is what the parent wires to, so when a port and an
	// instance label collide it is the (private) label that has to move
	inputs.forEach(c => { c._net = uniq(c.params.name || "in"); });
	outputs.forEach(c => { c._net = uniq(c.params.name || "out"); });
	/* Instance labels share that declarative region, and `u_` + sanId(label) is not
	   unique just because the LABEL is: `Adder 1` and `adder-1` both become `u_adder_1`,
	   and an all-Thai label collapses to the fallback. So labels are allocated through
	   the same `used` map and remembered for the emit site. An unlabelled block keeps
	   `u_<i>_<cid>`; a block whose type is gone emits no instance and claims no name. */
	const instLabel = new Map();
	inners.forEach(c => {
		if (!c.label) return;
		if (!(c.type.indexOf("SCH:") === 0 || c.type.indexOf("CUSTOM:") === 0 || c.type === "TEMPBLOCK")) return;
		if (!typeDef(c)) return;
		instLabel.set(c.id, uniq("u_" + sanId(c.label)));
	});
	inners.forEach((c, i) => {
		// every output port gets a signal (width recorded for the declaration)
		const td = typeDef(c);
		if (!td) { warns.push("Unknown type " + c.type); return; }
		c._nets = {};
		c._netW = {};
		if (c.type === "JUNCTION") {
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

	// Same walk as busSignalOf below, but returns the raw (component, pin) a merge
	// tap's bus side lands on instead of resolving straight to a signal name — lets
	// the pre-pass right after use it to decide whether a target signal needs to be
	// allocated (a sub-instance "in" pin never gets one from the loop above, which
	// only allocates _nets entries for "out"-direction ports).
	function resolveMergeTargetPin(tap) {
		const seen = new Set();
		const walk = cid => {
			if (seen.has(cid)) return null;
			seen.add(cid);
			for (const w of sch.wires) {
				const ends = [[w.from, w.to], [w.to, w.from]];
				for (const [a, b] of ends) {
					if (a.cid !== cid) continue;
					const oc = comp(b.cid, sch);
					if (!oc) continue;
					if (oc.type === "JUNCTION") { const r = walk(oc.id); if (r) return r; }
					// a sibling tap's bus-side pin is not a landing point — same bus,
					// not a sink. busSignalOf below skips these too, incidentally (a
					// BUSTAP's "d" pin, always dir "in", never gets a _nets entry).
					else if (oc.type === "BUSTAP" && b.pid === "d") continue;
					else return { oc, pid: b.pid };
				}
			}
			return null;
		};
		const dw = sch.wires.find(w => w.to.cid === tap.id && w.to.pid === "d");
		if (!dw) return null;
		const j = comp(dw.from.cid, sch);
		if (!j) return null;
		return j.type === "JUNCTION" ? walk(j.id) : { oc: j, pid: dw.from.pid };
	}
	// Pre-pass: allocate a target signal for any merge network that lands on a
	// sub-instance's vector "in" pin, BEFORE the main pass below runs — that pass
	// emits statements/port-maps in schematic array order, so the sub-instance may
	// be processed before the BUSTAP taps that feed it. The pin's width is fixed by
	// its own declaration (unlike an OUT marker's freely-inferred width), so it's
	// recorded as a hard ceiling in fixedWidthOf for the merge-write step to clamp to.
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

	const fixedWidthOf = {};   // sigName -> contractual width ceiling (sub-instance "in" pins only)
	const busNets = [];        // merge-bus signals declared on their own (an OUTPUT's internal copy)
	const outBusSig = new Map();   // OUTPUT id → the internal signal its bus really uses
	const mergeSig = new Map();    // merge net key → the signal its taps write
	inners.forEach(c => {
		if (c.type !== "BUSTAP" || c.params.mode !== "merge") return;
		const info = mergeBusInfo(sch, c);
		if (!info || mergeSig.has(info.key)) return;            // unwired — main loop warns later
		// with no destination port the taps themselves set the width, or the body would
		// index a signal declared one bit wide
		const width = info.width || info.tapWidth || 1;
		let outPort = null;
		info.net.forEach(id => {
			const w = sch.wires.find(x => x.id === id); if (!w) return;
			[w.from, w.to].forEach(ep => { const oc = comp(ep.cid, sch); if (oc && oc.type === "OUT") outPort = outPort || oc; });
		});
		let name = null;
		if (outPort) {
			/* AN OUTPUT PORT MAY BE WRITTEN BUT NEVER READ (Vivado: "cannot read from 'out'
			   object"). Writing the taps straight into the port broke the moment anything
			   else on the sheet read the same bus, so the bus gets its own signal and the
			   port takes a copy; synthesis folds the alias away. */
			name = uniq(outPort._net + "_i");
			busNets.push({ name, w: width });
			outBusSig.set(outPort.id, name);
		} else {
			const target = resolveMergeTargetPin(c);
			if (target && target.oc.type !== "JUNCTION") {
				const { oc, pid } = target;
				const p = getPort(oc, pid);
				if (p && oc._nets && oc._nets[pid]) name = oc._nets[pid];
				else if (p && p.dir === "in" && oc._nets) {
					oc._nets[pid] = uniq(`${sanId(oc.label || oc.type)}_${pid}_bus`);
					oc._netW[pid] = p.width || 1;
					fixedWidthOf[oc._nets[pid]] = p.width || 1;
					name = oc._nets[pid];
				}
			}
		}
		if (!name) return;
		mergeSig.set(info.key, name);
		// hang it on the net's junctions so anything ELSE reading the bus finds it too
		info.net.forEach(id => {
			const w = sch.wires.find(x => x.id === id); if (!w) return;
			[w.from, w.to].forEach(ep => {
				const oc = comp(ep.cid, sch);
				if (oc && oc.type === "JUNCTION" && !oc._busSig) { oc._busNet = name; oc._busW = width; }
			});
		});
	});

	// width-aware zero literal
	const zlit = w => (w || 1) > 1 ? "(others => '0')" : "STD_LOGIC'('0')";

	// grow a declared width to fit whatever bits the merge taps actually wrote —
	// used for OUT ports and floating-bus junctions, whose declared width is only
	// ever a default, never a hard contract (unlike a sub-instance pin, clamped
	// separately via fixedWidthOf before a bit is ever recorded here)
	function inferredWidth(sigName, declaredWidth) {
		const bits = busMergeBits[sigName];
		if (!bits || !bits.size) return declaredWidth || 1;
		return Math.max(declaredWidth || 1, Math.max(...bits) + 1);
	}
	/* A CONSTANT HAS NO WIDTH. '1' means "logic 1", not "a one-bit bus", so a VCC/GND
	   rail (or a 1-bit CONST) wired to a wider pin means every bit of that pin — the
	   `(others => '1')` idiom, written with its length spelled out so it is legal in
	   every position, including a port map actual and an aggregate operand. */
	const widenConst = (v, w) => {
		if (!(w > 1) || typeof v !== "string") return v;
		if (!/^'[01]'$/.test(v) && !/^STD_LOGIC'\('[01]'\)$/.test(v)) return v;
		return `std_logic_vector'(${w - 1} downto 0 => ${v.match(/'[01]'/)[0]})`;
	};

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
		if (src.type === "CONST") return constVhdl(src.params || {});
		if (src.type === "JUNCTION") {
			if (src._busSig) return src._busSig;                            // floating named bus
			// transparent — but with nothing upstream this may be a bus the merge taps
			// assemble, which does have a signal even with no driving port
			return driver(src.id, "j", visited) || src._busNet || null;
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
			if (src._busSig) return src._busW;                             // floating named bus
			// a merge bus has no driving PORT, so walking upstream finds nothing and the
			// bus used to measure 1 bit wide; the pre-pass stamped its real width here
			return driverWidth(src.id, "j", visited) || src._busW || null;
		}
		const sp = getPort(src, w.from.pid);
		return sp ? (sp.width || 1) : null;
	}
	const concurrent = [];
	const processes = [];
	const subInstances = [];
	const busMerges = [];        // "B(3) <= sig;" lines from merge taps
	const busMergeBits = {};     // sigName -> Set of bit indices actually written by merge taps
	/* The signal a merge tap writes into, settled per net by the pre-pass above. */
	function busSignalOf(tap) {
		const info = mergeBusInfo(sch, tap);
		return info ? (mergeSig.get(info.key) || null) : null;
	}

	inners.forEach(c => {
		const td = typeDef(c); if (!td) return;
		if (c.type === "JUNCTION") return;     // transparent — no VHDL statement
		const portsArr = td.ports(c.params || {});
		const inputsPorts = portsArr.filter(p => p.dir === "in");
		const driverFor = pid => {
			const v = (c._nets && c._nets[pid]) || driver(c.id, pid);
			const pw = (portsArr.find(p => p.id === pid) || {}).width || 1;
			if (!v) {
				warns.push(`${compDisplay(c)} ขา '${pid}' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน`);
				return zlit(pw);
			}
			return widenConst(v, pw);
		};
		/* A driver string may be a LITERAL — from an unwired pin (zlit) or a GND/VCC/CONST
		   tie-off. Two places must never receive one:
		    (a) a clock / async control: it lands in process(...) and rising_edge(...),
		        where VHDL demands a signal name — the file then does not even parse.
		    (b) the left side of a comparison: `'0' = '0'` is ambiguous ("=" is declared
		        for CHARACTER, BIT and STD_ULOGIC), the error family students lose hours to.
		   Note the bus form `(others => '0')` counts as a literal here too. */
		const isLit = v => typeof v === "string" && (/^'[01]'$/.test(v) || /^\(others\s*=>\s*'[01]'\)$/.test(v)
			|| /^x"[0-9A-Fa-f]+"$/.test(v) || /^"[01]+"$/.test(v));
		// comparison that stays legal when the driver is constant: fold it right here
		const eq = (v, bit) => {
			if (!isLit(v)) return `${v} = '${bit}'`;
			const one = /'1'/.test(v);
			return (one === (String(bit) === "1")) ? "true" : "false";
		};
		// a clock pin MUST be a real signal; null => caller must not emit the process
		const ffClock = () => {
			const v = driver(c.id, "clk");
			if (!v || isLit(v)) {
				warns.push(`${compDisplay(c)} ขา 'clk' ${v ? "ต่อกับค่าคงที่ (GND/VCC)" : "ยังไม่ได้ต่อสาย"} — flip-flop ต้องมีสัญญาณนาฬิกา จึงข้ามการสร้างวงจรนี้`);
				return null;
			}
			return v;
		};
		/* CLR / PRE tied to a CONSTANT is ordinary schematic practice, and the two levels
		   say opposite things. These pins are ACTIVE HIGH here, so:
		     GND ('0') — held inactive. That is the classic ISE tie-off for an async pin you
		                 do not want; the branch simply is not emitted, and the register is
		                 a plain one. Worth saying once, but nothing is wrong.
		     VCC ('1') — held asserted forever, so the register can never change: the output
		                 is a constant. `heldAsync` records it and the caller emits that
		                 constant instead of a process that cannot do anything.
		   Either way the literal must never reach the returned value: it would land in
		   process(...) where VHDL accepts signal names only, and the file would not parse. */
		const heldAsync = [];
		const asyncCtrl = (pid, enabled) => {
			if (!enabled) return null;
			const v = driver(c.id, pid);
			if (!v) { warns.push(`${compDisplay(c)} เปิด async ${pid} แต่ขา ${pid} ไม่ได้ต่อสาย — ข้าม ${pid} ในโค้ด`); return null; }
			if (isLit(v)) {
				if (/'1'/.test(v)) heldAsync.push(pid);
				else warns.push(`${compDisplay(c)} ขา '${pid}' ต่อไว้กับ GND — async ${pid} จึงไม่ทำงานตลอด (เท่ากับไม่เปิดใช้) — ถูกต้องตามแบบ tie-off`);
				return null;
			}
			return v;
		};
		/* Q̄ is usually left unconnected on a drawing; declaring and driving it anyway only
		   adds "unused signal" noise to the Vivado log, so drop it when nothing reads it. */
		const ffQn = () => {
			const used = sch.wires.some(w => w.from.cid === c.id && w.from.pid === "qn");
			if (!used) delete c._nets.qn;
			return used ? c._nets.qn : null;
		};
		/* A CLR/PRE wired to VCC never releases — Q is stuck at the value that pin forces.
		   Emitting the register anyway would be a lie (and Vivado would optimise it away),
		   so drive the constant and say why. Reset wins over preset, as in the process. */
		const holdOutputs = () => {
			const q = heldAsync.includes("rst") ? "0" : "1";
			const qn = q === "0" ? "1" : "0";
			const pin = heldAsync.includes("rst") ? "rst" : "pre";
			warns.push(`${compDisplay(c)} ขา '${pin}' ต่อไว้กับ VCC — async ${pin} ทำงานค้างตลอด flip-flop จึงถูกกดค้างที่ Q='${q}' ไม่จำค่าอะไรเลย`);
			concurrent.push(`  ${c._nets.q} <= '${q}';`);
			const QN = ffQn();
			if (QN) concurrent.push(`  ${QN} <= '${qn}';`);
		};
		// when a flip-flop is skipped, still give its outputs a defined value so the rest
		// of the design elaborates instead of collapsing into undriven-signal noise
		const tieOffOutputs = () => {
			Object.keys(c._nets || {}).forEach(pid => concurrent.push(`  ${c._nets[pid]} <= ${zlit((c._netW && c._netW[pid]) || 1)};`));
		};
		/* AMD UG901: most current FPGA families (Spartan-7 included) give a register ONE
		   asynchronous control. Asking for async reset AND preset costs extra logic or
		   fails outright, so say it out loud rather than emitting a register that will
		   not map. */
		const warnBothAsync = (RST, PRE) => {
			if (RST && PRE) warns.push(`${compDisplay(c)} เปิดทั้ง async reset และ preset พร้อมกัน — FPGA (Spartan-7) มี async control ได้ทางเดียว ควรเลือกอย่างใดอย่างหนึ่ง`);
		};

		/* ----- gates ----- */
		if (["AND", "OR", "NAND", "NOR", "XOR", "XNOR", "NOT", "BUF"].includes(c.type)) {
			/* On a WIDE gate every operand must be exactly that wide: VHDL has no
			   "vector and bit". A single bit arriving at a wide gate is the ordinary
			   idiom — one select or enable line masking a whole byte — so replicate it
			   across the width, written as a qualified aggregate so no tool has to guess
			   the type. An unwired pin is handled here too: `(others => '0')` is not
			   legal as an operand on its own. */
			const gw = gateWidth(c.params || {});
			const ins = inputsPorts.map(p => {
				const v = driverFor(p.id);
				if (gw < 2) return v;
				if (/^\(others\s*=>\s*'0'\)$/.test(v)) return `std_logic_vector'(${gw - 1} downto 0 => '0')`;
				// driverFor() already widened a constant rail to the pin width — a second
				// wrap would put a vector in the element position of the aggregate
				if (/^std_logic_vector'\(/.test(v)) return v;
				return (driverWidth(c.id, p.id) || 1) > 1 ? v : `std_logic_vector'(${gw - 1} downto 0 => ${v})`;
			});
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
		/* ----- BUS TAP: one bit in or out of a bus ----- */
		if (c.type === "BUSTAP") {
			const bit = c.params.bit ?? 0;
			const width = Math.max(1, c.params.width || 1);
			const hi = bit + width - 1;
			const sw = driverWidth(c.id, "d");   // real bus width, traced live
			if (c.params.mode === "merge") {
				// the bus is assembled FROM taps: write this bit range. Handled with the
				// output assignments below (busMerges) so it lands after the bus signal exists.
				const v = driver(c.id, "y");
				const busSig = busSignalOf(c);
				if (!busSig) warns.push(`${compDisplay(c)} ยังไม่ได้เกาะกับสายบัส`);
				else if (!v) warns.push(`${compDisplay(c)} ยังไม่มีสัญญาณเข้าขาบิต`);
				else {
					const ceiling = fixedWidthOf[busSig];
					// the bus has no driving port, so its width comes from the net itself;
					// writing a bit it does not have is an out-of-range index
					const bw = (mergeBusInfo(sch, c) || {}).width;
					if (ceiling !== undefined && hi >= ceiling) {
						warns.push(`${compDisplay(c)} บิต ${width > 1 ? `${hi}:${bit}` : bit} เกินความกว้างของขา '${busSig}' (0..${ceiling - 1}) — ไม่ถูกต่อ`);
					} else if (bw && hi > bw - 1) {
						warns.push(`${compDisplay(c)} แตะบิต ${width > 1 ? `${hi}:${bit}` : bit} แต่บัสมีแต่ (${bw - 1}:0)`);
					} else {
						const set = busMergeBits[busSig] || (busMergeBits[busSig] = new Set());
						let dup = false;
						for (let i = bit; i <= hi; i++) {
							if (set.has(i)) dup = true;
							set.add(i);
						}
						if (dup) warns.push(`${compDisplay(c)} เขียนบิต ${width > 1 ? `${hi}:${bit}` : bit} ของ '${busSig}' ซ้ำกับ tap อื่น — จะกลายเป็น multiple driver`);
						busMerges.push(width > 1 ? `  ${busSig}(${hi} downto ${bit}) <= ${widenConst(v, width)};` : `  ${busSig}(${bit}) <= ${v};`);
					}
				}
				return;
			}
			const src = driver(c.id, "d");
			let expr = null;
			if (!src) warns.push(`${compDisplay(c)} ยังไม่ได้เกาะกับสายบัส — ใช้ค่า '0' แทน`);
			else if (!sw || sw <= 1) warns.push(`${compDisplay(c)} ต้องเกาะกับสายบัส (กว้าง > 1 bit) แต่ได้สัญญาณ ${sw || 1} bit — ใช้ค่า '0' แทน`);
			else if (hi > sw - 1) warns.push(`${compDisplay(c)} เลือกบิต (${width > 1 ? `${hi}:${bit}` : bit}) เกินช่วงบัสต้นทาง (${sw - 1}:0) — ใช้ค่า '0' แทน`);
			else expr = width > 1 ? `${src}(${hi} downto ${bit})` : `${src}(${bit})`;
			concurrent.push(`  ${c._nets.y} <= ${expr || zlit(width)};`);
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
			const CLK = ffClock();
			if (!CLK) { tieOffOutputs(); return; }      // no clock → emit nothing unparseable
			const RST = asyncCtrl("rst", c.params.reset);
			const PRE = asyncCtrl("pre", c.params.preset);
			warnBothAsync(RST, PRE);
			if (heldAsync.length) { holdOutputs(); return; }   // CLR/PRE on VCC — Q is a constant
			const D = driverFor("d");
			const QN = ffQn();
			const set2 = (q, qn) => `      ${c._nets.q}  <= ${q};` + (QN ? `\n      ${QN} <= ${qn};` : "");
			processes.push({
				clk: CLK, edge: c.params.edge,
				rst: RST, pre: PRE,
				body: set2(D, `not (${D})`),
				rstAssign: set2("'0'", "'1'"),
				preAssign: set2("'1'", "'0'"),
			});
			return;
		}
		/* ----- JK-FF ----- */
		if (c.type === "JKFF") {
			const CLK = ffClock();
			if (!CLK) { tieOffOutputs(); return; }
			const RST = asyncCtrl("rst", c.params.reset);
			const PRE = asyncCtrl("pre", c.params.preset);
			warnBothAsync(RST, PRE);
			if (heldAsync.length) { holdOutputs(); return; }
			const J = driverFor("j");
			const K = driverFor("k");
			const QN = ffQn();
			const qsig = c._nets.q;
			const put = (q, qn) => `      ${qsig} <= ${q};` + (QN ? ` ${QN} <= ${qn};` : "");
			// J/K wired to constants (VCC/GND/CONST) is how a toggle/counter stage is drawn —
			// resolve it here so the student reads "q <= not q" instead of three dead
			// branches guarded by true/false
			let body;
			if (isLit(J) && isLit(K)) {
				const j1 = /'1'/.test(J), k1 = /'1'/.test(K);
				body = (j1 && k1) ? put(`not ${qsig}`, qsig)
					: (j1 && !k1) ? put("'1'", "'0'")
						: (!j1 && k1) ? put("'0'", "'1'")
							: "      null;   -- J=K='0' → hold";
			} else {
				// qn is assigned in every branch from the same pre-edge value of q,
				// so q/qn always stay complementary after the edge
				body =
					`      if    (${eq(J, 0)} and ${eq(K, 1)}) then ${put("'0'", "'1'").trim()}
      elsif (${eq(J, 1)} and ${eq(K, 0)}) then ${put("'1'", "'0'").trim()}
      elsif (${eq(J, 1)} and ${eq(K, 1)}) then ${put(`not ${qsig}`, qsig).trim()}
      end if;`;
			}
			processes.push({
				clk: CLK, edge: c.params.edge,
				rst: RST, pre: PRE, body,
				rstAssign: `      ${qsig} <= '0';` + (QN ? `\n      ${QN} <= '1';` : ""),
				preAssign: `      ${qsig} <= '1';` + (QN ? `\n      ${QN} <= '0';` : "")
			});
			return;
		}
		/* ----- T-FF ----- */
		if (c.type === "TFF") {
			const CLK = ffClock();
			if (!CLK) { tieOffOutputs(); return; }
			const RST = asyncCtrl("rst", c.params.reset);
			const PRE = asyncCtrl("pre", c.params.preset);
			warnBothAsync(RST, PRE);
			if (heldAsync.length) { holdOutputs(); return; }
			const T = driverFor("t");
			const QN = ffQn();
			const qsig = c._nets.q;
			// on a toggle both read the OLD q: new q = not q, new qn = old q = not(new q)
			const tog = `${qsig} <= not ${qsig};` + (QN ? ` ${QN} <= ${qsig};` : "");
			const body = isLit(T)
				? (/'1'/.test(T) ? `      ${tog}` : "      null;   -- T='0' → hold")
				: `      if (${eq(T, 1)}) then ${tog} end if;`;
			processes.push({
				clk: CLK, edge: c.params.edge,
				rst: RST, pre: PRE, body,
				rstAssign: `      ${qsig} <= '0';` + (QN ? `
      ${QN} <= '1';` : ""),
				preAssign: `      ${qsig} <= '1';` + (QN ? `
      ${QN} <= '0';` : ""),
			});
			return;
		}
		/* ----- SR-FF ----- */
		if (c.type === "SRFF") {
			const CLK = ffClock();
			if (!CLK) { tieOffOutputs(); return; }
			const RST = asyncCtrl("rst", c.params.reset);
			const PRE = asyncCtrl("pre", c.params.preset);
			warnBothAsync(RST, PRE);
			if (heldAsync.length) { holdOutputs(); return; }
			const S = driverFor("s");
			const R = driverFor("r");
			const QN = ffQn();
			const qsig = c._nets.q;
			const put = (q, qn) => `${qsig} <= ${q};` + (QN ? ` ${QN} <= ${qn};` : "");
			let body;
			if (isLit(S) && isLit(R)) {
				const s1 = /'1'/.test(S), r1 = /'1'/.test(R);
				body = (s1 && !r1) ? `      ${put("'1'", "'0'")}`
					: (!s1 && r1) ? `      ${put("'0'", "'1'")}`
						: "      null;   -- S/R เป็นค่าคงที่ที่ไม่เปลี่ยนสถานะ → hold";
			} else {
				body =
					`      if    (${eq(S, 1)} and ${eq(R, 0)}) then ${put("'1'", "'0'")}
      elsif (${eq(S, 0)} and ${eq(R, 1)}) then ${put("'0'", "'1'")}
      end if;`;
			}
			processes.push({
				clk: CLK, edge: c.params.edge,
				rst: RST, pre: PRE, body,
				rstAssign: `      ${qsig} <= '0';` + (QN ? `\n      ${QN} <= '1';` : ""),
				preAssign: `      ${qsig} <= '1';` + (QN ? `\n      ${QN} <= '0';` : "")
			});
			return;
		}
		/* ----- COMPARATORS -----
		   The operands are QUALIFIED (`unsigned'(a1 & a0)`) rather than plain conversions:
		   a bare concatenation has no type of its own, and an unqualified `(others => '0')`
		   on one side of a comparison is the exact shape that made Vivado report an
		   ambiguous "=" before. One-bit comparisons skip the array form altogether and go
		   through eq(), which folds a constant driver instead of writing '0' = '1'. */
		if (c.type === "COMP" || c.type === "COMPM") {
			const isLit = v => typeof v === "string" && (/^'[01]'$/.test(v) || /^\(others\s*=>\s*'[01]'\)$/.test(v));
			const eq = (v, bit) => {
				if (!isLit(v)) return `${v} = '${bit}'`;
				const one = /'1'/.test(v);
				return (one === (String(bit) === "1")) ? "true" : "false";
			};
			const mag = c.type === "COMPM";
			const n = Math.max(1, c.params.width || 2);
			const outs = mag ? ["gt", "lt"] : ["eq"];
			const tie = () => outs.forEach(pid => concurrent.push(`  ${c._nets[pid]} <= '0';`));
			let A, B, arr;
			if (cmpIsBus(c.params)) {
				const av = (c._nets && c._nets.a) || driver(c.id, "a");
				const bv = (c._nets && c._nets.b) || driver(c.id, "b");
				if (!av || !bv || isLit(av) || isLit(bv)) {
					warns.push(`${compDisplay(c)} ยังต่อขา A/B ไม่ครบ — ผลลัพธ์ถูกตรึงเป็น '0'`);
					tie(); return;
				}
				A = av; B = bv; arr = true;
			} else if (n === 1) {
				A = driverFor("a0"); B = driverFor("b0"); arr = false;
			} else {
				const side = pre => { const bits = []; for (let i = n - 1; i >= 0; i--) bits.push(driverFor(pre + i)); return bits.join(" & "); };
				A = side("a"); B = side("b"); arr = true;
			}
			// numeric_std defines < and > for unsigned, NOT for std_logic_vector — a bare
			// `aa > bb` does not compile in Vivado. A bus operand is CONVERTED; a raw
			// concatenation is QUALIFIED, since it has no type of its own to convert from.
			const q = v => cmpIsBus(c.params) ? `unsigned(${v})` : `unsigned'(${v})`;
			const sv = v => cmpIsBus(c.params) ? v : `std_logic_vector'(${v})`;
			if (!mag) {
				const cond = arr ? `${sv(A)} = ${sv(B)}`
					: (isLit(A) && isLit(B) ? (A === B ? "true" : "false") : `${A} = ${B}`);
				concurrent.push(`  ${c._nets.eq} <= '1' when ${cond} else '0';`);
			} else if (arr) {
				concurrent.push(`  ${c._nets.gt} <= '1' when ${q(A)} > ${q(B)} else '0';`);
				concurrent.push(`  ${c._nets.lt} <= '1' when ${q(A)} < ${q(B)} else '0';`);
			} else {
				// 1 bit: A>B is A=1 and B=0
				concurrent.push(`  ${c._nets.gt} <= '1' when ${eq(A, 1)} and ${eq(B, 0)} else '0';`);
				concurrent.push(`  ${c._nets.lt} <= '1' when ${eq(A, 0)} and ${eq(B, 1)} else '0';`);
			}
			return;
		}
		/* ----- Temporary Block (stub instantiation — user supplies the entity body) ----- */
		if (c.type === "TEMPBLOCK") {
			const maps = [];
			portsArr.forEach(p => {
				if (p.dir === "in") {
					const v = c._nets[p.id] || driver(c.id, p.id);
					if (!v) warns.push(`${compDisplay(c)} ขา '${p.label}' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน`);
					maps.push(`${p.label} => ${v ? widenConst(v, p.width || 1) : zlit(p.width)}`);
				} else {
					maps.push(`${p.label} => ${c._nets[p.id]}`);
				}
			});
			const entity = sanId(c.params.entity || "temp_block");
			subInstances.push({ entity, inst: c.id, label: c.label || "", maps, _tempPorts: portsArr.map(p => ({ name: p.label, dir: p.dir, width: p.width })) });
			return;
		}
		/* ----- Custom component (component instantiation) ----- */
		if (c.type.startsWith("CUSTOM:")) {
			const td = typeDef(c);
			const cc = td._custom;
			const maps = [];
			customPorts(cc).forEach(p => {
				if (p.dir === "in") {
					const v = c._nets[p.name] || driver(c.id, p.name);
					if (!v) warns.push(`${compDisplay(c)} ขา '${p.name}' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน`);
					maps.push(`${p.name} => ${v ? widenConst(v, p.width || 1) : zlit(p.width)}`);
				} else {
					maps.push(`${p.name} => ${c._nets[p.name]}`);
				}
			});
			subInstances.push({ entity: sanId(cc.name), inst: c.id, label: c.label || "", maps });
			return;
		}
		/* ----- Sub-schematic instance ----- */
		if (c.type.startsWith("SCH:")) {
			const td = typeDef(c);
			const subSch = td._sch;
			const maps = [];
			td.ports({}).forEach(p => {
				if (p.dir === "in") {
					const v = c._nets[p.id] || driver(c.id, p.id);
					if (!v) warns.push(`${compDisplay(c)} ขา '${p.id}' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน`);
					maps.push(`${p.id} => ${v ? widenConst(v, p.width || 1) : zlit(p.width)}`);
				} else {
					maps.push(`${p.id} => ${c._nets[p.id]}`);
				}
			});
			subInstances.push({ entity: sanId(subSch.name), inst: c.id, label: c.label || "", maps });
			return;
		}
	});

	// output assignments
	const outLines = [];
	outputs.forEach(c => {
		const v = driver(c.id, "i");
		// a bus built up bit by bit by merge taps has no single driver — the taps ARE
		// its drivers. They write the bus's own signal, so the port takes a copy of it.
		const viaBus = outBusSig.get(c.id);
		if (viaBus && busMergeBits[viaBus]) { outLines.push(`  ${c._net} <= ${viaBus};`); return; }
		if (!v) { warns.push(`OUTPUT '${c._net}' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน`); outLines.push(`  ${c._net} <= ${zlit(c.params.width)};`); }
		else outLines.push(`  ${c._net} <= ${widenConst(v, c.params.width || 1)};`);
	});
	busMerges.forEach(l => outLines.push(l));

	// a gap in a merge group (e.g. taps for bits 0,1,3 but nothing for bit 2)
	// leaves that bit undriven — surface it like any other incomplete wiring
	Object.keys(busMergeBits).forEach(sig => {
		const bits = busMergeBits[sig];
		const max = Math.max(...bits);
		for (let i = 0; i < max; i++) if (!bits.has(i)) warns.push(`บิต ${i} ของ '${sig}' ไม่มี tap ต่อ — สัญญาณจะไม่ถูก drive ครบ`);
	});

	/* ---- assemble ---- */
	const portDecls = [];
	inputs.forEach(c => {
		const t = c.params.width > 1 ? `STD_LOGIC_VECTOR(${c.params.width - 1} downto 0)` : "STD_LOGIC";
		portDecls.push(`    ${c._net} : in  ${t}`);
	});
	outputs.forEach(c => {
		const w = inferredWidth(outBusSig.get(c.id) || c._net, c.params.width);
		const t = w > 1 ? `STD_LOGIC_VECTOR(${w - 1} downto 0)` : "STD_LOGIC";
		portDecls.push(`    ${c._net} : out ${t}`);
	});

	// flip-flop state nets get per-signal power-up initializers (q=0, qn=1)
	// so synthesis/simulation start from a defined state without a reset port.
	const ffInit = {};
	inners.forEach(c => {
		if (c.type !== "DFF" && c.type !== "JKFF" && c.type !== "TFF" && c.type !== "SRFF") return;
		if (!c._nets) return;
		if (c._nets.q) ffInit[c._nets.q] = "0";
		if (c._nets.qn) ffInit[c._nets.qn] = "1";
	});

	// collect internal signals (scalars grouped, vectors declared individually)
	const sigScalars = [];
	const sigVectors = [];
	busNets.forEach(b => { sigVectors.push({ name: b.name, w: inferredWidth(b.name, b.w) }); });
	inners.forEach(c => {
		if (c.type === "JUNCTION" && c._busSig) { sigVectors.push({ name: c._busSig, w: inferredWidth(c._busSig, c._busW) }); return; }
		if (!c._nets) return;
		Object.keys(c._nets).forEach(pid => {
			const baseW = (c._netW && c._netW[pid]) || 1;
			const wdt = inferredWidth(c._nets[pid], baseW);
			if (wdt > 1) sigVectors.push({ name: c._nets[pid], w: wdt });
			else if (!ffInit[c._nets[pid]]) sigScalars.push(c._nets[pid]);
		});
	});

	// component declarations for sub-entities used (match by sanitized name)
	const compDecls = [];
	const seen = new Set();
	subInstances.forEach(si => {
		if (seen.has(si.entity)) return;
		seen.add(si.entity);
		if (si._tempPorts) { compDecls.push(formatComponentDecl(si.entity, si._tempPorts)); return; }
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
	const ffInits = Object.keys(ffInit);
	ffInits.forEach(n => { code += `  signal ${n} : STD_LOGIC := '${ffInit[n]}';\n`; });
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
			const inst = instLabel.get(si.inst) || `u_${idx}_${si.inst}`;
			// a port-less instance takes no port map clause — "port map ( )" is invalid
			if (!si.maps.length) { code += `  ${inst} : ${si.entity};\n`; return; }
			code += `  ${inst} : ${si.entity} port map (\n    ` +
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
		syncSelTitle(sel);
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
	syncSelTitle(ev.target);
	showVhdlFor(ev.target.value);
});
/* the entity box is narrow enough to clip its longest label — keep the whole thing
   readable on hover, and follow the selection */
function syncSelTitle(sel) {
	if (!sel) return;
	const o = sel.options[sel.selectedIndex];
	sel.title = o ? o.text : "";
}
/* base64 an arbitrary UTF-8 string (schematic JSON can contain Thai labels) —
   chunk-free: ids/coords stay small so this never hits a call-stack limit. */
function utf8ToB64(s) {
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	bytes.forEach(b => { bin += String.fromCharCode(b); });
	return btoa(bin);
}
/* Wrap the WHOLE project (every schematic, every custom, and the top id) as a
   base64 blob inside a plain VHDL comment block — Vivado ignores it entirely, but
   Import VHDL recognizes the markers and restores the exact drawing instead of
   re-deriving one from the code. Never let a stamping failure break the export. */
function layoutStamp() {
	try {
		const p = state.project;
		const payload = { v: 1, schematics: Object.values(p.schematics), customs: p.customs || {}, topId: p.topId };
		// dropScratch, or every exported .vhd carries the net names of the last run
		const b64 = utf8ToB64(JSON.stringify(payload, dropScratch));
		return ["",
			"-- ============================================================",
			"-- Schematic Studio — ข้อมูลการจัดวางวงจร (layout)",
			"-- เป็นคอมเมนต์ล้วน ไม่มีผลต่อการสังเคราะห์: Vivado ข้ามทั้งบล็อกนี้",
			"-- มีไว้ให้ Import VHDL กลับแล้วได้ gate เดิมและตำแหน่งเดิม (อย่าแก้ด้วยมือ)",
			LAYOUT_TAG_BEGIN,
			...(b64.match(/.{1,76}/g) || [b64]).map(l => "-- " + l),
			LAYOUT_TAG_END, ""].join("\n");
	} catch (e) { return ""; }         // never let the stamp break an export
}
function exportVhdlFile() {
	if (!_lastAllVhdl) generateVHDL();
	const code = $("#vhdlOutput").dataset.raw || "";
	if (!code) { toast("ยังไม่มีโค้ดให้ดาวน์โหลด — กด Generate VHDL ก่อน", "warn"); return; }
	const v = $("#vhdlEntitySel").value || "top";
	let fname;
	if (v === "__all__") fname = dlName(state.project.name || "project", "_all.vhd", "project");
	else fname = dlName(v, ".vhd", "top");
	const b = new Blob([code + layoutStamp()], { type: "text/plain" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u; a.download = fname; a.click();
	URL.revokeObjectURL(u);
	toast("Downloaded " + fname + " (แนบการจัดวางไว้ในคอมเมนต์ — import กลับได้เหมือนเดิม)", "ok", 3600);
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
	a.href = u; a.download = dlName($("#projectName").value, "_all.vhd", "project"); a.click();
	URL.revokeObjectURL(u);
}
