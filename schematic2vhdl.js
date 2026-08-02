"use strict";

/* =========================================================================
   Schematic Studio
   - vanilla JS + SVG, single file
   - features: projects with multiple schematics, top selection,
	 custom component wizard, bus signals, configurable multi-input
	 gates / MUX / DEMUX / encoders / decoders, JK / D / T / SR flip-flops
	 with rising/falling edge, save/load JSON, auto-save to localStorage,
	 synthesis check, VHDL generation for Spartan-7 / Vivado.
   ========================================================================= */

const SVGNS = "http://www.w3.org/2000/svg";
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const canvas = $("#canvas");

const GRID = 11;            // snap-to-grid step (px)
const AUTOSAVE_KEY = "schstudio.autosave.v2";
const AUTOSAVE_MS = 4000;
// crossing style: "plain" = clean ISE-style crossings, "hop" = bump over
let HOP_STYLE = "plain";
try { HOP_STYLE = localStorage.getItem("schstudio.hopStyle") || "plain"; } catch (_) { }

/* ---------- helpers ---------- */
let _uidN = 1;
const uid = (p = "i") => p + (_uidN++);
const VHDL_RESERVED = new Set(("abs access after alias all and architecture array assert attribute begin block body buffer bus case component configuration constant disconnect downto else elsif end entity exit file for function generate generic group guarded if impure in inertial inout is label library linkage literal loop map mod nand new next nor not null of on open or others out package port postponed procedure process pure range record register reject rem report return rol ror select severity shared signal sla sll sra srl subtype then to transport type unaffected units until use variable wait when while with xnor xor").split(" "));
const sanId = s => {
	s = (s || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
	// VHDL identifiers may not start/end with '_' nor contain '__'; a non-Latin name
	// (e.g. all-Thai) collapses to underscores here, so normalise then fall back —
	// otherwise the whole design fails to compile on an otherwise-valid label.
	s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
	if (!s) s = "net";
	if (/^[0-9]/.test(s)) s = "n_" + s;
	if (VHDL_RESERVED.has(s)) s += "_s";   // VHDL reserved word → keep identifier legal
	return s;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const snap = v => Math.round(v / GRID) * GRID;
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function el(tag, attrs = {}, children = []) {
	const e = document.createElementNS(SVGNS, tag);
	for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
	for (const c of children) if (c) e.appendChild(c);
	return e;
}
function txt(x, y, s, opts = {}) {
	const t = el("text", { x, y, fill: opts.fill || "var(--ink)", "text-anchor": opts.anchor || "start", "font-size": opts.size || 11, "font-weight": opts.weight || 500 });
	t.textContent = s;
	return t;
}
function toast(msg, kind = "info", ms = 2400) {
	const stack = $("#toastStack");
	while (stack.children.length >= 4) stack.firstChild.remove();
	const div = document.createElement("div");
	div.className = "toast " + ({ info: "", ok: "ok", warn: "warn", err: "err" }[kind] || "");
	div.textContent = msg;
	stack.appendChild(div);
	setTimeout(() => { div.style.opacity = "0"; div.style.transition = ".25s"; setTimeout(() => div.remove(), 250); }, ms);
}

/* =========================================================================
   COMPONENT TYPE DEFINITIONS
   Each entry provides:
	 label, category, defaultParams,
	 size(p) -> {w, h}
	 ports(p) -> [{ id, dir:'in'|'out', dx, dy, width, label? }]
	 shape(p) -> svg innerHTML for the body group (origin 0,0)
	 vhdl(ctx) -> { stmts:[], processes:[], decls:[] } (combinational gates
													   just return expr str)
   ========================================================================= */
const HBASE = 56;
const STEP = 24;

function gatePortsAndSize(p, withBubble = false) {
	const n = clamp(p.inputs || 2, 1, 8);
	// h = 22*(n+1) puts every input at 22*i and the output at 11*(n+1) —
	// all GRID (11px) multiples, so snapped components wire up dead straight
	const h = 22 * (n + 1);
	// width GROWS with the input count so a many-input gate stays balanced (not a thin
	// tall sliver); always a GRID multiple so the output port lands on the grid.
	const w = GRID * clamp(4 + n, 6, 12);   // n=2 → 66 … n=8 → 132
	const ins = [];
	for (let i = 0; i < n; i++) {
		ins.push({ id: "i" + i, dir: "in", dx: 0, dy: Math.round(h / (n + 1) * (i + 1)) });
	}
	const out = { id: "o", dir: "out", dx: w, dy: Math.round(h / 2) };
	return { ports: [...ins, out], size: { w, h } };
}
function gateBodyShape(p, kind) {
	const n = clamp(p.inputs || 2, 1, 8);
	const h = 22 * (n + 1);   // must match gatePortsAndSize
	const w = GRID * clamp(4 + n, 6, 12);   // must match gatePortsAndSize
	const cy = h / 2, r = (h - 12) / 2;
	const hasBubble = (kind === "nand" || kind === "nor" || kind === "xnor" || kind === "not");
	// AND cap radius scales with the (now input-count-scaled) width so the D-curve
	// fills the body proportionally instead of flattening into a box on tall gates.
	const rx = Math.min(r, Math.round(w * 0.4));
	// where input stubs end / the body's right tip (bubble + output stub start here)
	const inX = (kind === "or" || kind === "nor") ? 20 : (kind === "xor" || kind === "xnor") ? 13 : 15;
	const re = (kind === "and" || kind === "nand") ? Math.round((w * 0.55 + rx) * 10) / 10
		: (kind === "not" || kind === "buf") ? 14 + (h - 8) : w - 10;  // ISE: triangle width == height (1:1)
	// connection stubs so wires visually reach the gate body
	let stubs = "";
	for (let i = 0; i < n; i++) {
		const y = Math.round(h / (n + 1) * (i + 1));
		stubs += `<line x1="0" y1="${y}" x2="${inX}" y2="${y}" stroke="var(--gate-stroke)" stroke-width="1.7"/>`;
	}
	stubs += `<line x1="${re}" y1="${cy}" x2="${w}" y2="${cy}" stroke="var(--gate-stroke)" stroke-width="1.7"/>`;
	let body = "";
	if (kind === "and" || kind === "nand") {
		body = `<path class="glow" d="M14,6 L${w * 0.55},6 A${rx},${r} 0 0 1 ${w * 0.55},${h - 6} L14,${h - 6} Z"
            fill="var(--gate-fill)" stroke="var(--gate-stroke)" stroke-width="1.7"/>`;
	} else if (kind === "or" || kind === "nor" || kind === "xor" || kind === "xnor") {
		const bx = (kind === "xor" || kind === "xnor") ? 12 : 8;
		body = `<path class="glow" d="M${bx},6 Q${w * 0.32},${cy} ${bx},${h - 6}
            Q${w * 0.45},${h - 6} ${w - 10},${cy} Q${w * 0.45},6 ${bx},6 Z"
            fill="var(--gate-fill)" stroke="var(--gate-stroke)" stroke-width="1.7"/>`;
		if (kind === "xor" || kind === "xnor") {
			body = `<path d="M4,6 Q${w * 0.22},${cy} 4,${h - 6}" fill="none" stroke="var(--gate-stroke)" stroke-width="1.7"/>` + body;
		}
	} else if (kind === "not" || kind === "buf") {
		// ISE 14.7 inv/buf symbol: an isoceles triangle whose depth EQUALS its base
		// height (64x64 in ISE units, 1:1) — pointing right, filling the cell height
		body = `<path class="glow" d="M14,4 L${re},${cy} L14,${h - 4} Z" fill="var(--gate-fill)" stroke="var(--gate-stroke)" stroke-width="1.7"/>`;
	}
	// inversion bubble sits flush on the body tip; ISE draws the inverter bubble
	// noticeably larger (r = triangle/4) than the small gate-output bubbles
	const br = (kind === "not") ? 7 : 4;
	const bubble = hasBubble
		? `<circle cx="${re + br}" cy="${cy}" r="${br}" fill="var(--gate-fill)" stroke="var(--gate-stroke)" stroke-width="1.4"/>`
		: "";
	return stubs + body + bubble;
}
function gateDef(kind, label, op, defaultIns = 2) {
	return {
		label, category: "gate",
		defaultParams: kind === "not" || kind === "buf" ? { inputs: 1 } : { inputs: defaultIns },
		paramSchema: kind === "not" || kind === "buf" ? [] : [{ key: "inputs", label: "Inputs", type: "int", min: 2, max: 8 }],
		size(p) { return gatePortsAndSize(p).size; },
		ports(p) { return gatePortsAndSize(p).ports; },
		shape(p) { return gateBodyShape(p, kind); },
		expr(ins) {
			if (kind === "not") return `not ${ins[0]}`;
			if (kind === "buf") return `${ins[0]}`;
			if (kind === "and") return ins.join(" and ");
			if (kind === "or") return ins.join(" or ");
			if (kind === "nand") return "not (" + ins.join(" and ") + ")";
			if (kind === "nor") return "not (" + ins.join(" or ") + ")";
			if (kind === "xor") return ins.join(" xor ");
			if (kind === "xnor") return "not (" + ins.join(" xor ") + ")";
			return ins[0];
		}
	};
}

/* Block-style helpers for MUX / DEMUX / ENC / DEC / FF */
function blockSize(w, h) { return { w, h }; }
function blockShape(label, w, h, sub) {
	// title sits near the top so it never collides with per-pin labels on tall blocks
	return `<rect class="glow" x="6" y="6" width="${w - 12}" height="${h - 12}" rx="4"
            fill="var(--gate-fill)" stroke="var(--gate-stroke)" stroke-width="1.7"/>
          <text x="${w / 2}" y="22" text-anchor="middle" font-size="11.5" font-weight="600" fill="var(--ink)">${label}</text>
          ${sub ? `<text x="${w / 2}" y="34" text-anchor="middle" font-size="9.5" fill="var(--ink-dim)">${sub}</text>` : ""}`;
}
/* IN/OUT flag geometry: width follows the label so long names never overflow */
function ioLabel(p) { return (p.name || "") + ((p.width || 1) > 1 ? `(${p.width - 1}:0)` : ""); }
// width rounded up to a GRID multiple so the port x lands on the grid
function ioShapeW(p) { return Math.ceil(Math.max(56, Math.round(ioLabel(p).length * 6.3) + 28) / GRID) * GRID; }
/* clock-edge mark for flip-flops: triangle, plus a bubble for falling edge */
function edgeMark(cy, edge) {
	const off = edge === "falling" ? 7 : 0;
	const bub = edge === "falling"
		? `<circle cx="2.5" cy="${cy}" r="3.5" fill="var(--gate-fill)" stroke="var(--gate-stroke)" stroke-width="1.4"/>` : "";
	return `${bub}<polyline points="${off},${cy - 6} ${off + 8},${cy} ${off},${cy + 6}" fill="none" stroke="var(--gate-stroke)" stroke-width="1.6"/>`;
}

const TYPES = {
	/* ---------- I/O ---------- */
	IN: {
		label: "INPUT", category: "io",
		defaultParams: { name: "in", width: 1 },
		paramSchema: [
			{ key: "name", label: "Pin name", type: "string" },
			// BUS DISABLED (commented out — locks IN/OUT to 1 bit): {key:"width", label:"Bus width", type:"int", min:1, max:64},
		],
		size: p => ({ w: ioShapeW(p), h: 44 }),
		ports: p => { const w = ioShapeW(p); return [{ id: "o", dir: "out", dx: w, dy: 22, width: p.width }]; },
		shape(p) {
			const w = ioShapeW(p);
			return `<path class="glow" d="M2,8 L${w - 14},8 L${w - 2},22 L${w - 14},36 L2,36 Z"
                fill="var(--in-fill)" stroke="var(--in-stroke)" stroke-width="1.6"/>
              <text x="${(w - 12) / 2}" y="26" text-anchor="middle" font-size="11" fill="var(--in-text)" font-weight="600">${esc(ioLabel(p))}</text>`;
		}
	},
	OUT: {
		label: "OUTPUT", category: "io",
		defaultParams: { name: "out", width: 1 },
		paramSchema: [
			{ key: "name", label: "Pin name", type: "string" },
			// BUS DISABLED (commented out — locks IN/OUT to 1 bit): {key:"width", label:"Bus width", type:"int", min:1, max:64},
		],
		size: p => ({ w: ioShapeW(p), h: 44 }),
		ports: p => { const w = ioShapeW(p); return [{ id: "i", dir: "in", dx: 0, dy: 22, width: p.width }]; },
		shape(p) {
			const w = ioShapeW(p);
			return `<path class="glow" d="M0,22 L12,8 L${w - 2},8 L${w - 2},36 L12,36 Z"
                fill="var(--out-fill)" stroke="var(--out-stroke)" stroke-width="1.6"/>
              <text x="${(w + 12) / 2}" y="26" text-anchor="middle" font-size="11" fill="var(--out-text)" font-weight="600">${esc(ioLabel(p))}</text>`;
		}
	},
	VCC: {
		label: "VCC", category: "io",
		defaultParams: {}, paramSchema: [],
		size: _ => ({ w: 22, h: 33 }),
		ports: _ => [{ id: "o", dir: "out", dx: 11, dy: 33 }],
		shape: _ => `<line x1="11" y1="18" x2="11" y2="33" stroke="var(--in-stroke)" stroke-width="1.6"/>
              <line x1="0" y1="18" x2="22" y2="18" stroke="var(--in-stroke)" stroke-width="1.6"/>
              <text x="11" y="13" text-anchor="middle" font-size="10" fill="var(--in-text)" font-weight="600">VCC</text>`
	},
	GND: {
		label: "GND", category: "io",
		defaultParams: {}, paramSchema: [],
		size: _ => ({ w: 22, h: 33 }),
		// GND DRIVES '0' out (mirror of VCC driving '1') — it was mis-modelled as an
		// input sink, so a GND→gate wire was a sink-sink tie, driver() never saw GND as
		// a source, and the gate input fell through to the zero-fallback with a bogus
		// "pin not connected" warning. The pin sits at the top (dy:0); symbol hangs below.
		ports: _ => [{ id: "o", dir: "out", dx: 11, dy: 0 }],
		shape: _ => `<line x1="11" y1="0" x2="11" y2="14" stroke="var(--out-stroke)" stroke-width="1.6"/>
              <line x1="0" y1="14" x2="22" y2="14" stroke="var(--out-stroke)" stroke-width="1.8"/>
              <line x1="4" y1="20" x2="18" y2="20" stroke="var(--out-stroke)" stroke-width="1.6"/>
              <line x1="7" y1="26" x2="15" y2="26" stroke="var(--out-stroke)" stroke-width="1.6"/>
              <text x="11" y="33" text-anchor="middle" font-size="10" fill="var(--out-text)" font-weight="600">GND</text>`
	},
	JUNCTION: {
		label: "Junction", category: "wire",
		defaultParams: {}, paramSchema: [],
		size: _ => ({ w: 12, h: 12 }),
		// single port, transparent — both directions allowed; treated as "out"
		// so it can fan out to many sinks, but onPortClick relaxes the rule and
		// VHDL gen traces through it to find the real driver.
		ports: _ => [{ id: "j", dir: "out", dx: 6, dy: 6 }],
		// ISE-style connection marker: a small solid square in the wire colour
		shape: _ => `<rect x="1.5" y="1.5" width="9" height="9" fill="var(--wire)" stroke="none"/>`
	},

	/* ---------- Gates (multi-input) ---------- */
	AND: gateDef("and", "AND", "and"),
	OR: gateDef("or", "OR", "or"),
	NAND: gateDef("nand", "NAND", "nand"),
	NOR: gateDef("nor", "NOR", "nor"),
	XOR: gateDef("xor", "XOR", "xor"),
	XNOR: gateDef("xnor", "XNOR", "xnor"),
	NOT: gateDef("not", "NOT", "not"),
	BUF: gateDef("buf", "BUF", "buf"),

	/* ---------- MUX / DEMUX ---------- */
	/* MUX/DEMUX/ENC/DEC use one grid row (22px) per pin so every pin lands on
	   the 11px grid and always sits on the body edge — same as the gates. */
	MUX: {
		label: "MUX", category: "mux",
		defaultParams: { inputs: 2 },
		paramSchema: [{ key: "inputs", label: "Data inputs", type: "select", options: [2, 4, 8, 16] }],
		size(p) {
			const n = p.inputs; const sel = Math.ceil(Math.log2(n));
			return blockSize(99, 22 * (n + sel + 2));
		},
		ports(p) {
			const n = p.inputs; const sel = Math.ceil(Math.log2(n));
			const h = 22 * (n + sel + 2);
			const w = 99;
			const ports = [];
			for (let i = 0; i < n; i++)   ports.push({ id: "d" + i, dir: "in", dx: 0, dy: 22 * (i + 1), label: "d" + i });
			for (let i = 0; i < sel; i++) ports.push({ id: "s" + i, dir: "in", dx: 0, dy: h - 22 * (sel - i), label: "s" + i });
			ports.push({ id: "y", dir: "out", dx: w, dy: h / 2, label: "y" });
			return ports;
		},
		shape(p) {
			const n = p.inputs; const sel = Math.ceil(Math.log2(n));
			const h = 22 * (n + sel + 2);
			const w = 99;
			const taper = 10;
			return `<path class="glow" d="M6,4 L${w - 6},${4 + taper} L${w - 6},${h - 4 - taper} L6,${h - 4} Z"
              fill="var(--gate-fill)" stroke="var(--gate-stroke)" stroke-width="1.7"/>
              <text x="${w / 2}" y="${h / 2 - 6}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--ink)">MUX</text>
              <text x="${w / 2}" y="${h / 2 + 9}" text-anchor="middle" font-size="9.5" fill="var(--ink-dim)">${n}:1</text>`;
		}
	},
	DEMUX: {
		label: "DEMUX", category: "mux",
		defaultParams: { outputs: 2 },
		paramSchema: [{ key: "outputs", label: "Data outputs", type: "select", options: [2, 4, 8, 16] }],
		size(p) {
			const n = p.outputs; const sel = Math.ceil(Math.log2(n));
			return blockSize(99, 22 * Math.max(n + 1, sel + 3));
		},
		ports(p) {
			const n = p.outputs; const sel = Math.ceil(Math.log2(n));
			const h = 22 * Math.max(n + 1, sel + 3);
			const w = 99;
			const ports = [];
			ports.push({ id: "d", dir: "in", dx: 0, dy: 22, label: "d" });
			for (let i = 0; i < sel; i++) ports.push({ id: "s" + i, dir: "in", dx: 0, dy: h - 22 * (sel - i), label: "s" + i });
			for (let i = 0; i < n; i++)   ports.push({ id: "y" + i, dir: "out", dx: w, dy: 22 * (i + 1), label: "y" + i });
			return ports;
		},
		shape(p) {
			const n = p.outputs; const sel = Math.ceil(Math.log2(n));
			const h = 22 * Math.max(n + 1, sel + 3);
			const w = 99;
			const taper = 10;
			return `<path class="glow" d="M6,${4 + taper} L${w - 6},4 L${w - 6},${h - 4} L6,${h - 4 - taper} Z"
              fill="var(--gate-fill)" stroke="var(--gate-stroke)" stroke-width="1.7"/>
              <text x="${w / 2}" y="${h / 2 - 6}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--ink)">DEMUX</text>
              <text x="${w / 2}" y="${h / 2 + 9}" text-anchor="middle" font-size="9.5" fill="var(--ink-dim)">1:${n}</text>`;
		}
	},

	/* ---------- BUS TAP ----------
	   ISE hollow-triangle tap that pulls a bit or bit-range off a bus. It has no
	   width parameter — the input side inherits the width of whichever bus it is
	   attached to (via netWidth at render / driverWidth in VHDL). hi==lo selects
	   a single bit; hi>lo an inclusive sub-bus. Set hi/lo in the Inspector. */
	BUSTAP: {
		label: "Bus Tap", category: "bus",
		defaultParams: { hi: 0, lo: 0, dir: "right" },
		paramSchema: [
			{ key: "hi", label: "บิตบน (hi)", type: "int", min: 0, max: 63 },
			{ key: "lo", label: "บิตล่าง (lo)", type: "int", min: 0, max: 63 },
			{ key: "dir", label: "ทิศทาง", type: "select", options: ["right", "down", "left", "up"] },
		],
		// 33 in the EXTEND direction (easy to grab), 22 ALONG the bus (adjacent taps at a
		// 22 pitch never overlap). Every port lands on the grid (11/33 = GRID multiples).
		size(p) { return (p.dir === "down" || p.dir === "up") ? { w: 22, h: 33 } : { w: 33, h: 22 }; },
		ports(p) {
			const hi = Math.max(p.hi ?? 0, p.lo ?? 0), lo = Math.min(p.hi ?? 0, p.lo ?? 0);
			const ow = hi - lo + 1;                       // width of the tapped output
			// d.width:2 is only a "this pin is a bus" marker for rendering (a square); the
			// real bus width is derived live from the attached net. d sits on the bus side,
			// y (the bit output) on the opposite side.
			const D = { id: "d", dir: "in", width: 2, label: "" }, Y = { id: "y", dir: "out", width: ow, label: "" };
			switch (p.dir) {
				case "down": return [{ ...D, dx: 11, dy: 0 }, { ...Y, dx: 11, dy: 33 }];
				case "up": return [{ ...D, dx: 11, dy: 33 }, { ...Y, dx: 11, dy: 0 }];
				case "left": return [{ ...D, dx: 33, dy: 11 }, { ...Y, dx: 0, dy: 11 }];
				default: return [{ ...D, dx: 0, dy: 11 }, { ...Y, dx: 33, dy: 11 }];   // right
			}
		},
		shape(p) {
			const hi = Math.max(p.hi ?? 0, p.lo ?? 0), lo = Math.min(p.hi ?? 0, p.lo ?? 0);
			const single = hi === lo;
			const rng = single ? `(${hi})` : `(${hi}:${lo})`;
			const tw = single ? 1.5 : 2.2;
			const W = (p.dir === "down" || p.dir === "up") ? 22 : 33;
			// a CLOSED triangle: broad BASE flush ON the bus (the d side), TIP is the bit
			// output — an ISE-style rip. Four orientations, label sits above.
			const tri = {
				right: "M0,0 L33,11 L0,22 Z", left: "M33,0 L0,11 L33,22 Z",
				down: "M0,0 L11,33 L22,0 Z", up: "M0,33 L11,0 L22,33 Z"
			}[p.dir] || "M0,0 L33,11 L0,22 Z";
			return `<path class="glow" d="${tri}" fill="var(--gate-fill)" stroke="var(--wire-bus)" stroke-width="${tw}"/>
              <text x="${W / 2}" y="-3" text-anchor="middle" font-size="8" fill="var(--ink-dim)">${rng}</text>`;
		}
	},


	/* ---------- Encoder / Decoder (priority) ---------- */
	ENC: {
		label: "ENCODER", category: "code",
		defaultParams: { inputs: 4 },
		paramSchema: [{ key: "inputs", label: "Data inputs", type: "select", options: [4, 8, 16] }],
		size(p) {
			const n = p.inputs; const ow = Math.ceil(Math.log2(n));
			return blockSize(110, 22 * (Math.max(n, ow) + 1));
		},
		ports(p) {
			const n = p.inputs; const ow = Math.ceil(Math.log2(n));
			const w = 110;
			const ports = [];
			for (let i = 0; i < n; i++)  ports.push({ id: "i" + i, dir: "in", dx: 0, dy: 22 * (i + 1), label: "i" + i });
			for (let i = 0; i < ow; i++) ports.push({ id: "y" + i, dir: "out", dx: w, dy: 22 * (i + 1), label: "y" + i });
			return ports;
		},
		shape(p) {
			const n = p.inputs; const ow = Math.ceil(Math.log2(n));
			return blockShape("ENCODER", 110, 22 * (Math.max(n, ow) + 1), `${n} → ${ow}`);
		}
	},
	DEC: {
		label: "DECODER", category: "code",
		defaultParams: { outputs: 4 },
		paramSchema: [{ key: "outputs", label: "Data outputs", type: "select", options: [4, 8, 16] }],
		size(p) {
			const n = p.outputs; const iw = Math.ceil(Math.log2(n));
			return blockSize(110, 22 * (Math.max(n, iw + 1) + 1));
		},
		ports(p) {
			const n = p.outputs; const iw = Math.ceil(Math.log2(n));
			const w = 110;
			const ports = [];
			for (let i = 0; i < iw; i++) ports.push({ id: "a" + i, dir: "in", dx: 0, dy: 22 * (i + 1), label: "a" + i });
			ports.push({ id: "en", dir: "in", dx: 0, dy: 22 * (iw + 1), label: "en" });
			for (let i = 0; i < n; i++)  ports.push({ id: "y" + i, dir: "out", dx: w, dy: 22 * (i + 1), label: "y" + i });
			return ports;
		},
		shape(p) {
			const n = p.outputs; const iw = Math.ceil(Math.log2(n));
			return blockShape("DECODER", 110, 22 * (Math.max(n, iw + 1) + 1), `${iw} → ${n}`);
		}
	},

	/* ---------- Flip-Flops ---------- */
	DFF: {
		label: "D-FF", category: "ff",
		defaultParams: { edge: "rising", reset: false, preset: false },
		paramSchema: [
			{ key: "edge", label: "Clock edge", type: "select", options: ["rising", "falling"] },
			{ key: "reset", label: "Async reset", type: "bool" },
			{ key: "preset", label: "Async preset", type: "bool" }
		],
		size(p) { return blockSize(88, 77); },
		ports(p) {
			// all pin offsets are GRID multiples → straight wiring when snapped
			const ports = [
				{ id: "d", dir: "in", dx: 0, dy: 22, label: "" },
				{ id: "clk", dir: "in", dx: 0, dy: 55, label: "" }
			];
			if (p.reset) ports.push({ id: "rst", dir: "in", dx: 22, dy: 77, label: "" });
			if (p.preset) ports.push({ id: "pre", dir: "in", dx: 66, dy: 0, label: "" });
			ports.push({ id: "q", dir: "out", dx: 88, dy: 22, label: "" });
			ports.push({ id: "qn", dir: "out", dx: 88, dy: 55, label: "" });
			return ports;
		},
		shape(p) {
			const tri = edgeMark(55, p.edge);
			return `<rect class="glow" x="6" y="6" width="76" height="65" rx="4" fill="var(--gate-fill)" stroke="var(--gate-stroke)" stroke-width="1.7"/>
              <text x="44" y="44" text-anchor="middle" font-size="11" font-weight="600" fill="var(--ink)">D-FF</text>
              <text x="14" y="26" font-size="10" fill="var(--ink-dim)">D</text>
              <text x="74" y="26" text-anchor="end" font-size="10" fill="var(--ink-dim)">Q</text>
              <text x="74" y="59" text-anchor="end" font-size="10" fill="var(--ink-dim)">Q̅</text>
              <g transform="translate(6,0)">${tri}</g>
              ${p.reset ? `<text x="25" y="68" font-size="9" fill="var(--err)">R</text>` : ""}
              ${p.preset ? `<text x="57" y="16" font-size="8" fill="var(--ok)">P</text>` : ""}`;
		}
	},
	JKFF: {
		label: "JK-FF", category: "ff",
		defaultParams: { edge: "rising", reset: false, preset: false },
		paramSchema: [
			{ key: "edge", label: "Clock edge", type: "select", options: ["rising", "falling"] },
			{ key: "reset", label: "Async reset", type: "bool" },
			{ key: "preset", label: "Async preset", type: "bool" }
		],
		size(p) { return blockSize(88, 88); },
		ports(p) {
			const ports = [
				{ id: "j", dir: "in", dx: 0, dy: 22, label: "" },
				{ id: "k", dir: "in", dx: 0, dy: 44, label: "" },
				{ id: "clk", dir: "in", dx: 0, dy: 66, label: "" }
			];
			if (p.reset) ports.push({ id: "rst", dir: "in", dx: 22, dy: 88, label: "" });
			if (p.preset) ports.push({ id: "pre", dir: "in", dx: 66, dy: 0, label: "" });
			ports.push({ id: "q", dir: "out", dx: 88, dy: 22, label: "" });
			ports.push({ id: "qn", dir: "out", dx: 88, dy: 44, label: "" });
			return ports;
		},
		shape(p) {
			const tri = edgeMark(66, p.edge);
			return `<rect class="glow" x="6" y="6" width="76" height="76" rx="4" fill="var(--gate-fill)" stroke="var(--gate-stroke)" stroke-width="1.7"/>
              <text x="48" y="69" text-anchor="middle" font-size="11" font-weight="600" fill="var(--ink)">JK-FF</text>
              <text x="14" y="26" font-size="10" fill="var(--ink-dim)">J</text>
              <text x="14" y="48" font-size="10" fill="var(--ink-dim)">K</text>
              <text x="74" y="26" text-anchor="end" font-size="10" fill="var(--ink-dim)">Q</text>
              <text x="74" y="48" text-anchor="end" font-size="10" fill="var(--ink-dim)">Q̅</text>
              <g transform="translate(6,0)">${tri}</g>
              ${p.reset ? `<text x="25" y="80" font-size="9" fill="var(--err)">R</text>` : ""}
              ${p.preset ? `<text x="57" y="16" font-size="8" fill="var(--ok)">P</text>` : ""}`;
		}
	},
	TFF: {
		label: "T-FF", category: "ff",
		defaultParams: { edge: "rising", reset: false, preset: false },
		paramSchema: [
			{ key: "edge", label: "Clock edge", type: "select", options: ["rising", "falling"] },
			{ key: "reset", label: "Async reset", type: "bool" },
			{ key: "preset", label: "Async preset", type: "bool" }
		],
		size(p) { return blockSize(88, 77); },
		ports(p) {
			const ports = [
				{ id: "t", dir: "in", dx: 0, dy: 22, label: "" },
				{ id: "clk", dir: "in", dx: 0, dy: 55, label: "" }
			];
			if (p.reset) ports.push({ id: "rst", dir: "in", dx: 22, dy: 77, label: "" });
			if (p.preset) ports.push({ id: "pre", dir: "in", dx: 55, dy: 0, label: "" });
			ports.push({ id: "q", dir: "out", dx: 88, dy: 33, label: "" });
			return ports;
		},
		shape(p) {
			const tri = edgeMark(55, p.edge);
			return `<rect class="glow" x="6" y="6" width="76" height="65" rx="4" fill="var(--gate-fill)" stroke="var(--gate-stroke)" stroke-width="1.7"/>
              <text x="42" y="52" text-anchor="middle" font-size="11" font-weight="600" fill="var(--ink)">T-FF</text>
              <text x="14" y="26" font-size="10" fill="var(--ink-dim)">T</text>
              <text x="74" y="37" text-anchor="end" font-size="10" fill="var(--ink-dim)">Q</text>
              <g transform="translate(6,0)">${tri}</g>
              ${p.reset ? `<text x="25" y="68" font-size="9" fill="var(--err)">R</text>` : ""}
              ${p.preset ? `<text x="47" y="16" font-size="8" fill="var(--ok)">P</text>` : ""}`;
		}
	},
	SRFF: {
		label: "SR-FF", category: "ff",
		defaultParams: { edge: "rising", reset: false, preset: false },
		paramSchema: [
			{ key: "edge", label: "Clock edge", type: "select", options: ["rising", "falling"] },
		],
		size(p) { return blockSize(88, 88); },
		ports(p) {
			return [
				{ id: "s", dir: "in", dx: 0, dy: 22, label: "" },
				{ id: "r", dir: "in", dx: 0, dy: 44, label: "" },
				{ id: "clk", dir: "in", dx: 0, dy: 66, label: "" },
				{ id: "q", dir: "out", dx: 88, dy: 22, label: "" },
				{ id: "qn", dir: "out", dx: 88, dy: 55, label: "" }
			];
		},
		shape(p) {
			const tri = edgeMark(66, p.edge);
			return `<rect class="glow" x="6" y="6" width="76" height="76" rx="4" fill="var(--gate-fill)" stroke="var(--gate-stroke)" stroke-width="1.7"/>
              <text x="48" y="76" text-anchor="middle" font-size="11" font-weight="600" fill="var(--ink)">SR-FF</text>
              <text x="14" y="26" font-size="10" fill="var(--ink-dim)">S</text>
              <text x="14" y="48" font-size="10" fill="var(--ink-dim)">R</text>
              <text x="74" y="26" text-anchor="end" font-size="10" fill="var(--ink-dim)">Q</text>
              <text x="74" y="59" text-anchor="end" font-size="10" fill="var(--ink-dim)">Q̅</text>
              <g transform="translate(6,0)">${tri}</g>`;
		}
	}
};

/* ---------- helpers for type system ---------- */
function typeDef(c) {
	if (c.type.startsWith("CUSTOM:")) {
		const name = c.type.slice(7);
		const cc = state.project.customs[name];
		if (cc) return customTypeDef(cc);
	}
	if (c.type.startsWith("SCH:")) {
		const sid = c.type.slice(4);
		const sch = state.project.schematics[sid];
		if (sch) return schTypeDef(sch);
	}
	return TYPES[c.type];
}
function getPorts(c) { const td = typeDef(c); return td ? td.ports(c.params || {}) : []; }
function getSize(c) { const td = typeDef(c); return td ? td.size(c.params || {}) : { w: 40, h: 40 }; }
function getPort(c, pid) { return getPorts(c).find(p => p.id === pid); }

/* Remove every placed instance of a type (e.g. "SCH:xxx" or "CUSTOM:name")
   from all schematics and stored customs, together with their wires. */
function removeInstancesOf(typeStr) {
	let n = 0;
	const scrub = sch => {
		if (!sch || !sch.components) return;
		const ids = new Set(sch.components.filter(c => c.type === typeStr).map(c => c.id));
		if (!ids.size) return;
		n += ids.size;
		sch.components = sch.components.filter(c => !ids.has(c.id));
		sch.wires = (sch.wires || []).filter(w => !ids.has(w.from.cid) && !ids.has(w.to.cid));
	};
	Object.values(state.project.schematics).forEach(scrub);
	Object.values(state.project.customs).forEach(cc => scrub(cc.schematic));
	return n;
}
/* Rewrite a component type everywhere (used when renaming a custom component) */
function rewriteInstanceType(from, to) {
	const walk = sch => sch && (sch.components || []).forEach(c => { if (c.type === from) c.type = to; });
	Object.values(state.project.schematics).forEach(walk);
	Object.values(state.project.customs).forEach(cc => walk(cc.schematic));
}
/* Auto-weld: a dangling wire end (free-endpoint junction, 1 wire) that lands
   exactly on top of another wire — or on another dangling end — is what the
   user means to CONNECT. Turn it into a real solid junction (split the host
   wire through it, or merge the two ends), so every point where wires actually
   meet shows a connection square and is electrically joined. Only fires on an
   exact overlap (<2px), so deliberately-parked stubs are never grabbed. */
function weldTouchingEnds(sch) {
	sch = sch || activeSch();
	const jWiresOf = j => sch.wires.filter(w => w.from.cid === j.id || w.to.cid === j.id);
	// flood j's OWN net through junctions → the wires/nodes we must never weld to
	// (welding onto our own net would make a self-loop that heal collapses to a
	//  corrupt from===to wire)
	const ownNet = j => {
		const wires = new Set(), nodes = new Set([j.id]), stack = [j.id];
		while (stack.length) {
			const jid = stack.pop();
			sch.wires.forEach(w => {
				if (w.from.cid !== jid && w.to.cid !== jid) return;
				wires.add(w.id);
				const other = w.from.cid === jid ? w.to : w.from;
				const oc = comp(other.cid, sch);
				if (oc && oc.type === "JUNCTION" && !nodes.has(oc.id)) { nodes.add(oc.id); stack.push(oc.id); }
			});
		}
		return { wires, nodes };
	};
	let welded = false, again = true, guard = 0;
	while (again && guard++ < 60) {
		again = false;
		const ends = sch.components.filter(c => c.type === "JUNCTION"
			&& c.params && c.params.endpoint && !c.params.busName   // plain free ends only
			&& jWiresOf(c).length === 1);
		for (const j of ends) {
			if (state.pendingWire && state.pendingWire.cid === j.id) continue;  // not the wire being drawn
			const jp = portPos(j, "j");
			const net = ownNet(j);
			// width the end "wants": the widest real port on its net (a driverless end
			// reads as 1 via netWidth, but it may connect to a 4-bit port — use that)
			let jWidth = 1;
			net.wires.forEach(wid => {
				const w = sch.wires.find(x => x.id === wid); if (!w) return;
				[w.from, w.to].forEach(ep => {
					const c0 = comp(ep.cid, sch);
					if (c0 && c0.type !== "JUNCTION") { const p = getPort(c0, ep.pid); if (p) jWidth = Math.max(jWidth, p.width || 1); }
				});
				const nwd = netWidth(w, sch); if (nwd > jWidth) jWidth = nwd;   // also honour a bus-def on the net
			});
			// (a) coincides with another junction NOT on our net, same width → merge
			const twin = sch.components.find(c => c !== j && c.type === "JUNCTION" && !net.nodes.has(c.id) && (() => {
				const p = portPos(c, "j"); return Math.abs(p.x - jp.x) < 2 && Math.abs(p.y - jp.y) < 2;
			})());
			if (twin) {
				const tw = sch.wires.find(w => w.from.cid === twin.id || w.to.cid === twin.id);
				const twinWidth = tw ? netWidth(tw, sch) : jWidth;
				if (twinWidth === jWidth) {
					sch.wires.forEach(w => {
						if (w.from.cid === j.id) w.from = { cid: twin.id, pid: "j" };
						if (w.to.cid === j.id) w.to = { cid: twin.id, pid: "j" };
					});
					if (twin.params && twin.params.endpoint) delete twin.params.endpoint;
					sch.components = sch.components.filter(c => c !== j);
					welded = true; again = true; break;
				}
			}
			// (b) lands exactly on another wire (not our own net) of the SAME width →
			// split it through j. Width must match: silently joining an 8-bit bus to a
			// 1-bit wire would be a corrupt net (use a Bus Tap for bus→bit instead).
			let host = null;
			for (const w of sch.wires) {
				if (net.wires.has(w.id)) continue;                 // never weld onto our own net
				const at = nearestOnWire(w, jp, 0, sch);
				if (at && at.d < 2 && netWidth(w, sch) === jWidth) { host = w; break; }
			}
			if (host) {
				delete j.params.endpoint;              // now a real connected junction
				splitWireThroughJunction(host, j, sch);
				welded = true; again = true; break;
			}
		}
	}
	return welded;
}
/* Junctions are managed automatically (created by tapping a wire) — this
   sweeps the ones that no longer serve a purpose:
	 0 wires            → remove the stray dot
	 1 wire             → remove the dangling stub (junction + its wire)
	 1 in + 1 out       → pass-through: merge back into a single wire
   A junction that the live pendingWire starts from is left alone.
   (Auto-welding of touching ends is a LIVE-EDIT action — see weldTouchingEnds,
	called from finishWireInSpace and drag-end — NOT here, so loading a saved
	project never silently alters geometry the user parked on purpose.) */
function healJunctions(sch) {
	sch = sch || activeSch();
	if (!sch) return;
	let changed = true;
	while (changed) {
		changed = false;
		for (const j of sch.components.filter(c => c.type === "JUNCTION")) {
			if (!sch.components.includes(j)) continue;   // already merged away this pass
			if (state.pendingWire && state.pendingWire.cid === j.id) continue;
			const ins = sch.wires.filter(w => w.to.cid === j.id);
			const outs = sch.wires.filter(w => w.from.cid === j.id);
			const total = ins.length + outs.length;
			// a floating-bus definition node holds the bus name+width — keep it intact
			// (never stub-drop or merge) as long as it still carries a wire
			if (j.params && j.params.busName && total > 0) continue;
			if (total === 0) {
				sch.components = sch.components.filter(c => c !== j);
				changed = true;
			} else if (total === 1 && j.params && j.params.endpoint) {
				// a deliberate free wire end (drawn into open space) — keep the stub
				continue;
			} else if (total === 1) {
				sch.components = sch.components.filter(c => c !== j);
				sch.wires = sch.wires.filter(w => w.from.cid !== j.id && w.to.cid !== j.id);
				changed = true;
			} else if (ins.length === 1 && outs.length === 1) {
				const a = ins[0], b = outs[0];
				const jp = portPos(j, "j");
				sch.components = sch.components.filter(c => c !== j);
				sch.wires = sch.wires.filter(w => w !== a && w !== b);
				const merged = { id: uid("w"), from: a.from, to: b.to, name: a.name || b.name || "" };
				// preserve manual waypoints through the removed junction point
				if (a.pts || b.pts) merged.pts = [...(a.pts || []), { x: jp.x, y: jp.y }, ...(b.pts || [])];
				sch.wires.push(merged);
				changed = true;
			} else {
				// ISE has ONE dot per branch point — never two a grid apart joined by a
				// stub. Collapse a fan-out junction that sits on top of another junction,
				// or is joined to one by a single short straight stub, into a single dot.
				const jp = portPos(j, "j");
				if (j.params && j.params.busName) continue;   // keep bus-def nodes distinct
				const twin = sch.components.find(k => {
					if (k === j || k.type !== "JUNCTION") return false;
					if (k.params && k.params.busName) return false;
					const kp = portPos(k, "j");
					if (Math.abs(kp.x - jp.x) < 2 && Math.abs(kp.y - jp.y) < 2) return true;   // coincident
					const stub = sch.wires.find(w => (w.from.cid === j.id && w.to.cid === k.id) || (w.from.cid === k.id && w.to.cid === j.id));
					if (!stub || (stub.pts && stub.pts.length)) return false;         // must be a plain stub
					const straight = Math.abs(kp.x - jp.x) < 1 || Math.abs(kp.y - jp.y) < 1;  // collinear H or V
					return straight && (Math.abs(kp.x - jp.x) + Math.abs(kp.y - jp.y)) <= 1.5 * GRID;
				});
				if (twin) {
					// A dot the user dragged is pinned (params.fixed) so it stays exactly
					// where they parked it — this merge must not silently delete it in
					// favor of whichever junction happened to be iterated first. If both
					// sides were parked by hand, leave them both alone; we can't guess
					// which placement wins. Otherwise the pinned one (if any) survives
					// and the unpinned one is the one folded away.
					const jFixed = !!(j.params && j.params.fixed);
					const twinFixed = !!(twin.params && twin.params.fixed);
					if (jFixed && twinFixed) continue;
					const keep = twinFixed ? twin : j;
					const drop = twinFixed ? j : twin;
					const wA = sch.wires.find(w => w.from.cid === keep.id || w.to.cid === keep.id);
					const wB = sch.wires.find(w => w.from.cid === drop.id || w.to.cid === drop.id);
					// CRITICAL: two coincident dots of DIFFERENT nets (both scalar) would weld
					// and SHORT the nets — silently wrong VHDL. Weld only when they are already
					// electrically one net: joined by the stub, or tracing to the same driver.
					const drvKey = jj => { const wf = sch.wires.find(w => w.from.cid === jj.id); if (!wf) return "solo:" + jj.id; const d = netDriverPort(sch, wf); return d ? d.cid + "." + d.pid : "solo:" + jj.id; };
					const joinedByStub = sch.wires.some(w => (w.from.cid === keep.id && w.to.cid === drop.id) || (w.from.cid === drop.id && w.to.cid === keep.id));
					const sameNet = joinedByStub || drvKey(keep) === drvKey(drop);
					if (sameNet && (!wA || !wB || netWidth(wA, sch) === netWidth(wB, sch))) {   // don't weld across a width boundary
						sch.wires.forEach(w => {
							if (w.from.cid === drop.id) w.from = { cid: keep.id, pid: "j" };
							if (w.to.cid === drop.id) w.to = { cid: keep.id, pid: "j" };
						});
						sch.components = sch.components.filter(c => c !== drop);
						sch.wires = sch.wires.filter(w => w.from.cid !== w.to.cid);   // drop the collapsed stub
						changed = true;
					}
				}
			}
		}
	}
}
/* Re-seed the uid counter after loading external data so new ids never collide */
/* Lift the uid counter above every id in p (default: the live project). Takes p so
   deserialize can seed from a project it has NOT committed yet — anything that mints
   ids before this runs (normalizePortFanout's junctions) would collide with loaded
   ids, and a duplicate cid silently re-points wires at the wrong component. */
function reseedUid(p) {
	let mx = 0;
	const scan = id => { const m = /(\d+)$/.exec(id || ""); if (m) mx = Math.max(mx, +m[1]); };
	p = p || state.project;
	Object.keys(p.schematics).forEach(sid => {
		scan(sid);
		const s = p.schematics[sid];
		(s.components || []).forEach(c => scan(c.id));
		(s.wires || []).forEach(w => scan(w.id));
	});
	Object.values(p.customs || {}).forEach(cc => {
		if (!cc.schematic) return;
		(cc.schematic.components || []).forEach(c => scan(c.id));
		(cc.schematic.wires || []).forEach(w => scan(w.id));
	});
	if (mx >= _uidN) _uidN = mx + 1;
}
/* THE single source of truth for a wire's width: the width of the port that
   ultimately drives its net, traced through width-transparent junctions.
   Never cached — always derived, so it can never go stale. */
function netWidth(w, sch, visited) {
	sch = sch || activeSch();
	visited = visited || new Set();
	if (visited.has(w.id)) return 1;          // cycle guard
	visited.add(w.id);
	const src = comp(w.from.cid, sch);
	if (!src) return 1;
	if (src.type === "JUNCTION") {
		const up = sch.wires.find(x => x.to.cid === src.id);
		if (up) return netWidth(up, sch, visited);
		if (src.params && src.params.busWidth) return src.params.busWidth;  // floating bus def
		return 1;
	}
	const fp = getPort(src, w.from.pid);
	return fp ? (fp.width || 1) : 1;
}
/* Ensure a schematic name is unique in the project (excluding one id) */
function uniqueSchName(base, excludeId) {
	let nm = sanId(base) || "sch";
	const taken = () => Object.keys(state.project.schematics)
		.some(id => id !== excludeId && state.project.schematics[id].name === nm);
	let k = 2; const root = nm;
	while (taken()) nm = root + "_" + (k++);
	return nm;
}

/* Derive port list of a custom component (from its inner schematic) */
/* THE canonical port list of a schematic used as a sub-block: IN ports then OUT
   ports, names deduped EXACTLY as generateSchVhdl dedups its entity's own _net
   (inputs first). Every place that must agree on the sub-entity's port names —
   the entity itself, its component declaration, the port-map formals, and the
   drawn block's pins — derives from here, so an IN and an OUT sharing a name
   become foo / foo_1 consistently instead of a duplicate/ mismatched formal. */
function schPortList(sch) {
	const used = {};
	const uq = b => { let n = sanId(b) || "net", i = 1; while (used[n]) n = sanId(b) + "_" + (i++); used[n] = 1; return n; };
	const out = [];
	(sch.components || []).filter(c => c.type === "IN").forEach(c => out.push({ id: uq(c.params.name || "in"), name: c.params.name, dir: "in", width: c.params.width || 1 }));
	(sch.components || []).filter(c => c.type === "OUT").forEach(c => out.push({ id: uq(c.params.name || "out"), name: c.params.name, dir: "out", width: c.params.width || 1 }));
	return out;
}
function customPorts(cc) {
	// new format: cc.schematic — use the shared, deduped list (name kept for the API)
	if (cc.schematic) return schPortList(cc.schematic).map(p => ({ name: p.id, dir: p.dir, width: p.width }));
	// legacy format
	return (cc.ports || []).map(p => ({ name: p.name, dir: p.dir, width: p.width || 1 }));
}

/* Custom component treated as a type def (drawn as a purple block) */
function customTypeDef(cc) {
	const ports = customPorts(cc);
	const ins = ports.filter(p => p.dir === "in");
	const outs = ports.filter(p => p.dir === "out");
	const n = Math.max(ins.length, outs.length, 2);
	const w = 120, h = Math.max(64, 14 + 22 * n);
	return {
		label: cc.name, category: "custom",
		defaultParams: {}, paramSchema: [],
		size: _ => ({ w, h }),
		ports() {
			const out = [];
			ins.forEach((p, i) => out.push({ id: p.name, dir: "in", dx: 0, dy: 14 + 22 * i, label: p.name, width: p.width || 1 }));
			outs.forEach((p, i) => out.push({ id: p.name, dir: "out", dx: w, dy: 14 + 22 * i, label: p.name, width: p.width || 1 }));
			return out;
		},
		shape: _ => `<rect class="glow" x="6" y="6" width="${w - 12}" height="${h - 12}" rx="4"
              fill="#2a1f3a" stroke="#c084fc" stroke-width="1.7"/>
              <text x="${w / 2}" y="${h / 2 - 2}" text-anchor="middle" font-size="11" font-weight="700" fill="#e9d5ff">${esc(cc.name)}</text>
              <text x="${w / 2}" y="${h / 2 + 12}" text-anchor="middle" font-size="9" fill="var(--ink-dim)">(custom)</text>`,
		_custom: cc
	};
}
/* Sub-schematic instance treated as a type def */
function schTypeDef(sch) {
	const ins = (sch.components || []).filter(c => c.type === "IN");
	const outs = (sch.components || []).filter(c => c.type === "OUT");
	const n = Math.max(ins.length, outs.length, 2);
	// GRID-aligned like the gates: pins every 22px starting at 22, width a multiple
	// of 11 — a snapped instance then has every pin exactly ON a grid point, so
	// wires meet the block dead straight (off-grid pins were a "สายหัก" source)
	const w = 121, h = 22 * (n + 1);
	return {
		label: sch.name, category: "sch",
		defaultParams: {}, paramSchema: [],
		size: _ => ({ w, h }),
		ports() {
			// ids come from the shared deduped list so port-map formals match the
			// sub-entity exactly (an IN+OUT with one name become foo/foo_1, not foo×2)
			const list = schPortList(sch);
			const insL = list.filter(p => p.dir === "in"), outsL = list.filter(p => p.dir === "out");
			const out = [];
			insL.forEach((p, i) => out.push({ id: p.id, dir: "in", dx: 0, dy: 22 * (i + 1), label: p.name, width: p.width }));
			outsL.forEach((p, i) => out.push({ id: p.id, dir: "out", dx: w, dy: 22 * (i + 1), label: p.name, width: p.width }));
			return out;
		},
		shape: _ => `<rect class="glow" x="6" y="6" width="${w - 12}" height="${h - 12}" rx="4"
              fill="#1f2a3a" stroke="#5dd5ff" stroke-width="1.7"/>
              <text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-size="11" font-weight="700" fill="#cfeaff">${esc(sch.name)}</text>
              <text x="${w / 2}" y="${h / 2 + 14}" text-anchor="middle" font-size="9" fill="var(--ink-dim)">(sub-schematic)</text>`,
		_sch: sch
	};
}

/* =========================================================================
   STATE
   ========================================================================= */
const state = {
	project: blankProject(),
	activeId: null,           // current schematic id
	openTabs: [],             // [schId]
	selection: new Set(),     // component or wire ids in active schematic
	pendingWire: null,        // {cid,pid,isOut,pts[]} while drawing, or {onWire} branch
	wireDrag: null,           // {w, kind, m0, moved, shift} — rerouting a wire
	cornerDrag: null,         // {w, index} — dragging a waypoint corner of a poly wire
	spaceDown: false,         // Space held = grab-to-pan mode
	tool: "select",           // ISE-style modal tool: select|wire|netname|iomarker
	drag: null,
	pan: null,
	view: { x: 0, y: 0, k: 1 },
	mouse: { x: 0, y: 0 },
	hover: null,
	history: { stack: [], idx: -1, muted: false },
	autosaveTimer: null,
	clipboard: null,           // {components:[], wires:[]}
};
function blankProject() {
	const id = uid("sch");
	return {
		name: "my_project",
		topId: id,
		schematics: { [id]: blankSchematic(id, "top") },
		customs: {}
	};
}
function blankSchematic(id, name) {
	return { id, name, components: [], wires: [] };
}

/* convenience */
function activeSch() { return state.project.schematics[state.activeId]; }
function comp(cid, sch = activeSch()) { return sch.components.find(c => c.id === cid); }

/* =========================================================================
   HISTORY (undo/redo)
   ========================================================================= */
function snapshot() {
	if (state.history.muted) return;
	const s = JSON.stringify({ p: state.project, a: state.activeId, t: state.openTabs });
	const h = state.history;
	h.stack = h.stack.slice(0, h.idx + 1);
	h.stack.push(s);
	if (h.stack.length > 80) h.stack.shift();
	h.idx = h.stack.length - 1;
}
function restore(s) {
	const o = JSON.parse(s);
	state.project = o.p;
	state.activeId = o.a;
	state.openTabs = o.t;
	state.selection.clear();
	state.pendingWire = null;
	renderAll();
}
function undo() { if (state.history.idx > 0) { state.history.idx--; restore(state.history.stack[state.history.idx]); } }
function redo() { if (state.history.idx < state.history.stack.length - 1) { state.history.idx++; restore(state.history.stack[state.history.idx]); } }

/* =========================================================================
   PROJECT TREE (left pane "Project")
   ========================================================================= */
function renderProjectTree() {
	const root = $("#projectPane");
	const p = state.project;
	const html = [];
	html.push(`<div class="tree">`);

	// Schematics
	html.push(`<div class="tree-group"><h4>SCHEMATICS
    <button class="add" title="New schematic" data-act="new-sch">+</button></h4>`);
	for (const id in p.schematics) {
		const sch = p.schematics[id];
		const isTop = id === p.topId;
		const isActive = id === state.activeId;
		html.push(`<div class="tree-item ${isActive ? "active" : ""} ${isTop ? "top" : ""}" data-open="${id}">
      <span class="star">★</span>
      <span class="ico">◆</span>
      <span class="label">${esc(sch.name)}</span>
      <span class="acts">
        <button title="Set as top" data-settop="${id}">★</button>
        <button title="Rename" data-rename-sch="${id}">✎</button>
        <button title="Delete" data-del-sch="${id}">✕</button>
      </span>
    </div>`);
	}
	html.push(`</div>`);

	// Import VHDL → schematic  (replaces the old custom-component feature)
	html.push(`<div class="tree-group"><h4>IMPORT VHDL
    <button class="add" title="เปิดไฟล์ .vhd แล้ววาดเป็นวงจร" data-act="import-vhdl">↓</button></h4>`);
	html.push(`<div style="padding:6px 10px;color:var(--muted);font-size:11px;line-height:1.6">
    เปิดไฟล์ <b style="color:var(--ink-dim)">.vhd</b> → แปลงเป็น schematic อัตโนมัติ (วาดเกต + สาย)<br>
    <span style="font-size:10.5px">รองรับ combinational (and/or/not/xor…), <b>process→D-FF</b>, <b>when/else→MUX</b></span></div>`);
	html.push(`</div>`);

	// Sub-schematics (other schematics in project as hierarchy blocks)
	html.push(`<div class="tree-group"><h4>USE AS SUB-BLOCK</h4>`);
	const others = Object.keys(p.schematics).filter(id => id !== state.activeId);
	if (others.length === 0) {
		html.push(`<div style="padding:6px 10px;color:var(--muted);font-size:11px">— ไม่มี schematic อื่น —</div>`);
	} else {
		others.forEach(id => {
			const sch = p.schematics[id];
			html.push(`<div class="tree-item" draggable="true" data-pal="SCH:${id}">
        <span class="star"></span>
        <span class="ico" style="color:#5dd5ff">▣</span>
        <span class="label">${esc(sch.name)}</span>
      </div>`);
		});
	}
	html.push(`</div>`);
	html.push(`</div>`);

	root.innerHTML = html.join("");

	// wire up
	root.querySelectorAll("[data-open]").forEach(e => e.addEventListener("click", ev => {
		if (ev.target.closest(".acts")) return;
		const id = e.dataset.open;
		openSchTab(id);
	}));
	root.querySelectorAll("[data-settop]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		state.project.topId = e.dataset.settop;
		snapshot(); renderAll();
		toast("ตั้งเป็น top entity: " + state.project.schematics[state.project.topId].name, "ok");
	}));
	root.querySelectorAll("[data-rename-sch]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		const id = e.dataset.renameSch;
		const sch = state.project.schematics[id];
		const nm = prompt("เปลี่ยนชื่อ schematic:", sch.name);
		if (nm) { sch.name = uniqueSchName(nm, id); snapshot(); renderAll(); }
	}));
	root.querySelectorAll("[data-del-sch]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		const id = e.dataset.delSch;
		if (Object.keys(state.project.schematics).length === 1) { toast("ต้องเหลืออย่างน้อย 1 schematic", "warn"); return; }
		if (!confirm("ลบ schematic นี้?")) return;
		delete state.project.schematics[id];
		// remove any placed instances of this schematic used as a sub-block
		const nInst = removeInstancesOf("SCH:" + id);
		if (nInst) toast(`ลบ instance ที่ใช้ schematic นี้ไปด้วย ${nInst} ตัว`, "warn");
		state.openTabs = state.openTabs.filter(t => t !== id);
		if (state.activeId === id) {
			state.activeId = state.openTabs[0] || Object.keys(state.project.schematics)[0];
			state.selection.clear();
			state.pendingWire = null;
		}
		if (!state.openTabs.includes(state.activeId)) state.openTabs.push(state.activeId);
		if (state.project.topId === id) {
			state.project.topId = Object.keys(state.project.schematics)[0];
		}
		snapshot(); renderAll();
	}));
	root.querySelectorAll("[data-edit-custom]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		openWizard(e.dataset.editCustom);
	}));
	root.querySelectorAll("[data-export-custom]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		exportCustomComponent(e.dataset.exportCustom);
	}));
	root.querySelectorAll("[data-del-custom]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		const name = e.dataset.delCustom;
		if (!confirm(`ลบ component "${name}"?`)) return;
		delete state.project.customs[name];
		const nInst = removeInstancesOf("CUSTOM:" + name);
		if (nInst) toast(`ลบ instance ของ "${name}" ไปด้วย ${nInst} ตัว`, "warn");
		snapshot(); renderAll();
	}));
	root.querySelectorAll("[data-pal]").forEach(e => {
		e.addEventListener("dragstart", ev => {
			state.dragType = e.dataset.pal;
			// Firefox aborts drags with an empty data store
			try { ev.dataTransfer.setData("text/plain", e.dataset.pal); ev.dataTransfer.effectAllowed = "copy"; } catch (_) { }
		});
	});
}

