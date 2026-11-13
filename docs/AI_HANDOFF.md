
# P4 工作交接（AI_HANDOFF）

> 本文件基于 **磁盘上的实际代码** 整理，不以聊天历史中的计划代替实际进度。
> 最后更新：P4（Writing Editor & Auto-save）收尾验收完成时；
> **P5（AI 集成）交接见文末 §13**（追加，未改动 P4 正文）。
> 最后提交：`1911b52 WIP: checkpoint P2-P4 development`（P1–P4 全部代码已纳入该提交；
> 本批次 P4 收尾的两处修改**尚未提交**，停留在工作区）。

---

## 1. 项目技术栈与架构

### 1.1 技术栈

| 类别 | 选型 |
| --- | --- |
| 构建 | Vite 8 + TypeScript 5.7（`tsc -b`，严格类型检查即 lint） |
| UI | React 19 + react-router-dom 7 + Tailwind CSS 4（`@tailwindcss/vite`） |
| 状态 | Zustand 5（仅全局 UI 状态）+ 自研 React data hooks |
| 持久化 | Dexie 4（IndexedDB），schema 版本推进式迁移 |
| 校验 | Zod 3（**所有持久化类型的唯一真源**） |
| 编辑器 | TipTap 3（`@tiptap/react` + `@tiptap/starter-kit`） |
| 图标 | lucide-react |

### 1.2 目录架构（分层，自下而上）

```
src/
  types/        领域类型（仅 TS 类型 + 字面量联合，不用 enum）
  schemas/      Zod schema —— 每个持久化类型的唯一真源
  db/           Dexie 定义、版本迁移、单例
  repositories/ 纯 IndexedDB 存取，读/写均做 Zod 校验
  services/     业务层：生成 id、时间戳、默认值、计数、级联删除
  hooks/        React 数据 hooks（useWorld/useCharacters/useNarrative/useOutline/useScenes）
  modules/      功能模块：dashboard, projects, world, characters, narrative, outline, editor, shared
  components/ui 设计系统（Button, Card, Badge, PageHeader, EmptyState, IconButton…）
  config/       navigation.ts —— 路由/页面元数据唯一真源
```

### 1.3 重要开发约束（必须遵守）

1. **分层不可跨越**：组件 → hooks → services → repositories → Dexie。UI 不直接访问 `db`。
2. **Schema 为唯一真源**：任何持久化结构变更必须同步 `schemas/`，repository 写入前 `validate`。
3. **迁移只增不改**：`db/database.ts` 的 `version(n)` 一旦发布不得编辑；新增字段用新的 `version(n+1)` 并**逐字重述**旧 store 定义，保证旧数据存活。当前为 **`version(5)`**。
4. **时间戳是 `number`**（`Date.now()` 毫秒），**不是 ISO 字符串**；`now()` 来自 `utils/date.ts`。
5. **id 统一由 `utils/id.ts` 生成**（`createChapterDraftId()` 等），前缀区分实体。
6. **唯一索引慎用**：`chapterDrafts`/`sceneDrafts` 的 `&ownerId` 是**唯一**索引 —— 同一章只能有一条稿件。写入路径必须幂等（见 §7 未解决问题）。
7. **不用 TS enum**，用 `as const` 联合 + Zod `z.enum`。
8. **样式用设计令牌**（`text-ink`/`text-muted`/`text-subtle`/`bg-surface`/`border-line`），不写裸色值。
9. **注释解释「为什么」**，不复述代码。
10. **不执行 `git commit` / `git push`**（本阶段明令禁止）。

---

## 2. P0–P3 已完成情况（简要）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 应用外壳、设计系统、路由、主题（light/dark/system）、部署 | ✅ |
| P1 | IndexedDB、项目 CRUD（创建/编辑/删除/列表/详情） | ✅ |
| P2-A | 世界观（World）+ 角色（Characters）CRUD | ✅ |
| P2-B | 叙事规划（Narrative：logline、结构、节拍） | ✅ |
| P3 | 大纲（卷 → 章）+ 场景规划，章节可关联叙事节拍 | ✅ |

对应验证脚本：`p2a-verify.cjs`、`p2b-verify.cjs`、`p2b-ui-verify.cjs`、`p3-verify.cjs`、`p3-ui-verify.cjs`（本次未重跑 P0–P3，按指示不重复全面审计）。

---

## 3. P4 功能进度

### 3.1 已完成（已实现，**禁止重复开发**）

**数据层（全部落盘、类型检查通过、浏览器实测 13/13 通过）**

- `types/manuscript.ts` + `schemas/manuscript.ts`：`ChapterDraft` / `SceneDraft` / `DraftVersion` 定义。
  - 稿件容器分离：章节稿件与场景稿件各自成表（`chapterDrafts` / `sceneDrafts`），均可承载正文。
  - `revision` 单调递增，用于乐观并发。
  - `DraftVersion` 是**只追加**快照日志（按 `draftId` 关联）。
- `db/database.ts`：`version(5)` 新增三张表（详见 §5）。
- `repositories/manuscript-repository.ts`：稿件/版本的全部存取；含按 `draftId` 读稿件（`getChapterDraftById` / `getSceneDraftById`）。
- `services/manuscript-service.ts`：
  - `openChapterDraft` / `openSceneDraft`（缺省时创建空稿件，返回兄弟章节与项目总字数、`locked` 标记）
  - `saveChapterDraft` / `saveSceneDraft`（派生字数/字符数、revision 仅在内容变化时 +1、`expectedRevision` 乐观并发）
  - `DraftConflictError`（陈旧 revision 拒绝覆盖）、`ChapterLockedError`（`status === 'final'` 拒绝写入）
  - `getDraft` / `getDraftById` / `listVersions` / `createManualVersion` / `restoreVersion`（**恢复＝追加新 revision + 记录 `restore` 快照**，历史不可变）
  - 版本裁剪 `prune`（`MAX_VERSIONS_PER_DRAFT`）
  - **级联删除**：`deleteChapterManuscripts` / `deleteSceneManuscripts` / `deleteByChapterId` / `deleteBySceneId` / `deleteByProject` —— 稿件与其**版本历史一并删除**（已修复孤儿版本缺陷）
  - `countProjectWords`（章节正文 + 场景正文）
- `services/manuscript-transfer-service.ts`：Markdown 导入/导出。
  - `previewImport()` **纯预览、不落库**；`importMarkdown()` 支持 `onDuplicate: 'skip' | 'overwrite'`；`exportVolume()` 导出整卷。
- `utils/manuscript-text.ts`：`computeTextStats`、`markdownToPlainText`、`splitMarkdownChapters`、`chaptersToMarkdown`、`normaliseChapterHeadings`（章节内 `#`/`##` 降级为 `###`，保证 `导出→导入` 无损往返）。
- 级联修复已接入 `services/outline-service.ts` 与 `services/scene-service.ts`（改用 `ManuscriptService`，不再漏删版本）。

**自动保存引擎（已实现，11/11 单元测试通过）**

- `modules/editor/autosave-engine.ts`：`AutosaveEngine`
  - 防抖（`debounceMs` 默认 800）+ `maxWaitMs` 上限
  - 串行化写入、dirty 跟踪
  - 乐观并发：每写携带其依据的 revision；冲突触发 `DraftConflictError` 处理路径
  - `switchTo()`：**切换文档前先 flush 旧文档**
  - `flush()` / `retry()` / `snapshot()` / `dispose()`
  - 可注入时钟与定时器，便于确定性测试

