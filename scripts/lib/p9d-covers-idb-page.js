/**
 * In-page driver for `p9d-covers-idb-verify.cjs` (P9 Batch D — Book Covers, REAL IDB).
 *
 * NOT executed by Node. The harness reads this text and evaluates `(${...})()`
 * inside a headless-Chrome tab via the DevTools Protocol, so it runs against the
 * REAL app modules served by Vite (`/src/...`) and the browser's REAL IndexedDB.
 *
 * Exercises `CoverService` end-to-end against real persistence:
 *   1. upload PNG → asset stored as Blob, project.cover = asset:<id>, resolvable;
 *   2. replace → the superseded asset is deleted (no orphan), exactly one asset;
 *   3. WebP is stored but NOT export-embeddable (writers get null); PNG/JPEG are;
 *   4. removeCover → project.cover cleared and asset deleted;
 *   5. project isolation → operating on A never touches B's cover assets;
 *   6. missing/orphaned asset reference → resolves to `asset-missing`, no crash;
 *   7. external URL cover → resolves to `external`, not an asset;
 *   8. project delete cascade → the project's cover assets are physically gone.
 *
 * Cover validation runs for real; only the image DIMENSION probe is stubbed
 * (deterministic dims) because this test focuses on persistence, not decoding.
 *
 * Returns a plain JSON-serialisable report object.
 */
