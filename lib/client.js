window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const NS = "session-delete";
		const zh = {
			"menu.deleteSession": "删除会话",
			"menu.confirmDelete": "再次点击确认删除",
			"menu.forceDelete": "再次点击：停止任务并强行删除",
			"menu.deleting": "正在删除…",
			"menu.deleted": "已删除",
			"menu.deleteFailed": "删除失败"
		};
		const en = {
			"menu.deleteSession": "Delete session",
			"menu.confirmDelete": "Click again to confirm",
			"menu.forceDelete": "Click again: stop the task and force-delete",
			"menu.deleting": "Deleting…",
			"menu.deleted": "Deleted",
			"menu.deleteFailed": "Delete failed"
		};

		/**
		 * The delete row of one Session's "..." menu: a two-step confirm inside
		 * the row itself (first click arms, second click deletes) so the menu
		 * stays open and can show the outcome. The row never dismisses the menu
		 * on its own — the menu's own pointer-leave/close behavior does that.
		 * When the host reports the session is running work, the row arms a
		 * second warning ("stop the task and force-delete") whose next click
		 * sends `force: true`; any other refusal (transport failure, internals
		 * that cannot detach) leaves the row armed for a retry, so the reason
		 * stays visible until the user acts on it or the menu closes.
		 */
		function DeleteSessionMenuItem(props) {
			const sessionId = props.sessionId;
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const [phase, setPhase] = react.useState("idle");
			const [detail, setDetail] = react.useState("");
			react.useEffect(() => {
				if (phase !== "confirm" && phase !== "forceArm") return void 0;
				const timer = setTimeout(() => setPhase("idle"), 6000);
				return () => clearTimeout(timer);
			}, [phase]);
			const activate = async () => {
				if (phase === "idle" || phase === "error") {
					setPhase("confirm");
					setDetail("");
					return;
				}
				if (phase !== "confirm" && phase !== "forceArm") return;
				const force = phase === "forceArm";
				setPhase("busy");
				try {
					const response = await fetch("/api/session-delete", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(force ? { sessionId, force: true } : { sessionId })
					});
					let data = null;
					try {
						data = await response.json();
					} catch {
						data = null;
					}
					if (response.ok && data && data.ok === true) {
						setPhase("done");
						return;
					}
					if (response.status === 409 && data && data.code === "active" && !force) {
						// Busy session: turn the refusal into the second warning
						// instead of a dead end — the next click forces.
						setPhase("forceArm");
						setDetail("");
						return;
					}
					setPhase("error");
					setDetail(String((data && (data.message || data.code)) || `HTTP ${response.status}`).slice(0, 96));
				} catch (error) {
					setPhase("error");
					setDetail(String((error && error.message) || error).slice(0, 96));
				}
			};
			const label =
				phase === "confirm" ? t("menu.confirmDelete") :
				phase === "forceArm" ? t("menu.forceDelete") :
				phase === "busy" ? t("menu.deleting") :
				phase === "done" ? t("menu.deleted") :
				phase === "error" ? `${t("menu.deleteFailed")}: ${detail}` :
				t("menu.deleteSession");
			return jsxRuntime.jsx(primitives.MenuItemButton, {
				danger: phase === "idle" || phase === "confirm" || phase === "forceArm" || phase === "error",
				separatorBefore: true,
				disabled: phase === "busy",
				icon: jsxRuntime.jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: activate,
				children: label
			});
		}

		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }));
			ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
				ctx.slots.register(
					{
						name: "sidebar.workspaces.session.menu.item",
						id: "dsh-session-delete",
						order: 500,
						locale: NS
					},
					DeleteSessionMenuItem
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
