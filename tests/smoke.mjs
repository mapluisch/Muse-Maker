/* Muse Maker smoke test — no Muse tokens spent.
   Requires the server running:  node server.mjs   (then: node tests/smoke.mjs)
   Covers non-AI paths: state, templated create, preview, history, settings guard, download, delete.
   Muse paths (plan/run/check) are verified manually to keep charges down. */
const BASE = process.env.BASE || "http://localhost:5174";
let failures = 0;
function check(name, ok, extra = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`); if (!ok) failures++; }
async function req(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text, type: r.headers.get("content-type") || "" };
}

const state = await req("GET", "/api/state");
check("GET /api/state", state.status === 200 && Array.isArray(state.json.projects));
check("brain is Muse", state.json.brain?.provider === "Muse", state.json.brain?.label || "");
check("templates present", Boolean(state.json.templates?.website?.length), Object.keys(state.json.templates || {}).join(","));

/* frontend must define its $ helper before first use (TDZ regression guard) and parse cleanly */
{
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const main = scripts[scripts.length - 1];
  let parses = true; try { new Function(main.replace(/load\(\)\.catch[\s\S]*$/, "")); } catch { parses = false; }
  check("frontend script parses", parses);
  check("$ helper defined before first use", main.indexOf("const $ =") >= 0 && main.indexOf("const $ =") < main.indexOf('$("'));
}

const created = await req("POST", "/api/projects", { name: "Smoke Test", type: "website", color: "#0F766E", desc: "smoke", template: "coffee" });
check("POST create (coffee template)", created.status === 201, created.json?.project?.dir || "");
const pid = created.json.project.id;

const preview = await req("GET", `/preview/${pid}/current`);
check("preview renders template headline", preview.status === 200 && preview.text.includes("Coffee worth slowing down for"));

const hist = await req("GET", `/api/projects/${pid}/history`);
check("history has initial commit", hist.status === 200 && hist.json.length >= 1, `${hist.json?.length} step(s)`);

const bad = await req("POST", "/api/settings", { plannerModel: "not-a-model" });
check("settings rejects unknown model", bad.status === 400);

const dl = await req("GET", `/api/projects/${pid}/download`);
check("download single-file html", dl.status === 200 && dl.type.includes("text/html"));

const del = await req("DELETE", `/api/projects/${pid}`);
check("delete project", del.status === 200 && del.json?.ok === true);

const after = await req("GET", "/api/state");
check("cleanup: smoke project gone", !after.json.projects.find((p) => p.id === pid));

/* import an existing folder (zero Muse tokens) */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mm-import-"));
fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><html><head><title>Imported</title></head><body><h1>IMPORTED-MARKER</h1></body></html>");
const imp = await req("POST", "/api/projects/import", { path: tmp });
check("POST import existing folder", imp.status === 201, imp.json?.project?.name || imp.json?.error || "");
if (imp.json?.project?.id) {
  const ipid = imp.json.project.id;
  const iprev = await req("GET", `/preview/${ipid}/current`);
  check("imported project renders", iprev.status === 200 && iprev.text.includes("IMPORTED-MARKER"));
  const bok = await req("POST", `/api/projects/${ipid}/budget`, { budget: 5000 });
  check("budget set", bok.status === 200 && bok.json.budget === 5000);
  const bbad = await req("POST", `/api/projects/${ipid}/budget`, { budget: -5 });
  check("budget rejects negative", bbad.status === 400);
  const idel = await req("DELETE", `/api/projects/${ipid}`);
  check("delete imported project", idel.status === 200);
}
const impBad = await req("POST", "/api/projects/import", { path: "/definitely/not/a/real/folder-xyz" });
check("import rejects missing folder", impBad.status === 400);
fs.rmSync(tmp, { recursive: true, force: true });

/* per-step screenshot (uses Chrome already on the machine; skipped silently if absent) */
{
  const c2 = await req("POST", "/api/projects", { name: "Smoke Shot", type: "website", desc: "screenshot smoke" });
  const spid = c2.json.project.id;
  const sh = await req("GET", `/api/projects/${spid}/history`);
  const hash = sh.json[0]?.hash;
  const cap = await req("POST", `/api/projects/${spid}/screenshot`, { hash });
  if (cap.status === 200 && cap.json.ok) {
    const img = await fetch(`${BASE}/api/projects/${spid}/steps/${hash}/screenshot`);
    check("step screenshot is PNG", img.status === 200 && (img.headers.get("content-type") || "").includes("image/png"));
    const sh2 = await req("GET", `/api/projects/${spid}/history`);
    check("history flags screenshot", sh2.json[0]?.shot === true);
  } else console.log("SKIP  screenshot (no headless Chrome available)");
  await req("DELETE", `/api/projects/${spid}`);
}
/* React framework path (slower: npm install) — opt-in with SMOKE_REACT=1 */
if (process.env.SMOKE_REACT === "1") {
  const rc = await req("POST", "/api/projects", { name: "Smoke React", type: "react", desc: "react smoke" });
  const rpid = rc.json.project.id;
  let setup = "";
  for (let i = 0; i < 40 && setup !== "ready" && setup !== "failed"; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await req("GET", "/api/state");
    setup = st.json.projects.find((p) => p.id === rpid)?.setup || "";
  }
  check("react setup ready", setup === "ready", setup);
  const rp = await req("GET", `/preview/${rpid}/current`);
  check("react preview serves build", rp.status === 200 && rp.text.includes('id="root"'));
  await req("DELETE", `/api/projects/${rpid}`);
} else console.log("SKIP  react framework (set SMOKE_REACT=1)");

/* editable team (zero Muse tokens) */
{
  const made = await req("POST", "/api/agents", { name: "Smoke Sofia", role: "Illustrator", skills: "icons, spots", color: "#FF6482", icon: "star" });
  check("agent create", made.status === 200 && Boolean(made.json.id), made.json.id || "");
  const st = await req("GET", "/api/state");
  check("agent in state with icon", st.json.agents[made.json.id]?.icon === "star" && st.json.agents[made.json.id]?.color === "#FF6482");
  const upd = await req("POST", "/api/agents", { id: made.json.id, name: "Smoke Sofia", role: "Motion Designer", skills: "icons, motion", color: "#FF6482", icon: "rocket" });
  check("agent update", upd.status === 200 && upd.json.agents[made.json.id]?.role === "Motion Designer");
  const bad = await req("POST", "/api/agents", { name: "", role: "" });
  check("agent rejects empty", bad.status === 400);
  const del = await req("DELETE", `/api/agents/${made.json.id}`);
  check("agent delete", del.status === 200 && !del.json.agents[made.json.id]);
}

/* Try-it-live + fullscreen regression guards (source-level, zero tokens) */
{
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  check("after mode fully reveals the after-frame (try-it-live clickable)", html.includes('mode==="before"?100:mode==="after"?0:compare'));
  check("fullscreen toggle wired", html.includes('id="fsBtn"') && html.includes("#frame:fullscreen") && html.includes("requestFullscreen"));
  check("non-web build view in stage", html.includes("buildview") && html.includes('p.kind==="mac"'));
  check("status strip + live elapsed wired", html.includes('id="statusStrip"') && html.includes("renderStatus") && html.includes("js-elapsed"));
  check("live polling sees phases/builds + selection survives refresh", html.includes("setInterval(pollState, 5000)") && html.includes('getItem("mm-project")') && html.includes('setItem("mm-project"'));
  const srv = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  check("build+run wired", html.includes('id="runAppBtn"') && srv.includes('parts[3] === "run"') && srv.includes("launchDetached"));
  check("server tracks phases and reconciles orphans", srv.includes("setPhase") && srv.includes("Stopped before it finished") && srv.includes("Auto-saved work already in the files"));
}

/* Python tool projects: create -> report generated -> build reruns (zero Muse tokens) */
{
  const pc = await req("POST", "/api/projects", { name: "Smoke Py", type: "python", desc: "smoke python" });
  check("python create", pc.status === 201 && pc.json.project.kind === "python", pc.json.project.kind || "");
  if (pc.json?.project?.id) {
    const ppid = pc.json.project.id;
    const pv = await req("GET", `/preview/${ppid}/current`);
    check("python report renders in the middle", pv.status === 200 && pv.text.includes("PYTHON REPORT"));
    const pb = await req("POST", `/api/projects/${ppid}/build`, {});
    check("python build runs main.py", pb.status === 200 && pb.json.build?.ok === true, pb.json.build?.log || pb.json?.error || "");
    const pr = await req("POST", `/api/projects/${ppid}/run`, {});
    check("python build+run executes", pr.status === 200 && pr.json.run?.ok === true, pr.json.run?.log || pr.json?.error || "");
    await req("DELETE", `/api/projects/${ppid}`);
  }
}

/* Mac + Unity projects: build-screen view (builds themselves are manual/slow, not smoked) */
for (const [type, kind] of [["mac", "mac"], ["unity", "unity"]]) {
  const mc = await req("POST", "/api/projects", { name: "Smoke " + kind, type, desc: "smoke " + kind });
  check(kind + " create", mc.status === 201 && mc.json.project.kind === kind, mc.json.project.kind || "");
  if (mc.json?.project?.id) {
    const mpid = mc.json.project.id;
    const bv = await req("GET", `/preview/${mpid}/buildview`);
    check(kind + " build view shows screen + status", bv.status === 200 && bv.text.includes("ui.svg") && bv.text.includes("Not built yet"));
    const st = await req("GET", "/api/state");
    const mp = st.json.projects.find((p) => p.id === mpid);
    check(kind + " state reports screen + clean files", mp?.screen === "sketch" && mp?.dirty === false, `${mp?.screen}/${mp?.dirty}`);
    await req("DELETE", `/api/projects/${mpid}`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
