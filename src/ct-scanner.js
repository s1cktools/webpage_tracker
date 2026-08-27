const {
  addDiscoveredSubdomains,
  addLog,
  getSetting,
  statements,
} = require("./db");
const {
  canonicalSiteHostname,
  fetchHistoricalCtNames,
  getCrtNameQuota,
  isConcreteSubdomainOf,
  normalizeCtName,
  resolveDnsStatus,
} = require("./ct");
const {
  getCertspotterManagerStatus,
  refreshCertspotterWatchlist: refreshManagedWatchlist,
  startCertspotterManager,
  stopCertspotterManager,
} = require("./certspotter-manager");
const { buildSubdomainPayload } = require("./discord");
const { buildWebsiteSubdomainEvent } = require("./events");
const { emitTrackerEvent } = require("./event-stream");
const { saveSubdomainsReport } = require("./reports");

const CT_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
const CRT_NAME_RECHECK_MS = 24 * 60 * 60_000;
const CRT_NAME_REQUEST_GAP_MS = 250;

let processing = Promise.resolve();
let crtQueue = Promise.resolve();
let nextCrtRequestAt = 0;
let activeSitesCache = [];
let activeSitesCachedAt = 0;
const ctScanning = new Set();
const dnsQueue = [];
let activeDnsChecks = 0;
const ctStatus = {
  connected: false,
  lastMessageAt: null,
  lastError: null,
  source: "certspotter",
};

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function getCtStatus() {
  return { ...ctStatus, monitor: getCertspotterManagerStatus() };
}

function parsedTimestamp(value) {
  if (!value) return NaN;
  const iso = String(value).includes("T") ? String(value) : String(value).replace(" ", "T");
  return Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
}

function queueCrtRequest(task, gapMs = CRT_NAME_REQUEST_GAP_MS) {
  const run = crtQueue.catch(() => {}).then(async () => {
    const wait = Math.max(0, nextCrtRequestAt - Date.now());
    if (wait) await delay(wait);
    nextCrtRequestAt = Date.now() + gapMs;
    return task();
  });
  crtQueue = run.catch(() => {});
  return run;
}

function shouldRecheckCtHistory(site) {
  if (!site.ct_history_baselined) return true;
  const checkedAt = parsedTimestamp(site.ct_last_checked_at);
  if (!Number.isFinite(checkedAt)) return true;
  return Date.now() - checkedAt >= CRT_NAME_RECHECK_MS;
}

function collapseWwwAliasSites(sites) {
  const chosen = new Map();
  for (const site of sites) {
    const root = canonicalSiteHostname(site.hostname);
    if (!root) continue;
    const existing = chosen.get(root);
    if (!existing) {
      chosen.set(root, site);
      continue;
    }
    const existingWww = String(existing.hostname).toLowerCase().startsWith("www.");
    const siteWww = String(site.hostname).toLowerCase().startsWith("www.");
    if (existingWww && !siteWww) chosen.set(root, site);
    else if (existingWww === siteWww && Number(site.id) < Number(existing.id)) {
      chosen.set(root, site);
    }
  }
  return [...chosen.values()];
}

function pumpDnsQueue() {
  while (activeDnsChecks < 6 && dnsQueue.length) {
    const job = dnsQueue.shift();
    activeDnsChecks++;
    resolveDnsStatus(job.hostname)
      .then((status) => {
        statements.updateSubdomainDns.run(status, job.siteId, job.hostname);
      })
      .catch(() => {})
      .finally(() => {
        activeDnsChecks--;
        pumpDnsQueue();
      });
  }
}

function queueDnsChecks(siteId, entries) {
  for (const entry of entries) {
    dnsQueue.push({ siteId, hostname: entry.hostname });
  }
  pumpDnsQueue();
}

function getActiveSitesCached() {
  if (Date.now() - activeSitesCachedAt > 10_000) {
    activeSitesCache = statements.activeSites.all();
    activeSitesCachedAt = Date.now();
  }
  return activeSitesCache;
}

function refreshCertspotterWatchlist() {
  activeSitesCachedAt = 0;
  activeSitesCache = [];
  return refreshManagedWatchlist();
}

function safeAddLog(siteId, level, message) {
  try {
    addLog(siteId, level, message);
  } catch (error) {
    console.error(`[ct] could not save ${level} log:`, error.message);
  }
}

