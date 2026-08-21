const fs = require("node:fs");
const path = require("node:path");
const { dataDirectory, statements } = require("./db");
const {
  collectAssetKeys,
  fetchPumpAsset,
  isImageAsset,
  mergePumpAssetMeta,
  safeAssetKey,
} = require("./pump");

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 4;
const pumpAssetDirectory = path.join(dataDirectory, "pump-assets");
fs.mkdirSync(pumpAssetDirectory, { recursive: true });

function assetMetaFromRow(row) {
  if (!row) return null;
  return {
    key: row.asset_key,
    name: row.name || null,
    fileExtension: row.file_extension || "",
    contentType: row.content_type || "",
    hasFile: Boolean(row.has_file),
    filename: row.filename || null,
  };
}

function getPumpAssetsByKeys(keys = []) {
  const assetsByKey = {};
  for (const key of keys) {
    const row = statements.getPumpAsset.get(key);
    if (row) assetsByKey[key] = assetMetaFromRow(row);
  }
  return assetsByKey;
}

function getPumpAssetFile(key) {
  const safeKey = safeAssetKey(key);
  if (!safeKey) return null;
  const row = statements.getPumpAsset.get(safeKey);
  if (!row?.has_file || !row.filename) return null;
  const absolutePath = path.join(pumpAssetDirectory, row.filename);
  if (!absolutePath.startsWith(pumpAssetDirectory)) return null;
  if (!fs.existsSync(absolutePath)) return null;
  return {
    absolutePath,
    contentType: row.content_type || "application/octet-stream",
  };
}

function listedAssetKeysFromUpdates(limit = 20) {
  const keys = [];
  for (const update of statements.recentPumpUpdates.all(limit)) {
    let changes = [];
    try {
      changes = JSON.parse(update.changes_json || "[]");
    } catch {
      continue;
    }
    keys.push(...collectAssetKeys(changes));
  }
  return [...new Set(keys)];
}

function missingPumpAssetKeys() {
  return listedAssetKeysFromUpdates().filter((key) => {
    const safeKey = safeAssetKey(key);
    if (!safeKey) return false;
    const row = statements.getPumpAsset.get(safeKey);
    return !row?.has_file;
  });
}

async function mapPool(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function saveAssetRecord(asset, extras = {}) {
  const safeKey = safeAssetKey(asset.key) || asset.key;
  statements.upsertPumpAsset.run(
    safeKey,
    extras.name ?? asset.name ?? null,
    extras.fileExtension ?? asset.fileExtension ?? null,
    extras.contentType ?? asset.contentType ?? null,
    extras.hasFile ? 1 : 0,
    extras.filename ?? null,
    extras.sourceUpdateId ?? null
  );
}

async function persistPumpAssets(
  manifest,
  extensions = {},
  { bundleBuffer = null, downloadKeys = [], sourceUpdateId = null } = {}
) {
  const assets = mergePumpAssetMeta(manifest, bundleBuffer);
  const downloadSet = new Set(
    downloadKeys.map((key) => safeAssetKey(key) || key).filter(Boolean)
  );
  const toDownload = [];

  for (const asset of assets) {
    const safeKey = safeAssetKey(asset.key);
    const existing = safeKey ? statements.getPumpAsset.get(safeKey) : null;
    saveAssetRecord(asset, {
      name: asset.name,
      fileExtension: asset.fileExtension,
      contentType: asset.contentType,
      hasFile: Boolean(existing?.has_file),
      filename: existing?.filename || null,
      sourceUpdateId,
    });

    if (
      safeKey &&
      downloadSet.has(safeKey) &&
      isImageAsset(asset) &&
      !existing?.has_file &&
      asset.url
    ) {
      toDownload.push({ ...asset, key: safeKey });
    }
  }

  if (!toDownload.length) return { stored: 0, failed: 0 };

  let stored = 0;
  let failed = 0;
  await mapPool(toDownload, DOWNLOAD_CONCURRENCY, async (asset) => {
    try {
      const downloaded = await fetchPumpAsset(asset, extensions);
      if (downloaded.buffer.length > MAX_ASSET_BYTES) {
        failed += 1;
        return;
      }
      const fileExtension =
        asset.fileExtension ||
        (downloaded.contentType.includes("webp")
          ? ".webp"
          : downloaded.contentType.includes("png")
            ? ".png"
            : downloaded.contentType.includes("jpeg")
              ? ".jpg"
              : downloaded.contentType.includes("gif")
                ? ".gif"
                : "");
      const filename = `${asset.key}${fileExtension}`;
      fs.writeFileSync(path.join(pumpAssetDirectory, filename), downloaded.buffer);
      saveAssetRecord(asset, {
        name: asset.name,
        fileExtension,
        contentType: downloaded.contentType || asset.contentType,
        hasFile: true,
        filename,
        sourceUpdateId,
      });
      stored += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[pump-app] asset ${asset.key}: ${error.message}`);
    }
  });

  return { stored, failed };
}

module.exports = {
  MAX_ASSET_BYTES,
  getPumpAssetFile,
  getPumpAssetsByKeys,
  missingPumpAssetKeys,
  persistPumpAssets,
  pumpAssetDirectory,
};
