/**
 * Functional test of the browser half, run with plain Node:
 *
 *   node scripts/test-client.mjs
 *
 * It defines the tiny browser surface client.js uses (module loader, React,
 * Notification, localStorage, fetch), loads the real factory, starts the feed
 * with a scripted Host response, and asserts that a reminder becomes a system
 * notification whose click opens the right conversation.
 */
import assert from 'node:assert/strict'

// --- browser surface -------------------------------------------------------

let captured

class FakeNotification {
  static permission = 'granted'
  static requestPermission = async () => 'granted'
  constructor(title, options) {
    this.title = title
    this.options = options ?? {}
    this.closed = false
    FakeNotification.instances.push(this)
  }
  close() {
    this.closed = true
  }
}
FakeNotification.instances = []

globalThis.Notification = FakeNotification

globalThis.localStorage = {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
  setItem(key, value) { this.store.set(key, value) },
}

globalThis.document = {
  visibilityState: 'visible',
  hasFocus: () => false,
  addEventListener() {},
  removeEventListener() {},
}

globalThis.window = {
  location: { href: 'http://127.0.0.1:51778/' },
  focus() {},
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
}

const polled = []
globalThis.fetch = (url) => {
  polled.push(url)
  if (polled.length === 1) {
    assert.match(url, /since=-1/)
    return Promise.resolve({ ok: true, json: async () => ({ seq: 5, events: [] }) })
  }
  if (polled.length === 2) {
    assert.match(url, /since=5/)
    return Promise.resolve({
      ok: true,
      json: async () => ({
        seq: 6,
        events: [{ seq: 6, kind: 'approval', key: 'approval:ap-1', sessionId: 'session-a', toolName: 'pwsh' }],
      }),
    })
  }
  // Stop the loop: a never-settling poll is a disposed page in practice.
  return new Promise(() => {})
}

// --- load the real client half --------------------------------------------

await import('../client.js')
assert.equal(captured.id, 'dsh-reminding')
assert.equal(typeof captured.factory, 'function')

const moduleExports = captured.factory((name) => {
  assert.equal(name, 'react')
  return fakeReact
})
assert.equal(typeof moduleExports.apply, 'function')

const opened = []
const disposers = []
const registrations = []
const ctx = {
  get(name) {
    if (name === 'sessions') {
      return { list: { getSnapshot: () => ({ byId: { 'session-a': { title: '测试会话' } } }) } }
    }
    if (name === 'uiWorkspace') return { openSession: (id) => opened.push(id) }
    return undefined
  },
  effect(setup) {
    const dispose = setup()
    disposers.push(dispose)
    return dispose
  },
  slots: {
    inject(key, callback) {
      assert.equal(key, 'settings.general.item')
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

moduleExports.apply(ctx)
assert.deepEqual(moduleExports.inject, ['slots'])
assert.equal(registrations.length, 1)
assert.equal(registrations[0].options.id, 'dsh-reminding')
assert.equal(typeof registrations[0].component, 'function')

// Let the scripted poll deliver the approval reminder.
await new Promise((resolve) => setTimeout(resolve, 50))

assert.equal(FakeNotification.instances.length, 1)
const toast = FakeNotification.instances[0]
assert.equal(toast.title, '需要你的授权')
assert.match(toast.options.body, /测试会话/)
assert.match(toast.options.body, /pwsh/)
assert.equal(toast.options.tag, 'approval:ap-1')

// A click must focus the page and open the exact conversation.
toast.onclick()
assert.deepEqual(opened, ['session-a'])
assert.equal(toast.closed, true)
assert.ok(polled.length >= 2)

console.log('client: all assertions passed')
