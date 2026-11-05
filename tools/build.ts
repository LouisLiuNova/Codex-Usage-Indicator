import { cp, mkdir } from 'node:fs/promises'
const renderer = await Bun.build({ entrypoints: ['tools/probes/renderer.ts'], target: 'browser',
  format: 'cjs', outdir: 'dist/probe', naming: 'index.js', minify: false })
if (!renderer.success) throw new Error('Renderer 探针构建失败')
await mkdir('dist/probe', { recursive: true })
await cp('tools/probes/manifest.json', 'dist/probe/manifest.json')
await cp('tools/probes/README.md', 'dist/probe/README.md')
await cp('LICENSE', 'dist/probe/LICENSE')
const native = await Bun.build({ entrypoints: ['tools/probes/app-server.ts'], target: 'node', format: 'esm',
  outdir: 'dist', naming: 'app-server-probe.mjs' })
if (!native.success) throw new Error('App Server 探针构建失败')
console.log('已构建 P0 探针；未生成正式发布包。')