/* =========================================================================
   PALETTE (left pane "Components")
   ========================================================================= */
function renderPalette() {
	const root = $("#palettePane");
	const groups = [
		["io", "I/O PORTS"],
		["gate", "LOGIC GATES"],
		["mux", "MUX / DEMUX"],
		["code", "ENCODER / DECODER"],
		["ff", "FLIP-FLOPS"],
		// BUS DISABLED (commented out): ["bus",  "BUS TOOLS"],
	];
	const html = [`<div class="palette">`];
	for (const [cat, name] of groups) {
		html.push(`<div class="pal-group"><h4>${name}</h4><div class="pal-grid">`);
		for (const t in TYPES) {
			if (TYPES[t].category !== cat) continue;
			const p = TYPES[t].defaultParams || {};
			const sz = TYPES[t].size(p);
			const sc = Math.min(60 / sz.w, 36 / sz.h, 1);
			html.push(`<div class="ptile" draggable="true" data-pal="${t}">
        <svg width="60" height="40" viewBox="0 0 ${sz.w} ${sz.h}" preserveAspectRatio="xMidYMid meet">
          ${TYPES[t].shape(p)}
        </svg>
        <span>${TYPES[t].label}</span>
      </div>`);
		}
		html.push(`</div></div>`);
	}
	html.push(`</div>`);
	root.innerHTML = html.join("");

	root.querySelectorAll(".ptile").forEach(e => {
		e.addEventListener("dragstart", ev => {
			state.dragType = e.dataset.pal;
			try { ev.dataTransfer.setData("text/plain", e.dataset.pal); ev.dataTransfer.effectAllowed = "copy"; } catch (_) { }
		});
		e.addEventListener("click", ev => {
			// place at the centre of the current view (not a fixed corner)
			const r = canvas.getBoundingClientRect();
			const cx = (r.width / 2 - state.view.x) / state.view.k;
			const cy = (r.height / 2 - state.view.y) / state.view.k;
			const id = addComp(e.dataset.pal, cx - 40 + Math.random() * 30, cy - 30 + Math.random() * 30);
			const nc = id && comp(id);
			if (nc && busInPin(nc)) attachBusPinToWire(nc);
		});
	});
}

/* =========================================================================
   SCH TABS
   ========================================================================= */
function openSchTab(id) {
	if (!state.project.schematics[id]) return;
	state.activeId = id;
	if (!state.openTabs.includes(id)) state.openTabs.push(id);
	state.selection.clear();
	state.pendingWire = null;
	renderAll();
}
function closeSchTab(id) {
	state.openTabs = state.openTabs.filter(t => t !== id);
	if (state.activeId === id) {
		state.activeId = state.openTabs[state.openTabs.length - 1] || Object.keys(state.project.schematics)[0];
		if (!state.openTabs.length) state.openTabs.push(state.activeId);
		state.selection.clear();
		state.pendingWire = null;
	}
	renderAll();
}
function renderSchTabs() {
	const root = $("#schTabs");
	const html = [];
	state.openTabs.forEach(id => {
		const sch = state.project.schematics[id]; if (!sch) return;
		const isTop = id === state.project.topId;
		const isA = id === state.activeId;
		html.push(`<button class="sch-tab ${isA ? "active" : ""} ${isTop ? "top" : ""}" data-tab="${id}">
      ${esc(sch.name)}
      <span class="close" data-close="${id}">✕</span>
    </button>`);
	});
	html.push(`<button class="sch-newbtn" data-act="new-sch" title="New schematic">＋</button>`);
	root.innerHTML = html.join("");
	root.querySelectorAll("[data-tab]").forEach(e => e.addEventListener("click", ev => {
		if (ev.target.dataset.close) return;
		openSchTab(e.dataset.tab);
	}));
	root.querySelectorAll("[data-close]").forEach(e => e.addEventListener("click", ev => {
		ev.stopPropagation();
		closeSchTab(e.dataset.close);
	}));
}

/* =========================================================================
   COMPONENT OPERATIONS
   ========================================================================= */
function addComp(type, x, y) {
	const sch = activeSch();
	if (!sch) return;
	let typeDef0;
	let params = {};
	if (type.startsWith("CUSTOM:")) {
		const name = type.slice(7);
		if (!state.project.customs[name]) return;
		typeDef0 = customTypeDef(state.project.customs[name]);
	} else if (type.startsWith("SCH:")) {
		if (!state.project.schematics[type.slice(4)]) return;
		typeDef0 = schTypeDef(state.project.schematics[type.slice(4)]);
	} else {
		if (!TYPES[type]) return;
		typeDef0 = TYPES[type];
		params = JSON.parse(JSON.stringify(typeDef0.defaultParams || {}));
	}
	// unique pin name for IN/OUT
	if (type === "IN") {
		let n = 0; const used = new Set(sch.components.filter(c => c.type === "IN").map(c => c.params.name));
		let nm; do { nm = "in" + (n++); } while (used.has(nm));
		params.name = nm; params.width = 1;
	}
	if (type === "OUT") {
		let n = 0; const used = new Set(sch.components.filter(c => c.type === "OUT").map(c => c.params.name));
		let nm; do { nm = "out" + (n++); } while (used.has(nm));
		params.name = nm; params.width = 1;
	}
	const id = uid("c");
	const nc = { id, type, x: snap(x), y: snap(y), params, label: "" };
	sch.components.push(nc);
	state.selection = new Set([id]);
	snapshot();
	renderAll();
	return id;
}

/* =========================================================================
   ISE-STYLE MODAL TOOLS (Add Wire / Net Name / I/O Marker)
   The active tool stays armed for repeated use; Esc returns to Select.
   ========================================================================= */
const TOOL_INFO = {
	select: {
		cur: "", msg: "โหมดเลือก/ย้าย",
		hint: "<b>เครื่องมือ ≣ (B)</b> = ลากจากพอร์ต >1 bit ของ component สร้างบัส · <b>คลิกสายบัส</b> = วาง Bus Tap · <b>ล้อ/Space+ลาก</b> เลื่อนจอ · <b>Ctrl+ล้อ</b> ซูม · <b>Del</b> ลบ · <b>F7</b> ตรวจ"
	},
	wire: {
		cur: "crosshair", msg: "Add Wire — คลิกพอร์ต→พอร์ตเพื่อต่อสาย · คลิกกลางสาย = แยกสาย",
		hint: "<b>คลิกพอร์ต</b> เริ่มสาย → <b>คลิกพื้นว่าง</b> หักมุม → <b>คลิกพอร์ต/สาย</b> จบ · <b>ดับเบิลคลิก/Enter</b> = จบสายในที่ว่าง · <b>Backspace</b> ถอยมุม · <b>Esc</b> ยกเลิก"
	},
	netname: {
		cur: "text", msg: "Add Net Name — คลิกที่สายเพื่อตั้งชื่อ",
		hint: "<b>คลิกสาย</b> ตั้งชื่อ · บัสต้องลากจากพอร์ต >1 bit ของ component (ตั้งชื่อบัสได้ แต่ความกว้างมาจากพอร์ตต้นทาง)"
	},
	bus: {
		cur: "crosshair", msg: "Add Bus — ลากจากพอร์ต >1 bit ของ component เพื่อสร้างบัส · คลิกสายบัส = ดึงบิต (Bus Tap)",
		hint: "<b>ลากจากพอร์ต >1 bit</b> ของ component = สร้างสายบัส (ตั้งความกว้างพอร์ตใน Inspector) · <b>คลิกสายบัส</b> = วาง Bus Tap ดึงบิตถัดไป · <b>Esc</b> ยกเลิก · สร้างบัสลอยจากพื้นที่ว่างไม่ได้"
	},
	iomarker: {
		cur: "crosshair", msg: "Add I/O Marker — คลิกขาที่ยังว่างเพื่อติด INPUT/OUTPUT อัตโนมัติ",
		hint: "<b>คลิกขาที่ยังว่าง</b> เพื่อติด INPUT/OUTPUT marker อัตโนมัติ (บัสได้ด้วย)"
	},
};
function setTool(t, silent) {
	if (t === "symbol") { setLeftTab("palette"); toast("ลาก component จากแผง Components ไปวางบน canvas", "info", 2200); return; }
	if (!TOOL_INFO[t]) t = "select";
	state.tool = t;
	if (state.pendingWire) { state.pendingWire = null; healJunctions(); }  // no orphan dots on tool switch
	$$("#canvasToolbar button").forEach(b => b.classList.toggle("active", b.dataset.tool === t));
	canvas.style.cursor = TOOL_INFO[t].cur;
	const ht = $("#canvasHintText"); if (ht) ht.innerHTML = TOOL_INFO[t].hint || TOOL_INFO[t].msg;
	if (!silent) toast(TOOL_INFO[t].msg, "info", 2200);
	render();
}

/* wire naming — supports ISE-style bus syntax: "data[7:0]" or "data(7:0)".
   Names the net; on a net with no source it also DEFINES the bus width by
   upgrading the net's root junction into the bus definition. */
function applyWireName(w, raw) {
	if (raw === null) return;
	const sch = activeSch();
	const m = /^\s*(.+?)\s*[\[\(]\s*(\d+)\s*:\s*(\d+)\s*[\]\)]\s*$/.exec(raw);
	if (m) {
		// ===== BUS DISABLED (commented out) — naming "name(hi:0)" no longer makes a bus;
		// just take the base name (range ignored). Re-enable by deleting the 4 lines below
		// and uncommenting the ORIGINAL block. =====
		w.name = sanId(m[1]);
		toast("ปิดฟีเจอร์บัสไว้ชั่วคราว — ตั้งชื่อสายได้ แต่ไม่สร้างบัส", "info", 2800);
		snapshot(); render(); renderInspector();
		return;
		/* ORIGINAL bus-by-naming:
		let base = sanId(m[1]); const hi = +m[2], lo = +m[3];
		if(lo !== 0){ toast("รองรับเฉพาะช่วงที่ลงท้าย :0 เช่น data(7:0)","warn",3200); renderInspector(); return; }
		if(hi < 1 || hi > 63){ toast("ความกว้างบัสต้องอยู่ระหว่าง 2–64 bit","warn"); renderInspector(); return; }
		if(netWidth(w, sch) > 1){
		  w.name = base;
		  toast("ตั้งชื่อบัส '"+base+"("+hi+":0)' แล้ว","ok",3000);
		  snapshot(); render(); renderInspector(); return;
		}
		const root = netDriverPort(sch, w);
		const rc = root && comp(root.cid, sch);
		if(rc && rc.type==="JUNCTION"){
		  const taken = new Set(sch.components
			.filter(x=>x.type==="JUNCTION" && x.id!==rc.id && x.params && x.params.busName)
			.map(x=>sanId(x.params.busName)));
		  const want = base; let k = 1;
		  while(taken.has(base)) base = want + "_" + (k++);
		  w.name = base;
		  rc.params = rc.params || {};
		  rc.params.busName  = base;
		  rc.params.busWidth = hi+1;
		} else {
		  w.name = base;
		}
		snapshot(); render(); renderInspector();
		return;
		*/
	}
	w.name = sanId(raw);
	snapshot(); render(); renderInspector();
}

/* bits already taken by Bus Taps on this wire's net (union of hi..lo ranges).
   The sweep is UNDIRECTED — a source connected INTO a free endpoint later gives
   the net wires of both orientations, and every tap must still be counted. */
function tappedBitsOnNet(w, sch) {
	sch = sch || activeSch();
	const used = new Set();
	const seenW = new Set(), seenJ = new Set(), stack = [];
	const noteTap = x => {
		const tc = comp(x.to.cid, sch);
		if (tc && tc.type === "BUSTAP" && x.to.pid === "d") {
			const hi = Math.max(tc.params.hi ?? 0, tc.params.lo ?? 0);
			const lo = Math.min(tc.params.hi ?? 0, tc.params.lo ?? 0);
			for (let b = lo; b <= hi; b++) used.add(b);
		}
	};
	const pushJ = cid => {
		const c0 = comp(cid, sch);
		if (c0 && c0.type === "JUNCTION" && !seenJ.has(c0.id)) { seenJ.add(c0.id); stack.push(c0.id); }
	};
	seenW.add(w.id); noteTap(w); pushJ(w.from.cid); pushJ(w.to.cid);
	while (stack.length) {
		const jid = stack.pop();
		sch.wires.forEach(x => {
			if (seenW.has(x.id)) return;
			if (x.from.cid === jid || x.to.cid === jid) {
				seenW.add(x.id); noteTap(x);
				pushJ(x.from.cid); pushJ(x.to.cid);
			}
		});
	}
	return used;
}
/* Add Bus Tap: click a bus wire → drop a tap flush on it (junction + triangle),
   inheriting the bus width. ISE-style auto-increment: each new tap takes the
   lowest bit not tapped yet on this net; when all bits are taken it wraps to 0
   (tapping the same bit twice is legal fan-out). */
