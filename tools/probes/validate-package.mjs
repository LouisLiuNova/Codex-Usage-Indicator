// Validate a development package in a fresh, disposable registry. Never attach to a live Loader.
import path from 'node:path'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const [loaderRoot, packageRoot] = process.argv.slice(2)
const report = { schemaVersion: 1, platform: process.platform, arch: process.arch, node: process.version,
  status: 'failed', code: 'arguments', checks: [], cleaned: false }
let scratch
const check = (name, condition) => {
  if (!condition) throw new Error('package-check')
  report.checks.push(name)
}
try {
  if (!loaderRoot || !packageRoot) throw new Error('arguments')
  report.code = 'loader'
  const root = path.resolve(loaderRoot)
  const loader = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (loader.name !== 'codex-script-loader' || loader.version !== '0.6.0') throw new Error('loader')
  const { ScriptRegistry } = await import(pathToFileURL(path.join(root, 'src/registry.mjs')).href)
  const { loadScriptDescriptor } = await import(pathToFileURL(path.join(root, 'src/manifest.mjs')).href)
  report.code = 'descriptor'
  const descriptor = await loadScriptDescriptor(path.resolve(packageRoot))
  check('manifest', descriptor.id === 'local.codex-usage-indicator' && descriptor.runAt === 'document-end'
    && descriptor.lifecycleGlobal === '__codexUsageIndicatorRuntime' && descriptor.documentation === 'README.md'
    && descriptor.settingsMode === 'none' && JSON.stringify(descriptor.permissions) === '["dom"]')
  for (const file of ['index.js', 'manifest.json', 'README.md', 'LICENSE', 'NOTICE.md'])
    await access(path.join(descriptor.directory, file))
  check('required-files', true)
  scratch = await mkdtemp(path.join(tmpdir(), 'cui-package-validation-'))
  let registry = await new ScriptRegistry(scratch).init()
  report.code = 'install'
  await registry.install(descriptor.directory, { enabled: false })
  // Reload from disk after each mutation rather than trusting returned in-memory state.
  const reload = async () => { registry = await new ScriptRegistry(scratch).init(); return registry.list() }
  let scripts = await reload()
  check('install-disabled', scripts.length === 1 && scripts[0].enabled === false && scripts[0].fingerprint === descriptor.fingerprint)
  report.code = 'enable'
  await registry.setEnabled(descriptor.id, true); scripts = await reload()
  check('enable', scripts[0]?.enabled === true && (await registry.buildPlan()).descriptors.length === 1)
  report.code = 'disable'
  await registry.setEnabled(descriptor.id, false); scripts = await reload()
  check('disable', scripts[0]?.enabled === false && (await registry.buildPlan()).descriptors.length === 0)
  await registry.setEnabled(descriptor.id, true)
  report.code = 'quarantine'
  const removed = await registry.quarantineScript(descriptor.id)
  scripts = await reload()
  check('quarantine-removal', scripts.length === 0 && (await registry.listQuarantined()).length === 1)
  report.code = 'restore'
  await registry.restoreQuarantined(removed.key); scripts = await reload()
  check('restore', scripts.length === 1 && scripts[0].enabled === true && scripts[0].fingerprint === descriptor.fingerprint
    && (await registry.listQuarantined()).length === 0)
  report.status = 'passed'; delete report.code
} catch {
  process.exitCode = 1
} finally {
  if (scratch) {
    try { await rm(scratch, { recursive: true, force: true }); report.cleaned = true }
    catch { report.status = 'failed'; report.code = 'cleanup'; process.exitCode = 1 }
  }
  console.log(JSON.stringify(report))
}
