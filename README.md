# Codex Usage Indicator

Codex Desktop 轻量用量指示器，按真实主账号窗口显示剩余额度。**当前处于 P0 技术验证，尚非可发布插件。**

已实现严格窗口校验、独立 App Server 探针、Renderer 能力与双挂载诊断、可撤销测试标记和 Loader CJS 构建。Pro 仅 Weekly 按正常场景处理，不伪造 5H。正式 Store/Scheduler、圆环、共享 Popover 和发布流程须在对应平台 P0 通过后实施。

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
bun run probe:app-server
```

构建生成 `dist/probe`（手动加载的 Renderer 探针）与 `dist/app-server-probe.mjs`（可由原生 Node 执行）。输出是有限白名单数据和诊断码，不读取或复制凭据文件。构建产物不入库，不生成正式 v0.1.0 发布 ZIP。

- [实施进度与平台门槛](docs/实施进度.md)
- [探针运行与卸载说明](tools/probes/README.md)
- [Windows P0 实测报告](docs/compatibility/windows-x64-p0.md)
- [继续实机验证的步骤](docs/compatibility/继续实机验证.md)
- [来源与复用边界](docs/参考来源.md)

本项目不隶属于 OpenAI。Loader/CDP 与内部 HTTP/DOM 依赖目标客户端实现；没有对应实机证据的平台不宣称兼容。
