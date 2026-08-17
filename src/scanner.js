const { addDiscoveredUrls, getSetting, statements } = require("./db");
const { discoverSite } = require("./discovery");

const POLL_INTERVAL_MS = 5_000;
const scanning = new Set();

async function sendDiscordAlert(site, urls) {
  const webhookUrl = getSetting("discord_webhook_url");
  if (!webhookUrl || urls.length === 0) return;

  const shown = urls.slice(0, 15);
  const extra = urls.length - shown.length;
  const lines = shown.map((url) => `• ${url}`);
  if (extra > 0) lines.push(`• …and ${extra} more`);

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "PagePulse",
      content: `🔎 **${urls.length} new URL${urls.length === 1 ? "" : "s"} on ${site.hostname}**\n${lines.join("\n")}`,
      allowed_mentions: { parse: [] },
    }),
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
  try {
    const urls = await discoverSite(site.url);
    const inserted = addDiscoveredUrls(site.id, urls, !site.baselined);

    if (site.baselined) await sendDiscordAlert(site, inserted);
    else statements.markBaselined.run(site.id);

    statements.markScanSuccess.run(site.id);
  } catch (error) {
    statements.markScanError.run(String(error.message).slice(0, 500), site.id);
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
