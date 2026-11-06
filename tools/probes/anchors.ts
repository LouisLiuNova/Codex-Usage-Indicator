export type AnchorCode = 'ready' | 'missing' | 'ambiguity' | 'space' | 'overlay' | 'structure'
export interface AnchorResult { kind: 'composer' | 'rail'; code: AnchorCode; candidates: number; adapter: string; target: HTMLElement | null }
function visible(element: HTMLElement): boolean {
  const style = element.ownerDocument.defaultView!.getComputedStyle(element)
  const r = element.getBoundingClientRect()
  return element.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    && style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0
}

function railFooter(node: HTMLElement): HTMLElement | null {
  const view = node.ownerDocument.defaultView!
  const children = [...node.children].filter((el): el is HTMLElement => el instanceof view.HTMLElement && visible(el))
  if (children.length !== 2) return null
  const grower = children[0]!, footer = children[1]!
  const style = view.getComputedStyle(grower)
  if (style.display !== 'flex' || style.flexDirection !== 'column' || Number(style.flexGrow) <= 0
    || !grower.querySelector('[data-sidebar-destination]') || footer.querySelector('[contenteditable="true"], textarea')) return null
  const controls = [...grower.querySelectorAll<HTMLElement>('button,a,[role="button"]')].filter(visible)
  if (!controls.length) return null
  const bottom = Math.max(...controls.map(el => el.getBoundingClientRect().bottom))
  return grower.getBoundingClientRect().bottom - bottom >= 128 ? footer : null
}

function composerFlow(node: HTMLElement): boolean {
  const view = node.ownerDocument.defaultView!
  let flow = node.parentElement
  for (let depth = 0; flow && view.getComputedStyle(flow).display === 'contents' && depth < 8; depth++) {
    if (flow.children.length !== 1) return false
    flow = flow.parentElement
  }
  const footer = node.closest<HTMLElement>('[data-thread-scroll-footer="true"]')
  if (!flow || !footer || !node.closest('[data-thread-find-composer="true"]')) return false
  const style = view.getComputedStyle(flow)
  const area = footer.parentElement?.getBoundingClientRect()
  return style.display === 'flex' && style.flexDirection === 'column'
    && footer.contains(flow) && !!area && node.getBoundingClientRect().top - 64 >= area.top + 80
}

export function inspectAnchor(doc: Document, kind: 'composer' | 'rail'): AnchorResult {
  const selector = kind === 'composer' ? '[data-codex-composer-root]' : 'nav[data-app-navigation-rail]'
  const nodes = [...doc.querySelectorAll<HTMLElement>(selector)].filter(visible)
  const result = (code: AnchorCode, target: HTMLElement | null = null): AnchorResult =>
    ({ kind, code, candidates: nodes.length, adapter: kind === 'composer' ? 'composer-root-v1' : 'navigation-rail-v1', target })
  if (nodes.length !== 1) return result(nodes.length ? 'ambiguity' : 'missing')
  const node = nodes[0]!
  if ([...doc.querySelectorAll<HTMLElement>('[aria-modal="true"], [role="menu"], dialog[open]')].some(visible)) return result('overlay')
  const r = node.getBoundingClientRect(), view = doc.defaultView!
  if (r.left < 0 || r.top < 0 || r.right > view.innerWidth || r.bottom > view.innerHeight) return result('space')
  if (kind === 'composer') {
    const editors = [...node.querySelectorAll<HTMLElement>('[contenteditable="true"][role="textbox"], textarea')].filter(visible)
    if (editors.length !== 1 || !node.parentElement || node.closest('[contenteditable="true"]')) return result('structure')
    // Marker is a new sibling region; require visible free space below the existing native region.
    const next = node.nextElementSibling?.getBoundingClientRect()
    if (r.width < 180) return result('space')
    if (r.bottom + 60 > view.innerHeight || (next && next.top < r.bottom + 60)) {
      if (next || !composerFlow(node)) return result('space')
      return { ...result('ready', node), adapter: 'composer-flow-v2' }
    }
  } else {
    // Wide sidebars are not evidence of the narrow icon rail requested by the design.
    if (r.width < 40 || r.width > 100 || r.height < 180) return result('space')
    const bottom = Math.max(r.top, ...[...node.children].map(child => child.getBoundingClientRect().bottom))
    if (r.bottom - bottom < 60) {
      if (!railFooter(node)) return result('space')
      return { ...result('ready', node), adapter: 'navigation-rail-flex-v2' }
    }
  }
  return result('ready', node)
}

