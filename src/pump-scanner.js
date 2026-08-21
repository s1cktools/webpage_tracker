const { getSetting, savePumpUpdate, statements } = require("./db");
const { buildPumpPayload } = require("./discord");
const { emitTrackerEvent } = require("./event-stream");
const { buildPumpAppUpdateEvent } = require("./events");
const {
  bundleSha256,
  diffPumpSignals,
  extractBundleSignals,
  fetchPumpBundle,
  fetchPumpUpdate,
  pumpRuntimeVersion,
  resolvePumpRuntimeVersion,
} = require("./pump");
const { missingPumpAssetKeys, persistPumpAssets } = require("./pump-assets");

const PUMP_POLL_INTERVAL_MS = 5_000;
let scanning = false;

function isPumpEnabled() {
  return getSetting("pump_app_enabled") !== "0";
}

function parseSignals(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
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

async function postDiscordPayload(webhookUrl, payload) {
  let response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    const waitMs = Math.min(Number(body.retry_after) * 1_000 || 1_000, 15_000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  }
  if (!response.ok) {
    throw new Error(`Discord webhook returned ${response.status}`);
  }
}

async function scanPumpApp(force = false) {
  if (scanning || (!force && !isPumpEnabled())) return;
  scanning = true;
  const startedAt = Date.now();
  const previous = statements.getPumpState.get();
  let configuredRuntime = previous.runtime_version || null;

  try {
    configuredRuntime = await resolvePumpRuntimeVersion();
    const sameRuntime = previous.runtime_version === configuredRuntime;
    const result = await fetchPumpUpdate({
      updateId: sameRuntime ? previous.update_id : null,
      etag: sameRuntime ? previous.etag : null,
      runtimeVersion: configuredRuntime,
    });
    if (result.unchanged) {
      const missingKeys = missingPumpAssetKeys();
      if (missingKeys.length) {
        const full = await fetchPumpUpdate({ runtimeVersion: configuredRuntime });
        if (!full.unchanged && full.manifest) {
          await persistAssetsSafely(full.manifest, full.extensions, {
            downloadKeys: missingKeys,
            sourceUpdateId: full.manifest.id,
          });
        }
      }
      statements.markPumpUnchanged.run();
      return;
    }

    const manifest = result.manifest;
    if (previous.baselined && manifest.id === previous.update_id) {
      const missingKeys = missingPumpAssetKeys();
      if (missingKeys.length) {
        await persistAssetsSafely(manifest, result.extensions, {
          downloadKeys: missingKeys,
          sourceUpdateId: manifest.id,
        });
      }
      statements.markPumpUnchanged.run();
      return;
    }

    const bundle = await fetchPumpBundle(manifest, result.extensions);
    const signals = extractBundleSignals(bundle, manifest);
    const changes = previous.baselined
      ? diffPumpSignals(parseSignals(previous.signals_json), signals)
      : [];
    const update = previous.baselined
      ? {
          changes,
          launchHash: manifest.launchAsset.hash,
          previousUpdateId: previous.update_id,
          publishedAt: manifest.createdAt || null,
          runtimeVersion: manifest.runtimeVersion || pumpRuntimeVersion(),
          updateId: manifest.id,
        }
      : null;

    savePumpUpdate(
      {
        bundleHash: bundleSha256(bundle),
        etag: result.etag,
        launchHash: manifest.launchAsset.hash,
        publishedAt: manifest.createdAt || null,
        runtimeVersion: manifest.runtimeVersion || pumpRuntimeVersion(),
        signals,
        updateId: manifest.id,
      },
      update
    );

    const addedAssetKeys = changes
      .filter((change) => change.category === "asset" && change.type === "added")
      .map((change) => change.value);
    await persistAssetsSafely(manifest, result.extensions, {
      bundleBuffer: bundle,
      downloadKeys: [...new Set([...addedAssetKeys, ...missingPumpAssetKeys()])],
      sourceUpdateId: manifest.id,
    });

    if (!update) {
      console.log(`[pump-app] baseline saved: ${manifest.id}`);
      return;
    }

    emitTrackerEvent(buildPumpAppUpdateEvent(update));
    const webhookUrl = getSetting("discord_webhook_url");
    if (webhookUrl) {
      await postDiscordPayload(
        webhookUrl,
        buildPumpPayload(update, Date.now() - startedAt)
      );
    }
    console.log(
      `[pump-app] ${manifest.id}: ${changes.length} extracted signal changes`
    );
  } catch (error) {
    statements.markPumpError.run(
      String(error.message).slice(0, 500),
      configuredRuntime
    );
    console.error("[pump-app]", error.message);
  } finally {
    scanning = false;
  }
}

function startPumpScanner() {
  scanPumpApp();
  const timer = setInterval(scanPumpApp, PUMP_POLL_INTERVAL_MS);
  timer.unref();
}

module.exports = {
  PUMP_POLL_INTERVAL_MS,
  isPumpEnabled,
  scanPumpApp,
  startPumpScanner,
};