function stampTapOnWire(w, point) {
	const sch = activeSch();
	const sw = netWidth(w, sch);
	if (sw <= 1) { toast("Bus Tap ใช้กับสายบัส (กว้าง > 1 bit) เท่านั้น", "warn"); return false; }
	const at = nearestOnWire(w, point, 0, sch);
	if (!at) return false;
	const used = tappedBitsOnNet(w, sch);
	let bit = 0; while (bit < sw && used.has(bit)) bit++;
	const full = bit >= sw;
	if (full) bit = 0;
	const j = { id: uid("c"), type: "JUNCTION", x: at.x - 6, y: at.y - 6, params: {} };
	sch.components.push(j);
	splitWireThroughJunction(w, j, sch);
	const tap = {
		id: uid("c"), type: "BUSTAP", x: 0, y: 0, label: "",
		params: { hi: bit, lo: bit, dir: at.seg === "v" ? "right" : "down" }
	};
	const dp0 = TYPES.BUSTAP.ports(tap.params).find(p => p.id === "d");
	tap.x = at.x - dp0.dx;   // seat so the d pin lands EXACTLY on the bus point (any tap size)
	tap.y = at.y - dp0.dy;
	sch.components.push(tap);
	sch.wires.push({ id: uid("w"), from: { cid: j.id, pid: "j" }, to: { cid: tap.id, pid: "d" }, name: "" });
	state.selection = new Set([tap.id]);
	snapshot(); render(); renderInspector();
	if (full) toast(`ครบทุกบิตแล้ว — วางซ้ำที่บิต [0] (ปรับช่วงได้ใน Inspector)`, "info", 3200);
	else toast(`วาง Bus Tap บิต [${bit}] แล้ว — คลิกต่อ = บิตถัดไป · ปรับช่วงใน Inspector`, "ok", 2800);
	return true;
}

/* the bus-side INPUT pin of a bus component (Bus Tap / Bus Ripper), or null */
function busInPin(c) {
	const td = typeDef(c);
	if (!td) return null;
	return td.ports(c.params || {}).find(p => p.dir === "in" && (p.bus || (p.width || 1) > 1)) || null;
}
/* AUTO-CONNECT a freshly placed bus component to a bus it was dropped on: if its
   bus-side pin lands within tol of a bus wire (netWidth>1), snap the pin onto that
   bus, split the bus with a junction, and wire the pin to it — so merely DROPPING
   the part on a bus connects it, no wire to route. A Bus Ripper with its untouched
   default slice is also seeded to a sensible half-split of the bus width. */
function attachBusPinToWire(c, tol = 44) {
	const sch = activeSch();
	let pin = busInPin(c);
	if (!pin) return false;
	// already wired to that pin? leave it alone
	if (sch.wires.some(w => (w.to.cid === c.id && w.to.pid === pin.id) || (w.from.cid === c.id && w.from.pid === pin.id))) return false;
	const dpos0 = { x: c.x + pin.dx, y: c.y + pin.dy };
	let best = null;
	for (const w of sch.wires) {
		if (netWidth(w, sch) <= 1) continue;                 // buses only
		const at = nearestOnWire(w, dpos0, 0, sch);
		if (at && (!best || at.d < best.at.d)) best = { w, at };
	}
	if (!best || best.at.d > tol) return false;
	const at = best.at;
	// orient a Bus Tap to point out the side it was dropped on, so it can ride the
	// left/right or top/bottom of the trunk; the Ripper stays horizontal.
	if (c.type === "BUSTAP") {
		const szT = getSize(c); const cenX = c.x + szT.w / 2, cenY = c.y + szT.h / 2;   // body centre (any size)
		c.params.dir = at.seg === "v" ? (cenX >= at.x ? "right" : "left")
			: (cenY >= at.y ? "down" : "up");
	}
	pin = busInPin(c);                                    // a dir change moves the pin
	const pp = { x: c.x + pin.dx, y: c.y + pin.dy };
	// seat the part so its bus pin sits EXACTLY on the tap point → the connector is
	// zero-length and it rides FLUSH on the bus, exactly like a clicked Bus Tap. If
	// instead we left it offset, that connector would carry the full bus width and
	// render as a THICK purple stub branching off the trunk (the "extra bent wire").
	// NOTE: do NOT snap() here — the bus coord (at) may sit off the 11px grid (ports
	// can), and snapping would nudge the pin off the junction, re-opening a stub.
	c.x = c.x + (at.x - pp.x);
	c.y = c.y + (at.y - pp.y);
	const j = { id: uid("c"), type: "JUNCTION", x: at.x - 6, y: at.y - 6, params: {} };
	sch.components.push(j);
	splitWireThroughJunction(best.w, j, sch);
	sch.wires.push({ id: uid("w"), from: { cid: j.id, pid: "j" }, to: { cid: c.id, pid: pin.id }, name: "" });
	snapshot(); render(); renderInspector();
	return true;
}
/* Called after a bus component is MOVED: keep it glued to the bus under its pin —
   snap ONTO a bus when dragged close, drop OFF when dragged well clear of every
   bus (the junction it sat on then heals back into the trunk). */
function syncBusAttachment(c) {
	const sch = activeSch();
	const pin = busInPin(c);
	if (!pin) return;
	const label = "Bus Tap";
	// Detach any existing bus connector first, then RE-SEAT flush at the current
	// nearest point — so moving the part SLIDES it along the bus (instead of leaving
	// its junction behind and stretching a thick stub). Moved clear → stays off.
	const links = sch.wires.filter(w => (w.to.cid === c.id && w.to.pid === pin.id) || (w.from.cid === c.id && w.from.pid === pin.id));
	const wasAttached = links.length > 0;
	if (wasAttached) { sch.wires = sch.wires.filter(w => !links.includes(w)); healJunctions(sch); }
	if (attachBusPinToWire(c)) {                             // near a bus → (re)seat flush
		if (!wasAttached) toast(`เกาะ ${label} เข้าสายบัสแล้ว`, "ok", 2000);
	} else if (wasAttached) {
		toast(`ปลด ${label} ออกจากบัสแล้ว`, "info", 2200);
	}
}

/* Add I/O Marker: click an unconnected pin → matching IN/OUT flag, wired straight */
function addIOMarkerAt(c, p) {
	const sch = activeSch();
	const used = sch.wires.some(w => (w.to.cid === c.id && w.to.pid === p.id) || (w.from.cid === c.id && w.from.pid === p.id));
	if (used) { toast("ขานี้มีสายต่ออยู่แล้ว", "warn"); return; }
	const pos = portPos(c, p.id);
	const wdt = p.width || 1;
	if (p.dir === "in") {
		let n = 0; const names = new Set(sch.components.filter(x => x.type === "IN").map(x => x.params.name));
		let nm; do { nm = "in" + (n++); } while (names.has(nm));
		const params = { name: nm, width: wdt };
		const ic = { id: uid("c"), type: "IN", x: pos.x - ioShapeW(params) - 44, y: pos.y - 22, params, label: "" };
		sch.components.push(ic);
		sch.wires.push({ id: uid("w"), from: { cid: ic.id, pid: "o" }, to: { cid: c.id, pid: p.id }, name: "", width: wdt });
	} else {
		let n = 0; const names = new Set(sch.components.filter(x => x.type === "OUT").map(x => x.params.name));
		let nm; do { nm = "out" + (n++); } while (names.has(nm));
		const params = { name: nm, width: wdt };
		const oc = { id: uid("c"), type: "OUT", x: pos.x + 44, y: pos.y - 22, params, label: "" };
		sch.components.push(oc);
		sch.wires.push({ id: uid("w"), from: { cid: c.id, pid: p.id }, to: { cid: oc.id, pid: "i" }, name: "", width: wdt });
	}
	snapshot(); render();
}

function deleteSelection() {
	const sch = activeSch();
	const ids = new Set(state.selection);
	// deleting a bus label removes the net's width definition — say so
	const lostBus = sch.components.some(c => ids.has(c.id) && c.type === "JUNCTION"
		&& c.params && c.params.busName && !sch.wires.some(w => w.to.cid === c.id));
	sch.components = sch.components.filter(c => !ids.has(c.id));
	sch.wires = sch.wires.filter(w => !ids.has(w.id) && !ids.has(w.from.cid) && !ids.has(w.to.cid));
	state.selection.clear();
	// a wire being drawn FROM a component we just deleted must die with it — else the
	// next port click dereferences the dead cid and throws, but only AFTER the
	// one-driver filter has already removed that sink's existing wire (silent loss)
	if (state.pendingWire && !comp(state.pendingWire.cid, sch)) state.pendingWire = null;
	healJunctions(sch);   // junctions clean themselves up when no longer needed
	snapshot(); renderAll();
	if (lostBus) toast("ลบป้ายชื่อบัสแล้ว — สายนี้ไม่เป็นบัสอีกต่อไป (Bus Tap ที่เหลือจะฟ้องตอนตรวจ)", "warn", 3600);
}
function duplicateSelection() {
	const sch = activeSch();
	const ids = new Set(state.selection);
	const newSel = new Set();
	const idMap = new Map();
	sch.components.filter(c => ids.has(c.id)).forEach(c => {
		const nc = JSON.parse(JSON.stringify(c));
		// +2*GRID keeps every component (and a junction's box+6 dot) ON the grid; the
		// old +24 (24%11=2) shoved every copy — and every copied dot — off-grid, the
		// classic "สายหัก" source the moment anything connects to or nudges the copy
		nc.id = uid("c"); nc.x += 2 * GRID; nc.y += 2 * GRID;
		if (nc.type === "IN" || nc.type === "OUT") {
			const used = new Set(sch.components.filter(x => x.type === nc.type).map(x => x.params.name));
			let base = nc.params.name || (nc.type === "IN" ? "in" : "out");
			let nm = base, k = 1;
			while (used.has(nm)) nm = base + "_" + (k++);
			nc.params.name = nm;
		}
		sch.components.push(nc);
		idMap.set(c.id, nc.id);
		newSel.add(nc.id);
	});
	// copy wires between selected components — deep-clone so the user's manual route
	// (pts waypoints, dragged z/s bends mx/my, zjog) survives the duplicate
	sch.wires.filter(w => ids.has(w.from.cid) && ids.has(w.to.cid)).forEach(w => {
		const nw = JSON.parse(JSON.stringify(w));
		nw.id = uid("w");
		nw.from = { cid: idMap.get(w.from.cid), pid: w.from.pid };
		nw.to = { cid: idMap.get(w.to.cid), pid: w.to.pid };
		sch.wires.push(nw);
	});
	state.selection = newSel;
	snapshot(); renderAll();
}

function copySelection() {
	const sch = activeSch();
	const ids = new Set(state.selection);
	const comps = sch.components.filter(c => ids.has(c.id))
		.map(c => JSON.parse(JSON.stringify(c)));
	if (!comps.length) { toast("ไม่มี component ที่เลือก", "warn"); return; }
	const wires = sch.wires.filter(w => ids.has(w.from.cid) && ids.has(w.to.cid))
		.map(w => JSON.parse(JSON.stringify(w)));
	state.clipboard = { components: comps, wires };
	toast(`คัดลอก ${comps.length} บล็อกแล้ว`, "ok");
}

function pasteClipboard() {
	if (!state.clipboard || !state.clipboard.components.length) {
		toast("clipboard ว่าง", "warn"); return;
	}
	const sch = activeSch();
	// origin = top-left of clipboard
	let minX = Infinity, minY = Infinity;
	state.clipboard.components.forEach(c => {
		minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
	});
	const ox = snap(state.mouse.x - 30) - minX;
	const oy = snap(state.mouse.y - 20) - minY;
	const idMap = new Map();
	const newSel = new Set();
	state.clipboard.components.forEach(c => {
		const nc = JSON.parse(JSON.stringify(c));
		nc.id = uid("c");
		// snap what the user SEES — a junction's dot sits at box+6 and 6%GRID!=0, so
		// snapping the box lands the dot off-grid (a 5px kink); match the drag handler
		const q = nc.type === "JUNCTION" ? 6 : 0;
		nc.x = snap(c.x + ox + q) - q;
		nc.y = snap(c.y + oy + q) - q;
		if (nc.type === "IN" || nc.type === "OUT") {
			const used = new Set(sch.components.filter(x => x.type === nc.type).map(x => x.params.name));
			let base = nc.params.name || (nc.type === "IN" ? "in" : "out");
			let nm = base, k = 1;
			while (used.has(nm)) nm = base + "_" + (k++);
			nc.params.name = nm;
		}
		sch.components.push(nc);
		idMap.set(c.id, nc.id);
		newSel.add(nc.id);
	});
	state.clipboard.wires.forEach(w => {
		if (!idMap.has(w.from.cid) || !idMap.has(w.to.cid)) return;
		// deep-clone to keep the user's manual route (pts/mx/my/zjog)
		const nw = JSON.parse(JSON.stringify(w));
		nw.id = uid("w");
		nw.from = { cid: idMap.get(w.from.cid), pid: w.from.pid };
		nw.to = { cid: idMap.get(w.to.cid), pid: w.to.pid };
		sch.wires.push(nw);
	});
	state.selection = newSel;
	snapshot(); render(); renderInspector();
	toast(`วาง ${state.clipboard.components.length} บล็อกแล้ว`, "ok");
}

/* =========================================================================
   WIRE OPERATIONS
   ========================================================================= */
/* map a component's 0° local port offset (dx,dy) to its ORIENTED local offset —
   mirror (horizontal flip) then rotate about the body centre, the SAME transform
   the render group applies, so ports and the symbol always agree. */
function orientLocal(c, dx, dy) {
	const sz = getSize(c), w = sz.w, h = sz.h;
	let x = dx, y = dy;
	if (c.mirror) x = w - x;                       // flip left-right about the centre
	const cx = w / 2, cy = h / 2, rx = x - cx, ry = y - cy;
	let nx, ny;
	switch (((c.rot || 0) % 360 + 360) % 360) {
		case 90: nx = -ry; ny = rx; break;        // SVG rotate() is clockwise (y-down)
		case 180: nx = -rx; ny = -ry; break;
		case 270: nx = ry; ny = -rx; break;
		default: nx = rx; ny = ry; break;
	}
	return { x: cx + nx, y: cy + ny };
}
function portPos(c, pid) {
	const p = getPort(c, pid);
	if (!p) return null;
	const o = orientLocal(c, p.dx, p.dy);
	return { x: c.x + o.x, y: c.y + o.y };
}
/* Rotate / mirror placed symbols (ISE ECS-style). Bus taps/rippers carry their
   own orientation and junctions have none, so they are skipped. */
function orientable(c) { return !!c && c.type !== "JUNCTION" && c.type !== "BUSTAP"; }
function rotateSelection(step) {       // step +1 = CW 90°, -1 = CCW 90°
	const sch = activeSch();
	const cs = [...state.selection].map(id => comp(id, sch)).filter(orientable);
	if (!cs.length) { toast("เลือก component ที่จะหมุนก่อน", "warn"); return; }
	cs.forEach(c => { c.rot = (((c.rot || 0) + step * 90) % 360 + 360) % 360; });
	snapshot(); render(); renderInspector();
}
function mirrorSelection() {
	const sch = activeSch();
	const cs = [...state.selection].map(id => comp(id, sch)).filter(orientable);
	if (!cs.length) { toast("เลือก component ที่จะพลิกก่อน", "warn"); return; }
	cs.forEach(c => { c.mirror = !c.mirror; });
	snapshot(); render(); renderInspector();
}
function onPortClick(c, p) {
	const sch = activeSch();
	// completing a branch that was started from a wire (deferred junction) →
	// place the junction optimally on the net, nearest this target
	if (state.pendingWire && state.pendingWire.onWire) {
		const wid = state.pendingWire.onWire;
		state.pendingWire = null;
		if (p.dir === "out") { toast("ต่อปลายทางเป็น output ไม่ได้ — เลือกขา input", "warn"); render(); return; }
		const w = sch.wires.find(x => x.id === wid);
		if (w) {
			const driver = netDriverPort(sch, w);
			if (driver) {
				sch.wires = sch.wires.filter(x => !(x.to.cid === c.id && x.to.pid === p.id));  // one driver
				if (!branchFromNet(sch, driver, { cid: c.id, pid: p.id })) {
					sch.wires.push({ id: uid("w"), from: driver, to: { cid: c.id, pid: p.id }, name: "" });
				}
				healLayout(sch);   // align alone would re-take columns separate just freed
			}
		}
		snapshot(); render();
		return;
	}
	if (!state.pendingWire) {
		state.pendingWire = { cid: c.id, pid: p.id, isOut: p.dir === "out", pts: [] };
		render();
		return;
	}
	const A = state.pendingWire;
	const B = { cid: c.id, pid: p.id, isOut: p.dir === "out" };
	if (A.cid === B.cid && A.pid === B.pid) { state.pendingWire = null; healJunctions(sch); render(); return; }
	const ca = comp(A.cid), cb = comp(B.cid);
	const aJunc = ca?.type === "JUNCTION";
	const bJunc = cb?.type === "JUNCTION";
	// Same direction & neither is a junction.
	if (A.isOut === B.isOut && !aJunc && !bJunc) {
		if (!A.isOut) {
			// TWO INPUT (sink) ports → tie them onto ONE shared net (real schematics
			// allow wiring inputs together to carry the same signal). If either side
			// already sits on a driven net, the other TAPS that driver so both get it.
			const wA = sch.wires.find(w => w.to.cid === A.cid && w.to.pid === A.pid);
			const wB = sch.wires.find(w => w.to.cid === B.cid && w.to.pid === B.pid);
			const drv = (wA && netDriverPort(sch, wA)) || (wB && netDriverPort(sch, wB)) || null;
			if (drv) {
				const target = wA ? B : A;                 // attach the not-yet-driven side
				sch.wires = sch.wires.filter(w => !(w.to.cid === target.cid && w.to.pid === target.pid)); // one driver
				if (!branchFromNet(sch, drv, { cid: target.cid, pid: target.pid })) {
					sch.wires.push({ id: uid("w"), from: drv, to: { cid: target.cid, pid: target.pid }, name: "" });
				}
				toast("เชื่อมขา input เข้าเน็ตเดียวกันแล้ว — ใช้สัญญาณร่วมกัน", "ok", 2600);
			} else {
				// neither is driven yet → tie both to a shared NET NODE (a junction), so
				// driving any tied input later (tie-through, below) feeds them all
				const pa = portPos(comp(A.cid, sch), A.pid), pb = portPos(comp(B.cid, sch), B.pid);
				const j = { id: uid("c"), type: "JUNCTION", x: snap((pa.x + pb.x) / 2) - 6, y: snap((pa.y + pb.y) / 2) - 6, params: {} };
				sch.components.push(j);
				sch.wires.push({ id: uid("w"), from: { cid: j.id, pid: "j" }, to: { cid: A.cid, pid: A.pid }, name: "" });
				sch.wires.push({ id: uid("w"), from: { cid: j.id, pid: "j" }, to: { cid: B.cid, pid: B.pid }, name: "" });
				toast("เชื่อมขา input สองขาแล้ว — ต่อ source เข้าขาใดก็ป้อนทั้งคู่", "info", 3000);
			}
			state.pendingWire = null;
			healJunctions(sch); healLayout(sch);
			snapshot(); render();
			return;
		}
		// two OUTPUT / driver ports → can't wire two drivers together; restart from B
		state.pendingWire = B; render(); return;
	}
	// Determine direction. If both are "out" but one is a junction, the
	// junction accepts the wire as an input (it is transparent). Same for
	// both "in".
	let fromPort, toPort;
	if (A.isOut && !B.isOut) { fromPort = A; toPort = B; }
	else if (!A.isOut && B.isOut) { fromPort = B; toPort = A; }
	else if (A.isOut && B.isOut) { fromPort = aJunc ? B : A; toPort = aJunc ? A : B; }
	else { fromPort = aJunc ? A : B; toPort = aJunc ? B : A; }
	// Tie-through: if the sink is already hung off an UNDRIVEN junction (a shared
	// net made by tying inputs together), retarget the driver to that junction so
	// it feeds EVERY tied sink — instead of stealing this one port off the net.
	if (comp(toPort.cid) && comp(toPort.cid).type !== "JUNCTION") {
		const feed = sch.wires.find(w => w.to.cid === toPort.cid && w.to.pid === toPort.pid);
		const fj = feed && comp(feed.from.cid, sch);
		if (fj && fj.type === "JUNCTION" && !sch.wires.some(w => w.to.cid === fj.id)) {
			toPort = { cid: fj.id, pid: "j" };
		}
	}
	// For non-junction targets, ensure only one driver
	if (comp(toPort.cid).type !== "JUNCTION") {
		sch.wires = sch.wires.filter(w => !(w.to.cid === toPort.cid && w.to.pid === toPort.pid));
	}
	const fc = comp(fromPort.cid); const tc = comp(toPort.cid);
	const fp = getPort(fc, fromPort.pid); const tp = getPort(tc, toPort.pid);
	const fw = fp.width || 1, tw = tp.width || 1;
	// a BUS TAP's d pin takes any bus width; junctions are width-transparent
	if (fw !== tw && fc.type !== "JUNCTION" && tc.type !== "JUNCTION" && tc.type !== "BUSTAP") {
		toast(`Width mismatch: ${fw} → ${tw}`, "warn");
	}
	// waypoints drawn by the user → honour the exact route (ordered from source
	// to sink); otherwise auto-route (and fan out through a junction if needed)
	const drawnFromSource = A.cid === fromPort.cid && A.pid === fromPort.pid;
	const pts = (A.pts && A.pts.length)
		? (drawnFromSource ? A.pts.slice() : A.pts.slice().reverse())
		: null;
	if (pts) {
		sch.wires.push({
			id: uid("w"),
			from: { cid: fromPort.cid, pid: fromPort.pid },
			to: { cid: toPort.cid, pid: toPort.pid },
			name: "", pts
		});
	} else if (!branchFromNet(sch, fromPort, toPort)) {
		sch.wires.push({
			id: uid("w"),
			from: { cid: fromPort.cid, pid: fromPort.pid },
			to: { cid: toPort.cid, pid: toPort.pid },
			name: ""
		});
	}
	state.pendingWire = null;
	healLayout(sch);   // full pass — align alone fights separateWireOverlaps (ping-pong)
	snapshot(); render();
}
/* the running "cursor" of the wire being drawn = last committed corner, or the
   start port if none yet */
function pendingLastPoint(sch) {
	const pw = state.pendingWire;
	if (!pw) return null;
	if (pw.pts && pw.pts.length) return pw.pts[pw.pts.length - 1];
	if (pw.onWire) { return pw.anchor; }
	const c = comp(pw.cid, sch); return c ? portPos(c, pw.pid) : null;
}
/* add an orthogonal corner at the cursor while drawing a wire */
function addWireCorner() {
	const pw = state.pendingWire;
	if (!pw || !pw.pts) return;
	const last = pendingLastPoint(activeSch());
	if (!last) return;
	const pt = orthoStep(last, state.mouse);
	if (pt.x !== last.x || pt.y !== last.y) { pw.pts.push(pt); render(); }
}
/* finish the wire being drawn in OPEN SPACE — leaves a free endpoint (an
   "endpoint" junction) so a bus stub can be routed first and tapped later */
function finishWireInSpace() {
	const pw = state.pendingWire;
	if (!pw || !pw.pts) { return; }
	const sch = activeSch();
	const src = comp(pw.cid, sch);
	if (!src) { state.pendingWire = null; render(); return; }
	const srcPos = portPos(src, pw.pid);
	// endpoint = the last committed corner, else one orthogonal step from source
	let endPt, pts;
	if (pw.pts.length) { endPt = pw.pts[pw.pts.length - 1]; pts = pw.pts.slice(0, -1); }
	else { endPt = orthoStep(srcPos, state.mouse); pts = []; }
	if (endPt.x === srcPos.x && endPt.y === srcPos.y) {
		state.pendingWire = null; healJunctions(sch); render(); return;   // drop a 0-wire orphan (e.g. bus node)
	}
	const j = { id: uid("c"), type: "JUNCTION", x: endPt.x - 6, y: endPt.y - 6, params: { endpoint: true } };
	sch.components.push(j);
	const ordered = pw.isOut ? pts : pts.slice().reverse();
	const nw = { id: uid("w"), name: "", pts: ordered };
	if (pw.isOut) { nw.from = { cid: pw.cid, pid: pw.pid }; nw.to = { cid: j.id, pid: "j" }; }
	else { nw.from = { cid: j.id, pid: "j" }; nw.to = { cid: pw.cid, pid: pw.pid }; }
	sch.wires.push(nw);
	state.pendingWire = null;
	// if the end landed on an existing wire, weld a real junction there
	const welded = weldTouchingEnds(sch);
	if (welded) healJunctions(sch);   // tidy any pass-throughs the weld produced
	snapshot(); render();
	toast(welded
		? "ต่อสายเข้ากับสายเดิมแล้ว — จุดต่อขึ้นสี่เหลี่ยมทึบ"
		: (netWidth(nw, sch) > 1
			? "จบสายบัสในที่ว่างแล้ว — ใช้เครื่องมือ ≣ หรือคลิกขวาที่สายเพื่อดึงบิต"
			: "จบสายในที่ว่างแล้ว — คลิกปลายสายด้วยเครื่องมือ ╱ เพื่อต่อทีหลัง"), "ok", 3200);
}

/* =========================================================================
   WIRE ROUTING  (Manhattan / 90-degree)
   A wire may carry a user-adjusted bend position:
	 w.mx — x of the vertical middle segment (staircase route)
	 w.my — y of the middle horizontal segment (S / wrap-around route)
   Both persist in the project file; when absent the route defaults to the
   midpoint and render() shifts it automatically to avoid overlapping runs.
   ========================================================================= */
const WIRE_MINLEG = 22;   // = 2*GRID, so every jog leg lands on a grid column (ISE-like)
/* project `to` onto a horizontal or vertical step from `from` (grid-snapped) */
function orthoStep(from, to) {
	const dx = to.x - from.x, dy = to.y - from.y;
	return Math.abs(dx) >= Math.abs(dy) ? { x: snap(to.x), y: from.y } : { x: from.x, y: snap(to.y) };
}
/* force a point list into an orthogonal polyline, inserting elbows where two
   consecutive points differ on both axes. fromH/toH pick the elbow orientation
   at the two port ends so wires leave/enter along the port's natural side. */
function orthoPolyline(points, fromH = true, toH = true) {
	const out = [points[0]];
	for (let i = 1; i < points.length; i++) {
		const a = out[out.length - 1], b = points[i];
		if (Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5) {
			const horizFirst = i === 1 ? fromH : i === points.length - 1 ? !toH : true;
			out.push(horizFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
		}
		if (Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5) out.push({ x: b.x, y: b.y });
	}
	// tidy: drop straight-through midpoints and collapse A→B→A backtracks
	let changed = true;
	while (changed && out.length > 2) {
		changed = false;
		for (let i = 1; i < out.length - 1; i++) {
			const a = out[i - 1], b = out[i], c = out[i + 1];
			if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) { out.splice(i, 1); changed = true; break; }
			if (a.x === c.x && a.y === c.y) { out.splice(i, 2); changed = true; break; }
		}
	}
	return out;
}
/* is a port on the left/right edge (horizontal entry) vs top/bottom (vertical)? */
function portSideH(c, pid) {
	const p = getPort(c, pid); if (!p) return true;
	const sz = getSize(c);
	const origH = p.dx <= 1 || p.dx >= sz.w - 1;    // left/right edge → horizontal at 0°
	const r = ((c.rot || 0) % 360 + 360) % 360;           // 90/270 swap H<->V; mirror keeps it
	return (r === 90 || r === 270) ? !origH : origH;
}
/* a junction has no fixed side — a wire attached to it should leave/enter
   PERPENDICULAR to the host wire passing through (horizontal host → the branch
   exits vertically out of the top/bottom of the square, and vice-versa).
   Returns true if the attached wire should be horizontal at the junction. */
function junctionExitH(j, self, sch) {
	const jp = portPos(j, "j");
	let horiz = false, vert = false;
	sch.wires.forEach(w => {
		if (w === self || (w.from.cid !== j.id && w.to.cid !== j.id)) return;
		const oc = comp(w.from.cid === j.id ? w.to.cid : w.from.cid, sch);
		const op = oc && portPos(oc, w.from.cid === j.id ? w.to.pid : w.from.pid);
		if (!op) return;
		if (Math.abs(op.y - jp.y) < 0.5) horiz = true;   // a host runs horizontally
		if (Math.abs(op.x - jp.x) < 0.5) vert = true;   // a host runs vertically
	});
	// exit perpendicular: horizontal host → false (exit vertical); vertical → true
	if (horiz && !vert) return false;
	if (vert && !horiz) return true;
	return false;   // ambiguous → exit vertical (down/up out of the square)
}
/* a Bus Tap / Ripper bus-side pin ("d") accepts the bus from ANY direction, like a
   junction — the wire approaches along whichever axis it mostly runs, so the thick
   bus never has to bend perpendicular INTO the tap (the classic "เส้นหัก"). */
function portExitH(c, pid, w, sch) {
	if (c.type === "JUNCTION") return junctionExitH(c, w, sch);
	if (c.type === "BUSTAP" && pid === "d") {
		const oCid = w.from.cid === c.id ? w.to.cid : w.from.cid;
		const oPid = w.from.cid === c.id ? w.to.pid : w.from.pid;
		const op = portPos(comp(oCid, sch), oPid), dp = portPos(c, "d");
		if (op && dp) return Math.abs(op.x - dp.x) >= Math.abs(op.y - dp.y);   // run along the wire
	}
	return portSideH(c, pid);
}
/* the fromH/toH routing hints for a wire, from its two ports' sides */
function wireOpts(w, sch) {
	sch = sch || activeSch();
	const a = comp(w.from.cid, sch), b = comp(w.to.cid, sch);
	const fromH = a ? portExitH(a, w.from.pid, w, sch) : true;
	const toH = b ? portExitH(b, w.to.pid, w, sch) : true;
	// a bus tap/ripper bus-pin as the DESTINATION may force a straight perpendicular
	// entry so the thick bus never bends INTO it. Kept localized to tap "d" pins so
	// junction routing (which has always ignored toH) is completely unaffected.
	const endTapV = !!(b && b.type === "BUSTAP" && w.to.pid === "d" && toH === false);
	return { fromH, toH, endTapV };
}
function wireRoute(w, p1, p2, opts) {
	const x1 = Math.round(p1.x), y1 = Math.round(p1.y);
	const x2 = Math.round(p2.x), y2 = Math.round(p2.y);
	// explicit user route (waypoints) — draw straight through the corners, any
	// direction; only auto-elbow the connections to the two ports
	if (w && w.pts && w.pts.length) {
		const raw = [{ x: x1, y: y1 }, ...w.pts.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })), { x: x2, y: y2 }];
		const pts = orthoPolyline(raw, opts ? opts.fromH !== false : true, opts ? opts.toH !== false : true);
		return { kind: "poly", x1, y1, x2, y2, pts, d: "M" + pts.map(p => `${p.x},${p.y}`).join("L") };
	}
	if (Math.abs(y2 - y1) < 0.5) return { kind: "h", x1, y1, x2, y2, d: `M${x1},${y1}H${x2}` };
	if (Math.abs(x2 - x1) < 0.5) return { kind: "v", x1, y1, x2, y2, d: `M${x1},${y1}V${y2}` };
	// destination is a bus tap wanting a straight VERTICAL entry → exit the source
	// horizontally, cross, then drop straight into the tap (no perpendicular bend on
	// the thick bus). Only when the source itself isn't vertical-exiting.
	if (opts && opts.endTapV && opts.fromH !== false) {
		return { kind: "lh", x1, y1, x2, y2, d: `M${x1},${y1}H${x2}V${y2}` };
	}
	// source wants a vertical exit (e.g. a branch leaving the bottom/top of a
	// junction on a horizontal wire) → L that goes straight out then across.
	// EXCEPT the degenerate case: a mostly-horizontal FORWARD branch whose row change
	// is under one leg (e.g. 1 grid) — an L would pin the kink right AT the junction
	// square (renders as a fat "broken wire" blob). Fall through so the jog lands
	// mid-span (z) or at the sink (lh) instead.
	if (opts && opts.fromH === false) {
		// "degenerate" = a tiny row change pinned as a stub right at the junction, better
		// jogged MID-SPAN. But mid-span means the z below, which needs 2*WIRE_MINLEG of
		// run — so only defer when that z actually exists. Without this width test a
		// short branch falls through to "lh" (horizontal-first), which is strictly worse:
		// it pins the kink at the SINK, and when a dot feeds two pins on one symbol BOTH
		// branches then share the run and split against the symbol, leaving the dot
		// stranded on a bare stub with a bare T at the gate.
		const degen = Math.abs(y2 - y1) < WIRE_MINLEG && (x2 - x1) >= 2 * WIRE_MINLEG;
		// w.zjog (set by separateWireOverlaps): this L's horizontal tail lay along
		// another net's run on the destination-pin row — take the z shape instead
		// (head rides its own trunk row, tail drops in past the conflict).
		if (!degen && !(w && w.zjog)) return { kind: "l", x1, y1, x2, y2, d: `M${x1},${y1}V${y2}H${x2}` };
	}
	if (x2 - x1 >= 2 * WIRE_MINLEG) {
		// Staircase through an adjustable vertical leg. Default: a column CENTRED on the
		// span (ISE-like, stable while dragging), fanned over <=5 nearby columns by the
		// source row so stacked parallel wires don't share a leg — and never hugging
		// either end, so the jog can't sit against a pin/junction square. A user drag
		// (w.mx) always wins; real collisions are resolved by separateWireOverlaps.
		let mx;
		if (w && typeof w.mx === "number") { mx = w.mx; }
		else {
			const loX = x1 + WIRE_MINLEG, hiX = x2 - WIRE_MINLEG;
			const cols = Math.max(1, Math.floor((hiX - loX) / GRID) + 1);
			const row = Math.round(y1 / GRID);
			const fan = Math.max(1, Math.min(5, cols - 2));
			const off = (((row % fan) + fan) % fan) - (fan >> 1);
			const mid = loX + Math.round((hiX - loX) / (2 * GRID)) * GRID;
			mx = mid + off * GRID;
		}
		mx = snap(clamp(mx, x1 + WIRE_MINLEG, x2 - WIRE_MINLEG));
		return { kind: "z", x1, y1, x2, y2, mx, d: `M${x1},${y1}H${mx}V${y2}H${x2}` };
	}
	// source exits HORIZONTAL here (the fromH===false L already returned above). When
	// the target is AHEAD (or level), leave the port horizontally then drop STRAIGHT
	// down/up into it — a clean H-then-V L. This is what makes a bus land square on a
	// tap/pin instead of running down off-axis and jogging sideways into it.
	if (x2 >= x1) {
		return { kind: "lh", x1, y1, x2, y2, d: `M${x1},${y1}H${x2}V${y2}` };
	}
	// target is BEHIND (to the left) but the run is mostly vertical → a V-then-H L
	// still reads cleanly without doubling back.
	if (Math.abs(y2 - y1) > Math.abs(x2 - x1)) {
		return { kind: "l", x1, y1, x2, y2, d: `M${x1},${y1}V${y2}H${x2}` };
	}
	// wrap-around: source is to the right of target → S-route, middle leg adjustable
	const my = snap((w && typeof w.my === "number") ? w.my : (y1 + y2) / 2);
	return { kind: "s", x1, y1, x2, y2, my, d: `M${x1},${y1}H${x1 + WIRE_MINLEG}V${my}H${x2 - WIRE_MINLEG}V${y2}H${x2}` };
}
function wirePath(p1, p2) { return wireRoute(null, p1, p2).d; }

