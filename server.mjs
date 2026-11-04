/* Muse Maker server — real projects, real git, real rendering.
   Brain: Muse only. The superagent and every subagent are headless Muse sessions
   (`muse exec`, Meta provider) running muse-* models — Muse Spark, Muse Wonder, etc.
   Auth is your Muse login on this machine (`muse login`). No API keys are stored here.
   Model choice in .env: MUSE_MODEL_PLANNER / MUSE_MODEL_WORKER (or MUSE_MODEL for both).
   Everything else (files, git, history, preview) is local and always real. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(ROOT, "projects");
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
/* Load .env next to this file. Values in .env win over shell env for these keys,
   so the key you paste in .env is the key that runs. Never commit .env. */
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env yet — shell env still works */ }
const PORT = process.env.PORT || 5174;
const SHOTS_DIR = path.join(DATA_DIR, "shots");
const CHROME_BIN = process.env.CHROME_BIN || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "google-chrome", "chromium"].find((c) => { try { return c.includes("/") ? fs.existsSync(c) : true; } catch { return false; } });
const MUSE_BIN = process.env.MUSE_BIN || "muse";
let PLANNER_MODEL = process.env.MUSE_MODEL_PLANNER || process.env.MUSE_MODEL || "muse-wonder-1.0";
const WORKER_MODEL = process.env.MUSE_MODEL_WORKER || process.env.MUSE_MODEL || "muse-spark-1.3";
let MUSE_OK = null; // null=unknown, true=muse exec works, false=CLI missing/logged out

export const AGENTS = {
  mira: { name: "Mira", role: "Designer", ini: "M", cls: "av-mira", color: "#E4573D", icon: "pencil", skills: "look, colour, layout, brand, typography, poster, polish" },
  kai:  { name: "Kai", role: "Builder", ini: "K", cls: "av-kai", color: "#0071E3", icon: "code", skills: "features, buttons, pages, charts, forms, functionality" },
  noor: { name: "Noor", role: "Checker", ini: "N", cls: "av-noor", color: "#30A46C", icon: "shield", skills: "checking, contrast, accessibility, consistency, proofreading" },
  leo:  { name: "Leo", role: "Tester", ini: "L", cls: "av-leo", color: "#8E8E93", icon: "flask", skills: "testing on devices, tapping, flows, edge cases" }
};
const AGENT_KEYS = () => Object.keys(state.agents || AGENTS);
const agentOf = (id) => (state.agents || AGENTS)[id] || { name: "Former teammate", role: "—", ini: "?", cls: "", color: "#8E8E93", icon: "spark", skills: "" };
const checkerOf = () => { const all = state.agents || AGENTS; const hit = Object.entries(all).find(([, a]) => /check/i.test(a.role)); return hit ? { id: hit[0], ...hit[1] } : { id: Object.keys(all)[0], ...all[Object.keys(all)[0]] }; };

/* ---------- state ---------- */
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SHOTS_DIR, { recursive: true });
let state = { projects: [], tasks: [], feed: [] };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { /* first run */ }
if (!state.agents) state.agents = JSON.parse(JSON.stringify(AGENTS));
function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
/* A step marked "doing" when the server starts was orphaned by a restart/stop:
   never leave the user staring at a spinner that will never finish. */
{
  let touched = false;
  for (const t of state.tasks || []) if (t.status === "doing") {
    t.status = "todo"; t.progress = 0; t.phase = "Stopped before it finished";
    t.error = "This step stopped before it finished — it was not saved as a completed step. Press “Run this step” to continue; work already in the files is auto-saved first.";
    t.interruptedAt = Date.now(); touched = true;
  }
  if (touched) save();
}
const uid = (p) => p + Date.now().toString(36) + Math.floor(Math.random() * 999).toString(36);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "project";
function feed(agent, text) { state.feed.unshift({ id: uid("f"), agent, text, at: Date.now() }); state.feed = state.feed.slice(0, 30); }
/* The team voice: VERY short. One line, plain words, only when something actually happened. */
function say(agentId, text) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  feed(agentId, clean.length > 110 ? clean.slice(0, 107) + "…" : clean);
}
const shortTitle = (t, n = 42) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
function setPhase(t, phase, progress) { if (phase) t.phase = phase; if (typeof progress === "number") t.progress = progress; t.phaseAt = Date.now(); save(); }
const projById = (id) => state.projects.find((p) => p.id === id);
const projDir = (p) => path.join(PROJECTS_DIR, p.dir);
function publicTask(t) { return t; }

