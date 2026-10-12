"use strict";

const SVGNS = "http://www.w3.org/2000/svg";

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

const canvas = $("#canvas");

const GRID = 11;
const AUTOSAVE_KEY = "schstudio.autosave.v2";
const AUTOSAVE_MS = 4000;

let HOP_STYLE = "plain";

try {
	HOP_STYLE = localStorage.getItem("schstudio.hopStyle") || "plain";
} catch (_) {}

let AUTO_ARRANGE = true;
try {
	AUTO_ARRANGE = localStorage.getItem("schstudio.autoArrange") !== "0";
} catch (_) {}

/* VHDL round-trip: the exported .vhd carries the schematic itself in a comment
   block (see layoutStamp() in 13-vhdl-generator.js) between these two markers, so
   Import gives back the SAME gates in the SAME places. Hand-written VHDL has no
   block and falls back to the AST rebuild. */
const LAYOUT_TAG_BEGIN = "-- @SCHEMATIC-STUDIO-LAYOUT-BEGIN";
const LAYOUT_TAG_END = "-- @SCHEMATIC-STUDIO-LAYOUT-END";

let _uidN = 1;

const uid = (prefix = "i") => prefix + _uidN++;

const VHDL_RESERVED = new Set(
	(
		"abs access after alias all and architecture array assert attribute " +
		"begin block body buffer bus case component configuration constant " +
		"disconnect downto else elsif end entity exit file for function " +
		"generate generic group guarded if impure in inertial inout is label " +
		"library linkage literal loop map mod nand new next nor not null of on " +
		"open or others out package port postponed procedure process pure range " +
		"record register reject rem report return rol ror select severity shared " +
		"signal sla sll sra srl subtype then to transport type unaffected units " +
		"until use variable wait when while with xnor xor"
	).split(" ")
);

/* Filename for anything the browser downloads. Every export lands in the same
   Downloads folder, so each one is stamped with the moment it was made — a second
   export never becomes "top (1).vhd". The stem is then stripped to letters and digits
   only: no spaces, no punctuation, nothing a Vivado tcl path can trip over, and Thai
   names (which have no ASCII form) fall back to the given default. */
const _dlIssued = new Set();
function dlName(base, ext, fallback) {
	const d = new Date(), z = n => String(n).padStart(2, "0");
	const ts = "" + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate())
		+ z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
	const stem = String(base == null ? "" : base).replace(/[^A-Za-z0-9]/g, "") || fallback || "schematic";
	// the stamp only resolves to the second, and a double-click on Export fires twice
	// inside one — at which point the browser itself appends " (1)", a space and two
	// brackets, exactly what this is here to avoid. Bump a digit instead.
	let n = ts + stem + ext, k = 1;
	while (_dlIssued.has(n)) n = ts + stem + (++k) + ext;
	_dlIssued.add(n);
	return n;
}

const sanId = value => {
	let result = (value || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	if (!result) result = "net";
	if (/^[0-9]/.test(result)) result = "n_" + result;
	if (VHDL_RESERVED.has(result)) result += "_s";

	return result;
};

const clamp = (value, min, max) =>
	Math.max(min, Math.min(max, value));

const snap = value =>
	Math.round(value / GRID) * GRID;

const esc = value =>
	String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

function el(tag, attrs = {}, children = []) {
	const element = document.createElementNS(SVGNS, tag);

	for (const key in attrs) {
		if (attrs[key] !== undefined && attrs[key] !== null) {
			element.setAttribute(key, attrs[key]);
		}
	}

	for (const child of children) {
		if (child) element.appendChild(child);
	}

	return element;
}

function txt(x, y, value, options = {}) {
	const text = el("text", {
		x,
		y,
		fill: options.fill || "var(--ink)",
		"text-anchor": options.anchor || "start",
		"font-size": options.size || 11,
		"font-weight": options.weight || 500
	});

	text.textContent = value;
	return text;
}

function toast(message, kind = "info", timeout = 2400) {
	const stack = $("#toastStack");
	if (!stack) return;

	while (stack.children.length >= 4) {
		stack.firstChild.remove();
	}

	const item = document.createElement("div");
	item.className =
		"toast " +
		({ info: "", ok: "ok", warn: "warn", err: "err" }[kind] || "");

	item.textContent = message;
	stack.appendChild(item);

	setTimeout(() => {
		item.style.opacity = "0";
		item.style.transition = ".25s";

		setTimeout(() => item.remove(), 250);
	}, timeout);
}
