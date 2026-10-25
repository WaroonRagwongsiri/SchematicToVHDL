// @ts-check
const path = require("path");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");

const APP_URL = pathToFileURL(path.resolve(__dirname, "..", "schematic2vhdl.html")).toString();

test.beforeEach(async ({ page }) => {
	await page.goto(APP_URL);
	await page.waitForFunction(() => typeof window.addComp === "function" && typeof window.activeSch === "function");
	// tiny builders shared by every test: a sheet from {name: comp} and [from, fromPin, to, toPin]
	await page.evaluate(() => {
		window.mk = (sch, parts, wires) => {
			const ids = {};
			Object.keys(parts).forEach((k, i) => {
				const c = Object.assign({ id: uid("c"), x: 50 + 100 * i, y: 50 + 40 * i, params: {} }, parts[k]);
				sch.components.push(c); ids[k] = c;
			});
			wires.forEach(([a, ap, b, bp]) => sch.wires.push({ id: uid("w"), from: { cid: ids[a].id, pid: ap }, to: { cid: ids[b].id, pid: bp }, name: "" }));
			return ids;
		};
		window.newSheet = name => {
			const id = uid("sch"), sch = blankSchematic(id, name);
			state.project.schematics[id] = sch;
			return sch;
		};
		window.topSheet = () => {
			const sch = state.project.schematics[state.project.topId];
			sch.components = []; sch.wires = [];
			return sch;
		};
		window.codeOf = name => {
			const e = generateAllVhdl()[name];
			return typeof e === "string" ? e : e.code;
		};
	});
});

test("feedback through a fully registered sub-block is not a combinational loop", async ({ page }) => {
	const r = await page.evaluate(() => {
		const acc = newSheet("acc");
		mk(acc, {
			d: { type: "IN", params: { name: "d", width: 1 } },
			clk: { type: "IN", params: { name: "clk", width: 1 } },
			ff: { type: "DFF", params: { edge: "rising" } },
			q: { type: "OUT", params: { name: "q", width: 1 } },
		}, [["d", "o", "ff", "d"], ["clk", "o", "ff", "clk"], ["ff", "q", "q", "i"]]);
		const alu = newSheet("alu");
		mk(alu, {
			a: { type: "IN", params: { name: "a", width: 1 } },
			g: { type: "NOT", params: {} },
			y: { type: "OUT", params: { name: "y", width: 1 } },
		}, [["a", "o", "g", "i0"], ["g", "o", "y", "i"]]);
		const top = topSheet();
		mk(top, {
			clk: { type: "IN", params: { name: "clk", width: 1 } },
			A: { type: "SCH:" + acc.id },
			L: { type: "SCH:" + alu.id },
			o: { type: "OUT", params: { name: "o", width: 1 } },
		}, [["clk", "o", "A", "clk"], ["A", "q", "L", "a"], ["L", "y", "A", "d"], ["A", "q", "o", "i"]]);
		const regLoop = combinationalLoops(top).length;
		// the same feedback through two COMBINATIONAL blocks is still a loop
		const alu2 = newSheet("alu2");
		mk(alu2, {
			a: { type: "IN", params: { name: "a", width: 1 } },
			g: { type: "NOT", params: {} },
			y: { type: "OUT", params: { name: "y", width: 1 } },
		}, [["a", "o", "g", "i0"], ["g", "o", "y", "i"]]);
		const s2 = newSheet("loopy");
		mk(s2, {
			L1: { type: "SCH:" + alu.id },
			L2: { type: "SCH:" + alu2.id },
		}, [["L1", "y", "L2", "a"], ["L2", "y", "L1", "a"]]);
		return { regLoop, combLoop: combinationalLoops(s2).length };
	});
	expect(r.regLoop).toBe(0);
	expect(r.combLoop).toBe(1);
});

test("a block whose sub-sheet was deleted is an error", async ({ page }) => {
	const issues = await page.evaluate(() => {
		const top = topSheet();
		mk(top, { X: { type: "SCH:sch_gone", label: "adder" } }, []);
		return runSynthesis();
	});
	const dead = issues.filter(i => i.lvl === "err" && /บล็อก 'adder' เรียก schematic ที่ไม่มีอยู่แล้ว/.test(i.msg));
	expect(dead).toHaveLength(1);
	expect(dead[0].cid).toBeTruthy();
});

