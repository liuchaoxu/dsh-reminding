/**
 * dsh-reminding — Host half.
 *
 * Watches the committed Session log and republishes the three moments a user
 * may be away for:
 *
 * - `approval/asked` — a sensitive tool call is waiting for a permission
 *   decision (`approval/decided` closes it again),
 * - an `ask_user_question` tool call — the model asked a structured question
 *   (or a plan review) and is waiting for the answer (`tool/result` closes it),
 * - `turn/end` with `completed` / `error` / `max-tokens` — the reply settled.
 *   Completion is debounced briefly so a goal round or an immediately
 *   following turn does not produce one toast per turn.
 *
 * Subagent sessions are ignored: they belong to their parent, and notifying
 * for every delegated step would bury the user in toasts.
 *
 * Delivery is a loopback Web route the browser half long-polls. Every item
 * carries its `sessionId`, which is what makes a toast click open the exact
 * conversation. The route applies the composition's own browser-trust fence
 * through `ctx.connection.requestRejection`, like the shipped browser-facing
 * routes, so a request from an unaccepted authority gets the same 401/403.
 *
 * Everything is derived from the log; nothing is persisted. A page reload
 * starts a fresh baseline and never replays old reminders.
 */

export const inject = ['webServer']

/** Loopback route the browser half long-polls. */
const ROUTE_POLL = '/reminding/poll'
/** How many feed items stay available for a briefly disconnected page. */
const MAX_FEED = 80
/** How long one poll is held open before an empty answer releases it. */
const MAX_WAIT_MS = 25_000
/** Completion debounce: a follow-up turn inside this window cancels the toast. */
const COMPLETION_DEBOUNCE_MS = 1_200
/**
 * Approval confirmation delay: an ask closed by a machine answerer or an
 * immediate cancellation is no longer a human decision worth a toast.
 */
const APPROVAL_NOTIFY_DELAY_MS = 400
/** The tool whose call means "the model is waiting for the user's answer". */
const USER_QUESTION_TOOL = 'ask_user_question'

/**
 * Whether one session should produce reminders. A delegated child session is
 * filtered out so its steps do not notify on behalf of the same conversation.
 * @param session - the session whose log grew.
 * @returns true for a user-facing (root) session.
 */
function shouldNotifySession(session) {
  const header = session?.header
  if (header === null || typeof header !== 'object') return true
  if (header.origin === 'subagent') return false
  const depth = header.delegationDepth
  if (typeof depth === 'number' && Number.isFinite(depth) && depth > 0) return false
  return true
}

/**
 * Parse the `questions` array of one `ask_user_question` call.
 * @param raw - the tool call's JSON argument string.
 * @returns the declared questions, or an empty array when unreadable.
 */
function parseQuestions(raw) {
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed = JSON.parse(raw)
    const questions = parsed?.questions
    return Array.isArray(questions) ? questions : []
  } catch {
    return []
  }
}

/** Write one JSON response with no caching. */
function writeJson(res, value) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/**
 * Apply the composition's browser-trust fence to one request. `node:http`
 * routes are unauthenticated by construction, so every route owner decides;
 * this mirrors the shipped browser-facing routes and answers 401/403 itself.
 * @param ctx - host context, with the optional `connection` service.
 * @param req - incoming request.
 * @param res - response to answer on when rejected.
 * @returns true when the request was already answered and the handler must stop.
 */
