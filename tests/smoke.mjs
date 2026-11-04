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

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
