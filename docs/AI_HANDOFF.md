
# P4 工作交接（AI_HANDOFF）

> 本文件基于 **磁盘上的实际代码** 整理，不以聊天历史中的计划代替实际进度。
> 最后更新：P4（Writing Editor & Auto-save）收尾验收完成时。
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
- 单元测试（autosave / markdown）不需要 dev server。
