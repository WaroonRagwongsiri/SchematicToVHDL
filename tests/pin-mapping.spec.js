// @ts-check
/* Layer 1 — the board pin map in the page: .xdc output, auto-map, the Issues it
   raises, persistence, and the no-helper .zip fallback. No Vivado needed. */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { test, expect } = require("@playwright/test");
const { openApp, buildFixture } = require("./fixtures/board-fixtures");

const GOLDEN = path.join(__dirname, "golden");
const BOARD_XDC = path.resolve(__dirname, "..", "..", "DigitalLab", "spartan7.xdc");

test.beforeEach(async ({ page }) => { await openApp(page); });

for (const f of ["A", "B", "C"]) {
	test(`fixture ${f}: auto-mapped .xdc matches the golden file exactly`, async ({ page }) => {
		await buildFixture(page, /** @type {"A"|"B"|"C"} */(f));
		const xdc = await page.evaluate(() => { autoMapPins(); return generateXdc(); });
		expect(xdc).toBe(fs.readFileSync(path.join(GOLDEN, `fixture-${f}.xdc`), "utf8"));
	});
}

test("ports come from the generated entity: names and widths agree with the VHDL", async ({ page }) => {
	await buildFixture(page, "B");
	const ports = await page.evaluate(() => topEntityPorts());
	expect(ports).toEqual([{ name: "sw", dir: "in", width: 4 }, { name: "led", dir: "out", width: 4 }]);
});

test("auto-map by name: clk, sw, led, pb, aliases, single bits, then spill to switches/LEDs", async ({ page }) => {
	const map = await page.evaluate(() => {
		state.project.pins = undefined;
		autoMapPins([
			{ name: "clk", dir: "in", width: 1 },
			{ name: "sw", dir: "in", width: 8 },
			{ name: "btn", dir: "in", width: 5 },
			{ name: "seg", dir: "out", width: 7 },
			{ name: "an", dir: "out", width: 4 },
			{ name: "led3", dir: "out", width: 1 },
			{ name: "sw_12", dir: "in", width: 1 },
			{ name: "go", dir: "in", width: 1 },
			{ name: "done", dir: "out", width: 1 },
		]);
		return state.project.pins.map;
	});
	expect(map).toEqual({
		clk: { sig: "clk", lo: 0 },
		sw: { sig: "sw", lo: 0 },
		btn: { sig: "pb", lo: 0 },
		seg: { sig: "seven_segment", lo: 0 },
		an: { sig: "digit", lo: 0 },
		led3: { sig: "led", lo: 3 },
		sw_12: { sig: "sw", lo: 12 },
		go: { sig: "sw", lo: 8 },        // first switch not already taken
		done: { sig: "led", lo: 0 },     // led3 is taken, led0 is free
	});
});

test("auto-map keeps choices already made and never doubles up a pin", async ({ page }) => {
	await buildFixture(page, "A");
	const map = await page.evaluate(() => {
		pinState().map.led0 = { sig: "led", lo: 7 };
		pinState().map.sw = { sig: "sw", lo: 4 };
		autoMapPins();
		return state.project.pins.map;
	});
	expect(map).toEqual({ led0: { sig: "led", lo: 7 }, sw: { sig: "sw", lo: 4 } });
});

