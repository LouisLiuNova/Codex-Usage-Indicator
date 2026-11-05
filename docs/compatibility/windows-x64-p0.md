# Windows x64 P0 实测报告

日期：2026-11-05（Asia/Shanghai）。当前结论：**部分通过，尚未达到平台 Go 门槛。**

## 真实环境

- 当前原生应用：Codex 26.1029.7803.0，Windows x64；进程参数中的设备缩放为 1.5、语言为 zh-CN，主题未采集。未导出完整命令行、用户目录或账号标识。
- 当前应用启动未包含 remote-debugging 参数；尚未安装或启动 Loader，未重启应用、未注入 Renderer。
- 探针使用已有原生 Windows Node 24.22.1 和原生 Codex CLI，通过 WSL 调用 Windows 可执行文件。数据请求发生于原生 Windows App Server，不以 WSL CLI 失败替代本结果。
- 两次原生探针均完成 initialize → initialized → account/read → account/rateLimits/read → account/read；账号只在内存比较，不导出身份。

## 白名单采样

以下是同一实现连续两次真实请求，不是 UI 截图或原生 Usage 对照。Unix 时间单位为秒；fetchedAt 为客户端成功取得时间。

| 采样 | requestedAt | fetchedAt | 300 分钟 used / remaining / reset | 10080 分钟 used / remaining / reset |
| --- | --- | --- | --- | --- |
| 1 | 1793853378 | 1793853381 | 40 / 60 / 1793858593 | 66 / 34 / 1793929409 |
| 2 | 1793853490 | 1793853492 | 41 / 59 / 1793858593 | 66 / 34 / 1793929409 |

两次主池识别为 both、quality=normal；第二次 5H 消耗增加属于独立采样事实，不据此判冲突。探针完成后原生进程清单中匹配探针启动参数的独立 App Server 数为 0。未验证该连接的通知能力，明确为 polling-only。

## 自动化验证

- TypeScript 严格类型检查通过。
- 85 项测试通过（142 个断言；以后以当前测试输出为准）：数据边界、账号变化、stdio 分块、超时/退出/协议错误、脱敏、模块能力识别、锚点拒绝条件、插入后重叠回滚、CJS 生命周期、Node bundle 入口。
- Bun Renderer CJS 与 Node ESM bundle 构建通过。
- 固定 Loader b6ec28c69af12e9667f57d19823fb46d225756e4 的 `loadScriptDescriptor` 实际接受生成包，runAt=document-end、permissions=[dom]；不是仅自行检查字段。
- 原生 Windows Node 运行独立 Loader 注册表准备脚本成功，探针 enabled=true、上游默认示例 enabled=false；只初始化临时测试目录，未启动 Loader 会话。Linux 重复运行同一准备目录会拒绝继续，避免覆盖现有插件状态。
- happy-dom 模拟几何用于生命周期单测；未运行真实浏览器 E2E。模拟 DOM 不能证明原生布局、焦点或输入/发送行为。
- 同一探针在 WSL 默认 CLI 环境初始化阶段退出，错误码 exit；未导出原始 stderr，该失败不推断为认证问题。

## 未通过的门槛

尚无 Renderer `/wham/usage` 样本、与原生 Usage 的同账号同时段对照、唯一真实锚点诊断、UI 截图、双挂载视觉/输入/发送/焦点验证、启停/任务重建实测、两主题与尺寸/缩放验证、真实网络/限流结果、30 分钟稳定性观察。

因此 Windows P0 不能标通过，P1/P2 平台整合与 P3 正式发布尚未开始。macOS Apple Silicon 与 Windows ARM64 均未验证，不能继承 x64 独立 App Server 结果。
