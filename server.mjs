/* Muse Maker server — real projects, real git, real rendering.
   Brain: Muse only. The superagent and every subagent are headless Muse sessions
   (`muse exec`, Meta provider) running muse-* models — Muse Spark, Muse Wonder, etc.
   Auth is your Muse login on this machine (`muse login`). No API keys are stored here.
   Model choice in .env: MUSE_MODEL_PLANNER / MUSE_MODEL_WORKER (or MUSE_MODEL for both).
   Everything else (files, git, history, preview) is local and always real. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
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
const MUSE_BIN = process.env.MUSE_BIN || "muse";
let PLANNER_MODEL = process.env.MUSE_MODEL_PLANNER || process.env.MUSE_MODEL || "muse-wonder-1.0";
const WORKER_MODEL = process.env.MUSE_MODEL_WORKER || process.env.MUSE_MODEL || "muse-spark-1.3";
let MUSE_OK = null; // null=unknown, true=muse exec works, false=CLI missing/logged out

export const AGENTS = {
  mira: { name: "Mira", role: "Designer", ini: "M", cls: "av-mira", skills: "look, colour, layout, brand, typography, poster, polish" },
  kai:  { name: "Kai", role: "Builder", ini: "K", cls: "av-kai", skills: "features, buttons, pages, charts, forms, functionality" },
  noor: { name: "Noor", role: "Checker", ini: "N", cls: "av-noor", skills: "checking, contrast, accessibility, consistency, proofreading" },
  leo:  { name: "Leo", role: "Tester", ini: "L", cls: "av-leo", skills: "testing on devices, tapping, flows, edge cases" }
};
const AGENT_KEYS = Object.keys(AGENTS);

/* ---------- state ---------- */
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
let state = { projects: [], tasks: [], feed: [] };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { /* first run */ }
function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
const uid = (p) => p + Date.now().toString(36) + Math.floor(Math.random() * 999).toString(36);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "project";
function feed(agent, text) { state.feed.unshift({ id: uid("f"), agent, text, at: Date.now() }); state.feed = state.feed.slice(0, 30); }
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
async function history(p) {
  try {
    const out = await git(projDir(p), ["log", "--reverse", "--format=%H%x7c%h%x7c%s%x7c%ct"]);
    return out.trim().split("\n").filter(Boolean).map((line, i) => {
      const [hash, short, message, ts] = line.split("|");
      return { step: i + 1, hash, short, message, at: Number(ts) * 1000 };
    });
  } catch { return []; }
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
  ]
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
  const agent = (RULES.find(([re]) => re.test(text)) || [null, "kai"])[1];
  const priority = /urgent|first|before anything/i.test(text) ? 1 : /later|someday/i.test(text) ? 4 : 2;
  return { agent, priority, reason: `Best match: ${AGENTS[agent].name} (${AGENTS[agent].role}) — ${AGENTS[agent].skills}.`, what: "Your team will show you a visual here before anything ships.", why: "You asked for it — and nothing goes live without your approval." };
}
async function planTask(project, text) {
  const r = await museRun({ workspace: ROOT, model: PLANNER_MODEL, readOnly: true, timeoutMs: 240000, maxSteps: Number(process.env.MUSE_PLANNER_MAX_STEPS || 3),
    prompt: `You are the superagent in Muse Maker. You order and assign user requests to subagents (Mira=Designer look/colour/layout, Kai=Builder features, Noor=Checker quality/accessibility, Leo=Tester devices/flows). Project: ${project.name} (${project.type}). Request: "${text}". Reply with ONLY this JSON, no other text: {"agent":"mira|kai|noor|leo","priority":1,"reason":"one plain-English sentence","what":"one plain-English sentence describing the visible change","why":"one plain-English sentence why it helps"}. Priority 1-5, lower = sooner. No jargon.` });
  if (r?.text) { try { const m = r.text.match(/\{[\s\S]*\}/); const p = JSON.parse(m[0]); if (AGENT_KEYS.includes(p.agent)) return { agent: p.agent, priority: Math.min(5, Math.max(1, p.priority || 2)), reason: String(p.reason || ""), what: String(p.what || ""), why: String(p.why || ""), brain: `muse:${PLANNER_MODEL}`, planTokens: r.tokens || 0 }; } catch { /* fall through */ } }
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
    const card = `<div class="cards"><div class="card"><b>${task.title.replace(/</g, "")}</b>Added by ${AGENTS[task.agent].name} (${AGENTS[task.agent].role}) for this step. Review it visually, then approve or ask for a tweak.</div></div>`;
    out = out.replace("<!--EXTRA-->", card + "<!--EXTRA-->"); notes.push("A new section was added for this step");
  }
  return { html: out, note: notes.join(". ") + "." };
}
/* A subagent IS a Muse session in the project workspace, editing real files with its tools. */
async function runMuseWorker(task, project, dir) {
  const a = AGENTS[task.agent];
  return museRun({ workspace: dir, model: WORKER_MODEL, timeoutMs: 420000, preset: process.env.MUSE_WORKER_PRESET || "miniswe", maxSteps: Number(process.env.MUSE_WORKER_MAX_STEPS || 14),
    prompt: `You are ${a.name}, the ${a.role}, a subagent in Muse Maker working in this workspace. The project is "${project.name}" (${project.type}). Its entry point is index.html. User request: "${task.title}". Use your file tools to edit index.html so this change is clearly visible when rendered. You may also create or edit linked local files (like styles.css or app.js, linked with relative paths) when that genuinely helps, but index.html must stay the entry point. Keep the <!--EXTRA--> marker in index.html, keep existing content unless asked to remove it, no external scripts or CDN links. Do not ask questions. When done, reply with ONE short plain-English sentence describing the visible change (no file names, no code).` });
}

