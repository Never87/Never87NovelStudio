# P9 用户使用说明与开发说明（Publishing · Export · Data Management）

> 适用范围：**P9 Batch A–E 已交付并在磁盘代码中存在的功能**。
> 本文档只描述**实际实现**，不夸大能力；未实现项与已知限制在 §6 显式列出。
> 最后整理：P9 Batch F（Integration / Regression / Documentation）。

P9 在导航中对应两个分组：

- **Publishing & Export**：Export Manager、Publishing Presets、Chapter Export、Book Covers、Blurb Generator、Portfolio、Royalty Calculator。
- **Version & Data Management**：Version History、Diff Viewer、Project Snapshots、Backup & Restore、Import / Export Project（见 §6 的占位说明）。

---

## 1. 支持的导出格式及限制

导出由 **全书画导出服务**（`src/services/full-book-export-service.ts`）+ **格式注册表**
（`src/modules/publishing/writers/format-registry.ts`）统一驱动。所有格式都消费同一个
**中间表示层 `RenderedDocument`（IR）**，因此预览与最终文件不会走两套排版路径。

| 格式 | 扩展名 | 能力 | 限制 / 已知行为 |
| --- | --- | --- | --- |
| Plain text | `.txt` | 纯文本，章节顺序严格等于大纲顺序 | 无样式；内联 Markdown 标记被保留或按预设剥离 |
| Markdown | `.md` | 标题 / 强调 / 粗体结构化 | 只输出受支持的子集，不做完整 Markdown 方言 |
| HTML | `.html` | 自包含单页，可直接浏览器打开 | 不含远程字体/图片，纯本地样式 |
| Word | `.docx` | 真实样式、可编辑 | 由 JSZip 生成，非 Office 原生排版引擎，复杂版式有限 |
| EPUB | `.epub` | EPUB 3，可嵌入封面 | **仅 PNG/JPEG 封面可嵌入**；WebP 封面不入书（见 §5）；无远程资源 |
| PDF | `.pdf` | 固定版式，**内置中文字体** | 依赖随包字体字节；字体缺失时 PDF 不可用（报 `font-missing`），其它格式不受影响 |

**通用限制**

- 导出是**只读**操作：不写数据库、不建版本、不建快照、不改草稿。
- 文件名由**预设的文件名模板** + 文件名工具生成（文件系统安全、Unicode 安全）。
- 章节顺序**只**来自 `bookAssemblyService.assembleBook`，与预览、其它格式完全一致。
- Kindle 等外部平台不在应用内直连，EPUB 需自行用其工具转换（见 §6）。
- 导出失败会抛出带稳定错误码的异常（`project-not-found` / `assembly-failed` /
  `font-missing` / `writer-failed` / `unknown-format`），**绝不会伪造空文件或半成品**。

---

## 2. Preset 的作用与限制

Preset 决定**排版规则 + 文件名模板 + 元数据**，是导出格式化的单一真源。

**内置预设**（`src/modules/publishing/presets.ts`）：

| id | 名称 |
| --- | --- |
| `generic` | Generic（默认安全默认值） |
| `qidian` | 起点中文网 |
| `jinjiang` | 晋江文学城 |
| `fanqie` | 番茄小说 |
| `wattpad` | Wattpad |
| `royal-road` | Royal Road |
| `amazon-kdp` | Amazon KDP |
| `generic-epub` | Generic EPUB |

**共享状态**

- 选中预设与用户自定义预设保存在**全局 `localStorage`**（键 `n87-publishing-presets`，
  版本化 envelope），由单例 `publishingPresetStore`
  （`src/modules/publishing/preset-store.ts`）统一管理。
- **Publishing Presets 页**、**Chapter Export 页**、**Export Manager 页**读取的是**同一份**
  选中状态（均通过 `usePublishingPresets` / `publishingPresetStore`），**全局只保留这一份** 选中值，
  不存在第二份副本把选中值同步回全局存储的机制。

**限制**

- 内置预设**只读**，不能修改或删除；自定义预设从内置预设克隆后编辑。
- 每个项目**不再单独**保存预设选择：当前选中预设是全局偏好，切换项目不会自动切换预设。
- 存储损坏 / 版本不符时，读取**不抛异常**：回退到安全默认（`generic`）并给出
  `recoveryNotice`，且**不会静默覆盖**原有字节（仅在下一次显式保存时才覆写）。