**编辑器 UI（已实现，但受 §7 阻塞无法端到端跑通）**

- `modules/editor/MarkdownEditor.tsx`：TipTap 编辑器，`StarterKit`（含 **undo/redo 历史**）、`aria-label="Chapter manuscript"`、`editable` 由锁定态控制、支持 `onSaveShortcut`（Ctrl/Cmd+S）。
- `modules/editor/use-chapter-editor.ts`：把 `AutosaveEngine` 与 `manuscriptService` 桥接为 React 状态（`document/status/error/autosave/onChange/saveNow/retry/reload/createVersion`）。
- `modules/editor/WritingPanel.tsx`：Writing 标签主界面 —— 左侧卷/章导航（含锁定图标）、右侧编辑器、实时字数、自动保存状态指示、上一章/下一章、版本与导入导出入口、锁定横幅、空态。
- `modules/editor/VersionHistoryDialog.tsx`：版本历史（手动快照、列表、恢复）。
- `modules/editor/ImportExportDialog.tsx`：导入预览（标题/字数/摘要/重复标记）/ 导出下载。
- `modules/projects/ProjectDetailPage.tsx`：**Writing 标签已接通**（`DetailTab` 联合、`DETAIL_TABS`、`BookOpen` 图标、`WritingPanel` 渲染分支均已补齐）。

**测试脚本（已存在）**

- `scripts/p4-autosave-unit.cjs`（11 项）
- `scripts/p4-markdown-unit.cjs`（13 项）
- `scripts/p4-verify.cjs`（浏览器数据层，13 项）
- `scripts/p4-ui-verify.cjs`（浏览器 UI 端到端，12 项）
- `package.json` 已注册：`verify:editor`、`verify:markdown`、`verify:writing`、`verify:writing:ui`

### 3.2 进行中

- **无。** P4 主体已全部落盘并通过验收，见 §6、§7。

### 3.3 未完成

- **场景正文（Scene）的编辑器入口**：服务层与 schema 已就绪，但 **UI 目前只有章节编辑器**，尚未提供场景正文编辑界面（属 P4 范围内可延后项）。
- README 的 P4 状态与 Roadmap 未更新（README 仍停在 P3，且 Roadmap 表中 `P3` 重复一行）。
- README 未补充 P4 的 `verify:*` 脚本说明。

---

## 4. 数据库版本与迁移

- 当前版本：**`version(5)`**（`src/db/database.ts`）。
- P4 在 `version(5)` 中新增（**纯附加**，v1–v4 全部 store 逐字重述，旧数据不受影响）：

| 表 | 索引 | 说明 |
| --- | --- | --- |
| `chapterDrafts` | `&id, &ownerId, projectId, updatedAt` | 每章一份稿件；`&ownerId` **唯一** |
| `sceneDrafts` | `&id, &ownerId, projectId, updatedAt` | 每场景一份稿件；`&ownerId` **唯一** |
| `draftVersions` | `&id, draftId, projectId, [draftId+revision], createdAt` | 只追加快照 |

> 注意：`draftVersions.draftId` 存的是**稿件记录 id**（`cdraft_*` / `sdraft_*`），不是章节/场景 id。

---

## 5. 本次（含中断前的会话）修改过的文件及职责

### 5.1 已修改的既有文件（相对 `5b13065`）

| 文件 | 职责 / 改动 |
| --- | --- |
| `README.md` | 更新至 P3 状态说明、补充验证脚本表 |
| `package.json` | 新增 `verify:*` 脚本（P2-A ~ P4） |
| `src/db/database.ts` | 新增 `version(5)`：三张 P4 表；类型声明 |
| `src/types/index.ts` | 导出 P2–P4 类型与字面量联合 |
| `src/utils/id.ts` | 新增 `createChapterDraftId` / `createSceneDraftId` / `createDraftVersionId` |
| `src/hooks/index.ts` | 导出新 hooks |
| `src/services/index.ts` | 导出 `ManuscriptService`、`ManuscriptTransferService`、`DraftConflictError`、`ChapterLockedError` |
| `src/services/project-service.ts` | 项目删除时级联清理稿件/版本 |
| `src/modules/projects/ProjectDetailPage.tsx` | 接通 Narrative / Outline / **Writing** 标签（含 `DetailTab`、`DETAIL_TABS`、`BookOpen` 图标、渲染分支） |

### 5.2 P4 新增文件

| 文件 | 职责 |
| --- | --- |
| `src/types/manuscript.ts` | 稿件/版本类型 |
| `src/schemas/manuscript.ts` | 稿件/版本 Zod schema（唯一真源） |
| `src/repositories/manuscript-repository.ts` | 稿件/版本纯存取与校验 |
| `src/services/manuscript-service.ts` | 稿件业务：并发、锁定、版本、级联、字数 |
| `src/services/manuscript-transfer-service.ts` | Markdown 导入/导出 |
| `src/utils/manuscript-text.ts` | 统计与 Markdown 切分/拼接/标题规范化 |
| `src/modules/editor/autosave-engine.ts` | 防抖/串行/冲突/切换 flush 的自动保存状态机 |
| `src/modules/editor/use-chapter-editor.ts` | 引擎 → React 状态桥接（**含 §7.3 的 cleanup 生命周期修复**） |
| `src/modules/editor/MarkdownEditor.tsx` | TipTap 编辑面积 |
| `src/modules/editor/WritingPanel.tsx` | Writing 标签主界面 |
| `src/modules/editor/VersionHistoryDialog.tsx` | 版本历史对话框 |
| `src/modules/editor/ImportExportDialog.tsx` | 导入/导出对话框 |
| `scripts/p4-autosave-unit.cjs` | 自动保存引擎单元测试 |
| `scripts/p4-markdown-unit.cjs` | Markdown 工具单元测试 |
| `scripts/p4-verify.cjs` | 浏览器数据层端到端（13 项） |
| `scripts/p4-ui-verify.cjs` | 浏览器 UI 端到端（13 项，含 reload 前置断言与有界 CDP 导航） |

> 其余 `?? ` 未跟踪文件（`src/modules/world|characters|narrative|outline/`、对应 schemas/repositories/services/hooks）属 P2–P3 成果，同样未提交，**不要动**。

---

## 6. 已执行的测试与结果（P4 收尾验收实测）

