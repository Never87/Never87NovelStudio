# Round 1 — 原始规划遗漏修复：审计状态矩阵

> **状态说明（本轮收尾后）**：本矩阵最初用于记录「原始规划遗漏」——占位页 16 项 + Dashboard 虚假数据 6 项。经本轮实现，**22 项全部为 IMPLEMENTED**（真实 Service/Hook/持久化，无 mock/静态数据），`REAL_PAGE_NAV_IDS` 已覆盖全部 45 个 nav item，不再有任何 nav item 回落到 `ModulePlaceholder`。下表「状态」列已更新为收尾后的真实状态，历史判断依据保留可审计。

> 判定依据：**当前工作区真实代码**逐项核对（路由 → 实际渲染组件 → 是否占位 → 是否接通 Service/Repository/Hook/持久化 → 是否存在 mock/静态数据）。
> 不以历史阶段报告推断。路由真源：`src/config/navigation.ts` + `src/routes/index.tsx`。
> 占位判定：不在 `REAL_PAGE_NAV_IDS` 中的 nav item 一律由 `createModulePage()` 渲染 `ModulePlaceholder`（`src/modules/shared/ModulePlaceholder.tsx`，可见徽标 `Coming Soon` / `P0 · Placeholder`）。

## 状态口径

| 状态 | 含义 |
| --- | --- |
| NOT_IMPLEMENTED | 无任何实现（无 schema/service/UI） |
| PLACEHOLDER | 路由存在但只渲染 `ModulePlaceholder` |
| PARTIAL | 有部分真实实现，但缺少规划中的关键子功能 |
| UI_DISCONNECTED | 底层业务逻辑已实现，但该导航路由未接通 UI |
| DATA_FAKE | 使用虚假/静态演示数据 |
| IMPLEMENTED | 真实业务功能完整 |

---

## A. 占位类页面审计（16 项真实页面；#17 为分组说明，不计数）

