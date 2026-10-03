/**
 * Host half of `dsh-session-delete`.
 *
 * Registers `POST /api/session-delete` on the shared `/api` connection channel
 * (so Host/Origin checks and browser authentication are the official `admit()`
 * gate), then deletes one Session's stored logs, drops its registry accounting
 * through the workspace registry's own durable, event-emitting writes
 * (`unpinSession` / `unarchiveSession` / `detachSession`), rebuilds the
 * registry's header index, and announces `api-session/removed` so every
 * connected browser drops the row immediately.
 *
 * Order matters: the workspace registry reconciles unaccounted persistence
 * listings back into records, so the log directories are removed first and the
 * bookkeeping follows. `unarchiveSession` and `unpinSession` are documented to
 * run no session-existence check, so deleting first is safe; `detachSession`
 * filters the raw record and never needs the header either. With both files and
 * accounting gone, the session is gone for good and a restart cannot resurrect
 * it.
 *
 * Two guards keep memory and disk honest in both directions:
 *
 * - **A session opened this run is refused (409 `live`).** Its write handle is
 *   still open, and the jsonl backend recreates a deleted directory on its next
 *   append (`mkdir recursive`) — a deletion of a live session would resurrect
 *   on restart, and on Windows the open handle races the `rm` itself. Cold
 *   sessions (never opened this run) have no writer and delete cleanly; merely
 *   browsing a session's history does not attach it.
 * - **`api-session/removed` is emitted after every successful pass**, including
 *   the idempotent repeat. DSH only emits this event for sessions disposed
 *   while *live* (`session/disposed` → session-controller), so without it a
 *   cold session's row stays in the browser's start-up list snapshot — stranded
 *   in the "ungrouped" bucket once the workspace detaches it — until the next
 *   restart. The idempotent re-announce also clears a row a stale client still
 *   shows. `dsh-api-remotes` forwards this allowlisted event to every browser.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

/** Stable Cordis plugin name. */
const name = "session-delete";
/** Services this plugin needs before its route can be registered. */
const inject = ["connection", "workspaceRegistry", "sessions"];

/**
 * One session id as the loader entries spell it (`session-<uuid>`, or a bare
 * uuid for older stores): no path separators, no leading dot, bounded length.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_$.-]{0,127}$/;

/** One JSON response for the browser half. */
function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" }
	});
}

/** Resolve `DSH_HOME` the same way the runtime does, with a `~/.dsh` fallback. */
function sessionsRoot() {
	const home = process.env.DSH_HOME;
	const base = home !== undefined && home !== "" ? home : join(os.homedir(), ".dsh");
	return join(base, "sessions");
}

/**
 * Handle one `POST /api/session-delete` request: `{ sessionId }` in, a JSON
 * verdict out. Deleting is idempotent: an id whose files and accounting are
 * both already gone answers `already-removed` so a stale row can be clicked
 * again without an alarming error.
 * @param ctx - the plugin's Cordis context (carries `waterfall`, the registry, `sessions`, and `emit`).
 * @param request - the WHATWG request the connection bridge hands the route.
 * @returns the JSON response.
 */