test("issues: unmapped port, a pin used twice, LEDs with the 7-segment, width mismatch", async ({ page }) => {
	await buildFixture(page, "B");
	const r = await page.evaluate(() => {
		const msgs = () => runSynthesis().filter(i => /^Pin map/.test(i.ref || "")).map(i => i.lvl + " " + i.msg);
		const before = msgs();                       // nothing mapped yet → no pin noise at all
		pinState().map.sw = { sig: "sw", lo: 0 };   // led left unmapped
		const unmapped = msgs();
		pinState().map.led = { sig: "led", lo: 0 };
		const clean = msgs();
		// two ports on one physical pin: led[3:0] is K12 M12 M14 P13, data[7:4] is P13 M14 M12 K12
		const sch = activeSch();
		sch.components.push({ id: uid("c"), type: "OUT", x: 600, y: 300, params: { name: "lcd", width: 4 } });
		sch.wires.push({ id: uid("w"), from: { cid: sch.components[1].id, pid: "o" }, to: { cid: sch.components[3].id, pid: "i" }, name: "" });
		pinState().map.lcd = { sig: "data", lo: 4 };
		const clash = msgs();
		// the 7-segment shares pins with led[8..15] — no bit in common here, still a warning
		pinState().map.lcd = { sig: "seven_segment", lo: 0 };
		const shared = msgs();
		// the sw port grows past what its board slot holds
		pinState().map.lcd = { sig: "digit", lo: 0 };
		pinState().map.sw = { sig: "sw", lo: 14 };
		const narrow = msgs();
		return { before, unmapped, clean, clash, shared, narrow };
	});
	expect(r.before).toEqual([]);
	expect(r.unmapped).toEqual(["err พอร์ต 'led' ยังไม่ได้กำหนดขาบนบอร์ด"]);
	expect(r.clean).toEqual([]);
	expect(r.clash.filter(m => /^err ขา (K12|M12|M14|P13) ถูกใช้ซ้ำ/.test(m))).toHaveLength(4);
	expect(r.clash.some(m => /^warn 'led' \(LEDs\) กับ 'data' \(LCD 2x16\) ใช้ขาร่วมกัน/.test(m))).toBe(true);
	expect(r.shared.filter(m => m.startsWith("err"))).toEqual([]);
	expect(r.shared.some(m => /^warn 'led' \(LEDs\) กับ 'seven_segment' \(7-Segment\) ใช้ขาร่วมกัน/.test(m))).toBe(true);
	expect(r.narrow).toContain("err พอร์ต 'sw' กว้าง 4 bit แต่ sw[17:14] บนบอร์ดมีไม่พอ (16 bit) — ความกว้างไม่ตรงกัน");
});

test("an OUTPUT on a switch pin is flagged; a mapping that no longer fits is left out of the .xdc", async ({ page }) => {
	await buildFixture(page, "A");
	const r = await page.evaluate(() => {
		pinState().map.sw = { sig: "sw", lo: 15 };      // 2 bits from sw15 — off the end
		pinState().map.led0 = { sig: "sw", lo: 3 };     // an output driving a switch
		return { issues: pinIssues().map(i => i.lvl + " " + i.msg), xdc: generateXdc() };
	});
	expect(r.issues.some(m => m.startsWith("warn OUTPUT 'led0' ขับขา sw[3]"))).toBe(true);
	expect(r.issues.some(m => m.startsWith("err พอร์ต 'sw' กว้าง 2 bit"))).toBe(true);
	expect(r.xdc).not.toContain("get_ports { sw[");
	expect(r.xdc).toContain("PACKAGE_PIN P12 IOSTANDARD LVCMOS33 } [get_ports { led0 }]");
});

test("buttons get PULLDOWN and the clock period follows the MHz setting", async ({ page }) => {
	await buildFixture(page, "C");
	const xdc = await page.evaluate(() => {
		autoMapPins();
		pinState().clockMHz = 50;
		pinState().map.cnt1 = { sig: "pb", lo: 4 };
		return generateXdc();
	});
	expect(xdc).toContain("create_clock -period 20.000 -name sys_clk [get_ports { clk }];");
	expect(xdc).toContain("{ PACKAGE_PIN J12 IOSTANDARD LVCMOS33 PULLDOWN true } [get_ports { cnt1 }];");
});

test("the pin map survives serialize → deserialize and undo", async ({ page }) => {
	await buildFixture(page, "C");
	const r = await page.evaluate(() => {
		autoMapPins();
		pinState().clockMHz = 12;
		snapshot();
		const want = JSON.stringify(state.project.pins);
		deserialize(serialize());
		const afterLoad = JSON.stringify(state.project.pins);
		pinState().map = {};
		snapshot();
		undo();
		return { want, afterLoad, afterUndo: JSON.stringify(state.project.pins) };
	});
	expect(r.afterLoad).toBe(r.want);
	expect(r.afterUndo).toBe(r.want);
	expect(JSON.parse(r.want).clockMHz).toBe(12);
});

