# Chromium挂载生命周期夹具

2026-11-06，在当前Windows客户端的Chromium中运行独立、不可见iframe，复用真实MountManager、UsageStore、SharedPopover和样式，以浏览器原生布局/MutationObserver验证生命周期。夹具仅使用合成Weekly样本，不发网络请求、不读取账号、不修改当前聊天的原生控件。它不是宿主真实页面切换、账号切换或Weekly-only实机账号的替代证据。

```sh
bun build tests/browser/mount-lifecycle.ts --target browser --format cjs --outfile artifacts/browser/mount-lifecycle.cjs
# LoaderRoot为已审阅的固定0.6.0源码；Port为已确认属于测试客户端的本地CDP端口。
# Windows使用原生Node 22+，路径使用实际环境值。
node tools/probes/check-mounts.mjs "$LoaderRoot" "$Port" artifacts/browser/mount-lifecycle.cjs
```

修复前：初始Composer隐藏时仅侧栏挂载，去掉hidden后仍仅1处；需显式resize才恢复2处。原因是缺少挂载点时仅观察childList，未观察已有隐藏候选及祖先的可见性属性。修复后保留隐藏候选，观察有限属性。2026-11-07进一步改为观察整个文档但过滤无关变更，覆盖非当前祖先分支中缓存Composer的显现；健康挂载保留节点，布局变化直接更新几何。普通快照更新也重新确认唯一可见候选，避免后出现的歧义被既有slot跳过。

| 条件 | 修复后原生Chromium夹具结果 |
| --- | --- |
| 初始Composer隐藏 | 仅rail，slots=1 |
| 去掉hidden，无额外resize/查询 | 自动恢复，slots=2 |
| 添加无关article并改变class | slots=2，scans保持2 |
| 替换Composer节点 | slots=2，两个适配器ready |
| 替换rail节点 | slots=2，两个适配器ready |
| 新增隐藏的第二个Composer | 仍slots=2 |
| 第二个Composer显现，无额外普通刷新 | Composer=ambiguity，只保留rail，slots=1 |
| 移除歧义节点 | 自动恢复，slots=2 |
| 宿主移除Composer slot | 自动恢复，slots=2 |

测试结束回读生命周期全局false、iframe数量0。检查器把等待放在Node进程，每一步重新读取结果，避免单个Renderer异步求值跨越多个后台定时器。最初整段求值曾发生观察超时；先核对原客户端仍活、旧iframe已自行清理，再切换分步检查，没有重启客户端。

本测试与145项Bun测试分开报告。真实宿主任务切换、设置页、完整主题/尺寸/缩放和键盘仍以[验收矩阵](../验收矩阵.md)为准。

2026-11-07在独立Chromium复验9项条件通过，另有[24项合成几何矩阵](hud-2026-11-07.md)及[常驻加载/压力检查](resident-injection.md)。这些结果与宿主完整兼容矩阵分别报告。
