// @ts-check
const path = require("path");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");

const APPS = ["schematic2vhdl.html", "schematic&bus2vhdl.html"];

for (const app of APPS) {
	const APP_URL = pathToFileURL(path.resolve(__dirname, "..", app)).toString();

	test.describe(app, () => {
		test.beforeEach(async ({ page }) => {
			await page.goto(APP_URL);
			await page.waitForFunction(() => typeof window.autosave === "function" && typeof window.activeSch === "function");
		});

		test("a workspace too big for the pretty-printed format still autosaves and restores", async ({ page }) => {
			const result = await page.evaluate(() => {
				clearInterval(state.autosaveTimer);
				// fill the active sheet, then copy the project until the old format overflows
				const sch = activeSch();
				sch.components = [];
				sch.wires = [];
				for (let i = 0; i < 2500; i++) {
					sch.components.push({ id: uid("c"), type: "AND", x: (i % 50) * 40, y: Math.floor(i / 50) * 40, params: { name: "g" + i, width: 1, inputs: 2 } });
				}
				for (let i = 0; i < 2500; i++) {
					sch.wires.push({ id: uid("w"), points: [{ x: i, y: i }, { x: i + 20, y: i }, { x: i + 20, y: i + 30 }] });
				}
				stashProjectUi();
				const base = JSON.stringify(state.project);
				for (let p = 0; p < 5; p++) {
					const copy = JSON.parse(base);
					copy.id = uid("prj");
					copy.name = "copy" + p;
					state.projects[copy.id] = copy;
				}
				const projectCount = Object.keys(state.projects).length;
				const activeProjectId = state.activeProjectId;
				const activeId = state.activeId;

				const oldLen = serialize().length;
				let oldError = null;
				try {
					localStorage.setItem(AUTOSAVE_KEY, serialize());
				} catch (e) {
					oldError = e.name;
				}
				localStorage.removeItem(AUTOSAVE_KEY);

				const newLen = serialize({ compact: true }).length;
				autosave();
				return {
					oldLen, newLen, oldError, projectCount, activeProjectId, activeId,
					status: document.querySelector("#statAutosave").textContent,
				};
			});

			expect(result.oldLen).toBeGreaterThan(5 * 1024 * 1024);
			expect(result.oldError).toBe("QuotaExceededError");
			expect(result.newLen).toBeLessThan(result.oldLen);
			expect(result.status).toContain("✓");

			await page.reload();
			await page.waitForFunction(() => typeof window.autosave === "function" && typeof window.activeSch === "function");
			const restored = await page.evaluate(() => ({
				projectCount: Object.keys(state.projects).length,
				activeProjectId: state.activeProjectId,
				activeId: state.activeId,
				components: activeSch().components.length,
			}));
			expect(restored).toEqual({
				projectCount: result.projectCount,
				activeProjectId: result.activeProjectId,
				activeId: result.activeId,
				components: 2500,
			});
		});

		test("Save Project output keeps the readable v1-compatible format", async ({ page }) => {
			const saved = await page.evaluate(() => serialize());
			const o = JSON.parse(saved);
			expect(o.project).toBeTruthy();
			expect(o.workspace.projects[o.workspace.activeId]).toBeTruthy();
			expect(saved).toContain("\n  ");
		});

		test("a storage error shows a specific status", async ({ page }) => {
			const status = await page.evaluate(() => {
				clearInterval(state.autosaveTimer);
				const orig = Storage.prototype.setItem;
				Storage.prototype.setItem = () => { throw new DOMException("full", "QuotaExceededError"); };
				try {
					autosave();
				} finally {
					Storage.prototype.setItem = orig;
				}
				const el = document.querySelector("#statAutosave span");
				return { text: el.textContent, title: el.title };
			});
			expect(status.text).toBe("autosave failed: storage full — Save Project to file");
			expect(status.title).toBe("full");
		});
	});
}