| 测试 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc -b --noEmit` | ✅ 通过（exit 0） |
| 自动保存单元 | `node scripts/p4-autosave-unit.cjs` | ✅ **11 / 11 PASS** |
| Markdown 单元 | `node scripts/p4-markdown-unit.cjs` | ✅ **13 / 13 PASS** |
| 数据层（真浏览器 + IndexedDB） | `node scripts/p4-verify.cjs` | ✅ **13 / 13 PASS** |
| UI 端到端（真浏览器） | `node scripts/p4-ui-verify.cjs` | ✅ **13 / 13 PASS** |
| 生产构建 | `npm run build` | ✅ 通过（exit 0） |

UI 端到端关键验收证据（实测值）：

- `autosave: 状态显示 "Saved"` → `{"saved":true,"unsaved":false,"failed":false}`
- `persistence: 正文落库` → `{"content":"The lamp swept the sea.","words":5,"revision":1}`
- `reload precondition: 导航前已 Saved` → `{saved:true,...}`
- `reload: 正文从数据库恢复` → `"The lamp swept the sea."`
- `switch: 切章前 flush 旧章节` → `stored:"Second chapter prose.The lamp swept the sea."`
- `cleanup: 无孤儿行` → `{"chapters":0,"drafts":0,"versions":0}`
- `no uncaught page exceptions` → PASS

---

## 7. P4 核心缺陷与修复记录

### 7.1 已修复一：StrictMode 下稿件并发创建（`ensureChapterDraft`）

**现象**：打开 Writing 标签报 `Failed to create the draft "cdraft_..."`，编辑器不渲染。

**根因**：`main.tsx` 使用 `<StrictMode>`，开发模式 effect 执行两次；旧实现「先查后建」，
两次并发调用都查到 `null`，各自 `add()` 一条不同 id 的稿件，而 `chapterDrafts` 有唯一索引
`&ownerId`，第二次写入违反唯一约束。双击、双标签页、快速切章同样会触发。

**修复（已落盘）**：`repositories/manuscript-repository.ts` 提供事务内**原子 upsert**
`ensureChapterDraft(ownerId, factory)` / `ensureSceneDraft(ownerId, factory)`，检查与写入在同一
Dexie 事务内完成；`services/manuscript-service.ts` 的 `openChapterDraft` / `openSceneDraft`
改为调用它们，并以返回的 `created` 作为原有标志。已由 `p4-verify.cjs` 断言
「creates once, reuses on reopen」验证。

### 7.2 已修复二：自动保存静默失效（StrictMode + `dispose()`）

**现象**：输入文字后 dirty 正常，但状态永远停在 `Unsaved changes`；IndexedDB 中
`content=""`、`words=0`、`revision=0`；`failed:false`（不报错）。

**根因**：`modules/editor/use-chapter-editor.ts` 的 unmount cleanup 调用了
`engine.flush().finally(() => engine.dispose())`。引擎在 **render 期间**创建并存于 `ref`，
因此全生命周期只创建一次；StrictMode 的「挂载 → 卸载 → 再挂载」对**同一实例**执行，
cleanup 中的 `dispose()` 把 `disposed` 永久置为 `true`（**无任何重置路径**），第二次挂载时
`if (!engineRef.current)` 为假、不会重建引擎。于是 `AutosaveEngine.drain()` 的循环条件
`while (this.pending !== null && this.target && !this.disposed)` **恒为假**，循环体一次都不执行 ——
`store.save` 从未被调用，正文永不落库。

**运行时证据**（浏览器内探针快照）：
```
{ at:"enter",  pending:"Hi.", hasTarget:true, disposed:true, gen:2, status:"dirty" }
{ at:"exit-ok", pending:"Hi.", hasTarget:true, disposed:true, gen:2, status:"dirty" }
DB {"content":"","words":0,"rev":0}
```
`gen:2` 即 StrictMode 二次挂载又 `bind()` 一次的印记。

### 7.3 最终采用的 cleanup 生命周期方案

```ts
const flushOnCleanup = useCallback((reason: string) => {
  const engine = engineRef.current;
  if (!engine) return;
  engine.flush().catch((error: unknown) => {
    console.error(
      `[useChapterEditor] Failed to flush the manuscript while ${reason}; ` +
        'the latest text may not be persisted.',
      error,
    );
  });
}, []);

// 章节/项目切换：切章前 flush 旧文档
useEffect(() => {
  /* ...load... */
  return () => flushOnCleanup('switching chapters');
}, [projectId, chapterId, load, flushOnCleanup]);

// 真正卸载：只 flush，绝不 dispose
useEffect(() => () => flushOnCleanup('unmounting the editor'), [flushOnCleanup]);
```

要点：

1. **永不 dispose 引擎**。`disposed` 无重置路径，是本次缺陷的根源。
2. **保留 `flush()`**：它已负责取消防抖定时器、等待在途写入、按 `generation` 丢弃过期响应，
   不需要 `disposed` 参与；过期写保护由 `generation` 承担，足够。
3. **显式处理 rejection**：cleanup 无法通过 React state 报错（组件正在卸载），未捕获的
   rejection 会在卸载时冒成运行时错误；因此用带上下文的 `console.error` 上报，
   **不静默吞掉**保存失败。项目无 logger 模块、无 ESLint `no-console` 规则，故用 `console.error`。
4. 两个 cleanup 触发时机不同（target 变更 vs 真正卸载），不会重复保存。
5. StrictMode 二次挂载复用同一引擎，且 `flush()` 不修改引擎活性，因此仍可正常保存。

### 7.4 已修复三：UI 测试在 reload 阶段无限挂起

**根因**：有未保存文字时 `beforeunload` 守卫会 `preventDefault()` 取消导航，
导致 CDP `Page.navigate` **永不 resolve**，脚本静默挂起、CPU 为零。这是**合理的业务保护**，
不是缺陷。

**修复（仅测试脚本，不给业务代码开豁免）**：
- 新增 `Cdp.sendBounded()`，为任意 CDP 命令加硬上限（`Promise.race` + `clearTimeout`）。
- reload 前**最多等待 10 秒**确认 `Saved`；成功才导航，超时则**记录 FAIL 并立即终止**
  （打印 SUMMARY、`exitCode=1`、不再 reload），避免把真实缺陷藏在挂起后面。
- `Page.navigate` 改用 `sendBounded(..., 15_000)`。

---

## 8. 剩余风险与维护注意事项

1. **`AutosaveEngine.dispose()` 目前无调用点**。组件真实卸载时不再显式 dispose；`flush()`
   已保证在途写入完成、定时器取消，卸载后无人持有引擎引用，GC 可回收。若未来让引擎被外部持有，
   需要重新设计生命周期（不可简单在 cleanup 中 dispose，否则会重蹈 §7.2 覆辙）。
2. **StrictMode 仍会双挂载**，导致 `openChapterDraft` 被调用两次；已由 `ensureChapterDraft`
   的原子 upsert 正确处理（测试断言 `created:true` 仅一次）。
3. **`beforeunload` 在真实浏览器中仍会拦截刷新**（有未保存文字时）——这是预期保护；
   自动化测试仅在确认 `Saved` 后导航来规避。
4. **场景正文编辑 UI 仍缺失**（见 §3.3）。
5. **`console.error` 为唯一诊断通道**。若将来引入 logger 模块，应把 `flushOnCleanup` 的
   上报切换到该模块。
6. UI 测试为 **13 项**（原 12 项 + 新增 reload 前置断言），属**新增覆盖**而非放宽标准。

## 9. P4 是否满足关闭条件

**满足，建议正式关闭 P4。** 依据：

- 四套测试全绿（11/11、13/13、13/13、13/13），类型检查与生产构建通过；
- 自动保存、刷新恢复、章节切换、无孤儿记录、无未捕获异常均经真浏览器实测验证；
- §7.1 与 §7.2 两个真实缺陷均已修复并有回归覆盖；
- 唯一未完成项（场景正文 UI）属 P4 范围内**可延后**项，不阻塞章节稿件主流程。

遗留的 README 状态更新（P4 打勾、删除重复 `P3` 行、补 `verify:*` 说明）属文档事务，
不影响功能验收。

## 11. 明确禁止重复开发（已实现且测试通过）

- 稿件/版本的原子 upsert（`ensureChapterDraft` / `ensureSceneDraft`，见 §7.1）
- 自动保存引擎全部能力（防抖、串行、冲突、switchTo flush、maxWait、注入时钟）
- `use-chapter-editor` 的 cleanup 生命周期（flush-only，见 §7.3）
- Markdown 统计/切分/拼接/标题规范化，以及章节内标题降级
- Markdown 导入（预览/重复处理）与导出
- 版本快照、手动快照、恢复（追加式）、裁剪
- 章节锁定（`final` 拒绝写入 + UI 只读）
- 级联删除（含版本历史一并清理）
- Writing 标签接入与整个编辑器 UI 骨架、版本/导入导出对话框、字数与保存状态显示
- 上述四套测试脚本本身（含 §7.4 的有界导航与 reload 前置断言）

---

## 12. 运行验证的前置条件

- 需要一个 dev server：`npm run dev -- --port 5177 --strictPort`（P4 脚本硬编码 `http://localhost:5177/`）。
- **不要重复启动** dev server；先检查 `5177` 端口是否已在监听。
- 浏览器脚本使用 `C:\Program Files\Google\Chrome\Application\chrome.exe`，headless + CDP。
- 不需要 dev server（本套 `verify:ai` 为纯 Node + Vite 打包，无网络、无浏览器）。
- `verify:ai:ui` 需要 dev server 运行在 `http://localhost:5177/`（见 §12）。

