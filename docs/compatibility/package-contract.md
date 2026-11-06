# 开发包与固定Loader注册表合同

2026-11-06，使用已审阅的Loader源码b6ec28c69af12e9667f57d19823fb46d225756e4（package 0.6.0）验证当前dist/plugin。工具仅创建自有临时注册表，不启动/停止Codex，不连接CDP，不修改当前Loader注册表或默认插件状态。

```sh
# LoaderRoot指向已审阅的固定版本源码；Windows使用原生Node 22+。
node tools/probes/validate-package.mjs "$LoaderRoot" dist/plugin
```

工具复用上游loadScriptDescriptor、ScriptRegistry和buildPlan，不另写安装实现。每次变更后重新从磁盘初始化注册表并回读，输出有限状态和检查名，失败不回显任意源路径或上游异常。临时目录在finally回收。

| 检查 | 原生Windows x64 | WSL补充检查 | 证据范围 |
| --- | --- | --- | --- |
| schema/runAt/lifecycleGlobal/documentation/settings/最小dom权限 | 通过 | 通过 | 固定Loader实际接受manifest |
| index.js/manifest/README/LICENSE/NOTICE存在 | 通过 | 通过 | 开发包文件齐全，尚非发布ZIP |
| 安装后默认禁用，指纹与源包一致 | 通过 | 通过 | 隔离注册表回读 |
| 启用后注入计划包含1个描述符 | 通过 | 通过 | 计划生成，不在此测试执行UI |
| 禁用后注入计划不含插件 | 通过 | 通过 | 计划生成，不替代真实停用回收 |
| 上游quarantine移除后无已安装插件 | 通过 | 通过 | 隔离注册表与移除记录回读 |
| restore后启用状态及包指纹恢复 | 通过 | 通过 | 无模拟包元数据或虚构升级 |
| 自有临时目录清理 | 通过 | 通过 | cleaned=true |

真实Renderer已另有加载、热重载、停用零残留和鼠标交互证据，见[Windows报告](windows-x64-p0.md)及[实施进度](../实施进度.md)。本表不把隔离文件系统操作当作当前运行宿主的完整安装/卸载/升级验收，也不证明macOS、ARM64或自动更新。正式P3门槛继续保留在[验收矩阵](../验收矩阵.md)。
