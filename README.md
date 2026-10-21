<p align="center">
  <img src="https://raw.githubusercontent.com/liuchaoxu/dsh-reminding/main/icon.svg" width="76" height="76" alt="dsh-reminding icon">
</p>

<h1 align="center">dsh-reminding</h1>

<p align="center">
  DeepSeek Harness 的系统提醒插件：需要你授权、模型提问或回合结束时弹出系统通知，<br>
  点一下通知，直接回到对应对话。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-reminding"><img src="https://img.shields.io/npm/v/dsh-reminding.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-reminding"><img src="https://img.shields.io/npm/dm/dsh-reminding.svg" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Windows, macOS, Linux">
  <img src="https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2-4B32C3" alt="DSH version">
</p>

---

## 为什么需要它

在 DeepSeek Harness 里，模型经常会停下来等你：一次敏感操作需要你点“允许”，一个问题需要你选择，或者一个回合已经跑完。你切到别的窗口以后，这些时刻很容易被错过。

`dsh-reminding` 把这三类时刻变成**操作系统的系统通知**（Windows 通知中心 / macOS 通知中心 / Linux libnotify），并把「点击通知」接回 Harness：**直接打开产生这条提醒的那个对话**，不需要在侧栏里翻。

- 零依赖：纯 ESM + 浏览器原生 Notification API，没有 npm 运行依赖；
- 零遥测：不联网、不上报、不写会话日志，提醒只在内存里流转；
- 零配置即可用：装好就有默认行为，设置页只提供一个总开关、权限状态和测试按钮。

## 提醒时机

插件只读已提交的会话日志（`session/event`），不改变模型行为，也不写任何会话事件：

| 会话事件 | 通知标题 | 说明 |
| --- | --- | --- |
| `approval/asked` | 需要你的授权 | 工具调用在等待你允许（沙箱升级、敏感操作等）；400ms 内被机器应答的请求不会误弹 |
| `ask_user_question` 工具调用 | 模型在等你回答 | 模型提问，或提交计划审阅 |
| `turn/end` → `completed` | 对话已完成 | 这一轮回复结束；1.2 秒内紧接的后续轮次会自动合并，不会连续轰炸 |
| `turn/end` → `error` | 生成失败 | 这一轮因错误中断 |
| `turn/end` → `max-tokens` | 输出被截断 | 达到输出 token 上限 |

- 授权 / 提问被处理（`approval/decided`、对应工具返回结果）后，已经弹出的那条通知会自动关闭；
- 子代理（subagent）会话不会提醒，避免一次任务被拆成几十条通知；
- 页面有焦点、且当前地址已经是这条提醒对应的会话时不会弹（你正看着它）；
- 页面失焦、最小化、或停留在另一个对话里时都会正常提醒。

## 点击跳转

每条提醒都带着会话 ID。点击通知会：

1. 把 Harness 窗口切到前台；
2. 调用 Client 的 `uiWorkspace.openSession(sessionId)` 打开对应对话。

测试通知只演示弹框，点击它只会聚焦窗口；只有真实提醒才带会话 ID。

## 安装

插件以 bundle 形式发布，`package.json` 的 `dsh.bundle.patch` 会把它挂进当前 profile。

### 方式一：插件页面（推荐）

1. 打开 Harness 侧栏的 **Plugins** 页面；
2. 在添加/安装入口输入 `dsh-reminding`；
3. 选择安装，成功后页面通常即时生效；若没有看到新的设置行，刷新一次页面。

### 方式二：CLI（高级）

```bash
dsh plugin --profile <profile> add dsh-reminding
```

这条命令把包装进 profile；随后在侧栏 **Plugins** 页面把 `dsh-reminding` 选为启用（bundle 是否加载由 profile 的 `dsh.profile.bundles` 决定，单纯 `pnpm add` 不会自动选中）。

> `desktop` 应用管理的 profile 不允许 CLI 直接改写，请使用插件页面。

### 方式三：本地目录（开发）

使用 agent 的 `plugin_manager` `install_bundle`，target 指向本目录的绝对路径。等效的 CLI 写法是 `dsh plugin --profile <profile> add link:/absolute/path/to/dsh-reminding`，安装后同样需要在 **Plugins** 页面启用。

## 设置

**设置 → 通用 → 系统提醒** 一行：

- **总开关**：关闭后不再弹任何系统通知（保存在浏览器 `localStorage`，按浏览器/设备区分）；
- **权限状态**：已允许 / 未授权 / 已被阻止 / 不支持；
- **测试**：发一条测试通知，同时也是浏览器要求的用户手势授权入口。

安装后首次加载会尝试自动授权；桌面端通常直接允许，普通浏览器若要求手势，点一次「测试」即可。

## 平台

### Windows

通知出现在右下角通知中心。Windows 会**按应用**单独拦截通知，且拦截发生在插件之外，插件无从感知。收不到弹框时按顺序检查：

1. **设置 → 系统 → 通知 → DeepSeek Harness**：确认「允许通知」和「显示通知横幅」都打开；
2. 确认「专注助手 / 勿扰」没有开启；
3. 回到 设置 → 通用 → 系统提醒，点一次「测试」。

也可以直接看注册表（应用级开关关闭时 `Enabled = 0`，通知会被系统静默丢弃）：

