// @ts-check
const path = require("path");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");

const APP_URL = pathToFileURL(path.resolve(__dirname, "..", "schematic2vhdl.html")).toString();

test.beforeEach(async ({ page }) => {
	await page.goto(APP_URL);
	await page.waitForFunction(() => typeof window.addComp === "function" && typeof window.activeSch === "function");
});

test("sub-block pin order follows the drawing position, not creation order", async ({ page }) => {
	const order = await page.evaluate(() => {
		const subId = uid("sch");
		state.project.schematics[subId] = blankSchematic(subId, "sub1");
		state.project.schOrder.push(subId);
		const sub = state.project.schematics[subId];
		// created bottom-to-top on purpose: creation order != position order
		sub.components.push({ id: uid("c"), type: "IN", x: 50, y: 300, params: { name: "third", width: 1 } });
		sub.components.push({ id: uid("c"), type: "IN", x: 50, y: 10, params: { name: "first", width: 1 } });
		sub.components.push({ id: uid("c"), type: "IN", x: 50, y: 150, params: { name: "second", width: 1 } });
		return {
			byList: schPortList(sub).map((p) => p.name),
			byTypeDef: schTypeDef(sub).ports().map((p) => p.label),
		};
	});

	expect(order.byList).toEqual(["first", "second", "third"]);
	expect(order.byTypeDef).toEqual(["first", "second", "third"]);
});

test("renaming one sub-block pin does not disturb wires on its sibling pins", async ({ page }) => {
	const setup = await page.evaluate(() => {
		const topId = state.activeId;
		const subId = uid("sch");
		state.project.schematics[subId] = blankSchematic(subId, "sub1");
		state.project.schOrder.push(subId);
		const sub = state.project.schematics[subId];
		const pinFirst = { id: uid("c"), type: "IN", x: 50, y: 10, params: { name: "first", width: 1 } };
		const pinSecond = { id: uid("c"), type: "IN", x: 50, y: 60, params: { name: "second", width: 1 } };
		const pinThird = { id: uid("c"), type: "IN", x: 50, y: 110, params: { name: "third", width: 1 } };
		sub.components.push(pinFirst, pinSecond, pinThird);

		const top = state.project.schematics[topId];
		top.components = [];
		top.wires = [];
		const instId = addComp("SCH:" + subId, 300, 300);
		const srcA = { id: uid("c"), type: "IN", x: 50, y: 50, params: { name: "a", width: 1 } };
		const srcB = { id: uid("c"), type: "IN", x: 50, y: 150, params: { name: "b", width: 1 } };
		const srcC = { id: uid("c"), type: "IN", x: 50, y: 250, params: { name: "c", width: 1 } };
		top.components.push(srcA, srcB, srcC);
		top.wires.push(
			{ id: uid("w"), from: { cid: srcA.id, pid: "o" }, to: { cid: instId, pid: "first" }, name: "" },
			{ id: uid("w"), from: { cid: srcB.id, pid: "o" }, to: { cid: instId, pid: "second" }, name: "" },
			{ id: uid("w"), from: { cid: srcC.id, pid: "o" }, to: { cid: instId, pid: "third" }, name: "" }
		);
		state.selection.clear();
		renderAll();

		return { topId, subId, instId, firstPinId: pinFirst.id };
	});

	// switch to the sub-sheet and rename "first" -> "renamed" through the REAL inspector field
	await page.evaluate((s) => {
		openSchTab(s.subId);
		state.selection = new Set([s.firstPinId]);
		renderAll();
	}, setup);

	await page.locator('#inspectorPane input[data-pk="name"]').fill("renamed");
	await page.locator('#inspectorPane input[data-pk="name"]').dispatchEvent("change");

	const wires = await page.evaluate((s) => {
		const top = state.project.schematics[s.topId];
		const byPin = {};
		top.wires.forEach((w) => {
			if (w.to.cid === s.instId) byPin[w.from.cid] = w.to.pid;
		});
		return byPin;
	}, setup);

	// re-fetch source component ids by name since we only kept the setup's own ids
	const bySourceName = await page.evaluate((s) => {
		const top = state.project.schematics[s.topId];
		const byName = {};
		top.components.forEach((c) => { if (c.type === "IN") byName[c.params.name] = c.id; });
		return byName;
	}, setup);

	expect(wires[bySourceName.a]).toBe("renamed"); // the renamed pin's wire followed it
	expect(wires[bySourceName.b]).toBe("second");  // sibling pins must NOT move
	expect(wires[bySourceName.c]).toBe("third");
});
