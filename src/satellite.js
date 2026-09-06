const http = require("node:http");
const os = require("node:os");
const { fetchBinanceNamespace } = require("./binance");
const { fetchBinanceSquareWindow } = require("./binance-square");
const { fetchCrtShNames } = require("./ct");
const { discoverSite, excludeTranslatedUrls } = require("./discovery");
const { fetchGitHubTarget } = require("./github");
const {
  fetchPumpUpdate,
  resolvePumpRuntimeVersion,
} = require("./pump");
const { discoverRobinhood } = require("./robinhood");
const { collectPlaybook, getPlaybook } = require("./websites");
const { getLatestVideos } = require("./youtube");

const WATCHLIST_INTERVAL_MS = 30_000;
const DEFAULT_POLL_MS = 5_000;
const CRT_INTERVAL_MS = 6 * 60 * 60_000;
const HTTP_TIMEOUT_MS = Number(process.env.SATELLITE_HTTP_TIMEOUT_MS || 20_000);
const DEFAULT_HUB_URL = "https://webtracker.up.railway.app";
const DEFAULT_HUB_TOKEN = "Nigrok129518582821iajdwoid19!";

function isSatelliteRole() {
  return String(process.env.PAGEPULSE_ROLE || "hub").trim().toLowerCase() === "satellite";
}

function satelliteId() {
  return String(
    process.env.SATELLITE_ID ||
      process.env.RAILWAY_SERVICE_NAME ||
      process.env.RAILWAY_REPLICA_ID ||
      ""
  ).trim() || os.hostname() || "satellite";
}

function hubUrl() {
  return String(process.env.WEBPAGE_TRACKER_URL || DEFAULT_HUB_URL).trim().replace(/\/+$/, "");
}

function hubToken() {
  return String(
    process.env.EVENT_STREAM_TOKEN || process.env.WEBPAGE_TRACKER_TOKEN || DEFAULT_HUB_TOKEN
  ).trim();
}

function getSatelliteConfig() {
  return {
    id: satelliteId(),
    hubUrl: hubUrl(),
    token: hubToken(),
  };
}

const posted = new Set();
const nextPollAt = new Map();
const binanceEtags = new Map();
const pumpAcknowledged = {
  runtimeVersion: null,
  updateId: null,
  etag: null,
};
let robinhoodState = {
  baselined: false,
  brandBuildId: null,
  homeEtag: null,
  learnBuildId: null,
  learnEtag: null,
  loginEtag: null,
  robotsEtag: null,
  runtimeUrl: null,
  sitemapEtag: null,
  sourcesJson: "{}",
};
let watchlist = {
  flags: {},
  sites: [],
  github_targets: [],
  youtube_channels: [],
  binance_square_targets: [],
  binance_ui_namespaces: [],
};
let watchlistTimer = null;
let dispatchTimer = null;
let flushTimer = null;
let lastCrtAt = 0;
let lastPostAt = 0;
let nextPostAt = 0;
let posting = false;
const pending = [];

function remember(key) {
  if (posted.has(key)) return false;
  posted.add(key);
  return true;
}

function queueItem(item) {
  pending.push(item);
}

async function hubRequest(method, pathname, body) {
  const base = hubUrl();
  const token = hubToken();
  if (!base) throw new Error("WEBPAGE_TRACKER_URL is required");
  if (!token) throw new Error("EVENT_STREAM_TOKEN is required");
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 300) };
    }
  }
  if (!response.ok) {
    throw new Error(data.error || `${method} ${pathname} returned HTTP ${response.status}`);
  }
  return data;
}

async function refreshWatchlist() {
  watchlist = await hubRequest("GET", "/v1/watchlist");
}

async function flushObservations() {
  if (posting || Date.now() < nextPostAt) return;
  const heartbeatDue = Date.now() - lastPostAt >= WATCHLIST_INTERVAL_MS;
  if (!pending.length && !heartbeatDue) return;
  posting = true;
  const items = pending.splice(0, 50);
  try {
    const result = await hubRequest("POST", "/v1/observations", {
      satellite_id: satelliteId(),
      items,
    });
    lastPostAt = Date.now();
    const errors = Array.isArray(result.errors) ? result.errors : [];
    const retryItems = errors
      .filter((entry) => !/^(Unknown|Unsupported|Invalid|Missing)| requires /.test(entry.error || ""))
      .map((entry) => items[Number(entry.index)])
      .filter(Boolean);
    if (retryItems.length) {
      pending.unshift(...retryItems);
      nextPostAt = Date.now() + 5_000;
    }
    if (errors.length) {
      console.warn(
        `[satellite] hub rejected ${errors.length} observation${errors.length === 1 ? "" : "s"}: ${errors[0].error}`
      );
    }
  } catch (error) {
    pending.unshift(...items);
    nextPostAt = Date.now() + 5_000;
    console.warn(`[satellite] observation post failed: ${error.message}`);
  } finally {
    posting = false;
  }
}

