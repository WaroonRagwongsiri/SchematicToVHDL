// @ts-check
/* Schematics for the board tests, built straight into the page's model.
     A — two switches ANDed onto one LED:  sw(1:0) → AND → led0
     B — a 4-bit bus passed through:       sw(3:0) → BUF → led(3:0)
     C — clk + 2-bit synchronous counter:  q0 toggles, q1 ^= q0  → cnt0, cnt1
     broken — A, plus a custom block whose hand-written VHDL does not parse */
const path = require("path");
const { pathToFileURL } = require("url");

const APP_URL = pathToFileURL(path.resolve(__dirname, "..", "..", "schematic2vhdl.html")).toString();

async function openApp(page, url) {
	await page.goto(url || APP_URL);
	await page.waitForFunction(() => typeof window.generateXdc === "function" && typeof window.activeSch === "function");
}

/** @param {import("@playwright/test").Page} page @param {"A"|"B"|"C"|"broken"} name */
async function buildFixture(page, name) {
	await page.evaluate((name) => {
		const sch = activeSch();
		sch.name = "top";
		state.project.topId = sch.id;
		state.project.pins = undefined;
		sch.components = [];
		sch.wires = [];
		const C = (type, x, y, params) => { const c = { id: uid("c"), type, x, y, params: params || {} }; sch.components.push(c); return c; };
		const W = (a, ap, b, bp) => sch.wires.push({ id: uid("w"), from: { cid: a.id, pid: ap }, to: { cid: b.id, pid: bp }, name: "" });
		if (name === "A" || name === "broken") {
			const a = C("IN", 44, 44, { name: "sw", width: 2 });
			const t0 = C("BUSTAP", 200, 44, { bit: 0, mode: "split" });
			const t1 = C("BUSTAP", 200, 110, { bit: 1, mode: "split" });
			const g = C("AND", 330, 66, { inputs: 2 });
			const y = C("OUT", 500, 66, { name: "led0", width: 1 });
			W(a, "o", t0, "d"); W(a, "o", t1, "d");
			W(t0, "y", g, "i0"); W(t1, "y", g, "i1"); W(g, "o", y, "i");
			if (name === "broken") {
				state.project.customs.bad = {
					name: "bad",
					vhdl: "library IEEE;\nuse IEEE.STD_LOGIC_1164.ALL;\nentity bad is\n  Port ( x : in STD_LOGIC; z : out STD_LOGIC );\nend bad;\narchitecture rtl of bad is\nbegin\n  z <= x FAKE_SYNTAX_ERROR and;\nend rtl;\n",
					ports: [{ name: "x", dir: "in", width: 1 }, { name: "z", dir: "out", width: 1 }],
				};
				const b = C("CUSTOM:bad", 330, 220, {});
				const bi = C("IN", 44, 220, { name: "pb0", width: 1 });
				const bo = C("OUT", 500, 220, { name: "led1", width: 1 });
				W(bi, "o", b, "x"); W(b, "z", bo, "i");
			}
		} else if (name === "B") {
			const a = C("IN", 44, 44, { name: "sw", width: 4 });
			const g = C("BUF", 220, 44, { inputs: 1, width: 4 });
			const y = C("OUT", 400, 44, { name: "led", width: 4 });
			W(a, "o", g, "i0"); W(g, "o", y, "i");
		} else if (name === "C") {
			const clk = C("IN", 44, 200, { name: "clk", width: 1 });
			const f0 = C("DFF", 220, 44, {});
			const f1 = C("DFF", 220, 220, {});
			const x = C("XOR", 120, 230, { inputs: 2 });
			const q0 = C("OUT", 450, 44, { name: "cnt0", width: 1 });
			const q1 = C("OUT", 450, 220, { name: "cnt1", width: 1 });
			W(clk, "o", f0, "clk"); W(clk, "o", f1, "clk");
			W(f0, "qn", f0, "d");
			W(f0, "q", x, "i0"); W(f1, "q", x, "i1"); W(x, "o", f1, "d");
			W(f0, "q", q0, "i"); W(f1, "q", q1, "i");
		}
		state.selection.clear();
		renderAll();
	}, name);
}

module.exports = { APP_URL, openApp, buildFixture };
