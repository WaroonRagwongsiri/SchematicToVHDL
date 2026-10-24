// @ts-check
/* Layer 3 — helper/server.js over HTTP, driving tests/fixtures/fake-vivado.js in
   place of Vivado: status, an SSE build, the 403s, queuing, and the page's Build
   button end to end. Seconds, and no Vivado needed. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { test, expect } = require("@playwright/test");
const { buildFixture } = require("./fixtures/board-fixtures");

test.describe.configure({ mode: "serial" });

const PORT = 7461;
const TOKEN = "feedfacefeedfacefeedfacefeedface";
const BASE = `http://127.0.0.1:${PORT}`;
let helper, home;

test.beforeAll(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "s2v-helper-"));
	helper = spawn(process.execPath, [path.join(__dirname, "..", "helper", "server.js")], {
		env: { ...process.env, S2V_PORT: String(PORT), S2V_TOKEN: TOKEN, S2V_HOME: home, VIVADO_BIN: path.join(__dirname, "fixtures", "fake-vivado.js"), FAKE_VIVADO_MS: "600" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await new Promise((resolve, reject) => {
		let out = "";
		helper.stdout.on("data", d => { out += d; if (out.includes("Open  http")) resolve(undefined); });
		helper.on("exit", c => reject(new Error("helper exited " + c + ": " + out)));
		setTimeout(() => reject(new Error("helper did not start: " + out)), 10000);
	});
});
test.afterAll(async () => {
	if (helper) helper.kill("SIGTERM");
	if (home) fs.rmSync(home, { recursive: true, force: true });
});

/** raw request so Host / Origin can be anything */
function raw(method, p, headers, body) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers }, res => {
			let data = "";
			res.on("data", d => { data += d; });
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
		});
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}
const auth = { "X-S2V-Token": TOKEN };
function parseSse(text) {
	return text.split("\n\n").filter(Boolean).map(block => {
		let event = "message";
		const data = [];
		block.split("\n").forEach(l => { if (l.startsWith("event: ")) event = l.slice(7); else if (l.startsWith("data: ")) data.push(l.slice(6)); });
		const d = data.join("\n");
		let parsed = d;
		try { parsed = JSON.parse(d); } catch (_) { }
		return { event, data: event === "log" ? d : parsed };
	});
}
const A_BODY = {
	top: "top",
	files: { "top.vhd": "entity top is port (sw : in std_logic_vector(1 downto 0); led0 : out std_logic); end top;" },
	xdc: "set_property -dict { PACKAGE_PIN K11 IOSTANDARD LVCMOS33 } [get_ports { sw[0] }];\n" +
		"set_property -dict { PACKAGE_PIN M11 IOSTANDARD LVCMOS33 } [get_ports { sw[1] }];\n" +
		"set_property -dict { PACKAGE_PIN K12 IOSTANDARD LVCMOS33 } [get_ports { led0 }];\n",
};
const build = body => fetch(BASE + "/build", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) })
	.then(async r => ({ status: r.status, events: parseSse(await r.text()) }));

test("/status reports Vivado found and probes the cable", async () => {
	const r = await fetch(BASE + "/status?probe=1", { headers: auth });
	expect(r.status).toBe(200);
	const s = await r.json();
	expect(s.vivado.found).toBe(true);
	expect(s.cable).toMatchObject({ targets: 0, devices: [] });
	expect(s.board).toEqual({ part: "xc7s15ftgb196-1", flash: "s25fl064l-spi-x1_x2_x4" });
});

test("/build streams the log over SSE and finishes with success, pins read back", async () => {
	const { status, events } = await build(A_BODY);
	expect(status).toBe(200);
	expect(events[0].event).toBe("queued");
	expect(events.some(e => e.event === "start")).toBe(true);
	const logs = events.filter(e => e.event === "log").map(e => e.data);
	expect(logs).toContain("S2V_BUILD_OK");
	expect(logs.every(l => !l.startsWith("Vivado% "))).toBe(true);    // prompt stripped
	const done = events[events.length - 1];
	expect(done.event).toBe("done");
	expect(done.data).toMatchObject({ ok: true, rc: 0, errors: [], criticalWarnings: [] });
	expect(done.data.pins).toEqual({ "sw[0]": "K11", "sw[1]": "M11", led0: "K12" });
	expect(done.data.utilization.iob).toEqual({ used: 3, avail: 100, pct: "1.00" });
	for (const f of ["top.vhd", "top.xdc", "top.bit", "top.mcs", "build.log"]) expect(fs.existsSync(path.join(done.data.dir, f))).toBe(true);
	expect(done.data.dir.startsWith(path.join(home, "build"))).toBe(true);
});

test("a VHDL error fails the build and the Vivado ERROR line comes back", async () => {
	const { events } = await build({ ...A_BODY, files: { "top.vhd": "FAKE_SYNTAX_ERROR" } });
	const done = events[events.length - 1].data;
	expect(done.ok).toBe(false);
	expect(done.errors[0]).toMatch(/^ERROR: \[Synth 8-2715\] syntax error/);
});