/* Break a route into ordered orthogonal parts (as the pen walks it) so we can
   insert crossing "hops" on horizontal runs. */
function routeParts(r) {
	if (r.kind === "poly") {
		const segs = [];
		for (let i = 1; i < r.pts.length; i++) {
			const a = r.pts[i - 1], b = r.pts[i];
			if (Math.abs(a.y - b.y) < 0.5) segs.push({ t: "h", x1: a.x, x2: b.x, y: a.y });
			else segs.push({ t: "v", x: a.x, y1: a.y, y2: b.y });
		}
		return segs;
	}
	if (r.kind === "h") return [{ t: "h", x1: r.x1, x2: r.x2, y: r.y1 }];
	if (r.kind === "v") return [{ t: "v", x: r.x1, y1: r.y1, y2: r.y2 }];
	if (r.kind === "l") return [
		{ t: "v", x: r.x1, y1: r.y1, y2: r.y2 },
		{ t: "h", x1: r.x1, x2: r.x2, y: r.y2 },
	];
	if (r.kind === "lh") return [
		{ t: "h", x1: r.x1, x2: r.x2, y: r.y1 },
		{ t: "v", x: r.x2, y1: r.y1, y2: r.y2 },
	];
	if (r.kind === "z") return [
		{ t: "h", x1: r.x1, x2: r.mx, y: r.y1 },
		{ t: "v", x: r.mx, y1: r.y1, y2: r.y2 },
		{ t: "h", x1: r.mx, x2: r.x2, y: r.y2 },
	];
	const L = WIRE_MINLEG;   // s-route
	return [
		{ t: "h", x1: r.x1, x2: r.x1 + L, y: r.y1 },
		{ t: "v", x: r.x1 + L, y1: r.y1, y2: r.my },
		{ t: "h", x1: r.x1 + L, x2: r.x2 - L, y: r.my },
		{ t: "v", x: r.x2 - L, y1: r.my, y2: r.y2 },
		{ t: "h", x1: r.x2 - L, x2: r.x2, y: r.y2 },
	];
}
/* Build an SVG path for a route, drawing a small semicircular hop wherever a
   horizontal run crosses another wire's vertical run — so crossings that are
   NOT electrical connections read clearly instead of looking joined. */
function hoppedPathD(r, allV, wid) {
	const HR = 5;
	const parts = routeParts(r);
	if (!parts.length) return r.d;   // degenerate (single-point) route
	const p0 = parts[0];
	let d = `M${p0.t === "h" ? p0.x1 : p0.x},${p0.t === "h" ? p0.y : p0.y1}`;
	for (const part of parts) {
		if (part.t === "v") { d += `V${part.y2}`; continue; }
		const dir = part.x2 >= part.x1 ? 1 : -1;
		const y = part.y, hlo = Math.min(part.x1, part.x2), hhi = Math.max(part.x1, part.x2);
		const xs = [];
		for (const v of allV) {
			if (v.wid === wid) continue;
			const vlo = Math.min(v.y1, v.y2), vhi = Math.max(v.y1, v.y2);
			if (v.x > hlo + HR && v.x < hhi - HR && y > vlo + 2 && y < vhi - 2) xs.push(v.x);
		}
		// de-dupe near-coincident crossings, order along travel direction
		xs.sort((a, b) => a - b);
		const uniq = xs.filter((x, i) => i === 0 || x - xs[i - 1] > 2 * HR);
		if (dir < 0) uniq.reverse();
		for (const hx of uniq) {
			d += `H${hx - dir * HR}A${HR},${HR} 0 0 ${dir > 0 ? 1 : 0} ${hx + dir * HR},${y}`;
		}
		d += `H${part.x2}`;
	}
	return d;
}

/* Junction helpers — wire-to-wire connections via a transparent dot */
/* nearest point ON a wire's rendered route: the cross-axis coordinate stays
   exactly on the wire (no kink), only the along-axis coordinate grid-snaps */
function nearestOnWire(w, pt, margin = 0, sch = activeSch()) {
	const a = comp(w.from.cid, sch), b = comp(w.to.cid, sch);
	if (!a || !b) return null;
	const p1 = portPos(a, w.from.pid), p2 = portPos(b, w.to.pid);
	if (!p1 || !p2) return null;
	let best = null;
	routeParts(wireRoute(w, p1, p2, wireOpts(w, sch))).forEach(part => {
		let px, py, lo, hi;
		if (part.t === "h") { lo = Math.min(part.x1, part.x2) + margin; hi = Math.max(part.x1, part.x2) - margin; }
		else { lo = Math.min(part.y1, part.y2) + margin; hi = Math.max(part.y1, part.y2) - margin; }
		if (hi < lo) return;   // segment too short for the requested margin
		if (part.t === "h") { px = clamp(pt.x, lo, hi); py = part.y; }
		else { px = part.x; py = clamp(pt.y, lo, hi); }
		const d = Math.hypot(pt.x - px, pt.y - py);
		if (!best || d < best.d) best = { d, seg: part.t, px, py, lo, hi };
	});
	if (!best) return null;
	// lo/hi = how far the tap may still slide ALONG this segment; callers that must
	// keep a dot clear of a symbol need the span, not just the ideal point
	if (best.seg === "h") return { seg: "h", d: best.d, x: clamp(snap(best.px), best.lo, best.hi), y: best.py, lo: best.lo, hi: best.hi };
	return { seg: "v", d: best.d, x: best.px, y: clamp(snap(best.py), best.lo, best.hi), lo: best.lo, hi: best.hi };
}
/* A connection dot must be GRABBABLE. "Nearest point on the net" alone parks it
   against the symbol edge — 1 grid off the input pin — where the pin's own hit
   circle eats the mousedown and the dot can't be picked up. ISE never seats a dot
   on a symbol; it taps the trunk a clear leg away and runs the branch in.
   GRAB_CLEAR: the dot's hit square is 18px (±9) and a port's is r=9, so 22px of
   body clearance both separates the two hit shapes and leaves a visible leg. */
const GRAB_CLEAR = WIRE_MINLEG;
function bodyClearance(pt, sch) {
	let d = Infinity;
	for (const c of sch.components) {
		if (c.type === "JUNCTION") continue;            // dots may meet dots; only symbols push back
		const td = typeDef(c); if (!td || !td.size) continue;
		const s = td.size(c.params || {});
		const dx = Math.max(c.x - pt.x, 0, pt.x - (c.x + s.w));
		const dy = Math.max(c.y - pt.y, 0, pt.y - (c.y + s.h));
		d = Math.min(d, Math.hypot(dx, dy));
	}
	return d;
}
/* slide a tap along its own segment to the closest grid spot that clears every
   symbol; null = this segment has nowhere legal, so the caller must not tap here */
function tapClearOfBodies(at, sch) {
	if (!at) return null;
	const horiz = at.seg === "h";
	const v0 = horiz ? at.x : at.y;
	const put = v => horiz ? { x: v, y: at.y } : { x: at.x, y: v };
	const cands = [];
	for (let v = Math.ceil(at.lo / GRID) * GRID; v <= at.hi; v += GRID) cands.push(v);
	cands.sort((a, b) => Math.abs(a - v0) - Math.abs(b - v0));   // nearest-to-ideal first
	for (const v of cands) {
		const p = put(v);
		if (bodyClearance(p, sch) >= GRAB_CLEAR)
			return { seg: at.seg, d: at.d + Math.abs(v - v0), x: p.x, y: p.y, lo: at.lo, hi: at.hi };
	}
	return null;
}
/* Closest take-off on wire w to pt that still clears every symbol. nearestOnWire
   commits to the single nearest SEGMENT — which is usually the leg hugging the very
   symbol we need clearance from, so sliding along it finds nothing and we'd give up
   and seat the dot on the pin anyway. Search every segment instead: the leg before
   the last turn nearly always has room. */
function nearestClearOnWire(w, pt, sch) {
	const a = comp(w.from.cid, sch), b = comp(w.to.cid, sch);
	if (!a || !b) return null;
	const p1 = portPos(a, w.from.pid), p2 = portPos(b, w.to.pid);
	if (!p1 || !p2) return null;
	let best = null;
	routeParts(wireRoute(w, p1, p2, wireOpts(w, sch))).forEach(part => {
		const horiz = part.t === "h";
		const lo = (horiz ? Math.min(part.x1, part.x2) : Math.min(part.y1, part.y2)) + GRID;
		const hi = (horiz ? Math.max(part.x1, part.x2) : Math.max(part.y1, part.y2)) - GRID;
		if (hi < lo) return;                       // leg too short to tap
		const at = tapClearOfBodies({
			seg: part.t, d: 0, lo, hi,
			x: horiz ? clamp(snap(pt.x), lo, hi) : part.x,
			y: horiz ? part.y : clamp(snap(pt.y), lo, hi)
		}, sch);
		if (!at) return;
		const d = Math.hypot(pt.x - at.x, pt.y - at.y);
		if (!best || d < best.d) best = { seg: at.seg, d, x: at.x, y: at.y, lo, hi };
	});
	return best;
}
function createJunctionOnWire(w, point) {
	const sch = activeSch();
	const at = nearestOnWire(w, point) || { x: snap(point.x), y: snap(point.y), seg: "h" };
	const j = { id: uid("c"), type: "JUNCTION", x: at.x - 6, y: at.y - 6, params: {} };
	sch.components.push(j);
	return { j, seg: at.seg };
}
function splitWireThroughJunction(w, j, sch = activeSch()) {
	const idx = sch.wires.indexOf(w);
	if (idx < 0) return;
	sch.wires.splice(idx, 1);
	// the net name stays on the FIRST half only — one label per net, not one
	// per segment (healJunctions' merge restores it via a.name||b.name)
	sch.wires.push({
		id: uid("w"),
		from: w.from,
		to: { cid: j.id, pid: "j" },
		name: w.name, width: w.width
	});
	sch.wires.push({
		id: uid("w"),
		from: { cid: j.id, pid: "j" },
		to: w.to,
		name: "", width: w.width
	});
}
/* all wires belonging to the net driven by (cid,pid), following junctions */
function netWiresFrom(sch, cid, pid) {
	const res = [];
	const stack = [[cid, pid]];
	const seen = new Set();
	while (stack.length) {
		const [c0, p0] = stack.pop();
		const key = c0 + "." + p0;
		if (seen.has(key)) continue;
		seen.add(key);
		sch.wires.forEach(w => {
			if (w.from.cid === c0 && w.from.pid === p0) {
				res.push(w);
				const tc = comp(w.to.cid, sch);
				if (tc && tc.type === "JUNCTION") stack.push([tc.id, "j"]);
			}
		});
	}
	return res;
}
/* Slide a junction along its (collinear) host wires so a single branch leaves
   it PERPENDICULAR — i.e. straight out of the top/bottom of the square for a
   junction on a horizontal wire, or the side for a vertical one. Keeps the dot
   on the host line; only runs when the junction is a clean 2-host + branches
   point (never disturbs a deliberate corner). */
function alignJunctionBranch(sch) {
	sch = sch || activeSch();
	sch.components.filter(c => c.type === "JUNCTION").forEach(j => {
		if (state.pendingWire && state.pendingWire.cid === j.id) return;
		if (j.params && j.params.fixed) return;        // user parked this dot — hands off
		const jp = portPos(j, "j");
		const legs = sch.wires
			.filter(w => w.from.cid === j.id || w.to.cid === j.id)
			.map(w => {
				const isFrom = w.from.cid === j.id;
				const oc = comp(isFrom ? w.to.cid : w.from.cid, sch);
				const op = oc && portPos(oc, isFrom ? w.to.pid : w.from.pid);
				return op ? { op } : null;
			}).filter(Boolean);
		if (legs.length < 3) return;
		const host = {
			h: legs.filter(l => Math.abs(l.op.y - jp.y) < 0.5),
			v: legs.filter(l => Math.abs(l.op.x - jp.x) < 0.5)
		};
		// horizontal host (≥2 collinear on x-axis) with exactly one off-axis branch
		if (host.h.length >= 2 && legs.length - host.h.length === 1) {
			const branch = legs.find(l => Math.abs(l.op.y - jp.y) >= 0.5);
			const xs = host.h.map(l => l.op.x);
			// move ONLY when the branch column really falls inside the host span —
			// clamping an outside column would teleport the dot onto/past a sink pin
			// (zero-length wire + square-on-port blob)
			// the branch column is the IDEAL, but it is usually a SINK PIN's column — so
			// slide to the nearest slot on the host that still clears every symbol
			const lo = Math.min(...xs) + GRID, hi = Math.max(...xs) - GRID;
			const nx = snap(branch.op.x);
			if (!Number.isFinite(nx) || nx < lo || nx > hi) return;
			const at = tapClearOfBodies({ seg: "h", d: 0, x: nx, y: jp.y, lo, hi }, sch);
			if (at) j.x = at.x - 6;
		} else if (host.v.length >= 2 && legs.length - host.v.length === 1) {
			const branch = legs.find(l => Math.abs(l.op.x - jp.x) >= 0.5);
			const ys = host.v.map(l => l.op.y);
			const lo = Math.min(...ys) + GRID, hi = Math.max(...ys) - GRID;
			const ny = snap(branch.op.y);
			if (!Number.isFinite(ny) || ny < lo || ny > hi) return;
			const at = tapClearOfBodies({ seg: "v", d: 0, x: jp.x, y: ny, lo, hi }, sch);
			if (at) j.y = at.y - 6;
		}
	});
}
/* The first routed segment LEAVING junction j along wire w: which way it exits
   (up/down/left/right) and where it first turns. Used to detect fan-out wires
   that leave the square in the SAME direction and overlap. */
function firstSegFromJunction(j, w, sch) {
	const a = comp(w.from.cid, sch), b = comp(w.to.cid, sch);
	if (!a || !b) return null;
	const p1 = portPos(a, w.from.pid), p2 = portPos(b, w.to.pid);
	if (!p1 || !p2) return null;
	const jp = portPos(j, "j");
	const parts = routeParts(wireRoute(w, p1, p2, wireOpts(w, sch)));
	for (const part of parts) {
		if (part.t === "v" && Math.abs(part.x - jp.x) < 1) {
			if (Math.abs(part.y1 - jp.y) < 1) { return { dir: part.y2 < jp.y ? "up" : "down", axis: "y", turn: part.y2 }; }
			if (Math.abs(part.y2 - jp.y) < 1) { return { dir: part.y1 < jp.y ? "up" : "down", axis: "y", turn: part.y1 }; }
		} else if (part.t === "h" && Math.abs(part.y - jp.y) < 1) {
			if (Math.abs(part.x1 - jp.x) < 1) { return { dir: part.x2 < jp.x ? "left" : "right", axis: "x", turn: part.x2 }; }
			if (Math.abs(part.x2 - jp.x) < 1) { return { dir: part.x1 < jp.x ? "left" : "right", axis: "x", turn: part.x1 }; }
		}
	}
	return null;
}
/* Keep a fan-out junction's square at the point where its wires actually DIVERGE.
   With no collinear host the router sends every branch out the SAME side (e.g.
   straight up), so 2+ wires overlap along a shared segment and the visible split
   happens far from the square. Slide the junction to the nearest turn of an
   overlapping group until no two wires leave it the same way. */
function reflowJunctions(sch) {
	sch = sch || activeSch();
	let guard = 0, moved = true;
	while (moved && guard++ < 40) {
		moved = false;
		for (const j of sch.components.filter(c => c.type === "JUNCTION")) {
			if (state.pendingWire && state.pendingWire.cid === j.id) continue;
			if (j.params && j.params.fixed) continue;       // user parked this dot — hands off
			const wires = sch.wires.filter(w => w.from.cid === j.id || w.to.cid === j.id);
			if (wires.length < 3) continue;                 // only genuine fan-out points
			const jp = portPos(j, "j");
			const segs = wires.map(w => firstSegFromJunction(j, w, sch)).filter(Boolean);
			const byDir = {};
			segs.forEach(s => { (byDir[s.dir] = byDir[s.dir] || []).push(s); });
			// a dot sitting ON a straight host line must stay ON it: pulling it off the
			// line kinks BOTH host wires at the square (the "broken wire" fat-blob)
			const ends = wires.map(w => {
				const oc = comp(w.from.cid === j.id ? w.to.cid : w.from.cid, sch);
				return oc && portPos(oc, w.from.cid === j.id ? w.to.pid : w.from.pid);
			}).filter(Boolean);
			const hostH = ends.filter(op => Math.abs(op.y - jp.y) < 0.5).length;
			const hostV = ends.filter(op => Math.abs(op.x - jp.x) < 0.5).length;
			let best = null;
			Object.keys(byDir).forEach(dir => {
				const g = byDir[dir];
				if (g.length < 2) return;                     // no overlap on this side
				if (g[0].axis === "y" && hostH >= 2) return;      // would leave a horizontal host line
				if (g[0].axis === "x" && hostV >= 2) return;      // would leave a vertical host line
				const cur = g[0].axis === "y" ? jp.y : jp.x;
				// nearest turn = where the first of the overlapping wires diverges
				let near = g[0].turn;
				g.forEach(s => { if (Math.abs(s.turn - cur) < Math.abs(near - cur)) near = s.turn; });
				// landing on an attached pin (zero-length wire) or on another dot (double
				// square) trades one artifact for a worse one — skip such turns
				const nx = g[0].axis === "x" ? snap(near) : jp.x;
				const ny = g[0].axis === "y" ? snap(near) : jp.y;
				if (ends.some(op => Math.hypot(op.x - nx, op.y - ny) < GRID)) return;
				if (sch.components.some(k => k !== j && k.type === "JUNCTION" && Math.hypot((k.x + 6) - nx, (k.y + 6) - ny) < GRID)) return;
				// …and landing ON a symbol is the worst artifact of all: the dot becomes
				// unclickable behind the gate's own hit shapes. The pin guard above is not
				// enough — a turn can clear every pin and still sit on the body.
				if (bodyClearance({ x: nx, y: ny }, sch) < GRAB_CLEAR) return;
				const dist = Math.abs(near - cur);
				if (dist > 0.5 && (!best || dist < best.dist)) best = { axis: g[0].axis, val: near, dist };
			});
			if (best) {
				if (best.axis === "y") j.y = snap(best.val) - 6; else j.x = snap(best.val) - 6;
				moved = true;
			}
		}
	}
}

/* DIFFERENT nets must never share a drawn run ("สายคนละเส้นห้ามทับกัน") — wires of
   the SAME net legitimately share trunks (fan-out), but when a z-staircase leg or an
   s-route middle lands on another net's segment, nudge it to the nearest FREE grid
   column/row. Runs after wiring edits/moves; a persisted w.mx/w.my is updated so the
   choice sticks. */
function separateWireOverlaps(sch) {
	sch = sch || activeSch();
	const key = new Map();     // wire id → net identity (driver port)
	sch.wires.forEach(w => {
		const d = netDriverPort(sch, w);
		key.set(w.id, d ? d.cid + "." + d.pid : "w:" + w.id);
	});
	const calc = w => {
		const a = comp(w.from.cid, sch), b = comp(w.to.cid, sch);
		const p1 = a && portPos(a, w.from.pid), p2 = b && portPos(b, w.to.pid);
		if (!p1 || !p2) return null;
		const r = wireRoute(w, p1, p2, wireOpts(w, sch));
		return { w, r, parts: routeParts(r) };
	};
	const ov = (a1, a2, b1, b2) => Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));
	let guard = 0;
	while (guard++ < 4) {
		const all = sch.wires.map(calc).filter(Boolean);
		let moved = false;
		for (const A of all) {
			const others = all.filter(B => B.w !== A.w && key.get(B.w.id) !== key.get(A.w.id));
			// a JUNCTION BRANCH drop ("l" leaving a junction — a bent leg only, never a
			// straight "v" whose both ends are pinned): its vertical leg sits AT the
			// junction x — when two stacked fan-outs drop side-by-side into the same
			// column, slide the JUNCTION itself along its horizontal host to a free column.
			if (A.r.kind === "l") {
				const j = comp(A.w.from.cid, sch);
				if (!j || j.type !== "JUNCTION") continue;
				if (j.params && j.params.fixed) continue;     // user parked this dot — hands off
				const yLo = Math.min(A.r.y1, A.r.y2), yHi = Math.max(A.r.y1, A.r.y2);
				const busy = x => others.some(B => B.parts.some(s => s.t === "v" && Math.abs(s.x - x) < 0.5 && ov(s.y1, s.y2, yLo, yHi) > 2));
				const hBusyAt = (y, a, b) => others.some(B => B.parts.some(s => s.t === "h" && Math.abs(s.y - y) < 0.5 && ov(s.x1, s.x2, a, b) > 2));
				// (1) an L's horizontal TAIL rides the destination-pin row for its whole
				// length — when that row also carries ANOTHER net (pins sharing a row is
				// common), re-route this branch as a z: head rides its own trunk row and
				// only drops onto the pin row PAST the conflict. Prefer the latest drop.
				if (hBusyAt(A.r.y2, Math.min(A.r.x1, A.r.x2), Math.max(A.r.x1, A.r.x2))
					&& (A.r.x2 - A.r.x1) >= 2 * WIRE_MINLEG) {
					const lo = A.r.x1 + WIRE_MINLEG, hi = A.r.x2 - WIRE_MINLEG;
					let pick;
					for (let x = hi; x >= lo; x -= GRID) {
						const xx = snap(x); if (xx < lo || xx > hi) continue;
						if (busy(xx)) continue;
						if (hBusyAt(A.r.y1, Math.min(A.r.x1, xx), Math.max(A.r.x1, xx))) continue;
						if (hBusyAt(A.r.y2, Math.min(xx, A.r.x2), Math.max(xx, A.r.x2))) continue;
						pick = xx; break;
					}
					if (pick !== undefined) {
						A.w.zjog = 1; A.w.mx = pick; moved = true;
						const u = calc(A.w); if (u) { A.r = u.r; A.parts = u.parts; }
						continue;
					}
				}
				if (!busy(A.r.x1)) continue;
				// allowed span: stay strictly between the horizontal hosts' far endpoints;
				// any VERTICAL host pins the junction column — sliding would kink it
				const jp = portPos(j, "j");
				let lo = -Infinity, hi = Infinity, onHost = false, vHost = false;
				sch.wires.forEach(w2 => {
					if (w2 === A.w || (w2.from.cid !== j.id && w2.to.cid !== j.id)) return;
					const oc = comp(w2.from.cid === j.id ? w2.to.cid : w2.from.cid, sch);
					const op = oc && portPos(oc, w2.from.cid === j.id ? w2.to.pid : w2.from.pid);
					if (!op) return;
					if (Math.abs(op.x - jp.x) < 0.5 && Math.abs(op.y - jp.y) >= 0.5) { vHost = true; return; }
					if (Math.abs(op.y - jp.y) >= 0.5) return;             // horizontal hosts only
					onHost = true;
					if (op.x < jp.x) lo = Math.max(lo, op.x + GRID); else hi = Math.min(hi, op.x - GRID);
				});
				if (!onHost || vHost) continue;
				if (!isFinite(lo)) lo = jp.x - 8 * GRID;
				if (!isFinite(hi)) hi = jp.x + 8 * GRID;
				// the landing column must be clear of every other junction square and of any
				// component pin on this row — else we mint a double-square blob or a fake
				// connection dot on a foreign port
				const clearAt = xx => sch.components.every(k => {
					if (k === j) return true;
					if (k.type === "JUNCTION")
						return Math.abs((k.x + 6) - xx) >= 1.5 * GRID || Math.abs((k.y + 6) - jp.y) >= 1.5 * GRID;
					const td = typeDef(k); if (!td || !td.ports) return true;
					return td.ports(k.params || {}).every(p => {
						const pp = portPos(k, p.id);
						return !pp || Math.abs(pp.x - xx) >= GRID || Math.abs(pp.y - jp.y) >= GRID;
					});
				});
				let slid = false;
				for (let d = 1; d <= Math.ceil((hi - lo) / GRID); d++) {
					const cands = [snap(jp.x - d * GRID), snap(jp.x + d * GRID)].filter(xx => xx >= lo && xx <= hi && clearAt(xx));
					const free = cands.find(xx => !busy(xx));
					if (free !== undefined) { j.x = free - 6; moved = true; slid = true; break; }
				}
				// sibling wires attached to this junction now have STALE routes — restart
				// the sweep instead of sliding again off stale data (junction walk-off)
				if (slid) break;
				continue;
			}
			if (A.r.kind !== "z" && A.r.kind !== "s") continue;      // only these have a free leg
			if (A.r.kind === "z") {
				// moving the leg (mx) changes all three runs — a candidate is bad if the
				// vertical leg lands on another net's vertical, OR either horizontal run
				// (y1: x1..mx, y2: mx..x2) would still lie along another net's horizontal
				const yLo = Math.min(A.r.y1, A.r.y2), yHi = Math.max(A.r.y1, A.r.y2);
				const busy = x =>
					others.some(B => B.parts.some(s => s.t === "v" && Math.abs(s.x - x) < 0.5 && ov(s.y1, s.y2, yLo, yHi) > 2)) ||
					others.some(B => B.parts.some(s => s.t === "h" && Math.abs(s.y - A.r.y1) < 0.5 && ov(s.x1, s.x2, Math.min(A.r.x1, x), Math.max(A.r.x1, x)) > 2)) ||
					others.some(B => B.parts.some(s => s.t === "h" && Math.abs(s.y - A.r.y2) < 0.5 && ov(s.x1, s.x2, Math.min(x, A.r.x2), Math.max(x, A.r.x2)) > 2));
				if (!busy(A.r.mx)) continue;
				const lo = A.r.x1 + WIRE_MINLEG, hi = A.r.x2 - WIRE_MINLEG;
				for (let d = 1; d <= Math.ceil((hi - lo) / GRID); d++) {
					const cands = [snap(A.r.mx + d * GRID), snap(A.r.mx - d * GRID)].filter(x => x >= lo && x <= hi);
					const free = cands.find(x => !busy(x));
					if (free !== undefined) { A.w.mx = free; moved = true; break; }
				}
			} else {
				// s-route: middle horizontal at my — collides with another net's horizontal?
				const xLo = Math.min(A.r.x1, A.r.x2) + WIRE_MINLEG, xHi = Math.max(A.r.x1, A.r.x2) - WIRE_MINLEG;
				const busy = y => others.some(B => B.parts.some(s => s.t === "h" && Math.abs(s.y - y) < 0.5 && ov(s.x1, s.x2, xLo, xHi) > 2));
				if (!busy(A.r.my)) continue;
				for (let d = 1; d <= 8; d++) {
					const free = [snap(A.r.my + d * GRID), snap(A.r.my - d * GRID)].find(y => !busy(y));
					if (free !== undefined) { A.w.my = free; moved = true; break; }
				}
			}
			if (moved) { const u = calc(A.w); if (u) { A.r = u.r; A.parts = u.parts; } }
		}
		if (!moved) break;
	}
}
/* ISE fan-out rule: a branch leaves the net at the take-off point CLOSEST to its own
   sink, so the connection dot sits where the wires REALLY diverge. Without this, a
   sink wired early keeps its tap far up the trunk while a later branch runs the whole
   way down beside it — two long parallel same-net runs and a dot stranded "ข้างบน"
   instead of at the split. Re-tap any branch the net can serve materially closer. */
function retapBranches(sch) {
	sch = sch || activeSch();
	if (state.pendingWire) return;
	for (let pass = 0; pass < 3; pass++) {
		let moved = false;
		for (const w of [...sch.wires]) {
			if (!sch.wires.includes(w)) continue;
			const j = comp(w.from.cid, sch), sink = comp(w.to.cid, sch);
			if (!j || j.type !== "JUNCTION") continue;            // only a branch off a dot
			if (!sink || sink.type === "JUNCTION") continue;      // …that ends at a real pin
			if (j.params && j.params.fixed) continue;           // user parked this dot — hands off
			const sp = portPos(sink, w.to.pid), jp = portPos(j, "j");
			if (!sp || !jp) continue;
			const drv = netDriverPort(sch, w); if (!drv) continue;
			const others = netWiresFrom(sch, drv.cid, drv.pid).filter(x => x !== w);
			let best = null;
			for (const cand of others) {
				// clear of every symbol, else the dot lands on the pin and can't be grabbed
				const at = nearestClearOnWire(cand, sp, sch);
				if (at && (!best || at.d < best.at.d)) best = { w: cand, at };
			}
			if (!best) continue;
			// only move for a real gain, so this can never fight itself into a loop
			if (Math.hypot(jp.x - sp.x, jp.y - sp.y) - best.at.d < 3 * GRID) continue;
			// reuse a dot already sitting there, else split that wire to make one
			let nj = sch.components.find(c => {
				if (c.type !== "JUNCTION" || c === j) return false;
				if (!others.some(x => x.from.cid === c.id || x.to.cid === c.id)) return false;
				const cp = portPos(c, "j");
				return Math.hypot(cp.x - best.at.x, cp.y - best.at.y) <= 1.5 * GRID;
			});
			if (!nj) {
				nj = { id: uid("c"), type: "JUNCTION", x: best.at.x - 6, y: best.at.y - 6, params: {} };
				sch.components.push(nj);
				splitWireThroughJunction(best.w, nj, sch);
			}
			w.from = { cid: nj.id, pid: "j" };                 // the old dot heals away
			moved = true;
		}
		if (!moved) break;
	}
	healJunctions(sch);
}
/* the ONE canonical layout pass, always in this order: put each branch's dot at the
   real divergence, align fan-out dots, reflow overlapping exits, separate
   different-net runs, then HEAL LAST so any adjacency the movers created (coincident
   dots, zero-length stubs) is merged before render — never leave a healer artifact on
   screen waiting for the "next edit". */
function healLayout(sch) {
	sch = sch || activeSch();
	retapBranches(sch);
	alignJunctionBranch(sch);
	reflowJunctions(sch);
	separateWireOverlaps(sch);
	healJunctions(sch);
}

/* ISE behaviour: a port drives ONE wire; further connections branch off the
   existing net through a junction, so every connection point shows a dot
   (and is itself connectable). Returns true if it branched. */
function branchFromNet(sch, fromPort, toPort) {
	const fc = comp(fromPort.cid, sch);
	if (!fc || fc.type === "JUNCTION") return false;         // junction fanout is already a dot
	const candidates = netWiresFrom(sch, fromPort.cid, fromPort.pid);
	if (!candidates.length) return false;                  // first wire from this port
	const sink = comp(toPort.cid, sch);
	const sinkPos = sink && portPos(sink, toPort.pid);
	if (!sinkPos) return false;
	// The dot is BORN here, and no later pass rescues it: retapBranches only moves a
	// branch that gains 3*GRID, and a dot minted at the nearest point is already ~GRID
	// from its sink — so if we seat it on the symbol here, it stays on the symbol and
	// can never be grabbed. Pick the closest take-off that still clears every body.
	let best = null, raw = null;
	for (const w of candidates) {
		const at0 = nearestOnWire(w, sinkPos, GRID, sch);
		if (at0 && (!raw || at0.d < raw.at.d)) raw = { w, at: at0 };
		const at = nearestClearOnWire(w, sinkPos, sch);
		if (at && (!best || at.d < best.at.d)) best = { w, at };
	}
	if (!best) best = raw;         // nowhere clear on this net — a tight dot beats no connection
	if (!best) return false;                               // net too short to tap
	// ISE puts ONE dot per branch point — if the tap lands within a grid of an
	// existing junction on this net, REUSE it instead of dropping a 2nd square
	// beside it (the "two adjacent squares" defect).
	const near = sch.components.find(c => {
		if (c.type !== "JUNCTION") return false;
		if (!candidates.some(w => w.from.cid === c.id || w.to.cid === c.id)) return false;   // must be on this net
		const cp = portPos(c, "j");
		return Math.hypot(cp.x - best.at.x, cp.y - best.at.y) <= 1.5 * GRID;
	});
	if (near) {
		sch.wires.push({ id: uid("w"), from: { cid: near.id, pid: "j" }, to: { cid: toPort.cid, pid: toPort.pid }, name: "" });
		return true;
	}
	const j = { id: uid("c"), type: "JUNCTION", x: best.at.x - 6, y: best.at.y - 6, params: {} };
	sch.components.push(j);
	splitWireThroughJunction(best.w, j, sch);
	sch.wires.push({ id: uid("w"), from: { cid: j.id, pid: "j" }, to: { cid: toPort.cid, pid: toPort.pid }, name: "" });
	return true;
}
/* the ultimate driving port of the net that wire w belongs to (traces w.from
   back through junctions to a real output port) */
function netDriverPort(sch, w, seen) {
	seen = seen || new Set();
	const src = comp(w.from.cid, sch);
	if (!src) return null;
	if (src.type !== "JUNCTION") return { cid: w.from.cid, pid: w.from.pid };
	if (seen.has(src.id)) return null;
	seen.add(src.id);
	const up = sch.wires.find(x => x.to.cid === src.id);
	return up ? netDriverPort(sch, up, seen) : { cid: src.id, pid: "j" };
}
/* start a branch FROM a wire without committing a junction yet — the junction
   is placed optimally (nearest the chosen target) once the target is clicked,
   so tapping anywhere on a net still yields clean, detour-free routing */
function startWireBranch(w, point) {
	const at = nearestOnWire(w, point);
	state.pendingWire = {
		onWire: w.id,
		anchor: at ? { x: at.x, y: at.y } : { x: snap(point.x), y: snap(point.y) }, isOut: true
	};
	render();
}
/* rewrite parallel same-port fanout wires (old files, seeds) into junction
   branches so connection dots appear everywhere wires join */
function normalizePortFanout(sch) {
	const failed = new Set();
	for (let guard = 0; guard < 200; guard++) {
		const groups = new Map();
		sch.wires.forEach(w => {
			const src = comp(w.from.cid, sch);
			if (!src || src.type === "JUNCTION") return;
			const k = w.from.cid + "." + w.from.pid;
			if (!groups.has(k)) groups.set(k, []);
			groups.get(k).push(w);
		});
		let extra = null;
		for (const [k, ws] of groups) {
			if (ws.length > 1 && !failed.has(k)) { extra = { k, w: ws[1] }; break; }
		}
		if (!extra) break;
		sch.wires = sch.wires.filter(w => w !== extra.w);
		if (!branchFromNet(sch, extra.w.from, extra.w.to)) {
			sch.wires.push(extra.w);            // couldn't branch — keep as-is
			failed.add(extra.k);
		}
	}
}
function tapWire(w, point) {
	// no wire being drawn yet → START a branch from this wire (junction deferred
	// until the target is chosen, so it lands at the optimal spot). Also used to
	// re-pick the source wire while a branch is pending.
	if (!state.pendingWire || state.pendingWire.onWire) {
		startWireBranch(w, point);
		return;
	}
	// completing a wire being drawn from a port/junction ONTO this wire →
	// block outputs (would make two drivers on one net)
	const pc = comp(state.pendingWire.cid);
	if (pc) {
		const pp = getPort(pc, state.pendingWire.pid);
		const drives = pc.type === "JUNCTION"
			? activeSch().wires.some(x => x.to.cid === pc.id)
			: (pp && pp.dir === "out");
		if (drives) {
			toast("แตะ (tap) สายด้วย output ไม่ได้ — จะทำให้มี driver ชนกันบน net เดียว", "warn");
			return;
		}
	}
	const { j } = createJunctionOnWire(w, point);
	splitWireThroughJunction(w, j);
	onPortClick(j, { id: "j", dir: "out" });   // complete the pending wire to the new junction
}

