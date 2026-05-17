# Multi-AI-Wrapper Handoff

Last updated: 2026-05-17

## Current State

Repo: `D:\Development\Projects\Multi-AI-Wrapper`

GitHub repo: `wandering-wampa/Multi-AI-Wrapper`

Branch status at handoff: `main...origin/main`

Only known untracked local item: `.vscode/` in the repo root. It was intentionally left uncommitted.

## Recent Commits

- `52687d9 Extract provider delivery scripts`
- `5d6679b Improve compare mode attachments and feedback`
- `99aabd7 Avoid BrowserView listener buildup`
- `604164d Refactor model catalog rules`

The first two were created and pushed in this session.

## What Changed In This Session

Compare mode received a UX and delivery pass:

- Custom tabs are now manual-only panes instead of failed automated-send targets.
- Compare send reports per-pane results with chips for sent, staged, manual, failed/loading states.
- Compare composer was visually tightened and made dark-mode friendly.
- Composer height is now reported from the renderer to the main process so provider panes are not covered by dynamic attachment/results content.
- Compare headers have minimal hide controls.
- Added "new chat in visible panes" action.
- Added readiness probing so status dots distinguish loaded vs composer-ready.
- First-run catalog behavior enables all built-in providers by default.
- Setup overlay was disabled because it blocked the top chrome behind `BrowserView` stacking.
- Prompt history popup now has search.
- Added a dedicated file attachment button next to image attachment.
- File attachments use the same staged/manual-submit compare workflow where provider file inputs support it.
- Provider-specific delivery script builders were extracted from `main.js` into `lib/provider-delivery.cjs`.

Important files:

- `main.js`
- `renderer.js`
- `index.html`
- `preload.js`
- `prompt-history.html`
- `prompt-history.js`
- `lib/model-catalog.cjs`
- `lib/provider-delivery.cjs`
- `test/model-catalog.test.cjs`
- `test/provider-delivery.test.cjs`

## Verification Already Done

Commands run successfully:

```sh
npm test
node --check main.js
node --check renderer.js
node --check preload.js
node --check lib/provider-delivery.cjs
```

User manually tested:

- Top tab/settings/compare controls after disabling setup overlay.
- Compare flow sufficiently to confirm "it is working."
- File button and staging path appeared to work.

## Dev Launch Note

The default repo-local `.dev-profile/` hit Electron cache access errors during launches. A temporary alternate profile was used:

```cmd
set MAW_PROFILE_DIR=D:\Development\Projects\Multi-AI-Wrapper\.dev-profile-codex&&npm start
```

`.dev-profile-codex/` was added to `.gitignore`.

## GitHub Issues

Closed during this session:

- `#1` Deepen model catalog rules into a testable module
- `#2` Deepen compare prompt delivery around provider-specific behavior

Still open:

- `#3` Deepen settings persistence and app state transitions
- `#4` Deepen auxiliary window lifecycle handling
- `#5` Deepen renderer model chrome
- `#6` Extract settings page script from inline HTML

Recommended next issue order:

1. `#6` Extract settings script from inline HTML.
2. `#5` Deepen renderer model chrome.
3. `#3` Settings persistence/state transitions.
4. `#4` Auxiliary window lifecycle.

## Known Caveats

- File staging depends on each provider exposing an `input[type="file"]`. Some providers may only create file inputs after opening their attach menu, so provider-specific follow-up issues may be needed.
- New-chat automation is best-effort by provider selectors and should be smoke-tested when provider UIs change.
- The disabled first-run setup overlay should be reintroduced later as a non-modal banner or Settings prompt, not as a full-screen renderer overlay over `BrowserView`.
- `main.js` is better after the provider extraction but still owns too much app state, persistence, window lifecycle, and compare orchestration.

## Suggested Skills For Next Session

- `triage`: for updating or creating provider-specific issues after smoke testing.
- `improve-codebase-architecture`: for issues `#3`, `#4`, and `#5`.
- `diagnose`: for provider-specific file upload/new-chat failures.
- `handoff`: when wrapping another long session.

## Resume Prompt

Use this to resume:

> Continue work in `D:\Development\Projects\Multi-AI-Wrapper`. Read `docs/handoff.md`, check `git status`, then pick up the remaining open GitHub issues. Prioritize issue `#6` unless I say otherwise. Preserve the pushed compare/file attachment work in commits `5d6679b` and `52687d9`.