test("merge taps: past the bus width, overlapping, and with no destination are errors", async ({ page }) => {
	const msgs = await page.evaluate(() => {
		const top = topSheet();
		mk(top, {
			a: { type: "IN", params: { name: "a", width: 1 } },
			b: { type: "IN", params: { name: "b", width: 1 } },
			c: { type: "IN", params: { name: "c", width: 1 } },
			j: { type: "JUNCTION", params: {} },
			t0: { type: "BUSTAP", params: { bit: 0, width: 1, mode: "merge", dir: "right" } },
			t1: { type: "BUSTAP", params: { bit: 0, width: 1, mode: "merge", dir: "right" } },
			t9: { type: "BUSTAP", params: { bit: 9, width: 1, mode: "merge", dir: "right" } },
			q: { type: "OUT", params: { name: "q", width: 4 } },
			j2: { type: "JUNCTION", params: {} },
			u: { type: "BUSTAP", params: { bit: 1, width: 1, mode: "merge", dir: "right" } },
		}, [
			["a", "o", "t0", "y"], ["b", "o", "t1", "y"], ["c", "o", "t9", "y"],
			["j", "j", "t0", "d"], ["j", "j", "t1", "d"], ["j", "j", "t9", "d"], ["j", "j", "q", "i"],
			["a", "o", "u", "y"], ["j2", "j", "u", "d"],
		]);
		return runSynthesis().filter(i => i.lvl === "err").map(i => i.msg);
	});
	expect(msgs.some(m => /แตะบิต 9 แต่บัสที่รวมเข้ากว้างแค่ \(3:0\)/.test(m))).toBe(true);
	expect(msgs.some(m => /แตะบิต 0 ทับกับ/.test(m))).toBe(true);
	expect(msgs.some(m => /รวมบิตเข้าไม่มีปลายทาง/.test(m))).toBe(true);
});

