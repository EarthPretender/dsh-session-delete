# dsh-session-delete

[English](README_EN.md) | 中文

给 DeepSeek Harness（DSH）会话“…”菜单的**“归档会话”下方加一个红色的“删除会话”**——真正删除该会话的全部数据，而不是只把它归档。

> 标签 / Tags: `dsh-plugin` · `dsh` · `deepseek-harness`

## 它做了什么

DSH 官方只提供“归档”（Archive），归档后的会话仍然留在磁盘上、也能在归档区找回。本插件补上**真删除**：

1. **菜单行**：在侧栏每个会话行的“…”菜单里、官方“归档会话”下方新增一行红色“删除会话”，带垃圾桶图标与分隔线。
2. **二次确认**：第一次点击变为“再次点击确认删除”（6 秒无操作自动还原），第二次点击才真正执行——菜单保持打开并直接显示结果，避免误删。若会话正有任务在跑，行会变为“再次点击：停止任务并强行删除”，再点一次先停任务再删；其他失败（宿主不可达等）行内显示原因并保持红色，再点一次即可重试。
3. **删除内容**：
   - 删除该会话在 `sessions/<工作区>/<会话id>/` 下的全部日志数据（含 `session.v4.jsonl.zstd`）；
   - 通过工作区注册表的官方持久化写清理登记（`unpin` → `unarchive` → `detachSession`），因此 `workspace.json` 由 registry 自己写，内存与磁盘始终一致，之后归档其他会话也不会把已删的会话“复活”。

## 安全性设计

- **当次启动使用过的会话也能直接删**：删除前先把该会话从内存停用（`flush` 落盘 → detach 会话 → 注销 agent，顺序固定——先会话后 agent，否则 DSH 会把行重新公告回来），写句柄随之关闭，日志删除带文件锁重试（15×100ms）——因此不会“删了不生效”或“删了又复活”，也不用重启。
- **正在跑任务的会话：提醒一下，再点一次就强删**：确认点击后若宿主返回“正在执行任务”，行会变为“**再次点击：停止任务并强行删除**”（6 秒无操作自动还原）；再点一次先调用官方 `workspace/session-stop` 停止任务（最多等 4 秒，可用环境变量 `SESSION_DELETE_STOP_WAIT_MS` 调整），任务拒绝停止也照样删——这是强行删除的既定语义。
- **删除成功后列表立即移除该行，无需重启**：插件会广播官方的 `api-session/removed` 事件（`dsh-api-remotes` 转发到每个浏览器），这正是 DSH 自己删除行用的通道——没有它，冷会话的行会留在浏览器启动时的快照里，掉进"未分组"直到重启。幂等的重复点击也会再广播一次，用来清掉残留的旧行。
- **鉴权继承官方通道**：删除接口挂在 DSH 共享的 `/api` 连接通道上（`connection.registerFetchRoute`），因此 Host/Origin 校验与浏览器认证由官方 `admit()` 统一把关。
- **幂等**：重复点击或对已删除的会话再次操作不会报错，只提示已删除。
- **不可逆**：删除会同时移除日志文件与登记，仅剩共享的附件/投影缓存等孤儿数据（无会话关联键，无害）。

## 安装

### 方式一：插件市场（推荐）

在 DSH 的插件市场（dshmarket）里搜索安装；仓库已按社区约定打标 `dsh-plugin`。

### 方式二：手动安装（github 源）

编辑 profile 的 `package.json`（`~/.dsh/profiles/desktop/package.json`）：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        // ... 其他 bundle
        "dsh-session-delete"
      ]
    }
  },
  "dependencies": {
    // ... 其他依赖
    "dsh-session-delete": "github:EarthPretender/dsh-session-delete"
  }
}
```

然后在 profile 目录执行 `pnpm install`，重启 DeepSeek Harness。

### 方式三：本地目录

```jsonc
"dsh-session-delete": "file:./dsh-session-delete"
```

把本仓库放到 profile 目录下，同样需要加入 `dsh.profile.bundles`。

## 使用

1. 重启 DeepSeek Harness（首次安装后）。
2. 侧栏任意会话行 → “…” → 最底部红色 **“删除会话”**。
3. 第一次点 → “再次点击确认删除”，再点一次执行；结果直接显示在行内，**该行立即从列表消失**。
4. 若该会话正有任务在跑，会看到“再次点击：停止任务并强行删除”——再点一次即停止任务并删除。

安装后在 **设置 → 插件** 里可以看到本插件卡片，并可随时开关。

## 卸载

1. 从 profile `package.json` 的 `dsh.profile.bundles` 与 `dependencies` 中移除 `dsh-session-delete`；
2. `pnpm install`，重启应用。

## 兼容性

- DSH `0.2.0-rc` 系列（Web / Desktop profile）。
- 宿主端为 Node ≥ 22；客户端半使用 DSH 平台基线模块（React、`@deepseek-ai/dsh-client-ui-primitives`）。

## 结构

| 路径 | 说明 |
|---|---|
| `lib/index.js` | **Host 半**：在 `/api` 上注册 `POST /api/session-delete`，执行日志删除 + registry 登记清理 |
| `lib/client.js` | **Client 半**：在 `sidebar.workspaces.session.menu.item` 槽注册“删除会话”行 |
| `cordis.patch.yml` | bundle 补丁：插入一个同时承载两半的 loader 条目 |
| `icon.svg` | 插件卡片图标 |
| `scripts/selftest.mjs` | 零依赖自检（`npm test`），不需要启动 DSH |

## 开发自检

```bash
npm test        # = node scripts/selftest.mjs
```

自检不启动 DSH，覆盖三块：

1. **身份一致性**：`package.json` 的 `name`、`lib/client.js` 里 `__ModuleLoader__.load({ id })` 的 id、`cordis.patch.yml` 插入行的 `name` 必须三者相同。不一致时 client-modules 会报 `loaded without registering "…" via __ModuleLoader__.load`，浏览器半永远不会上场——设置页显示“本页面的插件未能完成同步”。
2. **浏览器半**：二次确认两步、忙碌会话的强删警告行（第三次点击带 `force: true`）、成功/被拒/网络异常三种结果、失败后可重试，以及槽注册的 name/id/order/locale。
3. **宿主半**：路由契约（`POST /api/session-delete`、buffered body）、非法方法/非 JSON/路径穿越、活动会话 409（未 force）、force 停任务（stop → flush → dispose → 注销 agent 的固定顺序）、stop 不生效时的有界等待、live 会话停用后删除、store 无法 detach 时的拒绝回退、真实删除（日志目录 + `unpin`/`unarchive`/`detachSession` + header 索引重建）、`api-session/removed` 广播、幂等与存储不可读时的 500。

> 改包名时（例如从 `@local/dsh-session-delete` 改成 `dsh-session-delete`）上面三处必须一起改，然后**重启应用**：已启动的页面仍持有旧 id 的客户端模块行，热改文件不会把旧行换掉。

## 许可

[MIT](LICENSE)