---

## 13. P5（AI 集成）交接

> 本节为 P5 追加，P4 正文未改动。所有断言均基于磁盘代码与真机实测。

### 13.1 P5 交付范围

- **Provider Management**（`/settings/providers`）：多协议 provider（OpenAI / Anthropic /
  Gemini / 自定义 OpenAI 兼容端点）、API Key（默认掩码）、自定义 Header、启停、真实连接测试。
- **Model Configuration**（`/settings/models`）：手工登记模型（温度 / maxTokens / 超时）、
  全局默认模型、按任务指派模型、provider 级默认模型（每个 provider 至多一个）。
- **AI Assistance**（`/ai/assistance`）：独立问答/建议工作区；编辑器内嵌助理（**续写 / 改写 /
  润色 / 扩写 / 缩写**）。二者共用同一 `useAiAssistance` 引擎。
- **强制预览**（`AiPreviewDialog` + `DiffPreview`）：任何 AI 输出都必须在 diff 预览中
  由用户显式 **Apply / Regenerate / Reject**，绝不自动写入正文。
- **编辑器内动作**：续写（含确定插入锚点）、改写、润色、**扩写、缩写**。扩写/缩写/改写/润色
  都要求 **非空选区**，以选区文本作为输入；续写使用章节尾部文本。所有动作均产出 `AiProposal`
  并进入预览。

### 13.2 架构不变量（P6 不得破坏）

1. **每协议一个 Adapter**（`src/services/ai/adapters/*`）。`AiService`/UI 不按 `providerType`
   分支；新增协议 = 新增 Adapter + 注册表一行。
2. **唯一传输层** `AiTransport`：唯一的 `fetch` 点，负责超时（真实 `AbortController`）、
   取消、网络/CORS 归一化。别处不得再写 `fetch`。
3. **唯一写回路径**：AI 改动只经 `EditorAiAssistant` 里的 TipTap `editor` 实例写回，走 P4
   防抖 + revision 校验的自动保存；**没有第二条写路径，也无法绕过版本守卫**。P6 必须沿用。
4. **绝不静默换模型**：参考模型/服务被删或停用时，`AiService.resolveTarget` 抛 `AiError`
   （`config`），不会偷偷改用其他模型。

### 13.2.1 三项保证（P5 收尾补强）

**F1 — 扩写 / 缩写已暴露且安全**
- `EditorAiAssistant` 逐字渲染 `TASK_PROMPT_LIST` 中所有 `mode === 'replace-selection'` 的任务：
  Rewrite / Polish / Expand / Shorten，外加 Continue。任务定义**唯一来源**仍是
  `src/services/ai/task-prompts.ts`，UI 不复制 prompt。
- 扩写/缩写复用现有生成管线：`assistance.run` → `AiService.generate` → `AiProposal`，
  进入 `AiPreviewDialog` 预览。只有 **Apply** 经 TipTap `editor`（唯一写回路径）修改正文；
  Reject / Regenerate 均不触碰正文。四项 replace 任务均要求非空选区，否则按钮禁用。

**F2 — 运行时错误脱敏已接线**
- 收口函数 `redactForError(text, secrets)`（`src/services/ai/redaction.ts`）同时做两层处理：
  ① 按请求自身密钥（API Key、各 header 值）**精确替换**；② 按 `redactKnownPatterns`
  兜底（`?key=`/`api_key=`/`access_token=`、`x-api-key:`、`x-goog-api-key:`、
  `Authorization: [Bearer ]`）。
- `ProviderAdapter.parseError(status, body, rawText, secrets)` 在把 provider 错误文本写入
  `AiError.detail` **之前**必经 `redactForError`。`secrets` 由 `AiTransport` 在调用点通过
  `headerSecrets(request.headers)` 提供：除 `content-type` / `anthropic-version` 等协议常量外，
  **所有 header 值**都视作潜在密钥（含自定义 header），`Authorization` 额外剔除 `Bearer `
  前缀后单独纳入。
- 由此，无论 provider 在错误体 / 原始响应 / URL / header 回显里夹带密钥，都不会出现在
  `AiError.message`、`detail` 或用户可见文本中；`kind`、HTTP `status` 与安全的 provider
  消息仍保留。网络/CORS 错误的 `detail` 是浏览器自身的 fetch 错误文本（非 provider 控制），
  亦不含密钥。成功响应的解析不受影响。

**F3 — 续写插入位置确定化**
- 生成开始时（`EditorAiAssistant.runTask`）用 `captureInsertAnchor(doc, selection.to)` 捕获锚点：
  `{ pos, docSize, contextBefore }`，随 `AiProposal.insertAnchor` 一路保留到预览。
- Apply 前用 `validateAnchor(doc, anchor)`（`src/modules/ai/insert-anchor.ts`）校验：文档
  `content.size` 必须与捕获时一致，且 `pos` 前 `ANCHOR_CONTEXT_CHARS(32)` 个字符必须与
  `contextBefore` 完全相同；任一不符则不插入，给出**可恢复错误**（提示重新生成）。
- 因此光标在生成后移动**不影响**插入位置（插到锚点而非实时光标）；章节切换 / 文档改动后
  Apply 会拒绝而非误插。replace 模式的陈旧选区保护保持不变；仍是单编辑器写路径 + P4
  revision 保护。

### 13.3 P5 明确未做（留给 P6）

- **Prompt Engineering Center**：可编辑的提示模板、变量、版本化、上下文管理。P5 只有一张
  **固定**任务提示表（`src/services/ai/task-prompts.ts`），非用户可编辑模板。
- **模型自动发现**：模型纯手工登记，连接测试不做模型列举。
- **流式输出**：当前非流式；若加流式需改 `AiTransport`/`ProviderAdapter` 为事件流，
  并保持“预览→应用”契约。
- **安全密钥库**：Key 以明文存 IndexedDB，UI 已如实声明，任何地方不得宣称已加密。

### 13.4 数据模型（Dexie `version(6)`，纯附加）

| 表 | 索引 | 说明 |
| --- | --- | --- |
| `aiProviders` | `&id, providerType, enabled, updatedAt` | 全局工作区设置，不绑定项目 |
| `aiModels` | `&id, providerId, [providerId+modelId], enabled` | |
| `aiTaskConfigs` | `&task` | 每任务一行 |
| `aiGlobalConfig` | `&id` | 单例（`id==='global'`） |

### 13.5 模型解析顺序

`explicit modelId` → `task 指派` → `global 默认` → 抛错。唯一真源：
`AiService.resolveTarget`。UI 侧 `AiConfigService.getAssignments()` 暴露同样的信息。

### 13.6 文件清单（P5 新增 / 修改）

