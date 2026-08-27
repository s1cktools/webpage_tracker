const { addLog, getSetting } = require("./db");
const { fetchPageTitle } = require("./discovery");
const { buildDiscordPayload, fallbackTitle } = require("./discord");
const { buildWebsitePageEvent } = require("./events");
const { emitTrackerEvent } = require("./event-stream");
const { saveWebsitePagesReport } = require("./reports");

const POLL_INTERVAL_MS = 5_000;

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

async function notifyWebsitePages(
  site,
  inserted,
  sources,
  startedAt,
  knownTitles = new Map()
) {
  if (!site.baselined || !inserted.length) return;
  const detectedAt = new Date();
  const titles = new Map(knownTitles);
  const missing = inserted.filter((url) => !titles.get(url));
  if (missing.length) {
    const fetched = await fetchPageTitles(missing);
    for (const [url, title] of fetched) titles.set(url, title);
  }
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

module.exports = {
  POLL_INTERVAL_MS,
  notifyWebsitePages,
};
