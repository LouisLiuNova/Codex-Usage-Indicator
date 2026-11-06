export interface HttpClient { safeGet(path: string): Promise<unknown>; makeRequest: (...args: never[]) => unknown }
export class CapabilityError extends Error {
  constructor(readonly code: 'origin' | 'missing' | 'ambiguity' | 'timeout' | 'request') { super(code) }
}

function data(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}
function method(value: object, key: string): boolean {
  let current: object | null = value
  for (let depth = 0; current && current !== Object.prototype && depth < 6; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) return typeof descriptor.value === 'function'
    current = Object.getPrototypeOf(current)
  }
  return false
}
const object = (v: unknown): v is object => v !== null && (typeof v === 'object' || typeof v === 'function')

/** Rspack ESM runtime: inspect already cached exports, never run module factories.
 * Only zero-argument live-binding getters that return a single identifier are accepted.
 * Budget exhaustion rejects the entire scan, so partial results cannot establish uniqueness.
 */
export function clientsFromRspack(module: unknown, strictBudget = false): HttpClient[] {
  if (!object(module)) return []
  const runtime = data(module, '__webpack_require__')
  if (typeof runtime !== 'function') return []
  const cache = data(runtime, 'c'), factories = data(runtime, 'm')
  if (!object(cache) || !object(factories)) return []
  const ids = Object.getOwnPropertyNames(cache)
  const exhausted = (): HttpClient[] => {
    if (strictBudget) throw new CapabilityError('ambiguity')
    return []
  }
  if (ids.length > 16_384) return exhausted()
  let budget = 131_072
  const clients = new Set<HttpClient>()
  const inspect = (value: unknown) => {
    if (object(value) && method(value, 'safeGet') && method(value, 'makeRequest')) clients.add(value as HttpClient)
  }
  for (const id of ids) {
    try {
      const entry = data(cache, id)
      const exports = object(entry) ? data(entry, 'exports') : null
      if (!object(exports)) continue
      inspect(exports)
      // Rspack also caches transpiled live bindings without __esModule; skip the Window export itself.
      if (exports === globalThis) continue
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(exports))) {
        if (--budget < 0) return exhausted()
        let value: unknown = descriptor.value
        if (descriptor.get) {
          const source = Function.prototype.toString.call(descriptor.get)
          if (!/^\(\s*\)\s*=>\s*[A-Za-z_$][\w$]*\s*$/.test(source)) continue
          try { value = descriptor.get.call(exports) } catch { continue }
        }
        inspect(value)
      }
    } catch (error) {
      if (error instanceof CapabilityError) throw error
      // Unsupported proxy/module: reject it without executing factories.
    }
  }
  return [...clients]
}

/** Inspect data descriptors and already cached exports; never invoke getters or module factories. */
export function clientsFromModule(module: unknown): HttpClient[] {
  const found = new Set<HttpClient>()
  const queue: unknown[] = [module]
  const seen = new Set<object>()
  for (let i = 0; i < queue.length && i < 256; i++) {
    const value = queue[i]
    if (!object(value) || seen.has(value)) continue
    seen.add(value)
    try {
      if (method(value, 'safeGet') && method(value, 'makeRequest')) found.add(value as HttpClient)
      for (const key of Object.getOwnPropertyNames(value).slice(0, 256)) {
        const exported = data(value, key)
        if (!object(exported)) continue
        if (method(exported, 'safeGet') && method(exported, 'makeRequest')) found.add(exported as HttpClient)
        if (typeof exported !== 'function') continue
        const cache = data(exported, 'c'), factories = data(exported, 'm')
        if (!object(cache) || !object(factories)) continue
        for (const id of Object.getOwnPropertyNames(cache).slice(0, 256)) {
          const entry = data(cache, id)
          if (object(entry)) queue.push(data(entry, 'exports'))
        }
      }
    } catch { /* unsupported proxy/module: leave it unselected */ }
  }
  return [...found]
}

export function appModuleUrl(value: string, base: string): string | null {
  try {
    const host = new URL(base), url = new URL(value, host)
    return host.protocol === 'app:' && url.protocol === 'app:' && url.host === host.host
      && !url.username && !url.password && !url.search && !url.hash && /\.m?js$/i.test(url.pathname) ? url.href : null
  } catch { return null }
}

export function resourceUrls(doc: Document, perf: Pick<Performance, 'getEntriesByType'>, base: string): string[] {
  const found = new Set<string>()
  const add = (v: string) => { const url = appModuleUrl(v, base); if (url && found.size < 96) found.add(url) }
  doc.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[rel="modulepreload"][href]')
    .forEach(node => add(node.getAttribute('src') ?? node.getAttribute('href') ?? ''))
  for (const entry of perf.getEntriesByType('resource'))
    if ((entry as PerformanceResourceTiming).initiatorType === 'script') add(entry.name)
  return [...found]
}

export function deadline<T>(operation: Promise<T>, signal: AbortSignal, ms = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    const abort = () => { finish(); reject(new CapabilityError('timeout')) }
    const timer = setTimeout(abort, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    operation.then(value => { finish(); resolve(value) }, error => { finish(); reject(error) })
  })
}

export async function discoverClients(urls: string[], load: (url: string) => Promise<unknown>, base: string,
  signal: AbortSignal, readEntry?: (url: string) => Promise<string>): Promise<HttpClient[]> {
  if (new URL(base).protocol !== 'app:') throw new CapabilityError('origin')
  const queue = [...new Set(urls.map(v => appModuleUrl(v, base)).filter((v): v is string => v !== null))].slice(0, 96)
  const seen = new Set<string>()
  const found = new Set<HttpClient>()
  for (let i = 0; i < queue.length && i < 96; i++) {
    if (signal.aborted) throw new CapabilityError('timeout')
    const url = queue[i]!
    if (seen.has(url)) continue
    seen.add(url)
    if (readEntry && /\/(?:index|app-main)-[^/]+\.js$/.test(new URL(url).pathname)) {
      try {
        const text = await deadline(readEntry(url), signal, 5000)
        for (const match of text.slice(0, 4_194_304).matchAll(/(?:\.\/|\/)?(?:assets\/)?app-(?:main|initial|primary|shared)-[A-Za-z0-9_-]+\.js/g)) {
          const dependency = appModuleUrl(match[0], url)
          if (dependency && !queue.includes(dependency) && queue.length < 96) queue.push(dependency)
        }
      } catch { /* importing known entries can still succeed */ }
    }
    try {
      const module = await deadline(load(url), signal)
      for (const client of clientsFromModule(module)) found.add(client)
      for (const client of clientsFromRspack(module, true)) found.add(client)
    } catch (error) {
      // A rejected full scan cannot fall back to candidates from the partial legacy scan.
      if (error instanceof CapabilityError && error.code === 'ambiguity') throw error
      // No raw exception output.
    }
  }
  return [...found]
}

export async function readUsage(clients: HttpClient[], signal: AbortSignal) {
  // No retries across multiple authenticated clients: an ambiguous context is unsafe.
  if (clients.length !== 1) throw new CapabilityError(clients.length ? 'ambiguity' : 'missing')
  try { return await deadline(clients[0]!.safeGet('/wham/usage'), signal) }
  catch (e) { throw e instanceof CapabilityError ? e : new CapabilityError('request') }
}
