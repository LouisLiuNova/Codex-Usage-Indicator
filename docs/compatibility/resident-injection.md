# 常驻注入与开销验收

2026-11-07。后续交付方向为常驻注入；一次性模式已从macOS加载入口移除。当前仍为开发验收版。

## 实现与复用边界

复用固定Loader 0.6.0的macOS发现/启动、loopback CDP、注册表、bootstrap与脚本启停包装。上游CdpInjector在每次注入后关闭会话，现有监督器也不会检查同一target内丢失的运行时，因此本项目增加一层仅负责保持连接与恢复的适配器；不修改上游源码、不修改安装包、不新增本地HTTP/WebSocket服务。

- 保留一条指向唯一 `app://-/index.html` 主页面的CDP连接；建立或重建连接前核验应用身份、进程家族、loopback监听所有者及端口。不连接头像浮层、嵌入ChatGPT页或无关页面。
- 持有 `Page.addScriptToEvaluateOnNewDocument` 注册，在主文档DOM ready后恢复。执行上下文清空和页面加载事件合并100ms后核对实际运行时。
- 15秒一次轻量运行时检查，健康状态不重新注入、不重建预注册脚本、不启动ps/lsof子进程；额度请求仍每30秒一次。
- 注册表文件变更时同步启停；每60秒重新读取计划作为文件观察失效的兜底。计划未变化时复用注册和连接。
- 断线后按1/2/4/8/15秒封顶退避重新发现目标并核验归属。目标缺失或暂时不可达时记录degraded，不将旧注入回执当作健康证据。
- 开始对外报告running前，实际运行时必须连续3秒保持同一documentId、active和ready。冷启动最多等待60秒，不强杀或自动退出客户端。
- 停止监督器时取消待启动回调、移除预注册脚本、停止Renderer运行时并关闭连接。即使DOMContentLoaded迟到，也不应恢复已停用插件。
- 账号菜单打开时仍清空旧数据并暂停；观察到菜单关闭后等待500ms，再通过已有200ms前台合并入口重新发现当前客户端并取数，不再依赖窗口重新获焦。临时菜单观察器仅在暂停期间存在；菜单打开时focus/online不越过保护，关闭后和停用时回收。
- 新聊天使用独立的 `data-home-feed-composer` 流式适配；透明surface下改读实际body的下缘圆角，保持侧边连续。

