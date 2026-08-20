const {
  addDiscoveredSubdomains,
  addLog,
  getSetting,
  statements,
} = require("./db");
const {
  fetchCrtShNames,
  isSubdomainOf,
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
const CRT_REQUEST_GAP_MS = 13_000;

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

function queueCrtRequest(task) {
  const run = crtQueue.catch(() => {}).then(async () => {
    const wait = Math.max(0, nextCrtRequestAt - Date.now());
    if (wait) await delay(wait);
    nextCrtRequestAt = Date.now() + CRT_REQUEST_GAP_MS;
    return task();
  });
  crtQueue = run.catch(() => {});
  return run;
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
        .filter((entry) => !entry.wildcard && isSubdomainOf(entry.hostname, site.hostname))
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
    const entries = await queueCrtRequest(() => fetchCrtShNames(site.hostname));
    const currentSite = statements.getSite.get(site.id);
    if (!currentSite || !currentSite.enabled) return;
    await processCtEntries(currentSite, entries, "crt.sh", {
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
  for (const site of statements.activeSites.all()) {
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
  const sites = getActiveSitesCached();
  const matches = sites
    .map((site) => ({
      site,
      entries: entries.filter(
        (entry) => !entry.wildcard && isSubdomainOf(entry.hostname, site.hostname)
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
