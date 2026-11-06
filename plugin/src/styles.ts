export const styles = `
.cui-rings,.cui-popover{font-family:inherit;color:var(--color-token-text-primary,CanvasText);color-scheme:inherit;box-sizing:border-box}
.cui-rings{display:flex;align-items:center;justify-content:center;gap:16px;flex-shrink:0;min-width:0}
.cui-rail{flex-direction:column;gap:8px;width:100%}
[data-codex-composer-root]:has(+[data-cui-slot="composer"]){position:relative;z-index:1}
[data-cui-slot="composer"]{position:relative;z-index:0}
.cui-composer{position:relative;z-index:0;width:100%;min-height:44px;justify-content:flex-end;padding:14px 16px 4px;gap:16px;opacity:.8;border:0;border-radius:0 0 12px 12px;pointer-events:none}
.cui-composer::before{content:"";position:absolute;z-index:-1;inset:calc(12px - var(--cui-composer-radius,24px)) 0 0;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-top:0;border-radius:0 0 12px 12px;background:var(--color-background-primary,var(--color-token-bg-primary,Canvas));pointer-events:none}
.cui-composer .cui-value{flex-direction:row;gap:6px;min-height:20px;pointer-events:none}
.cui-composer .cui-percent{font-size:11px;line-height:16px;white-space:nowrap}
.cui-composer .cui-window-label{font-size:10px;line-height:16px;color:var(--color-token-text-secondary,GrayText)}
.cui-composer .cui-value+.cui-value{padding-inline-start:16px;border-inline-start:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:0}
.cui-trigger,.cui-value{all:unset;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:2px;border-radius:8px;color:inherit;font:inherit;flex-shrink:0}
.cui-trigger{cursor:pointer}
.cui-trigger:focus-visible,.cui-close:focus-visible{outline:2px solid Highlight;outline-offset:3px}
.cui-trigger:hover{background:color-mix(in srgb,currentColor 7%,transparent)}
.cui-ring{display:grid;position:relative;width:var(--cui-ring-size,40px);height:var(--cui-ring-size,40px);place-items:center}
.cui-ring svg{width:100%;height:100%;transform:rotate(-90deg);grid-area:1/1}
.cui-track{stroke:color-mix(in srgb,currentColor 12%,transparent)}
.cui-progress{stroke:var(--cui-accent);stroke-linecap:round}
.cui-fiveHour{--cui-accent:#0891b2}.cui-weekly{--cui-accent:#8b5cf6}
.cui-rail .cui-trigger[data-usage-level=low]{--cui-accent:var(--color-token-text-warning,light-dark(#b45309,#fbbf24))}
.cui-rail .cui-trigger[data-usage-level=critical]{--cui-accent:var(--color-token-text-error,light-dark(#dc2626,#f87171))}
.cui-rail .cui-trigger:is([data-usage-level=low],[data-usage-level=critical]) .cui-track{stroke:color-mix(in srgb,var(--cui-accent) 24%,transparent)}
.cui-percent{grid-area:1/1;font-size:10px;line-height:1;font-weight:600;font-variant-numeric:tabular-nums}
.cui-window-label{font-size:9px;line-height:12px;font-weight:600;letter-spacing:.04em}
.cui-rail .cui-trigger[data-warning=true] .cui-window-label::after{content:' !';color:var(--cui-accent)}
.cui-popover{position:fixed;inset:auto;top:0;left:0;width:300px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;z-index:1000;padding:16px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:16px;background:var(--color-token-bg-primary,Canvas);box-shadow:0 12px 40px #0003;font-size:12px;line-height:1.5}
.cui-popover header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.cui-popover h2{font-size:14px;line-height:20px;font-weight:600;margin:0}
.cui-popover section{border-top:1px solid color-mix(in srgb,currentColor 12%,transparent);padding-top:12px;margin-top:12px}
.cui-popover h3{font-size:12px;font-weight:600;margin:0 0 6px}
.cui-popover p{margin:4px 0;overflow-wrap:anywhere}
.cui-close{all:unset;cursor:pointer;border-radius:4px;padding:2px 6px;line-height:20px;font-size:18px}
.cui-muted{color:var(--color-token-text-secondary,GrayText)}
`