协议来源：[Page新文档脚本](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-addScriptToEvaluateOnNewDocument)、[Runtime上下文事件](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#event-executionContextsCleared)。持有连接后的实际恢复与清理以本项目浏览器测试为准。

## 使用

先构建并准备独立注册表，仅启用本项目开发包。Node要求22+，Loader源码仍固定为既有审阅版本，工作树必须干净。

```sh
bun run check
bun run test
bun run build
"$NodeExe" tools/probes/prepare-loader.mjs "$LoaderRoot" dist/plugin "$TestData"
"$NodeExe" tools/probes/load-macos.mjs --check "$LoaderRoot" "$TestData" "$OutputDir"
"$NodeExe" tools/probes/load-macos.mjs --wait "$LoaderRoot" "$TestData" "$OutputDir"
```

`--start`要求客户端已退出；`--wait`等待用户正常退出再启动。客户端已有经验证的调试端口时，可使用以下常驻接入方式：

```sh
"$NodeExe" tools/probes/load-macos.mjs --watch "$LoaderRoot" "$TestData" "$OutputDir" "$Port"
```

长时间运行使用持久TTY或已验证的进程管理器。SIGINT/SIGTERM停止并清理插件。此方案不配置系统登录自启；调试端口仍属于当前受管客户端会话。注册表停用和安全模式会移除当前插件并更新后续文档注册，不能仅隐藏UI。

输出包含有限状态和每15秒一次的 `macos-loader-metrics.json`。指标中的CPU仅为Node监督进程自身，单位微秒；RSS是该进程常驻内存，不包含Codex或测试观察器。`sentBytes`是发送的CDP命令JSON负载字节数，不含协议帧或接收事件，不能当作总网络流量。

## 已验证

环境：macOS 26.6.2（25G83）、arm64、Node 22.23.1、客户端26.1103.31037；监督器源码检查点ad46ec4，菜单恢复修复8ffc74d。资源观察以独立Node监督进程为对象，另有只读观察进程，不将测试观察器计入监督器RSS/CPU。

| 类别 | 结果与边界 |
| --- | --- |
| 类型、单测、构建 | 类型检查、178项测试/407个断言、构建通过 |
| 合成几何矩阵 | 24/24通过；home夹具采用真实发现的底部流式结构和透明surface/body圆角 |
| 常驻浏览器生命周期 | 菜单关闭后无额外focus约795ms恢复，菜单打开时focus/online保持暂停；三次整页重载更换documentId后自动恢复，保持同一连接和预注册；停用跨重载不恢复，再启用恢复；断线重新连接；停止后零挂载和样式，重载不恢复；加载未完成时停止，迟到DOMContentLoaded不启动 |
| 大DOM观察器压力 | 独立Chromium中1万行消息、9000次更新、18000条mutation；观察器回调总计58.3ms/11.24秒（约0.52%墙钟时间），没有额外锚点扫描、挂载拆除或错位。此数字不是原生Codex总CPU或完整性能基准 |
| 真实macOS | 真实新聊天从composer=space、1个slot恢复到composer=ready、双slot；736px等宽、12px重叠、实际新增32px。返回会话页保持双挂载。实机曾出现账号菜单关闭后仍连接中，捕获active、unavailable、coverage=none、请求停在21；调用现有前台重验后请求22、ready恢复。修复已热更新，contextPaused=false、connected、both、双挂载。新旧监督器切换时已回读清理 |
| 30分钟稳定性与资源 | 菜单修复后北京时间2026-11-07 02:27:15–02:57:15，121个实时样本，无异常、重连或补注入；当前会话页数据与几何观察通过，完整前台操作矩阵另验 |

浏览器工具：`tools/probes/check-resident.mjs`、`tools/probes/check-observer-overhead.mjs`。均拒绝非唯一about:blank页，只使用合成Provider；不重载真实用户页面或发送消息。原始报告保存在忽略目录。

## 30分钟资源结果

观察期间保留同一监督进程、同一连接及同一预注册。表中注册计数2包含观察开始前的菜单修复热更新，观察期间没有增长。CPU使用Node累计user+system差值计算，采样窗口约1800秒；不包含观察器或Codex Renderer总CPU。

| 指标 | 实测 |
| --- | --- |
| Node CPU | 约0.0265%单核平均，累计CPU时间0.476秒 |
| Node RSS | 60.8–64.7 MiB，结束64.7 MiB |
| Node已用JS堆 | 13.5 → 11.6 MiB；不以30分钟结果宣称长期无泄漏 |
| 持有连接/注册计数 | 连接1→1，注册2→2；新增重连、补注入、失败均为0 |
| 健康检查 | 120次；发送的CDP命令JSON负载约60.8 KiB，非总网络流量 |
| 真实额度轮询 | 读取计数增加58次；始终ready/both，未再次卡在账号上下文暂停 |
| 实时页面 | 121个样本，双挂载、等宽、12px重叠；无异常复核结果，documentId未变化 |

结论：当前macOS构建的常驻成本主要是约65 MiB的Node内存，稳定健康路径CPU开销很低。该观察覆盖当前真实会话页与数据/几何状态，不替代完整前台交互、休眠、账号切换或跨平台性能矩阵。独立Chromium压力测试的观察器回调耗时也不能替代原生Renderer总CPU测量。

先前长时观察因实机连接暂停问题中断，不计作最终通过。曾出现两条缓存Composer缺失样本；短时独立诊断捕获页面切换时slot在约112ms内恢复，未据此确认持续漏挂载。最终观察改为读取实时页面状态，暂态延迟1200ms复核，不仅凭缓存slot计数判定。原始记录保留在忽略目录。

## 仍待验证

真实客户端整页重载由用户操作完成后回读；完整macOS/Windows主题、尺寸、系统缩放、键盘、账号切换、真实Weekly-only及Windows ARM64矩阵仍未完成。合成浏览器的百毫秒恢复不能直接作为真实客户端恢复SLA。macOS冷启动的代码已接入同一常驻实现，但不能将热接入成功当作全量冷启动实测。
