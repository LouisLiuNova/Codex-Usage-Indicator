import { expect, test } from 'bun:test'
import { normalize } from '../plugin/src/usage'
import { UsageStore } from '../plugin/src/store'
import { RefreshScheduler, UsageRequestError, type Clock } from '../plugin/src/scheduler'

const usage = (weeklyOnly = true) => normalize({ rate_limit: {
  primary_window: { limit_window_seconds: 604800, used_percent: 25, reset_at: 1800000000 },
  secondary_window: weeklyOnly ? null : { limit_window_seconds: 18000, used_percent: 10, reset_at: 1800000000 }
} }, 'renderer-wham')
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
class FakeClock implements Clock {
  time = 0
  next = 0
  tasks = new Map<number, { at: number; fn: () => void }>()
  now = () => this.time
  set = (fn: () => void, ms: number) => { const id = ++this.next; this.tasks.set(id, { at: this.time + ms, fn }); return id }
  clear = (id: unknown) => { this.tasks.delete(id as number) }
  async advance(ms: number) {
    const end = this.time + ms
    await flush()
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.time = due[1].at; this.tasks.delete(due[0]); due[1].fn(); await flush()
    }
    this.time = end; await flush()
  }
}
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
test('Weekly-only 为 ready/connected/normal，完整快照替换且不可修改', () => {
  const store = new UsageStore()
  const revision = store.reset()
  store.accept(revision, usage(false), 1)
  store.accept(revision, usage(), 2)
  expect(store.snapshot).toMatchObject({ status: 'ready', connection: 'connected', quality: 'normal', coverage: 'weekly-only', fiveHour: null, fetchedAt: 2 })
  expect(Object.isFrozen(store.snapshot.weekly)).toBe(true)
  store.accept(revision, normalize({ rate_limit: {} }, 'renderer-wham'), 3)
  expect(store.snapshot).toMatchObject({ status: 'unavailable', coverage: 'none', weekly: null, fetchedAt: null })
})
test('错误保留同账号快照、独立老化、切换立即清空且旧响应拒绝', () => {
  const store = new UsageStore()
  const revision = store.reset()
  store.accept(revision, usage(), 1)
  store.fail(revision, false, 2)
  expect(store.snapshot).toMatchObject({ status: 'ready', connection: 'disconnected', fetchedAt: 1 })
  store.age(90)
  expect(store.snapshot.status).toBe('ready')
  store.age(91)
  expect(store.snapshot.status).toBe('stale')
  store.reset()
  expect(store.snapshot.weekly).toBeNull()
  expect(store.accept(revision, usage(false), 100)).toBe(false)
})
test('订阅异常隔离与取消订阅', () => {
  const store = new UsageStore()
  let calls = 0
  store.subscribe(() => { throw new Error('view') })
  const off = store.subscribe(() => { calls++ })
  store.reset(); off(); store.reset()
  expect(calls).toBe(2)
})
test('初始刷新、事件合并、250ms 事件防抖及30秒单定时器', async () => {
  const clock = new FakeClock(), store = new UsageStore()
  let calls = 0
  const scheduler = new RefreshScheduler(store, async () => { calls++; return usage() }, clock)
  const first = scheduler.start()
  expect(scheduler.refresh()).toBe(first)
  await first
  await scheduler.refresh(); await scheduler.refresh()
  expect(calls).toBe(1)
  await clock.advance(250)
  expect(calls).toBe(2)
  await clock.advance(30_000)
  expect(calls).toBe(3)
  expect(clock.tasks.size).toBe(2) // one poll and one freshness timer
  scheduler.stop()
  expect(clock.tasks.size).toBe(0)
})
test('挂起请求超时并释放单飞；stop 后迟到响应不回写', async () => {
  const clock = new FakeClock(), store = new UsageStore(), delayed = deferred<ReturnType<typeof usage>>()
  let signal: AbortSignal | undefined
  const scheduler = new RefreshScheduler(store, s => { signal = s; return delayed.promise }, clock)
  void scheduler.start(); await flush()
  await clock.advance(10_000)
  expect(signal?.aborted).toBe(true)
  expect(store.snapshot.connection).toBe('disconnected')
  scheduler.stop()
  delayed.resolve(usage()); await flush()
  expect(store.snapshot.weekly).toBeNull()
  expect(clock.tasks.size).toBe(0)
})
test('账号切换后保证读取新上下文，旧请求结果不能覆盖', async () => {
  const clock = new FakeClock(), store = new UsageStore(), old = deferred<ReturnType<typeof usage>>()
  let calls = 0
  const scheduler = new RefreshScheduler(store, () => ++calls === 1 ? old.promise : Promise.resolve(usage()), clock)
  void scheduler.start(); await flush()
  await scheduler.changeContext()
  expect(calls).toBe(2)
  old.resolve(usage(false)); await flush()
  expect(store.snapshot.coverage).toBe('weekly-only')
  scheduler.stop()
})
test('90秒新鲜度独立于挂起网络请求', async () => {
  const clock = new FakeClock(), store = new UsageStore()
  let calls = 0
  const scheduler = new RefreshScheduler(store, () => ++calls === 1 ? Promise.resolve(usage()) : new Promise(() => {}), clock, 200_000)
  await scheduler.start()
  await clock.advance(89_999)
  expect(store.snapshot.status).toBe('ready')
  await clock.advance(1)
  expect(store.snapshot.status).toBe('stale')
  expect(calls).toBe(2)
  scheduler.stop(); await flush()
})
test('429 Retry-After 不被前台事件、账号切换或重新启停绕过', async () => {
  const clock = new FakeClock(), store = new UsageStore()
  let calls = 0
  const scheduler = new RefreshScheduler(store, async () => { calls++; throw new UsageRequestError(429, 120_000) }, clock)
  await scheduler.start()
  await clock.advance(30_000)
  await scheduler.refresh(); await scheduler.changeContext()
  scheduler.stop(); await scheduler.start()
  expect(calls).toBe(1)
  await clock.advance(89_999)
  expect(calls).toBe(1)
  await clock.advance(1)
  expect(calls).toBe(2)
  scheduler.stop()
})
test('持续错误退避上限5分钟，401/403独立状态', async () => {
  const clock = new FakeClock(), store = new UsageStore()
  let calls = 0
  const starts: number[] = []
  const scheduler = new RefreshScheduler(store, async () => { starts.push(clock.now()); calls++; throw new UsageRequestError(403) }, clock)
  await scheduler.start()
  expect(store.snapshot.status).toBe('unauthorized')
  await clock.advance(30_000 + 60_000 + 120_000 + 240_000 + 300_000 + 300_000)
  expect(calls).toBe(7)
  expect(starts.slice(-3)).toEqual([450_000, 750_000, 1_050_000])
  scheduler.stop()
})
test('休眠恢复立即重算年龄且启动停止可重复', async () => {
  const clock = new FakeClock(), store = new UsageStore()
  const delayed = deferred<ReturnType<typeof usage>>()
  let calls = 0
  const scheduler = new RefreshScheduler(store, () => ++calls === 1 ? Promise.resolve(usage()) : delayed.promise, clock)
  await scheduler.start()
  clock.time = 200_000 // OS sleep: no scheduled callbacks ran
  const request = scheduler.refresh()
  expect(store.snapshot.status).toBe('stale')
  scheduler.stop(); await request
  expect(clock.tasks.size).toBe(0)
  const restart = scheduler.start()
  await clock.advance(250)
  delayed.resolve(usage()); await restart; await flush()
  expect(store.snapshot.status).toBe('ready')
  scheduler.stop()
})
