import { describe, expect, test } from 'bun:test'
import { GlobalWindow as Window } from 'happy-dom'
import { appModuleUrl, clientsFromModule, deadline, discoverClients, readUsage, resourceUrls } from '../tools/probes/renderer-capabilities'
import { inspectAnchor, mountContent, mountMarker, type SlotChecks } from '../tools/probes/anchors'
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
      const width = rail && el.style.width.endsWith('px') ? parseFloat(el.style.width) : 68
      return { x: left, y: top, left, top, width, height: 56, right: left + width, bottom: top + 56, toJSON() {} }
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
  test.each(['primary', 'hidden-primary', 'two-primary', 'invalid-primary', 'unmarked'] as const)('原生编辑器语义标记 %s 不与辅助编辑区混淆', mode => {
    const { win, doc, box } = dom()
    const root = doc.querySelector<HTMLElement>('[data-codex-composer-root]')!
    const primary = doc.querySelector('textarea')!
    if (mode !== 'unmarked') primary.dataset.codexComposer = ''
    if (mode === 'hidden-primary') primary.hidden = true
    if (mode === 'invalid-primary') {
      primary.removeAttribute('data-codex-composer')
      const invalid = doc.createElement('span'); invalid.dataset.codexComposer = ''; root.append(invalid)
    }
    const auxiliary = doc.createElement('div'); auxiliary.contentEditable = 'true'; auxiliary.setAttribute('role', 'textbox')
    root.append(auxiliary); box(auxiliary, 210, 570, 400, 24)
    if (mode === 'two-primary') auxiliary.dataset.codexComposer = ''
    expect(inspectAnchor(doc, 'composer').code).toBe(mode === 'primary' ? 'ready' : 'structure')
    win.close()
  })
  test('rail 增长区域空白可收缩，插入 footer 前且不撑宽原生 rail', () => {
    const { win, doc, box } = dom()
    const nav = doc.querySelector<HTMLElement>('nav')!
    nav.style.paddingInline = '8px'
    box(nav, 0, 0, 52, 800)
    const grower = doc.createElement('div'), footer = doc.createElement('div'), button = doc.createElement('button')
    Object.assign(grower.style, { display: 'flex', flexDirection: 'column', flexGrow: '1' })
    button.dataset.sidebarDestination = 'builtin:home'
    grower.append(button); nav.append(grower, footer)
    box(grower, 6, 8, 40, 700); box(button, 8, 10, 36, 36); box(footer, 8, 716, 36, 80)
    const result = inspectAnchor(doc, 'rail')
    expect(result.adapter).toBe('navigation-rail-flex-v2')
    const dispose = mountMarker(result)
    const marker = nav.querySelector<HTMLElement>('[data-cui-probe]')!
    expect(marker.style.width).toBe('36px')
    expect(marker.nextElementSibling).toBe(footer)
    dispose?.()
    expect(nav.querySelector('[data-cui-probe]')).toBeNull()
    button.removeAttribute('data-sidebar-destination')
    expect(inspectAnchor(doc, 'rail').code).toBe('space')
    win.close()
  })
  test.each([false, true])('Composer 外围可平移，但尺寸变化 %p 时必须回滚', resize => {
    const { win, doc, box } = dom()
    const root = doc.querySelector<HTMLElement>('[data-codex-composer-root]')!
    const editor = doc.querySelector<HTMLElement>('textarea')!
    const flow = doc.querySelector<HTMLElement>('main')!
    flow.dataset.threadFindComposer = 'true'
    Object.assign(flow.style, { display: 'flex', flexDirection: 'column' })
    const area = doc.createElement('section'), footer = doc.createElement('section')
    footer.dataset.threadScrollFooter = 'true'
    doc.body.append(area); area.append(footer); footer.append(flow)
    box(area, 200, 96, 600, 684)
    const rect = (top: number, width: number, height: number) =>
      ({ x: 200, y: top, left: 200, top, width, height, right: 200 + width, bottom: top + height, toJSON() {} })
    const hasMarker = () => !!doc.querySelector('[data-cui-probe="composer"]')
    root.getBoundingClientRect = () => rect(hasMarker() ? 576 : 640, hasMarker() && resize ? 604 : 600, 130)
    editor.getBoundingClientRect = () => rect(hasMarker() ? 586 : 650, 580, 40)
    const create = doc.createElement.bind(doc)
    doc.createElement = ((tag: string, options?: ElementCreationOptions) => {
      const element = create(tag, options)
      if (tag === 'div') element.getBoundingClientRect = () => rect(714, 40, 56)
      return element
    }) as typeof doc.createElement
    const result = inspectAnchor(doc, 'composer')
    expect(result.adapter).toBe('composer-flow-v2')
    const dispose = mountMarker(result)
    expect(!!dispose).toBe(!resize)
    dispose?.()
    expect(root.getBoundingClientRect().top).toBe(640)
    expect(doc.querySelector('[data-cui-probe]')).toBeNull()
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
  test.each([false, true])('文字栏装饰重叠允许，但可交互区域侵入原生按钮 %p 时必须撤销', intrudes => {
    const win = new Window({ width: 900, height: 800 })
    const doc = win.document as unknown as Document
    doc.body.innerHTML = '<section><div data-thread-scroll-footer="true"><main data-thread-find-composer="true" style="display:flex;flex-direction:column"><div data-codex-composer-root><textarea></textarea><button type="button">native</button></div></main></div></section>'
    const root = doc.querySelector<HTMLElement>('[data-codex-composer-root]')!
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON() {} })
    doc.querySelector('section')!.getBoundingClientRect = () => rect(200, 96, 600, 684)
    const offset = () => {
      const slot = doc.querySelector<HTMLElement>('[data-cui-slot=composer]')
      return slot ? parseFloat(slot.style.height) + 8 + parseFloat(slot.style.marginBlockStart || '0') : 0
    }
    root.getBoundingClientRect = () => rect(200, 640 - offset(), 600, 130)
    doc.querySelector('textarea')!.getBoundingClientRect = () => rect(210, 650 - offset(), 580, 40)
    doc.querySelector('button')!.getBoundingClientRect = () => rect(760, 770 - offset() - (intrudes ? 15 : 28), 20, 20)
    const create = doc.createElement.bind(doc)
    doc.createElement = ((tag: string, options?: ElementCreationOptions) => {
      const el = create(tag, options)
      if (tag === 'div') el.getBoundingClientRect = () => rect(200, root.getBoundingClientRect().bottom + 8 + parseFloat(el.style.marginBlockStart || '0'), 600, parseFloat(el.style.height || '0'))
      return el
    }) as typeof doc.createElement
    const content = create('div')
    let rejection: SlotChecks | undefined
    const mounted = mountContent(inspectAnchor(doc, 'composer', 32), content, 44, 12, checks => { rejection = checks })
    expect(!!mounted).toBe(!intrudes)
    if (mounted) {
      expect(root.getBoundingClientRect().bottom - mounted.root.getBoundingClientRect().top).toBe(12)
      expect(mounted.root.style.pointerEvents).toBe('none')
      mounted.stop()
    } else expect(rejection?.overlappingControls).toBeGreaterThan(0)
    expect(doc.querySelector('[data-cui-slot]')).toBeNull()
    expect(root.getBoundingClientRect().top).toBe(640)
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