async function pollSite(site) {
  const playbook = getPlaybook(site.hostname);
  if (playbook) {
    const groups = await collectPlaybook(playbook);
    for (const group of groups) {
      if (group.error) continue;
      const sourceIdentity =
        `website_source:${site.id}:${playbook.key}:${group.key}`;
      const firstSourceObservation = remember(sourceIdentity);
      const urls = [];
      for (const page of group.pages || []) {
        if (!page.url || !remember(`website_page:${site.id}:${page.url}`)) continue;
        urls.push({
          url: page.url,
          title: page.title || undefined,
          discovery_source: group.source || "sitemap",
        });
      }
      if (urls.length || firstSourceObservation) {
        queueItem({
          kind: "website_page",
          site_id: site.id,
          playbook_key: playbook.key,
          source_key: group.key,
          urls,
        });
      }
    }
    return;
  }

  const sources = new Map();
  const discovered = await discoverSite(site.url, () => {}, (url, source) => {
    if (!sources.has(url)) sources.set(url, source);
  });
  const urls = (site.ignore_locales ? excludeTranslatedUrls(discovered) : discovered)
    .filter((url) => remember(`website_page:${site.id}:${url}`))
    .map((url) => ({ url, discovery_source: sources.get(url) || "discovery" }));
  if (urls.length) queueItem({ kind: "website_page", site_id: site.id, urls });
}

async function pollGithub(target) {
  if (!process.env.GITHUB_TOKEN) return;
  const result = await fetchGitHubTarget(target);
  if (result.unchanged || !result.items.length) return;
  const items = result.items.filter((item) => remember(`github:${target.id}:${item.externalId}`));
  if (!items.length) return;
  queueItem({
    kind: items[0].kind === "repository" ? "github_repository" : "github_commit",
    target_id: target.id,
    items,
  });
}

async function pollYouTube(channel) {
  const videos = await getLatestVideos({
    channelId: channel.channel_id,
    title: channel.title,
  });
  const fresh = videos.filter((video) => video.videoId && remember(`youtube:${channel.channel_id}:${video.videoId}`));
  if (!fresh.length) return;
  queueItem({
    kind: "youtube_video",
    channel_id: channel.channel_id,
    videos: fresh,
  });
}

async function pollSquare(target) {
  const posts = await fetchBinanceSquareWindow({
    squareUid: target.square_uid,
    username: target.username,
    displayName: target.display_name,
    avatar: target.avatar,
    pinnedPostCount: target.pinned_post_count,
  });
  const fresh = posts.filter((post) => post.id && remember(`square:${target.square_uid}:${post.id}`));
  if (!fresh.length) return;
  queueItem({
    kind: "binance_square_post",
    square_uid: target.square_uid,
    posts: fresh,
  });
}

async function pollBinanceUi(namespace) {
  const result = await fetchBinanceNamespace(namespace, binanceEtags.get(namespace) || null);
  if (result.unchanged) return;
  if (result.etag) binanceEtags.set(namespace, result.etag);
  const versionKey = result.versionId || result.etag;
  if (!versionKey || !remember(`binance_ui:${namespace}:${versionKey}`)) return;
  queueItem({
    kind: "binance_ui",
    namespace,
    etag: result.etag,
    version_id: result.versionId,
    last_modified: result.lastModified,
    observed_at: new Date().toISOString(),
    data: result.data,
  });
}

async function pollPump() {
  const runtimeVersion = await resolvePumpRuntimeVersion();
  const sameRuntime = pumpAcknowledged.runtimeVersion === runtimeVersion;
  const result = await fetchPumpUpdate({
    updateId: sameRuntime ? pumpAcknowledged.updateId : null,
    etag: sameRuntime ? pumpAcknowledged.etag : null,
    runtimeVersion,
  });
  if (result.unchanged || !result.manifest?.id) return;
  if (!remember(`pump:${result.manifest.id}`)) return;
  queueItem({
    kind: "pump_app_update",
    updateId: result.manifest.id,
    runtimeVersion: result.manifest.runtimeVersion || runtimeVersion,
    publishedAt: result.manifest.createdAt || null,
    etag: result.etag,
    manifest: result.manifest,
    extensions: result.extensions || {},
    observed_at: new Date().toISOString(),
  });
  pumpAcknowledged.runtimeVersion = result.manifest.runtimeVersion || runtimeVersion;
  pumpAcknowledged.updateId = result.manifest.id;
  pumpAcknowledged.etag = result.etag;
}

async function pollRobinhood() {
  const result = await discoverRobinhood(robinhoodState);
  if (result.unchanged || !result.pages?.length) return;
  const pages = result.pages.filter((page) => page.url && remember(`robinhood_page:${page.url}`));
  const state = {
    baselined: true,
    brandBuildId: result.brandBuildId,
    homeEtag: result.homeEtag,
    learnBuildId: result.learnBuildId,
    learnEtag: result.learnEtag,
    loginEtag: result.loginEtag,
    robotsEtag: result.robotsEtag,
    runtimeUrl: result.runtimeUrl,
    sitemapEtag: result.sitemapEtag,
    sourcesJson: JSON.stringify(result.sources || {}),
  };
  if (pages.length) {
    queueItem({
      kind: "robinhood_page",
      pages,
      state: {
        ...state,
        sources: result.sources || {},
      },
    });
  }
  robinhoodState = state;
}

