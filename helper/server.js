#!/usr/bin/env node
"use strict";

/* Schematic Studio board helper — the bridge between the page and Vivado.
   A web page cannot start processes, and Vivado has no API besides Tcl, so this
   small server on 127.0.0.1 keeps ONE `vivado -mode tcl` session open (saving its
   start-up on every build), feeds it build.tcl / program.tcl, and streams what it
   prints back to the page as Server-Sent Events.

   Usage:  node helper/server.js
   Env:    VIVADO_BIN  path to vivado          (default ~/Vivado/2025.2/Vivado/bin/vivado)
           S2V_PORT    listen port              (default 7357)
           S2V_HOME    where builds are written (default ~/.schem2vhdl)
           S2V_TOKEN   fixed token instead of a random one (tests)

   Security: it only listens on loopback, checks Host (DNS rebinding), accepts an
   Origin only from file:// ("null") or localhost, and every API call must carry
   the token printed at start-up, so no other web page can trigger a build.
   No dependencies beyond Node's standard library. */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = +process.env.S2V_PORT || 7357;
const VIVADO = process.env.VIVADO_BIN || path.join(os.homedir(), "Vivado/2025.2/Vivado/bin/vivado");
const HOME = process.env.S2V_HOME || path.join(os.homedir(), ".schem2vhdl");
const BUILD_ROOT = path.join(HOME, "build");
const TOKEN = process.env.S2V_TOKEN || crypto.randomBytes(16).toString("hex");
const HELPER_DIR = __dirname;
const APP_ROOT = path.resolve(__dirname, "..");
const MAX_BODY = 8 * 1024 * 1024;

/* ---------- the one Vivado session ---------- */
/* Jobs run strictly one after another: Vivado's in-memory design (and the JTAG
   cable) are single-user, so a second build waits its turn instead of running in
   parallel. Each job is wrapped in catch{} and ends with a sentinel line carrying
   its id and Tcl return code, which is how we know the job — not the session — is
   finished. If Vivado dies the running job fails and the next one starts afresh. */
