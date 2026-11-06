import type { UsageSnapshot } from './store'
import { connectionLabel, displayPercent, labels, names, warning, type WindowKind } from './presentation'

export class RingView {
  readonly root: HTMLDivElement
  private entries = new Map<WindowKind, { button: HTMLButtonElement; percent: HTMLSpanElement; circle: SVGCircleElement | null; dispose: () => void }>()
  private status: HTMLSpanElement
  constructor(private doc: Document, private bind: (button: HTMLButtonElement) => () => void, readonly location: 'composer' | 'rail') {
    this.root = doc.createElement('div')
    this.root.className = `cui-rings cui-${location}`
    this.root.dataset.cuiView = location
    this.status = doc.createElement('span'); this.status.className = 'cui-muted cui-empty'
  }
  get preferredHeight() { return this.location === 'composer' ? 44 : this.entries.size ? this.entries.size * 50 + (this.entries.size - 1) * 8 : 28 }
  get preferredOverlap() { return this.location === 'composer' ? 12 : 0 }
  update(snapshot: Readonly<UsageSnapshot>) {
    let restoreFocus = false
    for (const kind of ['fiveHour', 'weekly'] as const) {
      const window = snapshot[kind]
      let entry = this.entries.get(kind)
      if (!window) {
        if (entry) {
          entry.dispose()
          restoreFocus ||= this.doc.activeElement === entry.button
          entry.button.remove(); this.entries.delete(kind)
        }
        continue
      }
      if (!entry) {
        const button = this.doc.createElement('button')
        button.type = 'button'
        button.className = `cui-trigger cui-${kind}`
        button.dataset.cuiWindow = kind
        const percent = this.doc.createElement('span')
        percent.className = 'cui-percent'
        const label = this.doc.createElement('span')
        label.className = 'cui-window-label'; label.textContent = labels[kind]
        let circle: SVGCircleElement | null = null
        if (this.location === 'rail') {
          const ring = this.doc.createElement('span')
          ring.className = 'cui-ring'
          const svg = this.doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
          svg.setAttribute('viewBox', '0 0 40 40'); svg.setAttribute('aria-hidden', 'true')
          const track = this.doc.createElementNS(svg.namespaceURI, 'circle') as SVGCircleElement
          for (const [key, value] of Object.entries({ cx: '20', cy: '20', r: '16', fill: 'none', 'stroke-width': '3', pathLength: '100' })) track.setAttribute(key, value)
          track.classList.add('cui-track')
          circle = track.cloneNode() as SVGCircleElement
          circle.classList.remove('cui-track'); circle.classList.add('cui-progress')
          svg.append(track, circle); ring.append(svg, percent); button.append(ring, label)
        } else button.append(label, percent)
        this.root.append(button)
        entry = { button, percent, circle, dispose: this.bind(button) }
        this.entries.set(kind, entry)
      }
      const value = window.remainingPercent
      entry.percent.textContent = this.location === 'composer' ? `剩余 ${value === null ? '未知' : displayPercent(value)}` : displayPercent(value)
      entry.circle?.setAttribute('stroke-dasharray', `${value === null ? 0 : Math.round(value)} 100`)
      entry.button.setAttribute('aria-label', `${names[kind]}额度，剩余 ${value === null ? '未知' : displayPercent(value)}${warning(value) ? `，${warning(value)}` : ''}`)
      entry.button.dataset.warning = warning(value) ? 'true' : 'false'
      entry.button.title = warning(value)
    }
    this.root.dataset.count = String(this.entries.size)
    this.status.remove()
    if (!this.entries.size) { this.status.textContent = connectionLabel(snapshot); this.root.append(this.status) }
    // Startup/failure is not evidence that the server removed a window. No fabricated windows.
    this.root.setAttribute('aria-label', this.entries.size ? '额度指示器' : snapshot.connection === 'connecting' ? '用量连接中' : '用量暂不可用')
    if (restoreFocus) this.entries.values().next().value?.button.focus()
  }
  stop() {
    for (const entry of this.entries.values()) entry.dispose()
    this.entries.clear(); this.root.remove()
  }
}