**Services / repositories / schemas / types**

- `src/types/ai.ts`、`src/schemas/ai.ts`（受持久化实体真源）
- `src/repositories/ai-repository.ts`
- `src/services/ai-config-service.ts`（CRUD + 业务不变量：每 provider 单默认、删级联清理）
- `src/services/ai-service.ts`（`resolveTarget` + `generate` + `testConnection`）
- `src/services/ai-assistance-service.ts`（任务 → `AiProposal`，只组包不落库）
- `src/services/ai/ai-errors.ts`、`ai-transport.ts`、`provider-adapter.ts`、`adapter-registry.ts`、
  `task-prompts.ts`、`text-diff.ts`、`redaction.ts`、`adapters/{openai,anthropic,gemini}-adapter.ts`

**Hooks**

- `src/hooks/use-ai-config.ts`（提供者/模型/任务配置状态与变更）
- `src/hooks/use-ai-assistance.ts`（生成生命周期、AbortController 取消、世代令牌防陈旧响应）

**UI（`src/modules/ai/`）**

- `src/modules/ai/`：`ApiSettingsPanel.tsx`、`ProviderManagementPanel.tsx`、`ModelConfigurationPanel.tsx`、
  `AiAssistancePanel.tsx`、`EditorAiAssistant.tsx`、`insert-anchor.ts`（续写锚点捕获/校验）、`index.ts`
- `components/`：`fields.tsx`、`ApiKeyInput.tsx`（默认掩码）、`ProviderFormDialog.tsx`、
  `ModelFormDialog.tsx`、`DiffPreview.tsx`、`AiPreviewDialog.tsx`

**接入 / 修改**

- `src/services/index.ts`（AI 服务单例与导出）、`src/hooks/index.ts`
- `src/types/index.ts`（AI 类型从 `@/schemas/ai` 再导出）
- `src/modules/editor/WritingPanel.tsx`（挂载 `EditorAiAssistant`，editor → 侧栏两列布局）
- `src/routes/index.tsx`（注册 4 个真实页面，`REAL_PAGE_NAV_IDS` 排除占位路由）

### 13.7 验证脚本与结果（实测）

| 测试 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc -b --noEmit` | ✅ exit 0 |
| 适配器/diff/**脱敏(真实错误路径)**/**锚点**单元 | `npm run verify:ai` | ✅ **71 / 71** |
| AI 页面 + 数据层 + **编辑器 AI 动作(F1/F3)**（真浏览器） | `npm run verify:ai:ui` | ✅ **26 / 26** |
| 生产构建 | `npm run build` | ✅ exit 0（各 AI 页面独立分包） |

`verify:ai` 覆盖：三协议请求构造（URL/auth/body 形状）、响应解析与空响应拒绝、HTTP→错误
类型映射（auth/model/rate-limit/http）、自定义 Authorization **无法** 覆盖真实 key、自定义
baseUrl 采用、word-diff 无损且分类正确、密钥与已知凭据模式脱敏；**经真实
`parseError` 路径**验证 OpenAI/Anthropic/Gemini 回显密钥（含 URL、`x-api-key`、
原始响应的自定义 header）均不出现在 `AiError` 任何字段；**续写锚点**的 正常/光标移动/
文档变长/上下文变更/章节切换 判定。
`verify:ai:ui` 覆盖：4 条路由渲染真实页面（非占位）、provider+model 创建、每 provider 单
默认不变式、删模型清全局/任务指派、无模型时显式 `config` 错误（不静默换模型）、删 provider
级联清模型、页面无未捕获异常；**编辑器动作**：五个动作可见、无选区禁用/有选区启用、扩写
用选区作输入并产出预览、Reject/Regenerate 不改正文、Apply 经编辑器改写正文、
**续写插到捕获锚点而非移动后的光标**。

### 13.8 安全与部署说明（如实）

- Key 明文存 IndexedDB；API Settings 与 provider 表单均有醒目提示。
- 请求浏览器直连 provider；Anthropic 可能因 CORS 拒绝浏览器调用，连接测试会如实报
  CORS/网络错误。应用为静态站点（无后端代理），此类 provider 在放开浏览器访问或加代理前不可用。

---

## 14. P6（Prompt Engineering Center & AI Context Manager）交接 · 最终验收

> 本节为 P6 追加，P4/P5 正文未改动。所有描述基于磁盘代码与真机实测。

### 14.1 交付范围

- **Prompt Engineering Center**（`/ai/prompt-templates`）：可编辑提示模板（分类、变量、
  任务关联）、追加式版本历史与恢复、内置模板种子、导入/导出（JSON 包）。
- **AI Context Manager**（`/ai/context-manager`）：四层上下文（base/dynamic/retrieved/
  instructions）、上下文项（引用 / 手记 / 指令）管理、优先级、token 预算、实时请求预览。
- **共享请求管线**：`ContextAssemblyService.assemble()` 产出**唯一** `{ messages, sections,
  budget, notices }`；预览与执行消费同一 `messages`（R5）。

### 14.2 R1–R10 架构澄清对账（本次最终审计）

| 澄清 | 结论与证据 |
| --- | --- |
| **R1 版本追加式** | `PromptTemplateService.updateTemplate`/`restoreVersion` 仅在内容变化时**追加** `PromptTemplateVersion`，绝不改写旧版本。版本表独立、不可变。测试：`verify:prompt` 中 R1 段（起始 v1、编辑→v2、旧快照内容不变、切换 enabled 不产版本、恢复→v3 且 reason=`restored`）；`verify:prompt:ui` 同款真库断言。 |
| **R2 Provider/Model 仅为偏好** | 模板的 `providerId`/`modelId` 仅存偏好；解析始终走 `AiService.resolveTarget`（唯一真源）。`createTemplate`/`updateTemplate` 仅校验偏好引用存在（`assertPreferencesExist`），不参与解析。 |
| **R3 上下文引用而非拷贝** | `ContextItem` 对引用型来源只存 `sourceId`，组装时经既有服务**实时解析**；编辑角色后组装内容随之更新。测试：`verify:prompt` R3 段（v1→v2 live、stale 消失）；`verify:prompt:ui` 真库同款。 |
| **R4 绝不从 maxTokens 推断窗口** | 预算容量只来自模型的 `contextWindowTokens`（已知）或项目 override；`maxTokens` 是输出上限，**绝不**用作窗口。未知窗口保持 `null`、`basis='user-budget'`。测试：两处（logic + ui）断言 `modelContextWindow===null` 且 `maxTokens(2048)` 被忽略。 |
| **R5 预览/执行一致** | 见 §14.3。 |
| **R6 导入冲突语义** | 见 §14.4（本次修复）。 |
| **R7 删除与关联清理** | 见 §14.5（本次修复）。 |
| **R8 预算不足不静默丢弃** | `required` 优先级项与用户指令不会被静默裁剪；溢出在 `notices` 中以 `overflow`/`missing` 显式报告，`budget.fits` 如实反映。 |
| **R9 token 为近似值** | `estimateTokens`/`estimateMessagesTokens` 为字符启发式（CJK 加权），预览文案与字段命名为 estimate；不宣称精确。 |
| **R10 无第二执行引擎** | 组装只产出逻辑请求；协议序列化仅在 P5 Adapter；写回仅经 P5 单一路径。 |

### 14.3 R5 — 预览/执行一致（代码路径证据）

单一 canonical 管线：

```
ContextAssemblyService.assemble()            // src/services/context-assembly-service.ts
  → { messages: AiMessage[] }                 // 适配器无关的逻辑请求
  → AiAssistanceService.run({ messages })      // src/services/ai-assistance-service.ts（直接用）
  → AiService.generate({ messages })            // src/services/ai-service.ts
  → adapter.buildRequest({ messages })          // src/services/ai/adapters/*（唯一的协议序列化点）
