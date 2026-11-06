# Windows x64 P0 实测报告

日期：2026-11-05（Asia/Shanghai）。当前结论：**部分通过，尚未达到平台 Go 门槛。**

## 2026-11-06 原生 Renderer 续测

本次已成功通过固定 Loader 进入当前原生 Windows x64 Codex 26.1029.7803.0；监督进程及实际应用进程均回读存活，应用包含 CDP 参数，Loader 完成监听器所有权校验。此前“尚未启动 Loader”的记录仅描述 11 月 5 日采样轮次，不再代表当前状态。

| 项目 | 实际结果 | 结论边界 |
| --- | --- | --- |
| Loader 生命周期 | 本项目探针状态 running；默认示例未启用 | 注入成功，不等于额度或挂载通过 |
| 初次执行 | Composer/rail 均 missing；HTTP 候选为 0 | document-end 仍可能早于宿主 UI 挂载 |
| UI 就绪后通过固定 Loader wrapScript(force) 重载 | Composer 和 rail 各 1 个可见候选，均 code=space；HTTP 候选仍为 0，usage 错误 missing | 排除“仅等待初始挂载即可修复”的解释 |
| 实际视口 | 1118 × 784 CSS px，devicePixelRatio=1.875 | 与早期进程参数的缩放记录分开，不能互相替代 |
| Composer 几何 | bottom≈764，距视口底部≈20px | 当前保守规则要求底部额外 60px，未满足 |
| Rail 几何 | 宽≈52px；容器 bottom≈780，末尾子区 bottom≈776 | 当前规则要求末尾额外 60px，未满足；未改动原生布局 |
| 同源模块结构 | 4 个数字命名 ESM 入口；其中一个导出 __webpack_require__，缓存模块 10298 个、getter 导出 20445 个 | 当前仅扫描前 256 个缓存记录且不执行 getter，零候选不能证明接口本身不存在 |

当前适配器的实测结论为 **No-go**：尚未取得 Renderer 主池样本，未插入任何标记，没有达到原生 Usage 同账号对照或双挂载要求。下一步应先评估当前 Rspack ESM 的缓存导出适配，以及在不破坏原生输入/菜单前提下是否存在可用布局；不得把诊断失败包装成已通过，不直接引入 Rust 或常驻 App Server。

本轮结束时通过 Loader 注册表禁用本项目探针并回读清理结果；监听器、几何与模块诊断均不导出聊天正文、账号、email 或凭据。尚无成功挂载截图、真实键盘/输入/发送验收或 30 分钟稳定性证据。P1 独立核心已另行实现并测试，仍未进行平台整合。

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