function rejected(ctx, req, res) {
  let rejection
  try {
    rejection = ctx.get?.('connection')?.requestRejection?.(req)
  } catch {
    rejection = undefined
  }
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/**
 * Mount the reminder feed.
 * @param ctx - host context with `webServer`.
 */
export function apply(ctx) {
  let seq = 0
  let disposed = false
  /** Published feed items, oldest first. */
  const feed = []
  /** Long-poll waiters: `{ since, flush(), cancel() }`. */
  const waiters = new Set()
  /** Per-session pending completion timers. */
  const completionTimers = new Map()
  /** Pending approval toasts, keyed by approval request id. */
  const approvalTimers = new Map()

  /**
   * Append one item to the feed and release every waiter that now has news.
   * @param item - event payload; `kind`, `sessionId` and `key` are the contract.
   */
  function publish(item) {
    if (disposed) return
    seq += 1
    const entry = { seq, at: Date.now(), ...item }
    feed.push(entry)
    if (feed.length > MAX_FEED) feed.splice(0, feed.length - MAX_FEED)
    for (const waiter of [...waiters]) {
      try {
        waiter.flush()
      } catch (err) {
        // A waiter whose socket vanished must not break the event fold.
        console.error('[dsh-reminding] failed to release a poll waiter:', err)
        waiter.cancel()
      }
    }
  }

  /**
   * Hold one poll open until there is something newer than `since`.
   * @param req - waiting request (its close cancels the wait).
   * @param res - response to answer on.
   * @param since - last sequence the page has already processed.
   */
  function hold(req, res, since) {
    let settled = false
    const waiter = {}
    const finish = (events) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      waiters.delete(waiter)
      try {
        writeJson(res, { seq, events })
      } catch {
        // The page navigated away while the answer was in flight.
      }
    }
    const timer = setTimeout(() => finish([]), MAX_WAIT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    waiter.flush = () => {
      const events = feed.filter((entry) => entry.seq > since)
      if (events.length > 0) finish(events)
    }
    waiter.cancel = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      waiters.delete(waiter)
    }
    waiters.add(waiter)
    req.once('close', waiter.cancel)
    res.once('close', waiter.cancel)
  }

  /** Cancel a scheduled completion toast for one session. */
  function cancelCompletion(sessionId) {
    const timer = completionTimers.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    completionTimers.delete(sessionId)
  }

  /**
   * Schedule the completion reminder for one settled turn; a new turn or a new
   * user message inside the debounce window cancels it.
   * @param sessionId - the settled conversation.
   * @param turn - the turn that ended.
   */
  function scheduleCompletion(sessionId, turn) {
    cancelCompletion(sessionId)
    const timer = setTimeout(() => {
      completionTimers.delete(sessionId)
      publish({ kind: 'completed', key: `turn:${sessionId}:${turn}`, sessionId, turn })
    }, COMPLETION_DEBOUNCE_MS)
    if (typeof timer.unref === 'function') timer.unref()
    completionTimers.set(sessionId, timer)
  }

  /**
   * Fold one committed session event into feed items. Everything here reads
   * only documented event payloads; an unexpected shape is contained so a
   * reminder can never break the session append that produced it.
   * @param session - the session whose log grew.
   * @param event - the committed event.
   */
  function onSessionEvent(session, event) {
    try {
      if (disposed) return
      if (!shouldNotifySession(session)) return
      const sessionId = String(session?.header?.id ?? session?.id ?? '')
      if (sessionId === '') return
      const data = event?.data ?? {}
      switch (event?.type) {
        case 'approval/asked': {
          const approvalId = String(data.id ?? '')
          if (approvalId === '') break
          const timer = setTimeout(() => {
            approvalTimers.delete(approvalId)
            publish({
              kind: 'approval',
              key: `approval:${approvalId}`,
              sessionId,
              toolName: typeof data.toolName === 'string' ? data.toolName : '',
              reason: typeof data.reason === 'string' ? data.reason : '',
            })
          }, APPROVAL_NOTIFY_DELAY_MS)
          if (typeof timer.unref === 'function') timer.unref()
          approvalTimers.set(approvalId, timer)
          break
        }
        case 'approval/decided': {
          const approvalId = String(data.id ?? '')
          const timer = approvalTimers.get(approvalId)
          if (timer !== undefined) {
            clearTimeout(timer)
            approvalTimers.delete(approvalId)
          }
          publish({
            kind: 'resolved',
            key: `approval:${approvalId}`,
            sessionId,
            outcome: typeof data.outcome === 'string' ? data.outcome : '',
          })
          break
        }
        case 'tool/call': {
          if (data.name !== USER_QUESTION_TOOL) return
          const questions = parseQuestions(data.arguments)
          if (questions.length === 0) return
          const first = questions[0] ?? {}
          const callId = String(data.callId ?? '')
          if (callId === '') return
          publish({
            kind: 'question',
            key: `question:${callId}`,
            sessionId,
            callId,
            question: typeof first.question === 'string' ? first.question : '',
            header: typeof first.header === 'string' ? first.header : '',
            count: questions.length,
            planReview: first?.intent?.kind === 'plan-review',
          })
          break
        }
        case 'tool/result': {
          const callId = String(data?.message?.toolCallId ?? '')
          if (callId === '') return
          publish({ kind: 'resolved', key: `question:${callId}`, sessionId })
          break
        }
        case 'turn/start':
        case 'user/message': {
          cancelCompletion(sessionId)
          break
        }
        case 'turn/end': {
          const reason = data.reason ?? {}
          if (reason.kind === 'completed') {
            scheduleCompletion(sessionId, data.turn)
          } else if (reason.kind === 'error') {
            publish({
              kind: 'error',
              key: `turn:${sessionId}:${String(data.turn ?? '')}:error`,
              sessionId,
              message: typeof reason?.error?.message === 'string' ? reason.error.message : '',
            })
          } else if (reason.kind === 'max-tokens') {
            publish({
              kind: 'max-tokens',
              key: `turn:${sessionId}:${String(data.turn ?? '')}:max`,
              sessionId,
            })
          }
          break
        }
        default:
          break
      }
    } catch (err) {
      console.error('[dsh-reminding] failed to fold a session event:', err)
    }
  }

  ctx.on('session/event', onSessionEvent)
  ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.id
    if (id !== undefined) cancelCompletion(String(id))
  })

  ctx.effect(() => {
    disposed = false
    return () => {
      disposed = true
      for (const timer of completionTimers.values()) clearTimeout(timer)
      completionTimers.clear()
      for (const timer of approvalTimers.values()) clearTimeout(timer)
      approvalTimers.clear()
      for (const waiter of [...waiters]) waiter.cancel()
      waiters.clear()
    }
  }, 'dsh-reminding: lifecycle')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_POLL,
    handler: (req, res) => {
      if (rejected(ctx, req, res)) return
      let since = -1
      let wait = true
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const raw = Number(url.searchParams.get('since'))
        if (Number.isFinite(raw)) since = Math.trunc(raw)
        wait = url.searchParams.get('wait') !== '0'
      } catch {
        since = -1
      }
      // A negative `since` is the initial handshake: report the current
      // sequence without replaying anything a freshly loaded page never saw.
      // `wait=0` is a non-blocking snapshot, used by diagnostics and tests.
      const backlog = since < 0 ? [] : feed.filter((entry) => entry.seq > since)
      if (since < 0 || backlog.length > 0 || since > seq || !wait) {
        writeJson(res, { seq, events: backlog })
        return
      }
      hold(req, res, since)
    },
  }), 'dsh-reminding: /reminding/poll')
}
