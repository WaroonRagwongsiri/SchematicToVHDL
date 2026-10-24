// @ts-check
const path = require("path");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");

const APP_URL = pathToFileURL(path.resolve(__dirname, "..", "schematic2vhdl.html")).toString();

test.beforeEach(async ({ page }) => {
	await page.goto(APP_URL);
	await page.waitForFunction(() => typeof window.addComp === "function" && typeof window.activeSch === "function");
});

test("rearranging pins on screen reorders the saved component array to match", async ({ page }) => {
	const result = await page.evaluate(() => {
		const sch = activeSch();
		sch.components = [];
		sch.wires = [];
		// created in this order (bottom-to-top) — the array starts out "wrong"
		const pinC = { id: uid("c"), type: "IN", x: 50, y: 300, params: { name: "bottom", width: 1 } };
		const pinA = { id: uid("c"), type: "IN", x: 50, y: 10, params: { name: "top", width: 1 } };
		const pinB = { id: uid("c"), type: "IN", x: 50, y: 150, params: { name: "middle", width: 1 } };
		const outX = { id: uid("c"), type: "OUT", x: 400, y: 200, params: { name: "second_out", width: 1 } };
		const outY = { id: uid("c"), type: "OUT", x: 400, y: 20, params: { name: "first_out", width: 1 } };
		sch.components.push(pinC, pinA, pinB, outX, outY);
		state.selection.clear();

		// before any commit, the live array is still in raw creation order
		const before = sch.components.filter((c) => c.type === "IN" || c.type === "OUT").map((c) => c.params.name);

		snapshot(); // every history commit should normalize IN/OUT order to match position

		const after = sch.components.filter((c) => c.type === "IN" || c.type === "OUT").map((c) => c.params.name);

		const savedJson = JSON.parse(serialize());
		const savedOrder = savedJson.project.schematics[state.activeId].components
			.filter((c) => c.type === "IN" || c.type === "OUT")
			.map((c) => c.params.name);

		return { before, after, savedOrder };
	});

	expect(result.before).toEqual(["bottom", "top", "middle", "second_out", "first_out"]);
	expect(result.after).toEqual(["top", "middle", "bottom", "first_out", "second_out"]);
	expect(result.savedOrder).toEqual(["top", "middle", "bottom", "first_out", "second_out"]);
});
