import { createInterface } from 'node:readline'
const mode = process.argv[2]
let initialized = false
let notified = false
let accountReads = 0
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (mode === 'hang') return
  if (mode === 'exit') process.exit(2)
  if (mode === 'malformed') { console.log('PRIVATE INVALID RAW'); return }
  if (mode === 'oversize') { process.stdout.write('x'.repeat(1_048_577)); return }
  if (request.method === 'initialized') { notified = true; return }
  if (mode === 'rpc-error') { console.log(JSON.stringify({ id: request.id, error: { message: 'SECRET ERROR' } })); return }
  let result: unknown
  if (request.method === 'initialize') { initialized = true; result = {} }
  else if (!initialized || !notified) { process.exit(3) }
  else if (request.method === 'account/read') {
    result = { account: { type: 'chatgpt', email: mode === 'switch' && ++accountReads > 1 ? 'changed' : 'PRIVATE', planType: 'pro' } }
  } else if (request.method === 'account/rateLimits/read') {
    result = { accountId: 'SECRET', rateLimitsByLimitId: { codex: { primary: { windowDurationMins: 10080, usedPercent: 25, resetsAt: 1_800_000_000 } } } }
  } else { process.exit(4) }
  // Unsolicited requests/notifications and mismatched IDs must never resolve a call.
  console.log(JSON.stringify({ method: 'account/login/start', id: 777, params: { token: 'SECRET' } }))
  console.log(JSON.stringify({ id: 999, result: 'WRONG' }))
  const response = JSON.stringify({ id: request.id, result }) + '\n'
  process.stdout.write(response.slice(0, 7))
  process.stdout.write(response.slice(7))
})
