export type Source = 'renderer-wham' | 'app-server'
export interface UsageWindow {
  remainingPercent: number | null
  resetsAt: number | null
}
export interface NormalizedUsage {
  source: Source
  coverage: 'both' | 'five-hour-only' | 'weekly-only' | 'none'
  quality: 'normal' | 'degraded'
  fiveHour: UsageWindow | null
  weekly: UsageWindow | null
  diagnostics: Diagnostic[]
}
export type Diagnostic = 'schema' | 'pool-unconfirmed' | 'duration' | 'ambiguity' | 'percent' | 'reset'
export const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export const unixSeconds = (v: unknown): v is number =>
  finite(v) && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000

// Unknown or absent values stay unknown; no numeric coercion or inferred resets.
export function normalize(raw: unknown, source: Source): NormalizedUsage {
  const diagnostics = new Set<Diagnostic>()
  const problem = (d: Diagnostic) => diagnostics.add(d)
  let pool: Record<string, unknown> | null = null
  if (!record(raw)) problem('schema')
  else if (source === 'renderer-wham') {
    if (record(raw.rate_limit)) pool = raw.rate_limit
    else problem('schema')
  } else if (raw.rateLimitsByLimitId !== undefined && raw.rateLimitsByLimitId !== null) {
    if (record(raw.rateLimitsByLimitId) && record(raw.rateLimitsByLimitId.codex)) {
      pool = raw.rateLimitsByLimitId.codex
      if (pool.limitId != null && pool.limitId !== 'codex') {
        pool = null
        problem('pool-unconfirmed')
      }
    } else problem('pool-unconfirmed')
  } else if (record(raw.rateLimits) && raw.rateLimits.limitId === 'codex') pool = raw.rateLimits
  else problem('pool-unconfirmed')

  const windows: { fiveHour: UsageWindow[]; weekly: UsageWindow[] } = { fiveHour: [], weekly: [] }
  if (pool) {
    const keys = source === 'renderer-wham' ? ['primary_window', 'secondary_window'] : ['primary', 'secondary']
    for (const key of keys) {
      const w = pool[key]
      if (w == null) continue
      if (!record(w)) { problem('schema'); continue }
      const duration = w[source === 'renderer-wham' ? 'limit_window_seconds' : 'windowDurationMins']
      const five = source === 'renderer-wham' ? 18_000 : 300
      const week = source === 'renderer-wham' ? 604_800 : 10_080
      const target = duration === five ? windows.fiveHour : duration === week ? windows.weekly : null
      if (!target) { problem('duration'); continue }
      const used = w[source === 'renderer-wham' ? 'used_percent' : 'usedPercent']
      const reset = w[source === 'renderer-wham' ? 'reset_at' : 'resetsAt']
      if (!finite(used) || used < 0 || used > 100) problem('percent')
      if (!unixSeconds(reset)) problem('reset')
      target.push({ remainingPercent: finite(used) ? Math.min(100, Math.max(0, 100 - used)) : null,
        resetsAt: unixSeconds(reset) ? reset : null })
    }
  }
  const unique = (items: UsageWindow[]) => {
    if (items.length > 1) { problem('ambiguity'); return null }
    return items[0] ?? null
  }
  const fiveHour = unique(windows.fiveHour)
  const weekly = unique(windows.weekly)
  return { source, fiveHour, weekly,
    coverage: fiveHour ? weekly ? 'both' : 'five-hour-only' : weekly ? 'weekly-only' : 'none',
    quality: diagnostics.size ? 'degraded' : 'normal', diagnostics: [...diagnostics] }
}

// Only this projection may leave the probe. Never spread raw account or response objects.
export function sample(raw: unknown, source: Source) {
  const normalized = normalize(raw, source)
  let pool: Record<string, unknown> | null = null
  if (record(raw)) {
    if (source === 'renderer-wham' && record(raw.rate_limit)) pool = raw.rate_limit
    if (source === 'app-server' && record(raw.rateLimitsByLimitId) && record(raw.rateLimitsByLimitId.codex))
      pool = raw.rateLimitsByLimitId.codex
    else if (source === 'app-server' && raw.rateLimitsByLimitId == null && record(raw.rateLimits) && raw.rateLimits.limitId === 'codex')
      pool = raw.rateLimits
  }
  if (normalized.diagnostics.includes('pool-unconfirmed')) pool = null
  const project = (v: unknown) => {
    if (!record(v)) return null
    const [d, u, r] = source === 'renderer-wham'
      ? [v.limit_window_seconds, v.used_percent, v.reset_at]
      : [v.windowDurationMins, v.usedPercent, v.resetsAt]
    return { duration: finite(d) ? d : null, used: finite(u) ? u : null, reset: unixSeconds(r) ? r : null }
  }
  return { normalized, windows: [project(pool?.[source === 'renderer-wham' ? 'primary_window' : 'primary']),
    project(pool?.[source === 'renderer-wham' ? 'secondary_window' : 'secondary'])] }
}