export function mountMarker(result: AnchorResult): (() => void) | null {
  if (result.code !== 'ready' || !result.target) return null
  const target = result.target
  const doc = target.ownerDocument
  const original = target.getBoundingClientRect()
  const flow = result.adapter === 'composer-flow-v2'
  if (flow && !composerFlow(target)) return null
  const footer = result.adapter === 'navigation-rail-flex-v2' ? railFooter(target) : null
  if (result.adapter === 'navigation-rail-flex-v2' && !footer) return null
  const controls = [...doc.querySelectorAll<HTMLElement>('button, textarea, input, [contenteditable="true"]')]
    .filter(visible).map(element => ({ element, rect: element.getBoundingClientRect() }))
  const node = result.target.ownerDocument.createElement('div')
  node.dataset.cuiProbe = result.kind
  node.textContent = 'P0'
  node.setAttribute('aria-label', '用量探针测试标记')
  Object.assign(node.style, { height: '56px', minHeight: '56px', maxWidth: '68px', width: '100%',
    boxSizing: 'border-box', border: '1px dashed currentColor', borderRadius: '8px',
    display: 'grid', placeItems: 'center', fontSize: '12px', pointerEvents: 'none' })
  if (flow) {
    node.style.width = '40px'
    node.style.marginInline = 'auto'
    node.style.flexShrink = '0'
  }
  if (footer) {
    const style = doc.defaultView!.getComputedStyle(target)
    const inner = original.width - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
    node.style.width = `${Math.min(40, inner, footer.getBoundingClientRect().width)}px`
    node.style.flexShrink = '0'
  }
  if (result.kind === 'composer') result.target.after(node)
  else if (footer) result.target.insertBefore(node, footer)
  else result.target.append(node)
  // Geometry checks before insertion cannot prove the host's layout behavior. Roll back synchronously.
  const rect = node.getBoundingClientRect(), after = target.getBoundingClientRect()
  const view = doc.defaultView!
  const moved = (a: DOMRect, b: DOMRect) => Math.abs(a.left - b.left) > 1 || Math.abs(a.top - b.top) > 1
    || Math.abs(a.width - b.width) > 1 || Math.abs(a.height - b.height) > 1
  const resized = (a: DOMRect, b: DOMRect) => Math.abs(a.width - b.width) > 1 || Math.abs(a.height - b.height) > 1
  const deltaY = after.top - original.top
  const flowValid = flow && !resized(original, after) && Math.abs(after.left - original.left) <= 1
    && deltaY <= 1 && deltaY >= -80
  const unsafe = rect.width === 0 || rect.height === 0 || rect.left < 0 || rect.top < 0
    || rect.right > view.innerWidth || rect.bottom > view.innerHeight || (flow ? !flowValid : moved(original, after))
    || (result.kind === 'rail' && (rect.left < original.left - 1 || rect.right > original.right + 1))
    || controls.some(({ element, rect: before }) => {
      const current = element.getBoundingClientRect()
      const inFlow = flowValid && (target.contains(element) || (!!element.closest('[data-app-action-timeline-scroll]')
        && !element.closest('[data-thread-scroll-footer]')))
      const translated = !resized(before, current) && Math.abs(before.left - current.left) <= 1
        && (Math.abs(current.top - before.top - deltaY) <= 1 || Math.abs(current.top - before.top) <= 1)
      return (inFlow ? !translated : moved(before, current))
        || (rect.left < current.right && rect.right > current.left && rect.top < current.bottom && rect.bottom > current.top)
    })
  if (unsafe) { node.remove(); return null }
  return () => node.remove()
}