/* =========================================================================
   CANVAS RENDER
   ========================================================================= */
/* The dot grid is a CSS layer on .canvas-host, so it must be driven by the view:
   scale the tile with the zoom and offset it by the pan, and step the spacing up or
   down by powers of two so the dots stay a readable density instead of turning into
   noise when zoomed out (or disappearing when zoomed in). Dots then always sit on
   real grid points under the schematic at ANY zoom. */
function syncGridBg() {
	const host = document.querySelector(".canvas-host");
	if (!host) return;
	const k = state.view.k;
	let base = 2 * GRID;                                  // the lattice the dots mark
	while (base * k < 12) base *= 2;         // zoomed OUT → coarser lattice
	while (base * k > 48 && base > GRID) base /= 2;        // zoomed IN  → finer lattice
	const s = base * k;
	const mod = (v, m) => ((v % m) + m) % m;             // the dot sits 1px into its tile
	host.style.backgroundSize = `${s}px ${s}px, auto`;
	host.style.backgroundPosition = `${mod(state.view.x - 1, s)}px ${mod(state.view.y - 1, s)}px, 0 0`;
}
function render() {
	const sch = activeSch();
	while (canvas.firstChild) canvas.removeChild(canvas.firstChild);
	syncGridBg();
	if (!sch) return;

	const root = el("g", { transform: `translate(${state.view.x},${state.view.y}) scale(${state.view.k})` });
	canvas.appendChild(root);

	// wires — resolve routes in two passes so automatic routes dodge both
	// manually-adjusted segments and each other (no overlapping vertical runs)
	const wireEnds = w => {
		const a = comp(w.from.cid, sch); const b = comp(w.to.cid, sch);
		if (!a || !b) return null;
		const p1 = portPos(a, w.from.pid); const p2 = portPos(b, w.to.pid);
		return (p1 && p2) ? [p1, p2] : null;
	};
	const wireRoutes = new Map();
	const usedV = [];   // occupied vertical runs: {x, y1, y2}
	const addV = r => routeParts(r).forEach(part => {
		if (part.t === "v") usedV.push({ x: part.x, y1: Math.min(part.y1, part.y2), y2: Math.max(part.y1, part.y2) });
	});
	// pass 1: straight, waypoint, and manually-routed wires are fixed obstacles
	sch.wires.forEach(w => {
		const pp = wireEnds(w); if (!pp) return;
		const r = wireRoute(w, pp[0], pp[1], wireOpts(w));
		if (r.kind !== "z" || typeof w.mx === "number") { wireRoutes.set(w.id, r); addV(r); }
	});
	// pass 2: default staircases slide sideways to a free column
	sch.wires.forEach(w => {
		if (wireRoutes.has(w.id)) return;
		const pp = wireEnds(w); if (!pp) return;
		const r = wireRoute(w, pp[0], pp[1], wireOpts(w));
		const lo = r.x1 + WIRE_MINLEG, hi = r.x2 - WIRE_MINLEG;
		const yA = Math.min(r.y1, r.y2), yB = Math.max(r.y1, r.y2);
		const collide = x => usedV.some(s => Math.abs(s.x - x) < 8 && yA < s.y2 && yB > s.y1);
		if (collide(r.mx)) {
			for (let k = 1; k <= 10; k++) {
				const cand = [r.mx + k * GRID, r.mx - k * GRID].filter(x => x >= lo && x <= hi && !collide(x));
				if (cand.length) { r.mx = cand[0]; r.d = `M${r.x1},${r.y1}H${r.mx}V${r.y2}H${r.x2}`; break; }
			}
		}
		wireRoutes.set(w.id, r); addV(r);
	});
	// all vertical runs across every wire — used to place crossing hops
	// Crossing hops cost O(wires²) per frame. Skip them when the plain style is
	// selected, while the user is actively dragging/panning (redraws every
	// mousemove), and in very large schematics.
	const fastRender = HOP_STYLE !== "hop" || !!(state.drag || state.wireDrag || state.pan) || sch.wires.length > 160;
	const allV = [];
	if (!fastRender) wireRoutes.forEach((r, wid) => {
		routeParts(r).forEach(part => {
			if (part.t === "v") allV.push({ x: part.x, y1: part.y1, y2: part.y2, wid });
		});
	});
	// wire widths derived once per frame from the driving ports (never cached)
	const wWidth = new Map();
	sch.wires.forEach(w => wWidth.set(w.id, netWidth(w, sch)));
	const drawWire = w => {
		const r = wireRoutes.get(w.id); if (!r) return;
		const isBus = (wWidth.get(w.id) || 1) > 1;
		const isSel = state.selection.has(w.id);
		const g = el("g", { class: "wire-group" + (isSel ? " sel" : "") });
		// visible path carries hops over crossings so overlaps read clearly
		const D = fastRender ? r.d : hoppedPathD(r, allV, w.id);
		const path = el("path", {
			d: D,
			class: "wire" + (isBus ? " bus" : "") + (isSel ? " selected" : ""),
			stroke: isSel ? "var(--wire-sel)" : (isBus ? "var(--wire-bus)" : "var(--wire)")
		});
		g.appendChild(path);
		// wide invisible hit path (straight route): easy clicking + drag rerouting
		const hit = el("path", { d: r.d, class: "wire-hit" });
		hit.style.cursor = state.tool !== "select" ? "inherit"
			: r.kind === "z" ? "ew-resize"
				: r.kind === "s" ? "ns-resize"
					: r.kind === "h" ? "ns-resize"     // straight horizontal — drag vertically to bend it
						: r.kind === "v" ? "ew-resize"     // straight vertical — drag horizontally to bend it
							: (r.kind === "l" || r.kind === "lh") ? "move"   // single elbow — drag to reshape
								: "pointer";
		hit.addEventListener("mousedown", ev => {
			if (ev.button !== 0) return;
			ev.stopPropagation();
			if (state.spaceDown) { startPan(ev); return; }
			// ISE modal tools act on wires directly
			if (state.tool === "netname") { applyWireName(w, prompt("ตั้งชื่อสาย (บัสต้องลากจากพอร์ต >1 bit ของ component):", w.name || "")); return; }
			if (state.tool === "bus") {
				// Bus tool on a wire: bus → tap the next bit; a non-bus wire is NOT
				// converted — a bus must originate from a component port (drag from a
				// >1-bit pin), never be conjured onto a plain wire.
				if (netWidth(w) > 1) stampTapOnWire(w, svgPoint(ev));
				else toast("สายนี้ไม่ใช่บัส — สร้างบัสโดยลากจากพอร์ต >1 bit ของ component", "info", 3000);
				return;
			}
			if (state.tool === "iomarker") return;
			if (state.tool === "wire") { tapWire(w, svgPoint(ev)); return; }   // branch from / finish at this wire
			// tap-on-wire: if user is currently drawing a wire, clicking on an
			// existing wire creates a junction at that point and continues the route
			if (state.pendingWire) { tapWire(w, svgPoint(ev)); return; }
			// shift+alt+click → tap (start a new wire from this point on the wire)
			if (ev.shiftKey && ev.altKey) { tapWire(w, svgPoint(ev)); return; }
			// click = select (on mouseup); drag = move the adjustable segment
			state.wireDrag = { w, kind: r.kind, m0: svgPoint(ev), moved: false, shift: ev.shiftKey };
		});
		hit.addEventListener("dblclick", ev => {
			// rename only when not mid-gesture (drawing/branching)
			if (state.pendingWire) return;
			applyWireName(w, prompt("ตั้งชื่อสาย (บัสต้องลากจากพอร์ต >1 bit ของ component):", w.name || ""));
		});
		// right-click a wire = tap it (only if it is already a bus); a plain wire is
		// never turned into a bus — buses come from a component port only
		hit.addEventListener("contextmenu", ev => {
			ev.preventDefault(); ev.stopPropagation();
			if (state.pendingWire) return;                 // never mutate mid-draw
			if (netWidth(w) > 1) stampTapOnWire(w, svgPoint(ev));
		});
		g.appendChild(hit);
		// endpoint markers when selected → the exact path is unambiguous
		if (isSel) {
			[[r.x1, r.y1], [r.x2, r.y2]].forEach(([ex, ey]) => {
				g.appendChild(el("circle", { cx: ex, cy: ey, r: 3.5, fill: "var(--wire-sel)", stroke: "var(--bg-0)", "stroke-width": 1, "pointer-events": "none" }));
			});
			// draggable corner handles for a manually-routed (waypoint) wire
			if (w.pts) w.pts.forEach((pt, idx) => {
				const h = el("rect", {
					x: pt.x - 4, y: pt.y - 4, width: 8, height: 8, rx: 1,
					fill: "var(--bg-1)", stroke: "var(--wire-sel)", "stroke-width": 1.5
				});
				h.style.cursor = "move";
				h.addEventListener("mousedown", ev => {
					if (ev.button !== 0) return; ev.stopPropagation();
					state.cornerDrag = { w, index: idx };
				});
				g.appendChild(h);
			});
		}
		root.appendChild(g);

		if (w.name) {
			// label follows the actual route (sits on the adjustable segment);
			// bus wires show the range like OP3[7:0] (same notation as I/O markers)
			let labText = w.name;
			if (isBus) labText = `${w.name}(${(wWidth.get(w.id) || 1) - 1}:0)`;
			let lx, ly;
			if (r.kind === "poly") { const m = r.pts[Math.floor(r.pts.length / 2)]; lx = m.x; ly = m.y - 6; }
			else {
				lx = r.kind === "z" ? r.mx : r.kind === "l" ? r.x1 : (r.x1 + r.x2) / 2;
				ly = (r.kind === "s" ? r.my : r.kind === "h" ? r.y1 : (r.y1 + r.y2) / 2) - 6;
			}
			const bw = Math.max(44, labText.length * 6.5 + 10);   // fit the text
			const bg = el("rect", { x: lx - bw / 2, y: ly - 10, width: bw, height: 14, rx: 3, fill: "#0008", "pointer-events": "none" });
			root.appendChild(bg);
			const lbl = txt(lx, ly, labText, { anchor: "middle", fill: "var(--ink-dim)", size: 10 });
			lbl.setAttribute("class", "wire-label");
			root.appendChild(lbl);
		}
	};
	// draw unselected first, selected last so the highlighted wire sits on top
	sch.wires.forEach(w => { if (!state.selection.has(w.id)) drawWire(w); });
	sch.wires.forEach(w => { if (state.selection.has(w.id)) drawWire(w); });

	// wire being drawn — show committed corners plus the live orthogonal segment
	if (state.pendingWire) {
		const pw = state.pendingWire;
		let start = null;
		if (pw.onWire) {
			const bw = sch.wires.find(x => x.id === pw.onWire);
			const at = bw && nearestOnWire(bw, state.mouse, 0, sch);
			start = at ? { x: at.x, y: at.y } : pw.anchor;
		} else {
			const c = comp(pw.cid, sch);
			if (c) start = portPos(c, pw.pid);
		}
		if (start) {
			const chain = [start, ...(pw.pts || [])];
			const last = chain[chain.length - 1];
			const step = orthoStep(last, state.mouse);          // current H/V segment
			const pts = orthoPolyline([...chain, step, state.mouse], true, true);
			root.appendChild(el("path", {
				d: "M" + pts.map(p => `${p.x},${p.y}`).join("L"), fill: "none",
				stroke: "var(--accent-2)", "stroke-width": 2, "stroke-dasharray": "6 4",
				"pointer-events": "none"   // never swallow the click that places the next corner
			}));
			// committed corner dots
			(pw.pts || []).forEach(p => root.appendChild(el("circle", { cx: p.x, cy: p.y, r: 2.5, fill: "var(--accent-2)", "pointer-events": "none" })));
		}
	}

	// marquee (rectangle selection)
	if (state.marquee && state.marquee.moved) {
		const x = Math.min(state.marquee.sx, state.marquee.ex);
		const y = Math.min(state.marquee.sy, state.marquee.ey);
		const w = Math.abs(state.marquee.ex - state.marquee.sx);
		const h = Math.abs(state.marquee.ey - state.marquee.sy);
		root.appendChild(el("rect", {
			x, y, width: w, height: h,
			fill: "rgba(91,141,239,0.13)", stroke: "var(--accent)",
			"stroke-width": 1.2 / state.view.k, "stroke-dasharray": `${5 / state.view.k} ${4 / state.view.k}`
		}));
	}

	// components
	sch.components.forEach(c => {
		const td = typeDef(c); if (!td) return;
		const sz = td.size(c.params || {});
		const isSel = state.selection.has(c.id);
		const rot = ((c.rot || 0) % 360 + 360) % 360;
		let ntf = `translate(${c.x},${c.y})`;
		if (rot) ntf += ` rotate(${rot} ${sz.w / 2} ${sz.h / 2})`;
		if (c.mirror) ntf += ` translate(${sz.w} 0) scale(-1 1)`;
		const g = el("g", { class: "node" + (isSel ? " selected" : ""), transform: ntf });
		const body = el("g", { class: "body" });
		body.innerHTML = td.shape(c.params || {});
		// a junction joining bus wires takes the bus colour so it blends in
		// instead of standing out cyan
		if (c.type === "JUNCTION") {
			const jWires = sch.wires.filter(w => w.from.cid === c.id || w.to.cid === c.id);
			const busJ = jWires.some(w => (wWidth.get(w.id) || 1) > 1);
			const isBusDef = c.params && c.params.busName && c.params.busWidth;
			const dot = body.querySelector("rect,circle");
			// ISE bus RIPPER: where a bit taps a bus, ISE draws a short 45° "rip"
			// slash (not a perpendicular dot). Detect a junction feeding a BUS TAP and
			// draw the ripper, oriented from the bus toward the tap branch.
			const tapW = jWires.find(w => {
				const oc = comp(w.from.cid === c.id ? w.to.cid : w.from.cid, sch);
				return oc && oc.type === "BUSTAP";
			});
			if (tapW && dot) {
				dot.remove();
				// a short 45° "/" rip slash in bus colour, centred on the join
				body.appendChild(el("line", {
					x1: -2, y1: 14, x2: 14, y2: -2,
					stroke: "var(--wire-bus)", "stroke-width": 2.6, "stroke-linecap": "round"
				}));
			} else if (dot && (busJ || isBusDef)) dot.setAttribute("fill", "var(--wire-bus)");
			// a free wire end reads as a hollow marker — judged LIVE (exactly one
			// wire attached), so a later-connected end goes back to a solid join;
			// a bus-definition node always stays solid + gets its ISE-style label
			if (dot && c.params && c.params.endpoint && jWires.length === 1 && !isBusDef) {
				dot.setAttribute("fill", "var(--bg-0)");
				dot.setAttribute("stroke", busJ ? "var(--wire-bus)" : "var(--wire)");
				dot.setAttribute("stroke-width", "1.6");
			}
			if (isBusDef) {
				// label shows the REAL net width (from the source if driven)
				const jw = jWires[0];
				const eff = jw ? (wWidth.get(jw.id) || c.params.busWidth) : c.params.busWidth;
				const text = sanId(c.params.busName) + "(" + (eff - 1) + ":0)";
				// place the label on the clear side of the host wire: above a
				// horizontal run, beside a vertical one (never through the stroke)
				let horiz = true, sign = 1;
				if (jw) {
					const oc = comp(jw.from.cid === c.id ? jw.to.cid : jw.from.cid, sch);
					const op = oc && portPos(oc, jw.from.cid === c.id ? jw.to.pid : jw.from.pid);
					if (op) { const dx = op.x - (c.x + 6), dy = op.y - (c.y + 6); horiz = Math.abs(dx) >= Math.abs(dy); sign = (horiz ? dx : dy) >= 0 ? 1 : -1; }
				}
				const tw = text.length * 6.6 + 8;
				let lx, anchor, ly;
				if (horiz) { ly = -7; lx = sign > 0 ? 2 : 10; anchor = sign > 0 ? "start" : "end"; }
				else { ly = 4; lx = 14; anchor = "start"; }
				const bgx = anchor === "start" ? lx - 3 : lx - tw + 3;
				body.appendChild(el("rect", {
					x: bgx, y: ly - 11, width: tw, height: 14, rx: 3,
					fill: "#0008", "pointer-events": "none"
				}));
				const lbl = txt(lx, ly, text, { anchor, fill: "var(--wire-bus)", size: 11 });
				lbl.setAttribute("font-family", "monospace");
				body.appendChild(lbl);
			}
			// junctions have no port overlay → give the 9px square a real hit area,
			// but ONLY in tools that act on junctions (select: move/inspect, wire:
			// connect). In the bus/netname tools an enlarged rect would eclipse the
			// wire underneath and swallow tap/rename clicks near every junction.
			if (state.tool === "select" || state.tool === "wire") {
				body.appendChild(el("rect", { x: -3, y: -3, width: 18, height: 18, fill: "transparent" }));
			}
		}
		body.addEventListener("mousedown", ev => startDrag(ev, c));
		if (c.type === "IN" || c.type === "OUT") {
			body.addEventListener("dblclick", ev => openInspectorFor(c));
		} else {
			body.addEventListener("dblclick", ev => openInspectorFor(c));
		}
		body.addEventListener("contextmenu", ev => {
			ev.preventDefault();
			openInspectorFor(c);
		});
		g.appendChild(body);

		// ports — a JUNCTION keeps only its body dot: click = wire, drag = move
		// (handled in startDrag/mouseup), so no port overlay is added for it
		if (c.type !== "JUNCTION") td.ports(c.params || {}).forEach(p => {
			const isOut = p.dir === "out";
			const isPending = state.pendingWire && state.pendingWire.cid === c.id && state.pendingWire.pid === p.id;
			const pg = el("g", { class: "port" + (isPending ? " pending" : "") });
			// bus ports show the ISE-style rectangle marker; scalar ports a dot.
			// Both get a larger invisible hit circle for easy clicking.
			// EXCEPTION: a BUS TAP's d pin sits directly ON the bus junction — an
			// opaque marker there would punch a hole in the bus stroke and make the
			// tap look disconnected, so it gets no marker (the junction square + the
			// purple triangle already show the joint).
			if (c.type === "BUSTAP" && p.id === "d") {
				pg.appendChild(el("circle", { class: "hit", cx: p.dx, cy: p.dy, r: 9 }));
				pg.addEventListener("mousedown", ev => {
					if (ev.button !== 0) return;
					ev.stopPropagation();
					if (state.spaceDown) { startPan(ev); return; }
					if (state.tool === "netname") return;
					if (state.tool === "iomarker") { toast("ขานี้มีสายต่ออยู่แล้ว", "warn"); return; }
					if (state.tool === "bus") { toast("คลิกบนตัวสายบัส (เยื้องจากจุดต่อ) เพื่อวาง Bus Tap", "info", 2400); return; }
					onPortClick(c, p);
				});
				g.appendChild(pg);
				return;
			}
			if ((p.width || 1) > 1) {
				pg.appendChild(el("rect", {
					class: "port-dot", x: p.dx - 7, y: p.dy - 5, width: 14, height: 10, rx: 1,
					fill: "var(--bg-1)", stroke: "var(--wire-bus)", "stroke-width": 2
				}));
			} else {
				pg.appendChild(el("circle", {
					class: "port-dot", cx: p.dx, cy: p.dy, r: 3.5,
					fill: isOut ? "var(--in-stroke)" : "var(--accent)",
					stroke: "var(--bg-0)", "stroke-width": 1.2
				}));
			}
			pg.appendChild(el("circle", { class: "hit", cx: p.dx, cy: p.dy, r: 9 }));
			pg.addEventListener("mousedown", ev => {
				if (ev.button !== 0) return;
				ev.stopPropagation();
				if (state.spaceDown) { startPan(ev); return; }
				if (state.tool === "iomarker") { addIOMarkerAt(c, p); return; }
				if (state.tool === "netname") return;
				// Bus tool: drag a wire OUT from this component port — the ONLY way to
				// make a bus (a >1-bit port yields a bus wire; a 1-bit port a plain wire)
				if (state.tool === "bus") { onPortClick(c, p); if (state.pendingWire && (p.width || 1) > 1) toast("ลากสายบัสออกจากพอร์ต — คลิกวางมุม/พอร์ตปลายทาง", "info", 2600); return; }
				onPortClick(c, p);   // select & wire modes
			});
			g.appendChild(pg);
			if (p.label) {
				const lx = isOut ? p.dx - 8 : p.dx + 8;
				const an = isOut ? "end" : "start";
				g.appendChild(txt(lx, p.dy + 3, p.label, { anchor: an, size: 9, fill: "var(--ink-dim)" }));
			}
		});

		root.appendChild(g);
	});

	updateStatus();
}

/* dragging */
function svgPoint(ev) {
	const r = canvas.getBoundingClientRect();
	return {
		x: (ev.clientX - r.left - state.view.x) / state.view.k,
		y: (ev.clientY - r.top - state.view.y) / state.view.k
	};
}
/* Selection model — optimistic single-select with multi-restore on drag:
	 - Click component        → IMMEDIATELY shows only that one highlighted
	 - Release without drag   → selection stays as single (clean click)
	 - Drag past threshold    → if it was part of a multi-selection, restore
								and move whole group; otherwise just that one
	 - Shift+click on unsel.  → add to selection
	 - Shift+click on selected→ toggle off
   This avoids the "click one, several look selected" confusion while still
   supporting multi-drag once the user clearly intends to drag.
*/
function startDrag(ev, c) {
	if (ev.button !== 0) return;          // only respond to left mouse button
	ev.stopPropagation();
	if (state.spaceDown) { startPan(ev); return; }   // Space+drag pans from anywhere
	if (state.tool !== "select") {
		// drawing tools don't move parts; a junction still acts as a wire source
		if (state.tool === "wire" && c.type === "JUNCTION") onPortClick(c, { id: "j", dir: "out" });
		return;
	}
	let prevMulti = null;
	if (ev.shiftKey) {
		if (state.selection.has(c.id)) {
			// shift+click on selected → toggle off, no drag
			state.selection.delete(c.id);
			render(); renderInspector();
			return;
		}
		// shift+click on unselected → add
		state.selection.add(c.id);
	} else {
		// remember if c was part of a multi-selection so we can restore on actual drag
		if (state.selection.has(c.id) && state.selection.size > 1) {
			prevMulti = new Set(state.selection);
		}
		// optimistic: visually single-select right now
		state.selection.clear();
		state.selection.add(c.id);
	}
	const m = svgPoint(ev);
	const items = Array.from(state.selection)
		.map(id => comp(id))
		.filter(Boolean)
		.map(cc => ({ c: cc, ox: m.x - cc.x, oy: m.y - cc.y }));
	state.drag = { items, anchor: c.id, sx: m.x, sy: m.y, moved: false, shift: ev.shiftKey, prevMulti };
	render(); renderInspector();
}
function updateMouseStat() {
	$("#statMouse").textContent = `x:${Math.round(state.mouse.x)}, y:${Math.round(state.mouse.y)}  ·  zoom ${Math.round(state.view.k * 100)}%`;
}
canvas.addEventListener("mousemove", ev => {
	state.mouse = svgPoint(ev);
	updateMouseStat();
	if (state.drag) {
		const dx = state.mouse.x - state.drag.sx, dy = state.mouse.y - state.drag.sy;
		// 6-pixel threshold avoids accidental drags from tiny hand jitter
		if (!state.drag.moved && Math.abs(dx) + Math.abs(dy) > 6) {
			state.drag.moved = true;
			// user clearly wants to drag → if anchor was originally part of a multi-
			// selection, restore that selection so the whole group moves together
			if (state.drag.prevMulti) {
				state.selection = new Set(state.drag.prevMulti);
				state.drag.items = Array.from(state.selection)
					.map(id => comp(id)).filter(Boolean)
					.map(cc => ({ c: cc, ox: state.mouse.x - cc.x, oy: state.mouse.y - cc.y }));
			}
		}
		if (state.drag.moved) {
			state.drag.items.forEach(d => {
				// snap what the user SEES. A junction's dot is drawn at its box + 6, and 6
				// is not a multiple of GRID(11) — snapping the box lands the dot at 11k+6,
				// half a grid off every line, which is exactly what kinks its wires. Every
				// creation site already does `<on-grid point> - 6`; match them.
				const q = d.c.type === "JUNCTION" ? 6 : 0;
				d.c.x = snap(state.mouse.x - d.ox + q) - q;
				d.c.y = snap(state.mouse.y - d.oy + q) - q;
			});
			render();
		}
	} else if (state.cornerDrag) {
		const cd = state.cornerDrag;
		cd.w.pts[cd.index] = { x: snap(state.mouse.x), y: snap(state.mouse.y) };
		cd.moved = true;
		render();
	} else if (state.wireDrag) {
		const wd = state.wireDrag;
		if (!wd.moved && Math.abs(state.mouse.x - wd.m0.x) + Math.abs(state.mouse.y - wd.m0.y) > 4) wd.moved = true;
		if (wd.moved) {
			if (wd.kind === "z") { wd.w.mx = snap(state.mouse.x); render(); }
			else if (wd.kind === "s") { wd.w.my = snap(state.mouse.y); render(); }
			else if (wd.kind === "h" || wd.kind === "v" || wd.kind === "l" || wd.kind === "lh") {
				// these shapes have no free/adjustable leg of their own — the FIRST drag
				// plants a manual waypoint at the drag point, switching the wire onto the
				// same user-routed (poly) path used by hand-drawn multi-corner wires. From
				// then on it's a normal draggable corner (see cornerDrag / w.pts above).
				if (!wd.w.pts) wd.w.pts = [{ x: 0, y: 0 }];
				wd.w.pts[0] = { x: snap(state.mouse.x), y: snap(state.mouse.y) };
				render();
			}
		}
	} else if (state.pendingWire) {
		render();
	} else if (state.pan) {
		state.view.x = ev.clientX - state.pan.x;
		state.view.y = ev.clientY - state.pan.y;
		state.pan.moved = true;
		render();
	} else if (state.marquee) {
		state.marquee.ex = state.mouse.x;
		state.marquee.ey = state.mouse.y;
		const dx = state.marquee.ex - state.marquee.sx, dy = state.marquee.ey - state.marquee.sy;
		if (!state.marquee.moved && Math.abs(dx) + Math.abs(dy) > 3) state.marquee.moved = true;
		render();
	}
});
window.addEventListener("mouseup", ev => {
	if (state.cornerDrag) {
		if (state.cornerDrag.moved) snapshot();
		state.cornerDrag = null;
		render();
		return;
	}
	if (state.drag) {
		// junction: a click without movement acts as a port click (start/finish a
		// wire) — but ONLY in the wire tool or when completing a pending wire.
		// In select mode a click on a junction (e.g. a bus label) just selects it,
		// so inspecting a bus never arms a phantom wire.
		if (!state.drag.moved && !state.drag.shift) {
			const anchor = comp(state.drag.anchor);
			if (anchor && anchor.type === "JUNCTION") {
				state.drag = null;
				if (state.tool === "wire" || state.pendingWire) {
					onPortClick(anchor, { id: "j", dir: "out" });
				} else {
					state.selection = new Set([anchor.id]);
					if (anchor.params && anchor.params.busName) setRightTab("inspector");
					render(); renderInspector();
				}
				return;
			}
		}
		if (state.drag.moved) {
			// a dangling end dragged onto a wire welds into a real junction (and its
			// square then tracks the connection); also cleans up any freed junctions
			const movedComps = state.drag.items.map(d => d.c);
			const draggedJunction = state.drag.items.some(d => d.c.type === "JUNCTION");
			const anchor = comp(state.drag.anchor);
			state.drag = null;
			// A dot the user dragged by hand is THEIRS: pin it, or the auto re-tap below
			// recomputes the "nearest take-off" and drags it straight back — which reads
			// as the dot being unmovable. Delete the dot to hand the net back to auto.
			// ONLY the grabbed dot: junctions swept along in a block/marquee drag were
			// never aimed at, and freezing those would silently kill auto-layout there.
			if (anchor && anchor.type === "JUNCTION") (anchor.params || (anchor.params = {})).fixed = true;
			if (draggedJunction) { weldTouchingEnds(); healJunctions(); }
			// a Bus Tap / Bus Ripper dragged onto a bus snaps on (or off, when dragged
			// clear) — so you can position it and let it grab the bus, no manual wire
			movedComps.forEach(c => { if (busInPin(c)) syncBusAttachment(c); });
			// moving a component/junction reroutes wires — re-slide branch junctions so
			// the connection square stays exactly where the wires diverge (not left
			// behind, and not stranded below a long shared stub of overlapping branches)
			healLayout();
			snapshot();
		} else {
			state.drag = null;
		}
		render();   // redraw with crossing hops now that the drag ended
	}
	if (state.wireDrag) {
		const wd = state.wireDrag;
		state.wireDrag = null;
		if (wd.moved) {
			if (wd.kind === "z" || wd.kind === "s" || wd.kind === "h" || wd.kind === "v" || wd.kind === "l" || wd.kind === "lh") snapshot();   // these all actually reroute now
		} else {
			// plain click on a wire → select it (shift toggles)
			if (!wd.shift) { state.selection.clear(); state.selection.add(wd.w.id); }
			else if (state.selection.has(wd.w.id)) state.selection.delete(wd.w.id);
			else state.selection.add(wd.w.id);
			renderInspector();
		}
		render();
	}
	if (state.pan) { state.pan = null; canvas.style.cursor = state.spaceDown ? "grab" : (TOOL_INFO[state.tool]?.cur || ""); render(); }
	if (state.marquee) {
		if (state.marquee.moved) {
			const sch = activeSch();
			const x1 = Math.min(state.marquee.sx, state.marquee.ex);
			const x2 = Math.max(state.marquee.sx, state.marquee.ex);
			const y1 = Math.min(state.marquee.sy, state.marquee.ey);
			const y2 = Math.max(state.marquee.sy, state.marquee.ey);
			// a component (incl. junctions) is selected if its bounding box intersects
			sch.components.forEach(c => {
				const sz = getSize(c);
				if (c.x + sz.w >= x1 && c.x <= x2 && c.y + sz.h >= y1 && c.y <= y2) {
					state.selection.add(c.id);
				}
			});
			// a wire is selected if ANY part of its routed path touches the rectangle
			// (not only when both endpoints are enclosed) — so a drag-box grabs every
			// wire it crosses, letting you select everything in an area at once
			const segHitsRect = part => {
				if (part.t === "h") {
					const xa = Math.min(part.x1, part.x2), xb = Math.max(part.x1, part.x2);
					return part.y >= y1 && part.y <= y2 && xb >= x1 && xa <= x2;
				}
				const ya = Math.min(part.y1, part.y2), yb = Math.max(part.y1, part.y2);
				return part.x >= x1 && part.x <= x2 && yb >= y1 && ya <= y2;
			};
			sch.wires.forEach(w => {
				const a = comp(w.from.cid, sch), b = comp(w.to.cid, sch);
				if (!a || !b) return;
				const p1 = portPos(a, w.from.pid), p2 = portPos(b, w.to.pid);
				if (!p1 || !p2) return;
				const parts = routeParts(wireRoute(w, p1, p2, wireOpts(w, sch)));
				if (parts.some(segHitsRect)) state.selection.add(w.id);
			});
			if (state.selection.size) toast(`Selected ${state.selection.size} item${state.selection.size > 1 ? "s" : ""}`, "info", 1200);
		}
		state.marquee = null;
		render(); renderInspector();
	}
});
function startPan(ev) {
	state.pan = {
		x: ev.clientX - state.view.x,
		y: ev.clientY - state.view.y,
		sx: ev.clientX, sy: ev.clientY,
		moved: false
	};
	canvas.style.cursor = "grabbing";
}
canvas.addEventListener("mousedown", ev => {
	// release focus from any input so keyboard shortcuts (Ctrl+C/V, Del, etc.) work
	if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
		document.activeElement.blur();
	}
	if (ev.target === canvas) {
		if (ev.button === 2) return;                  // ignore right-click
		if (ev.ctrlKey || ev.button === 1 || state.spaceDown) {
			// Ctrl+drag, middle-button, or Space+drag = pan
			startPan(ev);
		} else if (state.pendingWire && state.pendingWire.pts) {
			// drawing a wire → clicking empty canvas drops an orthogonal corner
			addWireCorner();
		} else if (state.pendingWire) {
			// a deferred branch (onWire) → empty click cancels it
			state.pendingWire = null; render();
		} else if (state.tool === "bus") {
			// a bus can NOT be started from empty space — it must be dragged out from a
			// component's port (a >1-bit pin). Guide the user to a port.
			toast("สร้างบัสจากพอร์ตของ component เท่านั้น — ลากออกจากขา >1 bit (สร้างบัสลอยจากพื้นที่ว่างไม่ได้)", "warn", 3600);
		} else if (state.tool === "select") {
			// plain left-drag = marquee (rectangle) selection
			const m = svgPoint(ev);
			state.marquee = { sx: m.x, sy: m.y, ex: m.x, ey: m.y, shift: ev.shiftKey, moved: false };
			if (!ev.shiftKey) { state.selection.clear(); healJunctions(); }
			render(); renderInspector();
		}
	}
});
// right-click on empty canvas while drawing = finish the wire in space
// (ISE-style "Done"); otherwise nothing (buses start from a port, not empty space)
canvas.addEventListener("contextmenu", ev => {
	if (ev.target !== canvas) return;
	ev.preventDefault();
	if (state.pendingWire) {
		if (state.pendingWire.pts) finishWireInSpace();
		else { state.pendingWire = null; healJunctions(); render(); }
	}
});
// double-click empty canvas while drawing → finish the wire in open space
canvas.addEventListener("dblclick", ev => {
	if (ev.target === canvas && state.pendingWire && state.pendingWire.pts) {
		ev.preventDefault();
		finishWireInSpace();
	}
});
canvas.addEventListener("wheel", ev => {
	ev.preventDefault();
	if (ev.ctrlKey || ev.metaKey) {
		// Ctrl+wheel (and trackpad pinch, which arrives as ctrl+wheel) = zoom at cursor
		const k0 = state.view.k;
		const k1 = clamp(k0 * (ev.deltaY < 0 ? 1.12 : 1 / 1.12), 0.3, 3);
		const r = canvas.getBoundingClientRect();
		const mx = ev.clientX - r.left, my = ev.clientY - r.top;
		state.view.x = mx - (mx - state.view.x) * (k1 / k0);
		state.view.y = my - (my - state.view.y) * (k1 / k0);
		state.view.k = k1;
	} else {
		// plain wheel / two-finger trackpad scroll = pan the view
		const unit = ev.deltaMode === 1 ? 16 : 1;   // Firefox line-mode
		let dx = ev.deltaX * unit, dy = ev.deltaY * unit;
		if (ev.shiftKey && !dx) { dx = dy; dy = 0; }   // shift+wheel = horizontal
		state.view.x -= dx;
		state.view.y -= dy;
	}
	render();
}, { passive: false });

