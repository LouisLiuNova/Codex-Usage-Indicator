# Codex Usage Indicator

Codex Desktop 轻量用量指示器，按真实主账号窗口显示剩余额度。**当前处于开发与技术验证，尚非可发布插件。**

当前实现、实测范围和未完成门槛集中记录在[当前状态](docs/当前状态.md)。历史过程记录不作为最新完成声明。

当前 UI 目标：输入框外侧下方显示等宽圆角矩形静态文字栏，与输入框部分重叠、无间隙；原生框覆盖在上，仅露出底层卡片下缘，侧边连续，文字靠右，无悬停或点击交互；圆环和详情入口仅在侧栏，详见 [UI设计决策](docs/UI设计决策.md)。只有 Weekly 时三个位置均移除完整5H项，不显示占位。

已实现严格窗口校验、独立 App Server 探针、Renderer 能力与双挂载诊断、可撤销测试标记和 Loader CJS 构建。Pro 仅 Weekly 按正常场景处理，不伪造 5H。开发版已连接 Store、Scheduler、Renderer Provider、文字栏、侧栏圆环及共享详情。

原生 Windows 已完成真实额度轮询、结构变化触发检查、Loader 热重载及停用清理验证；Esc关闭与焦点返回由用户人工确认。另有一次明确版本的30分钟后台观察，不能替代最新版本的完整前台使用验收。页面重建、账号切换、完整键盘与跨平台矩阵仍未完成。

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
bun run probe:app-server
```

构建生成 `dist/plugin`（可手动加载的开发版插件）、`dist/probe`（Renderer 探针）与 `dist/app-server-probe.mjs`（可由原生 Node 执行）。输出是有限白名单数据和诊断码，不读取或复制凭据文件。构建产物不入库，不生成正式 v0.1.0 发布 ZIP。开发版使用和限制见 [插件说明](plugin/README.md)。

- [实施进度与平台门槛](docs/实施进度.md)
- [原方案逐项验收矩阵](docs/验收矩阵.md)
- [探针运行与卸载说明](tools/probes/README.md)
- [Windows P0 实测报告](docs/compatibility/windows-x64-p0.md)
- [macOS Apple Silicon 加载与实测](docs/compatibility/macos-arm64.md)
- [开发包与Loader注册表检查](docs/compatibility/package-contract.md)
- [Chromium生命周期夹具](docs/compatibility/browser-fixture.md)
- [Windows后台稳定性记录](docs/compatibility/windows-x64-stability.md)
- [首次接入Loader的历史步骤](docs/compatibility/继续实机验证.md)
- [来源与复用边界](docs/参考来源.md)

本项目不隶属于 OpenAI。Loader/CDP 与内部 HTTP/DOM 依赖目标客户端实现；没有对应实机证据的平台不宣称兼容。
