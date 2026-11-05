import { describe, expect, test } from 'bun:test'
import { GlobalWindow as Window } from 'happy-dom'
import { appModuleUrl, clientsFromModule, deadline, discoverClients, readUsage, resourceUrls } from '../tools/probes/renderer-capabilities'
import { inspectAnchor, mountMarker } from '../tools/probes/anchors'
import { runInNewContext } from 'node:vm'

describe('能力发现边界', () => {
  const base = 'app://codex/assets/index-test.js'
  test.each(['https://example.com/x.js', 'app://other/x.js', 'file:///x.js', '/x.css', '/x.js?secret=x', '/x.js#x'])('拒绝外部或非模块资源 %s', url => {
    expect(appModuleUrl(url, base)).toBeNull()
  })
  test('同源相对模块路径', () => expect(appModuleUrl('./app-main-test.js', base)).toBe('app://codex/assets/app-main-test.js'))
  test('客户端实例/原型与缓存；不执行 getter 或工厂', () => {
    let calls = 0
    class Client { safeGet() { return Promise.resolve({}) }; makeRequest() {} }
    const client = new Client()
    const runtime = Object.assign(() => { calls++; throw new Error() }, { c: { a: { exports: { client } } }, m: {} })
    const module = { runtime, get unsafe() { calls++; throw new Error() } }
    expect(clientsFromModule(module)).toEqual([client])
    expect(calls).toBe(0)
    expect(clientsFromModule(new Proxy({}, { get: () => () => {} }))).toEqual([])
  })
  test('入口依赖发现及去重', async () => {
    const client = { safeGet: async () => ({}), makeRequest() {} }
    const imported: string[] = []
    const found = await discoverClients([base, base, 'https://evil/x.js'], async url => {
      imported.push(url)
      return url.includes('app-shared') ? { client } : {}
    }, base, new AbortController().signal, async () => './app-shared-abc.js')
    expect(found).toEqual([client])
    expect(imported).toEqual([base, 'app://codex/assets/app-shared-abc.js'])
  })
  test('只请求固定 GET；歧义不得跨客户端重试', async () => {
    const paths: string[] = []
    const client = { safeGet: async (path: string) => { paths.push(path); return {} }, makeRequest() {} }
    await readUsage([client], new AbortController().signal)
    expect(paths).toEqual(['/wham/usage'])
    await expect(readUsage([client, client], new AbortController().signal)).rejects.toHaveProperty('code', 'ambiguity')
    expect(paths.length).toBe(1)
  })
  test('取消、永久挂起与非 app 页面', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(deadline(new Promise(() => {}), abort.signal, 10)).rejects.toHaveProperty('code', 'timeout')
    await expect(deadline(new Promise(() => {}), new AbortController().signal, 10)).rejects.toHaveProperty('code', 'timeout')
    await expect(discoverClients([], async () => ({}), 'https://example.com', abort.signal)).rejects.toHaveProperty('code', 'origin')
  })
  test('DOM 与资源计时仅收集同源脚本', () => {
    const win = new Window()
    win.document.body.innerHTML = '<script src="app://codex/a.js"></script><link rel="modulepreload" href="app://other/b.js">'
    expect(resourceUrls(win.document as unknown as Document, { getEntriesByType: () => [] }, base)).toEqual(['app://codex/a.js'])
    win.close()
  })
})

