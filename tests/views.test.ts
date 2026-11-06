import { expect, test } from 'bun:test'
import { GlobalWindow } from 'happy-dom'
import { RingView } from '../plugin/src/rings'
import { SharedPopover, type Positioner } from '../plugin/src/popover'
import { UsageStore } from '../plugin/src/store'
import { normalize } from '../plugin/src/usage'
const usage = (both = true) => normalize({ rate_limit: {
  primary_window: { limit_window_seconds: 604800, used_percent: 73, reset_at: 1793929409 },
  secondary_window: both ? { limit_window_seconds: 18000, used_percent: 50.1, reset_at: 1793944482 } : null
} }, 'renderer-wham')
function setup(nativeEscapeHandler = false) {
  const win = new GlobalWindow(), doc = win.document as unknown as Document, store = new UsageStore()
  let started = 0, disposed = 0
  if (nativeEscapeHandler) doc.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopImmediatePropagation() }, true)
  const position: Positioner = (_, panel) => { started++; panel.style.visibility = 'visible'; return () => { disposed++ } }
  const popover = new SharedPopover(doc, store, position)
  const views = (['composer', 'rail'] as const).map(location => new RingView(doc, b => popover.bind(b), location))
  views.forEach(v => doc.body.append(v.root))
  const update = (both = true) => { store.accept(store.revision, usage(both), 1793928351); views.forEach(v => v.update(store.snapshot)) }
  const stop = () => { views.forEach(v => v.stop()); popover.stop(); win.close() }
  return { win, doc, store, popover, views, update, stop, counts: () => ({ started, disposed }) }
}
test('三处 Weekly-only 完全删除5H，并移除旧按钮而非隐藏占位', () => {
  const s = setup(); s.update()
  const five = s.doc.querySelector<HTMLButtonElement>('[data-cui-view=rail] [data-cui-window=fiveHour]')!
  five.click()
  expect(s.doc.querySelectorAll('[data-cui-detail]').length).toBe(2)
  s.update(false)
  expect(five.isConnected).toBe(false)
  expect(s.doc.querySelector('[data-cui-window=fiveHour]')).toBeNull()
  const weekly = s.doc.querySelector<HTMLButtonElement>('[data-cui-view=rail] [data-cui-window=weekly]')!
  weekly.click()
  expect(s.doc.querySelector('[data-cui-detail=fiveHour]')).toBeNull()
  expect(s.doc.querySelector('[data-cui-detail=weekly]')).not.toBeNull()
  expect(s.doc.querySelectorAll('.cui-trigger').length).toBe(1)
  expect(s.store.snapshot).toMatchObject({ status: 'ready', connection: 'connected', quality: 'normal' })
  s.stop()
})
test('数字与侧栏圆环共享舍入口径，告警使用原始阈值', () => {
  const s = setup(); s.update()
  const five = s.doc.querySelector<HTMLButtonElement>('[data-cui-view=rail] [data-cui-window=fiveHour]')!
  expect(five.querySelector('.cui-percent')!.textContent).toBe('50%')
  expect(five.querySelector('.cui-progress')!.getAttribute('stroke-dasharray')).toBe('50 100')
  expect(five.getAttribute('aria-label')).toContain('余量偏低')
  expect(five.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
  s.stop()
})
test('侧栏两个入口共用一张卡片，固定切换与相同入口解除固定', () => {
  const s = setup(); s.update()
  const buttons = [...s.doc.querySelectorAll<HTMLButtonElement>('.cui-trigger')]
  buttons[0]!.click(); expect(s.popover.state).toBe('pinned')
  buttons[1]!.click()
  expect(s.doc.querySelectorAll('.cui-popover').length).toBe(1)
  expect(buttons[0]!.getAttribute('aria-expanded')).toBe('false')
  expect(buttons[1]!.getAttribute('aria-expanded')).toBe('true')
  buttons[1]!.click()
  expect(s.popover.state).toBe('closed')
  expect(s.counts()).toEqual({ started: 2, disposed: 2 })
  s.stop()
})
test('焦点预览、Escape 关闭并返回触发点，outside关闭', () => {
  const s = setup(); s.update()
  const trigger = s.doc.querySelector<HTMLButtonElement>('.cui-trigger')!
  trigger.focus(); expect(s.popover.state).toBe('transient')
  const close = s.popover.panel.querySelector<HTMLButtonElement>('button')!
  close.focus()
  s.doc.dispatchEvent(new s.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as KeyboardEvent)
  expect(s.popover.state).toBe('closed')
  expect(s.doc.activeElement).toBe(trigger)
  trigger.click()
  s.doc.body.dispatchEvent(new s.win.PointerEvent('pointerdown', { bubbles: true }) as unknown as PointerEvent)
  expect(s.popover.state).toBe('closed')
  s.stop()
})
test('百分比未知仍保留真实窗口，缺失reset不推算', () => {
  const s = setup()
  s.store.accept(s.store.revision, normalize({ rate_limit: { primary_window: { limit_window_seconds: 604800, used_percent: null, reset_at: null } } }, 'renderer-wham'), 0)
  s.views.forEach(v => v.update(s.store.snapshot))
  const trigger = s.doc.querySelector<HTMLButtonElement>('.cui-trigger')!
  expect(trigger.getAttribute('aria-label')).toContain('未知')
  expect(s.doc.querySelector('[data-cui-view=composer] .cui-percent')!.textContent).toBe('剩余 未知')
  trigger.click()
  expect(s.popover.panel.textContent).toContain('重置于 未知')
  s.stop()
})
test('Composer 仅显示文字剩余量，圆环仅存在于侧栏', () => {
  const s = setup(); s.update()
  const composer = s.doc.querySelector('[data-cui-view=composer]')!
  expect(composer.querySelector('svg')).toBeNull()
  expect(composer.querySelector('.cui-ring')).toBeNull()
  expect(composer.textContent).toContain('剩余 50%')
  expect(composer.textContent).toContain('剩余 27%')
  expect(s.doc.querySelectorAll('[data-cui-view=rail] svg').length).toBe(2)
  s.update(false)
  expect(composer.textContent).not.toContain('5H')
  expect(composer.querySelectorAll('button').length).toBe(0)
  expect(composer.querySelectorAll('.cui-value').length).toBe(1)
  s.stop()
})
test('Composer为静态文字，不注册详情入口、焦点或原生悬停提示', () => {
  const s = setup(); s.update()
  const composer = s.doc.querySelector<HTMLElement>('[data-cui-view=composer]')!
  expect(composer.querySelector('button,[tabindex],[role=button],[aria-haspopup],[aria-expanded],[aria-controls],[title]')).toBeNull()
  const value = composer.querySelector<HTMLElement>('.cui-value')!
  value.click(); value.focus()
  value.dispatchEvent(new s.win.PointerEvent('pointerenter') as unknown as PointerEvent)
  expect(s.popover.state).toBe('closed')
  expect(s.doc.querySelector('.cui-popover')).toBeNull()
  const rail = s.doc.querySelector<HTMLButtonElement>('[data-cui-view=rail] button')!
  rail.click()
  expect(s.popover.state).toBe('pinned')
  value.click()
  expect(s.popover.state).toBe('pinned')
  expect(s.doc.querySelectorAll('.cui-popover').length).toBe(1)
  s.stop()
})
test('原生 document 捕获处理器不能先吞掉详情卡片 Escape', () => {
  const s = setup(true); s.update()
  const trigger = s.doc.querySelector<HTMLButtonElement>('.cui-trigger')!
  trigger.focus(); trigger.click()
  trigger.dispatchEvent(new s.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as KeyboardEvent)
  expect(s.popover.state).toBe('closed')
  expect(s.doc.activeElement).toBe(trigger)
  s.stop()
})
test('stop 清除展开卡片、定位订阅和入口监听，重复stop幂等', () => {
  const s = setup(); s.update()
  const trigger = s.doc.querySelector<HTMLButtonElement>('.cui-trigger')!
  trigger.click()
  s.popover.stop(); s.popover.stop()
  trigger.click(); trigger.focus()
  expect(s.popover.state).toBe('closed')
  expect(s.counts()).toEqual({ started: 1, disposed: 1 })
  expect(trigger.hasAttribute('aria-expanded')).toBe(false)
  s.stop()
})
test('跨入口间隙进入卡片取消关闭，卡片内有焦点时不随鼠标离开关闭', async () => {
  const s = setup(); s.update()
  const trigger = s.doc.querySelector<HTMLButtonElement>('.cui-trigger')!
  trigger.dispatchEvent(new s.win.PointerEvent('pointerenter') as unknown as PointerEvent)
  trigger.dispatchEvent(new s.win.PointerEvent('pointerleave') as unknown as PointerEvent)
  s.popover.panel.dispatchEvent(new s.win.PointerEvent('pointerenter') as unknown as PointerEvent)
  await new Promise(resolve => setTimeout(resolve, 180))
  expect(s.popover.state).toBe('transient')
  s.popover.panel.querySelector<HTMLButtonElement>('button')!.focus()
  s.popover.panel.dispatchEvent(new s.win.PointerEvent('pointerleave') as unknown as PointerEvent)
  await new Promise(resolve => setTimeout(resolve, 180))
  expect(s.popover.state).toBe('transient')
  s.stop()
})
test('成功取数的毫秒时间正常显示，刷新说明仅保留每30秒刷新', () => {
  const s = setup()
  s.store.accept(s.store.revision, usage(), Date.parse('2026-11-06T10:53:00.487Z') / 1000)
  s.views.forEach(view => view.update(s.store.snapshot))
  s.doc.querySelector<HTMLButtonElement>('[data-cui-view=rail] button')!.click()
  const lines = [...s.popover.panel.querySelectorAll('p')].map(p => p.textContent)
  expect(lines.find(text => text.startsWith('更新于 '))).toMatch(/^更新于 Nov 6, 2026 · \d{2}:\d{2} · UTC[+-]\d{2}:\d{2}$/)
  expect(lines.at(-1)).toBe('每 30 秒刷新')
  expect(s.popover.panel.textContent).not.toMatch(/采样|退避重试/)
  s.stop()
})
test('额度为零时静态文字与详情显示已经用尽，侧栏数字及可访问状态一致', () => {
  const s = setup()
  s.store.accept(s.store.revision, normalize({ rate_limit: {
    primary_window: { limit_window_seconds: 18000, used_percent: 100, reset_at: 1800000000 },
    secondary_window: { limit_window_seconds: 604800, used_percent: 25, reset_at: 1800000000 }
  } }, 'renderer-wham'), 1793928351)
  s.views.forEach(view => view.update(s.store.snapshot))
  const composer = s.doc.querySelector<HTMLElement>('[data-cui-view=composer] [data-cui-window=fiveHour]')!
  const rail = s.doc.querySelector<HTMLButtonElement>('[data-cui-view=rail] [data-cui-window=fiveHour]')!
  expect(composer.textContent).toContain('已经用尽')
  expect(composer.textContent).not.toContain('剩余 0%')
  expect(rail.querySelector('.cui-percent')!.textContent).toBe('0%')
  expect(rail.title).toBe('已经用尽')
  expect(rail.getAttribute('aria-label')).toBe('5 小时额度，已经用尽')
  rail.click()
  const detail = s.doc.querySelector('[data-cui-detail=fiveHour]')!
  expect(detail.textContent).toContain('已经用尽')
  expect(detail.textContent).not.toMatch(/即将用尽|剩余 0%/)
  expect(s.doc.querySelector('[data-cui-detail=weekly]')!.textContent).toContain('剩余 75%')
  s.stop()
})
