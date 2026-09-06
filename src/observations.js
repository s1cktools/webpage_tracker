const { processBinanceObservation } = require("./binance-observations");
const { ingestBinanceSquarePage } = require("./binance-square-scanner");
const { isConcreteSubdomainOf } = require("./ct");
const {
  addDiscoveredSubdomains,
  addDiscoveredUrls,
  addGithubItems,
  addGithubLog,
  addLog,
  addRobinhoodPages,
  getSetting,
  statements,
  touchSatellite,
} = require("./db");
const {
  buildGitHubPayload,
  buildRobinhoodPayload,
  buildSubdomainPayload,
} = require("./discord");
const {
  buildBinanceSquarePostEvent,
  buildGithubEvent,
  buildRobinhoodPageEvent,
  buildWebsiteSubdomainEvent,
  buildYouTubeVideoEvent,
} = require("./events");
const { emitTrackerEvent } = require("./event-stream");
const { processPumpObservation } = require("./pump-observations");
const {
  saveGithubReport,
  saveRobinhoodReport,
  saveSubdomainsReport,
} = require("./reports");
const { notifyWebsitePages } = require("./scanner");
const { canonicalizePageUrl } = require("./discovery");
const { ingestYouTubePage } = require("./youtube-scanner");

function emptyResult() {
  return { inserted: 0, emitted: 0, items: [] };
}

async function postDiscordPayload(payload) {
  const webhookUrl = getSetting("discord_webhook_url");
  if (!webhookUrl) return;
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

function normalizeWebsiteUrls(items) {
  const urls = [];
  const sources = new Map();
  const titles = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item === "string" && item.trim()) {
      urls.push(canonicalizePageUrl(item.trim()) || item.trim());
      continue;
    }
    if (!item || typeof item.url !== "string" || !item.url.trim()) continue;
    const url = canonicalizePageUrl(item.url.trim()) || item.url.trim();
    urls.push(url);
    if (item.discovery_source || item.source) {
      sources.set(url, item.discovery_source || item.source);
    }
    if (item.title) titles.set(url, item.title);
  }
  return { urls, sources, titles };
}

async function ingestWebsitePages(site, items, options = {}) {
  const normalized = normalizeWebsiteUrls(items);
  const sources = options.sources || normalized.sources;
  const titles = options.titles || normalized.titles;
  const isBaseline = options.isBaseline ?? !site.baselined;
  const inserted = addDiscoveredUrls(site.id, normalized.urls, isBaseline);
  const shouldNotify = options.notify ?? (!isBaseline && Boolean(site.baselined));
  const dumpThreshold = Number(options.dumpThreshold) || 0;
  const dumpFused =
    shouldNotify && dumpThreshold > 0 && inserted.length >= dumpThreshold;
  if (dumpFused) {
    addLog(
      site.id,
      "warn",
      `archived ${inserted.length} unseen URLs without alerts (dump fuse)`
    );
  } else if (inserted.length && shouldNotify) {
    try {
      await notifyWebsitePages(
        site,
        inserted,
        sources,
        options.startedAt || Date.now(),
        titles
      );
    } catch (error) {
      addLog(site.id, "error", `website notification failed: ${error.message}`);
    }
  }
  return {
    inserted: inserted.length,
    emitted: shouldNotify && !dumpFused ? inserted.length : 0,
    items: inserted,
    sources,
    titles,
  };
}

async function ingestWebsiteSubdomains(site, entries, source, options = {}) {
  const isBaseline = options.isBaseline ?? (options.forceBaseline || !site.ct_baselined);
  const inserted = addDiscoveredSubdomains(site.id, entries, source, isBaseline);
  if (!inserted.length) return emptyResult();
  if (isBaseline || !site.ct_baselined) {
    return { inserted: inserted.length, emitted: 0, items: inserted };
  }

  const detectedAt = options.detectedAt || new Date();
  let reportUrl = null;
  try {
    reportUrl = saveSubdomainsReport(site, inserted).url;
  } catch (error) {
    addLog(site.id, "error", `CT report failed: ${error.message}`);
  }
  for (const entry of inserted) {
    emitTrackerEvent(
      buildWebsiteSubdomainEvent(site, entry, detectedAt, reportUrl, inserted.length)
    );
  }
  try {
    await postDiscordPayload(
      buildSubdomainPayload(
        site,
        inserted,
        Date.now() - (options.startedAt || Date.now()),
        detectedAt,
        reportUrl
      )
    );
  } catch (error) {
    addLog(site.id, "error", `CT Discord alert failed: ${error.message}`);
  }
  addLog(
    site.id,
    "new",
    `${inserted.length} new certificate subdomain${inserted.length === 1 ? "" : "s"}`
  );
  return {
    inserted: inserted.length,
    emitted: inserted.length,
    items: inserted,
    reportUrl,
  };
}

