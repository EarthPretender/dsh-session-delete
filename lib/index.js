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
 * Teardown adapts to how live the session is:
 *
 * - **Cold sessions** (never opened this run) have no writer: logs, accounting,
 *   and the removal announcement are enough.
 * - **Sessions attached this run are disposed before the logs go**: flush the
 *   write path, detach the store entry (mirroring the store's own announce/
 *   append single-shot guards), then deregister the agent — session first,
 *   because `publishAgentAvailability` re-publishes the row while
 *   `ctx.sessions.get(id) === agent.session` still holds. With the writer
 *   closed there is no append path left to recreate a deleted directory, and
 *   the `rm` carries a bounded retry so a just-closed handle cannot fail the
 *   delete on Windows.
 * - **Busy sessions need `force: true`**: without it the route answers
 *   409 `active` (the browser arms a "stop the task and force-delete" row);
 *   with it the official `workspace/session-stop` is dispatched first and the
 *   activity gate is polled for up to `SESSION_DELETE_STOP_WAIT_MS`
 *   (default 4000). Providers that refuse to stop do not block the forced
 *   delete — that is what "force" means.
 *
 * `api-session/removed` is emitted after every successful pass, including the
 * idempotent repeat. DSH only emits this event for sessions disposed while
 * *live* (`session/disposed` → session-controller), so without it a cold
 * session's row stays in the browser's start-up list snapshot — stranded in
 * the "ungrouped" bucket once the workspace detaches it — until the next
 * restart. The idempotent re-announce also clears a row a stale client still
 * shows. `dsh-api-remotes` forwards this allowlisted event to every browser.
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

/** Awaitable timer (node). */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a forced delete waits for providers to report idle. Test knob: `SESSION_DELETE_STOP_WAIT_MS`. */
function stopWaitMs() {
	const raw = Number(process.env.SESSION_DELETE_STOP_WAIT_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 4000;
}

/** The official activity list for one session (same waterfall the archive gate uses). */
async function activityList(ctx, sessionId) {
	const activity = await ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
	return Array.isArray(activity) ? activity : [];
}

/**
 * Remove one stored log directory, retrying while a just-closed write handle
 * still holds it. The dispose path closes handles asynchronously; 15 × 100 ms
 * covers the drain without turning a genuinely stuck file into a hang.
 * @param target - absolute path of the session directory inside the store.
 */
async function removeWithRetry(target) {
	let lastError;
	for (let attempt = 0; attempt < 15; attempt += 1) {
		try {
			await rm(target, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			await sleep(100);
		}
	}
	throw lastError;
}

/**
 * Handle one `POST /api/session-delete` request: `{ sessionId, force? }` in, a
 * JSON verdict out. Without `force`, a busy session answers 409 `active` so the
 * browser can show its second warning; with `force`, the task is stopped first
 * and the delete proceeds regardless. Deleting is idempotent: an id whose files
 * and accounting are both already gone answers `already-removed` so a stale row
 * can be clicked again without an alarming error.
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

	// The same activity gate the official archive action uses. A busy session
	// answers 409 unless the client explicitly forces: the browser turns that
	// 409 into a second-warning row ("stop the task and force-delete").
	const force = body?.force === true;
	let stopped = false;
	const initialActivity = await activityList(ctx, sessionId);
	if (initialActivity.length > 0 && !force) {
		return json({ ok: false, code: "active", message: "会话正在执行任务——再次点击将停止任务并强行删除" }, 409);
	}
	if (initialActivity.length > 0 && force) {
		// Official stop fan-out (registry.stopSessionActivity dispatches the
		// same event): listener failures are logged, never a reason to keep a
		// session we were told to force-delete.
		try {
			await ctx.parallel("workspace/session-stop", { sessionId });
			stopped = true;
		} catch (error) {
			stopped = true;
			console.warn("[session-delete] workspace/session-stop reported failures:", error);
		}
		// Poll until providers report idle, bounded so a provider that refuses
		// to stop cannot hang the forced delete.
		const deadline = Date.now() + stopWaitMs();
		while ((await activityList(ctx, sessionId)).length > 0) {
			if (Date.now() >= deadline) {
				console.warn("[session-delete] session still busy after the stop wait; proceeding with the forced delete");
				break;
			}
			await sleep(150);
		}
	}

	// Dispose an attached session before touching the disk: with its writer
	// closed there is no append path left to recreate the directory, and
	// `session/disposed` performs DSH's own cascade (persistence close, title,
	// projections, telemetry). Feature-detected against the store's internal
	// entry shape; when it does not hold we refuse instead of half-deleting.
	let disposed = false;
	const sessions = ctx.sessions;
	const live = typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined;
	if (live !== undefined && live !== null) {
		try {
			// Durability first: writer.close()'s final drain then has nothing
			// left to write, so it cannot race the directory removal.
			if (typeof sessions.flush === "function") await sessions.flush(live);
		} catch (error) {
			console.warn("[session-delete] flush before dispose failed:", error);
		}
		const entry = typeof sessions.store?.get === "function" ? sessions.store.get(sessionId) : undefined;
		if (entry !== undefined && typeof entry.detach === "function") {
			entry.detach();
			// The store defers a detach that lands mid-announce/append; wait it
			// out the same way (bounded), then confirm the store really dropped it.
			const deadline = Date.now() + stopWaitMs();
			while (entry.detachRequested === true && Date.now() < deadline) await sleep(100);
			disposed = sessions.get(sessionId) === undefined;
		}
		if (!disposed) {
			return json({ ok: false, code: "live", message: "无法及时停用该会话（仍在写入或 DSH 内部结构已变化），请重启 DeepSeek Harness 后再删除" }, 409);
		}
		// Agent strictly AFTER the session: before it, publishAgentAvailability
		// sees ctx.sessions.get(id) === agent.session and re-announces the row.
		try {
			const agents = ctx.agents;
			const agentEntry = typeof agents?.store?.get === "function" ? agents.store.get(sessionId) : undefined;
			if (agentEntry !== undefined && typeof agentEntry.detach === "function") agentEntry.detach();
		} catch (error) {
			console.warn("[session-delete] agent detach skipped:", error);
		}
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
	for (const dirEntry of entries) {
		if (!dirEntry.isDirectory()) continue;
		const target = join(root, dirEntry.name, sessionId);
		try {
			await stat(target);
		} catch {
			continue;
		}
		try {
			await removeWithRetry(target);
		} catch (error) {
			return json({ ok: false, code: "locked", message: `日志仍被占用，删除失败: ${error?.message ?? String(error)}（请稍后重试）` }, 500);
		}
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
		return json({ ok: true, code: "already-removed", deletedLogs: 0, steps, headersReindexed, stopped, disposed });
	}
	return json({
		ok: true,
		deletedLogs,
		steps,
		headersReindexed,
		stopped,
		disposed,
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
