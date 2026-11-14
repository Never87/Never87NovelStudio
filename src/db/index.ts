import { NovelStudioDb, getDb, __setDbForTesting } from './database';

/**
 * Database entry point.
 *
 * The whole app shares ONE `NovelStudioDb` instance. React components must not
 * import this module directly — they go through the Repository/Service layer
 * (P1-B onwards) so IndexedDB access stays in one place.
 */

export { NovelStudioDb, getDb, __setDbForTesting };

/** The single application database instance. */
export const db: NovelStudioDb = getDb();

/** Error raised when the database cannot be opened, with a diagnosable cause. */
export class DatabaseInitError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DatabaseInitError';
    this.cause = cause;
  }
}

/**
 * Opens the database, initialising indexes/upgrades as needed.
 *
 * Called once during app bootstrap (not at import time). Failures are wrapped
 * so the original error — including Dexie's `Inner`/`name`, which usually
 * explains quota, privacy-mode or version problems — is preserved for logging.
 *
 * @returns the ready database instance.
 */
export async function initDatabase(database: NovelStudioDb = db): Promise<NovelStudioDb> {
  try {
    await database.open();
    return database;
  } catch (error) {
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new DatabaseInitError(
      `Failed to open IndexedDB database "${database.name}" (${detail}). ` +
        'Check that IndexedDB is available (not blocked by a private window) and that the schema version is consistent.',
      error,
    );
  }
}

/**
 * Closes the database connection (used on app teardown, e.g. simulated logout).
 * The instance remains usable — a later query re-opens it.
 */
export function closeDatabase(database: NovelStudioDb = db): void {
  database.close();
}
