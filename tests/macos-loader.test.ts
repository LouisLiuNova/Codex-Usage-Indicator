import { expect, test } from 'bun:test'
// @ts-expect-error The native Node launcher is intentionally an untranspiled mjs entry.
import { withoutCrashReporters, processFamily } from '../tools/probes/load-macos.mjs'

test('macOS 仅忽略独立 Crashpad，保留主进程、Renderer 及同名参数', () => {
  const processes = [
    { processId: 1, command: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' },
    { processId: 2, command: '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/152/Helpers/browser_crashpad_handler --monitor-self' },
    { processId: 3, command: '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/156/Helpers/Codex (Renderer)' },
    { processId: 4, command: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --label=browser_crashpad_handler' }
  ]
  expect(withoutCrashReporters(processes).map((p: { processId: number }) => p.processId)).toEqual([1, 3, 4])
  expect(processes.length).toBe(4)
})

test('监听归属接受宿主的多层子进程，拒绝无关联和孤立进程', () => {
  expect([...processFamily([10], [[30, 20], [20, 10], [40, 1], [50, 99]])].sort((a, b) => a - b)).toEqual([10, 20, 30])
})
