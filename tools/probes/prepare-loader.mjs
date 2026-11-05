// Prepare an isolated test registry without launching or stopping Codex.
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const [loaderRoot, probePackage, dataRoot] = process.argv.slice(2)
if (!loaderRoot || !probePackage || !dataRoot) {
  console.error('用法：node prepare-loader.mjs <已审阅的固定 Loader 目录> <dist/probe> <独立测试数据目录>')
  process.exitCode = 1
} else {
  const root = path.resolve(loaderRoot)
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (pkg.name !== 'codex-script-loader' || pkg.version !== '0.6.0') throw new Error('需要已审阅的固定 Loader 0.6.0 源码')
  const { ScriptRegistry } = await import(pathToFileURL(path.join(root, 'src/registry.mjs')).href)
  const { ensureBundledPackages } = await import(pathToFileURL(path.join(root, 'src/bundled.mjs')).href)
  const registry = await new ScriptRegistry(path.resolve(dataRoot)).init()
  // Never reuse an existing populated registry: this helper must not change production plugin state.
  if ((await registry.list()).length) throw new Error('请使用空的独立测试目录；未修改已有插件')
  await ensureBundledPackages(registry)
  for (const script of await registry.list()) await registry.setEnabled(script.id, false)
  await registry.install(path.resolve(probePackage), { enabled: true })
  console.log(JSON.stringify({ prepared: true, launched: false,
    scripts: (await registry.list()).map(({ id, enabled }) => ({ id, enabled })) }))
}
