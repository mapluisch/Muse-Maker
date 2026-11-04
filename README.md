# Muse Maker

**See what your agents built — don't read about it.**

Meta Global AI Developer Hackathon Entry

Muse Maker is a visual, layman-friendly frontend for coding agents. Instead of flooding you with text walls and red/green diffs, it shows you the *actual rendered change*, who did it, and lets you approve it with one tap.

## The problem

Frontier agents are so productive that users stop reviewing. They get a wall of text, shrug, and hit Accept — without knowing what changed. That's how bugs, ugly designs, and unwanted changes ship.

## The idea

- **Visual, not textual** — every change is a draggable Before / After of the real rendered app, with orange pins on *what* moved. No diffs.
- **Plain English always** — "What changed" and "Why it helps you" in human words. No jargon, no file names.
- **People, not processes** — your agents are a team (Designer, Builder, Checker, Tester) with faces, roles, and "who did / is doing / checked this" on every card.
- **You stay the boss** — nothing ships until you tap ✓ Looks good. Everything is reversible. A Checker has already tried to break it before you see it.
- **For everyone** — if you can describe it like you'd tell a friend ("make the button bigger"), you can direct a team of agents.

## Run it locally

```bash
node server.mjs
# open http://localhost:5174
```

No dependencies, no build step. The server is the product: it creates real projects in `projects/` (each its own git repo), plans, executes, renders, and keeps history.

### The brain

Muse only — no third-party APIs, no keys stored. Every agent is a headless Muse session (`muse exec`, Meta provider). Auth is your Muse login on this machine (`muse login`); Muse Maker never sees a key. Current `.env` runs **cost-saver mode**: `muse-spark-1.3` plans *and* builds, at low reasoning effort, with the lean `miniswe` worker preset and step caps (planner ≤3 steps, worker ≤14) — a verified design step used ~54k tokens vs ~144k uncapped. Flip **Planner · Spark/Wonder** in the header when you want deeper planning (workers always stay Spark unless you change `.env`); the badge always shows what's actually running. Projects are multi-file now: workers may add linked `styles.css`/`app.js` etc., the preview serves them, git history/restore/undo cover all files, and **Download** exports `.html` for single-file projects or `.tar.gz` when a project has grown files. Every card shows which Muse ran, how many tokens it used, and the line diff — cost is never hidden. If the Muse CLI is missing or logged out, a deterministic local fallback still makes real edits/commits and the header badge + task card say so honestly.

### How a step flows

`New request → superagent orders + assigns (Mira/Kai/Noor/Leo) → Run this step (or Run queue in order) → subagent edits projects/<name>/index.html → git commit → Noor (a separate read-only Muse session) reviews the actual diff and posts a pass/flag note → you compare Before/After → Approve / Tweak / Undo`. The UI only says "checked by Noor" when that check really ran; older steps get an **Ask Noor to check** button. Set `AUTO_CHECK=0` in `.env` to skip auto-checks and save tokens. History is a timeline of commits: tap any step to view it rendered (read-only); **Restore** saves that version as a new commit on top — history is never rewritten.

## Any visual project — not one hardcoded app

The center canvas renders the *real project files* — anything browser-renderable belongs there. Create from scratch in six flavours: **Website, Mobile app, Poster, Dashboard, Slides, Shop** (`+ New project`: name, type, template, colour mood, one-line description). Each type ships starting templates (Coffee shop, Portfolio, Festival, Pitch…) so a new project already looks like something; Blank canvas is always there. Regression-check the non-AI paths any time with `npm test` (server must be running; spends no Muse tokens). One real project (**Aurora**, a coffee brand site) is seeded so the first open already has history; everything else you create yourself. **Try it live** makes the preview clickable so you can use the project, not just look at it; **Download** exports the single-file HTML.

## Try this flow (60 seconds)

1. **Aurora** is open. Left, under **For you**, pick a finished step.
2. Drag **Compare** — left is before that step, right is after. Real rendered files, not screenshots of a mock.
3. Read the one-line *what changed*, the token cost, and the line diff → **Approve**, **Ask for a tweak**, or **Undo step**.
4. Scrub **History** below the canvas to look back; **Restore** re-saves any step on top.
5. **+ New request** in plain English → the Spark superagent assigns it and queues it → **Run queue in order**.

## What's real

Everything user-facing is real: project files, git commits/history/restore, Muse planning and editing, rendering, token accounting. The only fallback is a deterministic local editor used solely when the Muse CLI is unavailable — and the UI labels those steps as local, never as Muse work.
