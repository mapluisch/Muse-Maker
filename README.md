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
python3 -m http.server 5173
# open http://localhost:5173
```

No build step. Single file: `index.html`.

## Any visual project — not one hardcoded app

The center canvas is a *renderer slot*. A project brings its own visual (website, mobile app, poster, dashboard, slides…); Muse Maker renders Before / After of the real thing and diffs it visually. The demo ships four: **Aurora** (website), **Pulse** (phone app), **Nord Fest** (poster), **Clarity** (dashboard). Use **+ New** to create your own — name, type, colour mood — and the team starts on a blank canvas of that type.

This is deliberately built to become a real project maker: swap a demo renderer for a real one (live DOM / screenshot of your actual project) and the tasks, team, compare, and approval flow stay identical.

## Try this flow (60 seconds)

1. Top: switch projects — **Aurora / Pulse / Nord Fest / Clarity / + New**. Notice the canvas changes shape: browser, phone, poster.
2. Left: click a request marked **For you**. Middle: drag to compare Before / After. Tap pin **1**.
3. Below the canvas: one line of *what changed* and *why* → **Approve**. Or **Ask for a tweak**.
4. Header: **Watch them work** — a Doing request finishes and becomes For you.
5. **+ New request** — plain English, auto-assigned to the right person.

## What's simulated vs real

This hackathon MVP simulates agent work with realistic demo data so anyone can judge the experience in a minute. The natural next step is wiring the same UI to real Muse sessions, git worktrees per agent, and headless screenshot capture for true Before/After renders.
