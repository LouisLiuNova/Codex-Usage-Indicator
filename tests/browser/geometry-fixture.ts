import { createRuntime } from '../../plugin/src/runtime'
export function createGeometryFixture(doc: Document, mode: 'home' | 'thread', theme: 'dark' | 'light') {
  doc.querySelectorAll('[data-test-fixture]').forEach(n => n.remove())
  const style = doc.createElement('style'); style.dataset.testFixture = ''
  style.textContent = `body{margin:0;background:${theme === 'dark' ? '#171821' : '#f9f9fb'};color:${theme === 'dark' ? '#adb1d0' : '#303444'};--color-token-bg-primary:${theme === 'dark' ? '#171821' : '#f9f9fb'}}
  #fixture{position:absolute;left:100px;right:24px;bottom:24px;display:flex;flex-direction:column}
  #flow{display:flex;flex-direction:column;gap:8px} .contents{display:contents}
  [data-codex-composer-root]{position:relative;background:${theme === 'dark' ? '#2b2d3d' : '#fff'};border-radius:24px;height:100px;box-shadow:0 1px 2px #0003}
  textarea{position:absolute;left:24px;top:16px;width:calc(100% - 48px);height:32px;background:transparent;color:inherit;border:0;resize:none}
  #native{position:absolute;right:20px;bottom:16px}
  nav{position:absolute;top:0;left:0;width:68px;height:700px}`
  doc.head.append(style)
  const fixture = doc.createElement('section'); fixture.id = 'fixture'; fixture.dataset.testFixture = ''
  if (mode === 'thread') fixture.dataset.threadScrollFooter = 'true'
  fixture.innerHTML = `<div id="flow" data-thread-find-composer="true"><div class="contents"><div class="contents"><div data-codex-composer-root data-composer-placement="${mode}"><textarea data-codex-composer placeholder="synthetic composer"></textarea><button id="native">Send</button></div></div></div></div>`
  if (mode === 'home') {
    // Actual home footer: no thread markers, display:contents chain, bottom anchored.
    fixture.removeAttribute('data-thread-scroll-footer')
    fixture.querySelector('#flow')!.removeAttribute('data-thread-find-composer')
    const root = fixture.querySelector<HTMLElement>('[data-codex-composer-root]')!
    root.style.background = 'transparent'; root.style.borderRadius = '0'
    const body = doc.createElement('div'); body.dataset.composerBody = ''
    Object.assign(body.style, { position: 'absolute', inset: '0', borderRadius: '24px', background: theme === 'dark' ? '#2b2d3d' : '#fff' })
    body.append(...root.childNodes); root.append(body)
    fixture.querySelector('.contents')!.setAttribute('data-home-feed-composer', 'true')
  }
  doc.body.append(fixture)
  const nav = doc.createElement('nav'); nav.dataset.appNavigationRail = ''; nav.dataset.testFixture = ''; doc.body.append(nav)
  const runtime = createRuntime(doc, { read: async () => ({ source: 'renderer-wham', coverage: 'both', quality: 'normal',
    fiveHour: { remainingPercent: 50, resetsAt: 1800000000 }, weekly: { remainingPercent: 75, resetsAt: 1800000000 }, diagnostics: [] }) })
  let slot: Element | null = null, replacements = 0, count = 0
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.removedNodes)
      if (node instanceof doc.defaultView!.Element && (node.matches('[data-cui-slot]') || node.querySelector('[data-cui-slot]'))) replacements++
  })
  observer.observe(fixture, { subtree: true, childList: true })
  return {
    mutate() {
      slot ??= doc.querySelector('[data-cui-slot=composer]')
      const root = doc.querySelector<HTMLElement>('[data-codex-composer-root]')!
      root.style.height = `${100 + (++count % 2) * 40}px`
      doc.querySelector<HTMLElement>('#flow')!.style.gap = `${count % 2 ? 4 : 12}px`
      root.classList.toggle('changed'); fixture.classList.toggle('changed')
      const contents = doc.createElement('span'); contents.textContent = ' '; root.append(contents); contents.remove()
    },
    snapshot() {
      const root = doc.querySelector<HTMLElement>('[data-codex-composer-root]')!, hud = doc.querySelector<HTMLElement>('[data-cui-slot=composer]')
      const r = root.getBoundingClientRect(), h = hud?.getBoundingClientRect(), text = hud?.querySelector('.cui-value')?.getBoundingClientRect()
      return { runtime: runtime.inspect(), replacements, sameSlot: !slot || slot === hud,
        aligned: !!h && Math.abs(h.left - r.left) < 1 && Math.abs(h.width - r.width) < 1,
        overlap: h ? r.bottom - h.top : null, textBelow: !!text && text.top >= r.bottom,
        upperEdgeHidden: !!hud && getComputedStyle(hud.firstElementChild!, '::before').borderTopWidth === '0px',
        joinedEdge: !!hud && Math.abs((h!.top + parseFloat(getComputedStyle(hud.firstElementChild!, '::before').top)) - (r.bottom - 24)) < 1,
        nativeAbove: !!h && root.contains(doc.elementFromPoint(r.left + r.width / 2, r.bottom - 4)),
        viewport: !!h && h.bottom <= innerHeight && h.left >= 0 && h.right <= innerWidth }
    },
    stop() { observer.disconnect(); runtime.stop(); fixture.remove(); nav.remove(); style.remove() }
  }
}