```

- **预览**与**执行**都持有同一个 `assemble()` 返回的 `messages` 数组；预览只是渲染它，
  执行把它原样交给 `AiAssistanceService.run` 的 `messages` 入参（该入参**替换**内置 prompt 构造，
  不会二次重建）。不存在第二条消息构造路径。
- 协议（HTTP URL / auth / body 形状）序列化**只在** `ProviderAdapter.buildRequest` 内，UI 与
  组装层均不感知 `providerType`。

### 14.4 R6 — 导入冲突语义（本次修复）

修复前：同名一律 `skip`，**不同内容也会被静默丢弃**。修复后（`importBundle`）：

- **同名 + 同内容**（内容/变量/分类/任务一致）→ `skipped`，幂等（重复导入收敛，项目不变）。
- **同名 + 不同内容** → **保留两者**：导入为派生唯一名（`"X (imported)"`、`"X (imported 2)"`…），
  计入 `conflicted`，原始模板内容不被覆盖，来件内容不丢失。
- **ID 冲突**：每个导入副本始终经 `createTemplate` 分配**全新 id**，从不覆盖已有记录。
- 结果对象 `PromptImportResult` 现含 `imported / skipped / conflicted / details[].status`
  （`imported|skipped|conflict|invalid`），准确上报。

注：幂等判定按**内容一致**（不限名字），因此第二次导入同一冲突包时，命中的是上一次生成的
`"X (imported)"`，不会再次增生副本。测试：`verify:prompt` §5b（同名同内容跳过、同名异内容
导入为改名副本且原始保留、新 id、detail=`conflict`、二次导入幂等）；`verify:prompt:ui` R6
段真库同款。

### 14.5 R7 — 删除与关联清理（本次修复）

- **模板删除**：`deleteTemplate(id, { deleteVersions: true })` 一并删除其版本历史；不触碰
  其他项目数据。
- **Provider/Model 删除**（P5 已实现）：清空 `aiTaskConfigs` 中指向该模型的指派、清空全局
  默认中指向该模型的引用，任务回退到解析链下一级。
- **模板偏好悬空清理（本次新增）**：`AiConfigService` 删除模型/服务后，模板上的
  `providerId`/`modelId` 偏好**此前不会被清理**（悬空引用）。新增
  `PromptTemplateService.clearPreferencesForModel(modelId)` 与
  `clearPreferencesForProvider(providerId, modelIds[])`：清空悬空偏好、**保留内容与任务关联**、
  **不追加版本**（偏好非内容）。生产路径在 `use-ai-config.ts` 的 `deleteModel`/`deleteProvider`
  中调用（先捕获将删的模型 id，再删除，再做 best-effort 清理，清理失败不阻断删除）。
  测试：`verify:prompt` §5c（模型删除仅清该模型偏好、保留 provider 偏好与内容/版本；provider
  删除清 provider 偏好与其成员模型偏好；不影响版本历史）；`verify:prompt:ui` R7 段真库同款。

> 说明：清理由 UI 边界 hook 触发，而非在 P5 服务内反向依赖 P6，避免层间耦合；直接调用
> `aiConfigService.deleteModel`（如测试清理）不会自动清理模板偏好，这是有意的分层取舍，
> 已在 §14.8 列为已知限制。

### 14.6 数据模型（Dexie `version(7)`，纯附加）

| 表 | 索引 | 说明 |
| --- | --- | --- |
| `promptTemplates` | `&id, projectId, category, taskKind, updatedAt` | 当前快照 |
| `promptTemplateVersions` | `&id, templateId, projectId, [templateId+version], createdAt` | 追加式历史 |
| `contextItems` | `&id, projectId, layer, updatedAt` | 持久上下文项（引用/手记） |
| `contextConfigs` | `&id, &projectId, updatedAt` | 每项目一行的配置（唯一 projectId） |

`aiModels` 新增可选字段 `contextWindowTokens`（无索引，无需迁移数据）。

### 14.7 验证结果（实测）

| 测试 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc -b --noEmit` | ✅ exit 0 |
| P6 逻辑（Node + Vite 打包） | `npm run verify:prompt` | ✅ **82 / 82** |
| P6 浏览器/UI（真浏览器 + IndexedDB） | `npm run verify:prompt:ui` | ✅ **27 / 27** |
| P5 AI 逻辑 | `npm run verify:ai` | ✅ **71 / 71** |
| P5 AI UI | `npm run verify:ai:ui` | ✅ **26 / 26** |
| P1–P4 回归 | `verify` / `verify:narrative` / `verify:outline` / `verify:editor` / `verify:markdown` / `verify:writing` / `verify:writing:ui` | ✅ 23/21/28/11/13/13/13 |
| 生产构建 | `npm run build` | ✅ exit 0 |

### 14.8 已知限制与风险

1. **模板偏好清理仅在 UI hook 路径触发**：绕过 hook 直接调用 `aiConfigService.deleteModel`
   不会清理模板偏好（见 §14.5 说明）。运行期解析不受影响（`resolveTarget` 有存在性校验），
   仅模板 UI 可能显示一个悬空偏好直至重新编辑。
2. **导入同名副本命名**为 `"X (imported N)"`，仅按内容判幂等；若同一包内多条同名且内容互异，
   会各自生成独立改名副本（符合“不丢内容”原则）。
3. **token 为近似估算**（字符启发式），非模型分词器精确值；预览已标注为 estimate。
4. **动态层不持久化**：动态上下文按请求派生，不存 `contextItems`（设计如此）。
5. **`timeline` 来源暂无解析器**，组装时以 `missing` 提示跳过（预留）。
6. Key 仍明文存 IndexedDB（P5 限制延续，未在 P6 范围内）。

### 14.9 结论

P6 在 R1–R10 上均满足；本次修复了 R6（同名异内容不再静默丢弃）与 R7（模板悬空偏好清理）
两处语义缺口，并补充了针对性测试。全部 P1–P6 测试、类型检查与生产构建通过。
**建议判定：PASS（含第 14.8 节所列、不阻塞范围的已知限制）。**

---

## 15. P7（Knowledge Base · Continuity · Story Analysis）交接

> 本节为 P7 追加，P4–P6 正文未改动。所有描述基于磁盘代码与真机实测。

### 15.1 交付范围

- **Knowledge Base**（`/ai/knowledge-base`）：结构化知识条目（character/location/faction/
  rule/event/item/concept/term）的增删改查、客户端搜索（全部关键词 AND）、以及**一键索引**现有
  项目实体（角色 / 世界观 + 分区 / 章节 / 场景 / 叙事规划）。索引**幂等**：重复运行只刷新不重复，
  每条导入条目保留**可追溯来源引用**（`source` / `sourceKey` / `sourceRef`）。
- **Continuity Manager**（`/ai/continuity-manager`）：事件溯源式「连续性事实」日志（谁在哪 /
  持有何物 / 知晓何事 / 关系 / 状态 / 属性），锚定到章节（可选场景）。展示「当前状态」与
  「某章节时点状态」两种**确定性重建**。重建始终按**实时大纲顺序**计算，章节重排后自动正确。