async function ingestGithubItems(target, items, options = {}) {
  const inserted = addGithubItems(target.id, items, !target.baselined);
  if (!target.baselined || !inserted.length) {
    return { inserted: inserted.length, emitted: 0, items: inserted };
  }
  const detectedAt = new Date();
  const report = saveGithubReport(target, inserted);
  for (const item of inserted) {
    emitTrackerEvent(
      buildGithubEvent(target, item, detectedAt, report.url, inserted.length)
    );
  }
  try {
    await postDiscordPayload(
      buildGitHubPayload(
        target,
        inserted,
        Date.now() - (options.startedAt || Date.now()),
        detectedAt,
        report.url
      )
    );
  } catch (error) {
    addGithubLog(target.id, "error", `Discord alert failed: ${error.message}`);
  }
  return { inserted: inserted.length, emitted: inserted.length, items: inserted, report };
}

async function ingestRobinhoodPages(pages, isBaseline, options = {}) {
  const inserted = addRobinhoodPages(pages, isBaseline);
  if (isBaseline || !inserted.length) {
    return { inserted: inserted.length, emitted: 0, items: inserted };
  }
  const detectedAt = new Date();
  const report = saveRobinhoodReport(inserted);
  for (const page of inserted) {
    emitTrackerEvent(
      buildRobinhoodPageEvent(page, detectedAt, report.url, inserted.length)
    );
  }
  try {
    await postDiscordPayload(
      buildRobinhoodPayload(
        inserted,
        Date.now() - (options.startedAt || Date.now()),
        detectedAt,
        report.url
      )
    );
  } catch (error) {
    console.warn(`[robinhood] Discord alert failed: ${error.message}`);
  }
  return { inserted: inserted.length, emitted: inserted.length, items: inserted, report };
}

function ingestYouTubeObservation(channel, videos) {
  const discovered = ingestYouTubePage(channel, videos);
  const current = statements.getYouTubeChannel.get(channel.channel_id);
  for (const video of discovered) {
    emitTrackerEvent(buildYouTubeVideoEvent(current, video));
  }
  return { inserted: discovered.length, emitted: discovered.length, items: discovered };
}

function ingestSquareObservation(target, posts) {
  const discovered = ingestBinanceSquarePage(target, posts);
  const current = statements.getBinanceSquareTarget.get(target.square_uid);
  for (const post of discovered.sort(
    (left, right) => (left.createdAt || 0) - (right.createdAt || 0)
  )) {
    emitTrackerEvent(buildBinanceSquarePostEvent(current, post));
  }
  return { inserted: discovered.length, emitted: discovered.length, items: discovered };
}

async function ingestBinanceObservation(item, context) {
  const result = await processBinanceObservation({
    namespace: item.namespace,
    etag: item.etag,
    versionId: item.version_id ?? item.versionId,
    lastModified: item.last_modified ?? item.lastModified,
    snapshot: item.data ?? item.snapshot,
    probeId: context.satelliteId,
    observedAt: item.observed_at || new Date().toISOString(),
    scanDurationMs: item.scan_duration_ms ?? item.scanDurationMs ?? 0,
  });
  const changes = Array.isArray(result.changes) ? result.changes : [];
  return {
    inserted: changes.length,
    emitted: result.notified ? 1 : 0,
    items: changes,
  };
}

async function ingestPumpObservation(item, context) {
  const result = await processPumpObservation({
    updateId: item.update_id ?? item.updateId,
    etag: item.etag,
    publishedAt: item.published_at ?? item.publishedAt,
    runtimeVersion: item.runtime_version ?? item.runtimeVersion,
    manifest: item.manifest,
    extensions: item.extensions,
    probeId: context.satelliteId,
    observedAt: item.observed_at || new Date().toISOString(),
    scanDurationMs: item.scan_duration_ms ?? item.scanDurationMs ?? 0,
  });
  return {
    inserted: ["accepted", "baselined"].includes(result.status) ? 1 : 0,
    emitted: result.notified ? 1 : 0,
    items: result.update ? [result.update] : [],
  };
}

