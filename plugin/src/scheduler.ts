import { UsageStore } from './store'
import type { NormalizedUsage } from './usage'

export interface Clock {
  now(): number // milliseconds
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}
const systemClock: Clock = { now: Date.now, set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }
export class UsageRequestError extends Error {
  constructor(readonly status: number | null = null, readonly retryAfterMs: number | null = null) { super('usage-request') }
}
export type UsageProvider = (signal: AbortSignal) => Promise<NormalizedUsage>

export class RefreshScheduler {
  private active = false
  private flight: { promise: Promise<void>; cancel: () => void } | undefined
  private poll: unknown
  private stale: unknown
  private failures = 0
  private notBefore = 0
  private lastStarted = -Infinity
  constructor(readonly store: UsageStore, private provider: UsageProvider, private clock: Clock = systemClock,
    private timeoutMs = 10_000) {}
  private cancelTimers() {
    if (this.poll !== undefined) this.clock.clear(this.poll)
    if (this.stale !== undefined) this.clock.clear(this.stale)
    this.poll = this.stale = undefined
  }
  start() {
    if (this.active) return this.flight?.promise ?? Promise.resolve()
    this.active = true
    this.store.reset()
    return this.refresh()
  }
  stop() {
    this.active = false
    this.store.reset('disconnected') // invalidates every pending revision before cancellation
    this.flight?.cancel()
    this.flight = undefined
    this.cancelTimers()
  }
  changeContext() {
    this.store.reset(this.active ? 'connecting' : 'disconnected')
    this.flight?.cancel()
    this.flight = undefined
    this.cancelTimers()
    this.failures = 0
    this.lastStarted = -Infinity
    return this.active ? this.refresh() : Promise.resolve()
  }
  // Focus, visibility, online and verified notifications use the same merged entry.
  refresh(): Promise<void> {
    this.store.age(this.clock.now() / 1000)
    if (!this.active) return Promise.resolve()
    if (this.flight) return this.flight.promise
    const now = this.clock.now()
    const allowed = Math.max(this.notBefore, this.lastStarted + 250)
    if (now < allowed) { this.plan(allowed - now); return Promise.resolve() }
    if (this.poll !== undefined) { this.clock.clear(this.poll); this.poll = undefined }
    this.lastStarted = now
    const revision = this.store.revision
    const abort = new AbortController()
    let cancel!: () => void
    let timeout: unknown
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => { abort.abort(); reject(new UsageRequestError()) }
      timeout = this.clock.set(cancel, this.timeoutMs)
    })
    const current = { promise: Promise.resolve(), cancel }
    this.flight = current
    current.promise = (async () => {
      try {
        const usage = await Promise.race([Promise.resolve().then(() => {
          if (abort.signal.aborted) throw new UsageRequestError()
          return this.provider(abort.signal)
        }), cancelled])
        if (!this.active || revision !== this.store.revision) return
        if (this.store.accept(revision, usage, this.clock.now() / 1000)) {
          this.failures = 0
          this.notBefore = 0
          this.armStale()
        }
      } catch (error) {
        if (!this.active || revision !== this.store.revision) return
        this.failures++
        const failure = error instanceof UsageRequestError ? error : new UsageRequestError()
        this.store.fail(revision, failure.status === 401 || failure.status === 403, this.clock.now() / 1000)
        const delay = Math.min(300_000, 30_000 * 2 ** Math.min(this.failures - 1, 4))
        const retry = failure.status === 429 && failure.retryAfterMs !== null && Number.isFinite(failure.retryAfterMs)
          ? Math.max(0, failure.retryAfterMs) : 0
        this.notBefore = this.clock.now() + Math.max(delay, retry)
      } finally {
        this.clock.clear(timeout)
        if (this.flight === current) {
          this.flight = undefined
          if (this.active) this.plan(Math.max(30_000, this.notBefore - this.clock.now()))
        }
      }
    })()
    return current.promise
  }
  private plan(ms: number) {
    if (this.poll !== undefined) this.clock.clear(this.poll)
    // Browser timer delays above the signed int limit wrap; retain notBefore across bounded wakeups.
    this.poll = this.clock.set(() => { this.poll = undefined; void this.refresh() }, Math.min(ms, 2_147_483_647))
  }
  private armStale() {
    if (this.stale !== undefined) this.clock.clear(this.stale)
    this.stale = undefined
    const fetchedAt = this.store.snapshot.fetchedAt
    if (fetchedAt === null) return
    this.stale = this.clock.set(() => {
      this.stale = undefined
      if (this.active) this.store.age(this.clock.now() / 1000)
    }, Math.max(0, fetchedAt * 1000 + 90_000 - this.clock.now()))
  }
}
