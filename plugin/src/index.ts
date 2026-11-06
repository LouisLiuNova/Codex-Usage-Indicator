import { createRuntime, type RuntimeHandle } from './runtime'
let current: RuntimeHandle | undefined
function stop() { const previous = current; current = undefined; previous?.stop() }
function start() {
  stop()
  const runtime = createRuntime(document)
  current = runtime
  return () => { if (current === runtime) stop() }
}
module.exports = { start, stop }
