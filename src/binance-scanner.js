const {
  BINANCE_UI_NAMESPACES,
  diffObjects,
  fetchBinanceNamespace,
} = require("./binance");
const { addBinanceChanges, getSetting, statements } = require("./db");
const { buildBinancePayload } = require("./discord");
const { buildBinanceUiEvent } = require("./events");
const { emitTrackerEvent } = require("./event-stream");

const BINANCE_POLL_INTERVAL_MS = 5_000;
const MAX_CONCURRENCY = 6;
const EMBEDS_PER_MESSAGE = 5;
let scanning = false;

for (const namespace of BINANCE_UI_NAMESPACES) {
  statements.ensureBinanceNamespace.run(namespace);
}

function isBinanceEnabled() {
  return getSetting("binance_ui_enabled") !== "0";
}

async function scanNamespace(row) {
  try {
    const result = await fetchBinanceNamespace(row.name, row.etag);
    if (result.unchanged) {
      statements.markBinanceUnchanged.run(row.name);
      return null;
    }

    let changes = [];
    if (row.baselined && row.snapshot_json) {
      try {
        changes = diffObjects(JSON.parse(row.snapshot_json), result.data);
      } catch {
        changes = [];
      }
    }

    statements.saveBinanceSnapshot.run(
      result.etag,
      JSON.stringify(result.data),
      row.name
    );
    if (!row.baselined || changes.length === 0) return null;

    addBinanceChanges(row.name, changes);
    emitTrackerEvent(buildBinanceUiEvent(row.name, changes));
    return { namespace: row.name, changes };
  } catch (error) {
    statements.markBinanceError.run(
      String(error.message).slice(0, 500),
      row.name
    );
    console.error(`[binance-ui] ${row.name}:`, error.message);
    return null;
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

async function sendBinanceAlerts(events, scanDurationMs) {
  const webhookUrl = getSetting("discord_webhook_url");
  if (!webhookUrl || events.length === 0) return;

  for (let index = 0; index < events.length; index += EMBEDS_PER_MESSAGE) {
    const batch = events.slice(index, index + EMBEDS_PER_MESSAGE);
    await postDiscordPayload(
      webhookUrl,
      buildBinancePayload(batch, scanDurationMs)
    );
  }
}

async function scanBinanceUi(force = false) {
  if (scanning || (!force && !isBinanceEnabled())) return;
  scanning = true;
  const startedAt = Date.now();
  const rows = statements.listBinanceNamespaces.all();
  const events = [];
  let nextIndex = 0;

  try {
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENCY, rows.length) },
      async () => {
        while (nextIndex < rows.length) {
          const row = rows[nextIndex++];
          const event = await scanNamespace(row);
          if (event) events.push(event);
        }
      }
    );
    await Promise.all(workers);
    await sendBinanceAlerts(events, Date.now() - startedAt);
  } catch (error) {
    console.error("[binance-ui]", error.message);
  } finally {
    scanning = false;
  }
}

function startBinanceScanner() {
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