/* Noor, the Checker: a separate read-only Muse session reviewing the actual diff of a step. */
async function runChecker(t, p) {
  if (!t.commit) return null;
  const dir = projDir(p);
  let diff = "";
  try { diff = (await git(dir, ["show", "--format=", "--unified=1", t.commit])).slice(0, 8000); } catch { return null; }
  const r = await museRun({ workspace: dir, model: WORKER_MODEL, readOnly: true, timeoutMs: 240000, maxSteps: Number(process.env.MUSE_CHECKER_MAX_STEPS || 2),
    prompt: `You are Noor, the Checker in Muse Maker. Another subagent just made this change. User request: "${t.title}". What they say changed: "${t.what || ""}". Here is the actual diff (may be truncated):\n${diff}\nJudge only: does the diff plausibly do what was asked, without obviously breaking the page (unclosed tags, removed content that should stay, broken structure)? Reply with ONLY this JSON: {"verdict":"pass" or "fix","note":"one short plain-English sentence a non-technical owner understands"}.` });
  if (r?.text) {
    try { const m = r.text.match(/\{[\s\S]*\}/); const j = JSON.parse(m[0]);
      t.check = { verdict: j.verdict === "fix" ? "fix" : "pass", note: String(j.note || "").slice(0, 300), tokens: r.tokens || 0, model: r.models?.[0] || WORKER_MODEL, at: Date.now() };
    } catch { t.check = { verdict: "unknown", note: "Noor's check came back unreadable — use your eyes on the Compare view.", tokens: r.tokens || 0, model: WORKER_MODEL, at: Date.now() }; }
  } else t.check = { verdict: "unknown", note: "Noor couldn't run just now — use your eyes on the Compare view.", tokens: 0, model: WORKER_MODEL, at: Date.now() };
  feed("noor", `<b>Noor (Checker)</b> ${t.check.verdict === "pass" ? "passed" : t.check.verdict === "fix" ? "flagged" : "couldn't check"} “${t.title}” — ${t.check.note}`);
  save(); return t.check;
}

