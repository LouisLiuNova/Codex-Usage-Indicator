import type { UsageSnapshot } from './store'
import { unixSeconds } from './usage'

export type WindowKind = 'fiveHour' | 'weekly'
export const labels = { fiveHour: '5H', weekly: 'WEEK' } as const
export const names = { fiveHour: '5 小时', weekly: '每周' } as const
export const displayPercent = (value: number | null) => value === null ? '—' : `${Math.round(value)}%`
export const warning = (value: number | null) => value === null ? '额度未知' : value >= 50 ? ''
  : value >= 20 ? '余量偏低' : value >= 10 ? '余量很低' : '即将用尽'
export function formatTime(seconds: number | null, timeZone?: string) {
  if (!unixSeconds(seconds)) return '未知'
  const date = new Date(seconds * 1000)
  const parts = new Intl.DateTimeFormat('en-US', { ...(timeZone ? { timeZone } : {}), year: 'numeric',
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  const zone = get('timeZoneName').replace('GMT', 'UTC')
  return `${get('month')} ${get('day')}, ${get('year')} · ${get('hour')}:${get('minute')} · ${zone === 'UTC' ? 'UTC+00:00' : zone}`
}
export function connectionLabel(snapshot: Readonly<UsageSnapshot>) {
  if (snapshot.status === 'unauthorized') return '需要登录'
  if (snapshot.connection === 'connecting') return '连接中'
  if (snapshot.connection === 'disconnected') return snapshot.status === 'stale' ? '连接中断 · 数据已过期' : '连接中断'
  if (snapshot.status === 'stale') return '数据已过期'
  if (snapshot.status === 'unavailable') return '未取得支持的额度窗口'
  return snapshot.quality === 'degraded' ? '已连接 · 数据异常' : '已连接'
}
