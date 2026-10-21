/**
 * Functional test of the Host half, run with plain Node:
 *
 *   node scripts/test-host.mjs
 *
 * It mounts index.js on a mocked Cordis context, feeds documented Session
 * events, and exercises the long-poll route with fake request/response pairs.
 * No DSH process, no network and no files are touched.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { apply } from '../index.js'

const listeners = new Map()
const routes = new Map()
let route

const registered = []
const ctx = {
  on(event, listener) {
    listeners.set(event, listener)
    registered.push(() => listeners.delete(event))
    return () => listeners.delete(event)
  },
  get(name) {
    if (name === 'connection') return { requestRejection: () => undefined }
    return undefined
  },
  effect(setup) {
    const dispose = setup()
    registered.push(dispose)
    return dispose
  },
  webServer: {
    register(value) {
      routes.set(value.path, value)
      if (value.path === '/reminding/poll') route = value
      return () => {}
    },
  },
}

apply(ctx)
assert.equal(route.path, '/reminding/poll')
assert.ok(routes.has('/reminding/focus'), 'the toast-click route is mounted')

const fire = (session, event) => listeners.get('session/event')(session, event)

/** One fake Exchange for the route handler: parse the JSON written by the route. */
function exchange(since, wait = 1) {
  const req = new EventEmitter()
  req.url = `/reminding/poll?since=${since}&wait=${wait}`
  const res = new EventEmitter()
  let resolveBody
  const body = new Promise((resolve) => { resolveBody = resolve })
  res.writeHead = () => {}
  res.end = (text) => resolveBody(JSON.parse(text))
  res.writableEnded = false
  route.handler(req, res)
  return { req, res, body }
}

const session = { header: { id: 'session-a' } }
const subagent = { header: { id: 'session-child', origin: 'subagent', delegationDepth: 1 } }

// 1. Baseline handshake replays nothing.
const baseline = await exchange(-1).body
assert.equal(baseline.events.length, 0)
let since = baseline.seq

// 2. Approval ask is published with its session identity once it survives the
//    confirmation delay (a machine answerer closes it sooner).
fire(session, { type: 'approval/asked', data: { id: 'ap-1', toolName: 'pwsh', reason: 'sandbox escalation' } })
assert.equal((await exchange(since, 0).body).events.length, 0)
await new Promise((resolve) => setTimeout(resolve, 500))
let poll = await exchange(since).body
assert.equal(poll.events.length, 1)
assert.equal(poll.events[0].kind, 'approval')
assert.equal(poll.events[0].sessionId, 'session-a')
assert.equal(poll.events[0].toolName, 'pwsh')
since = poll.seq

// 2b. An approval answered inside the delay never produces a toast at all.
fire(session, { type: 'approval/asked', data: { id: 'ap-fast', toolName: 'read' } })
fire(session, { type: 'approval/decided', data: { id: 'ap-fast', outcome: 'allowed-once' } })
await new Promise((resolve) => setTimeout(resolve, 500))
poll = await exchange(since, 0).body
assert.equal(poll.events.filter((entry) => entry.kind === 'approval').length, 0)
assert.equal(poll.events[0].kind, 'resolved')
since = poll.seq

// 3. The outcome resolves that reminder by key.
fire(session, { type: 'approval/decided', data: { id: 'ap-1', outcome: 'allowed-once' } })
poll = await exchange(since).body
assert.equal(poll.events[0].kind, 'resolved')
assert.equal(poll.events[0].key, 'approval:ap-1')
since = poll.seq

// 4. A question tool call becomes a question reminder and its result resolves it.
fire(session, {
  type: 'tool/call',
  data: {
    callId: 'call-1',
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ question: '用哪个方案？', header: '方案', intent: { kind: 'plan-review' } }] }),
  },
})
poll = await exchange(since).body
assert.equal(poll.events[0].kind, 'question')
assert.equal(poll.events[0].question, '用哪个方案？')
assert.equal(poll.events[0].planReview, true)
since = poll.seq

fire(session, { type: 'tool/result', data: { message: { toolCallId: 'call-1' } } })
poll = await exchange(since).body
assert.equal(poll.events[0].kind, 'resolved')
since = poll.seq

// 5. A completed turn is debounced, then published.
fire(session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
assert.equal((await exchange(since, 0).body).events.length, 0)
await new Promise((resolve) => setTimeout(resolve, 1500))
poll = await exchange(since).body
assert.equal(poll.events[0].kind, 'completed')
assert.equal(poll.events[0].sessionId, 'session-a')
since = poll.seq

// 6. A follow-up turn inside the debounce window cancels the toast.
fire(session, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
fire(session, { type: 'turn/start', data: { turn: 5 } })
await new Promise((resolve) => setTimeout(resolve, 1500))
assert.equal((await exchange(since, 0).body).events.length, 0)

// 7. Errors and truncation notify immediately.
fire(session, { type: 'turn/end', data: { turn: 6, reason: { kind: 'error', error: { message: 'upstream 502' } } } })
poll = await exchange(since).body
assert.equal(poll.events[0].kind, 'error')
assert.equal(poll.events[0].message, 'upstream 502')
since = poll.seq

fire(session, { type: 'turn/end', data: { turn: 7, reason: { kind: 'max-tokens' } } })
poll = await exchange(since).body
assert.equal(poll.events[0].kind, 'max-tokens')
since = poll.seq

// 8. Subagent traffic never reaches the feed.
fire(subagent, { type: 'approval/asked', data: { id: 'ap-child', toolName: 'bash' } })
fire(subagent, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await new Promise((resolve) => setTimeout(resolve, 1500))
assert.equal((await exchange(since, 0).body).events.length, 0)

// 9. A held poll is released by the next reminder instead of timing out.
//    The host's own timers are unref'd, so this test keeps one ref'd timer
//    alive while it waits for the release.
const held = exchange(since)
await new Promise((resolve) => setTimeout(resolve, 50))
fire(session, { type: 'approval/asked', data: { id: 'ap-2', toolName: 'write' } })
const heldBody = await Promise.race([
  held.body,
  new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
])
assert.notEqual(heldBody, null, 'held poll was not released')
poll = heldBody
assert.equal(poll.events.length, 1)
assert.equal(poll.events[0].key, 'approval:ap-2')

console.log('host: all assertions passed')