async function deleteSession(ctx, request) {
	if (request.method !== "POST") return json({ ok: false, message: "method not allowed" }, 405);
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, message: "request body is not JSON" }, 400);
	}
	const sessionId = body?.sessionId;
	if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
		return json({ ok: false, message: "invalid sessionId" }, 400);
	}

	// The same activity gate the official archive action uses: refuse while
	// any provider reports running work instead of racing a live writer.
	const activity = await ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
	if (Array.isArray(activity) && activity.length > 0) {
		return json({ ok: false, code: "active", message: "会话正在执行任务，请先停止后再删除" }, 409);
	}

	// A session attached during this run still owns an open write handle. The
	// jsonl backend recreates deleted directories on its next append, so the
	// deletion would resurrect on restart; refuse and ask for a restart instead
	// of half-deleting. Browsing history never attaches, so a cold session —
	// the normal cleanup target — passes straight through.
	const liveSession = typeof ctx.sessions?.get === "function" ? ctx.sessions.get(sessionId) : undefined;
	if (liveSession !== undefined && liveSession !== null) {
		return json({ ok: false, code: "live", message: "该会话本次启动中使用过，请重启 DeepSeek Harness 后再删除" }, 409);
	}

	// 1) Remove every stored log directory carrying this session id. The id
	//    pattern forbids separators, so `join` can never leave its workspace dir.
	const root = sessionsRoot();
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		return json({ ok: false, message: `无法读取会话存储 ${root}: ${error?.message ?? String(error)}` }, 500);
	}
	let deletedLogs = 0;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const target = join(root, entry.name, sessionId);
		try {
			await stat(target);
		} catch {
			continue;
		}
		await rm(target, { recursive: true, force: true });
		deletedLogs += 1;
	}

	// 2) Bookkeeping through the registry's own writes: each one persists to
	//    workspace.json itself and emits its change event, so memory and disk
	//    never disagree and a later archive cannot resurrect this id.
	const steps = [];
	let bookkeepingError = null;
	try {
		const registry = ctx.workspaceRegistry;
		if (registry.pinnedSessionIds.includes(sessionId)) {
			await registry.unpinSession(sessionId);
			steps.push("unpinned");
		}
		if (registry.archivedSessionIds.includes(sessionId)) {
			await registry.unarchiveSession(sessionId);
			steps.push("unarchived");
		}
		for (const workspace of registry.list()) {
			if (workspace.sessionIds.includes(sessionId)) {
				await workspace.detachSession(sessionId);
				steps.push(`detached:${workspace.id}`);
			}
		}
	} catch (error) {
		bookkeepingError = error?.message ?? String(error);
		console.error("[session-delete] registry bookkeeping failed:", error);
	}

	// 3) Rebuild the registry's header index from disk. The registry serves
	//    `sessionKnown`/`readSessionHeader` from an in-memory map loaded at
	//    startup; without this refresh it keeps claiming the deleted id until
	//    the next restart. Feature-detected: older registries simply skip it.
	let headersReindexed = false;
	try {
		const registry = ctx.workspaceRegistry;
		if (typeof registry.listStoredHeaders === "function" && typeof registry.replaceHeaderIndex === "function") {
			await registry.replaceHeaderIndex(await registry.listStoredHeaders());
			headersReindexed = true;
		}
	} catch (error) {
		console.warn("[session-delete] header reindex skipped:", error);
	}

	if (bookkeepingError !== null && deletedLogs === 0 && steps.length === 0) {
		return json({ ok: false, code: "bookkeeping-failed", message: `删除失败: ${bookkeepingError}` }, 500);
	}

	// 4) Announce the removal to every connected browser. DSH only emits this
	//    allowlisted event when a *live* session is disposed; a cold session
	//    would otherwise keep its row in the client's start-up snapshot until a
	//    restart. Re-announcing the idempotent pass clears a stale row too.
	ctx.emit("api-session/removed", sessionId);

	if (deletedLogs === 0 && steps.length === 0) {
		return json({ ok: true, code: "already-removed", deletedLogs: 0, steps, headersReindexed });
	}
	return json({
		ok: true,
		deletedLogs,
		steps,
		headersReindexed,
		...bookkeepingError === null ? {} : { warning: bookkeepingError }
	});
}

/**
 * Register the delete route on the shared `/api` connection channel.
 * @param ctx - the plugin's Cordis context (`connection`, `workspaceRegistry`, `sessions` injected).
 * @returns nothing; the route is owned by the plugin fiber and disposed with it.
 */
function apply(ctx) {
	ctx.connection.registerFetchRoute(ctx, {
		path: "/api/session-delete",
		methods: ["POST"],
		requestBody: "buffered",
		fetch: async (request) => {
			try {
				return await deleteSession(ctx, request);
			} catch (error) {
				console.error("[session-delete] unexpected failure:", error);
				return json({ ok: false, message: `删除失败: ${error?.message ?? String(error)}` }, 500);
			}
		}
	});
}

export { apply, inject, name };
