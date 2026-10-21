/**
 * dsh-reminding — browser half.
 *
 * Long-polls the Host's `/reminding/poll` feed and turns each item into an OS
 * notification through the standard Notification API, which is what makes the
 * same code work on Windows (toast), macOS (Notification Center) and Linux
 * (libnotify) — the desktop shell and every Chromium-based browser implement
 * it. Clicking a notification focuses the window and opens the exact
 * conversation through `ctx.uiWorkspace.openSession(sessionId)`.
 *
 * The Settings → General row is the one piece of visible UI: a master switch,
 * the live permission state, and a test button (the user gesture browsers
 * require before granting notification permission).
 *
 * Notifications are suppressed when the page has focus AND the URL already
 * shows that conversation, so looking at the answer never produces a redundant
 * toast; being anywhere else (another conversation, another app) does.
 */
window.__ModuleLoader__.load({
  id: 'dsh-reminding',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Locale namespace of every user-visible string in this plugin. */
    const NS = 'dsh-reminding'
    /** Host route, document-relative so a directory-mounted GUI still works. */
    const ROUTE_POLL = 'reminding/poll'
    /** Where the master switch lives; localStorage keeps it per browser. */
    const STORAGE_KEY = 'dsh-reminding:settings'
    /** Longest body line sent to the OS; toasts truncate anyway. */
    const MAX_BODY = 140

    const zh = {
      'meta.title': '系统提醒',
      'settings.title': '系统提醒',
      'settings.description': '对话需要授权、模型提问或回复完成时弹出系统通知；点击通知直接回到对应对话。',
      'settings.toggle': '系统通知开关',
      'settings.test': '测试',
      'settings.permission.granted': '通知权限：已允许',
      'settings.permission.default': '通知权限：未授权，点击「测试」完成授权',
      'settings.permission.denied': '通知权限：已被阻止，请在系统或浏览器设置中允许后刷新',
      'settings.permission.unsupported': '当前环境不支持系统通知',
      'settings.testSent': '测试通知已发送，请查看系统通知中心。',
      'settings.testBlocked': '无法发送：通知权限未授予。',
      'settings.testFailed': '发送失败：{error}',
      'notify.approval.title': '需要你的授权',
      'notify.approval.body': '工具「{tool}」正在等待你的授权',
      'notify.approval.fallback': '有一步操作正在等待你的授权',
      'notify.approval.reason': '原因：{reason}',
      'notify.question.title': '模型在等你回答',
      'notify.question.body': '模型提出了一个问题，点击回到对话处理。',
      'notify.question.planReview': '模型提交了计划，等待你的审阅。',
      'notify.completed.title': '对话已完成',
      'notify.completed.body': '这一轮回复已经结束，点击回到对话查看。',
      'notify.error.title': '生成失败',
      'notify.error.body': '这一轮回复因错误中断。',
      'notify.maxTokens.title': '输出被截断',
      'notify.maxTokens.body': '已达到输出 token 上限。',
      'notify.test.title': '测试通知',
      'notify.test.body': '通知已开启，点击这条消息可回到对话。',
      'notify.sessionFallback': '对话',
    }

    const en = {
      'meta.title': 'System Reminders',
      'settings.title': 'System reminders',
      'settings.description': 'OS notifications when a step needs your approval, the model asks a question, or a turn finishes; click a toast to jump back to that conversation.',
      'settings.toggle': 'System notification switch',
      'settings.test': 'Test',
      'settings.permission.granted': 'Notification permission: allowed',
      'settings.permission.default': 'Notification permission: not granted yet — press “Test” to allow',
      'settings.permission.denied': 'Notification permission: blocked — allow it in the system or browser settings, then refresh',
      'settings.permission.unsupported': 'System notifications are unavailable in this environment',
      'settings.testSent': 'Test notification sent — check your system notification center.',
      'settings.testBlocked': 'Cannot send: notification permission is not granted.',
      'settings.testFailed': 'Send failed: {error}',
      'notify.approval.title': 'Approval needed',
      'notify.approval.body': 'Tool “{tool}” is waiting for your approval',
      'notify.approval.fallback': 'An operation is waiting for your approval',
      'notify.approval.reason': 'Reason: {reason}',
      'notify.question.title': 'The model is waiting for you',
      'notify.question.body': 'The model asked a question — click to open the conversation.',
      'notify.question.planReview': 'The model submitted a plan for your review.',
      'notify.completed.title': 'Turn finished',
      'notify.completed.body': 'This reply is finished — click to open the conversation.',
      'notify.error.title': 'Generation failed',
      'notify.error.body': 'This turn stopped with an error.',
      'notify.maxTokens.title': 'Output truncated',
      'notify.maxTokens.body': 'The output token limit was reached.',
      'notify.test.title': 'Test notification',
      'notify.test.body': 'Notifications are on. Click this message to return to the conversation.',
      'notify.sessionFallback': 'Conversation',
    }

    /** Substitute `{name}` placeholders without depending on a translate API. */
    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (
        params !== undefined && params[name] !== undefined ? String(params[name]) : match
      ))
    }

    /** Fallback translator used when the Client locale service is absent. */
    function fallbackT(key, params) {
      const template = zh[key] ?? key
      return params === undefined ? template : fill(template, params)
    }

    // -----------------------------------------------------------------------
    // Master switch. Module-level so the polling loop, the settings row and a
    // plugin reload in the same page all observe one value.
    let enabled = true
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw !== null) {
        const parsed = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object' && parsed.enabled === false) enabled = false
      }
    } catch {
      enabled = true
    }

    function persistEnabled(next) {
      enabled = next
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: next }))
      } catch {
        // Private mode or a full quota keeps the in-memory value for this page.
      }
    }

    /** The context of the active activation, used by toast click handlers. */
    let activeContext = null

    // -----------------------------------------------------------------------
    // Notification plumbing.

    /** Current permission, normalized across browsers and the desktop shell. */
    function permissionState() {
      try {
        if (typeof Notification === 'undefined') return 'unsupported'
        return Notification.permission
      } catch {
        return 'unsupported'
      }
    }

    /**
     * Ask for notification permission. Call from a user gesture when possible;
     * the desktop shell usually answers without showing a prompt.
     * @returns the resulting permission state.
     */
    async function requestPermission() {
      const current = permissionState()
      if (current !== 'default') return current
      try {
        return await Notification.requestPermission()
      } catch {
        return 'error'
      }
    }

    /** Whether the page is visible and holds keyboard focus. */
    function pageFocused() {
      try {
        return document.hasFocus() && document.visibilityState === 'visible'
      } catch {
        return false
      }
    }

    /** Whether the current URL already shows that conversation. */
    function viewingSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      try {
        return window.location.href.includes(sessionId)
      } catch {
        return false
      }
    }

    /** Ask the Host to restore the desktop window; a browser Host has no window to restore. */
    function requestWindowFocus() {
      try {
        void fetch('reminding/focus', { method: 'POST', cache: 'no-store' }).catch(() => {})
      } catch {
        // The Host route is an enhancement; window.focus() remains the fallback.
      }
    }

    /** Open the conversation that produced one reminder. */
    function openConversation(sessionId) {
      requestWindowFocus()
      try {
        window.focus()
      } catch {
        // A denied focus is cosmetic: the navigation below still happens.
      }
      if (typeof sessionId !== 'string' || sessionId === '') return
      try {
        activeContext?.get?.('uiWorkspace')?.openSession?.(sessionId)
      } catch (err) {
        console.warn('[dsh-reminding] could not open the conversation:', err)
      }
    }

    /** Look up one session's title with a defensive read of the Client store. */
    function sessionTitle(sessionId) {
      try {
        const snapshot = activeContext?.get?.('sessions')?.list?.getSnapshot?.()
        if (snapshot === null || snapshot === undefined) return ''
        const summary = snapshot.byId?.[sessionId]
        const direct = summary?.title ?? summary?.name
        if (typeof direct === 'string' && direct.trim() !== '') return direct.trim()
        const values = snapshot.projectionsBySession?.[sessionId]?.values
        const projected = values?.title
        if (typeof projected === 'string' && projected.trim() !== '') return projected.trim()
        if (projected !== null && typeof projected === 'object' && typeof projected.title === 'string') {
          return projected.title.trim()
        }
      } catch {
        // A cold or malformed store only costs the title, never the toast.
      }
      return ''
    }

    /** Trim one body line for the OS notification. */
    function clip(text) {
      const value = typeof text === 'string' ? text.trim() : ''
      return value.length > MAX_BODY ? `${value.slice(0, MAX_BODY)}…` : value
    }

    /**
     * Compose the localized title and body of one reminder.
     * @param t - translate function bound to this plugin's namespace.
     * @param item - one Host feed item.
     * @returns `{ title, body }`.
     */
    function describe(t, item) {
      const kind = typeof item?.kind === 'string' ? item.kind : ''
      const title = sessionTitle(item?.sessionId)
      const prefix = title === '' ? '' : `【${title}】`
      const withSession = (text) => `${prefix}${clip(text)}`
      if (kind === 'approval') {
        const tool = typeof item.toolName === 'string' ? item.toolName : ''
        const base = tool === ''
          ? t('notify.approval.fallback')
          : fill(t('notify.approval.body'), { tool })
        const reason = typeof item.reason === 'string' ? item.reason : ''
        return {
          title: t('notify.approval.title'),
          body: withSession(base + (reason === '' ? '' : ` · ${fill(t('notify.approval.reason'), { reason })}`)),
        }
      }
      if (kind === 'question') {
        const question = typeof item.question === 'string' ? item.question : ''
        if (question !== '') {
          return { title: t('notify.question.title'), body: withSession(question) }
        }
        return {
          title: t('notify.question.title'),
          body: withSession(t(item.planReview === true ? 'notify.question.planReview' : 'notify.question.body')),
        }
      }
      if (kind === 'completed') {
        return { title: t('notify.completed.title'), body: withSession(t('notify.completed.body')) }
      }
      if (kind === 'error') {
        const message = typeof item.message === 'string' ? item.message : ''
        return {
          title: t('notify.error.title'),
          body: withSession(message === '' ? t('notify.error.body') : message),
        }
      }
      if (kind === 'max-tokens') {
        return { title: t('notify.maxTokens.title'), body: withSession(t('notify.maxTokens.body')) }
      }
      if (kind === 'test') {
        return { title: t('notify.test.title'), body: t('notify.test.body') }
      }
      return null
    }

    /** Live toasts by feed key, so a resolved approval/question can close its own toast. */
    const liveToasts = new Map()

    /** TEMPORARY: last showReminder decision, reported through the next poll for diagnosis. */
    let lastDecision = ''

    /** Close one toast by its feed key. */
    function closeToast(key) {
      const entry = liveToasts.get(key)
      if (entry === undefined) return
      liveToasts.delete(key)
      try {
        entry.close()
      } catch {
        // Already dismissed by the OS: nothing to do.
      }
    }

    /**
     * Show one reminder as an OS notification.
     * @param t - translate function.
     * @param item - feed item.
     * @param options - `force` bypasses the master switch and the focus gate.
     * @returns true when a notification was actually created.
     */
    function showReminder(t, item, options = {}) {
      if (options.force !== true) {
        if (!enabled) { lastDecision = `${item?.kind}:off`; return false }
        if (pageFocused() && viewingSession(item?.sessionId)) { lastDecision = `${item?.kind}:focus`; return false }
      }
      if (permissionState() !== 'granted') { lastDecision = `${item?.kind}:perm=${permissionState()}`; return false }
      const copy = describe(t, item)
      if (copy === null) { lastDecision = `${item?.kind}:nokind`; return false }
      try {
        const notification = new Notification(copy.title, {
          body: copy.body,
          tag: item?.kind === 'completed' ? undefined : typeof item.key === 'string' ? item.key : undefined,
        })
        lastDecision = `${item?.kind}:ok`
        notification.onshow = () => { lastDecision = `${item?.kind}:shown` }
        const key = typeof item.key === 'string' ? item.key : ''
        if (key !== '') {
          closeToast(key)
          liveToasts.set(key, notification)
        }
        notification.onclick = () => {
          lastDecision = `click:${item?.sessionId ?? ''}`
          openConversation(item?.sessionId)
          try {
            notification.close()
          } catch {
            // Closing an already dismissed toast is a no-op.
          }
          if (key !== '') liveToasts.delete(key)
        }
        notification.onclose = () => {
          if (key !== '') liveToasts.delete(key)
        }
        notification.onerror = () => {
          lastDecision = `${item?.kind}:onerror`
          if (key !== '') liveToasts.delete(key)
        }
        return true
      } catch (err) {
        lastDecision = `${item?.kind}:error=${err?.message ?? String(err)}`
        console.warn('[dsh-reminding] could not show the notification:', err)
        return false
      }
    }

    /** Sleep helper for reconnect backoff (never used on the fast path). */
    function delay(ms) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms)
      })
    }

    /**
     * Long-poll the Host feed until the plugin is disposed. The next request
     * starts from the network callback rather than a timer, so a background or
     * minimized window keeps receiving reminders instead of being throttled.
     * @param getT - current translate function.
     * @returns disposal function.
     */
    function startFeed(getT) {
      let stopped = false
      let controller = null
      let since = -1
      let retries = 0

      const handle = (item) => {
        if (item === null || typeof item !== 'object') return
        if (item.kind === 'resolved') {
          closeToast(typeof item.key === 'string' ? item.key : '')
          return
        }
        showReminder(getT(), item)
      }

      const run = async () => {
        while (!stopped) {
          controller = typeof AbortController === 'function' ? new AbortController() : null
          try {
            const diag = `&page=${encodeURIComponent(window.location.href)}&perm=${encodeURIComponent(permissionState())}&on=${enabled ? 1 : 0}&focus=${pageFocused() ? 1 : 0}&dec=${encodeURIComponent(lastDecision)}`
            // A poll the Host never answers (for example while its plugin
            // reloads) must not freeze the feed: give every request a bound,
            // above the Host's own 25s hold, and retry after it.
            const timeout = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(30_000) : null
            let signal
            if (controller === null) signal = timeout ?? undefined
            else if (timeout !== null && typeof AbortSignal?.any === 'function') signal = AbortSignal.any([controller.signal, timeout])
            else signal = controller.signal
            const response = await fetch(`${ROUTE_POLL}?since=${since}&wait=1${diag}`, {
              cache: 'no-store',
              ...(signal === undefined ? {} : { signal }),
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            retries = 0
            const hostSeq = Number(payload?.seq)
            if (Number.isFinite(hostSeq) && (since < 0 || hostSeq < since)) since = hostSeq
            const events = Array.isArray(payload?.events) ? payload.events : []
            for (const item of events) {
              const itemSeq = Number(item?.seq)
              if (Number.isFinite(itemSeq)) since = Math.max(since, itemSeq)
              handle(item)
            }
          } catch (err) {
            if (stopped) return
            retries += 1
            await delay(Math.min(10_000, 750 * retries))
          }
        }
      }

      run()
      return () => {
        stopped = true
        if (controller !== null) controller.abort()
      }
    }

    // -----------------------------------------------------------------------
    // Settings row (Settings → General). The owner passes no props, so the row
    // draws its own label, state and controls from the injected face.

    const STYLES = [
      '.dsh-reminding-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; padding: 10px 0; box-sizing: border-box; }',
      '.dsh-reminding-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }',
      '.dsh-reminding-title { font-size: 14px; font-weight: 500; line-height: 22px; color: var(--dsw-alias-label-primary); }',
      '.dsh-reminding-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
      '.dsh-reminding-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
      '.dsh-reminding-message { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); }',
      '.dsh-reminding-message-error { color: var(--dsw-alias-state-error-primary); }',
      '.dsh-reminding-controls { display: inline-flex; align-items: center; gap: 10px; flex: 0 0 auto; }',
      '.dsh-reminding-switch { position: relative; width: 36px; height: 20px; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); cursor: pointer; transition: background 120ms ease, border-color 120ms ease; }',
      '.dsh-reminding-switch.is-on { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }',
      '.dsh-reminding-knob { position: absolute; top: 1px; left: 1px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-bg-base); transition: transform 120ms ease; }',
      '.dsh-reminding-switch.is-on .dsh-reminding-knob { transform: translateX(16px); }',
      '.dsh-reminding-switch:focus-visible, .dsh-reminding-test:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }',
      '.dsh-reminding-test { height: 28px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; cursor: pointer; }',
      '.dsh-reminding-test:hover { background: var(--dsw-alias-bg-layer-2); }',
    ].join('\n')

    /** Settings → General → one row: master switch, permission state, test. */
    function RemindingSettings(props) {
      const t = typeof props?.t === 'function' ? props.t : fallbackT
      const [isEnabled, setIsEnabled] = React.useState(enabled)
      const [permission, setPermission] = React.useState(permissionState)
      const [message, setMessage] = React.useState('')

      React.useEffect(() => {
        const refresh = () => setPermission(permissionState())
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)
        return () => {
          window.removeEventListener('focus', refresh)
          document.removeEventListener('visibilitychange', refresh)
        }
      }, [])

      const toggle = async () => {
        const next = !isEnabled
        setIsEnabled(next)
        persistEnabled(next)
        setMessage('')
        if (next) setPermission(await requestPermission())
      }

      const test = async () => {
        setMessage('')
        const granted = await requestPermission()
        setPermission(granted)
        if (granted !== 'granted') {
          setMessage(t(granted === 'unsupported' ? 'settings.permission.unsupported' : 'settings.testBlocked'))
          return
        }
        if (!enabled) {
          persistEnabled(true)
          setIsEnabled(true)
        }
        const sent = showReminder(t, { kind: 'test', key: `test:${Date.now()}`, sessionId: '' }, { force: true })
        setMessage(sent ? t('settings.testSent') : t('settings.testFailed', { error: 'Notification' }))
      }

      const permissionText = permission === 'granted'
        ? t('settings.permission.granted')
        : permission === 'denied'
          ? t('settings.permission.denied')
          : permission === 'unsupported'
            ? t('settings.permission.unsupported')
            : t('settings.permission.default')

      return h('div', { className: 'dsh-reminding-row' },
        h('style', { 'data-plugin-css': 'dsh-reminding/styles', dangerouslySetInnerHTML: { __html: STYLES } }),
        h('div', { className: 'dsh-reminding-copy' },
          h('div', { className: 'dsh-reminding-title' }, t('settings.title')),
          h('div', { className: 'dsh-reminding-desc' }, t('settings.description')),
          h('div', { className: 'dsh-reminding-note' }, permissionText),
          message === '' ? null : h('div', {
            className: `dsh-reminding-message${permission === 'granted' ? '' : ' dsh-reminding-message-error'}`,
          }, message),
        ),
        h('div', { className: 'dsh-reminding-controls' },
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': isEnabled,
            'aria-label': t('settings.toggle'),
            title: t('settings.toggle'),
            className: `dsh-reminding-switch${isEnabled ? ' is-on' : ''}`,
            onClick: () => { void toggle() },
          }, h('span', { className: 'dsh-reminding-knob' })),
          h('button', {
            type: 'button',
            className: 'dsh-reminding-test',
            onClick: () => { void test() },
          }, t('settings.test')),
        ),
      )
    }

    /**
     * Activate the browser half.
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      activeContext = ctx

      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      let t = fallbackT
      if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-reminding: dictionaries')
        t = locale.bind(NS)
      }

      // Keep the feed alive for the whole page lifetime, independent of the
      // Settings panel: reminders must arrive with the panel closed.
      ctx.effect(() => startFeed(() => t), 'dsh-reminding: notification feed')

      // Grant once at boot when the environment answers without a prompt; a
      // browser that requires a gesture will grant from the Test button.
      if (enabled && permissionState() === 'default') {
        void requestPermission()
      }

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'dsh-reminding',
        order: 25,
        locale: NS,
        inject: () => ({ t }),
      }, RemindingSettings))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
