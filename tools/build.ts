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
const plugin = await Bun.build({ entrypoints: ['plugin/src/index.ts'], target: 'browser', format: 'cjs',
  outdir: 'dist/plugin', naming: 'index.js', minify: false })
if (!plugin.success) throw new Error('开发版插件构建失败')
for (const [from, to] of [['plugin/manifest.json', 'manifest.json'], ['plugin/README.md', 'README.md'], ['LICENSE', 'LICENSE'], ['NOTICE.md', 'NOTICE.md']])
  await cp(from!, `dist/plugin/${to}`)
console.log('已构建 P0 工具及可手动加载的开发版插件；未生成正式发布 ZIP。')
