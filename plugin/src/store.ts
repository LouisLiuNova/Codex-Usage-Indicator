import type { NormalizedUsage, Source, UsageWindow } from './usage'

export interface UsageSnapshot {
  status: 'ready' | 'stale' | 'unavailable' | 'unauthorized'
  connection: 'connecting' | 'connected' | 'disconnected'
  quality: 'normal' | 'degraded'
  coverage: NormalizedUsage['coverage']
  fiveHour: Readonly<UsageWindow> | null
  weekly: Readonly<UsageWindow> | null
  fetchedAt: number | null
  source: Source
}
export class UsageStore {
  private value: Readonly<UsageSnapshot>
  private listeners = new Set<(snapshot: Readonly<UsageSnapshot>) => void>()
  private generation = 0
  constructor(private source: Source = 'renderer-wham') { this.value = this.empty('disconnected') }
  private empty(connection: UsageSnapshot['connection']): Readonly<UsageSnapshot> {
    return Object.freeze({ status: 'unavailable', connection, quality: 'normal', coverage: 'none',
      fiveHour: null, weekly: null, fetchedAt: null, source: this.source })
  }
  get snapshot() { return this.value }
  get revision() { return this.generation }
  private publish(next: Readonly<UsageSnapshot>) {
    this.value = Object.freeze(next)
    for (const listener of [...this.listeners]) {
      try { listener(this.value) } catch { /* one view cannot break scheduling or other views */ }
    }
  }
  subscribe(listener: (snapshot: Readonly<UsageSnapshot>) => void) {
    this.listeners.add(listener)
    try { listener(this.value) } catch { /* same isolation for initial delivery */ }
    return () => { this.listeners.delete(listener) }
  }
  reset(connection: UsageSnapshot['connection'] = 'connecting') {
    this.generation++
    this.publish(this.empty(connection))
    return this.generation
  }
  accept(revision: number, usage: NormalizedUsage, nowSeconds: number) {
    if (revision !== this.generation || usage.source !== this.source) return false
    const copy = (window: UsageWindow | null) => window ? Object.freeze({ ...window }) : null
    // An accepted response replaces every field; absent windows never survive from an older sample.
    this.publish({ status: usage.coverage === 'none' ? 'unavailable' : 'ready', connection: 'connected',
      quality: usage.quality, coverage: usage.coverage, fiveHour: copy(usage.fiveHour), weekly: copy(usage.weekly),
      fetchedAt: usage.coverage === 'none' ? null : nowSeconds, source: usage.source })
    return true
  }
  fail(revision: number, unauthorized: boolean, nowSeconds: number) {
    if (revision !== this.generation) return
    this.publish({ ...this.value, connection: 'disconnected',
      status: unauthorized ? 'unauthorized' : this.value.fetchedAt === null ? 'unavailable'
        : nowSeconds - this.value.fetchedAt >= 90 ? 'stale' : 'ready' })
  }
  age(nowSeconds: number) {
    if (this.value.fetchedAt !== null && nowSeconds - this.value.fetchedAt >= 90 && this.value.status === 'ready')
      this.publish({ ...this.value, status: 'stale' })
  }
}