test("Pins tab: choosing from the dropdown updates the map and the .xdc downloads", async ({ page }) => {
	await buildFixture(page, "A");
	await page.click('[data-rtab="pins"]');
	await page.click('[data-act="auto-pins"]');
	await expect(page.locator('select[data-pin-port="sw"]')).toHaveValue("sw:0");
	await page.selectOption('select[data-pin-port="led0"]', "led:5");
	expect(await page.evaluate(() => state.project.pins.map.led0)).toEqual({ sig: "led", lo: 5 });
	await expect(page.locator("#pinsPane .pin-status")).toContainText("กำหนดขาครบ");

	const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-act="download-xdc"]')]);
	expect(dl.suggestedFilename()).toMatch(/^\d{14}myproject\.xdc$/);
	const text = fs.readFileSync(await dl.path(), "utf8");
	expect(text).toContain("PACKAGE_PIN P11 IOSTANDARD LVCMOS33 } [get_ports { led0 }]");
});

test("Build with no helper running falls back to a .zip that holds the whole flow", async ({ page }) => {
	await buildFixture(page, "A");
	await page.evaluate(() => { autoMapPins(); window.fetch = () => Promise.reject(new TypeError("Failed to fetch")); });
	await page.click('[data-rtab="build"]');
	const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-act="board-build"]')]);
	expect(dl.suggestedFilename()).toMatch(/_board\.zip$|board\.zip$/);
	await expect(page.locator("#buildStatus")).toContainText("ไม่พบ helper");
	const zip = await dl.path();
	execFileSync("python3", ["-m", "zipfile", "-t", zip]);   // CRCs and structure check out
	const list = execFileSync("unzip", ["-Z1", zip]).toString().trim().split("\n").sort();
	expect(list).toEqual(["my_project_board/README.txt", "my_project_board/build.tcl", "my_project_board/program.sh",
		"my_project_board/program.tcl", "my_project_board/top.vhd", "my_project_board/top.xdc"]);
	const tcl = execFileSync("unzip", ["-p", zip, "my_project_board/build.tcl"]).toString();
	expect(tcl).toBe(fs.readFileSync(path.join(__dirname, "..", "helper", "build.tcl"), "utf8"));
	const sh = execFileSync("unzip", ["-p", zip, "my_project_board/program.sh"]).toString();
	expect(sh).toContain("-source build.tcl -tclargs top ;;");
	expect(execFileSync("unzip", ["-Z", "-l", zip, "my_project_board/program.sh"]).toString()).toMatch(/^-rwxr-xr-x/);
});

test("Build refuses — and shows Issues — while a port is unmapped", async ({ page }) => {
	await buildFixture(page, "A");
	const calls = await page.evaluate(async () => {
		let n = 0;
		window.fetch = () => { n++; return Promise.reject(new TypeError("x")); };
		await boardBuild();
		return n;
	});
	expect(calls).toBe(0);
	await expect(page.locator("#errorsPane")).toContainText("ยังไม่ได้กำหนดขาบนบอร์ด");
});

