// Explicitly authorized one-shot restart. Run --check before --arm.
import { spawn, spawnSync } from 'node:child_process'
import { openSync, closeSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [mode, loaderArg, dataArg, outputArg, pidArg] = process.argv.slice(2)
if (process.platform !== 'win32') throw new Error('此工具仅支持原生 Windows Node')
if (!['--check', '--arm', '--worker'].includes(mode)) throw new Error('需要 --check、--arm 或 --worker')
const loader = path.resolve(loaderArg), data = path.resolve(dataArg), output = path.resolve(outputArg)
const targetPid = Number(pidArg)
if (!Number.isSafeInteger(targetPid) || targetPid <= 0) throw new Error('需要已核对的 Codex 主进程 PID')
const { validateWindowsPackage, listWindowsCodexProcesses } = await import(pathToFileURL(path.join(loader, 'src/windows-platform.mjs')).href)
const pkg = JSON.parse(readFileSync(path.join(loader, 'package.json'), 'utf8'))
if (pkg.version !== '0.6.0') throw new Error('Loader 版本不匹配')
// Query the registered package instead of enumerating the protected WindowsApps directory.
const query = spawnSync('powershell.exe', ['-NoProfile', '-Command',
  "Get-AppxPackage -Name OpenAI.Codex | Select-Object @{n='installLocation';e={$_.InstallLocation}},@{n='packageFamilyName';e={$_.PackageFamilyName}},@{n='version';e={$_.Version.ToString()}} | ConvertTo-Json -Compress"],
{ encoding: 'utf8', windowsHide: true, timeout: 15_000 })
if (query.status !== 0) throw new Error('无法读取已注册的 Codex 包')
const packageInfo = validateWindowsPackage(JSON.parse(query.stdout))
const processes = await listWindowsCodexProcesses(packageInfo)
if (!processes.some(p => p.processId === targetPid)) throw new Error('指定 Codex 进程已经退出；不执行重启')
const stateFile = path.join(output, 'restart-state.json')
const state = value => writeFileSync(stateFile, JSON.stringify({ ...value, at: new Date().toISOString() }, null, 2))
const args = ['--worker', loader, data, output, String(targetPid)]
if (mode === '--check') {
  console.log(JSON.stringify({ ready: true, platform: 'win32', loaderVersion: pkg.version, appVersion: packageInfo.version, targetPid }))
} else if (mode === '--arm') {
  if (existsSync(stateFile)) {
    const previous = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (previous.workerPid) {
      try { process.kill(previous.workerPid, 0); throw new Error('重启监督进程仍在运行；禁止重复安排') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  const fd = openSync(path.join(output, 'restart-supervisor.log'), 'a')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  child.unref(); closeSync(fd)
  state({ status: 'armed', workerPid: child.pid, targetPid, delaySeconds: 30 })
  console.log(JSON.stringify({ armed: true, workerPid: child.pid, delaySeconds: 30 }))
} else {
  await new Promise(resolve => setTimeout(resolve, 30_000))
  state({ status: 'closing', workerPid: process.pid, targetPid })
  // Normal window close only. Never force-kill Codex or its running tasks.
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$p = Get-Process -Id ${targetPid} -ErrorAction Stop; if ($p.ProcessName -notin @('ChatGPT','Codex')) { exit 2 }; if (-not $p.CloseMainWindow()) { exit 3 }`],
  { windowsHide: true, encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0) {
    state({ status: 'close-failed', workerPid: process.pid, code: result.status })
    process.exit(1)
  }
  const until = Date.now() + 45_000
  while ((await listWindowsCodexProcesses(packageInfo)).length && Date.now() < until)
    await new Promise(resolve => setTimeout(resolve, 1000))
  if ((await listWindowsCodexProcesses(packageInfo)).length) {
    // Request normal closure of the package process tree; deliberately omit /F.
    state({ status: 'closing-process-tree', workerPid: process.pid, targetPid })
    spawnSync('taskkill.exe', ['/PID', String(targetPid), '/T'], { windowsHide: true, timeout: 10_000, stdio: 'ignore' })
    const treeUntil = Date.now() + 15_000
    while ((await listWindowsCodexProcesses(packageInfo)).length && Date.now() < treeUntil)
      await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if ((await listWindowsCodexProcesses(packageInfo)).length) {
    state({ status: 'close-timeout', workerPid: process.pid }); process.exit(1)
  }
  state({ status: 'starting-loader', workerPid: process.pid })
  const { startWindowsLiveRuntime } = await import(pathToFileURL(path.join(loader, 'src/live-runtime.mjs')).href)
  const abort = new AbortController()
  process.once('SIGINT', () => abort.abort())
  process.once('SIGTERM', () => abort.abort())
  try {
    const runtime = await startWindowsLiveRuntime({ dataRoot: data, signal: abort.signal,
      dependencies: { discoverWindowsCodex: async () => packageInfo } })
    state({ status: 'loader-running', workerPid: process.pid, port: runtime.port })
    try { await runtime.run({ signal: abort.signal }) }
    finally { await runtime.close() }
    state({ status: 'loader-exited', workerPid: process.pid })
  } catch {
    if (!(await listWindowsCodexProcesses(packageInfo)).length) {
      const fallback = spawn(packageInfo.executable, [], { detached: true, stdio: 'ignore', windowsHide: false })
      fallback.unref()
    }
    state({ status: 'loader-start-failed', workerPid: process.pid })
    process.exitCode = 1
  }
}
