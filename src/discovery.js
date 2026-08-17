const cheerio = require("cheerio");
const net = require("node:net");

const USER_AGENT = "PagePulse/1.0 (+website change monitor)";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_SITEMAPS = 500;
const MAX_URLS = 250_000;
const SITEMAP_CONCURRENCY = 50;
const TRANSLATED_PATH_PREFIXES = new Set([
  "ar", "de", "el", "es", "fi", "fr", "id", "it", "ja",
  "ko", "nl", "pl", "pt", "ru", "tr", "uk", "vi", "zh",
]);

function normalizeSiteUrl(value) {
  const raw = String(value || "").trim();
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS websites are supported.");
  }
  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".local") ||
    isPrivateIp(url.hostname)
  ) {
    throw new Error("Local and private network addresses are not allowed.");
  }

  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function isPrivateIp(hostname) {
  if (!net.isIP(hostname)) return false;
  return (
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80") ||
    /^10\./.test(hostname) ||
    /^127\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

async function fetchText(url, accept = "*/*") {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`${response.status} ${response.statusText} at ${url}`);
  return { text: await response.text(), finalUrl: response.url };
}

function normalizeDiscoveredUrl(rawUrl, baseUrl, rootHostname) {
  try {
    const url = new URL(rawUrl, baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (
      url.hostname !== rootHostname &&
      !url.hostname.endsWith(`.${rootHostname}`)
    ) {
      return null;
    }

    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    return url.toString();
  } catch {
    return null;
  }
}

function isTranslatedUrl(rawUrl) {
  const firstSegment = new URL(rawUrl).pathname.split("/").filter(Boolean)[0] || "";
  const language = firstSegment.toLowerCase().split("-")[0];
  return TRANSLATED_PATH_PREFIXES.has(language);
}

function excludeTranslatedUrls(urls) {
  return urls.filter((url) => !isTranslatedUrl(url));
}

function extractLinks(html, pageUrl, rootHostname) {
  const $ = cheerio.load(html);
  const urls = new Set();
  $("a[href]").each((_, element) => {
    const url = normalizeDiscoveredUrl($(element).attr("href"), pageUrl, rootHostname);
    if (url) urls.add(url);
  });
  return urls;
}

function extractPageTitle(html) {
  const $ = cheerio.load(html);
  const candidates = [
    $('meta[property="og:title"]').attr("content"),
    $('meta[name="twitter:title"]').attr("content"),
    $("title").first().text(),
    $("h1").first().text(),
  ];
  const title = candidates.find((value) => String(value || "").trim());
  return title ? String(title).replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

async function fetchPageTitle(url) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

  const contentType = response.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    await response.body?.cancel();
    return "";
  }
  return extractPageTitle(await response.text());
}

function extractSitemapEntries(xml, sitemapUrl, rootHostname) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const sitemapUrls = [];
  const pageUrls = [];

  $("sitemap > loc").each((_, element) => {
    try {
      sitemapUrls.push(new URL($(element).text().trim(), sitemapUrl).toString());
    } catch {}
  });
  $("url > loc").each((_, element) => {
    const url = normalizeDiscoveredUrl($(element).text().trim(), sitemapUrl, rootHostname);
    if (url) pageUrls.push(url);
  });

  return { sitemapUrls, pageUrls };
}

async function discoverSitemapLocations(siteUrl) {
  const site = new URL(siteUrl);
  const locations = new Set([new URL("/sitemap.xml", site).toString()]);

  try {
    const { text } = await fetchText(new URL("/robots.txt", site), "text/plain");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*sitemap:\s*(.+?)\s*$/i);
      if (match) locations.add(new URL(match[1], site).toString());
    }
  } catch {
    // A missing robots.txt should not stop normal discovery.
  }
  return locations;
}

async function discoverSite(siteUrl, onLog = () => {}, onDiscover = () => {}) {
  const site = new URL(siteUrl);
  const found = new Set([site.toString()]);
  onDiscover(site.toString(), "homepage");
  const sitemapQueue = [...(await discoverSitemapLocations(siteUrl))];
  const visitedSitemaps = new Set();

  while (sitemapQueue.length && visitedSitemaps.size < MAX_SITEMAPS) {
    const batch = [];
    while (
      sitemapQueue.length &&
      batch.length < SITEMAP_CONCURRENCY &&
      visitedSitemaps.size < MAX_SITEMAPS
    ) {
      const sitemapUrl = sitemapQueue.shift();
      if (visitedSitemaps.has(sitemapUrl)) continue;
      visitedSitemaps.add(sitemapUrl);
      batch.push(sitemapUrl);
    }

    const results = await Promise.allSettled(
      batch.map(async (sitemapUrl) => {
        const { text } = await fetchText(sitemapUrl, "application/xml,text/xml");
        return extractSitemapEntries(text, sitemapUrl, site.hostname);
      })
    );

    for (const [index, result] of results.entries()) {
      if (result.status !== "fulfilled") {
        const message = `sitemap ${batch[index]}: ${result.reason.message}`;
        const level = /\b(404|410)\b/.test(result.reason.message) ? "warn" : "error";
        onLog(level, message);
        continue;
      }
      for (const url of result.value.pageUrls) {
        if (found.size >= MAX_URLS) break;
        found.add(url);
        onDiscover(url, "sitemap");
      }
      for (const sitemapUrl of result.value.sitemapUrls) {
        if (!visitedSitemaps.has(sitemapUrl)) sitemapQueue.push(sitemapUrl);
      }
    }
  }

  if (visitedSitemaps.size >= MAX_SITEMAPS && sitemapQueue.length) {
    onLog("warn", `sitemap limit reached (${MAX_SITEMAPS})`);
  }
  if (found.size >= MAX_URLS) {
    onLog("warn", `URL limit reached (${MAX_URLS})`);
  }

  const pagesToInspect = [siteUrl];
  for (const pageUrl of [...found]) {
    if (pagesToInspect.length >= 20) break;
    if (pageUrl !== siteUrl) pagesToInspect.push(pageUrl);
  }

  const pageResults = await Promise.allSettled(
    pagesToInspect.map((url) => fetchText(url, "text/html"))
  );
  for (const [index, result] of pageResults.entries()) {
    if (result.status !== "fulfilled") {
      onLog("warn", `page ${pagesToInspect[index]}: ${result.reason.message}`);
      continue;
    }
    extractLinks(result.value.text, result.value.finalUrl, site.hostname)
      .forEach((url) => {
        found.add(url);
        onDiscover(url, "link");
      });
  }

  return [...found].slice(0, MAX_URLS).sort();
}

module.exports = {
  discoverSite,
  excludeTranslatedUrls,
  extractLinks,
  extractPageTitle,
  extractSitemapEntries,
  fetchPageTitle,
  normalizeDiscoveredUrl,
  normalizeSiteUrl,
  isTranslatedUrl,
};
