import { describe, expect, test } from 'bun:test'
import { normalize, sample } from '../plugin/src/usage'

const w = (duration: unknown, used: unknown = 25, reset: unknown = 1_800_000_000) =>
  ({ limit_window_seconds: duration, used_percent: used, reset_at: reset })
const wham = (primary: unknown, secondary: unknown = null) =>
  ({ plan_type: 'pro', rate_limit: { primary_window: primary, secondary_window: secondary } })

describe('严格窗口契约', () => {
  test.each([[18_000, 604_800, 'both'], [604_800, 18_000, 'both'], [604_800, null, 'weekly-only'],
    [18_000, null, 'five-hour-only'], [3600, null, 'none']] as const)('%p / %p → %s', (a, b, coverage) => {
    expect(normalize(wham(w(a), b ? w(b) : null), 'renderer-wham').coverage).toBe(coverage)
  })
  test('仅 Weekly 正常，不由 pro 套餐删除真实 5H', () => {
    expect(normalize(wham(w(604_800)), 'renderer-wham').quality).toBe('normal')
    expect(normalize(wham(w(18_000)), 'renderer-wham').fiveHour?.remainingPercent).toBe(75)
  })
  test.each([null, undefined, '', '25', false, NaN, Infinity, -Infinity])('不强制转换百分比 %p', used => {
    const result = normalize(wham({ ...w(604_800), used_percent: used }), 'renderer-wham')
    expect(result.weekly?.remainingPercent).toBeNull()
    expect(result.diagnostics).toContain('percent')
  })
  test.each([[0, 100], [100, 0], [-1, 100], [101, 0], [49.5, 50.5]])('百分比 %p → %p', (used, remaining) => {
    expect(normalize(wham(w(604_800, used)), 'renderer-wham').weekly?.remainingPercent).toBe(remaining)
  })
  test.each([null, undefined, '', '18000', false, NaN, Infinity, 17_999, 604_799])('不推测时长 %p', duration => {
    expect(normalize(wham(w(duration)), 'renderer-wham').coverage).toBe('none')
  })
  test.each([null, '', false, -1, 1.1, Infinity, 8_640_000_000_001])('重置时间 %p 保留未知', reset => {
    expect(normalize(wham(w(604_800, 25, reset)), 'renderer-wham').weekly?.resetsAt).toBeNull()
  })
  test('过去时间不重置额度', () => {
    expect(normalize(wham(w(604_800, 25, 0)), 'renderer-wham').weekly).toEqual({ remainingPercent: 75, resetsAt: 0 })
  })
  test('重复周期不任取一个', () => {
    const result = normalize(wham(w(604_800), w(604_800, 50)), 'renderer-wham')
    expect(result.weekly).toBeNull()
    expect(result.diagnostics).toContain('ambiguity')
  })
  test('不从 additional_rate_limits 补齐，不保留上次窗口', () => {
    normalize(wham(w(18_000), w(604_800)), 'renderer-wham')
    const result = normalize({ ...wham(null), additional_rate_limits: [wham(w(18_000), w(604_800))] }, 'renderer-wham')
    expect(result.coverage).toBe('none')
  })
  test.each([null, [], false, 3, {}, { rate_limit: [] }].map(raw => [raw]))('结构异常 %p', raw => {
    expect(normalize(raw, 'renderer-wham').diagnostics).toContain('schema')
  })
  test('App Server 仅选 codex 池，不拼接兼容视图', () => {
    const result = normalize({ rateLimitsByLimitId: { codex: { primary: { windowDurationMins: 10080, usedPercent: 10, resetsAt: 0 } },
      other: { primary: { windowDurationMins: 300, usedPercent: 50 } } }, rateLimits: { limitId: 'codex', primary: { windowDurationMins: 300 } } }, 'app-server')
    expect(result.coverage).toBe('weekly-only')
    expect(result.weekly?.remainingPercent).toBe(90)
  })
  test.each([{ rateLimitsByLimitId: {} }, { rateLimitsByLimitId: [] }, { rateLimits: { primary: { windowDurationMins: 300 } } },
    { rateLimitsByLimitId: { codex: { limitId: 'other' } } }])('不确认归属的主池拒绝 %p', raw => {
    expect(normalize(raw, 'app-server').diagnostics).toContain('pool-unconfirmed')
  })
  test('旧版仅允许明确 codex 兼容视图', () => {
    expect(normalize({ rateLimits: { limitId: 'codex', primary: { windowDurationMins: 300, usedPercent: 10, resetsAt: 0 } } }, 'app-server').coverage).toBe('five-hour-only')
  })
  test('输出仅含白名单字段', () => {
    const output = JSON.stringify(sample({ ...wham(w(604_800)), accountId: 'PRIVATE', token: 'SECRET', nested: { email: 'HIDDEN' } }, 'renderer-wham'))
    for (const secret of ['PRIVATE', 'SECRET', 'HIDDEN', 'accountId', 'token', 'email']) expect(output).not.toContain(secret)
  })
})