- **Plot Hole Detector**（`/ai/plot-hole-detector`）：确定性检测器（同一章节内同主体同谓词的
  矛盾、死亡后仍有动作、未回收的伏笔）。**用户点击才运行**，无后台扫描；每条发现**至少携带
  一条带定位的 evidence**（章节或场景），schema 与 Service 双向拒绝无证据发现。发现是审查
  数据：确认 / 驳回 / 解决 / 删除，绝不修改正文。

### 15.2 架构不变量

1. **证据必达**：`AnalysisFindingSchema` 要求 `evidence` 非空，且每条 evidence 必须含
   `chapterId` 或 `sceneId`；`AnalysisService.saveDraft/runDeterministic` 同样拒绝无证据发现
   （双保险，逻辑与真库均验证）。
2. **事件溯源、非可变快照**：连续性状态由事实日志按 `(subject, predicate)` 折叠得出；没有任何
   可变的每角色快照。`anchorRank` 由**实时大纲顺序**派生，故章节重排会改变重建结果（已实测）。
3. **只读分析**：检测只读取连续性事实与知识条目，不写入正文、不改动项目数据。
4. **分层不变**：UI → hooks（`useKnowledgeBase`/`useContinuity`/`useAnalysis`）→ services →
   repositories → Dexie；UI 不直接触库。项目删除级联清理三张新表（已实测）。

### 15.3 数据模型（Dexie `version(8)`，纯附加）

| 表 | 索引 | 说明 |
| --- | --- | --- |
| `knowledgeEntries` | `&id, projectId, kind, source, updatedAt, [projectId+sourceKey]` | 结构化知识；复合 `[projectId+sourceKey]` 支撑幂等导入 |
| `continuityFacts` | `&id, projectId, [projectId+anchorChapterId], subjectId, predicate, updatedAt` | 追加/可编辑的事实日志 |
| `analysisFindings` | `&id, projectId, category, status, severity, updatedAt` | 证据支撑的审查发现 |

### 15.4 关键实现说明

- **幂等导入 + 对账**：`KnowledgeService.importFromProject` 以
  `buildSourceKey(source, entityId, subKey)` 定位已有条目；存在则刷新（内容/标题/摘要/标签合并、
  保留用户证据），否则新建。导入后**对账**：删除 `source` 非 `manual` 且 `sourceKey` 已不在当前
  存活集合中的索引条目，使已删除来源不会残留误导性条目；手工条目永不删除。
- **搜索**：`deriveSearchText` 预计算小写 `searchText`；`search()` 按空白切词并**全部命中**，
  空查询返回全部。客户端搜索（项目条目集有界、已在内存），严格按项目隔离。
- **重建**：`compareFacts` 以 `anchorRank` 优先、其后 `createdAt`、再 `id` 稳定排序；
  `reconstructState(facts, { stopRank })` 折叠出每 `(subject, predicate)` 的最新值。`stopRank`
  为「到该章节为止（含）」。
- **检测器**（`AnalysisService.runDeterministic`）：同一章节内同主体同谓词冲突；`status=deceased`
  后仍有后续动作；`foreshadowing` 标签且无回收证据的条目。全部产出带证据的 `FindingDraft`；
  `saveDraft` 额外校验 evidence 的章节/场景属于该项目（`assertEvidenceInProject`）。

### 15.5 文件清单（P7 新增 / 修改）

**Schemas / types**

- `src/schemas/knowledge.ts`、`src/schemas/continuity.ts`、`src/schemas/analysis.ts`
  （持久化真源；`EvidenceSchema`、`compareFacts`、`reconstructState`、`stateKey`、
  `deriveSearchText`、`buildSourceKey`、各字面量联合）。
- `src/types/index.ts`（再导出 P7 类型与联合）。

**Repositories**

- `src/repositories/knowledge-repository.ts`、`continuity-repository.ts`、`analysis-repository.ts`。

**Services**

- `src/services/knowledge-service.ts`（CRUD、幂等导入 + 对账、搜索、级联）。
- `src/services/continuity-service.ts`（事实 CRUD、`currentState`、`stateAsOf`、anchor 校验、
  孤儿锚点过滤 `withoutOrphanedAnchors`）。
- `src/services/analysis-service.ts`（`runDeterministic`、`saveDraft`、`updateFinding`、
  `deleteFinding`、`listFindings`；evidence 项目内定位校验）。
- `src/services/index.ts`（单例与导出）。

**Hooks**

- `src/hooks/use-knowledge-base.ts`、`use-continuity.ts`、`use-analysis.ts`；`src/hooks/index.ts`。

**UI（`src/modules/ai/`）**

- `KnowledgeBasePanel.tsx`、`ContinuityManagerPanel.tsx`、`PlotHoleDetectorPanel.tsx`。

**接入 / 修改**

- `src/routes/index.tsx`（三个真实页面 + `REAL_PAGE_NAV_IDS` 排除占位）。
- `src/db/database.ts`（`version(8)` 三张表，纯附加，逐字重述旧 store）。
- `src/services/project-service.ts`（项目删除级联清理三张表）。

### 15.6 验证脚本与结果（实测）

