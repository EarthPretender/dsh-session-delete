/**
 * `dsh-session-delete` self-test: identity, browser half, host half.
 *
 * The plugin failed its first real boot because the package was renamed while an
 * older page still held the previous module id (the browser half registered a
 * different id than the one client-modules expected for the loader row). Nothing
 * here needs DSH: identity is asserted against the three files that must agree,
 * the browser half runs in a stub module-loader, and the host half runs against a
 * throwaway `DSH_HOME`.
 *
 * Run: `npm test` (or `node scripts/selftest.mjs`).
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

/** Plugin root (this file lives in `<root>/scripts`). */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
/** Locale namespace the browser half registers. */
const NS = "session-delete";
/** Slot the browser half contributes to. */
const SLOT = "sidebar.workspaces.session.menu.item";

let failures = 0;
/** Run one named check; a throw is reported and counted instead of aborting the run. */
async function check(name, body) {
	try {
		await body();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${name}`);
		console.log(`     ${error instanceof Error ? error.message : String(error)}`);
	}
}

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const clientSource = await readFile(join(root, "lib", "client.js"), "utf8");
const patchSource = await readFile(join(root, "cordis.patch.yml"), "utf8");

await check("identity: package name, client module id, patch row name agree", () => {
	const registeredId = /id:\s*"([^"]+)"/.exec(clientSource)?.[1];
	const patchName = /name:\s*"([^"]+)"/.exec(patchSource)?.[1];
	assert.equal(registeredId, pkg.name, `lib/client.js registers "${registeredId}" but the package is "${pkg.name}" — client-modules keys the module by the package name and rejects the mismatch`);
	assert.equal(patchName, pkg.name, `cordis.patch.yml inserts the loader row under "${patchName}" but the package is "${pkg.name}"`);
});

await check("identity: manifest declares both halves", () => {
	assert.equal(pkg.type, "module");
	assert.equal(pkg.exports["."], "./lib/index.js");
	assert.equal(pkg.exports["./client"], "./lib/client.js");
	assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
	assert.equal(pkg.dsh.client.platform, "web");
	assert.ok(Array.isArray(pkg.dsh.client.inject));
	for (const file of [pkg.exports["."], pkg.exports["./client"], pkg.dsh.bundle.patch]) {
		assert.ok(existsSync(join(root, file)), `${file} is declared but missing`);
	}
});

/**
 * Minimal React replacement: a stable hook cell array, no effects (the browser
 * half only schedules the confirm timeout in one, which the test never needs).
 */
function createReactStub() {
	const cells = [];
	let cursor = 0;
	let rerender = () => {};
	return {
		api: {
			useState(initial) {
				const index = cursor;
				cursor += 1;
				if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial;
				return [cells[index], (value) => {
					cells[index] = typeof value === "function" ? value(cells[index]) : value;
					rerender();
				}];
			},
			useEffect() {
				return void 0;
			}
		},
		beginRender(next) {
			cursor = 0;
			rerender = next;
		}
	};
}

/**
 * Load `lib/client.js` into stub globals and materialize its factory.
 * @returns the registration, the materialized exports, and the captured services.
 */
async function loadClient() {
	const registrations = [];
	globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
	const reactRuntime = createReactStub();
	const primitives = {
		MenuItemButton: function MenuItemButton() {},
		IconTrashOutlineRegular: function IconTrashOutlineRegular() {}
	};
	const modules = {
		"react": reactRuntime.api,
		"react/jsx-runtime": {
			jsx: (type, props) => ({ type, props }),
			jsxs: (type, props) => ({ type, props }),
			Fragment: function Fragment() {}
		},
		"@deepseek-ai/dsh-client-ui-primitives": primitives
	};
	// A unique query keeps each scenario's module instance (and its hook cells) separate.
	await import(`${pathToFileURL(join(root, "lib", "client.js")).href}?selftest=${String(Date.now())}-${String(registrations.length)}`);
	const load = registrations[0];
	assert.equal(registrations.length, 1, "the bundle must call __ModuleLoader__.load exactly once, with one id");
	const exports = load.factory((specifier) => {
		assert.ok(specifier in modules, `lib/client.js requires "${specifier}", which is not a declared or seeded module`);
		return modules[specifier];
	});
	const locales = [];
	const slots = [];
	const injected = [];
	const ctx = {
		effect: (body) => body(),
		locale: { register: (namespace, dictionary) => locales.push({ namespace, dictionary }) },
		slots: {
			inject: (name, produce) => {
				injected.push(name);
				produce();
			},
			register: (descriptor, component) => slots.push({ descriptor, component })
		}
	};
	return { load, exports, ctx, locales, slots, injected, reactRuntime, primitives };
}

/**
 * Drive one browser-half scenario: load, apply, render, click through the
 * two-step confirm, and report what the row looked like at each phase.
 * @param fetchImpl - the `fetch` replacement the component will call.
 */
async function runClientScenario(fetchImpl) {
	const harness = await loadClient();
	const { load, exports, ctx, locales, slots, injected, reactRuntime, primitives } = harness;
	assert.equal(load.id, pkg.name, "the registered module id must be the package name");
	assert.ok(exports.inject.includes("slots") && exports.inject.includes("locale"), "both services must be injected");
	assert.equal(typeof exports.apply, "function");

	exports.apply(ctx);
	assert.equal(locales.length, 1, "apply must register exactly one locale namespace");
	assert.equal(locales[0].namespace, NS);
	assert.equal(locales[0].dictionary.zh["menu.deleteSession"], "删除会话");
	assert.equal(locales[0].dictionary.en["menu.deleteSession"], "Delete session");

	assert.deepEqual(injected, [SLOT]);
	assert.equal(slots.length, 1, "apply must contribute exactly one menu row");
	const { descriptor, component } = slots[0];
	assert.equal(descriptor.name, SLOT);
	assert.equal(descriptor.id, pkg.name, "the slot row id must match the plugin id so two builds cannot both render");
	assert.equal(descriptor.order, 500, "the row must sort below the official archive row (order 400)");
	assert.equal(descriptor.locale, NS);

	const translate = (key) => locales[0].dictionary.zh[key] ?? key;
	let tree;
	const render = () => {
		reactRuntime.beginRender(() => render());
		tree = component({ sessionId: "session-11111111-2222-3333-4444-555555555555", t: translate });
	};
	globalThis.fetch = fetchImpl;
	render();
	const rows = [];
	rows.push(tree.props.children);

	assert.equal(tree.type, primitives.MenuItemButton);
	assert.equal(tree.props.danger, true);
	assert.equal(tree.props.separatorBefore, true);
	assert.equal(tree.props.disabled, false);
	assert.equal(tree.props.children, "删除会话");

	await tree.props.onSelect();
	rows.push(tree.props.children);
	assert.equal(tree.props.children, "再次点击确认删除", "the first click only arms the row");

	await tree.props.onSelect();
	rows.push(tree.props.children);
	// `current()` reads the closure's live tree: every setState above re-rendered
	// into it, while destructuring a snapshot would freeze the first render.
	return { harness, rows, translate, current: () => tree };
}

const sessionId = "session-11111111-2222-3333-4444-555555555555";

await check("client: two-step confirm posts one delete and reports success", async () => {
	const calls = [];
	const scenario = await runClientScenario(async (url, init) => {
		calls.push({ url, init });
		return {
			ok: true,
			status: 200,
			json: async () => ({ ok: true, deletedLogs: 2, steps: ["detached:ws-1"] })
		};
	});
	const { rows } = scenario;
	const tree = scenario.current();
	assert.equal(calls.length, 1, "arming the row must not send a request");
	assert.equal(calls[0].url, "/api/session-delete");
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.headers["content-type"], "application/json");
	assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId });
	assert.equal(rows[0], "删除会话");
	assert.equal(rows[1], "再次点击确认删除");
	assert.equal(rows[2], "已删除（若列表未刷新请重启应用）");
	assert.equal(tree.props.disabled, false, "the row unlocks once the request settled");
});

await check("client: a refused delete keeps the reason and re-arms on the next click", async () => {
	const scenario = await runClientScenario(async () => ({
		ok: false,
		status: 409,
		json: async () => ({ ok: false, code: "active", message: "会话正在执行任务，请先停止后再删除" })
	}));
	assert.equal(scenario.current().props.children, "删除失败: 会话正在执行任务，请先停止后再删除");
	assert.equal(scenario.current().props.danger, true, "the failed row stays a destructive row, ready to retry");
	await scenario.current().props.onSelect();
	assert.equal(scenario.current().props.children, "再次点击确认删除", "a failed row must be retryable, not a dead end");
});

await check("client: an unreachable host surfaces the transport error", async () => {
	const scenario = await runClientScenario(async () => {
		throw new Error("Failed to fetch");
	});
	assert.equal(scenario.current().props.children, "删除失败: Failed to fetch");
});

/** Build a throwaway `DSH_HOME` with two stored log dirs for one session plus a decoy. */
async function createHome(sessionId) {
	const home = await mkdtemp(join(tmpdir(), "dsh-session-delete-selftest-"));
	const decoy = "session-99999999-8888-7777-6666-555555555555";
	for (const [directory, id] of [["--one--", sessionId], ["--two--", sessionId], ["--one--", decoy]]) {
		await mkdir(join(home, "sessions", directory, id), { recursive: true });
		await writeFile(join(home, "sessions", directory, id, "session.v4.jsonl.zstd"), "stored");
	}
	return { home, decoy };
}

/** Load the host half fresh (unique query) and register its route on a stub context. */
async function loadHost() {
	const module = await import(`${pathToFileURL(join(root, "lib", "index.js")).href}?selftest=${String(Date.now())}-${String(Math.random())}`);
	const calls = [];
	let route;
	const registry = {
		pinnedSessionIds: [sessionId],
		archivedSessionIds: [sessionId],
		unpinSession: async (id) => calls.push(`unpin:${id}`),
		unarchiveSession: async (id) => calls.push(`unarchive:${id}`),
		list: () => [{
			id: "ws-one",
			sessionIds: [sessionId],
			detachSession: async (id) => calls.push(`detach:ws-one:${id}`)
		}, {
			id: "ws-two",
			sessionIds: ["session-99999999-8888-7777-6666-555555555555"],
			detachSession: async (id) => calls.push(`detach:ws-two:${id}`)
		}]
	};
	let activity = [];
	const ctx = {
		connection: { registerFetchRoute: (_owner, value) => { route = value; } },
		waterfall: async () => activity,
		workspaceRegistry: registry
	};
	module.apply(ctx);
	assert.ok(route !== undefined, "apply must register one fetch route");
	return { module, route, calls, ctx, registry, setActivity: (next) => { activity = next; } };
}

/** POST a JSON body at the registered route. */
function post(sessionIdValue) {
	return new Request("http://dsh.invalid/api/session-delete", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId: sessionIdValue })
	});
}

await check("host: route descriptor matches the documented connection contract", async () => {
	const { module, route } = await loadHost();
	assert.deepEqual(module.inject, ["connection", "workspaceRegistry"]);
	assert.equal(module.name, "session-delete");
	assert.equal(route.path, "/api/session-delete");
	assert.deepEqual(route.methods, ["POST"]);
	assert.equal(route.requestBody, "buffered");
});

await check("host: malformed requests are refused before touching the disk", async () => {
	const { home, decoy } = await createHome(sessionId);
	process.env.DSH_HOME = home;
	const { route } = await loadHost();
	const wrongMethod = await route.fetch(new Request("http://dsh.invalid/api/session-delete", { method: "GET" }));
	assert.equal(wrongMethod.status, 405);
	const notJson = await route.fetch(new Request("http://dsh.invalid/api/session-delete", { method: "POST", body: "nope" }));
	assert.equal(notJson.status, 400);
	const traversal = await route.fetch(post("../../etc"));
	assert.equal(traversal.status, 400);
	assert.equal(existsSync(join(home, "sessions", "--one--", decoy)), true);
	await rm(home, { recursive: true, force: true });
});

await check("host: a session running work is refused with 409", async () => {
	const { home } = await createHome(sessionId);
	process.env.DSH_HOME = home;
	const host = await loadHost();
	host.setActivity(["turn"]);
	const response = await host.route.fetch(post(sessionId));
	assert.equal(response.status, 409);
	const payload = await response.json();
	assert.equal(payload.code, "active");
	assert.equal(existsSync(join(home, "sessions", "--one--", sessionId)), true, "a refused delete must not touch the logs");
	assert.deepEqual(host.calls, []);
	await rm(home, { recursive: true, force: true });
});

await check("host: a successful delete clears every log dir and the accounting", async () => {
	const { home, decoy } = await createHome(sessionId);
	process.env.DSH_HOME = home;
	const host = await loadHost();
	const response = await host.route.fetch(post(sessionId));
	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.equal(payload.ok, true);
	assert.equal(payload.deletedLogs, 2, "both stored log dirs for that session must go");
	assert.deepEqual(host.calls, [`unpin:${sessionId}`, `unarchive:${sessionId}`, `detach:ws-one:${sessionId}`]);
	assert.equal(existsSync(join(home, "sessions", "--one--", sessionId)), false);
	assert.equal(existsSync(join(home, "sessions", "--two--", sessionId)), false);
	assert.equal(existsSync(join(home, "sessions", "--one--", decoy)), true, "another session's logs must survive");
	assert.equal(existsSync(join(home, "sessions", "--one--", decoy, "session.v4.jsonl.zstd")), true);
	await rm(home, { recursive: true, force: true });
});

await check("host: deleting an already-removed session is a quiet success", async () => {
	const { home } = await createHome(sessionId);
	process.env.DSH_HOME = home;
	const host = await loadHost();
	await host.route.fetch(post(sessionId));
	host.registry.pinnedSessionIds = [];
	host.registry.archivedSessionIds = [];
	host.registry.list = () => [];
	const again = await host.route.fetch(post(sessionId));
	const payload = await again.json();
	assert.equal(again.status, 200);
	assert.equal(payload.ok, true);
	assert.equal(payload.code, "already-removed");
	await rm(home, { recursive: true, force: true });
});

await check("host: an unreadable session store reports a 500 instead of claiming success", async () => {
	process.env.DSH_HOME = join(tmpdir(), "dsh-session-delete-selftest-missing");
	const host = await loadHost();
	const response = await host.route.fetch(post(sessionId));
	assert.equal(response.status, 500);
	const payload = await response.json();
	assert.equal(payload.ok, false);
});

console.log("");
if (failures === 0) console.log("selftest: all checks passed");
else {
	console.log(`selftest: ${String(failures)} check(s) failed`);
	process.exitCode = 1;
}
