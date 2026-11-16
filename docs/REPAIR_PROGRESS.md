# Round 1 — 原始规划遗漏修复：进度 / 接管记录

> 本文件是本轮（Repair Round 1）的唯一进度真源。以**磁盘代码与实测结果**为准。
> 后续会话从此处继续，不得重置 / 回滚 / 重复实现已完成项。原始 P0–P9 规划不变，不创建 P10。

## 0. 中断恢复结论（本次接管实测）

上一会话已完成并落盘、本次已核实**有效、不重做**：

- Dashboard 六项虚假数据修复：数据层 + UI 完成，demo 数据彻底删除。
- 新增 schema / repository / service / hook / 纯函数 / Dexie v16 两张表。
- `pickContinueTarget` 真实缺陷已修复（跨项目按写作活动时间择优）。
- 单元测试 `verify:dashboard` = 49/49；浏览器验证 `verify:dashboard:ui` = 46/46。
- `tsc -b --noEmit` exit 0；`npm run build` exit 0。
- `docs/ROUND1_AUDIT_MATRIX.md`（审计矩阵）已完成；`docs/AI_HANDOFF.md` §17 已追加。

本次接管修正：删除此前编码损坏的 `docs/ROUND1_PROGRESS.md`，改用本文件 `docs/REPAIR_PROGRESS.md`；
并核对审计矩阵数量口径（见 §1）。

## 1. 占位页审计 — 已完成（不重复审计）

见 `docs/ROUND1_AUDIT_MATRIX.md`，含原始 P0–P9 阶段映射。

**数量口径（如实，收尾核对结论）**：实际审计 **22 个页面** = 占位类页面 **16 项** + Dashboard **6 项**。
任务标题「17 个 Placeholder 页面」经源码核对实为 **16 个占位路由**
（`ALL_NAV_ITEMS`(45) − `REAL_PAGE_NAV_IDS`(29) = 16），第 17 条为导航**分组标题**（非页面），
故不凑数到 23。逐项核对：A 表 16 项（#17 为非页面说明）+ B 表 6 项 = 22。

- IMPLEMENTED：6（Dashboard 六项）
- UI_DISCONNECTED：6（World / Characters / Narrative / Outline / Scene Builder / Story Editor — 底层完整，路由仍占位）
- PARTIAL：1（Import / Export Project，能力由 Backup & Restore 承担）
- PLACEHOLDER：9（Statistics / Goals / Timeline / Idea Generator / Model Playground / Style Analyzer / General / Editor Settings / Help）
- DATA_FAKE：0
- 合计：9 + 6 + 1 + 6 = 22（与源码交叉核对一致）

## 2. Dashboard 六项修复 — 已完成（不重复实现）

见 §0。数据来源、Dexie 兼容、深链、隔离、持久化均有测试覆盖。

## 3. 下一步

- 本轮修复目标（审计 + Dashboard 六项）均已交付并通过验证。
- 可选延伸（非本轮必须）：为 UI_DISCONNECTED 六项补独立路由页；Statistics/Goals 独立页；Timeline 等真实检测器。


---

## 4. 最终浏览器验收（Round 1 收尾补强 — 实测结果）

> 环境：本机 Windows，Chrome 已装于默认路径，Node v24。临时 dev server（**本次自启，仅本次使用**）
> 监听 `http://127.0.0.1:5177`，测试后已按 PID 精确停止并确认端口释放（未触碰任何用户既有服务，
> 启动时该端口为 free）。所有数字均为**本次实跑**，非引用。

### 4.1 覆盖范围与脚本

- 既有脚本：`verify:dashboard:ui`（p9f-dashboard-ui-verify.cjs）、
  `verify:backup:restore:ui`（p9-backup-restore-ui-verify.cjs）。
- 新增脚本（仅测试工具，未改业务代码）：`scripts/p9-round1-final-browser-verify.cjs`
  （`npm run verify:round1:browser`），针对本轮新增能力（双向 Beat 关联、Project I/O 导入、
  16 路由、Dashboard 六项）做真浏览器 + 真 IndexedDB 验证，走的是 UI 相同的服务路径。

### 4.2 本轮新增能力（新脚本，52/52 PASS）

- **Outline ↔ PlotBeat 双向关联**：章节→节拍写入后，派生视图 `getBeatChapterLinks` 正确把两个章节
  归到同一节拍（totalLinked=2）；取消关联后 `plotBeatId` 清空、派生视图立即移除该章节。
- **删除 Beat 无悬空引用**：从计划移除该节拍后，`unlinkRemovedBeats` 清除指向它的章节链接
  （unlinked=1，chapter.plotBeatId 变为 undefined），计划中已无该节拍。
- **.n87novel 单项目导入为新项目**：真实导出 → `parseBackupEntry` → `restoreAsNewProject`，
  项目数 +1；新项目 id 与源项目不同；**源项目仍在、未被覆盖**；导入项目存在。
- **刷新后仍在**：整页 reload 后，导入项目仍存在且携带 3 个章节；源项目仍存在且仍为 3 个章节。
- **导入失败不留半成品**：畸形 JSON 被拒；篡改 payload 被完整性校验拒绝；两种失败后**项目数不变**
  （countAfter == countBefore）。
- **16 个 Round-1 路由**：statistics / goals / novel(world-building,characters,narrative-planning,
  outline,scene-builder,story-editor,timeline) / ai(idea-generator,model-playground,style-analyzer) /
  data/project-import-export / settings(general,editor,help) 全部打开、有真实内容、**无占位符**、
  无页面异常。
- **Dashboard 六项**：`getDashboardStats()` 六字段类型正确（wordsWritten/writingStreak/
  completedChapters 为 number，continueTarget/goal 可空，recentActivity 为数组）；DOM 中
  Words Written / Streak / Completed / Continue Writing / Writing Goal / Recent Activity 六卡片均可见，
  **无 demo data 横幅**。
- **全程无未捕获异常**。

### 4.3 回归（既有脚本，实跑）

- `verify:dashboard:ui` → **46 / 46 PASS**（含深链打开精确章节）。
- `verify:backup:restore:ui` → **43 / 43 PASS**（含失败不写、隔离、flush-abort 无写入、无快照）。

### 4.4 结论

本轮要求的所有验收项均在**真实浏览器 + 真实 IndexedDB** 下通过：双向 Beat 关联/取消/删除无悬空、
单项目导入为新项目且刷新持久、原项目不被覆盖、导入失败无半成品、16 路由正常、Dashboard 六项真实。
合计本轮自测 **52/52**，回归 **46/46 + 43/43**，全绿。未修改任何业务代码。

