export type AnchorCode = 'ready' | 'missing' | 'ambiguity' | 'space' | 'overlay' | 'structure'
export interface AnchorResult { kind: 'composer' | 'rail'; code: AnchorCode; candidates: number; adapter: string; target: HTMLElement | null }
function visible(element: HTMLElement): boolean {
  const style = element.ownerDocument.defaultView!.getComputedStyle(element)
  const r = element.getBoundingClientRect()
  return element.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    && style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0
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
    if (r.width < 180 || r.bottom + 60 > view.innerHeight || (next && next.top < r.bottom + 60)) return result('space')
  } else {
    // Wide sidebars are not evidence of the narrow icon rail requested by the design.
    if (r.width < 40 || r.width > 100 || r.height < 180) return result('space')
    const bottom = Math.max(r.top, ...[...node.children].map(child => child.getBoundingClientRect().bottom))
    if (r.bottom - bottom < 60) return result('space')
  }
  return result('ready', node)
}

export function mountMarker(result: AnchorResult): (() => void) | null {
  if (result.code !== 'ready' || !result.target) return null
  const target = result.target
  const doc = target.ownerDocument
  const original = target.getBoundingClientRect()
  const controls = [...doc.querySelectorAll<HTMLElement>('button, textarea, input, [contenteditable="true"]')]
    .filter(visible).map(element => ({ element, rect: element.getBoundingClientRect() }))
  const node = result.target.ownerDocument.createElement('div')
  node.dataset.cuiProbe = result.kind
  node.textContent = 'P0'
  node.setAttribute('aria-label', '用量探针测试标记')
  Object.assign(node.style, { height: '56px', minHeight: '56px', maxWidth: '68px', width: '100%',
    boxSizing: 'border-box', border: '1px dashed currentColor', borderRadius: '8px',
    display: 'grid', placeItems: 'center', fontSize: '12px', pointerEvents: 'none' })
  if (result.kind === 'composer') result.target.after(node)
  else result.target.append(node)
  // Geometry checks before insertion cannot prove the host's layout behavior. Roll back synchronously.
  const rect = node.getBoundingClientRect(), after = target.getBoundingClientRect()
  const view = doc.defaultView!
  const moved = (a: DOMRect, b: DOMRect) => a.left !== b.left || a.top !== b.top || a.width !== b.width || a.height !== b.height
  const unsafe = rect.width === 0 || rect.height === 0 || rect.left < 0 || rect.top < 0
    || rect.right > view.innerWidth || rect.bottom > view.innerHeight || moved(original, after)
    || controls.some(({ element, rect: before }) => {
      const current = element.getBoundingClientRect()
      return moved(before, current) || (rect.left < current.right && rect.right > current.left && rect.top < current.bottom && rect.bottom > current.top)
    })
  if (unsafe) { node.remove(); return null }
  return () => node.remove()
}
