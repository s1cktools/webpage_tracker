const {
  addDiscoveredUrls,
  addLog,
  getSetting,
  pruneDiscoveredUrls,
  statements,
} = require("./db");
const {
  discoverSite,
  excludeTranslatedUrls,
  fetchPageTitle,
  isTranslatedUrl,
} = require("./discovery");
const { buildDiscordPayload, fallbackTitle } = require("./discord");
const { buildWebsitePageEvent } = require("./events");
const { emitTrackerEvent } = require("./event-stream");
const { saveWebsitePagesReport } = require("./reports");

const POLL_INTERVAL_MS = 5_000;
const LOG_INTERVAL_MS = 5 * 60_000;
const scanning = new Set();
const lastLogAt = new Map();
const localePrunedSites = new Set();

function logOccasionally(siteId, type, level, message) {
  const key = `${siteId}:${type}`;
  const now = Date.now();
  if (now - (lastLogAt.get(key) || 0) < LOG_INTERVAL_MS) return;
  lastLogAt.set(key, now);
  addLog(siteId, level, message);
}

async function fetchPageTitles(urls) {
  const titleUrls = urls.slice(0, 10);
  const titleResults = await Promise.allSettled(titleUrls.map(fetchPageTitle));
  const titles = new Map();
  titleResults.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value) {
      titles.set(titleUrls[index], result.value);
    }
  });
  return titles;
}

async function sendDiscordAlert(site, urls, sources, titles, scanDurationMs, reportUrl) {
  const webhookUrl = getSetting("discord_webhook_url");
  if (!webhookUrl || urls.length === 0) return;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      buildDiscordPayload(
        site,
        urls,
        new Date(),
        titles,
        sources,
        scanDurationMs,
        reportUrl
      )
    ),
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
    const issues = [];
    const sources = new Map();
    let baselineBlocked = false;
    const discoveredUrls = await discoverSite(
      site.url,
      (level, message) => {
        if (level === "warn" || level === "error") {
          issues.push(message);
          if (level === "error") baselineBlocked = true;
        } else {
          addLog(site.id, level, message);
        }
      },
      (url, source) => {
        if (!sources.has(url)) sources.set(url, source);
      }
    );
    const urls = site.ignore_locales
      ? excludeTranslatedUrls(discoveredUrls)
      : discoveredUrls;

    if (site.ignore_locales && !localePrunedSites.has(site.id)) {
      const removed = pruneDiscoveredUrls(site.id, isTranslatedUrl);
      localePrunedSites.add(site.id);
      if (removed) addLog(site.id, "info", `removed ${removed} translated URLs`);
    }

    const inserted = addDiscoveredUrls(site.id, urls, !site.baselined);

    if (issues.length) {
      const suffix = issues.length > 1 ? ` · ${issues.length} failures` : "";
      logOccasionally(
        site.id,
        "warning",
        baselineBlocked ? "error" : "warn",
        `${issues[0]}${suffix}`
      );
    }

    if (site.baselined) {
      if (inserted.length) {
        const detectedAt = new Date();
        const titles = await fetchPageTitles(inserted);
        const report = saveWebsitePagesReport(site, inserted, titles, sources);
        for (const url of inserted) {
          emitTrackerEvent(
            buildWebsitePageEvent(
              site,
              url,
              titles.get(url) || fallbackTitle(url),
              sources.get(url),
              detectedAt,
              report.url,
              inserted.length
            )
          );
        }
        await sendDiscordAlert(
          site,
          inserted,
          sources,
          titles,
          Date.now() - startedAt,
          report.url
        );
        addLog(site.id, "new", `${inserted.length} new URL${inserted.length === 1 ? "" : "s"}`);
      }
    } else {
      if (baselineBlocked) {
        statements.markScanError.run("Baseline incomplete; retrying without alerts.", site.id);
        return;
      }
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
