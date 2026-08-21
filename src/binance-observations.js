const crypto = require("node:crypto");
const { BINANCE_UI_NAMESPACES } = require("./binance");
const { sendBinanceAlerts } = require("./binance-alerts");
const {
  applyBinanceObservation,
  claimBinanceNotification,
  listPendingBinanceNotifications,
  markBinanceNotificationDelivered,
  markBinanceNotificationFailed,
} = require("./db");
const { emitTrackerEvent } = require("./event-stream");
const { buildBinanceUiEvent } = require("./events");
const { reportUrl } = require("./reports");

const namespaceSet = new Set(BINANCE_UI_NAMESPACES);

function isAuthorizedProbe(authorization, secret = process.env.BINANCE_PROBE_SECRET) {
  const expected = String(secret || "");
  const value = String(authorization || "");
  const prefix = "Bearer ";
  const provided = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  return (
    expected.length > 0 &&
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  );
}

function validIsoDate(value, field) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) throw new Error(`Invalid ${field}`);
  return new Date(time).toISOString();
}

function normalizeBinanceObservation(payload, { trustedLocal = false } = {}) {
  const namespace = String(payload?.namespace || "");
  if (!namespaceSet.has(namespace)) throw new Error("Unknown Binance namespace");
  if (
    !payload.snapshot ||
    typeof payload.snapshot !== "object" ||
    Array.isArray(payload.snapshot)
  ) {
    throw new Error("Invalid Binance snapshot");
  }

  const etag = payload.etag ? String(payload.etag).slice(0, 500) : null;
  const versionId = payload.versionId
    ? String(payload.versionId).slice(0, 500)
    : null;
  if (!etag && !versionId) throw new Error("Missing Binance version identifier");

  const probeId = String(payload.probeId || "").trim().slice(0, 100);
  if (!probeId) throw new Error("Missing probeId");

  return {
    namespace,
    etag,
    versionId,
    lastModified: validIsoDate(payload.lastModified, "lastModified"),
    snapshot: payload.snapshot,
    probeId,
    observedAt: validIsoDate(payload.observedAt || new Date(), "observedAt"),
    scanDurationMs: Math.max(
      0,
      Math.min(Number(payload.scanDurationMs) || 0, 60_000)
    ),
    trustedLocal,
  };
}

async function processBinanceObservation(payload, options) {
  const observation = normalizeBinanceObservation(payload, options);
  const result = applyBinanceObservation(observation);
  if (result.status === "deferred") return result;

  const notified = await deliverBinanceNotification(
    observation.namespace,
    result.versionKey,
    observation
  );
  return notified ? { ...result, notified: true } : result;
}

async function deliverBinanceNotification(namespace, versionKey, context = {}) {
  const pending = claimBinanceNotification(
    namespace,
    versionKey
  );
  if (!pending) return false;

  const event = {
    namespace: pending.namespace,
    changes: pending.changes,
    reportUrl: reportUrl(pending.reportId),
  };
  try {
    emitTrackerEvent(
      buildBinanceUiEvent(
        pending.namespace,
        pending.changes,
        context.observedAt || new Date(),
        event.reportUrl
      )
    );
    await sendBinanceAlerts([event], context.scanDurationMs || 0);
    markBinanceNotificationDelivered(pending.namespace, pending.versionKey);
    console.log(
      `[binance-ui] ${pending.namespace}: ${pending.changes.length} changes via ${context.probeId || "recovery"}`
    );
  } catch (error) {
    markBinanceNotificationFailed(
      pending.namespace,
      pending.versionKey,
      error
    );
    throw error;
  }
  return true;
}

async function retryPendingBinanceNotifications() {
  for (const pending of listPendingBinanceNotifications()) {
    try {
      await deliverBinanceNotification(pending.namespace, pending.version_key, {
        observedAt: pending.observed_at,
        probeId: pending.first_probe_id,
      });
    } catch (error) {
      console.error(
        `[binance-ui] pending ${pending.namespace}:`,
        error.message
      );
    }
  }
}

module.exports = {
  deliverBinanceNotification,
  isAuthorizedProbe,
  normalizeBinanceObservation,
  processBinanceObservation,
  retryPendingBinanceNotifications,
};
