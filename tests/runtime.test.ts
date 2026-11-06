import { expect, test } from 'bun:test'
import { GlobalWindow } from 'happy-dom'
import { createRuntime } from '../plugin/src/runtime'
import { normalize } from '../plugin/src/usage'
import type { Clock } from '../plugin/src/scheduler'

const usage = () => normalize({ rate_limit: { primary_window: {
  limit_window_seconds: 604800, used_percent: 25, reset_at: 1800000000
} } }, 'renderer-wham')
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
class ClockHarness implements Clock {
  time = 0
  next = 0
  tasks = new Map<number, { at: number; fn: () => void }>()
  now = () => this.time
  set = (fn: () => void, ms: number) => { const id = ++this.next; this.tasks.set(id, { at: this.time + ms, fn }); return id }
  clear = (id: unknown) => { this.tasks.delete(id as number) }
  async advance(ms: number) {
    const end = this.time + ms
    for (;;) {
      await flush()
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.time = due[1].at; this.tasks.delete(due[0]); due[1].fn()
    }
    this.time = end; await flush()
  }
}
function setup() {
  const win = new GlobalWindow(), doc = win.document as unknown as Document
  const clock = new ClockHarness()
  return { win, doc, clock }
}
function trackListeners(target: EventTarget) {
  const add = target.addEventListener, remove = target.removeEventListener
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  target.addEventListener = (type, listener, options) => {
    if (!listener) return
    add.call(target, type, listener, options)
    if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener)
  }
  target.removeEventListener = (type, listener, options) => {
    if (!listener) return
    remove.call(target, type, listener, options)
    listeners.get(type)?.delete(listener)
  }
  return { count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    restore() { target.addEventListener = add; target.removeEventListener = remove } }
}
test.each(['observer', 'popover-listener'] as const)('启动中途%s失败释放已注册资源，并可重新启动', async fault => {
  const s = setup(), windowListeners = trackListeners(s.win as unknown as EventTarget), documentListeners = trackListeners(s.doc)
  const host = s.win as unknown as { MutationObserver: typeof MutationObserver; addEventListener: EventTarget['addEventListener'] }
  const Observer = host.MutationObserver, add = host.addEventListener
  try {
    if (fault === 'observer') host.MutationObserver = class extends Observer { override observe() { throw new Error('test-observe-failure') } }
    else host.addEventListener = (type, listener, options) => {
      if (type === 'keydown') throw new Error('test-listener-failure')
      if (listener) add.call(s.win, type, listener, options)
    }
    expect(() => createRuntime(s.doc, { clock: s.clock, read: async () => usage() })).toThrow()
    host.MutationObserver = Observer; host.addEventListener = add
    await pause(100)
    expect(windowListeners.count()).toBe(0)
    expect(documentListeners.count()).toBe(0)
    expect(s.doc.querySelector('[data-cui-slot],style[data-cui-style],.cui-popover')).toBeNull()
    expect((s.win as unknown as { __codexUsageIndicatorRuntime?: unknown }).__codexUsageIndicatorRuntime).toBeUndefined()
    expect(s.clock.tasks.size).toBe(0)
    const recovered = createRuntime(s.doc, { clock: s.clock, read: async () => usage() })
    await flush()
    expect(recovered.inspect()).toMatchObject({ active: true, status: 'ready' })
    recovered.stop()
    expect(windowListeners.count() + documentListeners.count()).toBe(0)
  } finally {
    host.MutationObserver = Observer; host.addEventListener = add
    windowListeners.restore(); documentListeners.restore(); s.win.close()
  }
})
test('运行时单例替换与重复stop清除计时器、样式和页面监听', async () => {
  const s = setup()
  try {
    const first = createRuntime(s.doc, { read: async () => usage(), clock: s.clock })
    await flush()
    expect(first.inspect()).toMatchObject({ active: true, requests: 1, status: 'ready', coverage: 'weekly-only' })
    const second = createRuntime(s.doc, { read: async () => usage(), clock: s.clock })
    await flush()
    expect(first.inspect().active).toBe(false)
    expect(s.doc.querySelectorAll('style[data-cui-style]').length).toBe(1)
    await s.clock.advance(30_000)
    expect(first.inspect().requests).toBe(1)
    expect(second.inspect().requests).toBe(2)
    second.stop(); second.stop()
    s.win.dispatchEvent(new s.win.Event('online'))
    s.win.dispatchEvent(new s.win.Event('focus'))
    await pause(260)
    expect(second.inspect().requests).toBe(2)
    expect(s.clock.tasks.size).toBe(0)
    expect(s.doc.querySelector('[data-cui-slot],style[data-cui-style],.cui-popover')).toBeNull()
  } finally { s.win.close() }
})
test('停用立即中止请求，迟到响应不重建UI或污染新实例', async () => {
  const s = setup()
  let resolve!: (value: ReturnType<typeof usage>) => void, signal!: AbortSignal
  try {
    const old = createRuntime(s.doc, { clock: s.clock, read: abort => {
      signal = abort; return new Promise(r => { resolve = r })
    } })
    await flush(); old.stop()
    expect(signal.aborted).toBe(true)
    const next = createRuntime(s.doc, { clock: s.clock, read: async () => usage() })
    await flush(); resolve(usage()); await flush()
    expect(old.inspect()).toMatchObject({ active: false, status: 'unavailable' })
    expect(next.inspect()).toMatchObject({ active: true, requests: 1, status: 'ready' })
    expect(s.doc.querySelectorAll('style[data-cui-style]').length).toBe(1)
    next.stop()
  } finally { s.win.close() }
})
test('连续前台事件保留已有数据并合并请求；pagehide释放资源', async () => {
  const s = setup()
  try {
    const runtime = createRuntime(s.doc, { clock: s.clock, read: async () => usage() })
    await flush(); await s.clock.advance(1000)
    for (let i = 0; i < 5; i++) s.win.dispatchEvent(new s.win.Event('focus'))
    expect(runtime.inspect()).toMatchObject({ status: 'ready', coverage: 'weekly-only' })
    await pause(260); await flush()
    expect(runtime.inspect()).toMatchObject({ requests: 2, status: 'ready' })
    s.win.dispatchEvent(new s.win.Event('pagehide'))
    expect(runtime.inspect().active).toBe(false)
    expect(s.clock.tasks.size).toBe(0)
  } finally { s.win.close() }
})
test('输入框和按钮获得焦点不会被误判为窗口回到前台', async () => {
  const s = setup()
  try {
    s.doc.body.innerHTML = '<textarea></textarea><button>native control</button>'
    const runtime = createRuntime(s.doc, { clock: s.clock, read: async () => usage() })
    await flush(); await s.clock.advance(1000)
    s.doc.querySelector('textarea')!.focus(); s.doc.querySelector('button')!.focus()
    await pause(260); await flush()
    expect(runtime.inspect()).toMatchObject({ requests: 1, status: 'ready', coverage: 'weekly-only' })
    runtime.stop()
  } finally { s.win.close() }
})
test('前台刷新挂起及失败时保留同账号快照，重复focus不取消请求', async () => {
  const s = setup()
  let calls = 0, reject!: (error: Error) => void, signal!: AbortSignal
  try {
    const runtime = createRuntime(s.doc, { clock: s.clock, read: abort => {
      calls++
      if (calls === 1) return Promise.resolve(usage())
      signal = abort; return new Promise((_, fail) => { reject = fail })
    } })
    await flush(); await s.clock.advance(1000)
    s.win.dispatchEvent(new s.win.Event('focus')); await pause(260); await flush()
    expect(runtime.inspect()).toMatchObject({ requests: 2, status: 'ready', coverage: 'weekly-only' })
    s.win.dispatchEvent(new s.win.Event('focus')); await pause(260)
    expect(signal.aborted).toBe(false)
    expect(runtime.inspect().requests).toBe(2)
    reject(new Error('offline')); await flush()
    expect(runtime.inspect()).toMatchObject({ status: 'ready', coverage: 'weekly-only' })
    runtime.stop()
  } finally { s.win.close() }
})
test('原生账号菜单活动仍立即清空并暂停，前台恢复重新读取', async () => {
  const s = setup()
  try {
    s.doc.body.innerHTML = '<nav data-app-navigation-rail><div></div><div><button aria-haspopup="menu" aria-label="profile"></button></div></nav>'
    for (const child of s.doc.querySelector('nav')!.children) child.getBoundingClientRect = () => ({ width: 40 }) as DOMRect
    const runtime = createRuntime(s.doc, { clock: s.clock, read: async () => usage() })
    await flush()
    s.doc.querySelector('button')!.dispatchEvent(new s.win.PointerEvent('pointerdown', { bubbles: true }) as unknown as PointerEvent)
    expect(runtime.inspect()).toMatchObject({ status: 'unavailable', coverage: 'none' })
    await s.clock.advance(30_000)
    expect(runtime.inspect().requests).toBe(1)
    s.win.dispatchEvent(new s.win.Event('focus')); await pause(260); await flush()
    expect(runtime.inspect()).toMatchObject({ requests: 2, status: 'ready', coverage: 'weekly-only' })
    runtime.stop()
  } finally { s.win.close() }
})
test('缺少锚点时不占位，普通消息更新不扫描，窗口变化重新检查', async () => {
  const s = setup()
  try {
    const runtime = createRuntime(s.doc, { clock: s.clock, read: async () => usage() })
    await pause(90)
    const before = runtime.inspect().ui!.scans
    s.doc.body.append(s.doc.createElement('article'))
    await pause(90)
    expect(runtime.inspect().ui!.scans).toBe(before)
    expect(runtime.inspect().ui!.slots).toBe(0)
    s.win.dispatchEvent(new s.win.Event('resize'))
    await pause(90)
    expect(runtime.inspect().ui!.scans).toBeGreaterThan(before)
    expect(runtime.inspect().ui!.slots).toBe(0)
    runtime.stop()
  } finally { s.win.close() }
})