test("a merge bus into an OUTPUT that is also read gets an internal signal", async ({ page }) => {
	const code = await page.evaluate(() => {
		const top = topSheet();
		mk(top, {
			a: { type: "IN", params: { name: "a", width: 1 } },
			b: { type: "IN", params: { name: "b", width: 1 } },
			t0: { type: "BUSTAP", params: { bit: 0, width: 1, mode: "merge", dir: "right" } },
			t1: { type: "BUSTAP", params: { bit: 1, width: 1, mode: "merge", dir: "right" } },
			j: { type: "JUNCTION", params: {} },
			q: { type: "OUT", params: { name: "q", width: 2 } },
			g: { type: "NOT", params: { width: 2 } },
			nq: { type: "OUT", params: { name: "nq", width: 2 } },
		}, [
			["a", "o", "t0", "y"], ["b", "o", "t1", "y"],
			["j", "j", "t0", "d"], ["j", "j", "t1", "d"], ["j", "j", "q", "i"], ["j", "j", "g", "i0"],
			["g", "o", "nq", "i"],
		]);
		return codeOf(top.name);
	});
	expect(code).toMatch(/signal q_i : STD_LOGIC_VECTOR\(1 downto 0\);/);
	expect(code).toMatch(/q_i\(0\) <= a;/);
	expect(code).toMatch(/q <= q_i;/);
	expect(code).toMatch(/<= not q_i;/);
	expect(code).not.toMatch(/std_logic_vector'\(1 downto 0 => q_i\)/);
});

test("VCC into a wide sub-block pin is widened, and is not a width error", async ({ page }) => {
	const r = await page.evaluate(() => {
		const sub = newSheet("sub8");
		mk(sub, {
			d: { type: "IN", params: { name: "d", width: 8 } },
			y: { type: "OUT", params: { name: "y", width: 8 } },
		}, [["d", "o", "y", "i"]]);
		const top = topSheet();
		mk(top, {
			v: { type: "VCC" },
			S: { type: "SCH:" + sub.id },
			y: { type: "OUT", params: { name: "y", width: 8 } },
		}, [["v", "o", "S", "d"], ["S", "y", "y", "i"]]);
		const errs = runSynthesis().filter(i => i.lvl === "err" && /ความกว้างบัสไม่ตรงกัน/.test(i.msg));
		return { errs: errs.length, code: codeOf(top.name) };
	});
	expect(r.errs).toBe(0);
	expect(r.code).toContain("d => std_logic_vector'(7 downto 0 => '1')");
});

test("a port named like an instantiated sub-sheet is an error", async ({ page }) => {
	const issues = await page.evaluate(() => {
		const sub = newSheet("adder");
		mk(sub, { a: { type: "IN", params: { name: "a", width: 1 } }, y: { type: "OUT", params: { name: "y", width: 1 } } }, [["a", "o", "y", "i"]]);
		const top = topSheet();
		mk(top, {
			a: { type: "IN", params: { name: "a", width: 1 } },
			S: { type: "SCH:" + sub.id },
			o: { type: "OUT", params: { name: "adder", width: 1 } },
		}, [["a", "o", "S", "a"], ["S", "y", "o", "i"]]);
		return runSynthesis();
	});
	expect(issues.some(i => i.lvl === "err" && /พอร์ต 'adder' ชื่อเดียวกันกับ 'adder'/.test(i.msg))).toBe(true);
});

test("instance labels never collide with each other or a port; the stamp carries no scratch", async ({ page }) => {
	const r = await page.evaluate(() => {
		const sub = newSheet("buf1");
		mk(sub, { a: { type: "IN", params: { name: "a", width: 1 } }, y: { type: "OUT", params: { name: "y", width: 1 } } }, [["a", "o", "y", "i"]]);
		const top = topSheet();
		mk(top, {
			a: { type: "IN", params: { name: "u_adder_1", width: 1 } },
			S1: { type: "SCH:" + sub.id, label: "Adder 1" },
			S2: { type: "SCH:" + sub.id, label: "adder-1" },
			o1: { type: "OUT", params: { name: "o1", width: 1 } },
			o2: { type: "OUT", params: { name: "o2", width: 1 } },
		}, [["a", "o", "S1", "a"], ["a", "o", "S2", "a"], ["S1", "y", "o1", "i"], ["S2", "y", "o2", "i"]]);
		const code = codeOf(top.name);
		const stamp = readLayoutStamp(layoutStamp());
		const json = JSON.stringify(stamp);
		return { code, stamped: !!stamp, scratch: /"_(net|nets|netW|busSig|busNet|busW)"/.test(json) };
	});
	const insts = [...r.code.matchAll(/^\s+(\w+) : buf1 port map/gm)].map(m => m[1]);
	expect(insts).toHaveLength(2);
	expect(new Set(insts).size).toBe(2);
	expect(insts).not.toContain("u_adder_1");          // the port keeps its name
	expect(r.code).toMatch(/u_adder_1 : in\s+STD_LOGIC/);
	expect(r.stamped).toBe(true);
	expect(r.scratch).toBe(false);
});

test("a labelled block names its own signals", async ({ page }) => {
	const code = await page.evaluate(() => {
		const top = topSheet();
		mk(top, {
			a: { type: "IN", params: { name: "a", width: 1 } },
			g: { type: "NOT", params: {}, label: "carry" },
			n: { type: "NOT", params: {} },
			y: { type: "OUT", params: { name: "y", width: 1 } },
		}, [["a", "o", "g", "i0"], ["g", "o", "n", "i0"], ["n", "o", "y", "i"]]);
		return codeOf(top.name);
	});
	expect(code).toMatch(/signal [\w, ]*\bcarry_o\b[\w, ]*:/);
	expect(code).toMatch(/carry_o <= not /);
});

test("a net named like an instantiated sub-sheet moves aside for the component", async ({ page }) => {
	const code = await page.evaluate(() => {
		const sub = newSheet("adder");
		mk(sub, { a: { type: "IN", params: { name: "a", width: 1 } }, y: { type: "OUT", params: { name: "y", width: 1 } } }, [["a", "o", "y", "i"]]);
		const top = topSheet();
		mk(top, {
			a: { type: "IN", params: { name: "a", width: 1 } },
			g: { type: "NOT", params: {} },
			S: { type: "SCH:" + sub.id },
			o: { type: "OUT", params: { name: "o", width: 1 } },
		}, [["a", "o", "g", "i0"], ["g", "o", "S", "a"], ["S", "y", "o", "i"]]);
		top.wires.find(w => w.from.cid === top.components[1].id).name = "adder";
		return codeOf(top.name);
	});
	expect(code).toContain("component adder");
	expect(code).toMatch(/signal [\w, ]*\badder_1\b[\w, ]*:/);
	expect(code).not.toMatch(/signal [\w, ]*\badder\b[, ]/);
});
