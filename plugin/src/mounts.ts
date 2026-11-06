import { inspectAnchor, mountContent, type AnchorResult } from './adapters/dom'
import { RingView } from './rings'
import type { SharedPopover } from './popover'
import type { UsageStore } from './store'

const selectors = '[data-codex-composer-root],nav[data-app-navigation-rail]'
const own = '[data-cui-slot],[data-cui-view],.cui-popover,style[data-cui-style]'
const attributes = ['hidden', 'inert', 'aria-hidden', 'style', 'class', 'data-codex-composer-root', 'data-app-navigation-rail']
type Slot = NonNullable<ReturnType<typeof mountContent>>
interface Binding { kind: 'composer' | 'rail'; view: RingView; slot: Slot | null; target: HTMLElement | null; height: number; code: AnchorResult['code'] }

export class MountManager {
  private bindings: Binding[]
  private observer: MutationObserver
  private resize: ResizeObserver | undefined
  private dimensions = new Map<Element, { width: number; height: number }>()
  private candidates: HTMLElement[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private unsubscribe: () => void = () => {}
  private scans = 0
  private notifications = 0
  constructor(private doc: Document, store: UsageStore, popover: SharedPopover) {
    const win = doc.defaultView!
    this.bindings = (['composer', 'rail'] as const).map(kind => ({ kind,
      view: new RingView(doc, b => popover.bind(b), kind), slot: null, target: null, height: 0, code: 'missing' }))
    this.observer = new win.MutationObserver(this.onMutation)
    try {
      if (typeof win.ResizeObserver === 'function') this.resize = new win.ResizeObserver(entries => {
        for (const entry of entries) {
          const before = this.dimensions.get(entry.target), after = entry.target.getBoundingClientRect()
          if (before && (Math.abs(before.width - after.width) > 1 || Math.abs(before.height - after.height) > 1)) { this.updateGeometry(); this.schedule(); break }
        }
      })
      this.unsubscribe = store.subscribe(snapshot => {
        for (const binding of this.bindings) binding.view.update(snapshot)
        this.schedule()
      })
      win.addEventListener('resize', this.onResize)
      this.watch()
    } catch (error) { this.stop(); throw error }
  }
  private updateGeometry() {
    for (const binding of this.bindings) if (binding.slot?.root.isConnected && binding.target?.isConnected
      && binding.target.getBoundingClientRect().width > 0) binding.slot.update()
  }
  private onResize = () => { this.updateGeometry(); this.schedule() }
  private onMutation = (records: MutationRecord[]) => {
    if (this.stopped) return
    this.notifications++
    if (records.some(record => this.affectsLayout(record))) { this.updateGeometry(); this.schedule() }
  }
  private affectsLayout(record: MutationRecord) {
    const win = this.doc.defaultView!
    if (record.type === 'childList' && this.bindings.some(b => b.slot && [...record.removedNodes].includes(b.slot.root))) return true
    if (record.target instanceof win.Element && record.target.closest(own)) return false
    if (record.type === 'attributes') return record.target instanceof win.Element
      && (record.target.matches(selectors) || this.candidates.some(node => record.target instanceof win.Element && record.target.contains(node)))
    return [...record.addedNodes, ...record.removedNodes].some(node => {
      if (!(node instanceof win.Element) || node.matches(own)) return false
      return node.matches(selectors) || !!node.querySelector(selectors) || this.bindings.some(b => b.target && (node.contains(b.target) || b.target.contains(record.target)))
    })
  }
  private schedule() {
    if (this.stopped) return
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => { this.timer = undefined; this.sync() }, 50)
  }
  private sync() {
    if (this.stopped) return
    this.scans++
    // Ordinary sampling must still reject a newly ambiguous or hidden native anchor.
    for (const binding of this.bindings) {
      const height = binding.view.preferredHeight
      // Inspect with the existing slot in place. Native layout notifications must not
      // remove/reinsert a healthy flow item: that moves the composer and feeds ResizeObserver.
      const anchor = inspectAnchor(this.doc, binding.kind, height - binding.view.preferredOverlap, binding.slot?.root)
      if (binding.slot?.root.isConnected && binding.target === anchor.target && anchor.code === 'ready'
        && height === binding.height) { binding.slot.update(); binding.code = 'ready'; continue }
      const focused = binding.view.root.contains(this.doc.activeElement) ? this.doc.activeElement as HTMLElement : null
      binding.slot?.stop(); binding.slot = null; binding.target = null
      try {
        const anchor = inspectAnchor(this.doc, binding.kind, height - binding.view.preferredOverlap)
        binding.code = anchor.code
        if (anchor.code !== 'ready') continue
        binding.slot = mountContent(anchor, binding.view.root, height, binding.view.preferredOverlap)
        binding.target = binding.slot ? anchor.target : null
        binding.height = height
        if (!binding.slot) binding.code = 'space'
        if (focused?.isConnected) focused.focus()
      } catch { binding.code = 'structure' }
    }
    this.watch()
  }
  private watch() {
    this.observer.disconnect(); this.resize?.disconnect(); this.dimensions.clear()
    if (this.stopped) return
    this.candidates = [...this.doc.querySelectorAll<HTMLElement>(selectors)]
    const targets = this.bindings.map(b => b.target).filter((node): node is HTMLElement => !!node)
    // Cached/hidden chat branches can become active without replacing a currently
    // watched ancestor. Observe the document, but filter unrelated message mutations.
    this.observer.observe(this.doc.documentElement, { childList: true, subtree: true,
      attributes: true, attributeFilter: attributes })
    for (const target of targets) {
      const rect = target.getBoundingClientRect()
      this.dimensions.set(target, { width: rect.width, height: rect.height }); this.resize?.observe(target)
    }
  }
  inspect() { return { scans: this.scans, notifications: this.notifications,
    slots: this.bindings.filter(b => b.slot?.root.isConnected).length,
    adapters: this.bindings.map(b => ({ kind: b.kind, code: b.code })) } }
  stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.observer.disconnect(); this.resize?.disconnect(); this.dimensions.clear(); this.candidates = []; this.unsubscribe()
    this.doc.defaultView!.removeEventListener('resize', this.onResize)
    for (const binding of this.bindings) { binding.view.stop(); binding.slot?.stop(); binding.slot = null; binding.target = null }
  }
}
