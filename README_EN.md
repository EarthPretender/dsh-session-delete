# dsh-session-delete

English | [中文](README.md)

Adds a destructive red **"Delete session"** row right below **"Archive session"** in the Session "…" menu of DeepSeek Harness (DSH) — it actually deletes the session's data instead of only archiving it.

> Tags: `dsh-plugin` · `dsh` · `deepseek-harness`

## What it does

DSH ships Archive only: an archived session stays on disk and can be restored. This plugin adds real deletion:

1. **Menu row** — a red "Delete session" row (trash icon, separator) beneath the shipped "Archive session" row in every sidebar Session's "…" menu.
2. **Two-step confirm** — the first click arms the row ("Click again to confirm", auto-reset after 6s), the second click runs it; the menu stays open and shows the outcome inline. When the session is running work, the row arms a second warning ("Click again: stop the task and force-delete") whose next click stops the task first; any other refusal (unreachable host, locked file) shows its reason in the row, stays red, and re-arms on the next click.
3. **What gets deleted**
   - the session's stored logs under `sessions/<workspace>/<session-id>/` (including `session.v4.jsonl.zstd`);
   - its registry accounting, through the workspace registry's own durable writes (`unpin` → `unarchive` → `detachSession`), so `workspace.json` is written by the registry itself — memory and disk never disagree, and later archives cannot resurrect the deleted id.

## Safety

- **Sessions opened this run delete normally** — the plugin disposes the session from memory first (flush → detach the store entry → deregister the agent, session strictly before agent: while `ctx.sessions.get(id) === agent.session` still holds, DSH re-publishes the row), the write handle closes with it, and the log removal carries a bounded lock retry (15 × 100 ms). Nothing can "half-delete" or resurrect, and no restart is needed.
- **Running sessions: one warning, one more click, force-delete** — when the host reports running work, the row arms "Click again: stop the task and force-delete" (auto-reset after 6s); the next click dispatches the official `workspace/session-stop` first and waits up to 4 s (tunable via `SESSION_DELETE_STOP_WAIT_MS`). A task that refuses to stop does not block the delete — that is what force means.
- **The row disappears from the list immediately, no restart needed** — the plugin broadcasts the official `api-session/removed` event (forwarded to every browser by `dsh-api-remotes`), the exact channel DSH itself uses to drop rows. Without it a cold session's row stays in the browser's start-up snapshot, stranded in the "Ungrouped" bucket until a restart. An idempotent repeat re-broadcasts as well, to clear any stale leftover row.
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
  "dependencies": { "dsh-session-delete": "github:EarthPretender/dsh-session-delete" }
}
```

Then run `pnpm install` in the profile directory and restart DeepSeek Harness.

## Usage

1. Restart DSH after installing.
2. Hover a sidebar Session row → "…" → the red **Delete session** row at the bottom.
3. First click arms, second click deletes; the result shows in the row and **the row leaves the list immediately**.
4. If the session is running work, the row shows "Click again: stop the task and force-delete" — one more click stops the task and deletes.

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
| `scripts/selftest.mjs` | Dependency-free self-test (`npm test`); no DSH needed |

## Development self-check

```bash
npm test        # = node scripts/selftest.mjs
```

No DSH required. It covers three things:

1. **Identity** — the `package.json` `name`, the id in `lib/client.js`'s `__ModuleLoader__.load({ id })`, and the `name` of the `cordis.patch.yml` insert row must all be the same string. When they drift, client-modules reports `loaded without registering "…" via __ModuleLoader__.load` and the browser half never activates — Settings then shows "some plugins could not sync on this page".
2. **Browser half** — the two-step confirm, the force warning row for a busy session (third click sends `force: true`), success/refusal/transport-error outcomes, retry after a failure, and the registered slot's name/id/order/locale.
3. **Host half** — the route contract (`POST /api/session-delete`, buffered body), malformed method/JSON/path traversal, the 409 for a busy session without `force`, the forced path's fixed order (stop → flush → dispose → deregister agent), the bounded wait when providers ignore the stop, disposing then deleting an attached session, the refuse-not-half-delete fallback when the store cannot detach, a real delete (log dirs + `unpin`/`unarchive`/`detachSession` + header-index rebuild), the `api-session/removed` broadcast, idempotence, and the 500 when the store is unreadable.

> Renaming the package (for example `@local/dsh-session-delete` → `dsh-session-delete`) means changing all three places **and restarting the app**: a running page still holds the client module row under the old id, and editing files does not replace it.

## License

[MIT](LICENSE)
