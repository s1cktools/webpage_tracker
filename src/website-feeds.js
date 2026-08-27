const cheerio = require("cheerio");
const {
  OPENAI_BROWSER_UA,
  canonicalizePageUrl,
  extractLinks,
} = require("./discovery");

const FETCH_TIMEOUT_MS = 20_000;
const SITEMAP_CONCURRENCY = 6;

function decodeXmlText(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractXmlLocs(xml) {
  const locs = [];
  const pattern = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let match;
  while ((match = pattern.exec(String(xml || "")))) {
    const loc = decodeXmlText(match[1]).trim();
    if (loc) locs.push(loc);
  }
  return locs;
}

function isAllowedHost(hostname, rootHostname) {
  const host = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const root = String(rootHostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!host || !root) return false;
  return host === root || host.endsWith(`.${root}`);
}

function looksLikeSitemapFile(value) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    if (/\/sitemap\.xml\/[^/]+\/?$/.test(pathname)) return true;
    return pathname.includes("sitemap") && pathname.endsWith(".xml");
  } catch {
    return false;
  }
}

function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(String(xml || ""));
}

function sourceKeyFromUrl(value) {
  try {
    const url = new URL(value);
    return url.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return String(value || "");
  }
}

function toPage(rawUrl, allowedRoot, source) {
  const canonical = canonicalizePageUrl(rawUrl);
  if (!canonical) return null;
  let hostname;
  try {
    hostname = new URL(canonical).hostname;
  } catch {
    return null;
  }
  if (!isAllowedHost(hostname, allowedRoot)) return null;
  return { url: canonical, title: "", source };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  const workers = Math.min(Math.max(limit, 1), items.length);
  if (!workers) return results;
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

async function fetchResource(url, { now = Date.now(), cacheBust = true, accept, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const target = new URL(url);
  if (cacheBust) target.searchParams.set("t", String(now));
  const response = await fetch(target, {
    headers: {
      accept: accept || "*/*",
      "user-agent": OPENAI_BROWSER_UA,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} at ${url}`);
  return response;
}

async function fetchText(url, options = {}) {
  const response = await fetchResource(url, options);
  return response.text();
}

async function fetchXml(url, options = {}) {
  const response = await fetchResource(url, {
    ...options,
    accept: options.accept || "application/xml, text/xml, application/rss+xml, */*",
  });
  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetchResource(url, {
    ...options,
    accept: options.accept || "application/json, */*",
  });
  return response.json();
}

function parseRssItems(xml, allowedRoot) {
  const $ = cheerio.load(String(xml || ""), { xmlMode: true });
  const items = [];
  const seen = new Set();
  $("item").each((_, element) => {
    const link = $(element).find("link").first().text().trim();
    const page = toPage(link, allowedRoot, "rss");
    if (!page || seen.has(page.url)) return;
    seen.add(page.url);
    items.push({
      ...page,
      title: $(element).find("title").first().text().replace(/\s+/g, " ").trim(),
    });
  });
  return items;
}

async function collectRssSource(key, url, { allowedRoot, cacheBust = true } = {}) {
  try {
    const xml = await fetchXml(url, { cacheBust });
    return { key, source: "rss", pages: parseRssItems(xml, allowedRoot), error: null };
  } catch (error) {
    return { key, source: "rss", pages: [], error };
  }
}

function pagesFromUrlset(xml, allowedRoot) {
  const pages = [];
  const seen = new Set();
  for (const loc of extractXmlLocs(xml)) {
    if (looksLikeSitemapFile(loc)) continue;
    const page = toPage(loc, allowedRoot, "sitemap");
    if (!page || seen.has(page.url)) continue;
    seen.add(page.url);
    pages.push(page);
  }
  return pages;
}

async function collectHtmlLinksSource(
  key,
  pageUrl,
  { allowedRoot, pathIncludes = "", source = "link" } = {}
) {
  try {
    const html = await fetchText(pageUrl, {
      accept: "text/html,application/xhtml+xml",
    });
    const pages = [];
    const seen = new Set();
    for (const url of extractLinks(html, pageUrl, allowedRoot)) {
      if (pathIncludes && !url.includes(pathIncludes)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      pages.push({ url, title: "", source });
    }
    return { key, source, pages, error: null };
  } catch (error) {
    return { key, source, pages: [], error };
  }
}

async function collectUrlsetSource(key, url, { allowedRoot, cacheBust = true, xml } = {}) {
  try {
    const body = xml == null ? await fetchXml(url, { cacheBust }) : xml;
    if (/^No pages found/i.test(String(body).trim())) {
      return { key, source: "sitemap", pages: [], error: null };
    }
    if (isSitemapIndex(body)) {
      return { key, source: "sitemap", pages: [], error: new Error(`expected urlset at ${url}`) };
    }
    return { key, source: "sitemap", pages: pagesFromUrlset(body, allowedRoot), error: null };
  } catch (error) {
    return { key, source: "sitemap", pages: [], error };
  }
}

async function collectIndexSources(indexUrl, { allowedRoot, cacheBust = true, isChild, childKey } = {}) {
  try {
    const xml = await fetchXml(indexUrl, { cacheBust });
    if (!isSitemapIndex(xml)) {
      return [await collectUrlsetSource("sitemap", indexUrl, { allowedRoot, cacheBust, xml })];
    }
    const children = [];
    const seen = new Set();
    for (const loc of extractXmlLocs(xml)) {
      if (seen.has(loc)) continue;
      if (isChild && !isChild(loc)) continue;
      seen.add(loc);
      children.push(loc);
    }
    if (!children.length) {
      return [{ key: "sitemap-index", source: "sitemap", pages: [], error: new Error("sitemap index contained no files") }];
    }
    return mapLimit(children, SITEMAP_CONCURRENCY, async (childUrl) => {
      const key = childKey ? childKey(childUrl) : `sitemap:${sourceKeyFromUrl(childUrl)}`;
      return collectUrlsetSource(key, childUrl, { allowedRoot, cacheBust });
    });
  } catch (error) {
    return [{ key: "sitemap-index", source: "sitemap", pages: [], error }];
  }
}

function parseSpaceXUpdates(payload) {
  const rows = Array.isArray(payload) ? payload : [];
  const pages = [];
  const seen = new Set();
  for (const row of rows) {
    const updateId = String(row?.updateId || "").trim();
    const linked = row?.link ? toPage(row.link, "spacex.com", "cms") : null;
    const page =
      linked ||
      (updateId
        ? toPage(`https://www.spacex.com/updates/${updateId}/`, "spacex.com", "cms")
        : null);
    if (!page || seen.has(page.url)) continue;
    seen.add(page.url);
    pages.push({
      ...page,
      title: String(row?.title || "").replace(/\s+/g, " ").trim(),
    });
  }
  return pages;
}

module.exports = {
  BROWSER_UA: OPENAI_BROWSER_UA,
  SITEMAP_CONCURRENCY,
  collectHtmlLinksSource,
  collectIndexSources,
  collectRssSource,
  collectUrlsetSource,
  extractXmlLocs,
  fetchJson,
  fetchXml,
  isAllowedHost,
  isSitemapIndex,
  looksLikeSitemapFile,
  mapLimit,
  pagesFromUrlset,
  parseRssItems,
  parseSpaceXUpdates,
  sourceKeyFromUrl,
  toPage,
};
