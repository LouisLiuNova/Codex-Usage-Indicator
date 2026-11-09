import { MountManager } from '../../plugin/src/mounts'
import { UsageStore } from '../../plugin/src/store'
import { SharedPopover } from '../../plugin/src/popover'
import { normalize } from '../../plugin/src/usage'
import { styles } from '../../plugin/src/styles'

// Synthetic browser fixture: never use real account data or alter the host's native controls.
export function createMountLifecycleFixture(host: Document) {
  const iframe = host.createElement('iframe')
  iframe.dataset.cuiFixture = 'mount-lifecycle'; iframe.setAttribute('aria-hidden', 'true')
  Object.assign(iframe.style, { all: 'initial', position: 'fixed', left: '-10000px', top: '0', width: '900px',
    height: '800px', maxHeight: 'none', maxWidth: 'none', opacity: '0', pointerEvents: 'none', border: '0' })
  let mounts: MountManager | undefined, popup: SharedPopover | undefined, stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    try { mounts?.stop() }
    finally { try { popup?.stop() } finally { iframe.remove() } }
  }
  host.body.append(iframe)
  try {
    const doc = iframe.contentDocument
    if (!doc?.defaultView) throw new Error('fixture-document')
    doc.body.style.margin = '0'
    doc.body.innerHTML = '<main data-thread-scroll-footer="true" data-thread-find-composer="true" style="position:absolute;left:200px;top:400px;width:600px"><div data-codex-composer-root hidden style="height:160px;width:600px"><textarea style="width:580px;height:100px;margin:10px"></textarea></div></main><nav data-app-navigation-rail style="position:absolute;left:0;top:0;width:68px;height:700px"></nav>'
    const style = doc.createElement('style'); style.textContent = styles; doc.head.append(style)
    const store = new UsageStore()
    const refresh = () => store.accept(store.revision, normalize({ rate_limit: { primary_window: {
      limit_window_seconds: 604800, used_percent: 25, reset_at: 1800000000
    } } }, 'renderer-wham'), Date.now() / 1000)
    refresh()
    popup = new SharedPopover(doc, store, () => () => {})
    mounts = new MountManager(doc, store, popup)
    let duplicate: HTMLElement | undefined, message: HTMLElement | undefined
    return {
      snapshot: () => mounts!.inspect(),
      reveal() { doc.querySelector<HTMLElement>('[data-codex-composer-root]')!.hidden = false },
      unrelated() { message = doc.createElement('article'); message.textContent = 'fixture message'; doc.body.append(message); message.className = 'changed' },
      rebuildComposer() { const root = doc.querySelector('[data-codex-composer-root]')!; root.replaceWith(root.cloneNode(true)) },
      rebuildRail() {
        const rail = doc.querySelector('nav')!, copy = rail.cloneNode(true) as HTMLElement
        copy.querySelectorAll('[data-cui-slot]').forEach(node => node.remove()); rail.replaceWith(copy)
      },
      addHiddenDuplicate() {
        duplicate = doc.querySelector<HTMLElement>('[data-codex-composer-root]')!.cloneNode(true) as HTMLElement
        duplicate.hidden = true
        const aside = doc.createElement('aside'); aside.append(duplicate); doc.body.append(aside)
      },
      revealDuplicate() { duplicate!.hidden = false; refresh() },
      removeDuplicate() { duplicate!.remove() },
      stop
    }
  } catch (error) { stop(); throw error }
}