/* keyboard */
window.addEventListener("keydown", ev => {
	if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
	// use ev.code (keyboard-layout independent) AND ev.key (for fallback) so Thai
	// and other non-Latin layouts still respond to Ctrl+C / Ctrl+V etc.
	const code = ev.code;
	const k = (ev.key || "").toLowerCase();
	const ctl = ev.ctrlKey || ev.metaKey;
	if (ev.key === "Enter" && state.pendingWire && state.pendingWire.pts) {
		finishWireInSpace();   // end the wire in open space (free bus stub)
		ev.preventDefault();
	} else if (ev.key === "Backspace" && state.pendingWire && state.pendingWire.pts && state.pendingWire.pts.length) {
		state.pendingWire.pts.pop();   // undo the last corner while drawing
		render(); ev.preventDefault();
	} else if (ev.key === "Delete" || ev.key === "Backspace") {
		if (state.selection.size) { deleteSelection(); ev.preventDefault(); }
	} else if (ev.key === "Escape") {
		if (state.pendingWire) {
			// 1st Esc: cancel only the wire being drawn — keep the tool & selection
			state.pendingWire = null; state.wireDrag = null;
			healJunctions(); render();
		} else {
			// 2nd Esc: clear selection and return to the select tool (ISE behaviour)
			state.wireDrag = null; state.selection.clear();
			healJunctions();
			setTool("select", true);
			renderInspector();
		}
	} else if (!ctl && (code === "KeyW" || k === "w")) { setTool("wire"); ev.preventDefault(); }
	/* BUS DISABLED (commented out): else if(!ctl && (code==="KeyB" || k==="b")){ setTool("bus"); ev.preventDefault(); } */
	else if (!ctl && (code === "KeyN" || k === "n")) { setTool("netname"); ev.preventDefault(); }
	else if (!ctl && (code === "KeyI" || k === "i")) { setTool("iomarker"); ev.preventDefault(); }
	else if (!ctl && (code === "KeyR" || k === "r")) { rotateSelection(ev.shiftKey ? -1 : 1); ev.preventDefault(); }
	else if (!ctl && (code === "KeyM" || k === "m")) { mirrorSelection(); ev.preventDefault(); }
	else if (ctl && (code === "KeyZ" || k === "z")) {
		if (ev.shiftKey) redo(); else undo(); ev.preventDefault();
	} else if (ctl && (code === "KeyY" || k === "y")) { redo(); ev.preventDefault(); }
	else if (ctl && (code === "KeyA" || k === "a")) {   // select EVERYTHING on the sheet
		const sch = activeSch();
		state.selection = new Set([...sch.components.map(c => c.id), ...sch.wires.map(w => w.id)]);
		render(); renderInspector(); ev.preventDefault();
	}
	else if (ctl && (code === "KeyD" || k === "d")) { duplicateSelection(); ev.preventDefault(); }
	else if (ctl && (code === "KeyC" || k === "c")) { copySelection(); ev.preventDefault(); }
	else if (ctl && (code === "KeyV" || k === "v")) { pasteClipboard(); ev.preventDefault(); }
	else if (ctl && (code === "KeyX" || k === "x")) { copySelection(); deleteSelection(); ev.preventDefault(); }
	else if (ctl && (code === "KeyS" || k === "s")) { saveProjectToFile(); ev.preventDefault(); }
	else if (ctl && (code === "KeyO" || k === "o")) { openProjectFromFile(); ev.preventDefault(); }
	else if (ctl && (code === "KeyN" || k === "n")) { newProject(); ev.preventDefault(); }
	else if (code === "Space") {
		// hold Space = grab-to-pan mode (like design tools)
		if (!state.spaceDown) { state.spaceDown = true; if (!state.pan) canvas.style.cursor = "grab"; }
		ev.preventDefault();
	}
	else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key)) {
		const dx = ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowRight" ? 1 : 0;
		const dy = ev.key === "ArrowUp" ? -1 : ev.key === "ArrowDown" ? 1 : 0;
		const selComps = Array.from(state.selection).map(id => comp(id)).filter(Boolean);
		if (selComps.length) {
			// nudge selected components one grid step (a junction snaps by its DOT, which
			// sits at box+6 — snapping the box would drift it half a grid off the lines)
			selComps.forEach(c => {
				const q = c.type === "JUNCTION" ? 6 : 0;
				c.x = snap(c.x + q + dx * GRID) - q;
				c.y = snap(c.y + q + dy * GRID) - q;
			});
			// same pact as the mouse drag: a dot the user placed is theirs, so healLayout
			// below must not re-tap it back (it would silently undo the nudge). Only when
			// dots are what's selected — nudging a mixed block isn't aiming at its dots.
			if (selComps.every(c => c.type === "JUNCTION"))
				selComps.forEach(c => { (c.params || (c.params = {})).fixed = true; });
			healLayout();   // keep branch squares at the divergence point (heal runs last)
			snapshot(); render();
		} else {
			// nothing selected → pan the view
			state.view.x -= dx * 60;
			state.view.y -= dy * 60;
			render();
		}
		ev.preventDefault();
	}
	else if (ev.key === "Home") { zoomFit(); ev.preventDefault(); }
	else if (ev.key === "F7") { runSynthesis(); ev.preventDefault(); }
});
window.addEventListener("keyup", ev => {
	if (ev.code === "Space") {
		state.spaceDown = false;
		if (!state.pan) canvas.style.cursor = TOOL_INFO[state.tool]?.cur || "";
	}
});
window.addEventListener("blur", () => { state.spaceDown = false; if (!state.pan) canvas.style.cursor = TOOL_INFO[state.tool]?.cur || ""; });

/* canvas drag-drop from palette */
canvas.addEventListener("dragover", ev => ev.preventDefault());
canvas.addEventListener("drop", ev => {
	ev.preventDefault();
	const t = state.dragType || (ev.dataTransfer && ev.dataTransfer.getData("text/plain"));
	if (t) {
		const m = svgPoint(ev);
		const id = addComp(t, m.x - 20, m.y - 15);
		const nc = id && comp(id);
		if (nc && busInPin(nc) && attachBusPinToWire(nc))
			toast("เกาะสายบัสให้อัตโนมัติแล้ว — ปรับ slice ได้ใน Inspector", "ok", 2600);
	}
	state.dragType = null;
});
// clear the pending palette type when a drag ends anywhere but the canvas,
// so a stale value never spawns a phantom component later
document.addEventListener("dragend", () => { state.dragType = null; });

/* =========================================================================
   INSPECTOR PANEL
   ========================================================================= */
function openInspectorFor(c) {
	state.selection = new Set([c.id]);
	// also switch to inspector tab
	setRightTab("inspector");
	render(); renderInspector();
}
function renderInspector() {
	const root = $("#inspectorPane");
	const sch = activeSch();
	if (!sch) { root.innerHTML = ""; return; }

	if (state.selection.size === 0) {
		root.innerHTML = `<div class="insp">
      <h3>Schematic Properties</h3>
      <div class="row"><label>Name</label><input id="iSchName" value="${esc(sch.name)}"></div>
      <div class="row"><label>Top entity</label>
        <select id="iTopSel">
          ${Object.keys(state.project.schematics).map(id =>
			`<option value="${id}" ${id === state.project.topId ? "selected" : ""}>${esc(state.project.schematics[id].name)}</option>`
		).join("")}
        </select>
      </div>
      <div class="empty">เลือก component หรือ wire เพื่อปรับ properties</div>
    </div>`;
		$("#iSchName").addEventListener("change", ev => {
			sch.name = uniqueSchName(ev.target.value, sch.id); snapshot(); renderAll();
		});
		$("#iTopSel").addEventListener("change", ev => {
			state.project.topId = ev.target.value; snapshot(); renderAll();
			toast("ตั้งเป็น top entity: " + state.project.schematics[ev.target.value].name, "ok");
		});
		return;
	}

	// single component
	if (state.selection.size === 1) {
		const id = Array.from(state.selection)[0];
		const c = comp(id);
		if (c && c.type === "JUNCTION" && c.params && c.params.busWidth) {
			// bus label (definition node) — edit its name; width is editable only
			// when the net has NO source (otherwise it's inherited from the driver)
			const driven = sch.wires.some(x => x.to.cid === c.id);
			const jw = sch.wires.find(x => x.from.cid === c.id || x.to.cid === c.id);
			const eff = jw ? netWidth(jw, sch) : c.params.busWidth;
			const widthRow = driven
				? `<div class="row"><label>ความกว้าง (bit)</label><span style="color:var(--muted)">${eff} bit (จาก source)</span></div>`
				: `<div class="row"><label>ความกว้าง (bit)</label><input type="number" id="iBusW" min="2" max="64" value="${c.params.busWidth}"></div>`;
			// bit map of the net: which bits are already tapped
			const used = jw ? tappedBitsOnNet(jw, sch) : new Set();
			const chips = Array.from({ length: eff }, (_, b) =>
				`<span style="display:inline-block;min-width:16px;text-align:center;margin:1px;padding:1px 2px;border-radius:3px;font-size:10px;font-family:monospace;${used.has(b) ? "background:var(--wire-bus);color:#000" : "background:var(--bg-1);color:var(--muted)"}">${b}</span>`
			).reverse().join("");
			root.innerHTML = `<div class="insp">
        <h3>ป้ายชื่อบัส <span style="color:var(--wire-bus)">(${eff - 1}:0)</span></h3>
        <div class="row"><label>Position</label>
          <span><input style="width:62px" id="iX" value="${c.x}"> <input style="width:62px" id="iY" value="${c.y}"></span></div>
        <div class="row"><label>ชื่อบัส</label><input id="iBusName" value="${esc(c.params.busName || "bus")}"></div>
        ${widthRow}
        <div class="row"><label>บิตที่ดึงแล้ว</label><span>${chips}</span></div>
        <div class="row"><label></label><button class="btn" id="iBusTapNext" ${jw && eff > 1 ? "" : "disabled"}>▷ ดึงบิตถัดไป (Bus Tap)</button></div>
        <div class="row"><label></label><button class="btn" data-act="delete-sel">🗑 Delete</button></div>
        <div style="padding:4px 2px;font-size:11px;color:var(--muted)">${driven ? "บัสนี้มี source แล้ว — คลิกสายด้วยเครื่องมือ ≣ เพื่อดึงบิต" : "บัสลอย (ยังไม่มี source) — ดึงบิตได้เลย แล้วค่อยต่อ source ทีหลัง"}</div>
      </div>`;
			$("#iX").addEventListener("change", ev => { c.x = snap(+ev.target.value || 0); snapshot(); render(); renderInspector(); });
			$("#iY").addEventListener("change", ev => { c.y = snap(+ev.target.value || 0); snapshot(); render(); renderInspector(); });
			$("#iBusName").addEventListener("change", ev => {
				let v = sanId(ev.target.value) || "bus";
				const used2 = new Set(sch.components
					.filter(x => x.type === "JUNCTION" && x.id !== c.id && x.params && x.params.busName)
					.map(x => sanId(x.params.busName)));
				const base = v; let k = 1; while (used2.has(v)) v = base + "_" + (k++);
				if (v !== base) toast(`ชื่อ '${base}' ถูกใช้แล้ว → เปลี่ยนเป็น '${v}'`, "warn");
				c.params.busName = v; snapshot(); render(); renderInspector();
			});
			if ($("#iBusW")) $("#iBusW").addEventListener("change", ev => {
				const nv = clamp(Math.round(+ev.target.value) || 8, 2, 64);
				c.params.busWidth = nv; snapshot(); render(); renderInspector();
			});
			if ($("#iBusTapNext")) $("#iBusTapNext").addEventListener("click", () => {
				if (!jw) return;
				// stamp at the midpoint of the attached wire segment
				const a = comp(jw.from.cid, sch), b = comp(jw.to.cid, sch);
				const p1 = a && portPos(a, jw.from.pid), p2 = b && portPos(b, jw.to.pid);
				if (!p1 || !p2) return;
				const sel = new Set(state.selection);
				if (stampTapOnWire(jw, { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 })) {
					state.selection = sel;   // keep the label selected so the panel refreshes
					render(); renderInspector();
				}
			});
			return;
		}
		if (c && c.type === "BUSTAP") {
			// dedicated Bus Tap panel: live context of the tapped bus + clamped bits
			const dw = sch.wires.find(x => x.to.cid === c.id && x.to.pid === "d");
			const sw = dw ? netWidth(dw, sch) : 0;              // attached bus width (0 = detached)
			const hi = Math.max(c.params.hi ?? 0, c.params.lo ?? 0);
			const lo = Math.min(c.params.hi ?? 0, c.params.lo ?? 0);
			const outOfRange = sw > 1 && hi > sw - 1;
			const srcTxt = sw > 1 ? `บัสกว้าง ${sw} bit (${sw - 1}:0)` : (dw ? "สายที่เกาะไม่ใช่บัส!" : "ยังไม่ได้เกาะบัส!");
			const slice = hi === lo ? `(${hi})` : `(${hi}:${lo})`;
			const dirOpt = d => `<option value="${d}" ${(c.params.dir || "right") === d ? "selected" : ""}>${d}</option>`;
			root.innerHTML = `<div class="insp">
        <h3>Bus Tap <span style="color:${outOfRange || sw <= 1 ? "var(--err,#f66)" : "var(--wire-bus)"}">${slice}</span></h3>
        <div class="row"><label>Position</label>
          <span><input style="width:62px" id="iX" value="${c.x}"> <input style="width:62px" id="iY" value="${c.y}"></span></div>
        <div class="row"><label>ต้นทาง</label><span style="color:${sw > 1 ? "var(--muted)" : "var(--err,#f66)"}">${srcTxt}</span></div>
        <div class="row"><label>บิตบน (hi)</label><input type="number" id="iTapHi" min="0" max="${sw > 1 ? sw - 1 : 63}" value="${c.params.hi ?? 0}"></div>
        <div class="row"><label>บิตล่าง (lo)</label><input type="number" id="iTapLo" min="0" max="${sw > 1 ? sw - 1 : 63}" value="${c.params.lo ?? 0}"></div>
        <div class="row"><label>ทิศทาง</label><select id="iTapDir">${["right", "down", "left", "up"].map(dirOpt).join("")}</select></div>
        <div class="row"><label>ผลลัพธ์</label><span style="font-family:monospace;color:${outOfRange ? "var(--err,#f66)" : "var(--wire-bus)"}">y ⇐ บัส${slice}${outOfRange ? ` — เกินช่วง (${sw - 1}:0)!` : ""}</span></div>
        <div class="row"><label></label><button class="btn" data-act="delete-sel">🗑 Delete</button></div>
        <div style="padding:4px 2px;font-size:11px;color:var(--muted)">hi = lo → ดึงบิตเดียว · hi > lo → ดึงช่วงเป็นบัสย่อย</div>
      </div>`;
			$("#iX").addEventListener("change", ev => { c.x = snap(+ev.target.value || 0); snapshot(); render(); renderInspector(); });
			$("#iY").addEventListener("change", ev => { c.y = snap(+ev.target.value || 0); snapshot(); render(); renderInspector(); });
			const clampBit = v => clamp(Math.round(+v) || 0, 0, sw > 1 ? sw - 1 : 63);
			$("#iTapHi").addEventListener("change", ev => { c.params.hi = clampBit(ev.target.value); snapshot(); render(); renderInspector(); });
			$("#iTapLo").addEventListener("change", ev => { c.params.lo = clampBit(ev.target.value); snapshot(); render(); renderInspector(); });
			$("#iTapDir").addEventListener("change", ev => {
				// keep the d pin ON its junction when the orientation flips
				const oldPorts = TYPES.BUSTAP.ports(c.params);
				const oldD = oldPorts.find(p => p.id === "d");
				const ax = c.x + oldD.dx, ay = c.y + oldD.dy;   // absolute d position
				c.params.dir = ev.target.value;
				const newD = TYPES.BUSTAP.ports(c.params).find(p => p.id === "d");
				c.x = ax - newD.dx; c.y = ay - newD.dy;
				snapshot(); render(); renderInspector();
			});
			return;
		}
		if (c) {
			const td = typeDef(c);
			const schema = td && td.paramSchema || [];
			let html = `<div class="insp"><h3>${esc(td ? td.label : c.type)} <span style="font-size:11px;color:var(--muted);font-weight:normal">${esc(c.id)}</span></h3>`;
			html += `<div class="row"><label>Position</label>
        <span><input style="width:62px" id="iX" value="${c.x}"> <input style="width:62px" id="iY" value="${c.y}"></span></div>`;
			schema.forEach(f => {
				const v = (c.params || {})[f.key];
				if (f.type === "string") {
					html += `<div class="row"><label>${esc(f.label)}</label><input data-pk="${f.key}" value="${esc(v || "")}" placeholder="${esc(f.placeholder || "")}"></div>`;
				} else if (f.type === "int") {
					html += `<div class="row"><label>${esc(f.label)}</label><input type="number" data-pk="${f.key}" min="${f.min ?? 1}" max="${f.max ?? 64}" value="${v}"></div>`;
				} else if (f.type === "bool") {
					html += `<div class="row"><label>${esc(f.label)}</label><input type="checkbox" data-pk="${f.key}" ${v ? "checked" : ""}></div>`;
				} else if (f.type === "select") {
					html += `<div class="row"><label>${esc(f.label)}</label><select data-pk="${f.key}">
            ${f.options.map(o => `<option value="${o}" ${o == v ? "selected" : ""}>${o}</option>`).join("")}
          </select></div>`;
				}
			});
			if (orientable(c)) html += `<div class="row"><label>ทิศทาง</label><span style="display:flex;gap:4px">
        <button class="btn" id="iRotate" title="หมุน 90° (R · Shift+R = ทวนเข็ม)">↻ หมุน</button>
        <button class="btn" id="iMirror" title="พลิกซ้าย-ขวา (M)">⇋ พลิก</button></span></div>`;
			html += `<div class="row"><label></label><button class="btn" data-act="delete-sel">🗑 Delete</button></div>`;
			html += `</div>`;
			root.innerHTML = html;
			$("#iX").addEventListener("change", ev => { c.x = snap(+ev.target.value || 0); snapshot(); render(); renderInspector(); });
			$("#iY").addEventListener("change", ev => { c.y = snap(+ev.target.value || 0); snapshot(); render(); renderInspector(); });
			if ($("#iRotate")) $("#iRotate").addEventListener("click", () => rotateSelection(1));
			if ($("#iMirror")) $("#iMirror").addEventListener("click", () => mirrorSelection());
			root.querySelectorAll("[data-pk]").forEach(e => {
				e.addEventListener("change", ev => {
					const k = e.dataset.pk;
					const f = schema.find(s => s.key === k) || {};
					let v = e.type === "checkbox" ? e.checked
						: e.type === "number" ? (() => {        // 0 is a legal value (e.g. TAP lo=0) — no || here
							const mn = f.min ?? 1, mx = f.max ?? 64;
							const nv = e.value.trim() === "" ? NaN : Math.round(+e.value);
							return clamp(Number.isFinite(nv) ? nv : mn, mn, mx);
						})()
							: e.tagName === "SELECT" && /^\d+$/.test(e.value) ? +e.value
								: e.value;
					if (k === "name") {
						v = sanId(v);
						// keep IN/OUT pin names unique inside the schematic (they become VHDL ports)
						if (c.type === "IN" || c.type === "OUT") {
							const used = new Set(sch.components.filter(x => x.type === c.type && x.id !== c.id).map(x => x.params.name));
							const base = v; let kk = 1;
							while (used.has(v)) v = base + "_" + (kk++);
							if (v !== base) toast(`ชื่อ '${base}' ถูกใช้แล้ว → เปลี่ยนเป็น '${v}'`, "warn");
						}
					}
					c.params = c.params || {};
					c.params[k] = v;
					// ports may have changed (count/width): drop wires to vanished pins
					sch.wires = sch.wires.filter(w => {
						const a = comp(w.from.cid), b = comp(w.to.cid);
						return a && b && getPort(a, w.from.pid) && getPort(b, w.to.pid);
					});
					// wire widths are derived live (netWidth) — nothing to refresh
					snapshot(); render(); renderInspector();
				});
			});
			return;
		}
		// wire?
		const w = sch.wires.find(x => x.id === id);
		if (w) {
			const hasCustomRoute = (typeof w.mx === "number") || (typeof w.my === "number") || !!(w.pts && w.pts.length);
			const nw = netWidth(w, sch);
			root.innerHTML = `<div class="insp">
        <h3>Wire ${nw > 1 ? `<span style="color:var(--wire-bus)">bus (${nw - 1}:0)</span>` : ""}</h3>
        <div class="row"><label>Net name</label><input id="iWireName" value="${esc(w.name || "")}" placeholder="เช่น data หรือ data(7:0)"></div>
        <div class="row"><label>เส้นทาง</label><button class="btn" id="iWireRoute" ${hasCustomRoute ? "" : "disabled"} title="ลบตำแหน่งที่ลากไว้ ให้ระบบจัดแนวเอง">↺ จัดแนวอัตโนมัติ</button></div>
        <div class="row"><label></label><button class="btn" data-act="delete-sel">🗑 Delete</button></div>
        <div style="padding:4px 2px;font-size:11px;color:var(--muted)">${nw > 1 ? "สายบัส — ใช้เครื่องมือ ≣ (หรือคลิกขวา) คลิกสายเพื่อดึงบิต · หรือลาก Bus Ripper มาวางบนสาย" : "ลากที่ตัวสายเพื่อเลื่อนแนวท่อนกลางได้ · บัสต้องลากจากพอร์ต >1 bit ของ component (ตั้งชื่อบัสได้แต่ความกว้างมาจากต้นทาง)"}</div>
      </div>`;
			$("#iWireName").addEventListener("change", ev => { applyWireName(w, ev.target.value); });
			$("#iWireRoute").addEventListener("click", () => {
				delete w.mx; delete w.my; delete w.pts;
				snapshot(); render(); renderInspector();
				toast("จัดแนวสายอัตโนมัติแล้ว", "ok");
			});
			return;
		}
	}
	root.innerHTML = `<div class="insp"><div class="empty">${state.selection.size} items selected</div>
    <div style="display:flex;gap:6px;padding:0 12px"><button class="btn" data-act="duplicate">⎘ Duplicate</button><button class="btn" data-act="delete-sel">🗑 Delete</button></div></div>`;
}

/* =========================================================================
   ZOOM / VIEW
   ========================================================================= */
function zoomBy(f) {
	// zoom around the viewport centre so panned content stays in view
	const r = canvas.getBoundingClientRect();
	const cx = r.width / 2, cy = r.height / 2;
	const k0 = state.view.k;
	const k1 = clamp(k0 * f, 0.3, 3);
	state.view.x = cx - (cx - state.view.x) * (k1 / k0);
	state.view.y = cy - (cy - state.view.y) * (k1 / k0);
	state.view.k = k1;
	render();
}
function zoom100() { state.view = { x: 0, y: 0, k: 1 }; render(); }
function zoomFit() {
	const sch = activeSch(); if (!sch || !sch.components.length) { zoom100(); return; }
	let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
	sch.components.forEach(c => {
		const sz = getSize(c);
		minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
		maxX = Math.max(maxX, c.x + sz.w); maxY = Math.max(maxY, c.y + sz.h);
	});
	const r = canvas.getBoundingClientRect();
	const pad = 80;
	const kx = (r.width - pad * 2) / (maxX - minX);
	const ky = (r.height - pad * 2) / (maxY - minY);
	const k = clamp(Math.min(kx, ky), 0.3, 2);
	state.view.k = k;
	state.view.x = pad - minX * k + (r.width - pad * 2 - (maxX - minX) * k) / 2;
	state.view.y = pad - minY * k + (r.height - pad * 2 - (maxY - minY) * k) / 2;
	render();
}

/* =========================================================================
   SYNTHESIS CHECK
   ========================================================================= */
/* human-readable component reference for error messages */
function compDisplay(c) {
	if (c.type === "IN") return `INPUT '${c.params.name}'`;
	if (c.type === "OUT") return `OUTPUT '${c.params.name}'`;
	const td = typeDef(c);
	return `${td ? td.label : c.type} (${c.x}, ${c.y})`;
}
/* open the schematic, select the component and centre the view on it */
function focusComp(schId, cid) {
	if (!state.project.schematics[schId]) return;
	openSchTab(schId);
	const c = comp(cid);
	if (!c) return;
	state.selection = new Set([cid]);
	const r = canvas.getBoundingClientRect();
	const sz = getSize(c);
	state.view.x = r.width / 2 - (c.x + sz.w / 2) * state.view.k;
	state.view.y = r.height / 2 - (c.y + sz.h / 2) * state.view.k;
	render(); renderInspector();
}
function runSynthesis() {
	const issues = [];
	const top = state.project.schematics[state.project.topId];
	if (!top) { issues.push({ lvl: "err", msg: "ไม่มี top entity" }); }
	if (top && top.components.filter(c => c.type === "IN").length === 0)
		issues.push({ lvl: "warn", msg: "top entity ไม่มี INPUT pin", ref: top.name });
	if (top && top.components.filter(c => c.type === "OUT").length === 0)
		issues.push({ lvl: "warn", msg: "top entity ไม่มี OUTPUT pin", ref: top.name });

	Object.values(state.project.schematics).forEach(sch => {
		// duplicate IN/OUT names
		const inN = new Map(), outN = new Map();
		sch.components.forEach(c => {
			if (c.type === "IN") {
				const n = c.params.name;
				if (inN.has(n)) issues.push({ lvl: "err", msg: `INPUT '${n}' ชื่อซ้ำ`, ref: sch.name, schId: sch.id, cid: c.id });
				inN.set(n, c);
			} else if (c.type === "OUT") {
				const n = c.params.name;
				if (outN.has(n)) issues.push({ lvl: "err", msg: `OUTPUT '${n}' ชื่อซ้ำ`, ref: sch.name, schId: sch.id, cid: c.id });
				outN.set(n, c);
			}
		});
		// unconnected inputs
		sch.components.forEach(c => {
			const td = typeDef(c); if (!td) return;
			td.ports(c.params || {}).forEach(p => {
				if (p.dir === "in") {
					const has = sch.wires.some(w => w.to.cid === c.id && w.to.pid === p.id);
					if (!has && c.type !== "OUT" && c.type !== "GND") {
						issues.push({ lvl: "warn", msg: `${compDisplay(c)} ขา '${p.id}' ยังไม่ได้ต่อสาย`, ref: sch.name, schId: sch.id, cid: c.id });
					} else if (!has && c.type === "OUT") {
						issues.push({ lvl: "err", msg: `${compDisplay(c)} ยังไม่ได้ต่อสาย`, ref: sch.name, schId: sch.id, cid: c.id });
					}
				}
			});
		});
		// multiple drivers on a net (input with >1 incoming wire).
		// A junction may fan OUT freely but accepts only ONE incoming wire —
		// more than one means two drivers shorted on the same net.
		const driven = new Map();
		sch.wires.forEach(w => {
			const k = w.to.cid + "." + w.to.pid;
			driven.set(k, (driven.get(k) || 0) + 1);
		});
		driven.forEach((n, k) => {
			if (n > 1) {
				const [cid, pid] = k.split(".");
				const c = sch.components.find(x => x.id === cid);
				const isJ = c && c.type === "JUNCTION";
				issues.push({
					lvl: "err",
					msg: isJ ? `จุดแยกสาย (junction) มีสายเข้าซ้อนกัน ${n} เส้น — driver ชนกันบน net เดียว`
						: `${c ? compDisplay(c) : k} ขา '${pid}' มีสายเข้าซ้อนกัน ${n} เส้น (multi-driver)`,
					ref: sch.name, schId: sch.id, cid
				});
			}
		});
		// bus width mismatch — every consuming port must receive a signal of its
		// own width. Junctions are width-transparent, so trace back through them
		// to the real driving port; mismatches across a junction are caught too.
		const traceSrc = (w, visited) => {
			visited = visited || new Set();
			const fc = comp(w.from.cid, sch);
			if (!fc) return null;
			if (fc.type !== "JUNCTION") {
				const fp = getPort(fc, w.from.pid);
				return fp ? { c: fc, w: fp.width || 1 } : null;
			}
			if (visited.has(fc.id)) return null;
			visited.add(fc.id);
			const up = sch.wires.find(x => x.to.cid === fc.id);
			if (up) return traceSrc(up, visited);
			if (fc.params && fc.params.busWidth) return { c: fc, w: fc.params.busWidth };  // floating bus
			return null;
		};
		sch.wires.forEach(w => {
			const tc = comp(w.to.cid, sch);
			if (!tc || tc.type === "JUNCTION") return;   // validate at consuming ports
			const tp = getPort(tc, w.to.pid);
			if (!tp) return;
			const src = traceSrc(w);
			if (!src) return;
			const fw = src.w, tw = tp.width || 1;
			// BUS TAP's d pin accepts a bus of ANY width — validate bus-ness + range
			if (tc.type === "BUSTAP" && tp.id === "d") {
				const hi = Math.max(tc.params.hi ?? 0, tc.params.lo ?? 0);
				if (fw < 2) issues.push({
					lvl: "err",
					msg: `Bus Tap ต้องเกาะกับสายบัส (กว้าง > 1 bit) แต่ต่อกับ ${compDisplay(src.c)} (${fw} bit)`, ref: sch.name, schId: sch.id, cid: tc.id
				});
				else if (hi > fw - 1) issues.push({
					lvl: "err",
					msg: `Bus Tap เลือกบิต (${hi}) แต่บัสมีช่วงแค่ (${fw - 1}:0)`, ref: sch.name, schId: sch.id, cid: tc.id
				});
				return;
			}
			if (fw !== tw) {
				issues.push({
					lvl: "err",
					msg: `สายเชื่อม ${compDisplay(src.c)} (${fw} bit) เข้ากับ ${compDisplay(tc)} (${tw} bit) — ความกว้างบัสไม่ตรงกัน`,
					ref: sch.name, schId: sch.id, cid: tc.id
				});
			}
		});
	});
	renderErrors(issues);
	setRightTab("errors");
	if (issues.filter(i => i.lvl === "err").length === 0) {
		toast("Synthesis check ผ่าน ✓", "ok");
	} else {
		toast("พบ error — คลิกรายการใน Issues เพื่อไปยังจุดที่มีปัญหา", "err");
	}
	return issues;
}
function renderErrors(list) {
	const root = $("#errorsPane");
	if (!list || !list.length) {
		root.innerHTML = `<div class="err-empty">✓ ไม่พบปัญหา — schematic พร้อมสำหรับ Vivado</div>`;
		return;
	}
	const html = [`<div class="err-list">`];
	list.forEach((i, idx) => {
		const lvl = i.lvl === "err" ? "" : i.lvl === "warn" ? "warn" : "info";
		const ico = i.lvl === "err" ? "✕" : i.lvl === "warn" ? "⚠" : "ℹ";
		const jump = i.schId && i.cid ? `data-jump="${idx}" style="cursor:pointer" title="คลิกเพื่อไปยังตำแหน่ง"` : "";
		html.push(`<div class="err-item ${lvl}" ${jump}>
      <span class="ico">${ico}</span>
      <div class="msg">${esc(i.msg)}${i.ref ? `<div class="ref">ใน ${esc(i.ref)}</div>` : ""}</div>
    </div>`);
	});
	html.push(`</div>`);
	root.innerHTML = html.join("");
	root.querySelectorAll("[data-jump]").forEach(e => e.addEventListener("click", () => {
		const i = list[+e.dataset.jump];
		if (i && i.schId && i.cid) focusComp(i.schId, i.cid);
	}));
}

/* =========================================================================
   VHDL GENERATION
   ========================================================================= */
/* Walk top schematic recursively and collect every entity it depends on
   (sub-schematics and custom components). Returns a Set of keys like
   "sch:<name>" and "custom:<name>". The top is always included. */
function collectReachable() {
	const seen = new Set();
	const top = state.project.schematics[state.project.topId];
	if (!top) return seen;
	function walkComps(components) {
		(components || []).forEach(c => {
			const t = c.type || "";
			if (t.startsWith("CUSTOM:")) {
				const n = t.slice(7);
				const key = "custom:" + n;
				if (seen.has(key)) return;
				seen.add(key);
				const cc = state.project.customs[n];
				if (cc && cc.schematic) walkComps(cc.schematic.components);
			} else if (t.startsWith("SCH:")) {
				const id = t.slice(4);
				const sub = state.project.schematics[id];
				if (!sub) return;
				const key = "sch:" + sub.name;
				if (seen.has(key)) return;
				seen.add(key);
				walkComps(sub.components);
			}
		});
	}
	seen.add("sch:" + top.name);
	walkComps(top.components);
	return seen;
}

function generateAllVhdl() {
	const out = {};
	const reach = collectReachable();
	// two design units whose names sanId to the SAME entity identifier would emit two
	// `entity foo is` in one bundle (won't compile) — and, worse, a custom keyed by the
	// same display name used to silently OVERWRITE the schematic's entry (one entity
	// vanished). Track claimed entity names, never clobber an out key, and warn.
	const entOwner = new Map();
	const clashWarn = disp => {
		const e = sanId(disp);
		if (entOwner.has(e) && entOwner.get(e) !== disp)
			return `ชื่อ entity '${e}' ซ้ำกับ '${entOwner.get(e)}' — VHDL จะ compile ไม่ผ่าน (เปลี่ยนชื่อ block ให้ไม่ซ้ำ)`;
		entOwner.set(e, disp); return null;
	};
	const stash = (disp, r) => {
		const cw = clashWarn(disp);
		if (cw && r && Array.isArray(r.warns)) r.warns.push(cw);
		let key = disp; while (out[key] !== undefined) key += "*";   // never drop an entity
		out[key] = r;
	};
	// top schematic + any sub-schematics referenced
	Object.values(state.project.schematics).forEach(sch => {
		if (reach.has("sch:" + sch.name)) stash(sch.name, generateSchVhdl(sch));
	});
	// only customs actually used somewhere below top
	Object.values(state.project.customs).forEach(cc => {
		if (!reach.has("custom:" + cc.name)) return;
		if (cc.schematic) {
			const fakeSch = {
				id: "cc_" + cc.name, name: sanId(cc.name),
				components: cc.schematic.components || [],
				wires: cc.schematic.wires || []
			};
			stash(cc.name, generateSchVhdl(fakeSch));
		} else if (cc.vhdl) {
			stash(cc.name, cc.vhdl);
		}
	});
	return out;
}