async function sendDiscordAlert(site, entries, startedAt, reportUrl) {
  const webhookUrl = getSetting("discord_webhook_url");
  if (!webhookUrl || !entries.length) return;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      buildSubdomainPayload(site, entries, Date.now() - startedAt, new Date(), reportUrl)
    ),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Discord webhook returned ${response.status}`);
}

async function processCtEntries(siteOrId, entries, source, options = {}) {
  const site =
    typeof siteOrId === "object" ? statements.getSite.get(siteOrId.id) : statements.getSite.get(siteOrId);
  if (!site || !site.enabled) return [];
  const relevant = [
    ...new Map(
      entries
        .filter(
          (entry) =>
            !entry.wildcard && isConcreteSubdomainOf(entry.hostname, site.hostname)
        )
        .map((entry) => [entry.hostname, entry])
    ).values(),
  ];
  if (!relevant.length) return [];

  const startedAt = Date.now();
  const inserted = addDiscoveredSubdomains(
    site.id,
    relevant,
    source,
    options.forceBaseline || !site.ct_baselined
  );
  if (!inserted.length) return [];

  if (site.ct_baselined && !options.forceBaseline) {
    const detectedAt = new Date();
    let reportUrl = null;
    try {
      reportUrl = saveSubdomainsReport(site, inserted).url;
    } catch (error) {
      safeAddLog(site.id, "error", `CT report failed: ${error.message}`);
    }
    try {
      for (const entry of inserted) {
        emitTrackerEvent(
          buildWebsiteSubdomainEvent(
            site,
            entry,
            detectedAt,
            reportUrl,
            inserted.length
          )
        );
      }
    } catch (error) {
      safeAddLog(site.id, "error", `CT event stream failed: ${error.message}`);
    }
    try {
      await sendDiscordAlert(site, inserted, startedAt, reportUrl);
    } catch (error) {
      safeAddLog(site.id, "error", `CT Discord alert failed: ${error.message}`);
    }
    safeAddLog(
      site.id,
      "new",
      `${inserted.length} new certificate subdomain${inserted.length === 1 ? "" : "s"}`
    );
  }

  if (site.ct_baselined && !options.forceBaseline) {
    queueDnsChecks(site.id, inserted);
  }
  return inserted;
}

async function scanCtSite(siteOrId) {
  const site =
    typeof siteOrId === "object" ? statements.getSite.get(siteOrId.id) : statements.getSite.get(siteOrId);
  if (!site || !site.enabled || ctScanning.has(site.id)) return;
  ctScanning.add(site.id);
  const historyPending = !site.ct_history_baselined;
  try {
    const { entries, source } = await queueCrtRequest(() =>
      fetchHistoricalCtNames(site.hostname, { allowFallback: historyPending })
    );
    const currentSite = statements.getSite.get(site.id);
    if (!currentSite || !currentSite.enabled) return;
    await processCtEntries(currentSite, entries, source, {
      forceBaseline: historyPending,
    });
    const completedSite = statements.getSite.get(site.id);
    if (!completedSite) return;
    if (historyPending) {
      statements.markCtBaselined.run(site.id);
      addLog(site.id, "info", `certificate baseline complete · ${entries.length} subdomains`);
    } else {
      statements.markCtSuccess.run(site.id);
    }
  } catch (error) {
    const message = String(error.message).slice(0, 500);
    const currentSite = statements.getSite.get(site.id);
    if (!currentSite) return;
    try {
      if (!currentSite.ct_baselined) {
        statements.markCtLiveAfterBaselineError.run(message, site.id);
        addLog(site.id, "warn", "historical certificate baseline delayed; live monitoring active");
      } else {
        statements.markCtError.run(message, site.id);
      }
      addLog(site.id, "warn", `certificate check failed: ${error.message}`);
    } catch (stateError) {
      console.error(`[ct] ${site.hostname} state update:`, stateError.message);
    }
    console.error(`[ct] ${site.hostname}:`, error.message);
  } finally {
    ctScanning.delete(site.id);
  }
}

async function scanAllCtSites() {
  const sites = statements.activeSites.all().sort(
    (left, right) => Number(left.ct_history_baselined) - Number(right.ct_history_baselined)
  );
  for (const site of sites) {
    if (!shouldRecheckCtHistory(site)) continue;
    const quota = getCrtNameQuota();
    if (site.ct_history_baselined && quota.remaining === 0) continue;
    await scanCtSite(site);
  }
}

function runCtSweep() {
  void scanAllCtSites().catch((error) => {
    ctStatus.lastError = error.message;
    console.error("[ct] sweep:", error.message);
  });
}

function processLiveNames(names) {
  const entries = names.map(normalizeCtName).filter(Boolean);
  ctStatus.lastMessageAt = new Date().toISOString();
  if (!entries.length) return Promise.resolve();
  const sites = collapseWwwAliasSites(getActiveSitesCached());
  const matches = sites
    .map((site) => ({
      site,
      entries: entries.filter(
        (entry) =>
          !entry.wildcard && isConcreteSubdomainOf(entry.hostname, site.hostname)
      ),
    }))
    .filter((group) => group.entries.length);
  if (!matches.length) return Promise.resolve();
  const run = processing
    .catch(() => {})
    .then(async () => {
      for (const group of matches) {
        await processCtEntries(group.site, group.entries, "certspotter");
      }
    });
  processing = run.catch((error) => {
      ctStatus.lastError = error.message;
      console.error("[ct] stream processing:", error.message);
    });
  return run;
}

async function handleCertspotterEvent(event) {
  if (event.event === "discovered_cert") {
    await processLiveNames(event.dns_names);
    return;
  }
  const message = event.detail || event.summary || "Cert Spotter monitoring error";
  ctStatus.lastError = String(message).slice(0, 1000);
  console.error(`[ct] ${ctStatus.lastError}`);
  runCtSweep();
}

function startCtScanner() {
  runCtSweep();
  const sweepTimer = setInterval(runCtSweep, CT_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  void startCertspotterManager({
    onEvent: handleCertspotterEvent,
    onState(state) {
      ctStatus.connected = state.running;
      if (state.lastError) ctStatus.lastError = state.lastError;
      else if (state.running) ctStatus.lastError = null;
    },
  }).catch((error) => {
    ctStatus.connected = false;
    ctStatus.lastError = error.message;
    console.error("[ct] monitor startup:", error.message);
  });
}

module.exports = {
  CT_SWEEP_INTERVAL_MS,
  collapseWwwAliasSites,
  getCtStatus,
  handleCertspotterEvent,
  processCtEntries,
  processLiveNames,
  refreshCertspotterWatchlist,
  scanAllCtSites,
  scanCtSite,
  startCtScanner,
  stopCertspotterManager,
};