class VivadoSession {
	constructor(bin) {
		this.bin = bin;
		this.proc = null;
		this.chain = Promise.resolve();
		this.pending = 0;
		this.heavy = 0;        // queued builds / programming runs (minutes, not seconds)
		this.current = null;
		this.seq = 0;
		this.buf = "";
	}
	found() {
		try { fs.accessSync(this.bin, fs.constants.X_OK); return true; } catch (_) { return false; }
	}
	start() {
		if (this.proc) return;
		const p = spawn(this.bin, ["-mode", "tcl", "-nojournal", "-nolog", "-notrace"], {
			cwd: HOME, stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = p;
		this.buf = "";
		const onData = d => {
			this.buf += d.toString();
			let i;
			while ((i = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, i).replace(/\r$/, "");
				this.buf = this.buf.slice(i + 1);
				this.line(line);
			}
		};
		p.stdout.on("data", onData);
		p.stderr.on("data", onData);
		p.on("error", err => this.died("could not start Vivado: " + err.message));
		p.on("exit", code => this.died("Vivado exited (code " + code + ")"));
		p.stdin.on("error", () => { });
	}
	died(why) {
		this.proc = null;
		const cur = this.current;
		this.current = null;
		if (cur) { cur.onLine("S2V_ERROR: " + why); cur.resolve({ rc: -1, msg: why }); }
	}
	line(raw) {
		// the interactive prompt has no newline of its own and ends up glued to the
		// front of whatever is printed next
		const line = raw.replace(/^(Vivado% )+/, "");
		const cur = this.current;
		const m = /@@S2V_END@@ (\d+) (-?\d+)/.exec(line);
		if (m && cur && +m[1] === cur.id) {
			this.current = null;
			cur.resolve({ rc: +m[2] });
			return;
		}
		if (cur && line !== "") cur.onLine(line);
	}
	/* queue a Tcl script; resolves { rc } once it has run (rc 0 = no Tcl error).
	   `heavy` marks a build or programming run, which is what busy() reports. */
	run(tcl, onLine, onStart, heavy) {
		this.pending++;
		if (heavy) this.heavy++;
		const job = this.chain.then(() => new Promise(resolve => {
			this.start();
			const id = ++this.seq;
			this.current = { id, onLine: onLine || (() => { }), resolve };
			if (onStart) onStart();
			this.proc.stdin.write(
				`set ::s2v_rc [catch {\n${tcl}\n} ::s2v_msg]\n` +
				`if {$::s2v_rc} {puts "S2V_ERROR: [string map {"\\n" " "} $::s2v_msg]"}\n` +
				`puts "@@S2V_END@@ ${id} $::s2v_rc"\n`);
		})).finally(() => { this.pending--; if (heavy) this.heavy--; });
		this.chain = job.catch(() => { });
		return job;
	}
	busy() { return this.heavy > 0; }
	stop() { if (this.proc) { try { this.proc.stdin.write("exit\n"); } catch (_) { } } }
}
const vivado = new VivadoSession(VIVADO);

/* ---------- small helpers ---------- */
const tclStr = s => "{" + String(s).replace(/[{}\\]/g, "") + "}";   // paths here never hold braces
let lastBuild = null;      // { id, dir, ok }
let cable = null;          // last probe: { targets, devices, at }

function stamp() {
	const d = new Date(), z = n => String(n).padStart(2, "0");
	return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}
function newBuildDir() {
	fs.mkdirSync(BUILD_ROOT, { recursive: true });
	let id = stamp(), k = 1;
	while (fs.existsSync(path.join(BUILD_ROOT, id))) id = stamp() + "-" + (++k);
	const dir = path.join(BUILD_ROOT, id);
	fs.mkdirSync(dir);
	return { id, dir };
}
function readIf(f) { try { return fs.readFileSync(f, "utf8"); } catch (_) { return null; } }

/* the handful of numbers worth showing from Vivado's reports */
function utilSummary(rpt) {
	if (!rpt) return null;
	// | Slice LUTs | Used | Fixed | Prohibited | Available | Util% |  — first table that has it
	const pick = label => {
		const line = rpt.split("\n").find(l => new RegExp("^\\|\\s*" + label + "\\s*\\|").test(l));
		if (!line) return null;
		const c = line.split("|").map(s => s.trim()).filter(Boolean);
		return c.length >= 6 ? { used: +c[1], avail: +c[4], pct: c[5] } : null;
	};
	return { luts: pick("Slice LUTs"), regs: pick("Slice Registers"), iob: pick("Bonded IOB") };
}
function timingSummary(rpt) {
	if (!rpt) return null;
	const met = /All user specified timing constraints are met/.test(rpt);
	const failed = /Timing constraints are not met/.test(rpt);
	const noClock = /There are no user specified timing constraints/.test(rpt);
	// the first WNS column is the Design Timing Summary (NA without a clock)
	const m = /WNS\(ns\)[^\n]*\n[ -]+\n\s*(\S+)/.exec(rpt);
	return { met: met || (!failed && noClock), constrained: !noClock, wns: m && m[1] !== "NA" ? m[1] : null };
}

/* ---------- HTTP ---------- */
function allowedOrigin(origin) {
	if (!origin) return true;               // not a browser (curl, tests) — the token decides
	if (origin === "null") return true;     // the app opened from file://
	return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
function allowedHost(host) {
	return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}
function tokenOk(req) {
	const t = Buffer.from(String(req.headers["x-s2v-token"] || ""));
	const want = Buffer.from(TOKEN);
	return t.length === want.length && crypto.timingSafeEqual(t, want);
}
function cors(req, res) {
	const o = req.headers.origin;
	if (o && allowedOrigin(o)) {
		res.setHeader("Access-Control-Allow-Origin", o);
		res.setHeader("Vary", "Origin");
		res.setHeader("Access-Control-Allow-Headers", "content-type, x-s2v-token");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		// Chrome's Private Network Access: a file:// page reaching loopback is asked first
		res.setHeader("Access-Control-Allow-Private-Network", "true");
	}
}
function json(res, code, obj) {
	res.writeHead(code, { "Content-Type": "application/json" });
	res.end(JSON.stringify(obj));
}
function readBody(req) {
	return new Promise((resolve, reject) => {
		let n = 0;
		const parts = [];
		req.on("data", c => {
			n += c.length;
			if (n > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
			parts.push(c);
		});
		req.on("end", () => {
			try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); }
			catch (e) { reject(new Error("invalid JSON")); }
		});
		req.on("error", reject);
	});
}
/* SSE over the POST response itself: the page reads it with fetch(), which —
   unlike EventSource — can send the token header and a body */
function sse(res) {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
	return (event, data) => {
		if (res.writableEnded) return;
		const payload = typeof data === "string" ? data : JSON.stringify(data);
		res.write(`event: ${event}\n` + payload.split("\n").map(l => "data: " + l).join("\n") + "\n\n");
	};
}

async function handleBuild(req, res) {
	const body = await readBody(req);
	const top = String(body.top || "");
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(top)) return json(res, 400, { error: "bad top entity name" });
	const files = body.files && typeof body.files === "object" ? body.files : {};
	const names = Object.keys(files);
	if (!names.length) return json(res, 400, { error: "no VHDL files" });
	if (names.some(n => !/^[A-Za-z0-9_]+\.vhd$/.test(n) || typeof files[n] !== "string"))
		return json(res, 400, { error: "file names must look like name.vhd" });
	if (typeof body.xdc !== "string") return json(res, 400, { error: "missing xdc" });
	if (!vivado.found()) return json(res, 503, { error: "Vivado not found at " + VIVADO });

	const { id, dir } = newBuildDir();
	names.forEach(n => fs.writeFileSync(path.join(dir, n), files[n]));
	fs.writeFileSync(path.join(dir, "top.xdc"), body.xdc);

	const send = sse(res);
	const log = [];
	let gone = false;
	res.on("close", () => { gone = true; });
	send("queued", { id, ahead: vivado.pending });
	let startedAt = 0;
	const r = await vivado.run(
		`cd ${tclStr(dir)}\nset ::s2v_top ${top}\nsource ${tclStr(path.join(HELPER_DIR, "build.tcl"))}`,
		line => { log.push(line); if (!gone) send("log", line); },
		() => { startedAt = Date.now(); send("start", { id }); }, true);
	const endedAt = Date.now();
	fs.writeFileSync(path.join(dir, "build.log"), log.join("\n") + "\n");
	const errors = log.filter(l => /^ERROR:/.test(l) || /^S2V_ERROR:/.test(l));
	const critical = log.filter(l => /^CRITICAL WARNING:/.test(l));
	const has = f => fs.existsSync(path.join(dir, f));
	const ok = r.rc === 0 && has("top.bit") && has("top.mcs");
	let pins = null;
	try { pins = JSON.parse(readIf(path.join(dir, "pins.json"))); } catch (_) { }
	const result = {
		id, ok, rc: r.rc, dir, startedAt, endedAt,
		errors, criticalWarnings: critical,
		utilization: utilSummary(readIf(path.join(dir, "utilization.rpt"))),
		timing: timingSummary(readIf(path.join(dir, "timing.rpt"))),
		pins,
	};
	if (ok) lastBuild = { id, dir, ok };
	send("done", result);
	res.end();
}

async function handleProgram(req, res) {
	const body = await readBody(req);
	const target = body.target;
	if (target !== "sram" && target !== "flash") return json(res, 400, { error: "target must be sram or flash" });
	let b = lastBuild;
	if (body.buildId) {
		if (!/^[\w-]+$/.test(body.buildId)) return json(res, 400, { error: "bad buildId" });
		const dir = path.join(BUILD_ROOT, body.buildId);
		b = fs.existsSync(path.join(dir, "top.bit")) ? { id: body.buildId, dir } : null;
	}
	if (!b) return json(res, 409, { error: "no successful build yet — build first" });
	if (!vivado.found()) return json(res, 503, { error: "Vivado not found at " + VIVADO });

	const send = sse(res);
	const log = [];
	let gone = false;
	res.on("close", () => { gone = true; });
	send("queued", { id: b.id, ahead: vivado.pending });
	const r = await vivado.run(
		`cd ${tclStr(b.dir)}\nset ::s2v_target ${target}\nsource ${tclStr(path.join(HELPER_DIR, "program.tcl"))}`,
		line => { log.push(line); if (!gone) send("log", line); },
		() => send("start", { id: b.id, target }), true);
	fs.writeFileSync(path.join(b.dir, `program-${target}.log`), log.join("\n") + "\n");
	const doneLine = log.map(l => /^S2V_DONE_PIN (\d)/.exec(l)).filter(Boolean).pop();
	const ok = r.rc === 0 && log.some(l => l.startsWith("S2V_PROGRAM_OK"));
	send("done", {
		ok, rc: r.rc, target, buildId: b.id,
		donePin: doneLine ? +doneLine[1] : null,
		verified: target === "flash" ? log.includes("S2V_FLASH_VERIFIED") : undefined,
		errors: log.filter(l => /^ERROR:/.test(l) || /^S2V_ERROR:/.test(l)),
	});
	res.end();
}

async function handleStatus(req, res, url) {
	const found = vivado.found();
	// probing opens the hardware manager, so it queues like any job — but behind a
	// build it would wait a minute, so then the last answer is returned instead
	if (found && url.searchParams.get("probe") === "1" && !vivado.busy()) {
		const lines = [];
		await vivado.run(`source ${tclStr(path.join(HELPER_DIR, "probe.tcl"))}`, l => lines.push(l));
		const m = lines.map(l => /^S2V_PROBE (\d+)\s*(.*)$/.exec(l)).filter(Boolean).pop();
		cable = m ? { targets: +m[1], devices: m[2].split(/\s+/).filter(Boolean), at: Date.now() } : { targets: 0, devices: [], at: Date.now(), error: lines.slice(-3).join(" ") };
	}
	json(res, 200, {
		ok: true, vivado: { path: VIVADO, found }, busy: vivado.busy(), pending: vivado.pending,
		lastBuild: lastBuild && { id: lastBuild.id }, cable,
		board: { part: "xc7s15ftgb196-1", flash: "s25fl064l-spi-x1_x2_x4" },
	});
}

/* the app itself, so http://127.0.0.1:7357/ works too (same origin, token in the
   URL fragment); read-only, and only the files the page is made of */
const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".ico": "image/x-icon" };
function serveStatic(req, res, url) {
	let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "schematic2vhdl.html";
	const full = path.resolve(APP_ROOT, rel);
	rel = path.relative(APP_ROOT, full);
	const okPath = rel === "schematic2vhdl.html" || rel === "schematic2vhdl.css" || /^(js|img)[\\/][^\\/]+$/.test(rel);
	const type = STATIC_TYPES[path.extname(full)];
	if (!okPath || !type || !fs.existsSync(full)) { res.writeHead(404); res.end("not found"); return; }
	res.writeHead(200, { "Content-Type": type });
	if (rel === "schematic2vhdl.html") {
		// tell the page its API is right here, whatever port this helper is on
		res.end(fs.readFileSync(full, "utf8").replace("<head>", '<head>\n\t<meta name="s2v-helper" content="same-origin">'));
		return;
	}
	fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
	try {
		if (!allowedHost(req.headers.host)) { res.writeHead(403); res.end("bad host"); return; }
		const origin = req.headers.origin;
		if (!allowedOrigin(origin)) { res.writeHead(403); res.end("origin not allowed"); return; }
		cors(req, res);
		const url = new URL(req.url, `http://${req.headers.host}`);
		if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
		const api = url.pathname === "/status" || url.pathname === "/build" || url.pathname === "/program";
		if (!api) {
			if (req.method === "GET") return serveStatic(req, res, url);
			res.writeHead(404); res.end(); return;
		}
		if (!tokenOk(req)) return json(res, 403, { error: "missing or wrong token" });
		if (url.pathname === "/status" && req.method === "GET") return await handleStatus(req, res, url);
		if (url.pathname === "/build" && req.method === "POST") return await handleBuild(req, res);
		if (url.pathname === "/program" && req.method === "POST") return await handleProgram(req, res);
		json(res, 405, { error: "method not allowed" });
	} catch (e) {
		if (!res.headersSent) json(res, 400, { error: e.message || String(e) });
		else res.end();
	}
});

if (require.main === module) {
	fs.mkdirSync(HOME, { recursive: true });
	try { fs.writeFileSync(path.join(HOME, "token"), TOKEN + "\n", { mode: 0o600 }); } catch (_) { }
	server.listen(PORT, "127.0.0.1", () => {
		console.log(`Schematic Studio helper on http://127.0.0.1:${PORT}`);
		console.log(`  Vivado : ${VIVADO}${vivado.found() ? "" : "   (NOT FOUND — set VIVADO_BIN)"}`);
		console.log(`  builds : ${BUILD_ROOT}`);
		console.log(`  token  : ${TOKEN}`);
		console.log(`Open  http://127.0.0.1:${PORT}/#token=${TOKEN}`);
		console.log(`or paste the token into the app (Build tab) when it asks.`);
		// warm the session up now so the first build doesn't pay for Vivado's start-up
		if (vivado.found()) vivado.run("puts S2V_READY");
	});
	const bye = () => { vivado.stop(); process.exit(0); };
	process.on("SIGINT", bye);
	process.on("SIGTERM", bye);
}

module.exports = { server, vivado, utilSummary, timingSummary };
