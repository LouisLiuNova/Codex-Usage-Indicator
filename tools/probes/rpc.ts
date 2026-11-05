import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { record, sample } from '../../plugin/src/usage'

export type ProbeCode = 'spawn' | 'timeout' | 'exit' | 'protocol' | 'rpc' | 'account-changed' | 'account-unconfirmed'
export class ProbeError extends Error {
  constructor(readonly code: ProbeCode) { super(code) }
}

/** Finite, single-flight, read-only protocol. Raw stderr/errors/identities are never exported. */
export async function probeAppServer(command = 'codex', timeoutMs = 15_000) {
  const requestedAt = Math.floor(Date.now() / 1000)
  const child = spawn(command, ['app-server', '--listen', 'stdio://'], { stdio: 'pipe', windowsHide: true })
  const rpc = new ReadRpc(child, timeoutMs)
  try {
    await rpc.call('initialize', { clientInfo: { name: 'codex_usage_indicator_probe', version: '0.0.0-p0.1' },
      capabilities: { experimentalApi: false } })
    rpc.notifyInitialized()
    const before = await rpc.call('account/read', { refreshToken: false })
    const raw = await rpc.call('account/rateLimits/read', {})
    // Read again to avoid accepting a snapshot collected across an account change.
    const after = await rpc.call('account/read', { refreshToken: false })
    const identity = (v: unknown) => record(v) && record(v.account) && v.account.type === 'chatgpt'
      ? v.account : null
    const a = identity(before), b = identity(after)
    if (!a || !b) throw new ProbeError('account-unconfirmed')
    // This bounds a local probe session; it is not proof of Desktop/Renderer identity equality.
    if (a.email !== b.email || a.planType !== b.planType || a.workspaceName !== b.workspaceName)
      throw new ProbeError('account-changed')
    return { schemaVersion: 1, provider: 'app-server', requestedAt, fetchedAt: Math.floor(Date.now() / 1000),
      identity: 'desktop-comparison-required', eventMode: 'polling-only', ...sample(raw, 'app-server') }
  } finally { await rpc.close() }
}

export class ReadRpc {
  private nextId = 0
  private buffer = ''
  private closed = false
  private failure: ProbeError | undefined
  private pending: { id: number; resolve: (v: unknown) => void; reject: (e: ProbeError) => void; timer: ReturnType<typeof setTimeout> } | undefined
  constructor(private child: ChildProcessWithoutNullStreams, private timeoutMs: number) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', this.onData)
    child.stderr.resume() // drain, but never expose arbitrary server logs
    child.on('error', this.onError)
    child.on('exit', this.onExit)
    child.stdin.on('error', this.onError)
  }
  private fail = (code: ProbeCode) => {
    this.failure = new ProbeError(code)
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(this.failure)
      this.pending = undefined
    }
  }
  private onError = () => this.fail('spawn')
  private onExit = () => this.fail('exit')
  private onData = (chunk: string) => {
    this.buffer += chunk
    if (this.buffer.length > 1_048_576) { this.fail('protocol'); return }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message: unknown
      try { message = JSON.parse(line) } catch { this.fail('protocol'); return }
      if (!record(message)) { this.fail('protocol'); return }
      // Never execute unsolicited server requests or notifications.
      if ('method' in message || !this.pending || message.id !== this.pending.id) continue
      const p = this.pending
      this.pending = undefined
      clearTimeout(p.timer)
      if ('error' in message) p.reject(new ProbeError('rpc'))
      else if (!('result' in message)) p.reject(new ProbeError('protocol'))
      else p.resolve(message.result)
    }
  }
  call(method: 'initialize' | 'account/read' | 'account/rateLimits/read', params: Record<string, unknown>): Promise<unknown> {
    if (this.closed || this.failure || this.pending) return Promise.reject(this.failure ?? new ProbeError('protocol'))
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => this.fail('timeout'), this.timeoutMs)
      this.pending = { id, resolve, reject, timer }
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  notifyInitialized() {
    if (this.failure || this.closed) throw this.failure ?? new ProbeError('exit')
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
  }
  async close() {
    if (this.closed) return
    this.closed = true
    this.fail('exit')
    this.child.stdin.end()
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve() }, 500)
        this.child.once('close', () => { clearTimeout(timer); resolve() })
        this.child.kill()
      })
    }
    this.child.stdout.off('data', this.onData)
    this.child.off('exit', this.onExit)
    // Error listeners remain attached until streams close to consume late EPIPE.
  }
}
