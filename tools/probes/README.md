# 用量指示器 P0 探针

仅用于技术验收，尚非正式插件。固定 Loader 0.6.0 / b6ec28c69af12e9667f57d19823fb46d225756e4；真实兼容仍待验证。当前实现拒绝非 app 页面、歧义 HTTP 客户端、非唯一锚点、空间不足与可见原生菜单。两个锚点都满足检查才插入 P0 标记；无重试、无观察器、无后台轮询。未发现锚点时也会独立测试数据能力。

## 构建与启用

1. 在项目运行 `bun install --frozen-lockfile`、`bun run check`、`bun test`、`bun run build`。
2. 审阅构建目录 `dist/probe`。通过已审阅的固定 Loader 手动加载该目录，不使用正式发布通道。
3. 启用后在 Loader 插件日志读取 `anchors`、`capabilities` 与脱敏 `renderer-wham` 记录；只允许固定 GET `/wham/usage`。没有通用 URL、RPC、凭据文件或存储接口。
4. 比对原生 Usage 的周期、剩余值和 reset；仅 Weekly 不视为故障。身份只能由测试者在同一客户端上下文核对，日志不导出 email/accountId/token。
5. 观察两个标记的位置、输入框边界、键盘焦点、发送和原生菜单。任务切换、主题/缩放变化后禁用再启用重新采样。诊断为 ready 只是几何前置条件，不能代替视觉验收。
6. Loader 禁用调用 `stop`，取消异步结果并删除标记；重复启停、热重载后确认无 `[data-cui-probe]` 残留。探针不写浏览器存储、配置或安装目录。

## 独立 App Server

`bun run probe:app-server [codex 可执行文件路径]`；构建后也可 `node dist/app-server-probe.mjs [codex 可执行文件路径]`，支持原生 Windows。探针调用 initialize → initialized → account/read(refreshToken=false) → account/rateLimits/read → account/read(refreshToken=false)，保持 stdin 到请求结束，然后关闭进程。第二次 account/read 用于检查采集中账号切换，不代表已经确认 Desktop 同一账号。

仅输出有限错误码，不输出服务端 stderr 和原始 RPC 错误。每次请求超时 15 秒，最终进程清理含最多 500 毫秒等待。App Server 本身可能写入状态目录，探针不读取/复制凭据。未获取额度不等于认证失败。没有明确 codex 主池归属的旧版响应拒绝推断。

## 权限及卸载

manifest 仅申请 dom；不注册 Composer Accessory、设置、storage 或 WebSocket。内部 app 模块导入依赖宿主非公开实现，加载模块可能执行模块初始化；失败只报诊断，不尝试其他数据源。关闭探针后通过 Loader 移除目录；不改变原生 Usage 显示。