- 自定义预设的字段由 Zod 严格校验（`CustomPresetDraftSchema`），非法草稿被拒绝并给结构化错误。

---

## 3. 各功能使用方法

### 3.1 Book Covers

- 上传 **PNG / JPEG / WebP** 封面（尺寸、字节大小、宽高比均有校验与警告）。
- 封面**字节**存于独立库表 `coverAssets`（Blob），项目行只保存短引用
  `cover: "asset:<assetId>"`（`src/schemas/cover-asset.ts`）。
- 一个项目可有多个封面变体；项目当前封面由 `cover` 引用决定。
- 上传新封面会**清理被替换的旧资产**（非致命失败仅记录，不影响新封面生效）。

### 3.2 Blurb Generator

- 通过 P5 AI 管线生成**公开安全的**简介上下文（标题、类型、标签、叙事主轴、世界观、角色名/角色/摘要），
  **绝不上传**正文、内部笔记或凭据。
- 生成结果为**待审阅草稿**，服务层 `BlurbService` **从不写入项目**；保存是 UI 里**显式**
  通过 `ProjectService.updateProject({ blurb })` 完成。
- 简介字段 `blurb` 与内部摘要 `description` **相互独立**：保存简介不动 `description`，反之亦然。

### 3.3 Portfolio

- 将项目行（title / genre / tags / status / blurb / 字数目标）与**可选的**
  `PortfolioProfile` 展示覆盖合成为 `PortfolioEntry`（`portfolio-entry.ts`，纯函数）。
- 覆盖优先级：**profile 覆盖 → 项目值 → 计算回退**（如标题回退 `"Untitled"`，无作者为 `null`）。
- Portfolio **绝不使用**内部 `description` 作为简介——只读 `project.blurb`；封面色、类型、状态均为
  **实时读取**，不在 profile 中复制。
- 一个项目**至多一个** profile（`portfolioProfiles` 表对 `projectId` 建**唯一索引**）。
- 排序：精选优先 → `displayOrder` 升序 → 最近更新降序。

### 3.4 Royalty Calculator

- 纯前端估算：基于价格、销量、固定分成/费率，按**整数分**计算，跨平台对比。
- 所有费率为**假设值**，界面显示醒目的**估算免责声明**；不代表任何平台实际结算。

---

## 4. 数据行为（Version History / Snapshots / Backup & Restore）

理解 P9 的关键：这些是**三种不同粒度**的恢复/搬运机制，互相独立。

| 机制 | 范围 | 存储位置 | 是否写入项目 JSON 备份 |
| --- | --- | --- | --- |
| **Version History / Diff Viewer** | 单章/单场景的**文本版本** | `draftVersions`（章节草稿版本）等 | 是（属于项目内容） |
| **Project Snapshots** | **整项目**点时快照 | `projectSnapshots` | 是（快照即整项目 payload） |
| **Backup & Restore**（`.n87novel` 文件） | **单项目**完整备份到**设备文件** | 用户设备上的文件 | 是（备份文件本身，非端点以内） |

- **Version History**：浏览某章的每个已保存版本并可安全恢复；恢复替换当前草稿并记录一条恢复版本，
  旧版本保留。
- **Snapshots**：整项目点时捕获；恢复为**原子事务**，恢复前自动生成**安全快照**，失败整体回滚。
- **Backup & Restore**：下载单项目完整 JSON（`.n87novel`）；导入只做**只读预览/校验**，
  **恢复**（新建 / 覆盖）是此页唯一写路径，覆盖前刷新编辑器并自动安全快照，事务内重校验、失败回滚。
- **项目快照 vs 备份文件**：快照是"浏览器内恢复点"；备份是"你设备上的文件"。二者不同，页面文案已明示。

---

## 5. 设备本地资源 vs 项目内容（重要边界）

