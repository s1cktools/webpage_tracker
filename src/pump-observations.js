const {
  applyPumpObservation,
  claimPumpNotification,
  getSetting,
  inspectPumpObservation,
  listPendingPumpNotifications,
  markPumpNotificationDelivered,
  markPumpNotificationFailed,
} = require("./db");
const { buildPumpPayload } = require("./discord");
const { postDiscordPayload } = require("./binance-alerts");
const { emitTrackerEvent } = require("./event-stream");
const { buildPumpAppUpdateEvent } = require("./events");
const {
  bundleSha256,
  fetchPumpBundle,
  extractBundleSignals,
  pumpRuntimeVersion,
} = require("./pump");
const { missingPumpAssetKeys, persistPumpAssets } = require("./pump-assets");

const processingUpdates = new Map();

function validIsoDate(value, field) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) throw new Error(`Invalid ${field}`);
  return new Date(time).toISOString();
}

function normalizePumpObservation(payload) {
  const manifest = payload?.manifest;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !manifest.id ||
    !manifest.launchAsset?.hash ||
    !manifest.launchAsset?.url
  ) {
    throw new Error("Invalid Pump manifest");
  }
  const updateId = String(payload.updateId || manifest.id);
  if (updateId !== String(manifest.id)) {
    throw new Error("Pump updateId does not match manifest");
  }
  const probeId = String(payload.probeId || "").trim().slice(0, 100);
  if (!probeId) throw new Error("Missing probeId");

  return {
    updateId,
    etag: payload.etag ? String(payload.etag).slice(0, 500) : null,
    runtimeVersion: String(
      payload.runtimeVersion ||
        manifest.runtimeVersion ||
        pumpRuntimeVersion()
    ).slice(0, 100),
    publishedAt: validIsoDate(
      payload.publishedAt || manifest.createdAt,
      "publishedAt"
    ),
    manifest,
    extensions:
      payload.extensions &&
      typeof payload.extensions === "object" &&
      !Array.isArray(payload.extensions)
        ? payload.extensions
        : {},
    probeId,
    observedAt: validIsoDate(payload.observedAt || new Date(), "observedAt"),
    scanDurationMs: Math.max(
      0,
      Math.min(Number(payload.scanDurationMs) || 0, 60_000)
    ),
  };
}

async function persistAssetsSafely(manifest, extensions, options) {
  try {
    const result = await persistPumpAssets(manifest, extensions, options);
    if (result.stored) {
      console.log(`[pump-app] stored ${result.stored} asset files`);
    }
  } catch (error) {
    console.warn(`[pump-app] asset persist failed: ${error.message}`);
  }
}

async function deliverPumpNotification(updateId, context = {}) {
  const update = claimPumpNotification(updateId);
  if (!update) return false;
  try {
    emitTrackerEvent(
      buildPumpAppUpdateEvent(update, context.observedAt || new Date())
    );
    const webhookUrl = getSetting("discord_webhook_url");
    if (webhookUrl) {
      await postDiscordPayload(
        webhookUrl,
        buildPumpPayload(update, context.scanDurationMs || 0)
      );
    }
    markPumpNotificationDelivered(updateId);
    console.log(
      `[pump-app] ${updateId}: ${update.changes.length} changes via ${context.probeId || "recovery"}`
    );
  } catch (error) {
    markPumpNotificationFailed(updateId, error);
    throw error;
  }
  return true;
}

async function processNewPumpObservation(observation) {
  const bundle = await fetchPumpBundle(
    observation.manifest,
    observation.extensions
  );
  const signals = extractBundleSignals(bundle, observation.manifest);
  const result = applyPumpObservation({
    ...observation,
    bundleHash: bundleSha256(bundle),
    launchHash: observation.manifest.launchAsset.hash,
    signals,
  });

  if (result.status === "accepted" || result.status === "baselined") {
    const addedAssetKeys = (result.update?.changes || [])
      .filter((change) => change.category === "asset" && change.type === "added")
      .map((change) => change.value);
    await persistAssetsSafely(observation.manifest, observation.extensions, {
      bundleBuffer: bundle,
      downloadKeys: [
        ...new Set([...addedAssetKeys, ...missingPumpAssetKeys()]),
      ],
      sourceUpdateId: observation.updateId,
    });
  }

  const notified = await deliverPumpNotification(observation.updateId, observation);
  if (result.status === "baselined") {
    console.log(`[pump-app] baseline saved: ${observation.updateId}`);
  }
  return notified ? { ...result, notified: true } : result;
}

async function processPumpObservation(payload) {
  const observation = normalizePumpObservation(payload);
  const initialStatus = inspectPumpObservation(
    observation.updateId,
    observation.publishedAt
  );
  if (initialStatus !== "new") {
    const notified = await deliverPumpNotification(
      observation.updateId,
      observation
    );
    return { status: initialStatus, notified };
  }

  if (processingUpdates.has(observation.updateId)) {
    return processingUpdates.get(observation.updateId);
  }
  const processing = processNewPumpObservation(observation).finally(() => {
    processingUpdates.delete(observation.updateId);
  });
  processingUpdates.set(observation.updateId, processing);
  return processing;
}

async function retryPendingPumpNotifications() {
  for (const pending of listPendingPumpNotifications()) {
    try {
      await deliverPumpNotification(pending.update_id, {
        observedAt: pending.observed_at,
        probeId: pending.first_probe_id,
      });
    } catch (error) {
      console.error(`[pump-app] pending ${pending.update_id}:`, error.message);
    }
  }
}

module.exports = {
  deliverPumpNotification,
  normalizePumpObservation,
  processPumpObservation,
  retryPendingPumpNotifications,
};
