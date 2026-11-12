# P4 工作交接（AI_HANDOFF）

> 本文件基于 **磁盘上的实际代码** 整理，不以聊天历史中的计划代替实际进度。
> 生成时间：P4（Writing Editor）开发中断后。
> 最后提交：`5b13065 P1开发结束`（P1–P4 的全部代码均**未提交**，停留在工作区）。

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

- **无严格意义上的半成品文件**。所有编辑器文件均可编译，类型检查通过。唯一缺陷是数据层的一个并发竞态（见 §7），导致 UI 流程无法跑通。

### 3.3 未完成

- **§7 的并发竞态修复**（`ensureChapterDraft` / `ensureSceneDraft`）—— 这是 P4 唯一的核心阻塞项。
- 修复后的 UI 端到端回归（`verify:writing:ui` 需全绿）。
- 场景正文（Scene）的编辑器入口：服务层与 schema 已就绪，但 **UI 目前只有章节编辑器**，尚未提供场景正文编辑界面（属 P4 范围内可延后项）。
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
| `src/modules/editor/use-chapter-editor.ts` | 引擎 → React 状态桥接 |
| `src/modules/editor/MarkdownEditor.tsx` | TipTap 编辑面积 |
| `src/modules/editor/WritingPanel.tsx` | Writing 标签主界面 |
| `src/modules/editor/VersionHistoryDialog.tsx` | 版本历史对话框 |
| `src/modules/editor/ImportExportDialog.tsx` | 导入/导出对话框 |
| `scripts/p4-autosave-unit.cjs` | 自动保存引擎单元测试 |
| `scripts/p4-markdown-unit.cjs` | Markdown 工具单元测试 |
| `scripts/p4-verify.cjs` | 浏览器数据层端到端（13 项） |
| `scripts/p4-ui-verify.cjs` | 浏览器 UI 端到端（12 项） |

> 其余 `?? ` 未跟踪文件（`src/modules/world|characters|narrative|outline/`、对应 schemas/repositories/services/hooks）属 P2–P3 成果，同样未提交，**不要动**。

---

## 6. 已执行的测试与结果（本次实测）