/* ---------- git ---------- */
async function git(dir, args) { const { stdout } = await run("git", ["-C", dir, ...args], { timeout: 30000 }); return stdout; }
async function gitInit(dir) {
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "team@musemaker.local"]);
  await git(dir, ["config", "user.name", "Muse Maker"]);
}
async function commitAll(dir, message) {
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", message]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}
const shotPath = (p, hash) => path.join(SHOTS_DIR, p.id, hash + ".png");
async function history(p) {
  try {
    const out = await git(projDir(p), ["log", "--reverse", "--format=%H%x7c%h%x7c%s%x7c%ct"]);
    return out.trim().split("\n").filter(Boolean).map((line, i) => {
      const [hash, short, message, ts] = line.split("|");
      return { step: i + 1, hash, short, message, at: Number(ts) * 1000, shot: fs.existsSync(shotPath(p, hash)) };
    });
  } catch { return []; }
}
/* Per-step screenshot via headless Chrome (already on the machine; never installed by us). */
async function captureShot(p, hash) {
  if (!CHROME_BIN || !hash) return false;
  try {
    const out = shotPath(p, hash); fs.mkdirSync(path.dirname(out), { recursive: true });
    await run(CHROME_BIN, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--run-all-compositor-stages-before-draw", "--virtual-time-budget=20000", "--window-size=1100,750", "--screenshot=" + out, `http://localhost:${PORT}/preview/${p.id}/at/${hash}/`], { timeout: 90000 });
    return fs.existsSync(out) && fs.statSync(out).size > 0;
  } catch { return false; }
}
/* Framework (Vite + React) projects: install once, build per step, snapshot each build by commit. */
async function buildProject(p) {
  const dir = projDir(p);
  const { stdout, stderr } = await run("npm", ["run", "build"], { cwd: dir, timeout: 240000, maxBuffer: 16 * 1024 * 1024, env: process.env });
  return stdout + stderr;
}
async function snapshotBuild(p, hash) {
  try {
    const dir = projDir(p); const dist = path.join(dir, "dist"); if (!fs.existsSync(dist)) return;
    const dest = path.join(dir, ".mm-builds", hash); fs.rmSync(dest, { recursive: true, force: true }); fs.cpSync(dist, dest, { recursive: true });
  } catch { /* snapshot is best-effort */ }
}
/* Non-web projects (python/mac/unity): no live page to click — the middle shows the
   latest build's screen. Builds are real commands on this Mac; failures stay visible. */
function unityEditor() {
  const base = "/Applications/Unity/Hub/Editor";
  try { const v = fs.readdirSync(base).sort().pop(); const bin = v && path.join(base, v, "Unity.app/Contents/MacOS/Unity"); if (bin && fs.existsSync(bin)) return bin; } catch { /* not installed */ }
  return null;
}
async function runBuild(p) {
  const dir = projDir(p);
  if (p.framework) { await buildProject(p); return "React build finished"; }
  if (p.kind === "python") { const { stdout, stderr } = await run("python3", ["main.py"], { cwd: dir, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }); return (stdout + stderr).trim().slice(-500) || "Ran main.py"; }
  if (p.kind === "mac") { const { stdout, stderr } = await run("swift", ["build"], { cwd: dir, timeout: 600000, maxBuffer: 16 * 1024 * 1024 }); return (stdout + stderr).trim().slice(-500) || "Swift build finished"; }
  if (p.kind === "unity") {
    const editor = unityEditor();
    if (!editor) throw new Error("Unity Editor not found on this Mac (looked in /Applications/Unity/Hub/Editor).");
    const out = path.join(dir, "Build", "Game.app");
    const { stdout, stderr } = await run(editor, ["-batchmode", "-quit", "-nographics", "-projectPath", dir, "-buildOSXUniversalPlayer", out], { timeout: 900000, maxBuffer: 16 * 1024 * 1024 });
    if (!fs.existsSync(out)) throw new Error("Unity finished without producing a build. " + (stdout + stderr).trim().slice(-300));
    return "Unity build finished: Build/Game.app";
  }
  throw new Error("This project doesn't have a build.");
}
function launchDetached(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
async function runApp(p) {
  const dir = projDir(p);
  const log = await runBuild(p);
  p.build = { ok: true, at: Date.now(), log };
  if (p.kind === "python") { p.run = { ok: true, at: Date.now(), log: "Ran main.py — the report above is fresh." }; save(); return p.run; }
  if (p.kind === "mac") {
    const { stdout } = await run("swift", ["build", "--show-bin-path"], { cwd: dir, timeout: 60000 });
    const binDir = stdout.trim().split("\n").pop();
    const bins = fs.readdirSync(binDir).filter((f) => { try { const st = fs.statSync(path.join(binDir, f)); return st.isFile() && (st.mode & 0o111) && !f.endsWith(".dSYM"); } catch { return false; } }).sort((a, b) => a.length - b.length);
    if (!bins.length) throw new Error("Build finished but no runnable app was found in " + binDir);
    /* Kill earlier invisible instances of THIS project's app, then package a real
       .app bundle and open it via LaunchServices — a raw SwiftPM binary launched
       directly can run faceless (no visible window, no Dock presence). */
    try { await run("pkill", ["-f", dir], { timeout: 10000 }); } catch { /* none running */ }
    await new Promise((r) => setTimeout(r, 400));
    const appName = p.name.split("—")[0].trim() || "MakerApp";
    const bundle = path.join(dir, "Build", slug(appName) + ".app");
    const macosDir = path.join(bundle, "Contents", "MacOS");
    fs.mkdirSync(macosDir, { recursive: true });
    fs.copyFileSync(path.join(binDir, bins[0]), path.join(macosDir, bins[0]));
    try { fs.chmodSync(path.join(macosDir, bins[0]), 0o755); } catch { /* already executable */ }
    fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleName</key><string>${escXml(appName)}</string><key>CFBundleDisplayName</key><string>${escXml(appName)}</string><key>CFBundleExecutable</key><string>${escXml(bins[0])}</string><key>CFBundleIdentifier</key><string>local.musemaker.${slug(appName)}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>1.0</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>\n`);
    await launchDetached("open", [bundle]);
    let pid = null;
    for (let i = 0; i < 8 && !pid; i++) { try { const { stdout: pg } = await run("pgrep", ["-f", bundle], { timeout: 10000 }); pid = pg.trim().split("\n")[0]; } catch { await new Promise((r) => setTimeout(r, 500)); } }
    if (!pid) throw new Error("The build is fine, but the app quit right after opening — it likely crashed on launch. Ask a subagent to look at the app code next.");
    let winNote = "window opened";
    try {
      await run("osascript", ["-e", `tell application "System Events" to tell (first application process whose unix id is ${pid}) to set visible to true`], { timeout: 15000 });
      await run("osascript", ["-e", `tell application "System Events" to tell (first application process whose unix id is ${pid}) to set frontmost to true`], { timeout: 15000 });
      const { stdout: wi } = await run("osascript", ["-e", `tell application "System Events" to tell (first application process whose unix id is ${pid}) to return (count of windows)`], { timeout: 15000 });
      if (Number(wi.trim()) < 1) winNote = "app is running but macOS reports no window yet";
    } catch { winNote = "opened (couldn't verify the window — macOS automation permission)"; }
    p.run = { ok: true, at: Date.now(), log: `Opened ${appName} on this Mac — ${winNote}` };
    save(); return p.run;
  }
  if (p.kind === "unity") {
    const app = path.join(dir, "Build", "Game.app");
    await launchDetached("open", [app]);
    p.run = { ok: true, at: Date.now(), log: "Opened Build/Game.app on this Mac" };
    save(); return p.run;
  }
  throw new Error("This project runs in the preview above.");
}
function buildViewHtml(p) {
  const dir = projDir(p);
  const shot = ["screenshot.png", "screenshot.jpg", "ui.png"].find((f) => fs.existsSync(path.join(dir, f)));
  const svg = fs.existsSync(path.join(dir, "ui.svg"));
  const b = p.build;
  const status = b ? (b.ok ? `Last build OK · ${new Date(b.at).toLocaleString()}` : `Last build failed · ${new Date(b.at).toLocaleString()}`) : "Not built yet";
  const log = b?.log ? String(b.log).replace(/</g, "&lt;").slice(-400) : "";
  const img = shot ? `<img src="/preview/${p.id}/artifact/${shot}" alt="Latest build screen">` : svg ? `<img src="/preview/${p.id}/artifact/ui.svg" alt="UI preview">` : `<p style="color:#6E6E73">No build screen yet — press Build.</p>`;
  const sketchNote = !shot && svg ? `<p class="note">UI sketch from the source — press Build, and drop a real screenshot.png in the project to replace it.</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#FBFBFD;color:#1D1D1F;display:flex;flex-direction:column;align-items:center;padding:18px;gap:10px}img{max-width:100%;border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.13)}.note{font-size:12px;color:#6E6E73;margin:0}.status{font-size:12.5px;font-weight:700}.log{font-size:11px;color:#6E6E73;white-space:pre-wrap;max-width:640px;margin:0;text-align:center}</style></head><body>${img}${sketchNote}<p class="status">${status}</p>${log ? `<p class="log">${log}</p>` : ""}</body></html>`;
}
async function setupFramework(p) {
  const dir = projDir(p);
  try {
    p.setup = "installing"; save();
    await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, timeout: 420000, maxBuffer: 16 * 1024 * 1024, env: process.env });
    try { if ((await git(dir, ["status", "--porcelain"])).trim()) await commitAll(dir, "Muse Maker: install dependencies"); } catch { /* lockfile commit is best-effort */ }
    await buildProject(p);
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await snapshotBuild(p, head);
    p.setup = "ready"; delete p.setupError; save();
    void captureShot(p, head);
  } catch (e) {
    p.setup = "failed"; p.setupError = String(e.stderr || e.message || e).slice(-600); save();
  }
}

/* ---------- scaffolds: any browser-renderable project ---------- */
const TEMPLATES = {
  website: [
    { id: "blank", label: "Blank canvas", headline: "", sub: "" },
    { id: "coffee", label: "Coffee shop", headline: "Coffee worth slowing down for.", sub: "Small-batch beans from farms we know by name, roasted the week they ship." },
    { id: "portfolio", label: "Portfolio", headline: "Work that speaks quietly, clearly.", sub: "Selected projects, collaborations, and how to start one together." },
    { id: "restaurant", label: "Restaurant", headline: "Dinner, the way it should taste.", sub: "A short seasonal menu, cooked slowly, served warmly." }
  ],
  app: [
    { id: "blank", label: "Blank canvas", headline: "", sub: "" },
    { id: "fitness", label: "Fitness", headline: "You're on fire.", sub: "Your streak, your rings, your next run — all in one glance." },
    { id: "habits", label: "Habits", headline: "Small steps, daily.", sub: "One tiny promise a day, kept visibly." },
    { id: "finance", label: "Finance", headline: "Know where it goes.", sub: "Every euro, calmly accounted for." }
  ],
  poster: [
    { id: "blank", label: "Blank canvas", headline: "", sub: "" },
    { id: "festival", label: "Festival", headline: "MUSIC<br>IN THE<br>DARK.", sub: "14 acts. One Arctic night. Tickets now." },
    { id: "exhibition", label: "Exhibition", headline: "SEE IT<br>FIRST.", sub: "New work, opening this Friday. Free entry." },
    { id: "sale", label: "Sale", headline: "HALF<br>PRICE.", sub: "This weekend only. When it's gone, it's gone." }
  ],
  dashboard: [
    { id: "blank", label: "Blank canvas", headline: "", sub: "" },
    { id: "sales", label: "Sales", headline: "Are we winning?", sub: "Revenue, customers, and conversion — the three numbers that matter." },
    { id: "support", label: "Support", headline: "Calmer inboxes.", sub: "Tickets resolved, wait times, and happy replies." }
  ],
  slides: [
    { id: "blank", label: "Blank canvas", headline: "", sub: "" },
    { id: "pitch", label: "Pitch", headline: "Your big idea, in one line.", sub: "The problem, the fix, and the ask — in four slides." },
    { id: "lesson", label: "Lesson", headline: "One idea, clearly.", sub: "A short lesson anyone can follow." }
  ],
  shop: [
    { id: "blank", label: "Blank canvas", headline: "", sub: "" },
    { id: "goods", label: "Goods store", headline: "Things made to be kept.", sub: "Heavy materials, honest prices, shipped with care." },
    { id: "plants", label: "Plant shop", headline: "Green, delivered.", sub: "Hard-to-kill plants with simple care cards." }
  ],
  python: [{ id: "blank", label: "Blank tool", headline: "", sub: "" }],
  mac: [{ id: "blank", label: "Blank app", headline: "", sub: "" }],
  unity: [{ id: "blank", label: "Blank game", headline: "", sub: "" }]
};
function scaffold(type, name, color, desc, templateId) {
  let html = scaffoldBase(type, name, color, desc);
  const tpl = (TEMPLATES[type] || []).find((t) => t.id === templateId);
  if (tpl && tpl.headline) {
    html = html.replace(/(<h1[^>]*>)[\s\S]*?(<\/h1>)/, `$1${tpl.headline}$2`);
    if (tpl.sub) html = html.replace(/(<p class="lead">)[\s\S]*?(<\/p>)/, `$1${tpl.sub}$2`).replace(`<p>${desc}</p>`, `<p>${tpl.sub}</p>`);
  }
  return html;
}
function reactFiles(name, color, desc) {
  const short = name.split("—")[0].split("-")[0].trim();
  return {
    "package.json": JSON.stringify({ name: "muse-maker-app", private: true, version: "0.1.0", type: "module", scripts: { dev: "vite", build: "vite build" }, dependencies: { react: "^19.1.0", "react-dom": "^19.1.0" }, devDependencies: { vite: "^6.3.0", "@vitejs/plugin-react": "^4.4.0" } }, null, 2),
    "vite.config.js": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()], base: "./" });\n`,
    ".gitignore": "node_modules\ndist\n.mm-builds\n",
    "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`,
    "src/main.jsx": `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\nimport "./index.css";\ncreateRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);\n`,
    "src/index.css": `:root{--accent:${color}}*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;background:#FBFBFD;color:#1D1D1F}main{max-width:760px;margin:0 auto;padding:28px 22px}h1{font-size:42px;letter-spacing:-.03em;line-height:1.05;margin:8px 0 12px}.lead{color:#6E6E73;font-size:16px;line-height:1.6;max-width:520px}.btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:999px;padding:12px 22px;font-weight:700;font-size:14px;cursor:pointer}.cards{display:flex;gap:12px;margin-top:28px;flex-wrap:wrap}.card{flex:1;min-width:180px;background:#fff;border:1px solid rgba(0,0,0,.07);border-radius:16px;padding:16px;font-size:13px;line-height:1.5;box-shadow:0 4px 18px rgba(0,0,0,.05)}.card b{display:block;font-size:14px;margin-bottom:4px}nav{display:flex;gap:18px;align-items:center;padding:16px 22px;font-size:13px}nav b{font-size:17px;color:var(--accent)}\n`,
    "src/App.jsx": `import { useState } from "react";\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (<>\n    <nav><b>${short}</b></nav>\n    <main>\n      <span style={{color:"var(--accent)",fontWeight:700,fontSize:13,letterSpacing:".06em"}}>${short.toUpperCase()}</span>\n      <h1>A headline worth remembering.</h1>\n      <p className="lead">${desc}</p>\n      <button className="btn" onClick={() => setCount(count + 1)}>Clicked {count} times — it really works</button>\n      <div className="cards">\n        <div className="card"><b>Made with care</b>Every detail considered.</div>\n        <div className="card"><b>Loved locally</b>Built for the people nearby.</div>\n        <div className="card"><b>Start today</b>Two minutes to begin.</div>\n      </div>\n    </main>\n  </>);\n}\n`
  };
}
const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function uiSvg(name, color, desc, kindLabel) {
  const short = name.split("—")[0].split("-")[0].trim();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="760" viewBox="0 0 1100 760">
<rect width="1100" height="760" fill="#FBFBFD"/>
<rect x="70" y="60" width="960" height="640" rx="18" fill="#FFFFFF" stroke="rgba(0,0,0,.08)"/>
<rect x="70" y="60" width="960" height="52" rx="18" fill="#F5F5F7"/>
<circle cx="102" cy="86" r="7" fill="#FF5F57"/><circle cx="128" cy="86" r="7" fill="#FEBC2E"/><circle cx="154" cy="86" r="7" fill="#28C840"/>
<text x="550" y="92" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="15" font-weight="600" fill="#1D1D1F">${escXml(short)}</text>
<text x="120" y="190" font-family="-apple-system,sans-serif" font-size="13" font-weight="700" letter-spacing="2" fill="${color}">${escXml(kindLabel.toUpperCase())}</text>
<text x="120" y="248" font-family="-apple-system,sans-serif" font-size="44" font-weight="700" fill="#1D1D1F">${escXml(short)}</text>
<text x="120" y="292" font-family="-apple-system,sans-serif" font-size="17" fill="#6E6E73">${escXml(desc.slice(0, 90))}</text>
<rect x="120" y="330" width="170" height="46" rx="23" fill="${color}"/>
<text x="205" y="359" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="15" font-weight="700" fill="#FFFFFF">Get started</text>
<rect x="120" y="430" width="280" height="150" rx="14" fill="#FFFFFF" stroke="rgba(0,0,0,.07)"/>
<rect x="450" y="430" width="280" height="150" rx="14" fill="#FFFFFF" stroke="rgba(0,0,0,.07)"/>
<rect x="780" y="430" width="200" height="150" rx="14" fill="#FFFFFF" stroke="rgba(0,0,0,.07)"/>
<text x="145" y="480" font-family="-apple-system,sans-serif" font-size="16" font-weight="700" fill="#1D1D1F">Made with care</text>
<text x="145" y="508" font-family="-apple-system,sans-serif" font-size="13" fill="#6E6E73">Every detail considered.</text>
<text x="475" y="480" font-family="-apple-system,sans-serif" font-size="16" font-weight="700" fill="#1D1D1F">Loved locally</text>
<text x="475" y="508" font-family="-apple-system,sans-serif" font-size="13" fill="#6E6E73">Built for people nearby.</text>
<text x="805" y="480" font-family="-apple-system,sans-serif" font-size="16" font-weight="700" fill="#1D1D1F">Start today</text>
<text x="805" y="508" font-family="-apple-system,sans-serif" font-size="13" fill="#6E6E73">Two minutes to begin.</text>
</svg>`;
}
function pythonFiles(name, color, desc) {
  const main = `#!/usr/bin/env python3
"""${name} - a small Python tool.
Run it with:  python3 main.py
It writes report.html, which Muse Maker shows live in the middle.
Edit the numbers and words below; the report rebuilds itself every run."""
NAME = "${name.replace(/"/g, "")}"
ITEMS = [("Apples", 12), ("Bread", 19), ("Coffee", 7), ("Flowers", 15)]