test("no token, a wrong token, a foreign Origin, or a foreign Host all get 403", async () => {
	expect((await raw("GET", "/status", {})).status).toBe(403);
	expect((await raw("GET", "/status", { "X-S2V-Token": "nope" })).status).toBe(403);
	expect((await raw("POST", "/build", { ...auth, Origin: "https://evil.example", "Content-Type": "application/json" }, JSON.stringify(A_BODY))).status).toBe(403);
	expect((await raw("GET", "/status", { ...auth, Host: "evil.example:7461" })).status).toBe(403);
	// the page itself, from file:// or the helper's own origin, is let through
	const ok1 = await raw("GET", "/status", { ...auth, Origin: "null" });
	expect(ok1.status).toBe(200);
	expect(ok1.headers["access-control-allow-origin"]).toBe("null");
	const pre = await raw("OPTIONS", "/build", { Origin: "null", "Access-Control-Request-Private-Network": "true" });
	expect(pre.status).toBe(204);
	expect(pre.headers["access-control-allow-headers"]).toContain("x-s2v-token");
	expect(pre.headers["access-control-allow-private-network"]).toBe("true");
});

test("bad input is refused before anything runs", async () => {
	expect((await build({ ...A_BODY, top: "top; exec rm" })).status).toBe(400);
	expect((await build({ ...A_BODY, files: { "../x.vhd": "" } })).status).toBe(400);
	expect((await build({ ...A_BODY, xdc: undefined })).status).toBe(400);
});

test("two builds at once are queued, never run in parallel", async () => {
	const [a, b] = await Promise.all([build(A_BODY), build(A_BODY)]);
	const da = a.events[a.events.length - 1].data, db = b.events[b.events.length - 1].data;
	expect(da.ok && db.ok).toBe(true);
	const [first, second] = da.startedAt < db.startedAt ? [da, db] : [db, da];
	expect(second.startedAt).toBeGreaterThanOrEqual(first.endedAt);
	expect(first.id).not.toBe(second.id);
});

test("/program with no cable fails cleanly with the message from program.tcl", async () => {
	const r = await fetch(BASE + "/program", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ target: "sram" }) });
	const events = parseSse(await r.text());
	const done = events[events.length - 1].data;
	expect(done).toMatchObject({ ok: false, target: "sram" });
	expect(done.errors[0]).toContain("ไม่พบสาย JTAG");
	expect((await raw("POST", "/program", { ...auth, "Content-Type": "application/json" }, JSON.stringify({ target: "eeprom" }))).status).toBe(400);
});

test("static files: the app is served, nothing outside it is", async () => {
	const page = await raw("GET", "/", {});
	expect(page.status).toBe(200);
	expect(page.body).toContain("Schematic Studio");
	expect((await raw("GET", "/js/21-pin-mapping.js", {})).status).toBe(200);
	expect((await raw("GET", "/package.json", {})).status).toBe(404);
	expect((await raw("GET", "/../../../etc/passwd", {})).status).toBe(404);
	expect((await raw("GET", "/helper/server.js", {})).status).toBe(404);
});

test("the page's Build button, served by the helper, builds and shows the summary", async ({ page }) => {
	await page.goto(`${BASE}/#token=${TOKEN}`);
	await page.waitForFunction(() => typeof window.boardBuild === "function");
	expect(page.url()).not.toContain("token=");              // taken out of the address bar
	await buildFixture(page, "A");
	await page.evaluate(() => autoMapPins());
	await page.click('[data-rtab="build"]');
	await page.click('[data-act="board-build"]');
	await expect(page.locator("#buildStatus")).toContainText("Build สำเร็จ", { timeout: 20000 });
	await expect(page.locator("#buildSummary")).toContainText("ตรงกับที่กำหนด (3 ขา)");
	await expect(page.locator("#buildLog")).toContainText("S2V_BUILD_OK");

	await page.click('[data-act="board-sram"]');
	await expect(page.locator("#buildStatus")).toContainText("Program ไม่สำเร็จ", { timeout: 20000 });
	await expect(page.locator("#buildLog .e")).toContainText("ไม่พบสาย JTAG");
});

test("the page shows the Vivado error line when the design does not compile", async ({ page }) => {
	await page.goto(`${BASE}/#token=${TOKEN}`);
	await page.waitForFunction(() => typeof window.boardBuild === "function");
	await buildFixture(page, "broken");
	await page.evaluate(() => autoMapPins());
	await page.click('[data-rtab="build"]');
	await page.click('[data-act="board-build"]');
	await expect(page.locator("#buildStatus")).toContainText("Build ไม่ผ่าน", { timeout: 20000 });
	await expect(page.locator("#buildStatus")).toContainText("ERROR: [Synth 8-2715]");
	await expect(page.locator("#buildLog .e").first()).toContainText("FAKE_SYNTAX_ERROR");
});

test("a wrong stored token makes the page ask for it again", async ({ page }) => {
	await page.goto(`${BASE}/#token=00000000000000000000000000000000`);
	await page.waitForFunction(() => typeof window.boardCheckHelper === "function");
	page.once("dialog", d => d.accept(TOKEN));
	await page.click('[data-rtab="build"]');
	await page.click('[data-act="board-check"]');
	await expect(page.locator("#buildStatus")).toContainText("✓ Vivado");
	expect(await page.evaluate(() => localStorage.getItem("schstudio.helperToken"))).toBe(TOKEN);
});
