# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | ✅ |

## Reporting a vulnerability

请不要在公开 issue 里披露安全问题。优先使用 GitHub 的 **Security → Report a vulnerability**（Security Advisories）私下报告，并附上：

- 受影响的版本；
- 复现步骤与最小示例；
- 影响范围（例如：能否读取其他会话、能否伪造通知、能否绕过信任栅栏）。

## 安全模型

`dsh-reminding` 是一个在 Harness 进程内运行的插件，理解它的边界有助于判断报告是否属于本项目：

- Host 半边只订阅已提交的 `session/event`，不追加事件、不修改会话、不写入磁盘；
- 浏览器半边只做长轮询和 `new Notification(...)`，点击时调用 Harness 自己的 `uiWorkspace.openSession`；
- `/reminding/poll` 是 loopback Web 路由，注册时先经过 `ctx.connection.requestRejection`，未授权的请求由该栅栏直接拒绝；
- 插件不发起任何外部网络请求，不采集遥测，提醒内容只在内存中流转；
- 通知正文包含本机会话标题、工具名或问题文本，这些内容不会离开设备。

以下情况不属于本项目的漏洞：操作系统按应用关闭了通知、用户自行关闭总开关、浏览器拒绝通知权限、或 Harness 自身 `uiWorkspace` 的导航行为。