rows = ""
maxv = max(v for _, v in ITEMS)
for label, v in ITEMS:
    w = int(v / maxv * 100)
    rows += '<div class="row"><span>' + label + '</span><div class="bar"><i style="width:' + str(w) + '%"></i></div><b>' + str(v) + '</b></div>'

html = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>""" + NAME + """</title><style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#FBFBFD;color:#1D1D1F}
main{max-width:640px;margin:0 auto;padding:36px 24px}h1{font-size:34px;letter-spacing:-.02em;margin:6px 0 10px}
p.lead{color:#6E6E73;line-height:1.6}.row{display:flex;align-items:center;gap:12px;margin:14px 0;font-size:14px}
.row span{width:80px}.bar{flex:1;background:#EDEDF0;border-radius:99px;height:14px;overflow:hidden}
.bar i{display:block;height:100%;background:${color};border-radius:99px}
button{background:${color};color:#fff;border:0;border-radius:999px;padding:12px 22px;font-weight:700;font-size:14px;cursor:pointer;margin-top:18px}
.tag{color:${color};font-weight:700;font-size:12px;letter-spacing:.08em}</style></head><body><main>
<span class="tag">PYTHON REPORT</span><h1>""" + NAME + """</h1>
<p class="lead">${desc.replace(/"/g, "")} This page was generated by main.py just now - press Build in Muse Maker to run it again.</p>
""" + rows + """
<button id="b" type="button">Clicked 0 times - it really works</button>
<script>var n=0;document.getElementById('b').onclick=function(){n++;this.textContent='Clicked '+n+' times - it really works';};</script>
</main></body></html>"""

with open("report.html", "w", encoding="utf-8") as f:
    f.write(html)
print("Report updated for " + NAME + " (" + str(len(ITEMS)) + " rows)")
`;
  return {
    "main.py": main,
    ".gitignore": "__pycache__/\n",
    "README.md": `# ${name}\n\nA Python tool. Run \`python3 main.py\` — it writes \`report.html\`, which Muse Maker shows in the middle. Press **Build** in Muse Maker to run it.\n`
  };
}
function macFiles(name, color, desc) {
  const app = `import SwiftUI

@main
struct MakerApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @State private var taps = 0
    var body: some View {
        VStack(spacing: 14) {
            Text("${name.replace(/"/g, "")}")
                .font(.largeTitle).bold()
            Text("${desc.replace(/"/g, "")}")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Clicked \\(taps) times - it really works") { taps += 1 }
                .buttonStyle(.borderedProminent)
                .tint(Color(red: 0.0, green: 0.44, blue: 0.89))
        }
        .padding(40)
        .frame(minWidth: 520, minHeight: 360)
    }
}
`;
  return {
    "Package.swift": "// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: \"MakerApp\", platforms: [.macOS(.v13)], targets: [.executableTarget(name: \"MakerApp\", path: \"Sources/MakerApp\")])\n",
    "Sources/MakerApp/App.swift": app,
    "ui.svg": uiSvg(name, color, desc, "Mac app"),
    ".gitignore": ".build/\nBuild/\n",
    "README.md": `# ${name}\n\nA native Mac app (SwiftUI). Press **Build** in Muse Maker to compile it with \`swift build\`. The picture in the middle is ui.svg until you drop a real screenshot.png of the running app next to it.\n`
  };
}
function unityFiles(name, color, desc) {
  const scene = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!29 &1
OcclusionCullingSettings:
  m_ObjectHideFlags: 0
  serializedVersion: 2
  m_OcclusionBakeSettings:
    smallestOccluder: 5
    smallestHole: 0.25
    backfaceThreshold: 100
  m_SceneGUID: 00000000000000000000000000000000
  m_OcclusionCullingData: {fileID: 0}
--- !u!104 &2
RenderSettings:
  m_ObjectHideFlags: 0
  serializedVersion: 9
  m_Fog: 0
  m_FogColor: {r: 0.5, g: 0.5, b: 0.5, a: 1}
  m_FogMode: 3
  m_FogDensity: 0.01
  m_LinearFogStart: 0
  m_LinearFogEnd: 300
  m_AmbientSkyColor: {r: 0.212, g: 0.227, b: 0.259, a: 1}
  m_AmbientEquatorColor: {r: 0.114, g: 0.125, b: 0.133, a: 1}
  m_AmbientGroundColor: {r: 0.047, g: 0.043, b: 0.035, a: 1}
  m_AmbientIntensity: 1
  m_AmbientMode: 3
  m_SubtractiveShadowColor: {r: 0.42, g: 0.478, b: 0.627, a: 1}
  m_SkyboxMaterial: {fileID: 10304, guid: 0000000000000000f000000000000000, type: 0}
  m_HaloStrength: 0.5
  m_FlareStrength: 1
  m_FlareFadeSpeed: 3
  m_TrackedAmbientProbe: {fileID: 0}
  m_Sun: {fileID: 705507994}
  m_HdrRenderMode: 0
  m_GeometryECSMode: 0
  m_UseRadianceAmbientProbe: 0
--- !u!157 &3
LightmapSettings:
  m_ObjectHideFlags: 0
  serializedVersion: 12
  m_GIWorkflowMode: 1
  m_GISettings:
    m_BounceScale: 1
    m_IndirectOutputScale: 1
    m_AlbedoBoost: 1
    m_EnvironmentLightingMode: 0
    m_EnableBakedLightmaps: 1
    m_EnableRealtimeLightmaps: 0
  m_LightmapEditorSettings:
    m_Resolution: 2
    m_BakeResolution: 40
    m_AtlasSize: 1024
    m_AO: 0
    m_AOMaxDistance: 1
    m_CompAOExponent: 1
    m_CompAOExponentDirect: 0
    m_ExtractAmbientOcclusion: 0
    m_Padding: 2
    m_LightmapParameters: {fileID: 0}
    m_LightmapsBakeMode: 1
    m_TextureCompression: 1
    m_FinalGather: 0
    m_FinalGatherFiltering: 1
    m_FinalGatherRayCount: 256
    m_ReflectionCompression: 2
    m_MixedBakeMode: 2
    m_BakeBackend: 1
    m_PVRSampling: 1
    m_PVRDirectSampleCount: 32
    m_PVRSampleCount: 512
    m_PVRBounces: 2
    m_PVREnvironmentSampleCount: 256
    m_PVREnvironmentReferencePointCount: 2048
    m_PVRFilteringMode: 1
    m_PVRDenoiserTypeDirect: 1
    m_PVRDenoiserTypeIndirect: 1
    m_PVRDenoiserTypeAO: 1
    m_PVRFilterTypeDirect: 0
    m_PVRFilterTypeIndirect: 0
    m_PVRFilterTypeAO: 0
    m_PVREnvironmentMIS: 1
    m_PVRCulling: 1
    m_PVRGaussRadiusDirect: 1
    m_PVRGaussRadiusIndirect: 5
    m_PVRGaussRadiusAO: 2
    m_NumRaysToShootPerTexel: -1
    m_RespectSceneVisibilityWhenBaking: 0
    m_SelectedDirectory: 
  m_LightingDataAsset: {fileID: 0}
  m_LightingSettings: {fileID: 0}
--- !u!196 &4
NavMeshSettings:
  serializedVersion: 2
  m_ObjectHideFlags: 0
  m_BuildSettings:
    serializedVersion: 3
    agentTypeID: 0
    agentRadius: 0.5
    agentHeight: 2
    agentSlope: 45
    agentClimb: 0.4
    ledgeDropHeight: 0
    maxJumpAcrossDistance: 0
    minRegionArea: 2
    manualCellSize: 0
    cellSize: 0.16666667
    manualTileSize: 0
    tileSize: 256
    buildHeightMesh: 0
    maxJobWorkers: 0
    preserveTilesOutsideBounds: 0
    debug:
      m_Flags: 0
  m_NavMeshData: {fileID: 0}
--- !u!1 &705507993
GameObject:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  serializedVersion: 6
  m_Component:
  - component: {fileID: 705507995}
  - component: {fileID: 705507994}
  m_Layer: 0
  m_Name: Main Camera
  m_TagString: MainCamera
  m_Icon: {fileID: 0}
  m_NavMeshLayer: 0
  m_StaticEditorFlags: 0
  m_IsActive: 1
--- !u!20 &705507994
Camera:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: 705507993}
  m_Enabled: 1
  serializedVersion: 2
  m_ClearFlags: 1
  m_BackGroundColor: {r: 0.192, g: 0.302, b: 0.475, a: 1}
  m_projectionMatrixMode: 1
  m_SensorSize: {x: 36, y: 24}
  m_LensShift: {x: 0, y: 0}
  m_GateFitMode: 2
  m_FocalLength: 50
  m_NormalizedViewPortRect:
    serializedVersion: 2
    x: 0
    y: 0
    width: 1
    height: 1
  near clip plane: 0.3
  far clip plane: 1000
  field of view: 60
  orthographic: 0
  orthographic size: 5
  m_Depth: -1
  m_CullingMask:
    serializedVersion: 2
    m_Bits: 4294967295
  m_RenderingPath: -1
  m_TargetTexture: {fileID: 0}
  m_TargetDisplay: 0
  m_TargetEye: 3
  m_HDR: 1
  m_AllowMSAA: 1
  m_AllowDynamicResolution: 0
  m_ForceIntoRT: 0
  m_OcclusionCulling: 1
  m_StereoConvergence: 10
  m_StereoSeparation: 0.01
--- !u!4 &705507995
Transform:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: 705507993}
  serializedVersion: 2
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 0, y: 1, z: -10}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_ConstrainProportionsScale: 0
  m_Children: []
  m_Father: {fileID: 0}
  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}
`;
  return {
    "Assets/Scripts/PlayerController.cs": "using UnityEngine;\n\npublic class PlayerController : MonoBehaviour\n{\n    public float speed = 6f;\n\n    void Update()\n    {\n        float x = Input.GetAxis(\"Horizontal\");\n        float z = Input.GetAxis(\"Vertical\");\n        transform.Translate(new Vector3(x, 0, z) * speed * Time.deltaTime);\n    }\n}\n",
    "Assets/Scenes/Main.unity": scene,
    "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.34f1\n",
    "ProjectSettings/EditorBuildSettings.asset": "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1045 &1\nEditorBuildSettings:\n  m_ObjectHideFlags: 0\n  serializedVersion: 2\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Main.unity\n    guid: 00000000000000000000000000000000\n  m_configObjects: {}\n",
    "ui.svg": uiSvg(name, color, desc, "Unity game"),
    ".gitignore": "[Ll]ibrary/\n[Tt]emp/\n[Oo]bj/\nBuild/\n[Ll]ogs/\n*.csproj\n*.sln\n",
    "README.md": `# ${name}\n\nA Unity game. Press **Build** in Muse Maker to run a headless macOS build (needs Unity Hub + editor installed). The picture in the middle is ui.svg until you drop a real screenshot.png of gameplay next to it.\n`
  };
}
function scaffoldBase(type, name, color, desc) {
  const short = name.split("—")[0].split("-")[0].trim();
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title><style>
:root{--accent:${color};--bg:#FBFBFD;--ink:#1D1D1F;--sub:#6E6E73;--h1:40px;--btnpad:12px 22px}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}
nav{display:flex;gap:18px;align-items:center;padding:16px 22px;font-size:13px}nav b{font-size:17px;color:var(--accent)}nav span{color:var(--sub)}nav .cta{margin-left:auto;background:var(--accent);color:#fff;border-radius:999px;padding:8px 16px;font-weight:700}
main{padding:28px 22px;max-width:760px;margin:0 auto}h1{font-size:var(--h1);line-height:1.05;letter-spacing:-.03em;margin:8px 0 12px}p.lead{color:var(--sub);font-size:16px;line-height:1.6;max-width:520px}
.btn{display:inline-block;background:var(--accent);color:#fff;border-radius:999px;padding:var(--btnpad);font-weight:700;font-size:14px;margin-top:16px}
.cards{display:flex;gap:12px;margin-top:28px;flex-wrap:wrap}.card{flex:1;min-width:180px;background:#fff;border:1px solid rgba(0,0,0,.07);border-radius:16px;padding:16px;font-size:13px;line-height:1.5;box-shadow:0 4px 18px rgba(0,0,0,.05)}.card b{display:block;font-size:14px;margin-bottom:4px}
.ring{width:160px;height:160px;margin:22px auto;border-radius:50%;background:conic-gradient(var(--accent) 45%,#EDEDF0 0);display:grid;place-items:center}.ring i{width:118px;height:118px;background:var(--bg);border-radius:50%;display:grid;place-items:center;font-style:normal;font-weight:800;font-size:22px}
.poster{min-height:480px;background:var(--accent);color:#fff;border-radius:6px;padding:34px 28px;display:flex;flex-direction:column}.poster h1{color:#fff;font-size:52px}.poster p{opacity:.85;line-height:1.6}
.bars{display:flex;align-items:flex-end;gap:12px;height:160px;margin-top:24px}.bar{flex:1;background:var(--accent);border-radius:8px 8px 3px 3px;opacity:.9}
footer{padding:22px;text-align:center;color:var(--sub);font-size:12px}</style></head><body>`;
  const foot = `<!--EXTRA--><footer>Made with Muse Maker · ${short}</footer></body></html>`;
  if (type === "app") return head + `<main style="max-width:380px"><nav style="padding-left:0"><b>${short}</b><span class="cta" style="margin-left:auto">Today</span></nav><h1 id="headline">Your day, at a glance.</h1><p class="lead">${desc}</p><div class="ring"><i>45%</i></div><div class="cards"><div class="card"><b>Progress</b>Halfway to today's goal.</div><div class="card"><b>Streak</b>3 days and counting.</div></div><span class="btn" id="cta">Start</span></main>` + foot;
  if (type === "poster") return head + `<main style="max-width:440px"><div class="poster"><span style="letter-spacing:.14em;font-weight:700;font-size:12px">${short.toUpperCase()}</span><h1 id="headline" style="margin-top:auto">YOUR<br>HEADLINE<br>HERE.</h1><p>${desc}</p><span class="btn" style="background:#fff;color:var(--accent);align-self:flex-start">Find out more</span></div></main>` + foot;
  if (type === "slides") return head + `<main style="max-width:820px"><section style="min-height:420px;display:flex;flex-direction:column;justify-content:center;border:1px solid rgba(0,0,0,.07);border-radius:20px;padding:36px;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.06)"><span style="color:var(--accent);font-weight:700;font-size:13px">SLIDE 1 · TITLE</span><h1 id="headline">Your big idea, in one line.</h1><p class="lead">${desc}</p><span class="btn">Start the story</span></section><div class="cards"><div class="card"><b>Slide 2 · Problem</b>What hurts, in plain words.</div><div class="card"><b>Slide 3 · Solution</b>What you built about it.</div><div class="card"><b>Slide 4 · Ask</b>What you need next.</div></div></main>` + foot;
  if (type === "shop") return head + `<nav><b>${short}</b><span>Shop</span><span>About</span><span class="cta">Cart · 0</span></nav><main style="max-width:860px"><h1 id="headline">Things made to be kept.</h1><p class="lead">${desc}</p><div class="cards"><div class="card"><b>Everyday Tote</b>Heavy canvas, inside pocket.<br><b style="color:var(--accent)">€48</b></div><div class="card"><b>Field Notebook</b>Dotted pages, lays flat.<br><b style="color:var(--accent)">€14</b></div><div class="card"><b>Enamel Mug</b>Campfire-proof, 350ml.<br><b style="color:var(--accent)">€22</b></div><div class="card"><b>Wool Cap</b>One size, warm ears.<br><b style="color:var(--accent)">€32</b></div></div><span class="btn" id="cta">Shop all</span></main>` + foot;
  if (type === "dashboard") return head + `<nav><b>${short}</b><span>Overview</span><span>Customers</span><span class="cta">Export</span></nav><main style="max-width:820px"><h1 id="headline">How are we doing?</h1><p class="lead">${desc}</p><div class="cards"><div class="card"><b>€31.4k</b>Revenue this month</div><div class="card"><b>2,410</b>Customers</div><div class="card"><b>3.1%</b>Conversion</div></div><div class="bars"><span class="bar" style="height:30%"></span><span class="bar" style="height:38%"></span><span class="bar" style="height:33%"></span><span class="bar" style="height:46%"></span><span class="bar" style="height:42%"></span><span class="bar" style="height:55%"></span></div></main>` + foot;
  return head + `<nav><b>${short}</b><span>Menu</span><span>Story</span><span class="cta">Order</span></nav><main><span style="color:var(--accent);font-weight:700;font-size:13px;letter-spacing:.06em">${short.toUpperCase()}</span><h1 id="headline">A headline worth remembering.</h1><p class="lead">${desc}</p><span class="btn" id="cta">Get started</span><div class="cards"><div class="card"><b>Made with care</b>Every detail considered.</div><div class="card"><b>Loved locally</b>Built for the people nearby.</div><div class="card"><b>Start today</b>Two minutes to begin.</div></div></main>` + foot;
}

/* ---------- Muse brain: every agent is a headless Muse session ---------- */
async function museRun({ workspace, model, prompt, timeoutMs = 300000, readOnly = false, preset = null, maxSteps = null }) {
  if (MUSE_OK === false) return null;
  const args = ["exec", "--json", "--workspace", workspace, "--model", model, "--approval-mode", "never", "--disable-web-tools", "--disable-request-user-input", "--no-session-log"];
  if (preset) args.push("--preset", preset);
  if (maxSteps) args.push("--max-model-steps", String(maxSteps));
  if (readOnly) args.push("--disable-write", "--disable-shell");
  if (process.env.MUSE_REASONING_EFFORT) args.push("--reasoning-effort", process.env.MUSE_REASONING_EFFORT);
  args.push(prompt);
  try {
    const { stdout } = await run(MUSE_BIN, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: process.env });
    let text = null; const models = []; let tokens = 0;
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      try { const e = JSON.parse(line);
        if (e.payload_type === "run.terminal.completed") text = e.payload?.text || null;
        if (e.payload_type === "run.usage") for (const m of e.payload?.models || []) { if (!models.includes(m.model)) models.push(m.model); tokens += (m.input_tokens || 0) + (m.output_tokens || 0); }
      } catch { /* partial line */ }
    }
    return text ? { text, models, tokens } : null;
  } catch (e) { console.log(`museRun failed (${model}):`, String(e.stderr || e.message || e).slice(0, 300)); return null; }
}
const RULES = [
  [/design|look|colour|color|style|brand|poster|typography|headline|polish|beautiful/i, "mira"],
  [/check|contrast|accessib|readab|proof|consisten/i, "noor"],
  [/test|device|phone|tap|flow|try/i, "leo"]
];
function rulePlan(text) {
  let agent = (RULES.find(([re]) => re.test(text)) || [null, "kai"])[1];
  if (!state.agents[agent]) { const hit = Object.entries(state.agents).find(([, a]) => /build|code|develop/i.test(a.role)); agent = hit ? hit[0] : Object.keys(state.agents)[0]; }
  const priority = /urgent|first|before anything/i.test(text) ? 1 : /later|someday/i.test(text) ? 4 : 2;
  return { agent, priority, reason: `Best match: ${agentOf(agent).name} (${agentOf(agent).role}) — ${agentOf(agent).skills}.`, what: "Your team will show you a visual here before anything ships.", why: "You asked for it — and nothing goes live without your approval." };
}
async function planTask(project, text) {
  const r = await museRun({ workspace: ROOT, model: PLANNER_MODEL, readOnly: true, timeoutMs: 240000, maxSteps: Number(process.env.MUSE_PLANNER_MAX_STEPS || 3),
    prompt: `You are the superagent in Muse Maker. You order and assign user requests to subagents. Your team: ${Object.entries(state.agents).map(([id, a]) => `${id}=${a.name} (${a.role}: ${a.skills})`).join(", ")}. Project: ${project.name} (${project.type}). Request: "${text}". Reply with ONLY this JSON, no other text: {"agent":"one of: ${AGENT_KEYS().join("|")}","priority":1,"reason":"one plain-English sentence","what":"one plain-English sentence describing the visible change","why":"one plain-English sentence why it helps"}. Priority 1-5, lower = sooner. No jargon.` });
  if (r?.text) { try { const m = r.text.match(/\{[\s\S]*\}/); const p = JSON.parse(m[0]); if (AGENT_KEYS().includes(p.agent)) return { agent: p.agent, priority: Math.min(5, Math.max(1, p.priority || 2)), reason: String(p.reason || ""), what: String(p.what || ""), why: String(p.why || ""), brain: `muse:${PLANNER_MODEL}`, planTokens: r.tokens || 0 }; } catch { /* fall through */ } }
  return { ...rulePlan(text), brain: "rules" };
}
/* local executor: deterministic visible edits, used when no key / AI output invalid */
const COLORS = { red: "#DC2626", blue: "#0071E3", teal: "#0F766E", green: "#16A34A", orange: "#EA580C", black: "#111827", warm: "#9A3412", pink: "#DB2777", purple: "#7C3AED", yellow: "#CA8A04" };
function localEdit(html, task) {
  const text = task.title; let out = html; const notes = [];
  const quoted = text.match(/["“]([^"”]{3,80})["”]/);
  if (quoted) { out = out.replace(/(<h1[^>]*>)[\s\S]*?(<\/h1>)/, `$1${quoted[1]}$2`); notes.push(`Headline now says “${quoted[1]}”`); }
  const colorWord = Object.keys(COLORS).find((c) => new RegExp(`\\b${c}\\b`, "i").test(text));
  if (colorWord) { out = out.replace(/--accent:[^;]+/, `--accent:${COLORS[colorWord]}`); notes.push(`Accent colour is now ${colorWord}`); }
  if (/dark/i.test(text)) { out = out.replace("--bg:#FBFBFD", "--bg:#101114").replace("--ink:#1D1D1F", "--ink:#F5F5F7"); notes.push("Dark theme applied"); }
  if (/bigger|larger|huge/i.test(text)) { out = out.replace(/--h1:\d+px/, "--h1:56px"); if (/button/i.test(text)) out = out.replace(/--btnpad:[^}]+/, "--btnpad:16px 30px"); notes.push("Type/buttons enlarged"); }
  if (!notes.length || /add|section|new/i.test(text)) {
    const card = `<div class="cards"><div class="card"><b>${task.title.replace(/</g, "")}</b>Added by ${agentOf(task.agent).name} (${agentOf(task.agent).role}) for this step. Review it visually, then approve or ask for a tweak.</div></div>`;
    out = out.replace("<!--EXTRA-->", card + "<!--EXTRA-->"); notes.push("A new section was added for this step");
  }
  return { html: out, note: notes.join(". ") + "." };
}
/* A subagent IS a Muse session in the project workspace, editing real files with its tools. */
async function runMuseWorker(task, project, dir) {
  const a = agentOf(task.agent);
  return museRun({ workspace: dir, model: WORKER_MODEL, timeoutMs: 420000, preset: process.env.MUSE_WORKER_PRESET || "miniswe", maxSteps: Number(process.env.MUSE_WORKER_MAX_STEPS || 14),
    prompt: project.framework
      ? `You are ${a.name}, the ${a.role}, a subagent in Muse Maker working in this workspace. The project is "${project.name}", a Vite + React app (source in src/, entry src/App.jsx, styles src/index.css). User request: "${task.title}". Use your file tools to edit the React source so this change is clearly visible when the app renders. Do not edit package.json, vite.config.js, or node_modules. Keep it working React — the project will be built right after you finish, and a broken build means your change is discarded. Do not ask questions. When done, reply with exactly TWO short lines and nothing else: line 1 = one plain-English sentence describing the visible change (no file names, no code); line 2 = starts with "NOTE:" followed by a team message of at most 12 words (a heads-up, a thanks, or what's next).`
      : project.kind === "python"
      ? `You are ${a.name}, the ${a.role}, a subagent in Muse Maker working in this workspace. The project is "${project.name}", a Python tool (main.py). User request: "${task.title}". Edit main.py (stdlib only, no new packages) so the change is visible in the report it generates. Never edit report.html directly — it is generated; main.py will be run right after you finish, and if it crashes your change is discarded. Do not ask questions. When done, reply with exactly TWO short lines and nothing else: line 1 = one plain-English sentence describing the visible change (no file names, no code); line 2 = starts with "NOTE:" followed by a team message of at most 12 words (a heads-up, a thanks, or what's next).`
      : project.kind === "mac"
      ? `You are ${a.name}, the ${a.role}, a subagent in Muse Maker working in this workspace. The project is "${project.name}", a native Mac app in SwiftUI (Sources/MakerApp/App.swift). User request: "${task.title}". Edit the Swift source so this change is visible in the app window, and update ui.svg so the sketch in Muse Maker matches the UI you built. Do not edit Package.swift. Keep it compiling SwiftUI — the project will be compiled with swift build right after you finish, and a broken build means your change is discarded. Do not ask questions. When done, reply with exactly TWO short lines and nothing else: line 1 = one plain-English sentence describing the visible change (no file names, no code); line 2 = starts with "NOTE:" followed by a team message of at most 12 words (a heads-up, a thanks, or what's next).`
      : project.kind === "unity"
      ? `You are ${a.name}, the ${a.role}, a subagent in Muse Maker working in this workspace. The project is "${project.name}", a Unity game (C# in Assets/Scripts, scene Assets/Scenes/Main.unity). User request: "${task.title}". Edit the C# scripts (and the scene only if you are confident in Unity YAML) so this change is visible in gameplay, and update ui.svg so the preview in Muse Maker matches. Keep scripts compiling standard Unity C#. Do not ask questions. When done, reply with exactly TWO short lines and nothing else: line 1 = one plain-English sentence describing the visible change (no file names, no code); line 2 = starts with "NOTE:" followed by a team message of at most 12 words (a heads-up, a thanks, or what's next).`
      : `You are ${a.name}, the ${a.role}, a subagent in Muse Maker working in this workspace. The project is "${project.name}" (${project.type}). Its entry point is index.html. User request: "${task.title}". Use your file tools to edit index.html so this change is clearly visible when rendered. You may also create or edit linked local files (like styles.css or app.js, linked with relative paths) when that genuinely helps, but index.html must stay the entry point. Keep the <!--EXTRA--> marker in index.html, keep existing content unless asked to remove it, no external scripts or CDN links. Do not ask questions. When done, reply with exactly TWO short lines and nothing else: line 1 = one plain-English sentence describing the visible change (no file names, no code); line 2 = starts with "NOTE:" followed by a team message of at most 12 words (a heads-up, a thanks, or what's next).` });
}

/* Noor, the Checker: a separate read-only Muse session reviewing the actual diff of a step. */
async function runChecker(t, p) {
  if (!t.commit) return null;
  const dir = projDir(p);
  let diff = "";
  try { const stat = await git(dir, ["show", "--stat", "--format=", t.commit, "--", ".", ":(exclude)package-lock.json"]); const patch = await git(dir, ["show", "--format=", "--unified=1", t.commit, "--", ".", ":(exclude)package-lock.json"]); diff = (stat + "\n" + patch).slice(0, 8000); } catch { return null; }
  const r = await museRun({ workspace: ROOT, model: WORKER_MODEL, readOnly: true, timeoutMs: 240000, maxSteps: Number(process.env.MUSE_CHECKER_MAX_STEPS || 3),
    prompt: `You are ${checkerOf().name}, the Checker in Muse Maker. Another subagent just made this change. Answer IMMEDIATELY from the diff below — do not open, read, or explore any files. User request: "${t.title}". What they say changed: "${t.what || ""}". Here is the actual diff (may be truncated):\n${diff}\nJudge only: does the diff plausibly do what was asked, without obviously breaking the page (unclosed tags, removed content that should stay, broken structure)? Reply with ONLY this JSON: {"verdict":"pass" or "fix","note":"one short plain-English sentence a non-technical owner understands"}.` });
  if (r?.text) {
    try { const m = r.text.match(/\{[\s\S]*\}/); const j = JSON.parse(m[0]);
      t.check = { verdict: j.verdict === "fix" ? "fix" : "pass", note: String(j.note || "").slice(0, 300), tokens: r.tokens || 0, model: r.models?.[0] || WORKER_MODEL, at: Date.now() };
    } catch { t.check = { verdict: "unknown", note: "Noor's check came back unreadable — use your eyes on the Compare view.", tokens: r.tokens || 0, model: WORKER_MODEL, at: Date.now() }; }
  } else t.check = { verdict: "unknown", note: `${checkerOf().name} couldn't run just now — use your eyes on the Compare view.`, tokens: 0, model: WORKER_MODEL, at: Date.now() };
  if (t.check.verdict === "pass") say(checkerOf().id, `✓ Pass: “${shortTitle(t.title)}”`);
  else if (t.check.verdict === "fix") {
    say(checkerOf().id, `⚠ Flag: ${t.check.note}`);
    if (!t.fixQueued) {
      t.fixQueued = true;
      const fix = { id: uid("t"), projectId: p.id, title: `Fix after check: ${t.title}`, agent: t.agent, status: "todo", progress: 0, priority: 1, reason: `${checkerOf().name} flagged: ${t.check.note}`, what: "The original builder will address the checker's flag; you'll see a fresh Before/After.", why: "Flags get fixed before you ever have to worry about them.", commit: null, createdAt: Date.now(), brain: "checker" };
      state.tasks.push(fix);
      say(checkerOf().id, `→ ${agentOf(t.agent).name}: queued you a fix`);
    }
  } else say(checkerOf().id, `Couldn't check “${shortTitle(t.title)}” — eyes on Compare, please`);
  save(); return t.check;
}

/* ---------- project / task actions ---------- */
const TYPE_LABELS = { website: "Website", app: "Mobile app", poster: "Poster", dashboard: "Dashboard", slides: "Slides", shop: "Shop", react: "React app", python: "Python tool", mac: "Mac app", unity: "Unity game" };
const TYPE_RULES = [
  ["mac", 3, /\b(mac|macos|osx|swift|swiftui|menu ?bar|desktop app|native app)\b/i, "you mentioned a Mac/desktop app"],
  ["unity", 3, /\bunity\b/i, "you mentioned Unity"],
  ["unity", 2, /\b(game|platformer|shooter|arcade|puzzle game|rpg)\b/i, "it sounds like a game"],
  ["python", 3, /\b(python|script|scraper|automation|automate|csv|command[- ]line|cli)\b/i, "it sounds like a script/tool"],
  ["react", 3, /\b(react|vite|next\.?js)\b/i, "you mentioned React"],
  ["poster", 2, /\b(poster|flyer|album cover|gig)\b/i, "it sounds like a poster"],
  ["slides", 2, /\b(slides|pitch deck|presentation|keynote|deck)\b/i, "it sounds like slides"],
  ["dashboard", 2, /\b(dashboard|analytics|metrics|admin panel|stats)\b/i, "it sounds like a dashboard"],
  ["shop", 2, /\b(shop|store|e-?commerce|sell|checkout|products)\b/i, "it sounds like a shop"],
  ["app", 2, /\b(mobile app|iphone|ios app|android|phone app)\b/i, "it sounds like a phone app"],
  ["app", 1, /\bapp\b/i, "you called it an app"],
  ["website", 1, /\b(website|landing page|homepage|blog)\b/i, "it sounds like a website"]
];
function classifyByRules(text) {
  const scores = {};
  for (const [type, weight, re, why] of TYPE_RULES) if (re.test(text)) { scores[type] = (scores[type] || 0) + weight; scores[type + ":why"] = why; }
  const ranked = Object.keys(scores).filter((k) => !k.includes(":")).sort((a, b) => scores[b] - scores[a]);
  if (!ranked.length || scores[ranked[0]] === scores[ranked[1]]) return null;
  return { type: ranked[0], why: scores[ranked[0] + ":why"] };
}
async function classifyType(name, desc, requested) {
  if (requested && requested !== "auto" && TYPE_LABELS[requested]) return { type: requested, reason: null };
  const rule = classifyByRules(`${name} ${desc || ""}`);
  if (rule) return { type: rule.type, reason: `Read as ${TYPE_LABELS[rule.type]} — ${rule.why}.` };
  if (MUSE_OK !== false) {
    const r = await museRun({ workspace: ROOT, model: PLANNER_MODEL, readOnly: true, timeoutMs: 120000, maxSteps: 2,
      prompt: `A user wants to start a new project in Muse Maker. Name: "${name}". Description: "${desc || ""}". Which ONE category fits best? website (a site/page), app (phone-style app), poster (print/poster), dashboard (numbers/admin), slides (pitch/presentation), shop (selling things), react (a React web app), python (a Python script/tool that runs and reports), mac (a native Mac app), unity (a Unity game). Reply with ONLY this JSON: {"type":"one of those words","why":"at most 8 words"}.` });
    if (r?.text) { try { const j = JSON.parse(r.text.match(/\{[\s\S]*\}/)[0]); if (TYPE_LABELS[j.type]) return { type: j.type, reason: `Muse read this as ${TYPE_LABELS[j.type]} — ${String(j.why || "").slice(0, 60)}.` }; } catch { /* fall through */ } }
  }
  return { type: "website", reason: "Read as Website — nothing pointed anywhere else." };
}
async function createProject({ name, type, color, desc, template }) {
  const decided = await classifyType(name, desc, type);
  type = decided.type;
  const isReact = type === "react";
  const kind = { python: "python", mac: "mac", unity: "unity" }[type] || "web";
  const p = { id: uid("p"), dir: slug(name) + "-" + Date.now().toString(36), name, type, kind, ...(decided.reason ? { typeReason: decided.reason } : {}), color: color || "#0071E3", desc: desc || "A new project, ready for your team.", createdAt: Date.now(), budget: 0, ...(isReact ? { framework: "vite-react", setup: "installing" } : {}) };
  const dir = projDir(p); fs.mkdirSync(dir, { recursive: true });
  const writeFiles = (files) => { for (const [rel, content] of Object.entries(files)) { const fp = path.join(dir, rel); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, content); } };
  if (isReact) writeFiles(reactFiles(p.name, p.color, p.desc));
  else if (kind === "python") { writeFiles(pythonFiles(p.name, p.color, p.desc)); try { const log = await runBuild(p); p.build = { ok: true, at: Date.now(), log }; } catch (e) { p.build = { ok: false, at: Date.now(), log: String(e.stderr || e.message || e).slice(-400) }; } }
  else if (kind === "mac") writeFiles(macFiles(p.name, p.color, p.desc));
  else if (kind === "unity") writeFiles(unityFiles(p.name, p.color, p.desc));
  else fs.writeFileSync(path.join(dir, "index.html"), scaffold(p.type, p.name, p.color, p.desc, template));
  await gitInit(dir);
  const hash = await commitAll(dir, "Muse Maker: project created");
  state.projects.push(p); feed("mira", `<b>${p.name}</b> created. The canvas is live — add a request to begin.`);
  const first = { id: uid("t"), projectId: p.id, title: "First visual pass — set the direction", agent: "mira", status: "todo", progress: 0, priority: 1, reason: "Every project starts with a visual direction.", what: "Mira will set the first layout and colour mood on the blank canvas.", why: "You approve the direction before detail work begins.", commit: null, createdAt: Date.now(), brain: "local" };
  state.tasks.push(first); save();
  if (isReact) void setupFramework(p); else void captureShot(p, hash);
  return { project: p, initialCommit: hash };
}
function usageOf(projectId) {
  return state.tasks.filter((x) => x.projectId === projectId).reduce((n, x) => n + (x.tokens || 0) + (x.planTokens || 0) + (x.check?.tokens || 0), 0);
}
/* Import an existing project folder (the millions-of-users case: they already have one).
   Copies it into projects/ (node_modules and oversized files skipped), keeps its git history if it has one. */
async function importProject({ sourcePath, name }) {
  const src = path.resolve(sourcePath || "");
  if (!sourcePath || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error("That folder doesn't exist on this machine.");
  if (src.startsWith(PROJECTS_DIR)) throw new Error("That folder is already inside Muse Maker.");
  const entries = fs.readdirSync(src);
  const entry = entries.includes("index.html") ? "index.html" : entries.find((f) => f.endsWith(".html"));
  const detected = entries.includes("Package.swift") ? "mac" : (entries.includes("Assets") && entries.includes("ProjectSettings")) ? "unity" : entries.some((f) => f.endsWith(".py")) ? "python" : null;
  if (!entry && !detected) throw new Error("No usable project found there — Muse Maker needs an index.html, a Swift Package.swift, a Unity Assets/ProjectSettings folder, or Python files.");
  const displayName = (name || path.basename(src)).trim();
  const p = { id: uid("p"), dir: slug(displayName) + "-" + Date.now().toString(36), name: displayName, type: detected || "website", kind: detected || "web", color: "#0071E3", desc: "Imported from " + src, importedFrom: src, createdAt: Date.now(), budget: 0 };
  const dir = projDir(p); fs.mkdirSync(dir, { recursive: true });
  const SKIP_DIRS = ["node_modules", "Library", "Temp", ".build", "Logs", "obj", "__pycache__"];
  fs.cpSync(src, dir, { recursive: true, filter: (s) => { const rel = path.relative(src, s); if (rel.split(path.sep).some((part) => SKIP_DIRS.includes(part))) return false; try { if (fs.statSync(s).isFile() && fs.statSync(s).size > 5 * 1024 * 1024) return false; } catch { return false; } return true; } });
  if (entry && entry !== "index.html") fs.copyFileSync(path.join(dir, entry), path.join(dir, "index.html"));
  const hasGit = fs.existsSync(path.join(dir, ".git"));
  if (!hasGit) { await gitInit(dir); await commitAll(dir, "Muse Maker: project imported"); }
  else {
    try { await git(dir, ["config", "user.email", "team@musemaker.local"]); await git(dir, ["config", "user.name", "Muse Maker"]); if (!(await history(p)).length) await commitAll(dir, "Muse Maker: project imported"); else if ((await git(dir, ["status", "--porcelain"])).trim()) await commitAll(dir, "Muse Maker: import snapshot"); } catch { /* keep as-is */ }
  }
  try { const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }; if (all.react && all.vite) { p.type = "react"; p.framework = "vite-react"; p.setup = "installing"; } } catch { /* not a framework project */ }
  state.projects.push(p); feed("kai", `<b>${p.name}</b> imported. It's rendered in the middle — add a request to start improving it.`);
  if (p.framework) void setupFramework(p);
  state.tasks.push({ id: uid("t"), projectId: p.id, title: "First look — suggest what to improve first", agent: "mira", status: "todo", progress: 0, priority: 1, reason: "Imported projects start with a look before changes.", what: "Mira will review the imported page and propose a first visual improvement.", why: "You approve the direction before anything changes.", commit: null, createdAt: Date.now(), brain: "local" });
  save(); return { project: p };
}
function queueOf(projectId) {
  return state.tasks.filter((t) => t.projectId === projectId && (t.status === "todo" || t.status === "doing"))
    .sort((a, b) => (a.priority - b.priority) || (a.createdAt - b.createdAt));
}
async function addTask(project, text, pref) {
  const overBudget = project.budget > 0 && usageOf(project.id) >= project.budget;
  const plan = pref && AGENT_KEYS().includes(pref) ? { agent: pref, priority: 2, reason: `You chose ${agentOf(pref).name}.`, what: "Your team will show you a visual here before anything ships.", why: "You asked for it — and nothing goes live without your approval.", brain: "local" } : overBudget ? { ...rulePlan(text), brain: "rules", reason: rulePlan(text).reason + " (Budget reached — planned without Muse to save tokens.)" } : await planTask(project, text);
  const t = { id: uid("t"), projectId: project.id, title: text, agent: plan.agent, status: "todo", progress: 0, priority: plan.priority, reason: plan.reason, what: plan.what, why: plan.why, commit: null, createdAt: Date.now(), brain: plan.brain, planTokens: plan.planTokens || 0 };
  state.tasks.push(t);
  say(t.agent, `Superagent gave me: “${shortTitle(text)}” (#${queueOf(project.id).findIndex((x) => x.id === t.id) + 1} in queue)`);
  save(); return t;
}
async function probeMuse() {
  try { await run(MUSE_BIN, ["--version"], { timeout: 15000 }); MUSE_OK = true; }
  catch { MUSE_OK = false; console.log("Muse CLI not found — local fallback edits will run. Install Muse / run `muse login`."); }
}
const running = new Set();
const runningProjects = new Set();
async function runTask(t) {
  if (running.has(t.id)) return t;
  const p = projById(t.projectId);
  if (runningProjects.has(t.projectId)) { t.error = "Another step is already running on this project — wait for it to finish so history stays clean."; save(); return t; }
  running.add(t.id); runningProjects.add(t.projectId);
  const dir = projDir(p); const file = path.join(dir, "index.html");
  try {
    t.status = "doing"; t.startedAt = Date.now(); delete t.error; delete t.interruptedAt;
    setPhase(t, `${agentOf(t.agent).name} is starting`, 10);
    say(t.agent, `Starting: “${shortTitle(t.title)}”`);
    const isWeb = !p.kind || p.kind === "web";
    const before = isWeb ? fs.readFileSync(file, "utf8") : null;
    try { if ((await git(dir, ["status", "--porcelain"])).trim()) { await commitAll(dir, "Auto-saved work already in the files"); say(t.agent, "Auto-saved the work already in the files."); } } catch { /* clean or first run */ }
    const overBudget = p.budget > 0 && usageOf(p.id) >= p.budget;
    setPhase(t, p.kind === "mac" ? `${agentOf(t.agent).name} is designing the app window` : p.kind === "unity" ? `${agentOf(t.agent).name} is building the game step` : `${agentOf(t.agent).name} is working on the files`, 25);
    const result = overBudget ? null : await runMuseWorker(t, p, dir);
    let changed = false;
    try { changed = (await git(dir, ["status", "--porcelain"])).trim().length > 0; } catch { changed = false; }
    let valid = false; let buildError = "";
    if (changed && (p.framework || p.kind === "python" || p.kind === "mac")) setPhase(t, p.kind === "mac" ? "Building the Mac app with Swift" : p.kind === "python" ? "Running the Python tool" : "Building the app", 70);
    if (changed && p.framework) {
      try { await buildProject(p); valid = fs.existsSync(path.join(dir, "dist", "index.html")); } catch (e) { buildError = String(e.stderr || e.stdout || e.message || e).slice(-400); valid = false; }
    } else if (changed && p.kind === "python") {
      try { const log = await runBuild(p); p.build = { ok: true, at: Date.now(), log }; const rep = fs.readFileSync(path.join(dir, "report.html"), "utf8"); valid = rep.includes("</html>") && rep.length > 200; } catch (e) { buildError = String(e.stderr || e.stdout || e.message || e).slice(-400); p.build = { ok: false, at: Date.now(), log: buildError }; valid = false; }
    } else if (changed && p.kind === "mac") {
      try { const log = await runBuild(p); p.build = { ok: true, at: Date.now(), log }; valid = true; } catch (e) { buildError = String(e.stderr || e.stdout || e.message || e).slice(-400); p.build = { ok: false, at: Date.now(), log: buildError }; valid = false; }
    } else if (changed && p.kind === "unity") { valid = true; /* full Unity builds run from the Build button, not per step */ }
    else if (changed) { try { const now = fs.readFileSync(file, "utf8"); valid = now.includes("</html>") && now.length > 200; } catch { valid = false; } }
    let executor;
    if (result && changed && valid) {
      executor = `muse:${result.models?.[0] || WORKER_MODEL}`;
      const lines = result.text.trim().split("\n").map((x) => x.trim()).filter(Boolean);
      const sentence = (lines.find((x) => !/^NOTE:/i.test(x)) || "").slice(0, 300);
      if (sentence) t.what = sentence;
      const noteLine = lines.find((x) => /^NOTE:/i.test(x));
      if (noteLine) t.teamNote = noteLine.replace(/^NOTE:\s*/i, "").slice(0, 110);
      t.models = result.models; t.tokens = result.tokens || 0;
    } else {
      if (changed) { try { await git(dir, ["checkout", "--", "."]); await git(dir, ["clean", "-fd"]); } catch { if (isWeb && before) fs.writeFileSync(file, before); } }
      if (p.framework || !isWeb) {
        t.status = "todo"; t.progress = 0; t.phase = buildError ? "Build didn't pass — nothing saved" : "Stopped — nothing saved"; t.phaseAt = Date.now();
        if (buildError) say(t.agent, "Build broke — rolled back, nothing kept.");
        t.error = overBudget ? `This project's Muse budget (${p.budget.toLocaleString()} tokens) is used up. Raise the budget on the project header, then run again.` : buildError ? (p.framework ? "That change broke the React build, so nothing was kept. Try rephrasing the request." : "That change broke the build, so nothing was kept. Try rephrasing the request.") : "The Muse step didn't produce a working change, so nothing was kept.";
        return t;
      }
      const r = localEdit(fs.readFileSync(file, "utf8"), t);
      fs.writeFileSync(file, r.html); executor = "local-fallback"; if (r.note) t.what = r.note;
      t.executorNote = overBudget ? `This project's Muse budget (${p.budget.toLocaleString()} tokens) is used up — local fallback made this edit. Raise the budget on the project header to use Muse again.` : MUSE_OK === false ? "Muse CLI not found on the server — local fallback made this edit. Install Muse and `muse login`, then restart." : "The Muse step didn't produce a valid change — local fallback made this edit instead.";
    }
    setPhase(t, "Saving this step", 90);
    t.commit = await commitAll(dir, `${agentOf(t.agent).name} (${agentOf(t.agent).role}): ${t.title}`);
    try { const ns = (await git(dir, ["diff", "HEAD~1", "HEAD", "--numstat"])).trim().split("\t"); t.diff = { add: Number(ns[0]) || 0, del: Number(ns[1]) || 0 }; } catch { /* first commit */ }
    t.status = "review"; t.progress = 100; t.executor = executor;
    if (overBudget) say(t.agent, "Budget's used up — did a free local pass instead.");
    else if (executor === "local-fallback") say(t.agent, "Muse step didn't land — did a local pass instead.");
    else say(t.agent, `Done — ready for your eyes: “${shortTitle(t.title)}”`);
    if (t.teamNote) say(t.agent, t.teamNote);
    if (p.framework) await snapshotBuild(p, t.commit);
    setPhase(t, "Taking the picture of this step", 95);
    await captureShot(p, t.commit);
    if (executor.startsWith("muse:") && process.env.AUTO_CHECK !== "0") { say(t.agent, `→ ${checkerOf().name}: over to you for a check`); setPhase(t, `${checkerOf().name} is checking it`, 97); await runChecker(t, p); }
    t.phase = "Ready for your eyes"; t.phaseAt = Date.now(); t.endedAt = Date.now();
  } catch (e) { t.status = "todo"; t.progress = 0; t.phase = "Stopped — nothing saved"; t.phaseAt = Date.now(); t.error = String(e.message || e); }
  finally { running.delete(t.id); runningProjects.delete(t.projectId); save(); }
  return t;
}
const entryFile = (p) => (p.kind === "python" ? "report.html" : "index.html");
async function fileAt(p, hash) { return git(projDir(p), ["show", `${hash}:${entryFile(p)}`]); }

/* ---------- HTTP ---------- */
function send(res, code, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}
function readBody(req) { return new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") return send(res, 200, fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), "text/html");
    if (url.pathname === "/logo.svg" || url.pathname === "/app-icon.svg") return send(res, 200, fs.readFileSync(path.join(ROOT, url.pathname.slice(1)), "utf8"), "image/svg+xml");
    if (url.pathname === "/favicon-64.png" || url.pathname === "/apple-touch-icon.png" || url.pathname === "/favicon.ico") { const fp = path.join(ROOT, url.pathname.slice(1)); res.writeHead(200, { "Content-Type": url.pathname.endsWith(".ico") ? "image/x-icon" : "image/png", "Cache-Control": "no-store" }); return res.end(fs.readFileSync(fp)); }
    if (parts[0] === "preview" && parts[1]) {
      const p = projById(parts[1]); if (!p) return send(res, 404, "Project not found", "text/plain");
      const dir0 = projDir(p);
      const TYPES = { ".css": "text/css", ".js": "text/javascript", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".json": "application/json", ".txt": "text/plain", ".woff2": "font/woff2" };
      const serveFrom = (base, rel) => { const root = path.resolve(base); const full = path.resolve(root, rel || "index.html"); if ((full === root || full.startsWith(root + path.sep)) && TYPES[path.extname(full)] && fs.existsSync(full) && fs.statSync(full).isFile()) { send(res, 200, fs.readFileSync(full), TYPES[path.extname(full)]); return true; } return false; };
      const setupPage = () => send(res, 200, `<!doctype html><body style="font-family:-apple-system,sans-serif;padding:32px;color:#1D1D1F"><h2>${p.setup === "failed" ? "Build setup failed" : "Setting up your React project…"}</h2><p>${p.setup === "failed" ? "The install/build didn't finish. Details are on the project card — you can retry the build from there." : "Installing packages and doing the first build. This page will show your app in a moment — Muse Maker refreshes on its own."}</p></body>`, "text/html");
      if (parts[2] === "buildview") return send(res, 200, buildViewHtml(p), "text/html");
      if (parts[2] === "artifact" && parts[3]) { const f = path.basename(parts[3]); const fp = path.join(dir0, f); if ([".png", ".jpg", ".jpeg", ".svg"].includes(path.extname(f).toLowerCase()) && fs.existsSync(fp)) { res.writeHead(200, { "Content-Type": TYPES[path.extname(f).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" }); return res.end(fs.readFileSync(fp)); } return send(res, 404, "Not found", "text/plain"); }
      if (parts[2] === "at" && parts[3]) {
        const hash = parts[3]; const rest = decodeURIComponent(parts.slice(4).join("/"));
        const builds = path.join(dir0, ".mm-builds", hash);
        if (rest) {
          if (serveFrom(builds, rest)) return;
          if (!p.framework && !rest.includes("..")) { try { const content = await git(dir0, ["show", `${hash}:${rest}`]); return send(res, 200, content, TYPES[path.extname(rest)] || "text/plain"); } catch { /* not in that step */ } }
          return send(res, 404, "File not found", "text/plain");
        }
        const withBase = (html) => html.includes("<head>") ? html.replace("<head>", `<head><base href="/preview/${p.id}/at/${hash}/">`) : `<base href="/preview/${p.id}/at/${hash}/">` + html;
        if (fs.existsSync(path.join(builds, "index.html"))) return send(res, 200, withBase(fs.readFileSync(path.join(builds, "index.html"), "utf8")), "text/html");
        if (p.framework) return setupPage();
        if (p.kind === "mac" || p.kind === "unity") return send(res, 200, buildViewHtml(p), "text/html");
        return send(res, 200, withBase(await fileAt(p, hash)), "text/html");
      }
      if (parts[2] === "before-task" && parts[3]) {
        const t = state.tasks.find((x) => x.id === parts[3]);
        if (!t) { /* an asset resolving under before-task/ — never answer HTML for JS/CSS (strict MIME) */
          if (TYPES[path.extname(parts[parts.length - 1])]) return send(res, 404, "Not found", "text/plain");
          return send(res, 404, "Not found", "text/plain");
        }
        let parentHash = null;
        if (t?.commit) { try { parentHash = (await git(dir0, ["rev-parse", t.commit + "^"])).trim(); } catch { parentHash = null; } }
        const baseHtml = (html) => parentHash ? (html.includes("<head>") ? html.replace("<head>", `<head><base href="/preview/${p.id}/at/${parentHash}/">`) : `<base href="/preview/${p.id}/at/${parentHash}/">` + html) : html;
        if (t?.commit) {
          if (p.framework && parentHash && fs.existsSync(path.join(dir0, ".mm-builds", parentHash, "index.html"))) return send(res, 200, baseHtml(fs.readFileSync(path.join(dir0, ".mm-builds", parentHash, "index.html"), "utf8")), "text/html");
          if (p.framework) return setupPage();
          return send(res, 200, baseHtml(await fileAt(p, t.commit + "^")), "text/html");
        }
        return send(res, 200, baseHtml(await fileAt(p, "HEAD")), "text/html");
      }
      { /* current + linked files (static: project root · framework: dist/) */
        const base = p.framework ? path.join(dir0, "dist") : dir0;
        const rel = (!parts[2] || parts[2] === "current") ? "index.html" : decodeURIComponent(parts.slice(2).join("/"));
        if (p.kind === "python" && rel === "index.html" && serveFrom(base, "report.html")) return;
        if (serveFrom(base, rel)) return;
        if (p.framework && rel === "index.html") return setupPage();
        return send(res, 404, "File not found", "text/plain");
      }
    }
    if (parts[0] !== "api") return send(res, 404, "Not found", "text/plain");
    if (parts[1] === "state" && req.method === "GET") {
      const withHist = await Promise.all(state.projects.map(async (p) => { const dir = projDir(p); const screen = ["screenshot.png", "screenshot.jpg", "ui.png"].some((f) => fs.existsSync(path.join(dir, f))) ? "screenshot" : fs.existsSync(path.join(dir, "ui.svg")) ? "sketch" : p.kind === "python" ? "report" : "page"; let dirty = false; try { dirty = (await git(dir, ["status", "--porcelain"])).trim().length > 0; } catch { /* no repo yet */ } return { ...p, history: await history(p), screen, dirty }; }));
      return send(res, 200, { projects: withHist, tasks: state.tasks, feed: state.feed, agents: state.agents, brain: { provider: "Muse", cli: MUSE_OK, plannerModel: PLANNER_MODEL, workerModel: WORKER_MODEL, label: `Muse · ${PLANNER_MODEL} plans · ${WORKER_MODEL} builds` }, templates: TEMPLATES });
    }
    if (parts[1] === "settings" && req.method === "POST") { const b = await readBody(req); if (["muse-spark-1.3", "muse-wonder-1.0"].includes(b.plannerModel)) { PLANNER_MODEL = b.plannerModel; return send(res, 200, { ok: true, plannerModel: PLANNER_MODEL }); } return send(res, 400, { error: "Unknown planner model" }); }
    if (parts[1] === "agents" && req.method === "POST") { const b = await readBody(req); const name = String(b.name || "").trim(); const role = String(b.role || "").trim(); if (!name || !role) return send(res, 400, { error: "Name and role are required." }); const id = b.id && state.agents[b.id] ? b.id : uid("a"); state.agents[id] = { name, role, skills: String(b.skills || "").trim(), color: /^#[0-9a-fA-F]{6}$/.test(b.color || "") ? b.color : "#0071E3", icon: ["spark", "pencil", "code", "shield", "flask", "eye", "rocket", "star"].includes(b.icon) ? b.icon : "spark", ini: name.slice(0, 1).toUpperCase(), cls: "" }; save(); return send(res, 200, { ok: true, id, agents: state.agents }); }
    if (parts[1] === "agents" && parts[2] && req.method === "DELETE") { if (!state.agents[parts[2]]) return send(res, 404, { error: "No such teammate" }); if (Object.keys(state.agents).length <= 1) return send(res, 400, { error: "Your team needs at least one person." }); delete state.agents[parts[2]]; save(); return send(res, 200, { ok: true, agents: state.agents }); }
    if (parts[1] === "projects" && parts[2] === "import" && req.method === "POST") { const b = await readBody(req); try { return send(res, 201, await importProject({ sourcePath: b.path, name: b.name })); } catch (e) { return send(res, 400, { error: String(e.message || e) }); } }
    if (parts[1] === "projects" && parts[3] === "steps" && parts[5] === "screenshot" && req.method === "GET") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); const fp = shotPath(p, parts[4]); if (!fs.existsSync(fp)) return send(res, 404, { error: "No screenshot for this step yet" }); res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }); return res.end(fs.readFileSync(fp)); }
    if (parts[1] === "projects" && parts[3] === "screenshot" && req.method === "POST") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); const b = await readBody(req); const ok = await captureShot(p, b.hash); return send(res, ok ? 200 : 500, { ok }); }
    if (parts[1] === "projects" && parts[3] === "build" && req.method === "POST") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); if (p.framework) { try { if (!fs.existsSync(path.join(projDir(p), "node_modules"))) { p.setup = "installing"; save(); void setupFramework(p); return send(res, 202, { ok: true, setup: "installing" }); } await buildProject(p); const head = (await git(projDir(p), ["rev-parse", "HEAD"])).trim(); await snapshotBuild(p, head); p.setup = "ready"; delete p.setupError; save(); void captureShot(p, head); return send(res, 200, { ok: true, setup: "ready" }); } catch (e) { p.setup = "failed"; p.setupError = String(e.stderr || e.message || e).slice(-600); save(); return send(res, 500, { error: "Build failed", detail: p.setupError }); } } if (p.kind === "python" || p.kind === "mac" || p.kind === "unity") { const dir = projDir(p); p.build = { running: true, ok: null, at: Date.now(), log: "Building now…" }; save(); try { const log = await runBuild(p); p.build = { ok: true, at: Date.now(), log }; let head = (await git(dir, ["rev-parse", "HEAD"])).trim(); try { if ((await git(dir, ["status", "--porcelain"])).trim()) head = await commitAll(dir, `Build: ${p.kind} project`); } catch { /* commit best-effort */ } save(); void captureShot(p, head); return send(res, 200, { ok: true, build: p.build }); } catch (e) { p.build = { ok: false, at: Date.now(), log: String(e.stderr || e.stdout || e.message || e).slice(-600) }; save(); return send(res, 500, { error: "Build failed", detail: p.build.log }); } } return send(res, 400, { error: "This project doesn't have a build." }); }
    if (parts[1] === "projects" && parts[3] === "run" && req.method === "POST") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); if (!(p.kind === "python" || p.kind === "mac" || p.kind === "unity")) return send(res, 400, { error: "Build + Run is for Mac, Unity and Python projects — web projects already run in the preview." }); p.build = { running: true, ok: null, at: Date.now(), log: "Building now…" }; save(); try { const run = await runApp(p); let head = (await git(projDir(p), ["rev-parse", "HEAD"])).trim(); try { if ((await git(projDir(p), ["status", "--porcelain"])).trim()) head = await commitAll(projDir(p), `Build + Run: ${p.kind} project`); } catch { /* commit best-effort */ } save(); void captureShot(p, head); return send(res, 200, { ok: true, build: p.build, run }); } catch (e) { p.build = { ok: false, at: Date.now(), log: String(e.stderr || e.stdout || e.message || e).slice(-600) }; p.run = { ok: false, at: Date.now(), log: p.build.log }; save(); return send(res, 500, { error: "Build + Run didn't finish", detail: p.build.log }); } }
    if (parts[1] === "projects" && parts[3] === "budget" && req.method === "POST") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); const b = await readBody(req); const n = Number(b.budget); if (!Number.isFinite(n) || n < 0) return send(res, 400, { error: "Budget must be 0 (no limit) or a positive token count." }); p.budget = Math.floor(n); save(); return send(res, 200, { ok: true, budget: p.budget, usage: usageOf(p.id) }); }
    if (parts[1] === "projects" && parts.length === 2 && req.method === "POST") { const b = await readBody(req); if (!b.name?.trim()) return send(res, 400, { error: "Name required" }); return send(res, 201, await createProject({ name: b.name.trim(), type: b.type, color: b.color, desc: b.desc, template: b.template })); }
    if (parts[1] === "projects" && parts[3] === "tasks" && req.method === "POST") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); const b = await readBody(req); if (!b.text?.trim()) return send(res, 400, { error: "Write a request first" }); return send(res, 201, await addTask(p, b.text.trim(), b.agent)); }
    if (parts[1] === "projects" && parts[3] === "history" && req.method === "GET") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); return send(res, 200, await history(p)); }
    if (parts[1] === "projects" && parts.length === 3 && req.method === "DELETE") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); try { fs.rmSync(projDir(p), { recursive: true, force: true }); } catch { /* already gone */ } state.projects = state.projects.filter((x) => x.id !== p.id); state.tasks = state.tasks.filter((x) => x.projectId !== p.id); try { fs.rmSync(path.join(SHOTS_DIR, p.id), { recursive: true, force: true }); } catch { /* shots are best-effort */ } save(); return send(res, 200, { ok: true }); }
    if (parts[1] === "projects" && parts[3] === "download" && req.method === "GET") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); const files = (await git(projDir(p), ["ls-files"])).trim().split("\n").filter(Boolean); if (files.length <= 1) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `attachment; filename="${slug(p.name)}.html"`, "Cache-Control": "no-store" }); return res.end(fs.readFileSync(path.join(projDir(p), "index.html"), "utf8")); } const { stdout } = await run("tar", ["-czf", "-", "-C", projDir(p), "--exclude=.git", "."], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 }); res.writeHead(200, { "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="${slug(p.name)}.tar.gz"`, "Cache-Control": "no-store" }); return res.end(stdout); }
    if (parts[1] === "projects" && parts[3] === "reorder" && req.method === "POST") { const b = await readBody(req); (b.order || []).forEach((id, i) => { const t = state.tasks.find((x) => x.id === id); if (t) t.priority = i + 1; }); save(); return send(res, 200, { ok: true }); }
    if (parts[1] === "projects" && parts[3] === "restore" && req.method === "POST") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); const b = await readBody(req); const hist = await history(p); const step = hist.find((h) => h.hash === b.hash); if (!step) return send(res, 400, { error: "Unknown step" }); await git(projDir(p), ["checkout", b.hash, "--", "."]); const hash = await commitAll(projDir(p), `Back to step ${step.step}: ${step.message}`); if (p.framework) { try { await buildProject(p); await snapshotBuild(p, hash); } catch { p.setup = "failed"; } } void captureShot(p, hash); feed("noor", `<b>You</b> went back to step ${step.step} (“${step.message}”). Saved as a new step — nothing was erased.`); save(); return send(res, 200, { ok: true, hash, history: await history(p) }); }
    if (parts[1] === "tasks" && parts[2]) {
      const t = state.tasks.find((x) => x.id === parts[2]); if (!t) return send(res, 404, { error: "No task" });
      if (parts[3] === "run" && req.method === "POST") return send(res, 200, await runTask(t));
      if (parts[3] === "check" && req.method === "POST") { const p = projById(t.projectId); await runChecker(t, p); return send(res, 200, t); }
      if (parts[3] === "approve" && req.method === "POST") { t.status = "done"; say(t.agent, `Approved by you ✓ — “${shortTitle(t.title)}” is live`); const next = queueOf(t.projectId).find((x) => x.status === "todo"); if (next) say(next.agent, `I'm up next: “${shortTitle(next.title)}”`); save(); return send(res, 200, t); }
      if (parts[3] === "undo" && req.method === "POST") { const p = projById(t.projectId); if (t.commit) { await git(projDir(p), ["checkout", t.commit + "^", "--", "."]); const uh = await commitAll(projDir(p), `Undo: ${t.title}`); if (p.framework) { try { await buildProject(p); await snapshotBuild(p, uh); } catch { p.setup = "failed"; } } void captureShot(p, uh); } t.status = "todo"; t.progress = 0; t.commit = null; feed(t.agent, `<b>You</b> undid “${t.title}”. The previous version is back.`); save(); return send(res, 200, t); }
    }
    return send(res, 404, { error: "Unknown route" });
  } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
});

/* Seed one starter project only on the very first run ever (no state file yet).
   After that, an empty project list is the user's choice and stays empty. */
const hadStateFile = fs.existsSync(STATE_FILE);
if (!hadStateFile && !state.projects.length) {
  await createProject({ name: "Aurora — Coffee brand", type: "website", color: "#9A3412", desc: "Small-batch beans from farms we know by name, roasted the week they ship." });
}
probeMuse();
server.listen(PORT, () => console.log(`Muse Maker on http://localhost:${PORT} · brain: Muse (planner ${PLANNER_MODEL} · worker ${WORKER_MODEL})`));
