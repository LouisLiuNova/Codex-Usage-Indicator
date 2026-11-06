export type AnchorCode = 'ready' | 'missing' | 'ambiguity' | 'space' | 'overlay' | 'structure'
export interface AnchorResult { kind: 'composer' | 'rail'; code: AnchorCode; candidates: number; adapter: string; target: HTMLElement | null }
export function visible(element: HTMLElement): boolean {
  const style = element.ownerDocument.defaultView!.getComputedStyle(element)
  const r = element.getBoundingClientRect()
  return element.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    && style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0
}

function railFooter(node: HTMLElement, reserve = 120): HTMLElement | null {
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
  return grower.getBoundingClientRect().bottom - bottom >= reserve + 8 ? footer : null
}

function composerFlow(node: HTMLElement, reserve = 56): boolean {
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
    && footer.contains(flow) && !!area && node.getBoundingClientRect().top - reserve - 8 >= area.top + 80
}

export function inspectAnchor(doc: Document, kind: 'composer' | 'rail', reservedHeight?: number): AnchorResult {
  const reserve = reservedHeight ?? 56
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
    const marked = [...node.querySelectorAll<HTMLElement>('[data-codex-composer]')]
    // Native goal/accessory editors may share this outer root. Prefer the explicit prompt marker;
    // a present but hidden/invalid marker must never fall back to an unrelated editor.
    const editors = (marked.length ? marked.filter(el => el.matches('[contenteditable="true"][role="textbox"],textarea'))
      : [...node.querySelectorAll<HTMLElement>('[contenteditable="true"][role="textbox"], textarea')]).filter(visible)
    if (editors.length !== 1 || !node.parentElement || node.closest('[contenteditable="true"]')) return result('structure')
    // Marker is a new sibling region; require visible free space below the existing native region.
    const next = node.nextElementSibling?.getBoundingClientRect()
    if (r.width < 180) return result('space')
    if (r.bottom + reserve + 4 > view.innerHeight || (next && next.top < r.bottom + reserve + 4)) {
      if (next || !composerFlow(node, reserve)) return result('space')
      return { ...result('ready', node), adapter: 'composer-flow-v2' }
    }
  } else {
    // Wide sidebars are not evidence of the narrow icon rail requested by the design.
    if (r.width < 40 || r.width > 100 || r.height < 180) return result('space')
    const bottom = Math.max(r.top, ...[...node.children].map(child => child.getBoundingClientRect().bottom))
    if (r.bottom - bottom < reserve + 4) {
      if (!railFooter(node, reservedHeight ?? 120)) return result('space')
      return { ...result('ready', node), adapter: 'navigation-rail-flex-v2' }
    }
  }
  return result('ready', node)
}

export function mountMarker(result: AnchorResult): (() => void) | null {
  return insert(result, null, 56)?.stop ?? null
}

export interface SlotChecks { outsideViewport: boolean; hostChanged: boolean; escapedRail: boolean; movedControls: number; overlappingControls: number }
export function mountContent(result: AnchorResult, content: HTMLElement, height: number, overlap = 0, rejected?: (checks: SlotChecks) => void) {
  if (!Number.isFinite(height) || height < 1 || height > 160 || !Number.isFinite(overlap) || overlap < 0
    || overlap >= height || (overlap > 0 && result.kind !== 'composer')) return null
  return insert(result, content, height, overlap, rejected)
}

