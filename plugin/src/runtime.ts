import { UsageStore } from './store'
import { RefreshScheduler, type Clock, type UsageProvider } from './scheduler'
import { WhamProvider } from './providers/wham'
import { discoverClients, resourceUrls } from './providers/capabilities'
import { SharedPopover, type Positioner } from './popover'
import { MountManager } from './mounts'
import { styles } from './styles'

export interface RuntimeHandle { stop(): void; inspect(): { active: boolean; requests: number; status: string; coverage: string; connection: string; contextPaused: boolean; eventMode: string; ui: ReturnType<MountManager['inspect']> | null } }
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
      connection: store.snapshot.connection, contextPaused: ownershipUncertain,
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
    let accountTrigger: HTMLElement | undefined, accountSeen = false
    let accountWatch: MutationObserver | undefined, accountSettle: ReturnType<typeof setTimeout> | undefined
    const nativeMenus = '[role="menu"],[aria-modal="true"],dialog[open]'
    const menuOpen = () => accountTrigger?.isConnected && (accountTrigger.getAttribute('aria-expanded') === 'true'
      || accountTrigger.getAttribute('data-state') === 'open') || [...doc.querySelectorAll<HTMLElement>(nativeMenus)].some(node => {
        const rect = node.getBoundingClientRect(), css = win.getComputedStyle(node)
        return !node.closest('[data-cui-slot],.cui-popover') && !node.closest('[hidden],[aria-hidden="true"]')
          && rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden'
      })
    const clearAccountWatch = () => {
      accountWatch?.disconnect(); accountWatch = undefined
      if (accountSettle !== undefined) clearTimeout(accountSettle)
      accountSettle = undefined; accountTrigger = undefined; accountSeen = false
    }
    disposers.push(clearAccountWatch)
    const enterForeground = () => {
      if (!active || doc.visibilityState === 'hidden') return
      // Ordinary refreshes retain the current snapshot and any in-flight request.
      // Only an observed ownership risk invalidates the account context.
      if (ownershipUncertain) {
        if (menuOpen()) return
        provider!.invalidate(false); ownershipUncertain = false; clearAccountWatch()
      }
      if (foreground !== undefined) clearTimeout(foreground)
      foreground = setTimeout(() => { foreground = undefined; if (active) void scheduler!.refresh() }, 200)
    }
    listen(win, 'focus', event => { if (event.target === win) enterForeground() })
    listen(doc, 'visibilitychange', enterForeground)
    listen(win, 'online', enterForeground)
    const checkAccountClose = () => {
      if (!active || !ownershipUncertain) return
      if (accountSettle !== undefined) clearTimeout(accountSettle)
      accountSettle = undefined
      if (menuOpen()) { accountSeen = true; return }
      if (!accountSeen) return
      // Let native close/account selection commit, then rediscover the current client.
      accountSettle = setTimeout(() => { accountSettle = undefined; enterForeground() }, 500)
    }
    // Clear on ownership risk; resume only after the observed menu closes (or a
    // foreground entry), with fresh discovery. Never retain the previous account sample.
    const accountRisk = (event: Event) => {
      if (event instanceof win.KeyboardEvent && !['Enter', ' '].includes(event.key)) return
      if (!(event.target instanceof win.Element)) return
      const button = event.target.closest('button'), nav = button?.closest('nav[data-app-navigation-rail]')
      if (!button || !nav || button.closest('[data-cui-slot]') || button.getAttribute('aria-haspopup') !== 'menu'
        || /usage|用量/i.test(button.getAttribute('aria-label') ?? '')) return
      const footer = [...nav.children].filter(node => node.getBoundingClientRect().width > 0).at(-1)
      if (!footer?.contains(button)) return
      clearAccountWatch(); accountTrigger = button
      ownershipUncertain = true
      accountSeen = !!menuOpen()
      provider!.invalidate(true); void scheduler!.changeContext(false); popover!.close()
      if (foreground !== undefined) clearTimeout(foreground)
      foreground = undefined
      try {
        accountWatch = new win.MutationObserver(records => {
          const relevant = records.some(record => {
            if (record.type === 'attributes') return record.target === accountTrigger
              || record.target instanceof win.Element && record.target.matches(nativeMenus)
            return [...record.addedNodes, ...record.removedNodes].some(node => {
              if (!(node instanceof win.Element)) return false
              const menu = node.matches(nativeMenus) || !!node.querySelector(nativeMenus)
              if (menu) accountSeen = true
              return menu || !!accountTrigger && node.contains(accountTrigger)
            })
          })
          if (relevant) checkAccountClose()
        })
        accountWatch.observe(doc.documentElement, { subtree: true, childList: true, attributes: true,
          attributeFilter: ['aria-expanded', 'data-state', 'hidden', 'aria-hidden'] })
      } catch {
        accountWatch?.disconnect(); accountWatch = undefined
        // Retain the foreground-entry fallback, and keep old-account data cleared.
      }
      checkAccountClose()
    }
    listen(doc, 'pointerdown', accountRisk); listen(doc, 'keydown', accountRisk)
    listen(win, 'pagehide', () => handle.stop())
    void scheduler.start()
    return handle
  } catch (error) { handle.stop(); throw error }
}
