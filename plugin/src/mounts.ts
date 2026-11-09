import { inspectAnchor, isThreadComposer, mountContent, visible, type AnchorResult } from './adapters/dom'
import { RingView } from './rings'
import type { SharedPopover } from './popover'
import type { UsageStore } from './store'

const selectors = '[data-codex-composer-root],nav[data-app-navigation-rail]'
const own = '[data-cui-slot],[data-cui-view],.cui-popover,style[data-cui-style]'
const attributes = ['hidden', 'inert', 'aria-hidden', 'style', 'class', 'data-codex-composer-root', 'data-app-navigation-rail', 'data-thread-scroll-footer', 'data-thread-find-composer']
type Slot = NonNullable<ReturnType<typeof mountContent>>
interface Binding { kind: 'composer' | 'rail'; view: RingView; slot: Slot | null; target: HTMLElement | null; height: number; code: AnchorResult['code'] }

export class MountManager {
  private bindings: Binding[]
  private observer: MutationObserver
  private resize: ResizeObserver | undefined
  private dimensions = new Map<Element, { width: number; height: number }>()
  private candidates: HTMLElement[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private force = false
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
          if (before && (Math.abs(before.width - after.width) > 1 || Math.abs(before.height - after.height) > 1)) { this.schedule(true); break }
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
  private onResize = () => this.schedule(true)
  private onMutation = (records: MutationRecord[]) => {
    if (this.stopped) return
    this.notifications++
    if (records.some(record => this.affectsLayout(record))) this.schedule(true)
  }
  private affectsLayout(record: MutationRecord) {
    const win = this.doc.defaultView!
    if (record.target instanceof win.Element && record.target.closest(own)) return false
    if (record.type === 'attributes') return record.target instanceof win.Element
      && (record.target.matches(selectors) || this.candidates.some(node => record.target instanceof win.Element && record.target.contains(node)))
    return [...record.addedNodes, ...record.removedNodes].some(node => {
      if (!(node instanceof win.Element) || node.matches(own)) return false
      return node.matches(selectors) || !!node.querySelector(selectors) || this.bindings.some(b => b.target && node.contains(b.target))
    })
  }
  private schedule(force = false) {
    if (this.stopped) return
    this.force ||= force
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => { this.timer = undefined; this.sync() }, 50)
  }
  private sync() {
    if (this.stopped) return
    const force = this.force; this.force = false
    this.scans++
    // Ordinary sampling must still reject a newly ambiguous or hidden native anchor.
    const live = [...this.doc.querySelectorAll<HTMLElement>(selectors)].filter(visible)
    for (const binding of this.bindings) {
      const height = binding.view.preferredHeight
      const rect = binding.target?.getBoundingClientRect()
      const matches = live.filter(node => node.matches(binding.kind === 'composer' ? '[data-codex-composer-root]' : 'nav[data-app-navigation-rail]'))
      if (!force && binding.slot?.root.isConnected && binding.target?.isConnected && rect && rect.width > 0 && rect.height > 0
        && (binding.kind !== 'composer' || isThreadComposer(binding.target))
        && height === binding.height && matches.length === 1 && matches[0] === binding.target) continue
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
    if (targets.length < 2) {
      const base = this.doc.body ?? this.doc.documentElement
      this.observer.observe(base, { childList: true, subtree: true, attributes: true, attributeFilter: attributes })
      if (base !== this.doc.documentElement) this.observer.observe(this.doc.documentElement,
        { childList: true, attributes: true, attributeFilter: attributes })
    } else {
      // Watch each ancestor's direct children. Replacing any containing branch is observed,
      // while ordinary message content and plugin-owned mutations are not scanned.
      const ancestors = new Set<Element>()
      for (const target of targets) for (let node: Element | null = target; node; node = node.parentElement) ancestors.add(node)
      for (const node of ancestors) this.observer.observe(node, { childList: true, attributes: true,
        attributeFilter: attributes })
    }
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
