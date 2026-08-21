const {
  BINANCE_UI_NAMESPACES,
  fetchBinanceNamespace,
} = require("./binance");
const { getSetting, statements } = require("./db");
const {
  processBinanceObservation,
  retryPendingBinanceNotifications,
} = require("./binance-observations");

const BINANCE_POLL_INTERVAL_MS = 5_000;
const MAX_CONCURRENCY = 6;
let scanning = false;

for (const namespace of BINANCE_UI_NAMESPACES) {
  statements.ensureBinanceNamespace.run(namespace);
}

function isBinanceEnabled() {
  return getSetting("binance_ui_enabled") !== "0";
}

async function scanNamespace(row) {
  const startedAt = Date.now();
  try {
    const result = await fetchBinanceNamespace(row.name, row.etag);
    if (result.unchanged) {
      statements.markBinanceUnchanged.run(
        result.versionId,
        result.lastModified,
        row.name
      );
      return null;
    }

    return await processBinanceObservation(
      {
        namespace: row.name,
        etag: result.etag,
        versionId: result.versionId,
        lastModified: result.lastModified,
        snapshot: result.data,
        probeId: "primary",
        observedAt: new Date().toISOString(),
        scanDurationMs: Date.now() - startedAt,
      },
      { trustedLocal: true }
    );
  } catch (error) {
    statements.markBinanceError.run(
      String(error.message).slice(0, 500),
      row.name
    );
    console.error(`[binance-ui] ${row.name}:`, error.message);
    return null;
  }
}

async function scanBinanceUi(force = false) {
  if (scanning || (!force && !isBinanceEnabled())) return;
  scanning = true;
  const rows = statements.listBinanceNamespaces.all();
  let nextIndex = 0;

  try {
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENCY, rows.length) },
      async () => {
        while (nextIndex < rows.length) {
          const row = rows[nextIndex++];
          await scanNamespace(row);
        }
      }
    );
    await Promise.all(workers);
  } catch (error) {
    console.error("[binance-ui]", error.message);
  } finally {
    scanning = false;
  }
}

function startBinanceScanner() {
  retryPendingBinanceNotifications().catch((error) => {
    console.error("[binance-ui] pending delivery:", error.message);
  });
  scanBinanceUi();
  const timer = setInterval(scanBinanceUi, BINANCE_POLL_INTERVAL_MS);
  timer.unref();
}

module.exports = {
  BINANCE_POLL_INTERVAL_MS,
  isBinanceEnabled,
  scanBinanceUi,
  startBinanceScanner,
};