function generateSchVhdl(sch) {
	const warns = [];
	const ename = sanId(sch.name) || "my_circuit";

	const inputs = sch.components.filter(c => c.type === "IN");
	const outputs = sch.components.filter(c => c.type === "OUT");
	const inners = sch.components.filter(c => !["IN", "OUT", "VCC", "GND"].includes(c.type));

	// assign net names
	const used = {};
	function uniq(b) { let n = sanId(b) || "net", i = 1; while (used[n]) n = sanId(b) + "_" + (i++); used[n] = 1; return n; }
	inputs.forEach(c => { c._net = uniq(c.params.name || "in"); });
	outputs.forEach(c => { c._net = uniq(c.params.name || "out"); });
	inners.forEach((c, i) => {
		// every output port gets a signal (width recorded for the declaration)
		const td = typeDef(c);
		if (!td) { warns.push("Unknown type " + c.type); return; }
		c._nets = {};
		c._netW = {};
		if (c.type === "JUNCTION") {
			delete c._busSig; delete c._busW;  // never reuse stale scratch from a prior run
			// a floating-bus definition node (no upstream driver) becomes its own signal
			if (c.params && c.params.busName && c.params.busWidth && !sch.wires.some(x => x.to.cid === c.id)) {
				c._busSig = uniq(c.params.busName);
				c._busW = c.params.busWidth;
				warns.push(`บัส '${c._busSig}' ยังไม่มี source — สัญญาณจะไม่ถูก drive (ต่อ source ก่อนใช้งานจริง)`);
			}
			return;                           // otherwise transparent — no signal allocation
		}
		td.ports(c.params || {}).forEach(p => {
			if (p.dir === "out") {
				c._nets[p.id] = uniq(`n${i + 1}_${p.id}`);
				c._netW[p.id] = p.width || 1;
			}
		});
	});

	// explicit wire names override — via uniq() so a duplicate name or a name
	// colliding with a port never produces two identical signal declarations
	const renamedPorts = new Set();
	sch.wires.forEach(w => {
		if (!w.name) return;
		const src = comp(w.from.cid, sch);
		if (!src) return;
		if (src.type === "IN") { /* skip, source is the input itself */ }
		else if (src._nets && src._nets[w.from.pid]) {
			const key = w.from.cid + "." + w.from.pid;
			if (renamedPorts.has(key)) return;   // rename each source port once only
			renamedPorts.add(key);
			src._nets[w.from.pid] = uniq(w.name);
		}
	});

	// width-aware zero literal
	const zlit = w => (w || 1) > 1 ? "(others => '0')" : "STD_LOGIC'('0')";

	function driver(cid, pid, visited) {
		visited = visited || new Set();
		const k = cid + "." + pid;
		if (visited.has(k)) return null;            // protect against loops
		visited.add(k);
		const w = sch.wires.find(w => w.to.cid === cid && w.to.pid === pid);
		if (!w) return null;
		const src = comp(w.from.cid, sch);
		if (!src) return null;
		if (src.type === "IN") return src._net;
		if (src.type === "VCC") return "STD_LOGIC'('1')";
		if (src.type === "GND") return "STD_LOGIC'('0')";
		if (src.type === "JUNCTION") {
			if (src._busSig) return src._busSig;                            // floating named bus
			return driver(src.id, "j", visited);                          // transparent
		}
		if (src._nets) return src._nets[w.from.pid] || null;
		return null;
	}
	// width of the ultimate driving port (traces through junctions) — used to
	// reject indexing a scalar as if it were a bus
	function driverWidth(cid, pid, visited) {
		visited = visited || new Set();
		const k = cid + "." + pid;
		if (visited.has(k)) return null;
		visited.add(k);
		const w = sch.wires.find(w => w.to.cid === cid && w.to.pid === pid);
		if (!w) return null;
		const src = comp(w.from.cid, sch);
		if (!src) return null;
		if (src.type === "JUNCTION") {
			if (src._busW) return src._busW;                               // floating named bus
			return driverWidth(src.id, "j", visited);
		}
		const sp = getPort(src, w.from.pid);
		return sp ? (sp.width || 1) : null;
	}
	const concurrent = [];
	const processes = [];
	const subInstances = [];

	inners.forEach(c => {
		const td = typeDef(c); if (!td) return;
		if (c.type === "JUNCTION") return;     // transparent — no VHDL statement
		const portsArr = td.ports(c.params || {});
		const inputsPorts = portsArr.filter(p => p.dir === "in");
		const driverFor = pid => {
			const v = driver(c.id, pid);
			if (!v) {
				const pw = (portsArr.find(p => p.id === pid) || {}).width || 1;
				warns.push(`${compDisplay(c)} ขา '${pid}' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน`);
				return zlit(pw);
			}
			return v;
		};

		/* ----- gates ----- */
		if (["AND", "OR", "NAND", "NOR", "XOR", "XNOR", "NOT", "BUF"].includes(c.type)) {
			const ins = inputsPorts.map(p => driverFor(p.id));
			concurrent.push(`  ${c._nets.o} <= ${TYPES[c.type].expr(ins)};`);
			return;
		}
		/* ----- MUX ----- */
		if (c.type === "MUX") {
			const n = c.params.inputs;
			const selW = Math.ceil(Math.log2(n));
			const dataIns = []; for (let i = 0; i < n; i++) dataIns.push(driverFor("d" + i));
			const selIns = []; for (let i = 0; i < selW; i++) selIns.push(driverFor("s" + i));
			// build: y <= dataIns[ to_integer(sel) ];
			const selExpr = selIns.length === 1 ? selIns[0]
				: selIns.slice().reverse().map(s => s).join(" & ");
			const condChain = [];
			for (let i = 0; i < n; i++) {
				const bits = i.toString(2).padStart(selW, "0");
				const cond = selIns.length === 1
					? `${selIns[0]} = '${bits}'`
					: `(${selIns.slice().reverse().map((s, k) => `${s} = '${bits[k]}'`).join(" and ")})`;
				condChain.push(`${dataIns[i]} when ${cond}`);
			}
			concurrent.push(`  ${c._nets.y} <= ${condChain.join(" else\n             ")} else '0';`);
			return;
		}
		/* ----- DEMUX ----- */
		if (c.type === "DEMUX") {
			const n = c.params.outputs;
			const selW = Math.ceil(Math.log2(n));
			const d = driverFor("d");
			const selIns = []; for (let i = 0; i < selW; i++) selIns.push(driverFor("s" + i));
			for (let i = 0; i < n; i++) {
				const bits = i.toString(2).padStart(selW, "0");
				const cond = selIns.length === 1
					? `${selIns[0]} = '${bits}'`
					: `(${selIns.slice().reverse().map((s, k) => `${s} = '${bits[k]}'`).join(" and ")})`;
				concurrent.push(`  ${c._nets["y" + i]} <= ${d} when ${cond} else '0';`);
			}
			return;
		}
		/* ----- BUS TAP (slice a hi:lo range off the attached bus) ----- */
		if (c.type === "BUSTAP") {
			const hi = Math.max(c.params.hi ?? 0, c.params.lo ?? 0);
			const lo = Math.min(c.params.hi ?? 0, c.params.lo ?? 0);
			const ow = hi - lo + 1;
			const src = driver(c.id, "d");
			const sw = driverWidth(c.id, "d");   // real bus width, traced live
			let expr = null;
			if (!src) {
				warns.push(`${compDisplay(c)} ยังไม่ได้เกาะกับสายบัส — ใช้ค่า '0' แทน`);
			} else if (!sw || sw <= 1) {
				warns.push(`${compDisplay(c)} ต้องเกาะกับสายบัส (กว้าง > 1 bit) แต่ได้สัญญาณ ${sw || 1} bit — ใช้ค่า '0' แทน`);
			} else if (hi > sw - 1) {
				warns.push(`${compDisplay(c)} เลือกบิต (${hi}${hi === lo ? "" : ":" + lo}) เกินช่วงบัสต้นทาง (${sw - 1}:0) — ใช้ค่า '0' แทน`);
			} else {
				expr = hi === lo ? `${src}(${hi})` : `${src}(${hi} downto ${lo})`;
			}
			concurrent.push(`  ${c._nets.y} <= ${expr || zlit(ow)};`);
			return;
		}
		/* ----- ENCODER (priority) ----- */
		if (c.type === "ENC") {
			const n = c.params.inputs;
			const ow = Math.ceil(Math.log2(n));
			const ins = []; for (let i = 0; i < n; i++) ins.push(driverFor("i" + i));
			// priority: highest index wins
			for (let b = 0; b < ow; b++) {
				// y_b = OR of i_k where bit b of k = 1, and no higher i is active
				const terms = [];
				for (let k = n - 1; k >= 0; k--) {
					if (((k >> b) & 1) === 1) {
						const higher = [];
						for (let m = k + 1; m < n; m++) higher.push(`not ${ins[m]}`);
						terms.push(higher.length ? `(${ins[k]} and ${higher.join(" and ")})` : ins[k]);
					}
				}
				concurrent.push(`  ${c._nets["y" + b]} <= ${terms.length ? terms.join(" or ") : "'0'"};`);
			}
			return;
		}
		/* ----- DECODER ----- */
		if (c.type === "DEC") {
			const n = c.params.outputs;
			const iw = Math.ceil(Math.log2(n));
			const a = []; for (let i = 0; i < iw; i++) a.push(driverFor("a" + i));
			const en = driverFor("en");
			for (let i = 0; i < n; i++) {
				const bits = i.toString(2).padStart(iw, "0");
				const cond = a.slice().reverse().map((s, k) => `${s} = '${bits[k]}'`).join(" and ");
				concurrent.push(`  ${c._nets["y" + i]} <= ${en} when (${cond}) else '0';`);
			}
			return;
		}
		/* ----- D-FF ----- */
		if (c.type === "DFF") {
			const D = driverFor("d");
			// clk must NEVER fall back to a literal: process('0') / rising_edge('0')
			// is not valid VHDL (rising_edge requires an actual signal, not a
			// constant). If clk isn't wired, skip this flip-flop instead of
			// emitting a literal into the sensitivity list.
			const CLK = driver(c.id, "clk");
			if (!CLK) { warns.push(`${compDisplay(c)} ขา 'clk' ยังไม่ได้ต่อสาย — ข้าม flip-flop นี้ในโค้ด (ต่อสัญญาณนาฬิกาก่อนสร้าง VHDL)`); return; }
			// unwired rst/pre must NOT reach the sensitivity list as a literal
			const RST = c.params.reset ? driver(c.id, "rst") : null;
			const PRE = c.params.preset ? driver(c.id, "pre") : null;
			if (c.params.reset && !RST) warns.push(`${compDisplay(c)} เปิด async reset แต่ขา rst ไม่ได้ต่อสาย — ข้าม reset ในโค้ด`);
			if (c.params.preset && !PRE) warns.push(`${compDisplay(c)} เปิด async preset แต่ขา pre ไม่ได้ต่อสาย — ข้าม preset ในโค้ด`);
			processes.push({
				clk: CLK, edge: c.params.edge,
				rst: RST, pre: PRE,
				body: `      ${c._nets.q}  <= ${D};\n      ${c._nets.qn} <= not (${D});`,
				rstAssign: `      ${c._nets.q}  <= '0';\n      ${c._nets.qn} <= '1';`,
				preAssign: `      ${c._nets.q}  <= '1';\n      ${c._nets.qn} <= '0';`,
			});
			return;
		}
		/* ----- JK-FF ----- */
		if (c.type === "JKFF") {
			const J = driverFor("j");
			const K = driverFor("k");
			const CLK = driver(c.id, "clk");
			if (!CLK) { warns.push(`${compDisplay(c)} ขา 'clk' ยังไม่ได้ต่อสาย — ข้าม flip-flop นี้ในโค้ด (ต่อสัญญาณนาฬิกาก่อนสร้าง VHDL)`); return; }
			const RST = c.params.reset ? driver(c.id, "rst") : null;
			const PRE = c.params.preset ? driver(c.id, "pre") : null;
			if (c.params.reset && !RST) warns.push(`${compDisplay(c)} เปิด async reset แต่ขา rst ไม่ได้ต่อสาย — ข้าม reset ในโค้ด`);
			if (c.params.preset && !PRE) warns.push(`${compDisplay(c)} เปิด async preset แต่ขา pre ไม่ได้ต่อสาย — ข้าม preset ในโค้ด`);
			const qsig = c._nets.q;
			processes.push({
				clk: CLK, edge: c.params.edge,
				rst: RST, pre: PRE,
				// qn is assigned in every branch from the same pre-edge value of q,
				// so q/qn always stay complementary after the edge
				body:
					`      if    (${J}='0' and ${K}='1') then ${qsig} <= '0'; ${c._nets.qn} <= '1';
      elsif (${J}='1' and ${K}='0') then ${qsig} <= '1'; ${c._nets.qn} <= '0';
      elsif (${J}='1' and ${K}='1') then ${qsig} <= not ${qsig}; ${c._nets.qn} <= ${qsig};
      end if;`,
				rstAssign: `      ${qsig} <= '0';\n      ${c._nets.qn} <= '1';`,
				preAssign: `      ${qsig} <= '1';\n      ${c._nets.qn} <= '0';`
			});
			return;
		}
		/* ----- T-FF ----- */
		if (c.type === "TFF") {
			const T = driverFor("t");
			const CLK = driver(c.id, "clk");
			if (!CLK) { warns.push(`${compDisplay(c)} ขา 'clk' ยังไม่ได้ต่อสาย — ข้าม flip-flop นี้ในโค้ด (ต่อสัญญาณนาฬิกาก่อนสร้าง VHDL)`); return; }
			const RST = c.params.reset ? driver(c.id, "rst") : null;
			const PRE = c.params.preset ? driver(c.id, "pre") : null;
			if (c.params.reset && !RST) warns.push(`${compDisplay(c)} เปิด async reset แต่ขา rst ไม่ได้ต่อสาย — ข้าม reset ในโค้ด`);
			if (c.params.preset && !PRE) warns.push(`${compDisplay(c)} เปิด async preset แต่ขา pre ไม่ได้ต่อสาย — ข้าม preset ในโค้ด`);
			const qsig = c._nets.q;
			processes.push({
				clk: CLK, edge: c.params.edge,
				rst: RST, pre: PRE,
				body: `      if (${T}='1') then ${qsig} <= not ${qsig}; end if;`,
				rstAssign: `      ${qsig} <= '0';`,
				preAssign: `      ${qsig} <= '1';`,
			});
			return;
		}
		/* ----- SR-FF ----- */
		if (c.type === "SRFF") {
			const S = driverFor("s");
			const R = driverFor("r");
			const CLK = driver(c.id, "clk");
			if (!CLK) { warns.push(`${compDisplay(c)} ขา 'clk' ยังไม่ได้ต่อสาย — ข้าม flip-flop นี้ในโค้ด (ต่อสัญญาณนาฬิกาก่อนสร้าง VHDL)`); return; }
			const qsig = c._nets.q;
			processes.push({
				clk: CLK, edge: c.params.edge,
				body:
					`      if    (${S}='1' and ${R}='0') then ${qsig} <= '1'; ${c._nets.qn} <= '0';
      elsif (${S}='0' and ${R}='1') then ${qsig} <= '0'; ${c._nets.qn} <= '1';
      end if;`
			});
			return;
		}
		/* ----- Custom component (component instantiation) ----- */
		if (c.type.startsWith("CUSTOM:")) {
			const td = typeDef(c);
			const cc = td._custom;
			const maps = [];
			customPorts(cc).forEach(p => {
				if (p.dir === "in") {
					const v = driver(c.id, p.name);
					if (!v) warns.push(`${compDisplay(c)} ขา '${p.name}' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน`);
					maps.push(`${p.name} => ${v || zlit(p.width)}`);
				} else {
					maps.push(`${p.name} => ${c._nets[p.name]}`);
				}
			});
			subInstances.push({ entity: sanId(cc.name), inst: c.id, maps });
			return;
		}
		/* ----- Sub-schematic instance ----- */
		if (c.type.startsWith("SCH:")) {
			const td = typeDef(c);
			const subSch = td._sch;
			const maps = [];
			td.ports({}).forEach(p => {
				if (p.dir === "in") {
					const v = driver(c.id, p.id);
					if (!v) warns.push(`${compDisplay(c)} ขา '${p.id}' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน`);
					maps.push(`${p.id} => ${v || zlit(p.width)}`);
				} else {
					maps.push(`${p.id} => ${c._nets[p.id]}`);
				}
			});
			subInstances.push({ entity: sanId(subSch.name), inst: c.id, maps });
			return;
		}
	});

	// output assignments
	const outLines = [];
	outputs.forEach(c => {
		const v = driver(c.id, "i");
		if (!v) { warns.push(`OUTPUT '${c._net}' ยังไม่ได้ต่อสาย — ใช้ค่า '0' แทน`); outLines.push(`  ${c._net} <= ${zlit(c.params.width)};`); }
		else outLines.push(`  ${c._net} <= ${v};`);
	});

	/* ---- assemble ---- */
	const portDecls = [];
	inputs.forEach(c => {
		const t = c.params.width > 1 ? `STD_LOGIC_VECTOR(${c.params.width - 1} downto 0)` : "STD_LOGIC";
		portDecls.push(`    ${c._net} : in  ${t}`);
	});
	outputs.forEach(c => {
		const t = c.params.width > 1 ? `STD_LOGIC_VECTOR(${c.params.width - 1} downto 0)` : "STD_LOGIC";
		portDecls.push(`    ${c._net} : out ${t}`);
	});

	// collect internal signals (scalars grouped, vectors declared individually)
	const sigScalars = [];
	const sigVectors = [];
	inners.forEach(c => {
		if (c.type === "JUNCTION" && c._busSig) { sigVectors.push({ name: c._busSig, w: c._busW }); return; }
		if (!c._nets) return;
		Object.keys(c._nets).forEach(pid => {
			const wdt = (c._netW && c._netW[pid]) || 1;
			if (wdt > 1) sigVectors.push({ name: c._nets[pid], w: wdt });
			else sigScalars.push(c._nets[pid]);
		});
	});

	// component declarations for sub-entities used (match by sanitized name)
	const compDecls = [];
	const seen = new Set();
	subInstances.forEach(si => {
		if (seen.has(si.entity)) return;
		seen.add(si.entity);
		// find the source: custom or sub-sch
		const cc = Object.values(state.project.customs).find(x => sanId(x.name) === si.entity);
		if (cc) {
			compDecls.push(formatComponentDecl(si.entity, customPorts(cc)));
		} else {
			const sub = Object.values(state.project.schematics).find(s => sanId(s.name) === si.entity);
			if (sub) {
				// shared deduped list → component decl matches the sub-entity's ports exactly
				const cps = schPortList(sub).map(p => ({ name: p.id, dir: p.dir, width: p.width }));
				compDecls.push(formatComponentDecl(si.entity, cps));
			}
		}
	});

	let code = "";
	code += `library IEEE;\n`;
	code += `use IEEE.STD_LOGIC_1164.ALL;\n`;
	code += `use IEEE.NUMERIC_STD.ALL;\n\n`;
	code += `-- Generated by Schematic Studio  (target: Xilinx Spartan-7 / Vivado)\n`;
	code += `-- Schematic: ${sch.name}\n\n`;
	code += `entity ${ename} is\n`;
	if (portDecls.length) code += `  Port (\n` + portDecls.join(";\n") + `\n  );\n`;   // empty Port() is invalid VHDL
	code += `end ${ename};\n\n`;
	code += `architecture Behavioral of ${ename} is\n`;
	if (compDecls.length) code += compDecls.join("\n") + "\n";
	if (sigScalars.length) code += `  signal ${sigScalars.join(", ")} : STD_LOGIC;\n`;
	sigVectors.forEach(s => { code += `  signal ${s.name} : STD_LOGIC_VECTOR(${s.w - 1} downto 0);\n`; });
	code += `begin\n`;
	if (concurrent.length) {
		code += `\n  -- combinational logic\n` + concurrent.join("\n") + "\n";
	}
	if (processes.length) {
		code += `\n  -- sequential logic (flip-flops)\n`;
		processes.forEach((pr, idx) => {
			const sens = [pr.clk];
			if (pr.rst) sens.push(pr.rst);
			if (pr.pre) sens.push(pr.pre);
			const edgeFn = pr.edge === "falling" ? "falling_edge" : "rising_edge";
			code += `  process(${sens.join(", ")})\n  begin\n`;
			const indent = "    ";
			if (pr.rst && pr.pre) {
				// async reset has priority over async preset
				code += `${indent}if ${pr.rst} = '1' then\n${pr.rstAssign}\n${indent}elsif ${pr.pre} = '1' then\n${pr.preAssign}\n${indent}elsif ${edgeFn}(${pr.clk}) then\n`;
			} else if (pr.rst) {
				code += `${indent}if ${pr.rst} = '1' then\n${pr.rstAssign}\n${indent}elsif ${edgeFn}(${pr.clk}) then\n`;
			} else if (pr.pre) {
				code += `${indent}if ${pr.pre} = '1' then\n${pr.preAssign}\n${indent}elsif ${edgeFn}(${pr.clk}) then\n`;
			} else {
				code += `${indent}if ${edgeFn}(${pr.clk}) then\n`;
			}
			code += pr.body + "\n";
			code += `${indent}end if;\n  end process;\n`;
		});
	}
	if (subInstances.length) {
		code += `\n  -- sub-component instantiations\n`;
		subInstances.forEach((si, idx) => {
			// a port-less instance takes no port map clause — "port map ( )" is invalid
			if (!si.maps.length) { code += `  u_${idx}_${si.inst} : ${si.entity};\n`; return; }
			code += `  u_${idx}_${si.inst} : ${si.entity} port map (\n    ` +
				si.maps.join(",\n    ") + `\n  );\n`;
		});
	}
	if (outLines.length) {
		code += `\n  -- output drivers\n` + outLines.join("\n") + "\n";
	}
	code += `\nend Behavioral;\n`;

	return { code, warns };
}
function formatComponentDecl(name, ports) {
	// a port-less component must have NO Port clause — "Port ( );" is invalid VHDL
	if (!ports.length) return `  component ${name}\n  end component;`;
	const decls = ports.map(p => {
		const t = (p.width || 1) > 1 ? `STD_LOGIC_VECTOR(${p.width - 1} downto 0)` : "STD_LOGIC";
		return `      ${p.name} : ${p.dir === "in" ? "in " : "out"} ${t}`;
	});
	return `  component ${name}\n    Port (\n${decls.join(";\n")}\n    );\n  end component;`;
}

/* ---- Generate & show in VHDL panel ---- */
let _lastAllVhdl = null;
function bundleAll(all) {
	return Object.keys(all).map(n => {
		const entry = all[n];
		const c = (typeof entry === "string") ? entry : (entry?.code || "-- no code");
		return `-- ============================================================\n-- Entity: ${n}\n-- ============================================================\n${c}`;
	}).join("\n");
}
function generateVHDL() {
	try {
		const issues = runSynthesis() || [];
		const all = generateAllVhdl();
		_lastAllVhdl = all;
		const sel = $("#vhdlEntitySel");
		const topName = state.project.schematics[state.project.topId]?.name;
		const opts = [`<option value="__all__">★ All entities (bundle for Vivado)</option>`];
		Object.keys(all).forEach(n => {
			const isTop = n === topName;
			opts.push(`<option value="${esc(n)}">📄 ${esc(n)}${isTop ? "  (top)" : ""}</option>`);
		});
		sel.innerHTML = opts.join("");
		sel.value = "__all__";
		showVhdlFor("__all__", all);
		setRightTab("vhdl");
		// surface generator warnings in the Issues tab instead of dropping them
		const warnItems = [];
		Object.keys(all).forEach(n => {
			const entry = all[n];
			if (entry && entry.warns) entry.warns.forEach(m => warnItems.push({ lvl: "warn", msg: m, ref: n }));
		});
		if (warnItems.length) renderErrors(issues.concat(warnItems));
		const nEnt = Object.keys(all).length;
		if (warnItems.length) {
			toast(`สร้าง ${nEnt} entity แล้ว — มีคำเตือน ${warnItems.length} รายการในแท็บ Issues`, "warn");
		} else {
			toast(`สร้าง ${nEnt} entity เรียบร้อย ✓`, "ok");
		}
		return all;
	} catch (err) {
		console.error("VHDL gen failed:", err);
		toast("VHDL gen error: " + (err.message || err), "err");
		return null;
	}
}
function showVhdlFor(name, all) {
	if (!all) all = _lastAllVhdl || generateAllVhdl();
	let code;
	if (name === "__all__") {
		code = bundleAll(all);
	} else {
		const entry = all[name];
		code = (typeof entry === "string") ? entry : (entry?.code || "-- no code");
	}
	const pre = $("#vhdlOutput");
	pre.dataset.raw = code;
	pre.innerHTML = vhdlHighlight(code);
}
function vhdlHighlight(code) {
	const escd = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return escd.split("\n").map(line => {
		const ci = line.indexOf("--");
		let head = ci >= 0 ? line.slice(0, ci) : line;
		const tail = ci >= 0 ? `<span class="cm">${line.slice(ci)}</span>` : "";
		head = head
			.replace(/\b(library|use|entity|is|Port|in|out|inout|end|architecture|of|begin|signal|process|if|then|elsif|else|when|others|null|component|port|map|rising_edge|falling_edge|and|or|not|xor|nand|nor|downto)\b/gi, '<span class="kw">$1</span>')
			.replace(/\b(STD_LOGIC|STD_LOGIC_VECTOR|STD_LOGIC_1164|NUMERIC_STD|IEEE|Behavioral|UNSIGNED|SIGNED)\b/g, '<span class="ty">$1</span>');
		return head + tail;
	}).join("\n");
}
$("#vhdlEntitySel")?.addEventListener("change", ev => {
	showVhdlFor(ev.target.value);
});

/* =========================================================================
   FILE I/O
   ========================================================================= */