function insert(result: AnchorResult, content: HTMLElement | null, height: number, overlap = 0, rejected?: (checks: SlotChecks) => void): { root: HTMLElement; stop: () => void } | null {
  if (result.code !== 'ready' || !result.target) return null
  const target = result.target
  const doc = target.ownerDocument
  const original = target.getBoundingClientRect()
  const flow = result.adapter === 'composer-flow-v2'
  if (flow && !composerFlow(target, height)) return null
  const footer = result.adapter === 'navigation-rail-flex-v2' ? railFooter(target, height) : null
  if (result.adapter === 'navigation-rail-flex-v2' && !footer) return null
  const controls = [...doc.querySelectorAll<HTMLElement>('button, textarea, input, [contenteditable="true"]')]
    .filter(visible).filter(element => {
      if (typeof doc.elementFromPoint !== 'function') return true
      const r = element.getBoundingClientRect()
      const hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      // Chat controls already behind the native footer are not exposed input targets.
      // A missing hit (including DOM test environments) retains the conservative check.
      return !hit || hit === element || element.contains(hit)
    }).map(element => ({ element, rect: element.getBoundingClientRect() }))
  const node = result.target.ownerDocument.createElement('div')
  if (content) node.dataset.cuiSlot = result.kind
  else { node.dataset.cuiProbe = result.kind; node.textContent = 'P0'; node.setAttribute('aria-label', '用量探针测试标记') }
  Object.assign(node.style, { height: `${height}px`, minHeight: `${height}px`, maxWidth: '68px', width: '100%',
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
  if (content) {
    node.style.border = '0'; node.style.pointerEvents = 'auto'; node.style.maxWidth = 'none'
    if (result.kind === 'composer') node.style.width = '100%'
    if (footer) node.style.setProperty('--cui-ring-size', node.style.width)
    if (result.kind === 'composer' && overlap) node.style.pointerEvents = 'none'
    node.append(content)
  }
  if (result.kind === 'composer') result.target.after(node)
  else if (footer) result.target.insertBefore(node, footer)
  else result.target.append(node)
  if (overlap) {
    const gap = Math.max(0, node.getBoundingClientRect().top - target.getBoundingClientRect().bottom)
    node.style.marginBlockStart = `${-gap - overlap}px`
  }
  // Geometry checks before insertion cannot prove the host's layout behavior. Roll back synchronously.
  const rect = node.getBoundingClientRect(), after = target.getBoundingClientRect()
  const view = doc.defaultView!
  const moved = (a: DOMRect, b: DOMRect) => Math.abs(a.left - b.left) > 1 || Math.abs(a.top - b.top) > 1
    || Math.abs(a.width - b.width) > 1 || Math.abs(a.height - b.height) > 1
  const resized = (a: DOMRect, b: DOMRect) => Math.abs(a.width - b.width) > 1 || Math.abs(a.height - b.height) > 1
  const deltaY = after.top - original.top
  const flowValid = flow && !resized(original, after) && Math.abs(after.left - original.left) <= 1
    && deltaY <= 1 && deltaY >= -height - 24
  const checks: SlotChecks = { outsideViewport: rect.width === 0 || rect.height === 0 || rect.left < 0 || rect.top < 0
    || rect.right > view.innerWidth || rect.bottom > view.innerHeight, hostChanged: flow ? !flowValid : moved(original, after),
    escapedRail: result.kind === 'rail' && (rect.left < original.left - 1 || rect.right > original.right + 1), movedControls: 0, overlappingControls: 0 }
  for (const { element, rect: before } of controls) {
      const current = element.getBoundingClientRect()
      const inFlow = flowValid && (target.contains(element) || (!!element.closest('[data-app-action-timeline-scroll]')
        && !element.closest('[data-thread-scroll-footer]')))
      const translated = !resized(before, current) && Math.abs(before.left - current.left) <= 1
        && (Math.abs(current.top - before.top - deltaY) <= 1 || Math.abs(current.top - before.top) <= 1)
      if (inFlow ? !translated : moved(before, current)) checks.movedControls++
      if (rect.left < current.right && rect.right > current.left && rect.top + overlap < current.bottom && rect.bottom > current.top) checks.overlappingControls++
  }
  if (checks.outsideViewport || checks.hostChanged || checks.escapedRail || checks.movedControls || checks.overlappingControls) {
    node.remove(); rejected?.(checks); return null
  }
  return { root: node, stop: () => node.remove() }
}
