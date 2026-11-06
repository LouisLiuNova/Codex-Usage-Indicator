import { normalize, record, type NormalizedUsage } from '../usage'
import { UsageRequestError } from '../scheduler'
import { CapabilityError, deadline, type HttpClient } from './capabilities'

/** Error projection never retains server messages, response bodies or account identifiers. */
export function requestError(error: unknown, now = Date.now()): UsageRequestError {
  const response = record(error) && record(error.response) ? error.response : null
  const rawStatus = record(error) ? error.status ?? error.statusCode ?? response?.status : null
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : null
  const headers = record(error) ? error.headers ?? response?.headers : null
  let retry: unknown = record(headers) ? headers['retry-after'] ?? headers['Retry-After'] : null
  if (typeof Headers !== 'undefined' && headers instanceof Headers) retry = headers.get('Retry-After')
  let retryAfterMs: number | null = null
  if (status === 429 && typeof retry === 'string' && retry.trim()) {
    if (/^\d+(?:\.\d+)?$/.test(retry.trim())) {
      const milliseconds = Number(retry) * 1000
      if (Number.isFinite(milliseconds)) retryAfterMs = milliseconds
    } else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry.trim())) {
      const timestamp = Date.parse(retry)
      if (Number.isFinite(timestamp)) retryAfterMs = Math.max(0, timestamp - now)
    }
  }
  return new UsageRequestError(status, retryAfterMs)
}

export type ClientDiscovery = (signal: AbortSignal) => Promise<HttpClient[]>

export class WhamProvider {
  private clients: Promise<HttpClient[]> | undefined
  private epoch = 0
  private identity: string | null = null
  private blocked = false
  private stopped = false
  constructor(private discover: ClientDiscovery, private onIdentityChanged: () => void = () => {}) {}
  /** Host ownership uncertainty clears discovery and blocks reads until a confirmed foreground entry. */
  invalidate(block = false) {
    this.epoch++; this.clients = undefined; this.identity = null; this.blocked = block
  }
  stop() { this.stopped = true; this.invalidate(true) }
  async read(signal: AbortSignal): Promise<NormalizedUsage> {
    if (this.stopped || this.blocked || signal.aborted) throw new UsageRequestError()
    const epoch = this.epoch
    try {
      this.clients ??= this.discover(signal)
      const clients = await this.clients
      if (signal.aborted || epoch !== this.epoch || this.stopped) throw new UsageRequestError()
      if (clients.length !== 1) throw new CapabilityError(clients.length ? 'ambiguity' : 'missing')
      const raw = await deadline(clients[0]!.safeGet('/wham/usage'), signal)
      if (signal.aborted || epoch !== this.epoch || this.stopped) throw new UsageRequestError()
      const identity = record(raw) && typeof raw.account_id === 'string' && raw.account_id ? raw.account_id : null
      const changed = this.identity !== null && this.identity !== identity
      this.identity = identity
      if (changed) this.onIdentityChanged()
      return normalize(raw, 'renderer-wham')
    } catch (error) {
      if (epoch === this.epoch) this.clients = undefined
      throw error instanceof UsageRequestError ? error : requestError(error)
    }
  }
}