| # | 项目 | 状态 | 路由 | 实际渲染 | 底层实现 | 判断依据 | 原始阶段 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Writing Statistics | **IMPLEMENTED** | `/statistics` (`stats`) | `StatisticsPage`（`modules/stats`） | 真实：`useWorkspaceStats` → `WritingStatsService`；`writingActivity` 台账；按项目拆分、日/周/月输出 | 页面已接通真实 Hook/Service，`stores:stats` 在 `REAL_PAGE_NAV_IDS` | P1/P9-F 周边 |
| 2 | Writing Goals | **IMPLEMENTED** | `/goals` (`goals`) | `GoalsPage`（`modules/goals`） | 真实：`useWritingGoal` / `WritingGoalService` / `writingGoals` 表 | 页面已接通持久化目标（与 Dashboard 共享同一数据源） | P1/P9-F 周边 |
| 3 | World Building | **IMPLEMENTED** | `/novel/world-building` | `WorldBuildingPage`（`creation/CreationPages` + `ProjectScopedPage` + `WorldPanel`） | 完整：`world-*` 全套；`ProjectScopedPage` 提供项目选择 | 导航路由已接通真实 `WorldPanel` | P2-A |
| 4 | Characters | **IMPLEMENTED** | `/novel/characters` | `CharactersPage`（+ `CharactersPanel`） | 完整：`character-*` 全套 | 导航路由已接通真实面板 | P2-A |
| 5 | Narrative Planning | **IMPLEMENTED** | `/novel/narrative-planning` | `NarrativePlanningPage`（+ `NarrativePanel`） | 完整：`narrative-*` 全套 | 导航路由已接通真实面板 | P2-B |
| 6 | Outline | **IMPLEMENTED** | `/novel/outline` | `OutlinePage`（+ `OutlinePanel`） | 完整：卷→章→场景、排序、节拍关联 | 导航路由已接通真实面板 | P3 |
| 7 | Scene Builder | **IMPLEMENTED** | `/novel/scene-builder` | `SceneBuilderPage`（+ `ScenesProsePanel`） | 完整：场景级写作 | 导航路由已接通真实面板 | P3 |
| 8 | Story Editor | **IMPLEMENTED** | `/novel/story-editor` | `StoryEditorPage`（+ `WritingPanel`） | 完整：TipTap + 自动保存 + 版本 + 导入导出 + AI 助理 | 导航路由已接通真实面板 | P4 |
| 9 | Timeline | **IMPLEMENTED** | `/novel/timeline` | `TimelinePage`（`creation`） | 真实派生：`useOutline` + `useContinuity` → 按时间顺序排列事件 | 页面已实现（基于真实 outline + 连续性数据派生） | P3/P7 周边 |
| 10 | Story Idea Generator | **IMPLEMENTED** | `/ai/idea-generator` | `IdeaGeneratorPage`（`modules/ai-toolbox`） | 真实：`useAiConfig` + `useAiAssistance`，用户输入 genre/theme → 调用真实 AI 管线 | 页面已实现并接通真实 AI 管线 | P5 |
| 11 | AI Model Playground | **IMPLEMENTED** | `/ai/model-playground` | `ModelPlaygroundPage`（`modules/ai-toolbox`） | 真实：`useAiConfig` + `useAiAssistance`，对已配置模型直接运行 prompt | 页面已实现并接通真实 AI 管线 | P5 |
| 12 | Style Analyzer | **IMPLEMENTED** | `/ai/style-analyzer` | `StyleAnalyzerPage`（`modules/ai-toolbox`） | 真实：确定性本地分析 `style-analysis.ts`（`analyzeStyle` / `topWords`）+ 可选 AI 深化 | 页面已实现（本地确定性检测器为真实核心） | P7 |
| 13 | Import / Export Project | **IMPLEMENTED** | `/data/project-import-export` (`project-io`) | `ProjectIOPage`（`modules/data`） | 真实：工作区级 `TransferService.exportWorkspace` 导出 + `backupPreviewService` 校验预览；恢复由 Backup & Restore 承担 | 专用 project-io 页面已实现（导出/校验），写恢复不重复实现 | P9-A |
| 14 | General Settings | **IMPLEMENTED** | `/settings/general` | `GeneralSettingsPage`（`modules/system`） | 真实：`setThemeMode`/`useThemeMode`（持久化 `n87-theme`）+ `useUiStore` 侧栏默认（`n87-ui`） | 页面已实现并接通真实持久化 | P0 周边 |
| 15 | Editor Settings | **IMPLEMENTED** | `/settings/editor` | `EditorSettingsPage`（`modules/system`） | 真实：主题切换（影响编辑器）+ 如实展示自动保存保证（800ms/5s，硬编码行为，非假开关） | 页面已实现；不伪造不存在的可配置项 | P4 周边 |
| 16 | Help & About | **IMPLEMENTED** | `/settings/help` | `HelpPage`（`modules/system`） | 真实：产品说明、数据存放/隐私、可用的快捷入口（指向真实路由） | 页面已实现 | P0 |
| 17 | （说明）Workspace/Creation/Import-Analysis/AI-Toolbox/Publishing/Version-Data/System | 分组标题 | — | 非页面 | `workspace`/`creation`/`import-analysis`/`ai-toolbox`/`publishing`/`version-data`/`system` 是**导航分组**，不产生路由 | navigation.ts 中为 group | — |

## B. Dashboard 六项虚假数据审计（修复前状态）

