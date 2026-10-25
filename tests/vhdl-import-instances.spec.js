// @ts-check
const path = require("path");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");

const APP_URL = pathToFileURL(path.resolve(__dirname, "..", "schematic2vhdl.html")).toString();

test.beforeEach(async ({ page }) => {
	await page.goto(APP_URL);
	await page.waitForFunction(() => typeof window.parseVhdl === "function" && typeof window.buildSchematicFromVhdl === "function");
});

test("wrapper VHDL with port maps imports as wired sub-block instances", async ({ page }) => {
	const r = await page.evaluate(() => {
		const mkSeg = (name, outName) => {
			const id = uid("sch");
			const s = blankSchematic(id, name);
			s.components.push(
				{ id: uid("c"), type: "IN", x: 50, y: 10, params: { name: "d0", width: 1 } },
				{ id: uid("c"), type: "IN", x: 50, y: 60, params: { name: "d1", width: 1 } },
				{ id: uid("c"), type: "OUT", x: 300, y: 10, params: { name: outName, width: 1 } }
			);
			state.project.schematics[id] = s;
			state.project.schOrder.push(id);
			return id;
		};
		const idA = mkSeg("ascii_segment_a", "a");
		const idB = mkSeg("ascii_segment_b", "b");
		const src = `
library ieee; use ieee.std_logic_1164.all;
entity wrap is
  port ( d0, d1 : in std_logic; a, b : out std_logic );
end wrap;
architecture rtl of wrap is
  component ascii_segment_a port ( d0, d1 : in std_logic; a : out std_logic ); end component;
  component ascii_segment_b port ( d0, d1 : in std_logic; b : out std_logic ); end component;
begin
  u_a : ascii_segment_a port map ( d0 => d0, d1 => d1, a => a );
  u_b : entity work.ascii_segment_b port map ( d0, d1, b );
end rtl;`;
		const ast = parseVhdl(src);
		const built = buildSchematicFromVhdl(ast);
		const byId = Object.fromEntries(built.comps.map(c => [c.id, c]));
		const inOf = n => built.comps.find(c => c.type === "IN" && c.params.name === n);
		const outOf = n => built.comps.find(c => c.type === "OUT" && c.params.name === n);
		const src_ = (cid, pid) => {
			const w = built.wires.find(w => w.to.cid === cid && w.to.pid === pid);
			return w ? { c: byId[w.from.cid], pid: w.from.pid } : null;
		};
		const blocks = built.comps.filter(c => c.type.startsWith("SCH:"));
		const boxes = built.comps.map(c => Object.assign({ x: c.x, y: c.y }, getSize(c)));
		let overlap = false;
		for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
			const p = boxes[i], q = boxes[j];
			if (p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h) overlap = true;
		}
		const blkA = blocks.find(b => b.type === "SCH:" + idA), blkB = blocks.find(b => b.type === "SCH:" + idB);
		return {
			nBlocks: blocks.length,
			labels: blocks.map(b => b.label).sort(),
			inputsOk: [blkA, blkB].every(b => b && ["d0", "d1"].every(p => { const s = src_(b.id, p); return s && s.c === inOf(p); })),
			outA: (s => s && s.c === blkA && s.pid === "a")(src_(outOf("a").id, "i")),
			outB: (s => s && s.c === blkB && s.pid === "b")(src_(outOf("b").id, "i")),
			unresolved: built.unresolved,
			warns: ast.warns,
			overlap,
		};
	});
	expect(r.nBlocks).toBe(2);
	expect(r.labels).toEqual(["a", "b"]);
	expect(r.inputsOk).toBe(true);
	expect(r.outA).toBe(true);
	expect(r.outB).toBe(true);
	expect(r.unresolved).toEqual([]);
	expect(r.warns).toEqual([]);
	expect(r.overlap).toBe(false);
});

test("an unknown instantiated entity warns instead of crashing", async ({ page }) => {
	const r = await page.evaluate(() => {
		const ast = parseVhdl(`
entity w is port ( x : in std_logic; y : out std_logic ); end w;
architecture rtl of w is begin
  u0 : no_such_block port map ( x => x, y => y );
end rtl;`);
		const built = buildSchematicFromVhdl(ast);
		return { warns: ast.warns, types: built.comps.map(c => c.type).sort() };
	});
	expect(r.warns.some(w => w.includes("no_such_block"))).toBe(true);
	expect(r.types).toEqual(["IN", "OUT"]);
});