- **封面字节（`coverAssets`）** 与 **Portfolio 展示档案（`portfolioProfiles`）** 是**设备本地资源/展示元数据**，
  **刻意不进入** `.n87novel` 项目 JSON 传输包与工作区备份（见 `src/transfer/collection-registry.ts`
  的 `EXCLUDED_TABLES`）：
  - 封面是 Blob，不能 JSON 表示；项目只保留 `cover: "asset:<id>"` 短引用。导入到新设备后该引用可能指向
    不存在的资产 → UI **优雅降级为占位符**，绝不崩溃；WebP 封面因 EPUB 不支持也不入书。
  - Portfolio 展示档案是"策展覆盖"，属设备本地偏好；**项目行才是 title/description/blurb/genre/status
    的真源**，Portfolio 实时从项目解析。移机后不携带过时的策展层，目标设备上项目以纯项目值呈现。
- **不会被加入项目 JSON 备份**：`coverAssets`、`portfolioProfiles`、`projects`（根行单独处理）、
  AI 凭据表（`SECRET_BEARING_TABLES`）以及工作区级设备设置。
- **删除级联**：删除项目时，`coverAssets` 与 `portfolioProfiles` 与其余项目-owned 集合一并清理
  （`ProjectService.deleteProject`，在删除项目根行之前、逐表幂等删除）。

---

## 6. 未实现功能与已知限制（如实标注，不夸大）

**明确不在首版范围 / 未实现**

- **不自动发布**，**不登录任何外部平台**（起点 / 晋江 / 番茄 / Wattpad / Royal Road / Amazon KDP 等均**无账号接入、
  无自动上传**）。预设仅提供**本地排版规则**。
- **Kindle / 平台直连转换** 不实现；EPUB 需用户自行搬运/转换。
- **Blurb → EPUB/PDF 导出**：当前导出管线**不消费 `blurb`**，简介**不会**自动写入导出文件
  （Blurb → Portfolio 的读取链接已实现；Blurb → 导出文件**未实现**，此为已知缺口）。
- **Import / Export Project 页面（`/data/project-import-export`）**：导航项存在，但**仍是占位页**
  （不在 `REAL_PAGE_NAV_IDS`）。单项目 `.n87novel` 的实际导出/导入/恢复由 **Backup & Restore** 页提供；
  独立的 project-io 专用页**尚未实现**。
- **工作区（全部项目）备份**：未实现（Backup & Restore 仅支持单项目文件；工作区级能力在传输层层级存在，
  但无独立 UI 页）。
- **跨标签页锁**：Project Snapshots / Backup & Restore **无跨标签页写锁**；其它标签页通过 UI 提示"请刷新"，
  依赖乐观并发。
- **Portfolio 封面**：由 hook 实时解析为对象 URL 显示，profile **不存封面副本**；设备本地资产缺失时降级占位。

**已知限制**

- PDF 依赖随包中文字体；字体加载失败则 PDF 不可用（其它格式仍可用）。
- EPUB 仅嵌入 PNG/JPEG 封面；WebP/外部 URL 封面不嵌入。
- 导出/格式化只覆盖受支持的 Markdown 子集（粗体/斜体/代码等），非完整方言。
- Royalty Calculator 全部为**估算**，非任何平台真实结算口径。

---

## 7. 开发说明（架构与不变量）

**分层**（自下而上）：`types`（TS 类型）→ `schemas`（Zod，持久化唯一真源）→ `db`（Dexie，版本推进迁移，
**纯附加**）→ `repositories`（读/写均 Zod 校验）→ `services`（业务规则、id、时间戳、级联）→
`hooks`（React 数据绑定）→ `modules`（页面）。

**P9 数据模型（Dexie 纯附加版本）**

- `v14 coverAssets`（`&id, projectId, createdAt`）—— 封面 Blob。
- `v15 portfolioProfiles`（`&id, &projectId, updatedAt`）—— **唯一 `projectId`** 强制"一项目一档案"。
- 每次升级**逐字重述**旧 store，数据保全；新表从空开始。

**关键不变量（P9 不得破坏）**

1. **单一真源**：章节顺序只来自 `assembleBook`；格式决策只在 `format-registry`；预设选择只在
   `publishingPresetStore`。