async function applyObservation(item, context = {}) {
  if (!item || typeof item !== "object" || !item.kind) {
    throw new Error("observation kind is required");
  }
  switch (item.kind) {
    case "website_page": {
      const site = statements.getSite.get(Number(item.site_id));
      if (!site) throw new Error(`Unknown site_id: ${item.site_id}`);
      const playbookKey = String(item.playbook_key || "").trim();
      const sourceKey = String(item.source_key || "").trim();
      if (!playbookKey || !sourceKey) {
        return ingestWebsitePages(site, item.urls || [], { dumpThreshold: 20 });
      }
      if (
        !/^[a-z0-9_-]{1,80}$/i.test(playbookKey) ||
        sourceKey.length > 200 ||
        sourceKey.includes(",")
      ) {
        throw new Error("Invalid website source identity");
      }
      const settingKey = `website_sources_${playbookKey}`;
      const seenSources = new Set(
        String(getSetting(settingKey) || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      );
      const firstSeen = !seenSources.has(sourceKey);
      const result = await ingestWebsitePages(site, item.urls || [], {
        isBaseline: firstSeen || !site.baselined,
        notify: !firstSeen && Boolean(site.baselined),
        dumpThreshold: 20,
      });
      if (firstSeen) {
        seenSources.add(sourceKey);
        statements.setSetting.run(settingKey, [...seenSources].sort().join(","));
      }
      return result;
    }
    case "website_subdomain": {
      const site = statements.getSite.get(Number(item.site_id));
      if (!site) throw new Error(`Unknown site_id: ${item.site_id}`);
      const entries = (item.entries || []).map((entry) => ({
        hostname: entry.hostname,
        wildcard: Boolean(entry.wildcard),
        dnsStatus: entry.dns_status || entry.dnsStatus || "unchecked",
      })).filter(
        (entry) =>
          !entry.wildcard &&
          isConcreteSubdomainOf(entry.hostname, site.hostname)
      );
      return ingestWebsiteSubdomains(site, entries, item.source || "satellite");
    }
    case "github_commit":
    case "github_repository":
    case "github": {
      const target = statements.getGithubTarget.get(Number(item.target_id));
      if (!target) throw new Error(`Unknown target_id: ${item.target_id}`);
      const items = (item.items || []).map((entry) => ({
        ...entry,
        externalId: entry.externalId ?? entry.external_id,
      }));
      return ingestGithubItems(target, items);
    }
    case "robinhood_page": {
      const previous = statements.getRobinhoodState.get();
      const result = await ingestRobinhoodPages(
        item.pages || [],
        !previous.baselined
      );
      if (!previous.baselined && item.state) {
        statements.saveRobinhoodState.run(
          item.state.homeEtag || null,
          item.state.loginEtag || null,
          item.state.learnEtag || null,
          item.state.robotsEtag || null,
          item.state.sitemapEtag || null,
          item.state.brandBuildId || null,
          item.state.learnBuildId || null,
          item.state.runtimeUrl || null,
          JSON.stringify(item.state.sources || {}),
          (item.pages || []).length
        );
      }
      return result;
    }
    case "pump_app_update":
      return ingestPumpObservation(item, context);
    case "youtube_video": {
      const channel = statements.getYouTubeChannel.get(item.channel_id);
      if (!channel) throw new Error(`Unknown channel_id: ${item.channel_id}`);
      return ingestYouTubeObservation(channel, item.videos || []);
    }
    case "binance_square_post": {
      const target = statements.getBinanceSquareTarget.get(item.square_uid);
      if (!target) throw new Error(`Unknown square_uid: ${item.square_uid}`);
      return ingestSquareObservation(target, item.posts || []);
    }
    case "binance_ui":
      return ingestBinanceObservation(item, context);
    default:
      throw new Error(`Unsupported observation kind: ${item.kind}`);
  }
}

async function applyObservations(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  const satelliteId = String(body?.satellite_id || "").trim() || "unknown";
  touchSatellite(satelliteId, items.map((item) => item?.kind).filter(Boolean));
  let accepted = 0;
  let inserted = 0;
  let emitted = 0;
  const errors = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    try {
      const result = await applyObservation(item, { satelliteId });
      accepted += 1;
      inserted += result.inserted || 0;
      emitted += result.emitted || 0;
    } catch (error) {
      errors.push({
        index,
        kind: item?.kind || "unknown",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { accepted, inserted, emitted, errors };
}

module.exports = {
  applyObservation,
  applyObservations,
  ingestGithubItems,
  ingestRobinhoodPages,
  ingestWebsitePages,
  ingestWebsiteSubdomains,
};
