# macOS Apple Silicon 开发加载

2026-11-06：macOS 26.6.2 / arm64；客户端 26.1029.61003（24614），应用名为 ChatGPT.app，bundle ID 为 com.openai.codex。真实 Renderer 加载、双挂载、局部交互和停用恢复已通过；完整平台验收仍未完成。

## 已验证与修复

- Bun 1.3.13 下依赖安装、类型检查及构建通过；2026-11-07后续修订类型检查与165项测试（371个断言）通过。
- 默认临时目录使用 /var 路径，而 Node 的模块 URL 使用 /private/var；App Server 探针现使用 realpath 判断入口，并添加符号链接回归检查。
- 客户端自带 CLI 0.166.0-alpha.6 的独立 App Server 探针取得主池双窗口正常结果。该结果不证明 Renderer 与 Desktop 账号相同，也不作为插件备用数据源。
- Node 22.23.1 下固定 Loader 的隔离注册表安装、启用、禁用、移除、恢复检查通过；默认 Node 20 不满足 Loader 的 Node >=22 要求。
- 固定 Loader 0.6.0 默认只发现 Codex.app。项目入口复用其 discoverMacCodex，补充 ChatGPT.app 候选并校验 bundle ID；不修改上游源码或客户端安装包。
- 本机有旧版本遗留的独立 Crashpad 进程。加载入口仅排除 Helpers/browser_crashpad_handler，继续检查主进程和 Renderer 等其他进程，并保留上游 CDP 监听所有权检查；不结束遗留进程。

## 加载入口

使用固定 Loader 源码 b6ec28c69af12e9667f57d19823fb46d225756e4 和原生 Node 22+。Loader 工作树必须干净。先构建，再准备空的独立注册表，默认示例保持禁用，仅启用本项目开发包。

```sh
bun run check
bun run test
bun run build
"$NodeExe" tools/probes/prepare-loader.mjs "$LoaderRoot" dist/plugin "$TestData"
"$NodeExe" tools/probes/load-macos.mjs --check "$LoaderRoot" "$TestData" "$OutputDir"
"$NodeExe" tools/probes/load-macos.mjs --start "$LoaderRoot" "$TestData" "$OutputDir"
```

`--start` 在客户端仍运行时拒绝启动。`--wait` 最多等待30分钟，用户正常退出客户端后复用上游 startMacLiveRuntime 启动；不发送关闭或强杀请求。等待模式应由持久 TTY 或已验证的进程管理器承载，不能只后台启动后假定存活。

输出目录中的 macos-loader-state.json 仅记录阶段、监督进程号、版本和本地端口。`running` 表示上游启动流程返回，仍须回读实际进程、loopback 端口、Renderer 运行时状态、双挂载与额度；不能直接当作完整 UI 验收。关闭监督进程会调用上游回收。重复工作进程会被拒绝。

## 真实客户端验证

用户正常退出后，launchd 监督任务于北京时间2026-11-06 23:52启动客户端并进入 running。已分别回读监督进程、客户端父子进程和客户端持有的 IPv4 loopback CDP 监听；唯一目标为上游要求的 app Renderer。独立注册表仅启用本项目开发包，示例禁用。

| 检查 | 本机结果与范围 |
| --- | --- |
| Renderer 数据读取 | active=true、ready、coverage=both；后续样本显示真实额度变化，不使用 App Server 补数据 |
| 双挂载 | Composer 与 rail 均 ready，slots=2；视口1912×1047 CSS px、devicePixelRatio=2，截图核对为深色界面 |
| 静态文字栏 | 5H/Weekly 与侧栏显示一致，Composer 内无插件按钮或 tabindex 入口 |
| 原生鼠标 | CDP Input 点击圆环打开详情，卡片可见且在视口内；切换第二入口复用同一详情并更新展开状态 |
| Esc 与焦点 | CDP Input Escape 关闭详情，焦点返回 Weekly 触发圆环 |
| 详情内容 | 已连接、双窗口剩余量、绝对重置时间、UTC+08:00、更新时间及每30秒刷新说明可见 |
| 真实停用 | 通过隔离注册表禁用，宿主自动移除运行时、两个slot、样式和详情；对应节点计数均为0 |
| 重新启用 | 真实数据重新取得，双挂载恢复、仅1份样式，Loader错误计数0；测试结束保持启用 |
| 后续轮询 | 重新启用后间隔31秒采样，请求计数2→3，两次均ready、双挂载、1份样式、Loader错误计数0；仅为短时轮询证据 |

本地截图和有限诊断保存在忽略的 artifacts 目录，不进入远端。未发送测试消息或切换账号。

完整键盘、两主题、尺寸/缩放、页面重建、账号切换、Weekly-only真实账号、三方同归属对照及30分钟稳定性仍待验证；本次短时观察不能替代这些门槛。未生成正式发布包。

## 一次性加载实验（2026-11-07）

新增 `--once` 与 `--wait-once`：仍复用固定 Loader 的启动、归属校验及注入实现，确认唯一插件状态为 running 后关闭宿主桥接和CDP连接，然后退出 Node。前者要求客户端已退出；后者等待用户退出。此模式不启动监督循环，不承诺插件管理UI、热重载、新窗口或完整页面重载后的自动恢复。停止插件可退出客户端；注册表变更不再由常驻监督器自动应用。

```sh
"$NodeExe" tools/probes/load-macos.mjs --wait-once "$LoaderRoot" "$TestData" "$OutputDir"
```

`injected` 是注入流程返回并关闭宿主后的记录；必须另行核对进程确已退出、Renderer状态及后续真实取数，不能仅凭记录宣称零常驻已验收。

独立无头 Chromium、about:blank 与模拟 Weekly-only Provider 实验：使用实际 createRuntime，独立注入器进程退出码为0，断开后运行时继续ready，间隔31秒请求计数1→2；页面重载后运行时为null，未自动恢复。该结果仅证明页面内运行时不依赖注入器常驻，不能替代真实客户端额度、双挂载、页面切换或休眠恢复验收。

实验可复用 `tools/probes/check-once.mjs`，参数为固定Loader目录、独立Chromium端口和实际runtime的CJS构建文件。工具拒绝非唯一about:blank页面；测试使用合成额度，不对真实客户端执行Page.reload。本地有限结果保存在忽略的 artifacts 目录。

### 真实页面补充验证与限制

客户端已更新至26.1103.31037。首次启动时曾记录injected，但后续实际Renderer没有运行时；原因尚未确认，不能凭早期注入状态判断可见。另发现launchctl submit任务会在成功退出后重启等待进程，已移除此任务；一次性模式不能直接使用该启动方式宣称零常驻。

新增 `--inject-once <LoaderRoot> <TestData> <OutputDir> <Port>`，用于客户端已有调试端口时向当前页面注入；无端口时不绕过客户端重启要求。此路径核对loopback监听归属，包含宿主的真实子进程（本机Computer Use辅助进程继承了监听描述符），拒绝无关进程；复用上游bootstrap、生命周期、单包wrap及CdpInjector，不加载依赖常驻桥接的管理UI。

北京时间2026-11-07 01:18—01:19：向当前真实页面重新注入成功，注入进程及旧等待进程均确认退出。独立检查间隔31秒，请求计数1→2、ready、coverage=both、双slot和1份样式持续存在；真实5H剩余99%→98%、Weekly 69%。截图确认侧栏圆环和输入框下方文字均可见。这是当前稳定页面的短时零常驻加载证据；启动期页面切换、重载、新窗口恢复仍未通过。
