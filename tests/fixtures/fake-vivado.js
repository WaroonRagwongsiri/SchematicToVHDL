#!/usr/bin/env node
"use strict";
/* A stand-in for `vivado -mode tcl` so the helper's API can be tested in seconds
   and without Vivado installed. It understands exactly the job shape the helper
   sends — `cd {dir}` + `source {…/build.tcl|program.tcl|probe.tcl}` wrapped in
   catch{} and closed by the @@S2V_END@@ sentinel — and fakes each script:
     build : waits FAKE_VIVADO_MS (default 400), writes top.bit/top.mcs/pins.json
             (pins read back out of top.xdc); a .vhd containing FAKE_SYNTAX_ERROR
             fails the way Vivado does, with an ERROR: line and rc 1
     probe : no cable
     program: no cable, rc 1
   Like the real thing it prints "Vivado% " prompts with no newline. */
const fs = require("fs");
const path = require("path");

const DELAY = +process.env.FAKE_VIVADO_MS || 400;
let cwd = process.cwd();
let block = [];
let queue = Promise.resolve();
const out = s => process.stdout.write(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

out("****** Vivado v2025.2 (fake)\nVivado% ");

async function runBlock(lines) {
	const text = lines.join("\n");
	const end = /@@S2V_END@@ (\d+)/.exec(text);
	const id = end ? end[1] : "0";
	const cd = /cd \{([^}]*)\}/.exec(text);
	if (cd) cwd = cd[1];
	let rc = 0;
	const src = /source \{([^}]*)\}/.exec(text);
	const script = src ? path.basename(src[1]) : "";
	if (script === "build.tcl") {
		out("INFO: [Synth 8-638] synthesizing module (fake)\n");
		await sleep(DELAY);
		const vhds = fs.readdirSync(cwd).filter(f => f.endsWith(".vhd"));
		if (vhds.some(f => fs.readFileSync(path.join(cwd, f), "utf8").includes("FAKE_SYNTAX_ERROR"))) {
			out(`ERROR: [Synth 8-2715] syntax error near 'FAKE_SYNTAX_ERROR' [${path.join(cwd, vhds[0])}:3]\n`);
			out("S2V_ERROR: ERROR: [Common 17-69] Command failed: Synthesis failed - please see the console or run log file for details\n");
			rc = 1;
		} else {
			const xdc = fs.readFileSync(path.join(cwd, "top.xdc"), "utf8");
			const pins = {};
			xdc.replace(/PACKAGE_PIN (\w+)[^[]*\[get_ports \{ ([^ }]+) \}\]/g, (_, pin, port) => { pins[port] = pin; });
			fs.writeFileSync(path.join(cwd, "pins.json"), JSON.stringify(pins));
			fs.writeFileSync(path.join(cwd, "top.bit"), "fake bit");
			fs.writeFileSync(path.join(cwd, "top.mcs"), "fake mcs");
			fs.writeFileSync(path.join(cwd, "utilization.rpt"),
				"| Slice LUTs              |    1 |     0 |          0 |      8000 |  0.01 |\n" +
				"| Slice Registers         |    0 |     0 |          0 |     16000 |  0.00 |\n" +
				`| Bonded IOB                  |    ${Object.keys(pins).length} |     0 |          0 |       100 |  1.00 |\n`);
			fs.writeFileSync(path.join(cwd, "timing.rpt"), "There are no user specified timing constraints.\n");
			out("S2V_BUILD_OK\n");
		}
	} else if (script === "probe.tcl") {
		out("S2V_PROBE 0 \n");
	} else if (script === "program.tcl") {
		out("S2V_ERROR: ไม่พบสาย JTAG (fake)\n");
		rc = 1;
	} else {
		const p = /puts (\S+)/.exec(text);
		if (p && !/@@S2V_END@@/.test(p[1])) out(p[1] + "\n");
	}
	out(`@@S2V_END@@ ${id} ${rc}\nVivado% `);
}

let buf = "";
process.stdin.on("data", d => {
	buf += d.toString();
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (line.trim() === "exit") { queue.then(() => process.exit(0)); continue; }
		block.push(line);
		if (/@@S2V_END@@/.test(line)) {
			const b = block;
			block = [];
			queue = queue.then(() => runBlock(b));
		}
	}
});
process.stdin.on("end", () => queue.then(() => process.exit(0)));
