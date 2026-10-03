# dsh-session-delete

English | [中文](README.md)

Adds a destructive red **"Delete session"** row right below **"Archive session"** in the Session "…" menu of DeepSeek Harness (DSH) — it actually deletes the session's data instead of only archiving it.

> Tags: `dsh-plugin` · `dsh` · `deepseek-harness`

## What it does

DSH ships Archive only: an archived session stays on disk and can be restored. This plugin adds real deletion:

1. **Menu row** — a red "Delete session" row (trash icon, separator) beneath the shipped "Archive session" row in every sidebar Session's "…" menu.
2. **Two-step confirm** — the first click arms the row ("Click again to confirm", auto-reset after 6s), the second click runs it; the menu stays open and shows the outcome inline.
3. **What gets deleted**
   - the session's stored logs under `sessions/<workspace>/<session-id>/` (including `session.v4.jsonl.zstd`);
   - its registry accounting, through the workspace registry's own durable writes (`unpin` → `unarchive` → `detachSession`), so `workspace.json` is written by the registry itself — memory and disk never disagree, and later archives cannot resurrect the deleted id.

## Safety

- **Running sessions are refused** — the same activity gate the official archive action uses (`workspace/session-activity` waterfall).
- **Official auth** — the delete endpoint rides DSH's shared `/api` connection channel (`connection.registerFetchRoute`), so Host/Origin checks and browser authentication are enforced by the official `admit()` gate.
- **Idempotent** — clicking again, or acting on an already-deleted session, answers "already removed" rather than erroring.
- **Irreversible** — logs and accounting are removed; only shared attachments/projection caches remain as harmless orphans.

## Install

### Via the plugin market (recommended)

Search and install from DSH's plugin market (dshmarket); this repo carries the community `dsh-plugin` tag.

### Manual (github spec)

Edit the profile `package.json` (`~/.dsh/profiles/desktop/package.json`):

```jsonc
{
  "dsh": { "profile": { "bundles": [ "dsh-session-delete" ] } },
  "dependencies": { "dsh-session-delete": "github:<GITHUB_USER>/dsh-session-delete" }
}
```

Then run `pnpm install` in the profile directory and restart DeepSeek Harness.

## Usage

1. Restart DSH after installing.
2. Hover a sidebar Session row → "…" → the red **Delete session** row at the bottom.
3. First click arms, second click deletes; the result shows in the row.
4. If the list does not refresh immediately, a restart guarantees a clean state.

The plugin appears as a card in **Settings → Plugins** and can be toggled there.

## Uninstall

Remove `dsh-session-delete` from `dsh.profile.bundles` and `dependencies`, run `pnpm install`, restart.

## Compatibility

- DSH `0.2.0-rc` line (Web / Desktop profile).
- Host half: Node ≥ 22. Client half uses DSH platform baseline modules (React, `@deepseek-ai/dsh-client-ui-primitives`).

## Layout

| Path | Purpose |
|---|---|
| `lib/index.js` | Host half: `POST /api/session-delete`, log removal + registry bookkeeping |
| `lib/client.js` | Client half: the "Delete session" row in `sidebar.workspaces.session.menu.item` |
| `cordis.patch.yml` | Bundle patch inserting one loader row carrying both halves |
| `icon.svg` | Plugin card icon |

## License

[MIT](LICENSE)