function dom() {
  const win = new Window({ width: 900, height: 800 })
  win.document.body.innerHTML = '<main><div data-codex-composer-root><textarea></textarea></div></main><nav data-app-navigation-rail></nav>'
  const doc = win.document as unknown as Document
  function box(el: Element, left: number, top: number, width: number, height: number) {
    el.getBoundingClientRect = () => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON() {} })
  }
  box(doc.querySelector('main')!, 200, 400, 600, 350)
  box(doc.querySelector('[data-codex-composer-root]')!, 200, 450, 600, 160)
  box(doc.querySelector('textarea')!, 210, 460, 580, 100)
  box(doc.querySelector('nav')!, 0, 0, 68, 800)
  // happy-dom has no layout engine; simulate marker geometry independently from native controls.
  const create = doc.createElement.bind(doc)
  doc.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const el = create(tag, options)
    if (tag === 'div') el.getBoundingClientRect = () => {
      const rail = el.dataset.cuiProbe === 'rail'
      const left = rail ? 0 : 200, top = rail ? 100 : 620
      return { x: left, y: top, left, top, width: 68, height: 56, right: left + 68, bottom: top + 56, toJSON() {} }
    }
    return el
  }) as typeof doc.createElement
  return { win, doc, box }
}
describe('挂载前置条件与生命周期', () => {
  test('双标记不进入编辑器，清理幂等', () => {
    const { win, doc } = dom()
    const disposers = (['composer', 'rail'] as const).map(kind => mountMarker(inspectAnchor(doc, kind)))
    expect(doc.querySelectorAll('[data-cui-probe]').length).toBe(2)
    expect(doc.querySelector('textarea')?.childElementCount).toBe(0)
    for (const dispose of disposers) { dispose?.(); dispose?.() }
    expect(doc.querySelectorAll('[data-cui-probe]').length).toBe(0)
    win.close()
  })
  test.each(['missing', 'ambiguity', 'space', 'overlay', 'structure'])('Composer 拒绝 %s', code => {
    const { win, doc, box } = dom()
    const root = doc.querySelector('[data-codex-composer-root]')!
    if (code === 'missing') root.remove()
    if (code === 'ambiguity') { const copy = root.cloneNode(true) as Element; doc.body.append(copy); box(copy, 300, 300, 200, 100) }
    if (code === 'space') box(root, 200, 700, 600, 100)
    if (code === 'overlay') { const menu = doc.createElement('div'); menu.setAttribute('role', 'menu'); doc.body.append(menu); box(menu, 100, 100, 100, 100) }
    if (code === 'structure') doc.querySelector('textarea')!.remove()
    const result = inspectAnchor(doc, 'composer')
    expect(result.code).toBe(code)
    expect(mountMarker(result)).toBeNull()
    win.close()
  })
  test('宽侧栏不冒充 icon rail', () => {
    const { win, doc, box } = dom()
    box(doc.querySelector('nav')!, 0, 0, 260, 800)
    expect(inspectAnchor(doc, 'rail').code).toBe('space')
    win.close()
  })
  test('插入后与原生输入控件重叠则同步回滚', () => {
    const { win, doc, box } = dom()
    const input = doc.createElement('input')
    doc.body.append(input)
    box(input, 200, 620, 100, 40)
    expect(mountMarker(inspectAnchor(doc, 'composer'))).toBeNull()
    expect(doc.querySelectorAll('[data-cui-probe]').length).toBe(0)
    win.close()
  })
  test('隐藏编辑器不参与唯一性判断', () => {
    const { win, doc } = dom()
    const root = doc.querySelector('[data-codex-composer-root]')!
    root.setAttribute('hidden', '')
    expect(inspectAnchor(doc, 'composer').code).toBe('missing')
    win.close()
  })
  test('CJS start-stop-start 与卸载迟到响应隔离', async () => {
    const build = await Bun.build({ entrypoints: ['tools/probes/renderer.ts'], target: 'browser', format: 'cjs' })
    expect(build.success).toBe(true)
    const { win, doc } = dom()
    const module = { exports: {} as { start: (api: unknown) => () => void; stop: () => void } }
    const logs: string[] = []
    runInNewContext(await build.outputs[0]!.text(), { module, document: doc, performance: { getEntriesByType: () => [] },
      location: { href: 'app://codex/index.html' }, AbortController, URL, setTimeout, clearTimeout })
    const api = { log: { info: (s: string) => logs.push(s) } }
    const first = module.exports.start(api)
    expect(doc.querySelectorAll('[data-cui-probe]').length).toBe(2)
    first(); module.exports.stop()
    const count = logs.length
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(logs.length).toBe(count)
    expect(doc.querySelectorAll('[data-cui-probe]').length).toBe(0)
    module.exports.start(api)
    expect(doc.querySelectorAll('[data-cui-probe]').length).toBe(2)
    first()
    expect(doc.querySelectorAll('[data-cui-probe]').length).toBe(2)
    module.exports.stop()
    win.close()
  })
})