```powershell
Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\electron.app.DeepSeek Harness'
```

### macOS

通知出现在通知中心。首次可能需要在 **系统设置 → 通知 → DeepSeek Harness** 里允许；如果之前选过“不允许”，需要在那里重新打开。

### Linux

依赖桌面环境的通知守护进程（libnotify / dunst / GNOME Shell 等）。没有通知服务的精简桌面不会显示弹框。

浏览器访问 `dsh web` 时同样可用，但受浏览器通知权限与站点设置约束。

## 隐私与安全

- **不联网**：插件不发起任何外部请求，也不采集遥测；
- **只读**：只订阅已提交的 `session/event`，不追加事件、不改会话；
- **不落盘**：提醒只存在于 Host 进程内存与页面内存，刷新后从当前序号重建基线，不回放旧提醒；
- **本机路由**：浏览器半边通过 `/reminding/poll` 长轮询取提醒，路由先经过 `ctx.connection.requestRejection` 的浏览器信任栅栏；
- 通知正文只在本机展示，包含会话标题、工具名或问题文本，不会离开设备。

## 兼容性

| 项 | 要求 |
| --- | --- |
| DeepSeek Harness | `>= 0.2.1-rc.2`（`engines.dsh`，插件管理器会在安装前校验） |
| Node.js | `>= 18` |
| 运行形态 | DSH 桌面应用、`dsh web` 浏览器访问均可 |
| 操作系统 | Windows、macOS、Linux |

DSH 版本兼容声明同时写在 `package.json` 的 `dsh.compatibility.dshReleases` 里。

## 开发

仓库没有构建步骤：`index.js` 是 Host 半边，`client.js` 是浏览器半边，都是可直接加载的 ESM / 纯 JS。

```bash
git clone https://github.com/liuchaoxu/dsh-reminding.git
cd dsh-reminding

npm run check        # 清单、导出、locale、图标、patch 的一致性检查
npm test             # Host 事件流 + Client 通知/跳转的功能测试（无需 DSH 进程）
npm run pack:check   # 查看 npm 实际发布的文件列表
```

两段测试都使用 Node 内置能力，不联网、不写盘：

- `scripts/test-host.mjs`：模拟 Cordis 上下文，覆盖授权、提问、完成、失败、去抖取消、子代理过滤与长轮询释放；
- `scripts/test-client.mjs`：加载真实的 `client.js` 工厂，脚本化 Host 响应，断言通知标题/正文与点击后的 `openSession`。

目录：

```text
.
├── index.js              # Host 半边：session/event → 提醒流 → /reminding/poll
├── client.js             # 浏览器半边：长轮询 → 系统通知 → 打开会话
├── cordis.patch.yml      # bundle patch：插入 dsh-reminding 行
├── locale/{zh,en}.json   # 插件管理页的标题与描述
├── icon.svg              # 插件图标
├── scripts/              # check + 两段功能测试
└── .github/              # CI、发布工作流、issue 模板
```

### 发布

1. 更新 `package.json` 的 `version` 与 `CHANGELOG.md`；
2. 打 tag 并创建 GitHub Release，`Publish to npm` 工作流会用 `NPM_TOKEN` 执行 `npm publish --provenance --access public`（provenance 需要 CI 的 OIDC，因此由工作流完成）；
3. 也可以在本地执行 `npm publish --access public`（先 `npm login`），但本地产物不带 provenance 证明。

## 常见问题

**设置里没有「系统提醒」这一行？** 安装后刷新一次页面；如果仍未出现，检查 设置 → 插件 里 `dsh-reminding` 是否启用。

**和 dsh-pet 的通知重复？** 两者都提供系统通知。关掉任意一个即可：本插件在 设置 → 通用 → 系统提醒，dsh-pet 在它自己的设置页。

**点击测试通知没有跳转？** 这是预期行为：测试通知没有会话 ID，只会聚焦窗口；真实提醒会打开对应对话。

**窗口关掉后还会提醒吗？** 不会。通知逻辑在页面内，这是“点击跳转”的前提；请保持 Harness 窗口（可以最小化）运行。

## License

[MIT](LICENSE) © 2026 liuchaoxu

---

## English

**System reminders for DeepSeek Harness.** When a tool call is waiting for your approval, the model asks a question (including plan review), or a turn finishes / fails / hits the output limit, the plugin raises an OS notification. Clicking it focuses Harness and opens the exact conversation.

- Cross-platform OS notifications via the standard Notification API (Windows toast, macOS Notification Center, Linux libnotify);
- Approval and question notifications close themselves once the decision is made;
- Subagent sessions are ignored; completion is debounced so goal rounds do not spam you;
- Notifications are suppressed only while you are focused on that very conversation;
- No dependencies, no network calls, no telemetry, no session-log writes; reminders live in memory only.

Install from the Harness **Plugins** page by entering `dsh-reminding`, or run `dsh plugin --profile <profile> add dsh-reminding` and then enable the bundle on that page. Then find **Settings → General → System reminders** for the master switch, permission state, and a test button.

On Windows, if nothing appears, check **Settings → System → Notifications → DeepSeek Harness** — the OS can disable notifications per app, silently and outside the plugin's control.

Requires DeepSeek Harness `>= 0.2.1-rc.2` and Node.js `>= 18`. MIT licensed.
