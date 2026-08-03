"use strict";

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
