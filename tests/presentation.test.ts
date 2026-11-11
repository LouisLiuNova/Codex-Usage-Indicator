import { expect, test } from 'bun:test'
import { formatTime, warning, displayPercent, remainingText, usageLevel } from '../plugin/src/presentation'
test.each([[50, ''], [49.9, ''], [30, ''], [29.99, ''], [20, ''], [10, ''], [9.99, '即将用尽'], [0.1, '即将用尽'], [0, '已经用尽'], [null, '额度未知']] as const)('阈值 %p 无小数断档', (value, label) => {
  expect(warning(value)).toBe(label)
})
test('实际为零显示已经用尽，正数和未知保持原有含义', () => {
  expect(remainingText(0)).toBe('已经用尽')
  expect(remainingText(1)).toBe('剩余 1%')
  expect(remainingText(null)).toBe('剩余 —')
})
test('显示百分比与未知值', () => {
  expect(displayPercent(49.9)).toBe('50%')
  expect(displayPercent(null)).toBe('—')
})
test('绝对时间、秒边界、上海/UTC/非整点时区', () => {
  const seconds = Date.parse('2026-11-05T05:04:00Z') / 1000
  expect(formatTime(seconds, 'Asia/Shanghai')).toBe('Nov 5, 2026 · 13:04 · UTC+08:00')
  expect(formatTime(seconds, 'UTC')).toBe('Nov 5, 2026 · 05:04 · UTC+00:00')
  expect(formatTime(seconds, 'Asia/Kathmandu')).toBe('Nov 5, 2026 · 10:49 · UTC+05:45')
  expect(formatTime(null)).toBe('未知')
})
test('纽约夏令时重复小时仍以 offset 区分', () => {
  const before = Date.parse('2026-11-01T05:30:00Z') / 1000
  const after = Date.parse('2026-11-01T06:30:00Z') / 1000
  expect(formatTime(before, 'America/New_York')).toContain('01:30 · UTC-04:00')
  expect(formatTime(after, 'America/New_York')).toContain('01:30 · UTC-05:00')
})
test('本地取得时间保留毫秒精度，显示仍为正常绝对时间', () => {
  const seconds = Date.parse('2026-11-06T10:53:00.487Z') / 1000
  expect(formatTime(seconds, 'Asia/Shanghai')).toBe('Nov 6, 2026 · 18:53 · UTC+08:00')
})
test.each([NaN, Infinity, -Infinity, -0.1, 8_640_000_000_001])('无效时间 %p 仍显示未知', seconds => {
  expect(formatTime(seconds, 'Asia/Shanghai')).toBe('未知')
})

test.each([[100, 'normal'], [30, 'normal'], [29.99, 'low'], [10, 'low'], [9.99, 'critical'], [0, 'critical'], [null, 'normal']] as const)('圆环区间使用原始余量 %p', (value, level) => {
  expect(usageLevel(value)).toBe(level)
})
