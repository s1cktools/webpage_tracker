const WebSocket = require("ws");
const {
  addDiscoveredSubdomains,
  addLog,
  getSetting,
  statements,
} = require("./db");
const {
  CERTSTREAM_URL,
  fetchCrtShNames,
  isSubdomainOf,
  parseCertstreamMessage,
  resolveDnsStatus,
} = require("./ct");
const { buildSubdomainPayload } = require("./discord");
const { buildWebsiteSubdomainEvent } = require("./events");
const { emitTrackerEvent } = require("./event-stream");
const { saveSubdomainsReport } = require("./reports");

const CT_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
const CRT_REQUEST_GAP_MS = 13_000;
const STALE_STREAM_MS = 2 * 60_000;
const MAX_RECONNECT_MS = 60_000;

let socket;
let reconnectTimer;
let staleTimer;
let reconnectAttempt = 0;
let outageStartedAt = Date.now();
let lastMessageAt = 0;
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
};

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function getCtStatus() {
  return { ...ctStatus };
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
    const report = saveSubdomainsReport(site, inserted);
    for (const entry of inserted) {
      emitTrackerEvent(
        buildWebsiteSubdomainEvent(
          site,
          entry,
          detectedAt,
          report.url,
          inserted.length
        )
      );
    }
    try {
      await sendDiscordAlert(site, inserted, startedAt, report.url);
    } catch (error) {
      addLog(site.id, "error", `CT Discord alert failed: ${error.message}`);
    }
    addLog(
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

function handleStreamMessage(rawMessage) {
  const entries = parseCertstreamMessage(rawMessage);
  if (!entries.length) return;
  lastMessageAt = Date.now();
  ctStatus.lastMessageAt = new Date(lastMessageAt).toISOString();
  const sites = getActiveSitesCached();
  const matches = sites
    .map((site) => ({
      site,
      entries: entries.filter(
        (entry) => !entry.wildcard && isSubdomainOf(entry.hostname, site.hostname)
      ),
    }))
    .filter((group) => group.entries.length);
  if (!matches.length) return;
  processing = processing
    .catch(() => {})
    .then(async () => {
      for (const group of matches) {
        await processCtEntries(group.site, group.entries, "certstream");
      }
    })
    .catch((error) => {
      ctStatus.lastError = error.message;
      console.error("[ct] stream processing:", error.message);
    });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  ctStatus.connected = false;
  const base = Math.min(MAX_RECONNECT_MS, 1_000 * 2 ** reconnectAttempt++);
  const wait = Math.round(base * (0.75 + Math.random() * 0.5));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectCertstream();
  }, wait);
  reconnectTimer.unref();
}

function connectCertstream() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  socket = new WebSocket(CERTSTREAM_URL, {
    handshakeTimeout: 15_000,
    perMessageDeflate: false,
  });
  socket.on("open", () => {
    const outageMs = outageStartedAt ? Date.now() - outageStartedAt : 0;
    outageStartedAt = null;
    reconnectAttempt = 0;
    lastMessageAt = Date.now();
    ctStatus.connected = true;
    ctStatus.lastError = null;
    if (outageMs > STALE_STREAM_MS) runCtSweep();
  });
  socket.on("message", handleStreamMessage);
  socket.on("error", (error) => {
    ctStatus.lastError = error.message;
  });
  socket.on("close", () => {
    if (!outageStartedAt) outageStartedAt = Date.now();
    ctStatus.connected = false;
    scheduleReconnect();
  });
}

function startCtScanner() {
  connectCertstream();
  runCtSweep();
  const sweepTimer = setInterval(runCtSweep, CT_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  staleTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > STALE_STREAM_MS) {
      ctStatus.lastError = "Certificate stream became stale";
      outageStartedAt = lastMessageAt || Date.now() - STALE_STREAM_MS;
      socket.terminate();
    }
  }, 30_000);
  staleTimer.unref();
}

module.exports = {
  CT_SWEEP_INTERVAL_MS,
  getCtStatus,
  processCtEntries,
  scanAllCtSites,
  scanCtSite,
  startCtScanner,
};
