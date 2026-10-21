# Contributing

感谢你愿意一起完善 `dsh-reminding`。这个仓库刻意保持很小：没有构建步骤，没有运行依赖，Host 半边与浏览器半边都是可以直接加载的纯 JS。

## 开发环境

- Node.js 20 或更高版本（测试用 `node --test` 之外的普通 ESM 脚本，Node 18 亦可运行）；
- 一个可用的 DeepSeek Harness 0.2.1-rc.2 或更高版本，用于在真实页面里验证。

仓库没有 `npm install` 步骤，也没有 `node_modules`：

```bash
npm run check        # 清单 / 导出 / locale / 图标 / patch / 两半入口的一致性检查
npm test             # 功能测试，不需要 DSH 进程
npm run pack:check   # 确认 npm 实际会发布哪些文件
```

## 目录

| 路径 | 作用 |
| --- | --- |
| `index.js` | Host 半边：订阅 `session/event`，维护带 `sessionId` 的提醒流，注册 `/reminding/poll` 长轮询路由。 |
| `client.js` | 浏览器半边：长轮询、系统通知、点击打开会话，以及设置 → 通用的开关行。 |
| `cordis.patch.yml` | bundle patch：把插件行插进 profile。 |
| `locale/` | 插件管理页读取的标题与描述。 |
| `scripts/` | 清单检查与两段功能测试。 |

## 修改约定

- **不要引入构建步骤**。`client.js` 以 `window.__ModuleLoader__.load(...)` 的闭包工厂格式发布；浏览器只从 loader 取 `react`，不要 `require('@deepseek-ai/...')` 形式的 Harness Client 包。
- **样式只用主题变量**：`--dsw-alias-*`；不要写死颜色（图标等插画资源除外）。
- **所有用户可见文案走 `ctx.locale`**，并同时补充 `zh` 与 `en` 两套字典。
- **Host 侧不要写会话日志**：提醒是派生状态，只读已提交事件。
- **保持路由安全**：新增 Web 路由必须像 `/reminding/poll` 一样先经过 `ctx.connection.requestRejection`。
- **加测试**：行为改动请同时更新 `scripts/test-host.mjs` / `scripts/test-client.mjs`，并在 PR 里写明验证方式。

## 提交与 PR

1. 从 `main` 拉一个分支；
2. 提交前跑 `npm run check && npm test`；
3. PR 描述里写清楚：改了什么、为什么、怎么验证的；
4. UI 改动请附上浅色 / 深色主题下的截图（如果环境允许）。

## 发布

版本号遵循 SemVer。维护者流程：

1. 更新 `package.json` 的 `version` 和 `CHANGELOG.md`；
2. 创建 GitHub Release（tag 与版本号一致）；
3. `Publish to npm` 工作流使用仓库 secret `NPM_TOKEN` 执行 `npm publish --provenance --access public`。

本地发布需要先 `npm login`，再执行 `npm publish --access public`。provenance 证明只在 CI（工作流的 OIDC）里生成，本地发布不带。