| 测试 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc -b --noEmit` | ✅ exit 0 |
| P7 逻辑（Node + Vite 打包，注入假仓储） | `npm run verify:knowledge` | ✅ **66 / 66** |
| P7 浏览器/UI（真浏览器 + IndexedDB） | `npm run verify:knowledge:ui` | ✅ **16 / 16** |
| P6 逻辑回归 | `npm run verify:prompt` | ✅ **82 / 82**（无回归） |
| 生产构建 | `npm run build` | ✅ exit 0（三个 P7 页面独立分包） |

`verify:knowledge` 覆盖：evidence 定位必填（空/负 offset 拒绝）、finding 无证据被 schema 拒绝、
`deriveSearchText`/`buildSourceKey` 确定性、`compareFacts` 稳定排序与 tie-break、
`reconstructState` 最新值/顺序无关/as-of 截止/多谓词、Knowledge 导入幂等 + 来源可追溯 + 搜索
AND/空查询、Continuity anchor 校验/当前状态/as-of/**重排后重建随实时顺序变化**/更新删除、
Analysis 检测器仅产证据发现 + `saveDraft` 拒绝无证据 + 审查生命周期、级联隔离。
本次审计新增断言：**删除锚点章节后重建不再被孤儿事实污染**、**saveDraft 拒绝跨项目/跨章节
evidence 引用**、**重新索引时清理已删除来源的陈旧条目**。

`verify:knowledge:ui` 覆盖（真库）：三条路由渲染真实页面（非占位）、首导入创建 + 重导入幂等
（0 新增/全部刷新/总数不变）+ 来源可追溯 + 搜索命中/未命中、连续性当前状态 / as-of、**真实
`moveChapter` 重排后重建状态随之改变**、分析运行产出且全部证据支撑 + 拒绝无证据、项目删除级联
清空三表、无未捕获页面异常。

### 15.7 已知限制与风险

1. **检测器为确定性启发式**，覆盖三类高频问题；更复杂的跨章节因果/世界规则校验留待扩展，且
   均须遵循「证据必达」不变式。
2. **知识搜索为客户端 AND 子串匹配**（非向量/模糊）；来源索引不包含全部实体（如角色关系图细节），
   以现有实体粒度为准。
3. **连续性 `anchorRank` 依赖大纲查询**：若在服务外用非大纲路径改动章节顺序，需重新刷新状态；
   正常 UI/服务路径（`moveChapter`/`updateChapter`）已实测正确。
4. **AI 辅助发现生成未实现（本阶段有意留白）**：`AnalysisService` 目前只有纯确定性检测器，
   **不存在** `analyzeWithAi` 方法，UI 也无 AI 分析入口。`origin: 'ai'` 仅为保留枚举值；未来接入
   须经 P6 组装管线、显式用户触发、结果作为**草稿**经 `saveDraft` 审查（该入口已强制证据必达 +
   项目内定位校验）。
5. **Timeline Events / Foreshadowing 无独立实体**：项目数据模型中时间线以章节/场景/叙事节拍
   承载，伏笔以叙事节拍文本启发式打标（`foreshadowing`）。知识索引据此归入 `event`/节拍条目，
   无独立「时间线事件」表。
6. **搜索严格按项目隔离**：`search()` 只在**当前项目**条目内检索，不跨项目（符合分层内数据作用域）。

### 15.8 本次审计（验收前完整性审计）的修复记录

针对验收审计任务逐项核对后，修复了三处与「完整性契约」相关的缺口，并同步修正了与实现不符的注释：

1. **删除锚点章节污染重建**（对应「Deleted anchors must not silently produce incorrect state」）：
   此前 `currentState/stateAsOf` 只把实时 rank 用于**排序**，整条事实日志（含锚点已删章节的
   孤儿事实）都会被折叠进状态，导致已删章节的事实仍作为「当前值」出现。已在
   `ContinuityService` 增加 `withoutOrphanedAnchors()`：当**有实时大纲**（`chapterRank` 非空）时，
   排除 `anchorChapterId` 不在当前大纲中的事实（事实行本身**保留在日志**，只是不进重建视图；
   无大纲时回退到缓存 rank，避免误删全部）。`stateAsOf` 对已删章节仍抛错。
   断言见 `verify:knowledge` §7b（基线 lighthouse → 删章后回退 harbour、事实行仍在、asOf 抛错）。

2. **发现 evidence 未做项目内定位校验**（对应「Chapter/Scene references are project-scoped」）：
   `AnalysisService.saveDraft` 之前只校验 evidence 非空，不校验 `chapterId/sceneId` 是否属于该项目。
   现注入 `OutlineService/SceneService`，新增 `assertEvidenceInProject()`：`chapterId` 必须属于项目；
   `sceneId` 必须属于其 `chapterId`（孤立 `sceneId` 必须在项目某章节下），否则拒绝。`runDeterministic`
   先过滤锚点已删的事实，且对因锚点失效而无法安全落库的草稿**计入 skipped 而非中断整轮**。
   断言见 `verify:knowledge` §8（拒绝跨项目章节、拒绝跨章节场景、接受项目内合法定位）。
   注：因该改动 `AnalysisService` 构造新增两个可选依赖（默认真实服务），`p7-verify.cjs` 注入假
   outline/scene。

3. **重新索引遗留陈旧条目**（对应「Deleted or unavailable source entities do not silently produce
   misleading entries」）：`importFromProject` 之前只 upsert、不回收，删除角色后再索引会残留
   指向已删实体的陈旧知识条目。现改为**对账**：先收集当前存活 `sourceKey` 集合，upsert 后删除
   `source` 非 `manual` 且 `sourceKey` 不在存活集合中的索引条目（手工条目永不删除）。
   `ImportKnowledgeResult` 新增 `removed` 计数，UI 导入提示如实显示「stale removed」。
   断言见 `verify:knowledge` §6（删角色再索引后角色索引条目归零、手工条目保留、`removed≥1`）。

4. **注释与实现对齐**：`AnalysisService` 类注释与 `schemas/analysis.ts` 曾声称存在 `analyzeWithAi`
   且「复用 P5」，实际并无该方法。已改为如实说明「AI 辅助发现本阶段未实现（保留）」，避免误导读代码者。

修复后：`verify:knowledge` 从 56 增至 **66** 项、`verify:knowledge:ui` 仍 16/16、类型检查与
生产构建通过、P6 及 P1–P4 回归全绿。

### 15.9 完整性契约逐项判定（审计结论）

| 契约项 | 判定 | 证据 |
| --- | --- | --- |
| 知识索引覆盖所有要求实体 | ✅（时间线/伏笔见说明） | 角色/地点/阵营/世界规则/历史事件/章节/场景均实测生成对应条目；时间线以章节·场景·节拍承载、伏笔为节拍启发式标签 |
| 索引幂等（重复运行无重复） | ✅ | `verify:knowledge` §6（secondary imported=0） |
| 搜索跨相关字段、项目隔离 | ✅ | `search` 用 `searchText`（标题/摘要/正文/标签）AND 匹配；严格按项目 |
| 删除来源不产生误导性陈旧条目 | ✅（本次修复） | §15.8-3 |
| 条目可追溯至来源 | ✅ | `sourceKey`/`sourceRef` 断言 |
| 连续性事实校验到有效存在条目 | ✅ | `createFact/updateFact` 校验章节属于项目、场景属于章节 |
| 连续性事实锚定并可用 | ✅ | `anchorChapterId` 必填、`verify` 已测 |
| 事实重建为一致状态 | ✅ | `reconstructState` 确定折叠 |
| 改动剧情顺序后后续重建反映新顺序 | ✅ | 逻辑 + 真库 `moveChapter` 均断言 |
| 任意时点重建 | ✅ | `stateAsOf` 到章节（含其场景）为止 |
| 支持所需谓词 | ✅ | position/possession/knowledge/relationship/status/attribute |
| 项目删除级联清理 P7 数据 | ✅ | 逻辑 + 真库级联断言（findings→continuity→knowledge 顺序） |
| 删除锚点不产生错误状态 | ✅（本次修复） | §15.8-1 |
| 每个发现至少一条证据（schema 拒绝） | ✅ | `evidence.min(1)` + `saveDraft` 双保险 |
| 证据含定位（章节/场景）与摘要/引用 | ✅ | `EvidenceSchema`（chapterId/sceneId + quote/offset/note） |
| 发现引用项目内章节/场景 | ✅（本次修复） | §15.8-2 |
| 发现使用有意义的类别与严重度 | ✅ | 6 类别 × 3 严重度；三类检测器覆盖 |
| 高置信发现标记来源 | ✅ | `origin: deterministic|ai|manual`（本阶段确定性） |
| 发现可审查且不与正文冲突 | ✅ | open/confirmed/dismissed/resolved + 只读分析 |
| 各功能类别存在 AI 辅助 | ❌（时间线/连续性/分析 AI 均未实现，见 §15.7-4） | 确定性检测器为主；AI 路径保留未启用（符合任务「不得重设计」约束） |
| 证据导航到被引用章节/场景 | ✅（UI 展示定位） | 分析面板逐条渲染 evidence 定位；连续性面板显示锚点章节 |

> AI 辅助分析的缺失为**任务明确允许的范围**（「若缺失，只报告、不重设计/重实现」），已如实
> 记录于 §15.7-4，不影响完整性契约中「确定性、证据支撑、只读审查」的核心判定。

### 15.10 结论

P7 三个模块均按「幂等 / 证据必达 / 事件溯源 / 只读分析 / 分层不变」实现；本次审计修复了
「删除锚点污染重建」「evidence 项目内定位校验」「重新索引清理陈旧条目」三处完整性缺口。
逻辑 **66/66**、真库 UI 16/16、P6 回归 82/82、P1–P4 回归全绿、类型检查与生产构建全部通过。
**建议判定：PASS（含 §15.7 所列、不阻塞范围的已知限制，以及 §15.9 中如实标注的 AI 辅助分析尚未实现项）。**