| # | 项目 | 修复前状态 | 修复前依据 | 修复后 |
| --- | --- | --- | --- | --- |
| 18 | Words Written | **DATA_FAKE** | `DashboardPage` 硬编码数字；`demo-data.ts` 提供示例项目 | **IMPLEMENTED**：真实章节+场景稿件 `wordCount` 汇总 |
| 19 | Writing Streak | **DATA_FAKE** | 硬编码固定天数徽标 | **IMPLEMENTED**：`writingActivity` 台账 → `computeStreak`；无历史则如实 0 |
| 20 | Completed Chapters | **DATA_FAKE** | 硬编码 `12` | **IMPLEMENTED**：`chapter.status ∈ {revised, final}`（`COMPLETED_CHAPTER_STATUSES`） |
| 21 | Continue Writing | **DATA_FAKE** | 固定指向 `DEMO_PROJECTS[0]`，按钮 `disabled` | **IMPLEMENTED**：最近编辑项目+最新编辑章节，深链 `?tab=writing&chapter=<id>` |
| 22 | Writing Goal | **DATA_FAKE** | 静态进度条百分比 | **IMPLEMENTED**：`writingGoals` 单例持久化 + 真实今日/本周输出 |
| 23 | Recent Activity | **DATA_FAKE** | `DEMO_ACTIVITY` 固定列表 | **IMPLEMENTED**：项目创建时间 + 章节稿件 `updatedAt`（真实时间戳） |

## C. 汇总（与源码一致，逐项可核）

**A 表（16 个占位类页面，含 16 项真实页面；#17 为分组说明不计数）：**

- **IMPLEMENTED**：16 —— Writing Statistics(#1)、Writing Goals(#2)、World Building(#3)、Characters(#4)、Narrative Planning(#5)、Outline(#6)、Scene Builder(#7)、Story Editor(#8)、Timeline(#9)、Story Idea Generator(#10)、AI Model Playground(#11)、Style Analyzer(#12)、Import / Export Project(#13)、General Settings(#14)、Editor Settings(#15)、Help & About(#16)
- **PLACEHOLDER / UI_DISCONNECTED / PARTIAL / DATA_FAKE**：0
- A 表合计：16（#17 分组说明不计）

**B 表（Dashboard 六项，修复后）：**

- **IMPLEMENTED**：6 —— Words Written(#18)、Writing Streak(#19)、Completed Chapters(#20)、Continue Writing(#21)、Writing Goal(#22)、Recent Activity(#23)

**总计：**

- 审计页面总数 = **16（A）+ 6（B）= 22**
- **IMPLEMENTED**：16 + 6 = **22**（全部真实接通）
- **DATA_FAKE**：0（演示数据已彻底删除）
- **PLACEHOLDER / UI_DISCONNECTED / PARTIAL**：0（本轮全部实现）
- **NOT_IMPLEMENTED**：0
- **源码交叉核对**：`ALL_NAV_ITEMS`（45 项）− `REAL_PAGE_NAV_IDS`（本轮已加入 stats/goals/world-building/characters/narrative/outline/scenes/story-editor/timeline/idea-generator/model-playground/style-analyzer/general-settings/editor-settings/help/project-io 共 16 项）= **0 个占位路由**，与「A 表 16 项全部 IMPLEMENTED」一致。每个 nav item 均渲染真实页面，`createModulePage()` 占位路径已无调用方。


---

## D. Round 1 收尾补强（追加，ASCII + 中文）

- **#6 Outline**: 现在为真正的**双向** chapter <-> PlotBeat 编辑。单一真源仍为 `Chapter.plotBeatId`；
  叙事侧新增派生视图 `getBeatChapterLinks` 与定向清理 `unlinkRemovedBeats`，并在 `NarrativePanel`
  中提供 Link/Unlink；删除节拍/计划时先清理引用。详见 `AI_HANDOFF.md` §19.1。
- **#13 Import / Export Project**: 现在可从单项目 `.n87novel` **导入为新项目**，走唯一
  `projectRestoreService.restoreAsNewProject`（原子、id 重映射、失败回滚），不再只是预览。
  详见 `AI_HANDOFF.md` §19.2。
- 验证: `npx tsc -b --noEmit` exit 0; 新增 `npm run verify:outline:beatlink` 21/21;
  `verify:backup:restore` 93/93; `verify:backup:preview` 47/47。

