const { getSetting, statements } = require("./db");
const {
  fetchPumpUpdate,
  resolvePumpRuntimeVersion,
} = require("./pump");
const { missingPumpAssetKeys, persistPumpAssets } = require("./pump-assets");
const {
  processPumpObservation,
  retryPendingPumpNotifications,
} = require("./pump-observations");

const PUMP_POLL_INTERVAL_MS = 5_000;
let scanning = false;

function isPumpEnabled() {
  return getSetting("pump_app_enabled") !== "0";
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

    await processPumpObservation({
      updateId: manifest.id,
      etag: result.etag,
      publishedAt: manifest.createdAt || null,
      runtimeVersion: manifest.runtimeVersion || configuredRuntime,
      manifest,
      extensions: result.extensions,
      probeId: "primary",
      observedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - startedAt,
    });
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
  retryPendingPumpNotifications().catch((error) => {
    console.error("[pump-app] pending delivery:", error.message);
  });
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