test("the board table agrees with DigitalLab/spartan7.xdc pin for pin", async ({ page }) => {
	test.skip(!fs.existsSync(BOARD_XDC), "spartan7.xdc not next to this repo");
	// tolerant of that file's broken lines ({pin8}}], {pin13]}]); SCK/CS are listed
	// for the ADC first and then the DAC, which the table calls adc_* / dac_*
	const seen = {};
	const want = {};
	fs.readFileSync(BOARD_XDC, "utf8").split("\n").forEach(line => {
		if (/^\s*#/.test(line)) return;
		const m = /PACKAGE_PIN\s+(\w+)[^[]*\[get_ports\s*\{\s*([A-Za-z0-9_]+)(?:\[(\d+)\])?/.exec(line);
		if (!m) return;
		let name = m[2].toLowerCase(), bit = m[3] === undefined ? null : +m[3];
		if (name === "sck" || name === "cs") { seen[name] = (seen[name] || 0) + 1; name = (seen[name] === 1 ? "adc_" : "dac_") + name; }
		if (name === "din" || name === "dout") name = "adc_" + name;
		if (name === "mosi") name = "dac_mosi";
		const pm = /^pin(\d+)$/.exec(name);
		if (pm) { name = "j5"; bit = +pm[1] - 5; }
		// that file has Seven_Segment[7..1] = A..G, [0] = DP; the table has seven_segment[0..6] = A..G + dp
		if (name === "seven_segment") { if (bit === 0) { name = "dp"; bit = null; } else bit = 7 - bit; }
		want[bit === null ? name : `${name}[${bit}]`] = m[1];
	});
	const have = await page.evaluate(() => {
		const o = {};
		BOARD_S7.signals.forEach(s => {
			if (s.bits) s.bits.forEach(b => { o[`${s.name}[${b.i}]`] = b.pin; });
			else o[s.name] = s.pin;
		});
		return o;
	});
	// every PACKAGE_PIN line was understood (none skipped by the tolerant parse)
	const lines = fs.readFileSync(BOARD_XDC, "utf8").split("\n").filter(l => /^\s*set_property.*PACKAGE_PIN/.test(l)).length;
	expect(Object.keys(want).length).toBe(lines);
	expect(have).toEqual(want);
});

test("the Tcl embedded in the page is the same as helper/*.tcl (run npm run sync-tcl)", async () => {
	const { render, OUT } = require("../helper/sync-tcl");
	expect(fs.readFileSync(OUT, "utf8")).toBe(render());
});

test("lab 7: the .xdc reproduces the hand-written one that works on the board", async ({ page }) => {
	// pins straight from that working lab7.xdc (segment[0] = A … segment[6] = G)
	const want = {
		clk: "H11",
		"s0[0]": "K11", "s0[1]": "M11", "s0[2]": "N14", "s0[3]": "P12",
		"s1[0]": "N10", "s1[1]": "P10", "s1[2]": "M10", "s1[3]": "N4",
		"m0[0]": "L2", "m0[1]": "P3", "m0[2]": "N1", "m0[3]": "M2",
		"m1[0]": "L1", "m1[1]": "J3", "m1[2]": "K3", "m1[3]": "J1",
		error: "K12", timeup: "M12",
		start: "J13", set: "J14", reset: "J12",
		"common[0]": "H4", "common[1]": "H3", "common[2]": "H2", "common[3]": "H1",
		"segment[0]": "L3", "segment[1]": "P4", "segment[2]": "P2", "segment[3]": "M3",
		"segment[4]": "M1", "segment[5]": "J4", "segment[6]": "K4",
	};
	const xdc = await page.evaluate(() => {
		const ports = [
			["m1", "in", 4], ["m0", "in", 4], ["s1", "in", 4], ["s0", "in", 4],
			["set", "in", 1], ["reset", "in", 1], ["start", "in", 1], ["clk", "in", 1],
			["segment", "out", 7], ["common", "out", 4], ["timeup", "out", 1], ["error", "out", 1],
		].map(([name, dir, width]) => ({ name, dir, width }));
		Object.assign(pinState().map, {
			s0: { sig: "sw", lo: 0 }, s1: { sig: "sw", lo: 4 }, m0: { sig: "sw", lo: 8 }, m1: { sig: "sw", lo: 12 },
			error: { sig: "led", lo: 0 }, timeup: { sig: "led", lo: 1 },
			start: { sig: "pb", lo: 0 }, set: { sig: "pb", lo: 2 }, reset: { sig: "pb", lo: 4 },
			clk: { sig: "clk", lo: 0 }, segment: { sig: "seven_segment", lo: 0 }, common: { sig: "digit", lo: 0 },
		});
		return generateXdc(ports, "lab7");
	});
	const have = {};
	xdc.split("\n").forEach(l => {
		const m = /PACKAGE_PIN (\w+) .*get_ports \{ (\S+) \}/.exec(l);
		if (m) have[m[2]] = m[1];
	});
	expect(have).toEqual(want);
	// the buttons keep their pulldowns, as in the hand-written file
	["start", "set", "reset"].forEach(p => expect(xdc).toMatch(new RegExp(`PULLDOWN true \\} \\[get_ports \\{ ${p} \\}\\]`)));
});
