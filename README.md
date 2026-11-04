<h1 align="center">Muse Maker</h1>

<div align="center">
    <img src="logo.svg" width="18%" height="18%" alt="Muse Maker icon">
</div>

<p align="center">
    A local frontend for Muse that shows agent changes as rendered output instead of text.
</p>

<hr>

## Overview

<p align="center">
  <img src="docs/screenshot.png" alt="Muse Maker interface: request queue, rendered project with Before/After comparison, agent team" style="width: 92%;">
</p>

Coding agents produce changes faster than most people can review them. The default review surface — a long transcript plus a diff — does not scale: readers skim, then accept changes they have not actually evaluated.

Muse Maker takes a different approach. The project itself is rendered in the center of the window. Each agent step produces a new rendered state, shown next to the previous one, with a short description of what changed and why. The user approves, requests a change, or reverts. Nothing is presented as final before that decision.

The system runs locally. Projects are ordinary files on disk, each with its own git repository. All planning and editing is done by Muse sessions; Muse Maker handles state, rendering, history, and review.

<hr>

## How it works

1. Create a project, or import an existing folder. Project type can be selected manually or inferred from the name and description.
2. Add requests in plain language. A planner session (the "superagent") sorts the queue and assigns each request to a subagent by role.
3. The assigned subagent edits the real project files. Progress is reported as a sequence of phases — working, building, saving, checking — with elapsed time.
4. A separate, read-only checker session reviews the resulting diff and records a pass or a flag. Flags are queued back to the original author as fix requests.
5. The result appears as a Before/After rendering. Approve, request a tweak, or undo. Approval is the only path to "done".

Every completed step is a git commit. Any earlier step can be viewed rendered, read-only. Restoring a step checks it out and records it as a new commit; history is never rewritten.

## Supported project types

| Type | Behavior |
|---|---|
| Website, mobile app, poster, dashboard, slides, shop | Rendered directly from project files; starter templates included |
| React (Vite) | Dependencies installed and built by Muse Maker; build output snapshotted per step for Before/After |
| Python tool | `main.py` is executed; the report it generates is rendered in place |
| Mac app (SwiftUI) | Compiled with `swift build`; **Build + Run** packages a `.app` bundle and opens it |
| Unity game | Built headlessly with the installed Unity editor; stage shows the latest build screen and log |

Non-web projects cannot be rendered live in a browser frame, so the stage shows the latest build artifact — a `screenshot.png` from the project if present, otherwise a UI sketch generated from source — together with build status. This is labeled as such in the UI.

## Running

```bash
node server.mjs
# http://localhost:5174
```

There are no dependencies and no build step. Requirements: Node.js, git, and the Muse CLI, signed in (`muse login`). No API keys are stored, and no third-party AI service is contacted.

Optional, for React and native builds: `npm`, the Swift toolchain, Unity Hub, and Chrome (used for per-step screenshots; if absent, screenshots are skipped and can be captured manually).

## Models and cost

All agents are headless Muse sessions (`muse exec`, Meta provider). Configuration is in `.env`:

- `MUSE_MODEL_PLANNER` / `MUSE_MODEL_WORKER` select the Muse models. The shipped defaults use `muse-spark-1.3` for both; the planner can be switched to `muse-wonder-1.0` from the header.
- Reasoning effort and per-session step caps are set low by default, and workers run under a lean preset.
- Each project has an optional token budget. When it is exhausted, planning falls back to rules and execution to a deterministic local editor; both are labeled in the UI, and token usage per step is always displayed.
- `AUTO_CHECK=0` disables the checker session.

If the Muse CLI is missing or signed out, the local fallback still produces real edits and commits. Those steps are marked as local in the UI, never attributed to a model.

## Implementation notes

- `server.mjs` is the entire backend: project scaffolding and import, git operations, preview serving, build orchestration, screenshots, and the Muse session runner.
- State lives in `data/state.json`; projects live in `projects/<name>-<id>/`, each a separate git repository. Screenshots are stored per commit under `data/shots/`.
- One step runs per project at a time, so history cannot be corrupted by concurrent edits. A step interrupted by a restart is marked as stopped rather than left in a running state; uncommitted work in the files is auto-saved before the next run.
- The frontend is a single `index.html`. It polls state every five seconds and re-renders on change; the selected project and step persist across reloads.

## Testing

```bash
npm test
```

This runs `tests/smoke.mjs` against the running server. It covers project creation, import, previews, history, budgets, agent editing, builds for Python/Mac/Unity scaffolds, and frontend regressions. It spends no Muse tokens; the Muse paths (planning, execution, checking) are exercised manually.

## Limitations

- Local only. No accounts, sync, sharing, or multi-user collaboration.
- Native apps are shown as build artifacts, not live-rendered, and clicks are not mirrored into them. Web projects are fully interactive in the preview.
- Builds depend on toolchains installed on the machine. A missing or failing toolchain is reported in the build log rather than hidden.

## Contributing

Issues and pull requests are welcome. The acceptance criterion for UI changes: a non-technical user should be able to tell what changed, who changed it, and how to undo it, without reading a diff.
