import { expect, test } from 'bun:test'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import manifest from '../tools/probes/manifest.json'

test('manifest 使用当前 Loader 合同与最小权限', () => {
  expect(manifest.schemaVersion).toBe(1)
  expect(manifest.runAt).toBe('document-end')
  expect(manifest.permissions).toEqual(['dom'])
  expect(manifest.documentation).toBe('README.md')
  expect(manifest.settings.mode).toBe('none')
})
test('App Server bundle 可由 Node 执行且错误脱敏', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cui-build-'))
  try {
    const build = await Bun.build({ entrypoints: ['tools/probes/app-server.ts'], target: 'node', format: 'esm', outdir: dir, naming: 'probe.mjs' })
    expect(build.success).toBe(true)
    const run = spawnSync('node', [join(dir, 'probe.mjs'), '/missing/PRIVATE'], { encoding: 'utf8', timeout: 3000 })
    expect(run.status).toBe(1)
    expect(JSON.parse(run.stdout)).toEqual({ schemaVersion: 1, provider: 'app-server', status: 'failed', code: 'spawn' })
    expect(run.stdout + run.stderr).not.toContain('PRIVATE')
    if (process.platform !== 'win32') {
      // Node resolves the module URL, but keeps the symlink spelling in argv[1].
      await symlink(join(dir, 'probe.mjs'), join(dir, 'linked.mjs'))
      const linked = spawnSync('node', [join(dir, 'linked.mjs'), '/missing/PRIVATE'], { encoding: 'utf8', timeout: 3000 })
      expect(linked.status).toBe(1)
      expect(JSON.parse(linked.stdout)).toEqual({ schemaVersion: 1, provider: 'app-server', status: 'failed', code: 'spawn' })
      expect(linked.stdout + linked.stderr).not.toContain('PRIVATE')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
