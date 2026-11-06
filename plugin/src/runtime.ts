import { UsageStore } from './store'
import { RefreshScheduler, type Clock, type UsageProvider } from './scheduler'
import { WhamProvider } from './providers/wham'
import { discoverClients, resourceUrls } from './providers/capabilities'
import { SharedPopover, type Positioner } from './popover'
import { MountManager } from './mounts'
import { styles } from './styles'

export interface RuntimeHandle { stop(): void; inspect(): { active: boolean; requests: number; status: string; coverage: string; eventMode: string; ui: ReturnType<MountManager['inspect']> | null } }
type RuntimeWindow = Window & typeof globalThis & { __codexUsageIndicatorRuntime?: RuntimeHandle }
export function createRuntime(doc: Document, options: { read?: UsageProvider; clock?: Clock; position?: Positioner } = {}): RuntimeHandle {
  const win = doc.defaultView! as RuntimeWindow
  win.__codexUsageIndicatorRuntime?.stop()
  const store = new UsageStore()
  let active = true, requests = 0, ownershipUncertain = false
  let scheduler: RefreshScheduler | undefined, provider: WhamProvider | undefined
  let popover: SharedPopover | undefined, mounts: MountManager | undefined
  let foreground: ReturnType<typeof setTimeout> | undefined
  const style = doc.createElement('style'); style.dataset.cuiStyle = 'runtime'; style.textContent = styles
  const disposers: (() => void)[] = []
  const handle: RuntimeHandle = {
    stop() {
      if (!active) return
      active = false; scheduler?.stop(); provider?.stop()
      if (foreground !== undefined) clearTimeout(foreground)
      foreground = undefined
      mounts?.stop(); popover?.stop(); style.remove()
      for (const dispose of disposers.reverse()) dispose()
      if (win.__codexUsageIndicatorRuntime === handle) delete win.__codexUsageIndicatorRuntime
    },
    inspect() { return { active, requests, status: store.snapshot.status, coverage: store.snapshot.coverage,
      eventMode: 'polling-only', ui: mounts?.inspect() ?? null } }
  }
  win.__codexUsageIndicatorRuntime = handle
  try {
    ;(doc.head ?? doc.documentElement).append(style)
    popover = new SharedPopover(doc, store, options.position)
    mounts = new MountManager(doc, store, popover)
    provider = new WhamProvider(signal => discoverClients(resourceUrls(doc, win.performance, win.location.href),
      url => import(url), win.location.href, signal),
      () => { if (active) void scheduler?.changeContext() })
    const read = options.read ?? (signal => provider!.read(signal))
    scheduler = new RefreshScheduler(store, async signal => { requests++; return read(signal) }, options.clock)
    const listen = (target: EventTarget, type: string, listener: EventListener) => {
      target.addEventListener(type, listener, true); disposers.push(() => target.removeEventListener(type, listener, true))
    }
    const enterForeground = () => {
      if (!active || doc.visibilityState === 'hidden') return
      // Ordinary refreshes retain the current snapshot and any in-flight request.
      // Only an observed ownership risk invalidates the account context.
      if (ownershipUncertain) { provider!.invalidate(false); ownershipUncertain = false }
      if (foreground !== undefined) clearTimeout(foreground)
      foreground = setTimeout(() => { foreground = undefined; if (active) void scheduler!.refresh() }, 200)
    }
    listen(win, 'focus', event => { if (event.target === win) enterForeground() })
    listen(doc, 'visibilitychange', enterForeground)
    listen(win, 'online', () => { if (active) void scheduler!.refresh() })
    // Opening a native profile menu makes account ownership uncertain. Clear immediately,
    // and conservatively wait for a fresh foreground entry rather than guessing a switch event.
    const accountRisk = (event: Event) => {
      if (event instanceof win.KeyboardEvent && !['Enter', ' '].includes(event.key)) return
      if (!(event.target instanceof win.Element)) return
      const button = event.target.closest('button'), nav = button?.closest('nav[data-app-navigation-rail]')
      if (!button || !nav || button.closest('[data-cui-slot]') || button.getAttribute('aria-haspopup') !== 'menu'
        || /usage|用量/i.test(button.getAttribute('aria-label') ?? '')) return
      const footer = [...nav.children].filter(node => node.getBoundingClientRect().width > 0).at(-1)
      if (!footer?.contains(button)) return
      ownershipUncertain = true
      provider!.invalidate(true); void scheduler!.changeContext(false); popover!.close()
      if (foreground !== undefined) clearTimeout(foreground)
      foreground = undefined
    }
    listen(doc, 'pointerdown', accountRisk); listen(doc, 'keydown', accountRisk)
    listen(win, 'pagehide', () => handle.stop())
    void scheduler.start()
    return handle
  } catch (error) { handle.stop(); throw error }
}