2. **导出只读**：导出/预览不写 DB、不建版本/快照、不改草稿。
3. **传输排除**：`coverAssets` / `portfolioProfiles` 永不进入 `.n87novel`；项目 JSON 只含 19 个项目-owned 集合。
4. **简介/摘要独立**：`blurb` 与 `description` 相互隔离，任何编辑一方都不改另一方。
5. **Portfolio 不复制**：仅存策展覆盖；封面/简介/类型/状态实时读取；`description` 永不泄漏到 Portfolio。
6. **删除级联**：删除项目须清理 `coverAssets` + `portfolioProfiles` + 其余项目-owned 集合，再由根行删除。

**验证脚本**（`scripts/`，`npm run verify:*`）：见 §8 的实测清单。

---

## 8. P9 Batch F 回归实测结果（本机，无 dev server）

> 环境约束：本批次**未启动任何服务器**，仅运行**不依赖 dev server** 的纯逻辑/服务层测试。
> 依赖浏览器/IndexedDB/CDP 的 UI 与 IDB 测试**本次未运行**，见 §9。

- P9 纯逻辑 / 服务层套件：全部通过 —
  `p9-publishing-unit` 125、`p9-history-unit` 27、`p9-transfer-unit` 85、`p9-snapshot-unit` 28、
  `p9-snapshot-service-unit` 46、`p9-snapshots-ui-unit` 43、`p9-backup-unit` 46、`p9-backup-preview-unit` 47、
  `p9-backup-restore-unit` 93、`p9-backup-restore-coord-unit` 39、`p9b-presets-logic-unit` 85、
  `p9c-export-unit` 202、`p9d-blurb-unit` 47、`p9d-covers-unit` 45、`p9d-epub-cover-verify` 28、
  `p9e-royalty-unit` 46、`p9e-portfolio-unit` 34、`p9e-portfolio-service-unit` 23。
- P1–P8 纯逻辑回归：通过 —
  `p4-autosave-unit` 11、`p4-markdown-unit` 13、`p5-verify` 71、`p6-verify` 82、`p7-verify` 86、
  `p8-verify` 122、`p8-batch2-verify` 106、`p8-extraction-verify` 110、`p8-review-verify` 63、
  `p8-integration-verify` 60。
- 类型检查：`tsc -b --noEmit` → exit 0。
- 生产构建：`npm run build` → exit 0。

---

## 9. 本次未运行 / 环境阻塞的测试清单（明确标记：未验证）

> 以下测试**需要 dev server（默认 `http://localhost:5177/`）+ headless Chrome / IndexedDB**。
> 本批次**禁止启动服务器**，故**未运行**，**不记为 PASS**。需在有 dev server 的环境下补跑。

**Browser UI / IndexedDB（P1–P4，需 server）**

- `p2a-verify`（`npm run verify`）—— 实测尝试时报 `chrome-error://...` 动态导入失败，**确认需 server，未验证**。
- `p2b-verify`（`verify:narrative`）—— **未验证**（同上，需 server）。
- `p3-verify`（`verify:outline`）—— **未验证**（需 server）。
- `p4-verify`（`verify:writing`）—— 实测尝试同样 `chrome-error://...`，**确认需 server，未验证**。

**Batch B/C/D/E 浏览器 UI / IndexedDB（本次未跑）**

- Batch B：`p9b-publishing-ui-verify`（`verify:publishing:ui`）。
- Batch C：`p9c-export-ui-verify`（`verify:export:ui`）。
- Batch D：`p9d-blurb-ui-verify`、`p9d-blurb-idb-verify`（`verify:blurb:ui` / `verify:blurb:idb`）。
- Batch E：`p9e-idb-ui-verify`（`verify:portfolio:ui`，含 Portfolio 持久化 + Royalty UI）。
- 其它 P9/P8 IDB/UI：`p9-b2-idb-verify`、`p9-snapshots-ui-verify`、`p9-snapshot-idb-verify`、
  `p9-snapshot-service-idb-verify`、`p9-backup-idb-verify`、`p9-backup-ui-verify`、`p9-backup-preview-idb-verify`、
  `p9-backup-preview-ui-verify`、`p9-backup-restore-idb-verify`、`p9-backup-restore-ui-verify`、
  `p9-transfer-idb-verify`，以及各 `p*-ui-verify` / `p*-idb-verify`。

> 说明：上述"未验证"不代表失败，也不代表通过——是**因环境（无 server）而未执行**，需后续在带 server 的环境补测。
