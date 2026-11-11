import { RingView } from '../../plugin/src/rings'
import { SharedPopover } from '../../plugin/src/popover'
import { UsageStore } from '../../plugin/src/store'
import { normalize } from '../../plugin/src/usage'
import { styles } from '../../plugin/src/styles'

// Synthetic usage only; no runtime/provider, native controls or network requests.
export function createRingColorFixture(doc: Document) {
  const host = doc.createElement('main'), style = doc.createElement('style'), theme = doc.createElement('style')
  host.dataset.cuiColorFixture = ''
  Object.assign(host.style, { margin: '48px', width: '380px', display: 'flex', gap: '48px', alignItems: 'flex-start' })
  style.textContent = styles
  doc.head.append(style, theme); doc.body.append(host)
  const store = new UsageStore(), popup = new SharedPopover(doc, store, () => () => {})
  const views = (['rail', 'composer'] as const).map(kind => new RingView(doc, button => popup.bind(button), kind))
  views[0]!.root.style.width = '52px'; views[1]!.root.style.width = '300px'
  host.append(...views.map(v => v.root))
  return {
    theme(value: 'light' | 'dark') {
      theme.textContent = `:root{color-scheme:${value}}body{margin:0;background:${value === 'dark' ? '#171821' : '#fff'};color:${value === 'dark' ? '#e5e7eb' : '#1f2937'}}`
    },
    update(fiveHour: number | null, weekly: number | null) {
      store.accept(store.revision, normalize({ rate_limit: {
        primary_window: { limit_window_seconds: 18000, used_percent: fiveHour === null ? null : 100 - fiveHour, reset_at: 1800000000 },
        secondary_window: { limit_window_seconds: 604800, used_percent: weekly === null ? null : 100 - weekly, reset_at: 1800000000 }
      } }, 'renderer-wham'), Date.now() / 1000)
      views.forEach(view => view.update(store.snapshot))
    },
    snapshot() {
      return [...host.querySelectorAll<HTMLElement>('.cui-trigger')].map(button => {
        const circle = button.querySelector('.cui-progress')!, label = button.querySelector('.cui-window-label')!
        return { kind: button.dataset.cuiWindow, level: button.dataset.usageLevel, warning: button.dataset.warning,
          stroke: doc.defaultView!.getComputedStyle(circle).stroke,
          track: doc.defaultView!.getComputedStyle(button.querySelector('.cui-track')!).stroke,
          marker: doc.defaultView!.getComputedStyle(label, '::after').content,
          markerColor: doc.defaultView!.getComputedStyle(label, '::after').color,
          title: button.title, aria: button.getAttribute('aria-label'), text: button.textContent,
          scheme: doc.defaultView!.getComputedStyle(button).colorScheme }
      })
    },
    stop() { views.forEach(view => view.stop()); popup.stop(); host.remove(); style.remove(); theme.remove() }
  }
}