function serialize() {
	// strip only the VHDL-generator scratch fields (never user data, whose keys
	// could legitimately start with "_" after sanId)
	const SCRATCH = new Set(["_net", "_nets", "_netW", "_busSig", "_busW"]);
	return JSON.stringify({
		version: 1,
		project: state.project,
		activeId: state.activeId,
		openTabs: state.openTabs,
	}, (k, v) => SCRATCH.has(k) ? undefined : v, 2);
}
function resetVhdlPanel() {
	_lastAllVhdl = null;
	$("#vhdlEntitySel").innerHTML = "";
	const pre = $("#vhdlOutput");
	pre.dataset.raw = "";
	pre.innerHTML = `<span class="cm">-- กดปุ่ม "⚙ Generate VHDL" ด้านบน เพื่อสร้างโค้ดจากวงจร</span>`;
}
function deserialize(json) {
	// parse + repair on a local object first, commit to state only when valid
	const o = JSON.parse(json);
	if (!o.project || typeof o.project !== "object") throw new Error("Invalid file");
	const proj = o.project;
	if (!proj.schematics || Object.keys(proj.schematics).length === 0) {
		const fresh = blankProject();
		proj.schematics = fresh.schematics;
		proj.topId = fresh.topId;
	}
	if (!proj.customs) proj.customs = {};
	if (!proj.topId || !proj.schematics[proj.topId]) {
		proj.topId = Object.keys(proj.schematics)[0];
	}
	// normalise every sheet's SHAPE up front, so the migrate/heal/fanout passes below
	// can't throw a raw TypeError deep inside on a malformed-but-parseable file
	const fixSheet = (s, sid) => {
		if (!s || typeof s !== "object") throw new Error("Invalid file: schematic is not an object");
		if (!Array.isArray(s.components)) s.components = [];
		if (!Array.isArray(s.wires)) s.wires = [];
		s.wires = s.wires.filter(w => w && w.from && w.to && w.from.cid != null && w.to.cid != null);
		s.id = s.id || sid; s.name = s.name || sid || "sch";
	};
	Object.entries(proj.schematics).forEach(([sid, s]) => fixSheet(s, sid));
	Object.values(proj.customs).forEach(cc => { if (cc && cc.schematic) fixSheet(cc.schematic, cc.schematic.id); });
	// migrate/clean old bus components: TAP→BUSTAP (keep); SPLIT/MERGE/BUSMERGE
	// were removed → strip them and their wires
	const DEAD_TYPES = new Set(["SPLIT", "MERGE", "BUSMERGE", "BUSRIP"]);
	const migrate = s => {
		if (!s || !s.components) return;
		s.components.forEach(cc => { if (cc.type === "TAP") { cc.type = "BUSTAP"; if (cc.params) delete cc.params.width; } });
		const dead = new Set(s.components.filter(cc => DEAD_TYPES.has(cc.type)).map(cc => cc.id));
		if (dead.size) {
			s.components = s.components.filter(cc => !dead.has(cc.id));
			s.wires = (s.wires || []).filter(x => !dead.has(x.from.cid) && !dead.has(x.to.cid));
		}
	};
	Object.values(proj.schematics).forEach(migrate);
	Object.values(proj.customs || {}).forEach(cc => migrate(cc.schematic));
	// sweep junctions that lost their purpose (orphans from old files/edits)
	Object.values(proj.schematics).forEach(s => healJunctions(s));
	Object.values(proj.customs || {}).forEach(cc => { if (cc.schematic) healJunctions(cc.schematic); });
	// MUST precede anything that mints ids below: normalizePortFanout creates junction
	// + wire ids via uid(), and an id colliding with a loaded one silently re-points
	// wires at the wrong component (dead nets, wrong VHDL, saved back into the file)
	reseedUid(proj);
	// parallel same-port fanout (old files) → junction branches with visible dots
	Object.values(proj.schematics).forEach(s => normalizePortFanout(s));
	Object.values(proj.customs || {}).forEach(cc => { if (cc.schematic) normalizePortFanout(cc.schematic); });
	// legacy files may carry duplicate schematic names → entities would collide
	const seenNames = new Set();
	Object.values(proj.schematics).forEach(s => {
		let nm = sanId(s.name || "sch"), k = 2; const root = nm;
		while (seenNames.has(nm)) nm = root + "_" + (k++);
		seenNames.add(nm);
		s.name = nm;
	});
	// commit
	state.project = proj;
	state.activeId = (o.activeId && proj.schematics[o.activeId]) ? o.activeId : Object.keys(proj.schematics)[0];
	state.openTabs = (o.openTabs || []).filter(id => proj.schematics[id]);
	if (!state.openTabs.length) state.openTabs = [state.activeId];
	state.selection.clear();
	state.pendingWire = null;
	reseedUid();                     // avoid new-id collisions with loaded ids
	resetVhdlPanel();                // stale generated code belongs to the old project
	$("#projectName").value = proj.name || "my_project";
	snapshot(); renderAll();
}
function saveProjectToFile() {
	state.project.name = sanId($("#projectName").value || state.project.name || "project");
	$("#projectName").value = state.project.name;
	const data = serialize();
	const b = new Blob([data], { type: "application/json" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u;
	a.download = state.project.name + ".schproj.json";
	a.click();
	URL.revokeObjectURL(u);
	toast("บันทึกโปรเจกต์แล้ว", "ok");
}
function openProjectFromFile() {
	const inp = document.createElement("input");
	inp.type = "file";
	inp.accept = ".json,application/json";
	inp.onchange = e => {
		const f = e.target.files[0]; if (!f) return;
		const r = new FileReader();
		r.onload = () => {
			try { deserialize(r.result); toast("โหลดโปรเจกต์แล้ว", "ok"); }
			catch (err) { toast("โหลดไม่สำเร็จ: " + err.message, "err"); }
		};
		r.readAsText(f);
	};
	inp.click();
}
function newProject() {
	if (!confirm("สร้างโปรเจกต์ใหม่? โปรเจกต์ปัจจุบันที่ยังไม่ได้ Save เป็นไฟล์จะหายไป")) return;
	state.project = blankProject();
	state.activeId = Object.keys(state.project.schematics)[0];
	state.openTabs = [state.activeId];
	state.selection.clear();
	state.pendingWire = null;
	state.view = { x: 0, y: 0, k: 1 };
	state.history = { stack: [], idx: -1, muted: false };
	resetVhdlPanel();
	$("#projectName").value = "my_project";
	snapshot(); renderAll();
}
function exportVhdlFile() {
	if (!_lastAllVhdl) generateVHDL();
	const code = $("#vhdlOutput").dataset.raw || "";
	if (!code) { toast("ยังไม่มีโค้ดให้ดาวน์โหลด — กด Generate VHDL ก่อน", "warn"); return; }
	const v = $("#vhdlEntitySel").value || "top";
	let fname;
	if (v === "__all__") fname = sanId(state.project.name || "project") + "_all.vhd";
	else fname = sanId(v) + ".vhd";
	const b = new Blob([code], { type: "text/plain" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u; a.download = fname; a.click();
	URL.revokeObjectURL(u);
	toast("Downloaded " + fname, "ok");
}
function exportAllVhdl() {
	const all = generateAllVhdl();
	// pack as a single file with sections
	let bundle = "";
	for (const name in all) {
		bundle += `-- ============================================================\n-- Entity: ${name}\n-- ============================================================\n`;
		bundle += (typeof all[name] === "string" ? all[name] : all[name].code) + "\n\n";
	}
	const b = new Blob([bundle], { type: "text/plain" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u; a.download = sanId($("#projectName").value) + "_all.vhd"; a.click();
	URL.revokeObjectURL(u);
}

/* =========================================================================
   AUTO-SAVE (localStorage)
   ========================================================================= */
function autosave() {
	try {
		localStorage.setItem(AUTOSAVE_KEY, serialize());
		$("#statAutosave").innerHTML = `<span class="ok">autosave: ✓ ${new Date().toLocaleTimeString()}</span>`;
	} catch (e) {
		$("#statAutosave").innerHTML = `<span class="err">autosave failed</span>`;
	}
}
function loadAutosave() {
	const s = localStorage.getItem(AUTOSAVE_KEY);
	if (s) {
		try {
			deserialize(s);   // also syncs #projectName, uid counter, VHDL panel
			return true;
		} catch (e) {
			console.warn("Autosave restore failed:", e);
		}
	}
	return false;
}
function startAutoSave() {
	clearInterval(state.autosaveTimer);
	state.autosaveTimer = setInterval(autosave, AUTOSAVE_MS);
}

/* =========================================================================
   CUSTOM COMPONENT WIZARD  (schematic-based)
   - User picks a source schematic in the project.
   - The schematic's IN/OUT ports become the component's ports.
   - A deep-copy of the schematic is stored inside the custom, so it is
	 self-contained and can be exported/imported as a JSON file.
   ========================================================================= */
function openWizard(editName) {
	const isEdit = !!editName;
	const editing = isEdit ? state.project.customs[editName] : null;
	const initialSourceId = isEdit ? null : state.activeId;

	const schematics = Object.values(state.project.schematics);
	if (schematics.length === 0) { toast("ต้องมี schematic อย่างน้อย 1 อันก่อน", "warn"); return; }

	const m = document.createElement("div");
	m.className = "modal-bg";
	const schOptions = schematics.map(s =>
		`<option value="${s.id}" ${s.id === initialSourceId ? "selected" : ""}>${esc(s.name)}</option>`
	).join("");

	m.innerHTML = `
    <div class="modal">
      <h2>🧙 Custom Component Wizard ${isEdit ? `<span style="color:var(--muted);font-weight:400;font-size:12px;margin-left:6px">— editing "${esc(editName)}"</span>` : ""}
        <button class="close">×</button></h2>
      <div class="modal-body">
        <div style="background:#1a2a4a;border:1px solid var(--accent);border-radius:8px;padding:10px 12px;margin-bottom:14px;color:var(--ink-dim);font-size:12px;line-height:1.6">
          💡 <b style="color:var(--ink)">Custom Component สร้างจาก schematic</b> — เลือก schematic ที่จะแปลงเป็น reusable block. ระบบจะคัดลอกข้อมูลทั้งหมด (components + wires + I/O ports) เก็บไว้ใน custom component เพื่อให้สามารถ export/import แชร์ข้ามโปรเจคได้
        </div>
        ${isEdit ? "" : `
          <div class="row">
            <label>Source schematic</label>
            <select id="wSource">${schOptions}</select>
          </div>
        `}
        <div class="row">
          <label>Component name</label>
          <input id="wName" value="${esc(editing ? editing.name : "")}" placeholder="my_block">
        </div>
        <div class="row">
          <label>Description</label>
          <input id="wDesc" value="${esc(editing ? editing.description || "" : "")}" placeholder="(optional)">
        </div>
        <div style="margin:14px 0 6px;font-size:11px;color:var(--ink-dim);letter-spacing:1px;font-weight:600">DERIVED PORTS (จาก IN/OUT ใน schematic)</div>
        <div id="wPortPreview" style="background:var(--bg-2);border:1px solid var(--line);border-radius:6px;padding:10px 12px;max-height:200px;overflow:auto;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.8"></div>
        ${isEdit ? `<div style="margin-top:12px;padding:8px 10px;background:var(--bg-2);border-left:3px solid var(--warn);border-radius:4px;font-size:11.5px;color:var(--ink-dim)">⚠ โหมดแก้ไข: เปลี่ยนได้เฉพาะชื่อและคำอธิบาย — หากต้องการแก้วงจรข้างใน ให้ลบ component นี้แล้วสร้างใหม่จาก schematic</div>` : ""}
      </div>
      <div class="modal-foot">
        <button class="btn" id="wCancel">Cancel</button>
        <button class="btn btn-primary" id="wSave">${isEdit ? "Save Changes" : "Create Component"}</button>
      </div>
    </div>`;
	document.body.appendChild(m);

	function selectedSch() {
		if (isEdit) return editing.schematic ? { components: editing.schematic.components, wires: editing.schematic.wires, name: editing.name } : null;
		const sid = m.querySelector("#wSource").value;
		return state.project.schematics[sid];
	}
	function updatePreview() {
		const sch = selectedSch();
		const root = m.querySelector("#wPortPreview");
		if (!sch) { root.innerHTML = '<span style="color:var(--muted)">— ไม่มี schematic —</span>'; return; }
		const ins = (sch.components || []).filter(c => c.type === "IN");
		const outs = (sch.components || []).filter(c => c.type === "OUT");
		if (ins.length + outs.length === 0) {
			root.innerHTML = '<span style="color:var(--warn)">⚠ ไม่มี INPUT/OUTPUT pin ใน schematic นี้ — ต้องเพิ่มก่อน</span>';
			return;
		}
		let html = "";
		ins.forEach(c => {
			const w = c.params.width || 1;
			const t = w > 1 ? `std_logic_vector(${w - 1} downto 0)` : "std_logic";
			html += `<div><span style="color:var(--in-stroke)">▸ in </span><span style="color:var(--ink)">${esc(c.params.name)}</span> <span style="color:var(--muted)">: ${t}</span></div>`;
		});
		outs.forEach(c => {
			const w = c.params.width || 1;
			const t = w > 1 ? `std_logic_vector(${w - 1} downto 0)` : "std_logic";
			html += `<div><span style="color:var(--out-stroke)">◂ out</span> <span style="color:var(--ink)">${esc(c.params.name)}</span> <span style="color:var(--muted)">: ${t}</span></div>`;
		});
		root.innerHTML = html;
		// auto-fill name
		const nameInp = m.querySelector("#wName");
		if (!isEdit && !nameInp.value) nameInp.value = sch.name + "_blk";
	}
	updatePreview();
	const srcSel = m.querySelector("#wSource");
	if (srcSel) srcSel.onchange = updatePreview;

	m.querySelector(".close").onclick = () => m.remove();
	m.querySelector("#wCancel").onclick = () => m.remove();
	m.querySelector("#wSave").onclick = () => {
		const name = sanId(m.querySelector("#wName").value);
		if (!name) { toast("ต้องมีชื่อ", "err"); return; }
		const desc = m.querySelector("#wDesc").value;
		if (isEdit) {
			// rename if changed
			if (editName !== name) {
				if (state.project.customs[name]) { toast(`มีชื่อ "${name}" อยู่แล้ว`, "err"); return; }
				delete state.project.customs[editName];
				// keep every placed instance pointing at the new name
				rewriteInstanceType("CUSTOM:" + editName, "CUSTOM:" + name);
			}
			editing.name = name;
			editing.description = desc;
			state.project.customs[name] = editing;
		} else {
			if (state.project.customs[name]) { toast(`มีชื่อ "${name}" อยู่แล้ว`, "err"); return; }
			const sch = selectedSch();
			const ins = (sch.components || []).filter(c => c.type === "IN");
			const outs = (sch.components || []).filter(c => c.type === "OUT");
			if (ins.length + outs.length === 0) {
				if (!confirm("Schematic นี้ไม่มี I/O port — สร้างต่อ?")) return;
			}
			state.project.customs[name] = {
				name,
				description: desc,
				sourceSchematicId: sch.id,
				schematic: {
					components: JSON.parse(JSON.stringify(sch.components || [])),
					wires: JSON.parse(JSON.stringify(sch.wires || []))
				}
			};
		}
		snapshot(); renderAll();
		toast(`${isEdit ? "Updated" : "Created"} custom component "${name}"`, "ok");
		m.remove();
	};
}

/* =========================================================================
   EXPORT / IMPORT CUSTOM COMPONENTS  (JSON files)
   ========================================================================= */
function collectCustomDeps(cc, acc = new Set()) {
	if (!cc || !cc.schematic) return acc;
	cc.schematic.components.forEach(c => {
		if (c.type && c.type.startsWith("CUSTOM:")) {
			const n = c.type.slice(7);
			if (!acc.has(n) && state.project.customs[n]) {
				acc.add(n);
				collectCustomDeps(state.project.customs[n], acc);
			}
		}
	});
	return acc;
}
function exportCustomComponent(name) {
	const cc = state.project.customs[name];
	if (!cc) { toast("ไม่พบ component", "err"); return; }
	const deps = collectCustomDeps(cc);
	const pkg = {
		type: "schstudio-custom-pkg",
		version: 1,
		root: name,
		customs: { [name]: cc }
	};
	deps.forEach(n => { if (state.project.customs[n]) pkg.customs[n] = state.project.customs[n]; });
	const data = JSON.stringify(pkg, null, 2);
	const b = new Blob([data], { type: "application/json" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u;
	a.download = sanId(name) + ".sccomp.json";
	a.click();
	URL.revokeObjectURL(u);
	toast(`Exported "${name}"${deps.size ? ` (+ ${deps.size} dependencies)` : ""}`, "ok");
}
/* ==========================================================================
   VHDL  →  SCHEMATIC  import   (combinational gates + MUX + D flip-flop)
   Parses a .vhd file's entity/architecture and rebuilds a drawn circuit:
   ports→IN/OUT, boolean expressions→gate trees, when/else→MUX, rising_edge
   process→D-FF; then columns the parts by logic depth and lets the router wire.
   ========================================================================== */
function vhStrip(t) { return String(t).replace(/--[^\n]*/g, " ").replace(/\r/g, " "); }
function vhSplitTop(s, delim) {
	const out = []; let d = 0, cur = "";
	for (const ch of s) {
		if (ch === "(") d++; else if (ch === ")") d--;
		if (ch === delim && d === 0) { out.push(cur); cur = ""; } else cur += ch;
	}
	if (cur.trim()) out.push(cur); return out;
}
function vhTypeWidth(ts) {
	const m = /\(\s*(\d+)\s+downto\s+(\d+)\s*\)/i.exec(ts) || /\(\s*(\d+)\s+to\s+(\d+)\s*\)/i.exec(ts);
	return m ? Math.abs((+m[1]) - (+m[2])) + 1 : 1;
}
const vhBase = s => sanId(String(s).replace(/\(.*\)/, "").trim());
function vhTokenize(s) { const out = []; const re = /\s*('[01]'|"[01]+"|[A-Za-z_]\w*(?:\([^)]*\))?|\(|\)|<=)\s*/g; let m; while (m = re.exec(s)) out.push(m[1]); return out; }
function vhParseExpr(str) {
	// "(others => '0')" is a constant fill, not a signal — without this it tokenises
	// to a phantom 'others' net reported as a missing source
	const agg = /^\(\s*others\s*=>\s*'([01])'\s*\)$/i.exec(String(str).trim());
	if (agg) return { lit: agg[1] };
	const toks = vhTokenize(str); let pos = 0;
	const peek = () => toks[pos], nx = () => toks[pos++];
	function primary() {
		const t = peek();
		if (t === "(") { nx(); const e = orExpr(); if (peek() === ")") nx(); return e; }
		if (/^not$/i.test(t)) { nx(); return { op: "not", args: [primary()] }; }
		nx();
		if (/^'0'$/.test(t)) return { lit: "0" };
		if (/^'1'$/.test(t)) return { lit: "1" };
		return { sig: vhBase(t) };
	}
	function orExpr() {
		let left = primary();
		while (peek() && /^(and|or|xor|nand|nor|xnor)$/i.test(peek())) {
			const op = nx().toLowerCase(); const right = primary();
			if (left.op === op) left.args.push(right); else left = { op, args: [left, right] };
		}
		return left;
	}
	return orExpr();
}
function vhParseProcess(p, warns) {
	const em = /(rising|falling)_edge\s*\(\s*(\w+)\s*\)/i.exec(p);
	if (!em) { warns.push("ข้าม process ที่ไม่ใช่ flip-flop"); return null; }
	const asn = [...p.matchAll(/(\w+)\s*<=\s*([^;]+);/gi)];
	const clocked = asn.find(a => a.index > em.index) || asn[asn.length - 1];
	if (!clocked) return null;
	const ff = { kind: "ff", q: sanId(clocked[1]), d: vhParseExpr(clocked[2].trim()), clk: sanId(em[2]), edge: em[1].toLowerCase() };
	const rm = /if\s+(\w+)\s*=\s*'1'\s*then\s+\w+\s*<=\s*'0'/i.exec(p);
	const pm = /if\s+(\w+)\s*=\s*'1'\s*then\s+\w+\s*<=\s*'1'/i.exec(p);
	if (rm) ff.rst = sanId(rm[1]); if (pm) ff.pre = sanId(pm[1]);
	return ff;
}
function vhParseWhenElse(target, rhs) {
	const cases = []; let deflt = null;
	rhs.split(/\belse\b/i).forEach(seg => {
		const wm = /^([\s\S]+?)\s+when\s+([\s\S]+)$/i.exec(seg.trim());
		if (wm) cases.push({ value: vhParseExpr(wm[1]), cond: wm[2].trim() }); else deflt = vhParseExpr(seg.trim());
	});
	const sm = cases.length && /(\w+)\s*=\s*['"]/.exec(cases[0].cond);
	return { kind: "mux", target, cases, deflt, sel: sm ? sanId(sm[1]) : null };
}
/* Decode a MUX when-condition into {idx, sels}: idx = the binary value it selects,
   sels = the select net name(s) MSB-first. Handles "sel = '01'" (vector or 1-bit,
   one net) and "(a = '1' and b = '0')" (per-bit, MSB listed first — the app's form).
   idx=null when neither shape matches (caller falls back to source order + warns). */
function vhMuxSel(cond) {
	if (!cond) return { idx: null, sels: [] };
	const c = cond.trim().replace(/^\(+|\)+$/g, "").trim();
	const one = /^(\w+)\s*=\s*['"]([01]+)['"]$/.exec(c);
	if (one && !/\band\b/i.test(c)) return { idx: parseInt(one[2], 2), sels: [sanId(one[1])] };
	const eqs = [...c.matchAll(/(\w+)\s*=\s*['"]([01])['"]/g)];
	if (eqs.length) return { idx: parseInt(eqs.map(m => m[2]).join(""), 2), sels: eqs.map(m => sanId(m[1])) };
	return { idx: null, sels: [] };
}
function vhParseBody(body, stmts, warns) {
	const procRe = /process\s*(\([^)]*\))?\s*([\s\S]*?)end\s+process\s*;/gi;
	let pm, rest = body; const procs = [];
	while (pm = procRe.exec(body)) procs.push(pm[0]);
	procs.forEach(p => { rest = rest.replace(p, " "); const ff = vhParseProcess(p, warns); if (ff) stmts.push(ff); });
	vhSplitTop(rest, ";").forEach(raw => {
		const s = raw.trim(); if (!s) return;
		const m = /^([\w()]+?)\s*<=\s*([\s\S]+)$/.exec(s);
		if (!m) { if (/[a-z]/i.test(s)) warns.push("ข้ามคำสั่งที่อ่านไม่ได้: " + s.slice(0, 40)); return; }
		const target = vhBase(m[1]), rhs = m[2].trim();
		if (/\bwhen\b/i.test(rhs)) stmts.push(vhParseWhenElse(target, rhs));
		else stmts.push({ kind: "assign", target, expr: vhParseExpr(rhs) });
	});
}
function parseVhdl(src) {
	const t = vhStrip(src); const ports = [], signals = [], stmts = [], warns = [];
	const ent = /entity\s+(\w+)\s+is([\s\S]*?)end\b/i.exec(t);
	const entity = ent ? ent[1] : "imported";
	if (ent) {
		const pm = /port\s*\(([\s\S]*)\)\s*;\s*(?:end)?/i.exec(ent[2]);
		if (pm) vhSplitTop(pm[1], ";").forEach(decl => {
			const m = /^\s*([\w\s,]+?)\s*:\s*(in|out|inout)\b\s*(.+?)\s*$/i.exec(decl);
			if (!m) return;
			const dir = m[2].toLowerCase() === "in" ? "in" : "out", width = vhTypeWidth(m[3]);
			m[1].split(",").map(s => s.trim()).filter(Boolean).forEach(n => ports.push({ name: n, dir, width }));
		});
	}
	const arch = /architecture\s+\w+\s+of\s+\w+\s+is([\s\S]*?)\bbegin\b([\s\S]*)end\b/i.exec(t);
	if (arch) {
		let sm; const sigRe = /signal\s+([\w\s,]+?)\s*:\s*([^;]+?);/gi;
		while (sm = sigRe.exec(arch[1])) { const width = vhTypeWidth(sm[2]); sm[1].split(",").map(s => s.trim()).filter(Boolean).forEach(n => signals.push({ name: n, width })); }
		vhParseBody(arch[2], stmts, warns);
	}
	if ([...ports, ...signals].some(x => x.width > 1)) warns.push("มีสัญญาณบัส (>1 bit) — วาดลอจิกระดับบิตอาจไม่ครบ");
	return { entity, ports, signals, stmts, warns };
}
const VH_OPGATE = { and: "AND", or: "OR", xor: "XOR", nand: "NAND", nor: "NOR", xnor: "XNOR", not: "NOT", buf: "BUF" };
function buildSchematicFromVhdl(ast) {
	const comps = [], wires = [], driver = {}, need = [], depthOf = {};
	const warns = ast.warns || (ast.warns = []);   // import surfaces ast.warns to the user
	const add = (type, params) => { const id = uid("c"); comps.push({ id, type, x: 0, y: 0, params: params || {}, label: "" }); return id; };
	const outNames = new Set(ast.ports.filter(p => p.dir === "out").map(p => sanId(p.name)));
	const outAlias = {};
	function registerDriver(target, src) {
		if (src.cid !== undefined) { driver[target] = { cid: src.cid, pid: src.pid }; depthOf[target] = src.depth || 1; }
		else if (outNames.has(target)) { outAlias[target] = src.net; }
		else { const id = add("BUF", { inputs: 1 }); need.push({ cid: id, pid: "i0", net: src.net }); driver[target] = { cid: id, pid: "o" }; depthOf[target] = (depthOf[src.net] || 0) + 1; }
	}
	const outPorts = [];
	ast.ports.forEach(p => {
		if (p.dir === "in") { const id = add("IN", { name: sanId(p.name), width: p.width }); driver[sanId(p.name)] = { cid: id, pid: "o" }; depthOf[sanId(p.name)] = 0; }
		else outPorts.push({ name: sanId(p.name), width: p.width });
	});
	function emitExpr(node) {
		if (node.sig !== undefined) return { net: node.sig };
		if (node.lit !== undefined) { if (node.lit === "1") { const id = add("VCC", {}); return { cid: id, pid: "o", depth: 0 }; } return { open: true }; }
		const type = VH_OPGATE[node.op], ins = node.args.map(emitExpr);
		const params = (node.op === "not" || node.op === "buf") ? { inputs: 1 } : { inputs: ins.length };
		const gid = add(type, params);
		ins.forEach((src, i) => { if (src.net !== undefined) need.push({ cid: gid, pid: "i" + i, net: src.net }); else if (src.cid !== undefined) wires.push({ id: uid("w"), from: { cid: src.cid, pid: src.pid }, to: { cid: gid, pid: "i" + i }, name: "" }); });
		const d = 1 + Math.max(0, ...ins.map(s => s.net !== undefined ? (depthOf[s.net] || 0) : (s.depth || 0)));
		comps.find(c => c.id === gid).depth = d;
		return { cid: gid, pid: "o", depth: d };
	}
	ast.stmts.forEach(st => {
		if (st.kind === "assign") { registerDriver(st.target, emitExpr(st.expr)); }
		else if (st.kind === "ff") {
			const id = add("DFF", { edge: st.edge, reset: !!st.rst, preset: !!st.pre });
			const dsrc = emitExpr(st.d);
			if (dsrc.net !== undefined) need.push({ cid: id, pid: "d", net: dsrc.net }); else if (dsrc.cid !== undefined) wires.push({ id: uid("w"), from: { cid: dsrc.cid, pid: dsrc.pid }, to: { cid: id, pid: "d" }, name: "" });
			need.push({ cid: id, pid: "clk", net: st.clk });
			if (st.rst) need.push({ cid: id, pid: "rst", net: st.rst });
			if (st.pre) need.push({ cid: id, pid: "pre", net: st.pre });
			driver[st.q] = { cid: id, pid: "q" }; depthOf[st.q] = 2;
		} else if (st.kind === "mux") {
			// Each "... when <cond>" picks a data input; the cond's constant IS the binary
			// index of that input (the app's MUX drives d<idx> when sel = idx). Mapping by
			// SOURCE ORDER silently mis-wires any design whose whens aren't listed 0,1,2…
			// (incl. the app's own re-imported output), so decode the index from the cond.
			const parsed = st.cases.map(c => Object.assign({ v: c.value }, vhMuxSel(c.cond)));
			const maxIdx = parsed.reduce((m, p) => p.idx != null ? Math.max(m, p.idx) : m, 0);
			// size by the highest select index (or case count if indices didn't parse) —
			// the trailing "else '0'" is a fill for unused slots, NOT an extra data input
			const nCase = Math.max(2, maxIdx + 1, st.cases.length);
			const inputs = nCase <= 2 ? 2 : nCase <= 4 ? 4 : nCase <= 8 ? 8 : 16;
			const selW = Math.ceil(Math.log2(inputs));
			const id = add("MUX", { inputs });
			const used = new Set();
			const place = (idx, v) => {
				used.add(idx); const s = emitExpr(v);
				if (s.net !== undefined) need.push({ cid: id, pid: "d" + idx, net: s.net });
				else if (s.cid !== undefined) wires.push({ id: uid("w"), from: { cid: s.cid, pid: s.pid }, to: { cid: id, pid: "d" + idx }, name: "" });
			};
			parsed.forEach(p => {
				let idx = p.idx;
				if (idx == null || idx < 0 || idx >= inputs || used.has(idx)) {
					warns.push("MUX (" + st.target + "): อ่านค่า select ไม่ได้ วางตามลำดับแทน");
					for (idx = 0; idx < inputs && used.has(idx); idx++);
				}
				if (idx < inputs) place(idx, p.v);
			});
			if (st.deflt) { let idx = 0; for (; idx < inputs && used.has(idx); idx++); if (idx < inputs) place(idx, st.deflt); }
			// wire the select signal(s). vhMuxSel lists them MSB-first (the app emits
			// s_{hi}=MSB … s0=LSB), so the k-th listed maps to pin s{selW-1-k}.
			const sels = (parsed.find(p => p.sels && p.sels.length) || {}).sels || (st.sel ? [st.sel] : []);
			if (sels.length === 1 && selW > 1) { need.push({ cid: id, pid: "s0", net: sels[0] }); warns.push("MUX (" + st.target + "): select เป็นเวกเตอร์ ต่อ s0 เท่านั้น"); }
			else sels.forEach((netName, k) => { const b = selW - 1 - k; if (b >= 0 && b < selW) need.push({ cid: id, pid: "s" + b, net: netName }); });
			driver[st.target] = { cid: id, pid: "y" }; depthOf[st.target] = 2;
		}
	});
	outPorts.forEach(p => { const id = add("OUT", { name: p.name, width: p.width }); need.push({ cid: id, pid: "i", net: outAlias[p.name] || p.name }); });
	comps.forEach(c => { if (c.type === "IN") c.depth = 0; if ((c.type === "DFF" || c.type === "MUX") && c.depth == null) c.depth = 2; });
	need.forEach(nd => { const drv = driver[nd.net]; if (drv) wires.push({ id: uid("w"), from: { cid: drv.cid, pid: drv.pid }, to: { cid: nd.cid, pid: nd.pid }, name: "" }); });
	const maxD = Math.max(0, ...comps.filter(c => c.type !== "OUT").map(c => c.depth || 0));
	comps.forEach(c => { if (c.type === "OUT") c.depth = maxD + 1; });
	const COLW = 176, ROWH = 88, X0 = 66, Y0 = 55, cols = {};
	comps.forEach(c => { const d = c.depth || 0; (cols[d] = cols[d] || []).push(c); });
	Object.keys(cols).forEach(d => { cols[d].forEach((c, i) => { c.x = snap(X0 + (+d) * COLW); c.y = snap(Y0 + i * ROWH); delete c.depth; }); });
	return { comps, wires, unresolved: [...new Set(need.filter(nd => !driver[nd.net]).map(nd => nd.net))] };
}
function importVhdlFile() {
	const inp = document.createElement("input");
	inp.type = "file"; inp.accept = ".vhd,.vhdl,.txt";
	inp.onchange = e => {
		const f = (e.target.files || [])[0]; if (!f) return;
		const r = new FileReader();
		r.onload = () => {
			try {
				const ast = parseVhdl(r.result);
				if (!ast.ports.length && !ast.stmts.length) { toast("ไม่พบ entity/logic ในไฟล์นี้", "err", 3500); return; }
				const built = buildSchematicFromVhdl(ast);
				if (!built.comps.length) { toast("สร้าง schematic ไม่ได้", "err", 3500); return; }
				const id = uid("sch"), name = uniqueSchName(ast.entity || "imported", id);
				const sch = blankSchematic(id, name);
				sch.components = built.comps; sch.wires = built.wires;
				state.project.schematics[id] = sch;
				// same as deserialize: turn a driver's parallel sinks into junction-branch
				// fan-out (visible dots) and run the full layout — without this every
				// imported fan-out drew as a bare T with no connection dot until save+reload
				normalizePortFanout(sch);
				openSchTab(id); healLayout(sch); snapshot(); renderAll();
				try { zoomFit(); } catch (_) { }
				const parts = [`นำเข้า "${name}" — ${built.comps.length} components`];
				if (built.unresolved.length) parts.push("สัญญาณไม่พบต้นทาง: " + built.unresolved.join(", "));
				(ast.warns || []).forEach(w => parts.push("⚠ " + w));
				toast(parts.join(" · "), (built.unresolved.length || ast.warns.length) ? "warn" : "ok", 5200);
			} catch (err) { toast("Import VHDL error: " + (err && err.message || err), "err", 4000); }
		};
		r.readAsText(f);
	};
	inp.click();
}
function importCustomComponent() {
	const inp = document.createElement("input");
	inp.type = "file";
	inp.accept = ".json,application/json";
	inp.multiple = true;
	inp.onchange = e => {
		const files = Array.from(e.target.files || []);
		let okCount = 0;
		let pending = files.length;
		if (pending === 0) return;
		files.forEach(f => {
			const r = new FileReader();
			r.onload = () => {
				try {
					const o = JSON.parse(r.result);
					// package format
					if (o.type === "schstudio-custom-pkg" && o.customs) {
						const renames = new Map();          // original name → imported name
						const imported = [];
						Object.values(o.customs).forEach(cc => {
							let nm = cc.name, k = 1;
							while (state.project.customs[nm]) nm = cc.name + "_" + (k++);
							if (nm !== cc.name) renames.set(cc.name, nm);
							cc.name = nm;
							state.project.customs[nm] = cc;
							imported.push(cc);
							okCount++;
						});
						// fix nested CUSTOM: references that pointed at the original names
						if (renames.size) imported.forEach(cc => {
							if (!cc.schematic) return;
							(cc.schematic.components || []).forEach(c => {
								if (c.type && c.type.startsWith("CUSTOM:")) {
									const dep = c.type.slice(7);
									if (renames.has(dep)) c.type = "CUSTOM:" + renames.get(dep);
								}
							});
						});
					}
					// single-component format (legacy)
					else if (o.type === "schstudio-custom" && o.custom) {
						const cc = o.custom;
						let nm = cc.name, k = 1;
						while (state.project.customs[nm]) nm = cc.name + "_" + (k++);
						cc.name = nm;
						state.project.customs[nm] = cc;
						okCount++;
					} else {
						toast(`${f.name}: ไม่ใช่ component file`, "err");
					}
				} catch (err) {
					toast(`${f.name}: parse error`, "err");
				}
				if (--pending === 0) {
					if (okCount) {
						reseedUid();
						snapshot(); renderAll();
						toast(`นำเข้า ${okCount} component แล้ว`, "ok");
					}
				}
			};
			r.readAsText(f);
		});
	};
	inp.click();
}
function exportActiveAsCustom() {
	const sch = activeSch();
	if (!sch) { toast("ไม่มี schematic", "err"); return; }
	const ins = sch.components.filter(c => c.type === "IN");
	const outs = sch.components.filter(c => c.type === "OUT");
	if (ins.length + outs.length === 0) {
		if (!confirm("Schematic นี้ไม่มี I/O port — export ต่อ?")) return;
	}
	const cc = {
		name: sch.name,
		description: "Exported from schematic",
		schematic: {
			components: JSON.parse(JSON.stringify(sch.components)),
			wires: JSON.parse(JSON.stringify(sch.wires))
		}
	};
	const pkg = {
		type: "schstudio-custom-pkg", version: 1, root: cc.name,
		customs: { [cc.name]: cc }
	};
	const b = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
	const u = URL.createObjectURL(b);
	const a = document.createElement("a");
	a.href = u; a.download = sanId(cc.name) + ".sccomp.json"; a.click();
	URL.revokeObjectURL(u);
	toast(`Exported "${cc.name}" as component file`, "ok");
}

/* =========================================================================
   UI WIRE-UP
   ========================================================================= */
function setLeftTab(name) {
	$$(".pane:not(.right) .pane-tabs button").forEach(b => b.classList.toggle("active", b.dataset.ltab === name));
	$("#projectPane").classList.toggle("hidden", name !== "project");
	$("#palettePane").classList.toggle("hidden", name !== "palette");
}
function setRightTab(name) {
	$$(".pane.right .pane-tabs button").forEach(b => b.classList.toggle("active", b.dataset.rtab === name));
	$("#inspectorPane").classList.toggle("hidden", name !== "inspector");
	$("#errorsPane").classList.toggle("hidden", name !== "errors");
	$("#vhdlPane").classList.toggle("hidden", name !== "vhdl");
}
$$(".pane:not(.right) .pane-tabs button").forEach(b => b.addEventListener("click", () => setLeftTab(b.dataset.ltab)));
$$(".pane.right .pane-tabs button").forEach(b => b.addEventListener("click", () => setRightTab(b.dataset.rtab)));

/* Menu */
$$(".menu .mi").forEach(mi => {
	mi.querySelector("button").addEventListener("click", ev => {
		ev.stopPropagation();
		const open = mi.classList.contains("open");
		$$(".menu .mi").forEach(x => x.classList.remove("open"));
		if (!open) mi.classList.add("open");
	});
	// once a menu is open, hovering a sibling switches to it (standard menubar UX)
	mi.addEventListener("mouseenter", () => {
		if (mi.classList.contains("open")) return;
		if ($$(".menu .mi.open").length) {
			$$(".menu .mi").forEach(x => x.classList.remove("open"));
			mi.classList.add("open");
		}
	});
});
document.addEventListener("click", () => $$(".menu .mi").forEach(x => x.classList.remove("open")));

/* ISE-style tool palette */
$$("#canvasToolbar button").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));

/* View menu: crossing-style label reflects the current mode */
function updateHopMenuLabel() {
	const b = $("#miHops");
	if (b) b.textContent = HOP_STYLE === "hop"
		? "⤴ จุดตัดสาย: สะพานข้าม (คลิกเพื่อสลับ)"
		: "⤴ จุดตัดสาย: เรียบ แบบ ISE (คลิกเพื่อสลับ)";
}
updateHopMenuLabel();

/* Canvas hint: dismissible, remembered across sessions */
const HINT_KEY = "schstudio.hintDismissed";
try { if (localStorage.getItem(HINT_KEY) === "1") $("#canvasHint").style.display = "none"; } catch (_) { }
$("#hintClose").addEventListener("click", () => {
	$("#canvasHint").style.display = "none";
	try { localStorage.setItem(HINT_KEY, "1"); } catch (_) { }
});

/* Action dispatcher */
document.addEventListener("click", ev => {
	const a = ev.target.closest("[data-act]");
	if (!a) return;
	const act = a.dataset.act;
	switch (act) {
		case "new-project": newProject(); break;
		case "open-project": openProjectFromFile(); break;
		case "save-project": saveProjectToFile(); break;
		case "save-as-project": {
			const nm = prompt("บันทึกเป็นชื่อโปรเจกต์:", state.project.name || "my_project");
			if (nm === null || !nm.trim()) return;
			$("#projectName").value = sanId(nm.trim());
			saveProjectToFile();
			break;
		}
		case "new-sch": {
			const nm = prompt("ชื่อ schematic ใหม่:", "sch_" + (Object.keys(state.project.schematics).length + 1));
			if (!nm) return;
			const id = uid("sch");
			state.project.schematics[id] = blankSchematic(id, uniqueSchName(nm, id));
			openSchTab(id);
			snapshot(); renderAll();
			break;
		}
		case "rename-sch": {
			const sch = activeSch(); if (!sch) return;
			const nm = prompt("เปลี่ยนชื่อ schematic:", sch.name);
			if (nm) { sch.name = uniqueSchName(nm, sch.id); snapshot(); renderAll(); }
			break;
		}
		case "set-top": {
			if (!state.activeId) return;
			state.project.topId = state.activeId;
			snapshot(); renderAll();
			toast("ตั้งเป็น top entity: " + activeSch().name, "ok");
			break;
		}
		case "gen-vhdl": generateVHDL(); break;
		case "export-vhdl": exportVhdlFile(); break;
		case "export-all": exportAllVhdl(); break;
		case "wizard": openWizard(); break;
		case "synth": runSynthesis(); break;
		case "rename-wire": {
			const id = Array.from(state.selection)[0];
			const w = activeSch().wires.find(x => x.id === id);
			if (!w) { toast("เลือกสายก่อน", "warn"); return; }
			applyWireName(w, prompt("ตั้งชื่อสาย (บัสต้องลากจากพอร์ต >1 bit ของ component):", w.name || ""));
			break;
		}
		case "undo": undo(); break;
		case "redo": redo(); break;
		case "duplicate": duplicateSelection(); break;
		case "copy": copySelection(); break;
		case "paste": pasteClipboard(); break;
		case "cut": copySelection(); deleteSelection(); break;
		case "import-custom": importCustomComponent(); break;
		case "import-vhdl": importVhdlFile(); break;
		case "export-active-custom": exportActiveAsCustom(); break;
		case "delete-sel": deleteSelection(); break;
		case "clear-sch": {
			if (!confirm("ล้าง schematic นี้?")) return;
			const sch = activeSch(); sch.components = []; sch.wires = [];
			state.selection.clear(); snapshot(); renderAll();
			break;
		}
		case "zoom-in": zoomBy(1.2); break;
		case "zoom-out": zoomBy(1 / 1.2); break;
		case "zoom-100": zoom100(); break;
		case "zoom-fit": zoomFit(); break;
		case "toggle-hops": {
			HOP_STYLE = HOP_STYLE === "hop" ? "plain" : "hop";
			try { localStorage.setItem("schstudio.hopStyle", HOP_STYLE); } catch (_) { }
			updateHopMenuLabel();
			render();
			toast(HOP_STYLE === "hop" ? "จุดตัดสาย: สะพานข้าม (hop)" : "จุดตัดสาย: เรียบ (แบบ ISE)", "ok");
			break;
		}
		case "show-hint": {
			try { localStorage.removeItem(HINT_KEY); } catch (_) { }
			$("#canvasHint").style.display = "";
			break;
		}
		case "copy-vhdl": {
			if (!$("#vhdlOutput").dataset.raw) generateVHDL();   // never copy empty
			const t = $("#vhdlOutput").dataset.raw || "";
			if (!t) { toast("ยังไม่มีโค้ดให้คัดลอก", "warn"); break; }
			navigator.clipboard.writeText(t).then(() => toast("คัดลอกแล้ว", "ok"));
			break;
		}
		case "download-vhdl": exportVhdlFile(); break;
	}
});

$("#projectName").addEventListener("change", ev => {
	state.project.name = sanId(ev.target.value);
});

/* =========================================================================
   STATUS BAR
   ========================================================================= */
function updateStatus() {
	updateMouseStat();   // keep the zoom % current after wheel/button zoom
	const sch = activeSch();
	if (!sch) { $("#statCounts").textContent = "no schematic"; return; }
	$("#statCounts").textContent = `${sch.components.length} components · ${sch.wires.length} wires · top: ${state.project.schematics[state.project.topId]?.name || "-"}`;
}

/* =========================================================================
   FULL RENDER + INIT
   ========================================================================= */
function renderAll() {
	renderSchTabs();
	renderProjectTree();
	renderPalette();
	render();
	renderInspector();
}

function init() {
	let restored = false;
	try { restored = loadAutosave(); } catch (e) { }
	if (!restored) {
		state.activeId = Object.keys(state.project.schematics)[0];
		state.openTabs = [state.activeId];
		// seed half adder
		const sch = activeSch();
		const ia = { id: uid("c"), type: "IN", x: 88, y: 110, params: { name: "a", width: 1 } };
		const ib = { id: uid("c"), type: "IN", x: 88, y: 132, params: { name: "b", width: 1 } };
		const x = { id: uid("c"), type: "XOR", x: 264, y: 110, params: { inputs: 2 } };
		const an = { id: uid("c"), type: "AND", x: 264, y: 220, params: { inputs: 2 } };
		const os = { id: uid("c"), type: "OUT", x: 484, y: 121, params: { name: "sum", width: 1 } };
		const oc = { id: uid("c"), type: "OUT", x: 484, y: 231, params: { name: "cout", width: 1 } };
		sch.components.push(ia, ib, x, an, os, oc);
		sch.wires.push(
			{ id: uid("w"), from: { cid: ia.id, pid: "o" }, to: { cid: x.id, pid: "i0" }, name: "", width: 1 },
			{ id: uid("w"), from: { cid: ib.id, pid: "o" }, to: { cid: x.id, pid: "i1" }, name: "", width: 1 },
			{ id: uid("w"), from: { cid: ia.id, pid: "o" }, to: { cid: an.id, pid: "i0" }, name: "", width: 1 },
			{ id: uid("w"), from: { cid: ib.id, pid: "o" }, to: { cid: an.id, pid: "i1" }, name: "", width: 1 },
			{ id: uid("w"), from: { cid: x.id, pid: "o" }, to: { cid: os.id, pid: "i" }, name: "sum_w", width: 1 },
			{ id: uid("w"), from: { cid: an.id, pid: "o" }, to: { cid: oc.id, pid: "i" }, name: "carry", width: 1 }
		);
		normalizePortFanout(sch);   // fanout from a/b shows connection dots
		snapshot();
	}
	if (restored) {
		// an old autosave may carry junction columns / staircase legs placed by older
		// routing — re-run the layout healers once so stale overlaps fix themselves
		try { healLayout(); } catch (e) { }
	}
	renderAll();
	startAutoSave();
	toast("Schematic Studio — พร้อมใช้งาน", "ok", 1800);
}
init();