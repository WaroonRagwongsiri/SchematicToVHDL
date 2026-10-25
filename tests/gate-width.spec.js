// @ts-check
const path = require("path");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");

const APP_URL = pathToFileURL(path.resolve(__dirname, "..", "schematic2vhdl.html")).toString();

test.beforeEach(async ({ page }) => {
	await page.goto(APP_URL);
	// init() runs synchronously from a deferred <script>, so by the time `load`
	// fires (what goto() waits for) the demo half-adder is already seeded.
	await page.waitForFunction(() => typeof window.addComp === "function" && typeof window.activeSch === "function");
});

test("wide AND gate gets N-bit ports and the bit-range tag", async ({ page }) => {
	const id = await page.evaluate(() => addComp("AND", 500, 400));

	await page.locator('#inspectorPane input[data-pk="inputs"]').fill("3");
	await page.locator('#inspectorPane input[data-pk="inputs"]').dispatchEvent("change");

	await page.locator('#inspectorPane input[data-pk="width"]').fill("8");
	await page.locator('#inspectorPane input[data-pk="width"]').dispatchEvent("change");

	const result = await page.evaluate((cid) => {
		const sch = activeSch();
		const c = comp(cid, sch);
		return {
			inputs: c.params.inputs,
			width: c.params.width,
			ports: TYPES.AND.ports(c.params),
			shape: TYPES.AND.shape(c.params),
		};
	}, id);

	expect(result.inputs).toBe(3);
	expect(result.width).toBe(8);
	expect(result.ports).toHaveLength(4); // 3 inputs + 1 output
	expect(result.ports.every((p) => p.width === 8)).toBe(true);
	expect(result.shape).toContain("7:0");

	// the tag actually landed in the rendered SVG, not just in the raw shape() string
	await expect(page.locator("#canvas")).toContainText("7:0");
});

test("a 1-bit signal driving a wide gate pin is legal and replicated in VHDL", async ({ page }) => {
	const ids = await page.evaluate(() => {
		const sch = activeSch();
		sch.components = [];
		sch.wires = [];
		const sel = { id: uid("c"), type: "IN", x: 50, y: 50, params: { name: "sel", width: 1 } };
		const databus = { id: uid("c"), type: "IN", x: 50, y: 150, params: { name: "databus", width: 8 } };
		const gate = { id: uid("c"), type: "AND", x: 250, y: 100, params: { inputs: 2, width: 8 } };
		const y = { id: uid("c"), type: "OUT", x: 450, y: 100, params: { name: "y", width: 8 } };
		sch.components.push(sel, databus, gate, y);
		sch.wires.push(
			{ id: uid("w"), from: { cid: sel.id, pid: "o" }, to: { cid: gate.id, pid: "i0" }, name: "" },
			{ id: uid("w"), from: { cid: databus.id, pid: "o" }, to: { cid: gate.id, pid: "i1" }, name: "" },
			{ id: uid("w"), from: { cid: gate.id, pid: "o" }, to: { cid: y.id, pid: "i" }, name: "" }
		);
		state.selection.clear();
		renderAll();
		return { gate: gate.id };
	});

	const issues = await page.evaluate(() => runSynthesis());
	const widthMismatch = issues.filter(
		(i) => i.lvl === "err" && i.cid === ids.gate && /ความกว้างบัสไม่ตรงกัน/.test(i.msg)
	);
	expect(widthMismatch).toHaveLength(0);

	const all = await page.evaluate(() => generateVHDL());
	const entry = Object.values(all)[0];
	const code = typeof entry === "string" ? entry : entry.code;

	expect(code).toMatch(/std_logic_vector'\(7 downto 0 => \w+\)/);
	expect(code).toMatch(/<=\s*\(?std_logic_vector'\(7 downto 0 => \w+\)\s+and\s+\w+\)?;/);
});

test("a plain 1-bit gate (no width set) is unaffected — no tag, no replication", async ({ page }) => {
	const ids = await page.evaluate(() => {
		const sch = activeSch();
		sch.components = [];
		sch.wires = [];
		const a = { id: uid("c"), type: "IN", x: 50, y: 50, params: { name: "a", width: 1 } };
		const b = { id: uid("c"), type: "IN", x: 50, y: 150, params: { name: "b", width: 1 } };
		const gate = { id: uid("c"), type: "AND", x: 250, y: 100, params: { inputs: 2 } };
		const y = { id: uid("c"), type: "OUT", x: 450, y: 100, params: { name: "y", width: 1 } };
		sch.components.push(a, b, gate, y);
		sch.wires.push(
			{ id: uid("w"), from: { cid: a.id, pid: "o" }, to: { cid: gate.id, pid: "i0" }, name: "" },
			{ id: uid("w"), from: { cid: b.id, pid: "o" }, to: { cid: gate.id, pid: "i1" }, name: "" },
			{ id: uid("w"), from: { cid: gate.id, pid: "o" }, to: { cid: y.id, pid: "i" }, name: "" }
		);
		state.selection.clear();
		renderAll();
		return { gate: gate.id };
	});

	const info = await page.evaluate((cid) => {
		const sch = activeSch();
		const c = comp(cid, sch);
		return { ports: TYPES.AND.ports(c.params), shape: TYPES.AND.shape(c.params) };
	}, ids.gate);

	expect(info.ports.every((p) => p.width === 1)).toBe(true);
	expect(info.shape).not.toContain(":0");

	const all = await page.evaluate(() => generateVHDL());
	const entry = Object.values(all)[0];
	const code = typeof entry === "string" ? entry : entry.code;
	expect(code).not.toContain("std_logic_vector'(");
});

test("Bus Tap width param clamps against the live bus width, like bit already does", async ({ page }) => {
	const ids = await page.evaluate(() => {
		const sch = activeSch();
		sch.components = [];
		sch.wires = [];
		const databus = { id: uid("c"), type: "IN", x: 50, y: 50, params: { name: "databus", width: 8 } };
		const tap = { id: uid("c"), type: "BUSTAP", x: 250, y: 50, params: { bit: 6, width: 1, dir: "right", mode: "split" } };
		sch.components.push(databus, tap);
		sch.wires.push({ id: uid("w"), from: { cid: databus.id, pid: "o" }, to: { cid: tap.id, pid: "d" }, name: "" });
		state.selection = new Set([tap.id]);
		renderAll();
		return { tap: tap.id };
	});

	// bit=6 on an 8-bit bus leaves only 2 bits (6,7) for this tap to claim
	await page.locator('#inspectorPane input[data-pk="width"]').fill("4");
	await page.locator('#inspectorPane input[data-pk="width"]').dispatchEvent("change");

	const width = await page.evaluate((cid) => comp(cid, activeSch()).params.width, ids.tap);
	expect(width).toBeLessThanOrEqual(2);
});
