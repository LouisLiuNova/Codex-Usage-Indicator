import { autoUpdate, computePosition, flip, offset, shift, type Placement } from '@floating-ui/dom'
import { UsageStore } from './store'
import { connectionLabel, displayPercent, formatTime, names, warning } from './presentation'

export type PopoverMode = 'closed' | 'transient' | 'pinned'
export type Positioner = (button: HTMLButtonElement, panel: HTMLElement, dismiss: () => void) => () => void
const intersects = (a: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, b: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

/** Floating UI owns generic positioning. Critical native controls remain exclusion zones. */
export const positionPopover: Positioner = (button, panel, dismiss) => {
  let stopped = false, revision = 0
  const update = async () => {
    const current = ++revision
    const doc = panel.ownerDocument, view = doc.defaultView!
    try {
      // Composer entries sit below the native input. Anchor the card outside that entire native region.
      const composers = button.closest('[data-cui-view="composer"]')
        ? [...doc.querySelectorAll<HTMLElement>('[data-codex-composer-root]')].filter(node => node.getBoundingClientRect().width > 0) : []
      const reference = composers.length === 1
        ? { contextElement: button, getBoundingClientRect: () => composers[0]!.getBoundingClientRect() } : button
      for (const placement of ['top', 'right', 'left', 'bottom'] as Placement[]) {
        const position = await computePosition(reference, panel, { strategy: 'fixed', placement,
          middleware: [offset(10), flip({ padding: 8 }), shift({ padding: 8 })] })
        if (stopped || revision !== current) return
        const rect = { left: position.x, top: position.y, right: position.x + panel.offsetWidth, bottom: position.y + panel.offsetHeight }
        const blocked = [...doc.querySelectorAll<HTMLElement>('[data-codex-composer-root],[role="menu"],[aria-modal="true"]')]
          .filter(node => node !== panel && !panel.contains(node)).some(node => {
            const r = node.getBoundingClientRect()
            return r.width > 0 && r.height > 0 && intersects(rect, r)
          })
        if (!blocked && rect.left >= 0 && rect.top >= 0 && rect.right <= view.innerWidth && rect.bottom <= view.innerHeight) {
          Object.assign(panel.style, { left: `${position.x}px`, top: `${position.y}px`, visibility: 'visible' })
          return
        }
      }
      if (!stopped && revision === current) dismiss()
    } catch { if (!stopped && revision === current) dismiss() }
  }
  const cleanup = autoUpdate(button, panel, () => { void update() })
  return () => { stopped = true; revision++; cleanup() }
}

let nextId = 0
export class SharedPopover {
  readonly panel: HTMLDivElement
  private body: HTMLDivElement
  private anchor: HTMLButtonElement | null = null
  private mode: PopoverMode = 'closed'
  private closeTimer: ReturnType<typeof setTimeout> | undefined
  private stopPosition: (() => void) | undefined
  private unsubscribe: () => void
  private stopped = false
  private triggers = new Set<HTMLButtonElement>()
  private bindings = new Map<HTMLButtonElement, () => void>()
  private closeButton: HTMLButtonElement
  constructor(private doc: Document, private store: UsageStore, private position: Positioner = positionPopover) {
    this.panel = doc.createElement('div')
    this.panel.className = 'cui-popover'; this.panel.id = `cui-popover-${++nextId}`
    this.panel.setAttribute('role', 'dialog'); this.panel.setAttribute('aria-label', '用量详情')
    const header = doc.createElement('header'), title = doc.createElement('h2')
    title.textContent = '用量详情'
    this.closeButton = doc.createElement('button'); this.closeButton.type = 'button'
    this.closeButton.className = 'cui-close'; this.closeButton.textContent = '×'
    this.closeButton.setAttribute('aria-label', '关闭用量详情')
    this.closeButton.addEventListener('click', this.closeReturningFocus)
    header.append(title, this.closeButton)
    this.body = doc.createElement('div'); this.panel.append(header, this.body)
    this.panel.addEventListener('pointerenter', this.cancelClose)
    this.panel.addEventListener('pointerleave', this.queueClose)
    this.panel.addEventListener('focusout', this.queueClose)
    this.doc.addEventListener('pointerdown', this.outside, true)
    this.doc.defaultView!.addEventListener('keydown', this.keydown, true)
    this.unsubscribe = store.subscribe(() => this.render())
  }
  get state() { return this.mode }
  private cancelClose = () => { if (this.closeTimer !== undefined) clearTimeout(this.closeTimer); this.closeTimer = undefined }
  private queueClose = () => {
    this.cancelClose()
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined
      if (this.mode === 'transient' && !this.panel.contains(this.doc.activeElement) && this.doc.activeElement !== this.anchor) this.close()
    }, 160)
  }
  private closeReturningFocus = () => this.close(true)
  private outside = (event: Event) => {
    if (this.mode === 'closed') return
    const target = event.target as Node | null
    if (target && !this.panel.contains(target) && ![...this.triggers].some(trigger => trigger.contains(target))) this.close()
  }
  private keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.mode !== 'closed') { event.preventDefault(); event.stopPropagation(); this.close(true) }
  }
  bind(button: HTMLButtonElement): () => void {
    this.bindings.get(button)?.()
    this.triggers.add(button)
    button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false')
    button.setAttribute('aria-controls', this.panel.id)
    const preview = () => { if (this.mode !== 'pinned') this.show(button, 'transient') }
    const click = () => { if (this.anchor === button && this.mode === 'pinned') this.close(); else this.show(button, 'pinned') }
    button.addEventListener('pointerenter', preview); button.addEventListener('focus', preview)
    button.addEventListener('pointerleave', this.queueClose); button.addEventListener('blur', this.queueClose)
    button.addEventListener('click', click)
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      if (this.anchor === button) this.close(this.panel.contains(this.doc.activeElement))
      this.triggers.delete(button)
      button.removeEventListener('pointerenter', preview); button.removeEventListener('focus', preview)
      button.removeEventListener('pointerleave', this.queueClose); button.removeEventListener('blur', this.queueClose)
      button.removeEventListener('click', click)
      button.removeAttribute('aria-controls'); button.removeAttribute('aria-haspopup'); button.removeAttribute('aria-expanded')
      this.bindings.delete(button)
    }
    this.bindings.set(button, dispose)
    return dispose
  }
  private show(button: HTMLButtonElement, mode: Exclude<PopoverMode, 'closed'>) {
    if (this.stopped || !button.isConnected) return
    this.cancelClose()
    const changed = this.anchor !== button || this.mode === 'closed'
    this.anchor?.setAttribute('aria-expanded', 'false')
    this.anchor = button; this.mode = mode
    button.setAttribute('aria-expanded', 'true')
    if (!this.panel.isConnected) this.doc.body.append(this.panel)
    this.render()
    if (changed) {
      this.stopPosition?.(); this.stopPosition = undefined
      this.panel.style.visibility = 'hidden'
      const cleanup = this.position(button, this.panel, () => this.close())
      if (!this.panel.isConnected) cleanup()
      else this.stopPosition = cleanup
    }
  }
  close(returnFocus = false) {
    this.cancelClose()
    const anchor = this.anchor
    this.mode = 'closed'; this.anchor = null
    this.stopPosition?.(); this.stopPosition = undefined
    anchor?.setAttribute('aria-expanded', 'false')
    this.panel.remove()
    // Focus can trigger preview again; suppress it while restoring the trigger.
    if (returnFocus && anchor?.isConnected) {
      const stopped = this.stopped; this.stopped = true
      anchor.focus(); this.stopped = stopped
    }
  }
  private render() {
    const snapshot = this.store.snapshot
    this.body.replaceChildren()
    const line = (parent: HTMLElement, text: string, muted = false) => {
      const p = this.doc.createElement('p'); p.textContent = text
      if (muted) p.className = 'cui-muted'
      parent.append(p)
    }
    line(this.body, connectionLabel(snapshot))
    for (const kind of ['fiveHour', 'weekly'] as const) {
      const window = snapshot[kind]
      if (!window) continue
      const section = this.doc.createElement('section'), title = this.doc.createElement('h3')
      section.dataset.cuiDetail = kind; title.textContent = names[kind]
      section.append(title); this.body.append(section)
      line(section, `剩余 ${displayPercent(window.remainingPercent)}${warning(window.remainingPercent) ? ` · ${warning(window.remainingPercent)}` : ''}`)
      line(section, `重置于 ${formatTime(window.resetsAt)}`, true)
    }
    line(this.body, `更新于 ${formatTime(snapshot.fetchedAt)}`, true)
    line(this.body, '每 30 秒采样；连接异常时退避重试', true)
  }
  stop() {
    if (this.stopped) return
    this.stopped = true; this.close(); this.unsubscribe()
    for (const dispose of [...this.bindings.values()]) dispose()
    this.doc.removeEventListener('pointerdown', this.outside, true); this.doc.defaultView!.removeEventListener('keydown', this.keydown, true)
    this.closeButton.removeEventListener('click', this.closeReturningFocus)
    this.panel.removeEventListener('pointerenter', this.cancelClose); this.panel.removeEventListener('pointerleave', this.queueClose)
    this.panel.removeEventListener('focusout', this.queueClose)
    this.triggers.clear()
  }
}
