import { ProjectService } from './project-service';
import { WorldService } from './world-service';
import { CharacterService } from './character-service';
import { NarrativeService } from './narrative-service';
import { OutlineService } from './outline-service';
import { SceneService } from './scene-service';
import { ManuscriptService } from './manuscript-service';
import { ManuscriptTransferService } from './manuscript-transfer-service';

/**
 * Module-level application Services.
 *
 * Single instances are created here and shared by every hook, so the (single)
 * Dexie database behind them is reused instead of being rebuilt on each
 * render. Each Service already defaults to a Repository bound to the singleton
 * `db`, so no extra repository/database is constructed.
 *
 * Hooks import THESE instances — they never call `new XService()`.
 */
export const projectService = new ProjectService();
export const worldService = new WorldService();
export const characterService = new CharacterService();
export const narrativeService = new NarrativeService();
export const outlineService = new OutlineService();
export const sceneService = new SceneService();
export const manuscriptService = new ManuscriptService();
export const manuscriptTransferService = new ManuscriptTransferService();

export { ProjectService };
export type { CreateProjectInput, UpdateProjectInput } from './project-service';
export { WorldService };
export type { CreateWorldInput, UpdateWorldInput } from './world-service';
export { CharacterService };
export type { CreateCharacterInput, UpdateCharacterInput } from './character-service';
export { NarrativeService };
export {
  NarrativeAlreadyExistsError,
  NarrativeNotFoundError,
  NarrativeServiceError,
} from './narrative-service';
export type {
  CreateNarrativeInput,
  UpdateNarrativeInput,
  PlotBeatInput,
} from './narrative-service';
export { OutlineService, OutlineNotFoundError } from './outline-service';
export type {
  VolumeWithChapters,
  CreateVolumeInput,
  UpdateVolumeInput,
  CreateChapterInput,
  UpdateChapterInput,
} from './outline-service';
export { SceneService } from './scene-service';
export {
  ManuscriptService,
  DraftConflictError,
  ChapterLockedError,
} from './manuscript-service';
export { ManuscriptTransferService } from './manuscript-transfer-service';
export type {
  ImportPreviewChapter,
  ImportResult,
  ImportOptions,
} from './manuscript-transfer-service';
export type {
  ChapterEditorDocument,
  SaveDraftInput,
  SaveDraftResult,
  RestoreVersionResult,
  CreateDraftOptions,
} from './manuscript-service';
export type { CreateSceneInput, UpdateSceneInput } from './scene-service';
export {
  ProjectServiceError,
  ProjectRepositoryError,
  ProjectValidationError,
  ProjectNotFoundError,
  ProjectAlreadyExistsError,
} from './project-service';