| 测试 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc -b --noEmit` | ✅ 通过（exit 0） |
| 自动保存单元 | `node scripts/p4-autosave-unit.cjs` | ✅ **11 / 11 PASS** |
| Markdown 单元 | `node scripts/p4-markdown-unit.cjs` | ✅ **13 / 13 PASS** |
| 数据层（真浏览器 + IndexedDB） | `node scripts/p4-verify.cjs` | ✅ **13 / 13 PASS** |
| UI 端到端（真浏览器） | `node scripts/p4-ui-verify.cjs` | ❌ **5 / 12 PASS，7 FAIL** |

**UI 测试通过的 5 项**：seed、项目详情页渲染、Writing 标签存在且可点击、章节标题与左侧导航渲染、清理无孤儿。

**UI 测试失败的 7 项**（全部同一根因）：
`TipTap 编辑面未挂载` → 无法聚焦 → 无法输入 → 无自动保存 → 无持久化 → 刷新无内容 → 切换章节无 flush。

失败时的界面文本证据：
> `The manuscript could not be loaded.` / `Failed to create the draft "cdraft_…"` / `Retry`

同时在页面上下文**直接调用** `manuscriptService.openChapterDraft(...)` 却返回 `{ ok: true }` —— 证明是并发/重复调用问题，而非 schema 或逻辑错误。

---

## 7. 未解决的关键问题（唯一阻塞项）

### 7.1 现象

打开 Writing 标签时报 `Failed to create the draft "cdraft_..."`，编辑器不渲染。

### 7.2 根因（已定位，来自实测）

- `main.tsx` 使用 `<StrictMode>`，开发模式下 effect 会**执行两次**。
- `ManuscriptService.openChapterDraft()` 采用「**先查后建**」：

  ```ts
  let draft = await this.repository.getChapterDraft(chapterId);
  if (!draft) {
    draft = await this.repository.createChapterDraft(this.newChapterDraft(projectId, chapterId));
  }
  ```

- 两次并发调用都查到 `null`，于是各自 `add()` 一条**不同 id** 的稿件；而 `chapterDrafts` 有唯一索引 `&ownerId`，第二次写入违反唯一约束 → 抛错 → UI 显示「无法加载」。

这是**真实缺陷**，不只在开发模式出现：双击、两个标签页、快速切换章节都会触发。

### 7.3 修复方案（已设计，**尚未落盘**）

在 `src/repositories/manuscript-repository.ts` 增加**事务内原子 upsert**（检查与写入在同一个 Dexie 事务中，冲突时重新读取已有行）：

```ts
async ensureChapterDraft(factory: () => ChapterDraft): Promise<{ draft: ChapterDraft; created: boolean }> {
  return await getDb().transaction('rw', this.chapterDraftTable, async () => {
    const existing = await this.chapterDraftTable.where('ownerId').equals(factory().ownerId).first();
    if (existing !== undefined) return { draft: existing, created: false };
    const validated = validate(factory(), ChapterDraftSchema);
    await this.chapterDraftTable.add(validated);
    return { draft: validated, created: true };
  });
}
// ensureSceneDraft 同理（sceneDraftTable / SceneDraftSchema）
```

然后 `ManuscriptService.openChapterDraft` / `openSceneDraft` 改为调用 `ensure*Draft`，用返回的 `created` 作为原有 `created` 标志。

> ⚠️ 上一次会话中此修改的编辑**未成功落盘**（已核对：`manuscript-repository.ts` 中不存在 `ensureChapterDraft`）。因此该 bug 仍然存在，需要重新实施。

---

## 8. 准确的续接位置（下一步任务）

按顺序执行：

1. **【必修】实现 `ensureChapterDraft` / `ensureSceneDraft`**（§7.3），并在 `ManuscriptService.openChapterDraft` / `openSceneDraft` 中改用它们。
   - 文件：`src/repositories/manuscript-repository.ts`、`src/services/manuscript-service.ts`
   - 注意 `getDb()` 已在 repository 文件顶部导入；`ChapterDraftSchema` / `SceneDraftSchema` / `validate` 均在同文件可用。
2. 运行 `npx tsc -b --noEmit` 确认通过。
3. 运行 `node scripts/p4-ui-verify.cjs`，预期 **12 / 12 PASS**；若仍有失败，按失败项定位（不要改测试来迁就实现）。
4. 回归 `node scripts/p4-verify.cjs`（应为 13/13）、`p4-autosave-unit.cjs`（11/11）、`p4-markdown-unit.cjs`（13/13）。
5. 顺带回归 P3 不被破坏：`node scripts/p3-verify.cjs`。
6. **更新 README**：状态改为 P4；Roadmap 中 P4 打勾并删除重复的 `P3` 行；补充 P4 的 `verify:*` 脚本说明。
7. （可选，P4 范围内可延后）为**场景正文**提供编辑入口 —— 服务层（`openSceneDraft` / `saveSceneDraft`）与 schema 已完备，只缺 UI。

### 明确禁止重复开发（已实现且测试通过）

- 自动保存引擎全部能力（防抖、串行、冲突、switchTo flush、maxWait、注入时钟）
- Markdown 统计/切分/拼接/标题规范化，以及章节内标题降级
- Markdown 导入（预览/重复处理）与导出
- 版本快照、手动快照、恢复（追加式）、裁剪
- 章节锁定（`final` 拒绝写入 + UI 只读）
- 级联删除（含版本历史一并清理）
- Writing 标签接入与整个编辑器 UI 骨架、版本/导入导出对话框、字数与保存状态显示
- 上述四套测试脚本本身

---

## 9. 运行验证的前置条件

- 需要一个 dev server：`npm run dev -- --port 5177 --strictPort`（P4 脚本硬编码 `http://localhost:5177/`）。
- **不要重复启动** dev server；先检查 `5177` 端口是否已在监听。
- 浏览器脚本使用 `C:\Program Files\Google\Chrome\Application\chrome.exe`，headless + CDP。
- 单元测试（autosave / markdown）不需要 dev server。
