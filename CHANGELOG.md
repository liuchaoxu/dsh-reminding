# Changelog

所有值得注意的改动都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-21

### Added

- **系统通知**：授权等待（`approval/asked`）、模型提问 / 计划审阅（`ask_user_question`）、回合完成 / 失败 / 截断（`turn/end`）时弹出操作系统通知。
- **点击跳转**：通知带会话 ID，点击后聚焦 Harness 窗口并通过 `uiWorkspace.openSession(sessionId)` 打开对应对话。
- **设置行**：设置 → 通用 → 系统提醒，提供总开关（localStorage）、通知权限状态和测试按钮。
- **伴随关闭**：授权或提问被处理后，自动关闭已弹出的对应通知。
- **去抖与过滤**：完成提醒 1.2 秒去抖并合并紧接的后续轮次；授权请求 400ms 内被机器应答则不提醒；子代理会话不提醒。
- **聚焦抑制**：页面有焦点且当前地址已经是该会话时不弹，避免盯着答案还被通知。
- **Host 长轮询**：`/reminding/poll` 受 `ctx.connection.requestRejection` 浏览器信任栅栏保护，25 秒长轮询、心跳式重建，支持多窗口。
- **无依赖实现**：纯 ESM Host 半边 + 标准 Notification API 浏览器半边，无 npm 运行依赖、不联网、不写会话日志。
- **发布工程**：MIT License、CHANGELOG、CI（Windows / Linux × Node 20 / 22）、npm 发布工作流、issue / PR 模板、`npm run check` 清单校验与两段无 DSH 进程的功能测试。

### Notes

- Windows 会按应用单独拦截通知：如果系统设置里 `DeepSeek Harness` 的通知被关闭（注册表 `electron.app.DeepSeek Harness` 的 `Enabled = 0`），弹框会被静默丢弃。重新允许后即可恢复，README 的「Windows 收不到通知？」一节记录了排查步骤。
