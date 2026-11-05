import { sample } from '../../plugin/src/usage'
import { inspectAnchor, mountMarker } from './anchors'
import { CapabilityError, deadline, discoverClients, readUsage, resourceUrls } from './renderer-capabilities'

interface ProbeApi { log: { info(message: string): void } }
let active: { abort: AbortController; disposers: (() => void)[] } | undefined

function stop() {
  const previous = active
  active = undefined
  if (!previous) return
  previous.abort.abort()
  for (const dispose of previous.disposers.reverse()) dispose()
}
function start(api: ProbeApi) {
  stop()
  const context = { abort: new AbortController(), disposers: [] as (() => void)[] }
  active = context
  const signal = context.abort.signal
  const report = (value: unknown) => { if (active === context) api.log.info(JSON.stringify(value)) }
  const requestedAt = Math.floor(Date.now() / 1000)
  const readEntry = (url: string) => new Promise<string>(resolve => {
    const request = new XMLHttpRequest()
    const abort = () => request.abort()
    const finish = (text: string) => { signal.removeEventListener('abort', abort); resolve(text) }
    signal.addEventListener('abort', abort, { once: true })
    request.open('GET', url)
    request.timeout = 5000
    request.onload = () => finish(request.status === 200 ? request.responseText : '')
    request.onerror = request.ontimeout = request.onabort = () => finish('')
    request.send()
  })
  void (async () => {
    try {
      const anchors = (['composer', 'rail'] as const).map(kind => inspectAnchor(document, kind))
      report({ schemaVersion: 1, probe: 'anchors', anchors: anchors.map(({ target: _, ...safe }) => safe) })
      // Both anchors must be safe before touching either one. These markers are not final UI.
      if (anchors.every(anchor => anchor.code === 'ready')) {
        const markers: (() => void)[] = []
        for (const anchor of anchors) {
          const dispose = mountMarker(anchor)
          if (dispose) markers.push(dispose)
          else break
        }
        if (markers.length !== 2) markers.reverse().forEach(dispose => dispose())
        else context.disposers.push(...markers)
        report({ schemaVersion: 1, probe: 'markers', mounted: markers.length === 2 })
      }
      const clients = await deadline(discoverClients(resourceUrls(document, performance, location.href),
        url => import(/* @vite-ignore */ url), location.href, signal, readEntry), signal, 15_000)
      report({ schemaVersion: 1, probe: 'capabilities', candidates: clients.length, adapter: 'app-http-v1' })
      const raw = await readUsage(clients, signal)
      report({ schemaVersion: 1, provider: 'renderer-wham', requestedAt, fetchedAt: Math.floor(Date.now() / 1000),
        identity: 'native-comparison-required', eventMode: 'polling-only', ...sample(raw, 'renderer-wham') })
    } catch (error) {
      context.abort.abort()
      report({ schemaVersion: 1, probe: 'renderer', status: 'failed',
        code: error instanceof CapabilityError ? error.code : 'internal' })
    }
  })()
  return () => { if (active === context) stop() }
}

// Loader module-style lifecycle, deliberately not a browser ESM entry.
module.exports = { start, stop }