async function pollCrt(site) {
  const entries = await fetchCrtShNames(site.hostname);
  const fresh = entries
    .filter((entry) => entry.hostname && remember(`website_subdomain:${site.id}:${entry.hostname}`))
    .map((entry) => ({
      hostname: entry.hostname,
      wildcard: Boolean(entry.wildcard),
      dns_status: "unchecked",
    }));
  if (!fresh.length) return;
  queueItem({
    kind: "website_subdomain",
    site_id: site.id,
    source: "crt.sh",
    entries: fresh,
  });
}

function due(key, intervalMs, now) {
  if ((nextPollAt.get(key) || 0) > now) return false;
  nextPollAt.set(key, now + intervalMs);
  return true;
}

async function runTasks(tasks, concurrency = 20) {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    async () => {
      while (index < tasks.length) {
        const task = tasks[index++];
        try {
          await task();
        } catch (error) {
          console.warn(`[satellite] poll failed: ${error.message}`);
        }
      }
    }
  );
  await Promise.all(workers);
}

async function dispatch() {
  const flags = watchlist.flags || {};
  const now = Date.now();
  const tasks = [];

  if (flags.websites !== false) {
    for (const site of watchlist.sites || []) {
      if (site.enabled === false) continue;
      if (due(`site:${site.id}`, DEFAULT_POLL_MS, now)) {
        tasks.push(() => pollSite(site));
      }
    }
  }
  if (flags.github && process.env.GITHUB_TOKEN) {
    for (const target of watchlist.github_targets || []) {
      if (target.enabled === false) continue;
      if (due(`github:${target.id}`, DEFAULT_POLL_MS, now)) {
        tasks.push(() => pollGithub(target));
      }
    }
  }
  if (flags.youtube) {
    for (const channel of watchlist.youtube_channels || []) {
      const waitMs = Math.max(2, Number(channel.poll_interval_seconds) || 15) * 1000;
      if (due(`youtube:${channel.channel_id}`, waitMs, now)) {
        tasks.push(() => pollYouTube(channel));
      }
    }
  }
  if (flags.binance_square) {
    for (const target of watchlist.binance_square_targets || []) {
      const waitMs = Math.max(2, Number(target.poll_interval_seconds) || 2) * 1000;
      if (due(`square:${target.square_uid}`, waitMs, now)) {
        tasks.push(() => pollSquare(target));
      }
    }
  }
  if (flags.binance_ui) {
    for (const namespace of watchlist.binance_ui_namespaces || []) {
      if (due(`binance:${namespace}`, DEFAULT_POLL_MS, now)) {
        tasks.push(() => pollBinanceUi(namespace));
      }
    }
  }
  if (flags.pump_app && due("pump", DEFAULT_POLL_MS, now)) {
    tasks.push(() => pollPump());
  }
  if (flags.robinhood && due("robinhood", DEFAULT_POLL_MS, now)) {
    tasks.push(() => pollRobinhood());
  }
  if (flags.certificate_transparency && now - lastCrtAt >= CRT_INTERVAL_MS) {
    lastCrtAt = now;
    for (const site of watchlist.sites || []) {
      if (site.enabled === false) continue;
      tasks.push(() => pollCrt(site));
    }
  }

  await runTasks(tasks);
  await flushObservations();
  scheduleDispatch();
}

function scheduleDispatch() {
  dispatchTimer = setTimeout(() => {
    void dispatch();
  }, 250);
  dispatchTimer.unref();
}

function startHealthServer() {
  const port = Number(process.env.PORT) || 3000;
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[satellite] ${satelliteId()} listening on http://localhost:${port}/health`);
  });
  return server;
}

function startSatelliteProcess() {
  const server = startHealthServer();
  console.log(`[satellite] ${satelliteId()} posting to ${hubUrl()}`);
  const refresh = () => refreshWatchlist().catch((error) => {
    console.warn(`[satellite] watchlist refresh failed: ${error.message}`);
  });
  void refresh().then(() => dispatch());
  watchlistTimer = setInterval(refresh, WATCHLIST_INTERVAL_MS);
  watchlistTimer.unref();
  flushTimer = setInterval(() => {
    void flushObservations();
  }, 1_000);
  flushTimer.unref();

  const shutdown = () => {
    if (watchlistTimer) clearInterval(watchlistTimer);
    if (dispatchTimer) clearTimeout(dispatchTimer);
    if (flushTimer) clearInterval(flushTimer);
    server.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

module.exports = {
  getSatelliteConfig,
  isSatelliteRole,
  startSatelliteProcess,
};
