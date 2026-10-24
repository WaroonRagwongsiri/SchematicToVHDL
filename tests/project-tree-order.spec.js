// @ts-check
const path = require("path");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");

const APP_URL = pathToFileURL(path.resolve(__dirname, "..", "schematic2vhdl.html")).toString();

test.beforeEach(async ({ page }) => {
	await page.goto(APP_URL);
	await page.waitForFunction(() => typeof window.addComp === "function" && typeof window.activeSch === "function");
});

test("dragging sheets in the project tree reorders the saved schematics object, not just schOrder", async ({ page }) => {
	const result = await page.evaluate(() => {
		const pr = state.project;
		const topId = pr.topId;
		// three more sheets, added (and therefore object-key-inserted) in THIS order
		const idA = uid("sch"); pr.schematics[idA] = blankSchematic(idA, "clock");
		const idB = uid("sch"); pr.schematics[idB] = blankSchematic(idB, "display");
		const idC = uid("sch"); pr.schematics[idC] = blankSchematic(idC, "hex_7seg");
		pr.schOrder = [topId, idA, idB, idC];

		// simulate the drag handler: only schOrder changes, exactly like
		// js/06-project-ui.js's drop handler does (pr.schOrder = order)
		pr.schOrder = [topId, idC, idA, idB]; // user dragged hex_7seg to the top

		const beforeObjectKeys = Object.keys(pr.schematics);

		snapshot();

		const afterObjectKeys = Object.keys(pr.schematics);

		const saved = JSON.parse(serialize());
		const savedObjectKeys = Object.keys(saved.project.schematics);

		return { beforeObjectKeys, afterObjectKeys, savedObjectKeys, expected: [topId, idC, idA, idB] };
	});

	// before the fix, dragging never touched object key order
	expect(result.beforeObjectKeys).not.toEqual(result.expected);
	// after snapshot(), the schematics OBJECT itself is in the dragged order —
	// which is what a reader with no concept of schOrder (like the legacy tool's
	// `Object.keys(pr.schematics)`) will see
	expect(result.afterObjectKeys).toEqual(result.expected);
	expect(result.savedObjectKeys).toEqual(result.expected);
});
