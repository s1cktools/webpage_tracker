const { addDiscoveredUrls, addLog, getSetting, statements } = require("./db");
const { discoverSite } = require("./discovery");
const { buildDiscordPayload } = require("./discord");

const POLL_INTERVAL_MS = 5_000;
const LOG_INTERVAL_MS = 5 * 60_000;
const scanning = new Set();
const lastLogAt = new Map();

function logOccasionally(siteId, type, level, message) {
  const key = `${siteId}:${type}`;
  const now = Date.now();
  if (now - (lastLogAt.get(key) || 0) < LOG_INTERVAL_MS) return;
  lastLogAt.set(key, now);
  addLog(siteId, level, message);
}

async function sendDiscordAlert(site, urls) {
  const webhookUrl = getSetting("discord_webhook_url");
  if (!webhookUrl || urls.length === 0) return;

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildDiscordPayload(site, urls)),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook returned ${response.status}`);
  }
}

async function scanSite(siteOrId) {
  const site =
    typeof siteOrId === "object" ? siteOrId : statements.getSite.get(siteOrId);
  if (!site || scanning.has(site.id)) return;

  scanning.add(site.id);
  const startedAt = Date.now();
  try {
    const warnings = [];
    const urls = await discoverSite(site.url, (level, message) => {
      if (level === "warn") warnings.push(message);
      else addLog(site.id, level, message);
    });
    const inserted = addDiscoveredUrls(site.id, urls, !site.baselined);

    if (warnings.length) {
      const suffix = warnings.length > 1 ? ` · ${warnings.length} failures` : "";
      logOccasionally(site.id, "warning", "warn", `${warnings[0]}${suffix}`);
    }

    if (site.baselined) {
      await sendDiscordAlert(site, inserted);
      if (inserted.length) {
        addLog(site.id, "new", `${inserted.length} new URL${inserted.length === 1 ? "" : "s"}`);
      }
    } else {
      statements.markBaselined.run(site.id);
      addLog(site.id, "info", `baseline complete · ${urls.length} URLs`);
    }

    statements.markScanSuccess.run(site.id);
    logOccasionally(
      site.id,
      "heartbeat",
      "info",
      `scan complete · ${urls.length} URLs · ${Date.now() - startedAt}ms`
    );
  } catch (error) {
    statements.markScanError.run(String(error.message).slice(0, 500), site.id);
    logOccasionally(site.id, "error", "error", error.message);
    console.error(`[scanner] ${site.hostname}:`, error.message);
  } finally {
    scanning.delete(site.id);
  }
}

async function scanAll() {
  await Promise.allSettled(statements.activeSites.all().map(scanSite));
}

function startScanner() {
  scanAll();
  const timer = setInterval(scanAll, POLL_INTERVAL_MS);
  timer.unref();
}

module.exports = { POLL_INTERVAL_MS, scanAll, scanSite, startScanner };