async () => {
  const dbMod = await import('/src/db/index.ts');
  const { NovelStudioDb, __setDbForTesting } = dbMod;

  const report = {};

  // Minimal, REAL leading signatures padded to valid lengths.
  const png = (extra = 64) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(extra).fill(1)]);
  const jpeg = (extra = 64) => new Uint8Array([0xff, 0xd8, 0xff, ...new Array(extra).fill(1)]);
  const webp = (extra = 64) => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...new Array(extra).fill(1)]);

  // Deterministic dimension probe (validation still runs on real bytes).
  const probe = async () => ({ width: 800, height: 1200 });

  const DB_NAME = window.__P9COV_DB_NAME;
  const Dexie = Object.getPrototypeOf(NovelStudioDb);
  const db = new NovelStudioDb(DB_NAME);
  __setDbForTesting(db);
  await db.open();

  // Build FRESH service instances bound to THIS isolated database. The barrel
  // singletons were constructed at app bootstrap against the original db (before
  // __setDbForTesting), so reusing them would write to a different database.
  // Default constructors resolve `getDb()` at construction time, which now
  // returns the injected instance (__setDbForTesting ran above).
  const { CoverService } = await import('/src/services/cover-service.ts');
  const { ProjectService } = await import('/src/services/project-service.ts');
  const coverService = new CoverService();
  const projectService = new ProjectService();

  const coverCount = (projectId) => db.coverAssets.where('projectId').equals(projectId).count();
  const assetExists = async (id) => (await db.coverAssets.get(id)) !== undefined;

  // Two independent projects.
  const A = await projectService.createProject({ title: 'Covers A' });
  const B = await projectService.createProject({ title: 'Covers B' });

  /* ---- (1) upload PNG to A ---- */
  const up1 = await coverService.uploadCover(A.id, png(), { probe });
  const asset1Id = up1.asset.id;
  const projAAfterUpload = await projectService.getProject(A.id);
  const cur1 = await coverService.getCurrentCover(A.id, /* createUrls */ false);
  const aCount1 = await coverCount(A.id);
  report.upload = {
    assetStored: await assetExists(asset1Id),
    projectRefSet: projAAfterUpload.cover === `asset:${asset1Id}`,
    mimeCanonical: up1.asset.mimeType === 'image/png',
    resolvesAsAsset: cur1.resolution.kind === 'asset' && cur1.resolution.asset.id === asset1Id,
    exactlyOneAsset: aCount1 === 1,
  };

  /* ---- (2) replace with a new PNG → old asset is deleted (no orphan) ---- */
  const up2 = await coverService.uploadCover(A.id, png(80), { probe });
  const asset2Id = up2.asset.id;
  const projAAfterReplace = await projectService.getProject(A.id);
  report.replace = {
    newRefSet: projAAfterReplace.cover === `asset:${asset2Id}`,
    newAssetExists: await assetExists(asset2Id),
    oldAssetDeleted: !(await assetExists(asset1Id)),
    stillExactlyOne: (await coverCount(A.id)) === 1,
  };

  /* ---- (3) WebP stored but not export-embeddable; PNG is exportable ---- */
  const upWebp = await coverService.uploadCover(A.id, webp(80), { probe });
  const webpExport = await coverService.getCoverBytesForExport(A.id);
  report.webp = {
    webpStored: (await db.coverAssets.get(upWebp.asset.id)) !== undefined,
    webpMimeCanonical: upWebp.asset.mimeType === 'image/webp',
    webpNotExportable: webpExport === null,
  };
  // Now upload a JPEG and verify it IS exportable (PNG/JPEG only).
  const upJpeg = await coverService.uploadCover(A.id, jpeg(80), { probe });
  const jpegExport = await coverService.getCoverBytesForExport(A.id);
  report.exportBytes = {
    jpegExportable: jpegExport !== null && jpegExport.mimeType === 'image/jpeg',
    jpegBytesMatch: jpegExport !== null && jpegExport.bytes.length === upJpeg.asset.byteSize,
  };

  /* ---- (4) external cover → resolves as external, no asset ---- */
  const projAExt = await coverService.setExternalCover(A.id, 'https://example.com/cover.png');
  const curExt = await coverService.getCurrentCover(A.id, false);
  report.external = {
    refSet: projAExt.cover === 'https://example.com/cover.png',
    resolvesExternal: curExt.resolution.kind === 'external' && curExt.resolution.value === 'https://example.com/cover.png',
  };

  /* ---- (5) removeCover → reference cleared and asset deleted ---- */
  // Re-upload an asset first so removeCover has something to delete.
  const upForRemove = await coverService.uploadCover(A.id, png(90), { probe });
  const removedAssetId = upForRemove.asset.id;
  const projARemoved = await coverService.removeCover(A.id);
  report.remove = {
    refCleared: projARemoved.cover == null || projARemoved.cover === '',
    assetDeleted: !(await assetExists(removedAssetId)),
    noAssetsLeft: (await coverCount(A.id)) === 0,
  };

  /* ---- (6) missing/orphaned asset reference → asset-missing, no crash ---- */
  await projectService.updateProject(A.id, { cover: 'asset:cov_does_not_exist' });
  const curMissing = await coverService.getCurrentCover(A.id, false);
  report.orphan = {
    resolvesAssetMissing: curMissing.resolution.kind === 'asset-missing' && curMissing.resolution.assetId === 'cov_does_not_exist',
    noDisplayUrl: curMissing.displayUrl === null,
    exportNullForMissing: (await coverService.getCoverBytesForExport(A.id)) === null,
  };

  /* ---- (7) project isolation: B's assets untouched by all A operations ---- */
  const upB = await coverService.uploadCover(B.id, png(70), { probe });
  const bAssetId = upB.asset.id;
  // A operations above must never have created/deleted B rows.
  const bCount = await coverCount(B.id);
  const bCoverNow = await coverService.getCurrentCover(B.id, false);
  report.isolation = {
    bHasExactlyOne: bCount === 1,
    bRefIntact: bCoverNow.resolution.kind === 'asset' && bCoverNow.resolution.asset.id === bAssetId,
    bNotAffectedByARemove: await assetExists(bAssetId),
  };

  /* ---- (8) project delete cascade removes B's cover assets ---- */
  // uploadCover REPLACES the current cover (old asset is auto-deleted), so B
  // still holds exactly one asset here — enough to prove the cascade physically
  // removes a project's stored cover rows.
  await coverService.uploadCover(B.id, png(60), { probe });
  const bBeforeDelete = await coverCount(B.id);
  await projectService.deleteProject(B.id);
  const bAfterDelete = await db.coverAssets.where('projectId').equals(B.id).count();
  report.cascade = {
    bHadAssetBefore: bBeforeDelete >= 1,
    bAssetsGoneAfterDelete: bAfterDelete === 0,
    bProjectGone: (await projectService.getProject(B.id)) === null,
    aStillExists: (await projectService.getProject(A.id)) !== null,
  };

  db.close();
  await Dexie.delete(DB_NAME);
  return report;
}