/* ---------- project / task actions ---------- */
async function createProject({ name, type, color, desc, template }) {
  const p = { id: uid("p"), dir: slug(name) + "-" + Date.now().toString(36), name, type: ["website", "app", "poster", "dashboard", "slides", "shop"].includes(type) ? type : "website", color: color || "#0071E3", desc: desc || "A new project, ready for your team.", createdAt: Date.now() };
  const dir = projDir(p); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), scaffold(p.type, p.name, p.color, p.desc, template));
  await gitInit(dir);
  const hash = await commitAll(dir, "Muse Maker: project created");
  state.projects.push(p); feed("mira", `<b>${p.name}</b> created. The canvas is live — add a request to begin.`);
  const first = { id: uid("t"), projectId: p.id, title: "First visual pass — set the direction", agent: "mira", status: "todo", progress: 0, priority: 1, reason: "Every project starts with a visual direction.", what: "Mira will set the first layout and colour mood on the blank canvas.", why: "You approve the direction before detail work begins.", commit: null, createdAt: Date.now(), brain: "local" };
  state.tasks.push(first); save();
  return { project: p, initialCommit: hash };
}
function queueOf(projectId) {
  return state.tasks.filter((t) => t.projectId === projectId && (t.status === "todo" || t.status === "doing"))
    .sort((a, b) => (a.priority - b.priority) || (a.createdAt - b.createdAt));
}
async function addTask(project, text, pref) {
  const plan = pref && AGENT_KEYS.includes(pref) ? { agent: pref, priority: 2, reason: `You chose ${AGENTS[pref].name}.`, what: "Your team will show you a visual here before anything ships.", why: "You asked for it — and nothing goes live without your approval.", brain: "local" } : await planTask(project, text);
  const t = { id: uid("t"), projectId: project.id, title: text, agent: plan.agent, status: "todo", progress: 0, priority: plan.priority, reason: plan.reason, what: plan.what, why: plan.why, commit: null, createdAt: Date.now(), brain: plan.brain, planTokens: plan.planTokens || 0 };
  state.tasks.push(t);
  feed(t.agent, `<b>${AGENTS[t.agent].name} (${AGENTS[t.agent].role})</b> was assigned “${text}” — position ${queueOf(project.id).findIndex((x) => x.id === t.id) + 1} in the queue.`);
  save(); return t;
}
async function probeMuse() {
  try { await run(MUSE_BIN, ["--version"], { timeout: 15000 }); MUSE_OK = true; }
  catch { MUSE_OK = false; console.log("Muse CLI not found — local fallback edits will run. Install Muse / run `muse login`."); }
}
const running = new Set();
async function runTask(t) {
  if (running.has(t.id)) return t; running.add(t.id);
  const p = projById(t.projectId); const dir = projDir(p); const file = path.join(dir, "index.html");
  try {
    t.status = "doing"; t.progress = 40; save();
    const before = fs.readFileSync(file, "utf8");
    const result = await runMuseWorker(t, p, dir);
    let changed = false;
    try { changed = (await git(dir, ["status", "--porcelain"])).trim().length > 0; } catch { changed = false; }
    let valid = false;
    if (changed) { try { const now = fs.readFileSync(file, "utf8"); valid = now.includes("</html>") && now.length > 200; } catch { valid = false; } }
    let executor;
    if (result && changed && valid) {
      executor = `muse:${result.models?.[0] || WORKER_MODEL}`;
      const sentence = result.text.trim().split("\n").pop().slice(0, 300);
      if (sentence) t.what = sentence;
      t.models = result.models; t.tokens = result.tokens || 0;
    } else {
      if (changed) { try { await git(dir, ["checkout", "--", "index.html"]); } catch { fs.writeFileSync(file, before); } }
      const r = localEdit(fs.readFileSync(file, "utf8"), t);
      fs.writeFileSync(file, r.html); executor = "local-fallback"; if (r.note) t.what = r.note;
      t.executorNote = MUSE_OK === false ? "Muse CLI not found on the server — local fallback made this edit. Install Muse and `muse login`, then restart." : "The Muse step didn't produce a valid change — local fallback made this edit instead.";
    }
    t.commit = await commitAll(dir, `${AGENTS[t.agent].name} (${AGENTS[t.agent].role}): ${t.title}`);
    try { const ns = (await git(dir, ["diff", "HEAD~1", "HEAD", "--numstat"])).trim().split("\t"); t.diff = { add: Number(ns[0]) || 0, del: Number(ns[1]) || 0 }; } catch { /* first commit */ }
    t.status = "review"; t.progress = 100; t.executor = executor;
    feed(t.agent, `<b>${AGENTS[t.agent].name}</b> finished “${t.title}”. Ready for your eyes.`);
    if (executor.startsWith("muse:") && process.env.AUTO_CHECK !== "0") { t.progress = 100; save(); await runChecker(t, p); }
  } catch (e) { t.status = "todo"; t.progress = 0; t.error = String(e.message || e); }
  finally { running.delete(t.id); save(); }
  return t;
}
async function fileAt(p, hash) { return git(projDir(p), ["show", `${hash}:index.html`]); }

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
    if (parts[0] === "preview" && parts[1]) {
      const p = projById(parts[1]); if (!p) return send(res, 404, "Project not found", "text/plain");
      if (parts[2] === "at" && parts[3]) return send(res, 200, await fileAt(p, parts[3]), "text/html");
      if (parts[2] === "before-task" && parts[3]) { const t = state.tasks.find((x) => x.id === parts[3]); if (t?.commit) return send(res, 200, await fileAt(p, t.commit + "^"), "text/html"); return send(res, 200, await fileAt(p, "HEAD"), "text/html"); }
      if (parts[2] && parts[2] !== "current") { /* linked project files: styles.css, app.js, images… */
        const rel = decodeURIComponent(parts.slice(2).join("/"));
        const dir = projDir(p); const full = path.resolve(dir, rel);
        const TYPES = { ".css": "text/css", ".js": "text/javascript", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".txt": "text/plain" };
        if (full.startsWith(dir + path.sep) && TYPES[path.extname(full)] && fs.existsSync(full)) return send(res, 200, fs.readFileSync(full), TYPES[path.extname(full)]);
        return send(res, 404, "File not found", "text/plain");
      }
      return send(res, 200, fs.readFileSync(path.join(projDir(p), "index.html"), "utf8"), "text/html");
    }
    if (parts[0] !== "api") return send(res, 404, "Not found", "text/plain");
    if (parts[1] === "state" && req.method === "GET") {
      const withHist = await Promise.all(state.projects.map(async (p) => ({ ...p, history: await history(p) })));
      return send(res, 200, { projects: withHist, tasks: state.tasks, feed: state.feed, agents: AGENTS, brain: { provider: "Muse", cli: MUSE_OK, plannerModel: PLANNER_MODEL, workerModel: WORKER_MODEL, label: `Muse · ${PLANNER_MODEL} plans · ${WORKER_MODEL} builds` }, templates: TEMPLATES });
    }
    if (parts[1] === "settings" && req.method === "POST") { const b = await readBody(req); if (["muse-spark-1.3", "muse-wonder-1.0"].includes(b.plannerModel)) { PLANNER_MODEL = b.plannerModel; return send(res, 200, { ok: true, plannerModel: PLANNER_MODEL }); } return send(res, 400, { error: "Unknown planner model" }); }
    if (parts[1] === "projects" && parts.length === 2 && req.method === "POST") { const b = await readBody(req); if (!b.name?.trim()) return send(res, 400, { error: "Name required" }); return send(res, 201, await createProject({ name: b.name.trim(), type: b.type, color: b.color, desc: b.desc, template: b.template })); }
    if (parts[1] === "projects" && parts[3] === "tasks" && req.method === "POST") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); const b = await readBody(req); if (!b.text?.trim()) return send(res, 400, { error: "Write a request first" }); return send(res, 201, await addTask(p, b.text.trim(), b.agent)); }
    if (parts[1] === "projects" && parts[3] === "history" && req.method === "GET") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); return send(res, 200, await history(p)); }
    if (parts[1] === "projects" && parts.length === 3 && req.method === "DELETE") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); try { fs.rmSync(projDir(p), { recursive: true, force: true }); } catch { /* already gone */ } state.projects = state.projects.filter((x) => x.id !== p.id); state.tasks = state.tasks.filter((x) => x.projectId !== p.id); save(); return send(res, 200, { ok: true }); }
    if (parts[1] === "projects" && parts[3] === "download" && req.method === "GET") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); const files = (await git(projDir(p), ["ls-files"])).trim().split("\n").filter(Boolean); if (files.length <= 1) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `attachment; filename="${slug(p.name)}.html"`, "Cache-Control": "no-store" }); return res.end(fs.readFileSync(path.join(projDir(p), "index.html"), "utf8")); } const { stdout } = await run("tar", ["-czf", "-", "-C", projDir(p), "--exclude=.git", "."], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 }); res.writeHead(200, { "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="${slug(p.name)}.tar.gz"`, "Cache-Control": "no-store" }); return res.end(stdout); }
    if (parts[1] === "projects" && parts[3] === "reorder" && req.method === "POST") { const b = await readBody(req); (b.order || []).forEach((id, i) => { const t = state.tasks.find((x) => x.id === id); if (t) t.priority = i + 1; }); save(); return send(res, 200, { ok: true }); }
    if (parts[1] === "projects" && parts[3] === "restore" && req.method === "POST") { const p = projById(parts[2]); if (!p) return send(res, 404, { error: "No project" }); const b = await readBody(req); const hist = await history(p); const step = hist.find((h) => h.hash === b.hash); if (!step) return send(res, 400, { error: "Unknown step" }); await git(projDir(p), ["checkout", b.hash, "--", "."]); const hash = await commitAll(projDir(p), `Back to step ${step.step}: ${step.message}`); feed("noor", `<b>You</b> went back to step ${step.step} (“${step.message}”). Saved as a new step — nothing was erased.`); save(); return send(res, 200, { ok: true, hash, history: await history(p) }); }
    if (parts[1] === "tasks" && parts[2]) {
      const t = state.tasks.find((x) => x.id === parts[2]); if (!t) return send(res, 404, { error: "No task" });
      if (parts[3] === "run" && req.method === "POST") return send(res, 200, await runTask(t));
      if (parts[3] === "check" && req.method === "POST") { const p = projById(t.projectId); await runChecker(t, p); return send(res, 200, t); }
      if (parts[3] === "approve" && req.method === "POST") { t.status = "done"; feed(t.agent, `<b>You</b> approved “${t.title}” — it's live.`); save(); return send(res, 200, t); }
      if (parts[3] === "undo" && req.method === "POST") { const p = projById(t.projectId); if (t.commit) { await git(projDir(p), ["checkout", t.commit + "^", "--", "."]); await commitAll(projDir(p), `Undo: ${t.title}`); } t.status = "todo"; t.progress = 0; t.commit = null; feed(t.agent, `<b>You</b> undid “${t.title}”. The previous version is back.`); save(); return send(res, 200, t); }
    }
    return send(res, 404, { error: "Unknown route" });
  } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
});

/* seed one real project so first load is already real */
if (!state.projects.length) {
  await createProject({ name: "Aurora — Coffee brand", type: "website", color: "#9A3412", desc: "Small-batch beans from farms we know by name, roasted the week they ship." });
}
probeMuse();
server.listen(PORT, () => console.log(`Muse Maker on http://localhost:${PORT} · brain: Muse (planner ${PLANNER_MODEL} · worker ${WORKER_MODEL})`));
