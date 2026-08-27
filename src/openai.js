const cheerio = require("cheerio");
const {
  OPENAI_BROWSER_UA,
  canonicalizePageUrl,
  isOpenAiHost,
} = require("./discovery");

const OPENAI_RSS_URL = "https://openai.com/news/rss.xml";
const OPENAI_SITEMAP_INDEX_URL = "https://openai.com/sitemap.xml";
const FETCH_TIMEOUT_MS = 15_000;
const SITEMAP_FETCH_TIMEOUT_MS = 20_000;

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

function isOpenAiChildSitemapUrl(value) {
  try {
    const url = new URL(value);
    if (!isOpenAiHost(url.hostname)) return false;
    return /^\/sitemap\.xml\/[^/]+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function childSitemapKey(sitemapUrl) {
  try {
    const url = new URL(sitemapUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.slice(1).join("/") || "";
  } catch {
    return "";
  }
}

function parseOpenAiSitemapIndex(xml) {
  return [...new Set(extractXmlLocs(xml).filter(isOpenAiChildSitemapUrl))];
}

function parseOpenAiSitemapPages(xml) {
  const urls = [];
  const seen = new Set();
  for (const loc of extractXmlLocs(xml)) {
    if (isOpenAiChildSitemapUrl(loc)) continue;
    const canonical = canonicalizePageUrl(loc);
    if (!canonical) continue;
    let hostname;
    try {
      hostname = new URL(canonical).hostname;
    } catch {
      continue;
    }
    if (!isOpenAiHost(hostname) || seen.has(canonical)) continue;
    seen.add(canonical);
    urls.push(canonical);
  }
  return urls;
}

async function fetchOpenAiXml(url, { now = Date.now(), timeoutMs = SITEMAP_FETCH_TIMEOUT_MS } = {}) {
  const target = new URL(url);
  target.searchParams.set("t", String(now));
  const response = await fetch(target, {
    headers: {
      accept: "application/xml, text/xml, */*",
      "user-agent": OPENAI_BROWSER_UA,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} at ${url}`);
  return response.text();
}

function parseOpenAiRss(xml) {
  const $ = cheerio.load(String(xml || ""), { xmlMode: true });
  const items = [];
  const seen = new Set();
  $("item").each((_, element) => {
    const link = $(element).find("link").first().text().trim();
    const canonical = canonicalizePageUrl(link);
    if (!canonical) return;
    const hostname = new URL(canonical).hostname;
    if (!isOpenAiHost(hostname) || seen.has(canonical)) return;
    seen.add(canonical);
    items.push({
      url: canonical,
      title: $(element).find("title").first().text().replace(/\s+/g, " ").trim(),
      category: $(element).find("category").first().text().trim(),
    });
  });
  return items;
}

async function fetchOpenAiRss({ now = Date.now() } = {}) {
  const url = new URL(OPENAI_RSS_URL);
  url.searchParams.set("t", String(now));
  const response = await fetch(url, {
    headers: {
      accept: "application/rss+xml, application/xml, text/xml, */*",
      "user-agent": OPENAI_BROWSER_UA,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenAI RSS returned ${response.status}`);
  return parseOpenAiRss(await response.text());
}

module.exports = {
  OPENAI_RSS_URL,
  OPENAI_SITEMAP_INDEX_URL,
  childSitemapKey,
  extractXmlLocs,
  fetchOpenAiRss,
  fetchOpenAiXml,
  isOpenAiChildSitemapUrl,
  parseOpenAiRss,
  parseOpenAiSitemapIndex,
  parseOpenAiSitemapPages,
};
