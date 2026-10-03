# dsh-session-delete

[English](README_EN.md) | 中文

给 DeepSeek Harness（DSH）会话“…”菜单的**“归档会话”下方加一个红色的“删除会话”**——真正删除该会话的全部数据，而不是只把它归档。

> 标签 / Tags: `dsh-plugin` · `dsh` · `deepseek-harness`

## 它做了什么

DSH 官方只提供“归档”（Archive），归档后的会话仍然留在磁盘上、也能在归档区找回。本插件补上**真删除**：

1. **菜单行**：在侧栏每个会话行的“…”菜单里、官方“归档会话”下方新增一行红色“删除会话”，带垃圾桶图标与分隔线。
2. **二次确认**：第一次点击变为“再次点击确认删除”（6 秒无操作自动还原），第二次点击才真正执行——菜单保持打开并直接显示结果，避免误删。
3. **删除内容**：
   - 删除该会话在 `sessions/<工作区>/<会话id>/` 下的全部日志数据（含 `session.v4.jsonl.zstd`）；
   - 通过工作区注册表的官方持久化写清理登记（`unpin` → `unarchive` → `detachSession`），因此 `workspace.json` 由 registry 自己写，内存与磁盘始终一致，之后归档其他会话也不会把已删的会话“复活”。

## 安全性设计

- **正在跑任务的会话拒绝删除**：与官方归档使用同一个活动闸门（`workspace/session-activity` waterfall），会话正在执行任务时会返回提示，让你先停止。
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
    "dsh-session-delete": "github:<GITHUB_USER>/dsh-session-delete"
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
3. 第一次点 → “再次点击确认删除”，再点一次执行；结果显示在行内。
4. 如果列表未立即刷新，重启应用后一定干净。

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

## 许可

[MIT](LICENSE)
