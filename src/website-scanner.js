const {
  addLog,
  getSetting,
  pruneDiscoveredUrls,
  statements,
} = require("./db");
const { canonicalSiteHostname, siteHostnameAliases } = require("./ct");
const { excludeTranslatedUrls, isTranslatedUrl } = require("./discovery");
const { fallbackTitle } = require("./discord");
const { ingestWebsitePages } = require("./observations");
const { notifyWebsitePages } = require("./scanner");
const { WEBSITE_PLAYBOOKS, collectPlaybook, getPlaybook } = require("./websites");

const WEBSITE_POLL_INTERVAL_MS = 5_000;
const LOG_INTERVAL_MS = 5 * 60_000;

const scanning = new Set();
const lastLogAt = new Map();
const ticking = { value: false };

function sourcesSettingKey(playbookKey) {
  return `website_sources_${playbookKey}`;
}

function loadSeenSources(playbookKey) {
  return new Set(
    String(getSetting(sourcesSettingKey(playbookKey)) || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function saveSeenSources(playbookKey, seen) {
  statements.setSetting.run(sourcesSettingKey(playbookKey), [...seen].sort().join(","));
}

function logOccasionally(siteId, type, level, message) {
  const key = `${siteId}:${type}`;
  const now = Date.now();
  if (now - (lastLogAt.get(key) || 0) < LOG_INTERVAL_MS) return;
  lastLogAt.set(key, now);
  addLog(siteId, level, message);
}

function syncWebsitePlaybooks() {
  const claimed = new Set();
  for (const playbook of WEBSITE_PLAYBOOKS) {
    const aliases = siteHostnameAliases(playbook.hostname);
    const existing = statements.getSiteByHostnames.get(
      aliases[0],
      aliases[1] || aliases[0]
    );
    if (existing) {
      statements.updateWebsitePlaybook.run(
        playbook.url,
        playbook.hostname,
        playbook.nickname,
        playbook.ignoreLocales ? 1 : 0,
        existing.id
      );
      claimed.add(existing.id);
      if (playbook.ignoreLocales) {
        const removed = pruneDiscoveredUrls(existing.id, isTranslatedUrl);
        if (removed) addLog(existing.id, "info", `removed ${removed} translated URLs`);
      }
    } else {
      const id = Number(
        statements.addSiteWithLocales.run(
          playbook.url,
          playbook.hostname,
          playbook.nickname,
          playbook.ignoreLocales ? 1 : 0
        ).lastInsertRowid
      );
      claimed.add(id);
    }
  }

  for (const site of statements.listSites.all()) {
    if (claimed.has(site.id)) continue;
    if (site.enabled) statements.setSiteEnabled.run(0, site.id);
  }
}

function siteForPlaybook(playbook) {
  const aliases = siteHostnameAliases(playbook.hostname);
  return statements.getSiteByHostnames.get(aliases[0], aliases[1] || aliases[0]) || null;
}

async function scanWebsite(playbook, { force = false } = {}) {
  const site = siteForPlaybook(playbook);
  if (!site || (!site.enabled && !force)) return;
  if (scanning.has(site.id)) return;
  scanning.add(site.id);
  const startedAt = Date.now();
  try {
    const groups = await collectPlaybook(playbook);
    const seen = loadSeenSources(playbook.key);
    const toNotify = [];
    const sources = new Map();
    const titles = new Map();
    let pageCount = 0;
    let failures = 0;
    let collected = 0;

    for (const group of groups) {
      if (group.error) {
        failures += 1;
        continue;
      }
      collected += 1;
      let urls = group.pages.map((page) => page.url);
      if (site.ignore_locales) urls = excludeTranslatedUrls(urls);
      pageCount += urls.length;
      const firstSeen = !seen.has(group.key);
      const ingested = await ingestWebsitePages(
        site,
        urls,
        {
          isBaseline: firstSeen || !site.baselined,
          notify: false,
        }
      );
      const inserted = ingested.items;
      seen.add(group.key);
      const pageByUrl = new Map(group.pages.map((page) => [page.url, page]));
      if (!firstSeen && site.baselined) {
        for (const url of inserted) {
          toNotify.push(url);
          if (!sources.has(url)) sources.set(url, group.source || "sitemap");
          const title = pageByUrl.get(url)?.title;
          if (title) titles.set(url, title);
        }
      }
    }

    saveSeenSources(playbook.key, seen);

    if (!collected) {
      throw new Error(groups[0]?.error?.message || `${playbook.nickname} feeds failed`);
    }

    if (!site.baselined && pageCount > 0) {
      statements.markBaselined.run(site.id);
      addLog(
        site.id,
        "info",
        `${playbook.key} baseline · ${pageCount} URLs · ${seen.size} feeds`
      );
    } else if (toNotify.length) {
      for (const url of toNotify) {
        if (!titles.get(url)) titles.set(url, fallbackTitle(url));
      }
      await notifyWebsitePages(
        statements.getSite.get(site.id) || site,
        toNotify,
        sources,
        startedAt,
        titles
      );
    }

    statements.markScanSuccess.run(site.id);
    logOccasionally(
      site.id,
      "heartbeat",
      "info",
      `${playbook.key} · ${pageCount} URLs · ${groups.length} feeds · ${failures} failed · ${Date.now() - startedAt}ms`
    );
  } catch (error) {
    statements.markScanError.run(String(error.message).slice(0, 500), site.id);
    logOccasionally(site.id, "error", "warn", `${playbook.key}: ${error.message}`);
    console.error(`[website] ${playbook.hostname}:`, error.message);
  } finally {
    scanning.delete(site.id);
  }
}

async function scanWebsiteBySiteId(siteOrId, options) {
  const site =
    typeof siteOrId === "object" ? siteOrId : statements.getSite.get(siteOrId);
  if (!site) return;
  const playbook = getPlaybook(canonicalSiteHostname(site.hostname) || site.hostname);
  if (!playbook) return;
  return scanWebsite(playbook, options);
}

async function scanAllWebsites() {
  if (ticking.value) return;
  ticking.value = true;
  try {
    await Promise.allSettled(WEBSITE_PLAYBOOKS.map((playbook) => scanWebsite(playbook)));
  } finally {
    ticking.value = false;
  }
}

function startWebsiteScanner() {
  syncWebsitePlaybooks();
  scanAllWebsites();
  const timer = setInterval(scanAllWebsites, WEBSITE_POLL_INTERVAL_MS);
  timer.unref();
}

module.exports = {
  WEBSITE_POLL_INTERVAL_MS,
  scanAllWebsites,
  scanWebsite,
  scanWebsiteBySiteId,
  startWebsiteScanner,
  syncWebsitePlaybooks,
};
