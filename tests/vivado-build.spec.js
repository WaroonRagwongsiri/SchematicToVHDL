// @ts-check
/* Layer 2 — real Vivado, no board. Each fixture goes the whole way through the
   page (Build button) → helper → build.tcl in the helper's Vivado session, and
   must come out as top.bit + top.mcs with no ERROR / CRITICAL WARNING (Vivado
   reports an XDC typo or an unmatched get_ports as a critical warning), with every
   port placed on exactly the pin the page mapped it to.
   Skipped when Vivado is not installed, or with S2V_SKIP_VIVADO=1 (npm run test:fast).
   About a minute per build: the builds run one after another in one session. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { test, expect } = require("@playwright/test");
const { buildFixture } = require("./fixtures/board-fixtures");

const VIVADO = process.env.VIVADO_BIN || path.join(os.homedir(), "Vivado/2025.2/Vivado/bin/vivado");
const HAVE_VIVADO = fs.existsSync(VIVADO) && !process.env.S2V_SKIP_VIVADO;

test.describe.configure({ mode: "serial" });
test.skip(!HAVE_VIVADO, "Vivado not installed (or S2V_SKIP_VIVADO set)");

const PORT = 7462;
const TOKEN = "b01dfacecafeb01dfacecafeb01dface";
const BASE = `http://127.0.0.1:${PORT}`;
let helper, home;

test.beforeAll(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "s2v-vivado-"));
	helper = spawn(process.execPath, [path.join(__dirname, "..", "helper", "server.js")], {
		env: { ...process.env, S2V_PORT: String(PORT), S2V_TOKEN: TOKEN, S2V_HOME: home, VIVADO_BIN: VIVADO },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await new Promise((resolve, reject) => {
		let out = "";
		helper.stdout.on("data", d => { out += d; if (out.includes("Open  http")) resolve(undefined); });
		helper.on("exit", c => reject(new Error("helper exited " + c + ": " + out)));
		setTimeout(() => reject(new Error("helper did not start: " + out)), 15000);
	});
});
test.afterAll(async () => {
	if (helper) helper.kill("SIGTERM");
	// keep the build dirs of a failed run around for a look; clean up a good one
	if (home && test.info().status === "passed") fs.rmSync(home, { recursive: true, force: true });
});

async function buildInPage(page, fixture) {
	await page.goto(`${BASE}/#token=${TOKEN}`);
	await page.waitForFunction(() => typeof window.boardBuild === "function");
	await buildFixture(page, fixture);
	const expected = await page.evaluate(() => { autoMapPins(); return expectedPins(topEntityPorts()); });
	await page.click('[data-rtab="build"]');
	await page.click('[data-act="board-build"]');
	await expect(page.locator("#buildStatus")).toContainText(/Build สำเร็จ|Build ไม่ผ่าน|✕/, { timeout: 280000 });
	const result = await page.evaluate(() => buildUi.lastResult);
	return { expected, result };
}

for (const f of ["A", "B", "C"]) {
	test(`fixture ${f} builds clean in Vivado and lands on the mapped pins`, async ({ page }) => {
		test.setTimeout(300000);
		const { expected, result } = await buildInPage(page, f);
		expect(result, "the page got a build result").toBeTruthy();
		expect(result.errors).toEqual([]);
		expect(result.criticalWarnings).toEqual([]);
		expect(result.ok).toBe(true);
		for (const file of ["top.bit", "top.mcs"]) expect(fs.statSync(path.join(result.dir, file)).size).toBeGreaterThan(1000);
		const log = fs.readFileSync(path.join(result.dir, "build.log"), "utf8");
		expect(log.split("\n").filter(l => /^(ERROR|CRITICAL WARNING):/.test(l))).toEqual([]);
		expect(result.pins).toEqual(expected);
		await expect(page.locator("#buildSummary")).toContainText(`ตรงกับที่กำหนด (${Object.keys(expected).length} ขา)`);
		if (f === "C") {
			expect(result.timing).toMatchObject({ constrained: true, met: true });
			expect(result.utilization.regs.used).toBeGreaterThanOrEqual(2);
		}
	});
}

test("broken VHDL fails, and the page shows Vivado's ERROR line", async ({ page }) => {
	test.setTimeout(300000);
	const { result } = await buildInPage(page, "broken");
	expect(result.ok).toBe(false);
	expect(result.errors.length).toBeGreaterThan(0);
	expect(result.errors.some(l => /^ERROR: .*bad\.vhd/.test(l))).toBe(true);
	await expect(page.locator("#buildStatus")).toContainText("Build ไม่ผ่าน: ERROR:");
	await expect(page.locator("#buildLog .e").first()).toContainText("ERROR:");
});
