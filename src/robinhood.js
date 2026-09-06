const { extractLinks, extractSitemapEntries } = require("./discovery");

const USER_AGENT = "PagePulse/1.0 (+website change monitor)";
const REQUEST_TIMEOUT_MS = 10_000;
const ORIGIN = "https://robinhood.com";
const BRAND_HOME = "https://robinhood.com/us/en/";
const LOGIN_URL = "https://robinhood.com/login";
const LEARN_HOME = "https://robinhood.com/us/en/learn/";
const ROBOTS_URL = "https://robinhood.com/robots.txt";
const SITEMAP_INDEX = "https://robinhood.com/sitemap.xml";
const BRAND_CDN = "https://cdn.robinhood.com/assets/generated_assets/brand";
const WEBAPP_CDN = "https://cdn.robinhood.com/assets/generated_assets/webapp";

const SOURCE_ORDER = [
  "brand_manifest",
  "learn_manifest",
  "robots",
  "sitemap",
  "home_link",
  "learn_link",
  "login_link",
  "webapp",
];

const INTERNAL_ROUTES = new Set(["/_app", "/_error", "/404", "/500"]);
const SKIP_SITEMAP_RE = /sitemap-(?:stocks|crypto)|sherwood\.(?:news|media)|docs\.robinhood\.com/i;
const WEBAPP_PAGE_RE = /(?:Page|Router|Route|Screen)$/;
const BUILD_ID_RE = /_next\/static\/([0-9a-f]{16,40})\//g;
const MANIFEST_ABS_RE = /https?:\/\/[^"'\\\s]+_buildManifest\.js/g;
const MANIFEST_REL_RE = /["']([^"' ]+_buildManifest\.js)["']/g;
const RUNTIME_RE =
  /https?:\/\/cdn\.robinhood\.com\/assets\/generated_assets\/webapp\/runtime-[a-f0-9]+\.js/;

function isRobinhoodHost(hostname) {
  return hostname === "robinhood.com" || hostname.endsWith(".robinhood.com");
}

function titleFromUrl(rawUrl, fallback = "") {
  try {
    const url = new URL(rawUrl);
    const segment = url.pathname.split("/").filter(Boolean).at(-1);
    if (!segment) return fallback || url.hostname;
    return decodeURIComponent(segment)
      .replace(/\.[a-z\d]+$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  } catch {
    return fallback || rawUrl;
  }
}

function normalizePage(rawUrl, source, title = "") {
  try {
    const url = new URL(rawUrl, ORIGIN);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (!isRobinhoodHost(url.hostname)) return null;
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
    const normalized = url.toString();
    return {
      url: normalized,
      path: url.pathname,
      host: url.hostname,
      source,
      title: title || titleFromUrl(normalized),
    };
  } catch {
    return null;
  }
}

function isTrackableRoute(route) {
  if (!route.startsWith("/")) return false;
  if (INTERNAL_ROUTES.has(route)) return false;
  if (route.includes("/_next")) return false;
  if (route.includes("sitemap")) return false;
  if (/\.(xml|json|txt|js|css|map|woff2?|png|jpe?g|svg|ico)$/i.test(route)) return false;
  return true;
}

function parseBuildManifest(text) {
  const routes = new Set();
  const sorted = String(text).match(/sortedPages\s*:\s*(\[[^\]]+\])/);
  if (sorted) {
    for (const match of sorted[1].matchAll(/"(\/[^"]+)"/g)) {
      routes.add(decodeURIComponent(match[1]));
    }
  }
  for (const match of String(text).matchAll(/"(\/[^"]+)"/g)) {
    const route = decodeURIComponent(match[1]);
    if (route.includes(".js") || route.includes(".css") || route.startsWith("/_next")) {
      continue;
    }
    routes.add(route);
  }
  return [...routes].filter(isTrackableRoute).sort();
}

function pagesFromRoutes(routes, source) {
  const pages = [];
  for (const route of routes) {
    const page = normalizePage(route, source);
    if (page) pages.push(page);
  }
  return pages;
}

function extractBuildIds(html) {
  return [...new Set([...String(html).matchAll(BUILD_ID_RE)].map((match) => match[1]))];
}

function extractManifestUrls(html, baseUrl) {
  const urls = new Set();
  for (const match of String(html).matchAll(MANIFEST_ABS_RE)) {
    urls.add(match[0]);
  }
  for (const match of String(html).matchAll(MANIFEST_REL_RE)) {
    try {
      urls.add(new URL(match[1], baseUrl).toString());
    } catch {}
  }
  return [...urls];
}

function brandManifestUrl(buildId) {
  return `${BRAND_CDN}/_next/static/${buildId}/_buildManifest.js`;
}

function learnManifestUrl(buildId, baseUrl = LEARN_HOME) {
  return new URL(`_next/static/${buildId}/_buildManifest.js`, baseUrl).toString();
}

function extractRuntimeUrl(html) {
  return String(html).match(RUNTIME_RE)?.[0] || "";
}

function extractWebappPageNames(runtimeText) {
  const names = new Set();
  for (const match of String(runtimeText).matchAll(
    /\b\d+:"([A-Za-z][A-Za-z0-9]*?(?:Page|Router|Route|Screen))"/g
  )) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function pagesFromWebappNames(names) {
  return names.map((name) => ({
    url: `${LOGIN_URL}#${name}`,
    path: `/webapp/${name}`,
    host: "robinhood.com",
    source: "webapp",
    title: name,
  }));
}

function extractRobotsPaths(text) {
  const paths = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:allow|disallow)\s*:\s*(\/\S*)/i);
    if (!match || match[1] === "/" || match[1] === "/*") continue;
    paths.push(match[1]);
  }
  return paths;
}

function extractSitemapTargets(xml, sitemapUrl) {
  const { sitemapUrls, pageUrls } = extractSitemapEntries(
    xml,
    sitemapUrl,
    "robinhood.com"
  );
  const pages = [];
  const nested = [];
  for (const url of [...pageUrls, ...sitemapUrls]) {
    if (SKIP_SITEMAP_RE.test(url)) continue;
    if (/\.xml(?:$|\?)/i.test(url)) {
      nested.push(url);
      const page = normalizePage(url, "sitemap");
      if (page) pages.push(page);
      continue;
    }
    const page = normalizePage(url, "sitemap");
    if (page) pages.push(page);
  }
  return { pages, nested };
}

function pagesFromLinks(html, pageUrl, source = "link") {
  const pages = [];
  for (const url of extractLinks(html, pageUrl, "robinhood.com")) {
    if (/\.(js|css|png|jpe?g|svg|webp|woff2?|xml|json)(?:$|\?)/i.test(url)) continue;
    const page = normalizePage(url, source);
    if (page) pages.push(page);
  }
  return pages;
}

function mergePageSources(groups) {
  const pages = new Map();
  for (const source of SOURCE_ORDER) {
    for (const page of groups[source] || []) {
      if (!pages.has(page.url)) pages.set(page.url, page);
    }
  }
  return [...pages.values()].sort((a, b) => a.url.localeCompare(b.url));
}

function parseSourceGroups(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

async function fetchConditional(url, etag = null, accept = "*/*") {
  const headers = { "user-agent": USER_AGENT, accept };
  if (etag) headers["if-none-match"] = etag;
  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 304) {
    return { unchanged: true, etag, text: null, finalUrl: url, status: 304 };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} at ${url}`);
  }
  return {
    unchanged: false,
    etag: response.headers.get("etag") || etag,
    text: await response.text(),
    finalUrl: response.url,
    status: response.status,
  };
}

async function fetchOptional(url, etag, accept) {
  try {
    return await fetchConditional(url, etag, accept);
  } catch (error) {
    return {
      unchanged: Boolean(etag),
      etag,
      text: null,
      finalUrl: url,
      status: 0,
      error: error.message,
    };
  }
}

async function loadManifestPages(html, baseUrl, source, fallbackUrls = []) {
  const urls = new Set([...extractManifestUrls(html, baseUrl), ...fallbackUrls]);
  const pages = [];
  const issues = [];
  for (const url of urls) {
    const result = await fetchOptional(url, null, "application/javascript");
    if (result.error || !result.text) {
      issues.push(result.error || `empty manifest at ${url}`);
      continue;
    }
    pages.push(...pagesFromRoutes(parseBuildManifest(result.text), source));
  }
  return { pages, issues };
}

async function discoverRobinhood(previous = {}) {
  const issues = [];
  const sources = parseSourceGroups(previous.sourcesJson);
  const [home, login, learn, robots, sitemap] = await Promise.all([
    fetchOptional(BRAND_HOME, previous.homeEtag, "text/html"),
    fetchOptional(LOGIN_URL, previous.loginEtag, "text/html"),
    fetchOptional(LEARN_HOME, previous.learnEtag, "text/html"),
    fetchOptional(ROBOTS_URL, previous.robotsEtag, "text/plain"),
    fetchOptional(SITEMAP_INDEX, previous.sitemapEtag, "application/xml,text/xml"),
  ]);

  for (const result of [home, login, learn, robots, sitemap]) {
    if (result.error) issues.push(result.error);
  }

  const allUnchanged =
    home.unchanged &&
    login.unchanged &&
    learn.unchanged &&
    robots.unchanged &&
    sitemap.unchanged;

  if (allUnchanged && previous.baselined) {
    return {
      unchanged: true,
      pages: mergePageSources(sources),
      sources,
      issues,
      homeEtag: home.etag || previous.homeEtag || null,
      loginEtag: login.etag || previous.loginEtag || null,
      learnEtag: learn.etag || previous.learnEtag || null,
      robotsEtag: robots.etag || previous.robotsEtag || null,
      sitemapEtag: sitemap.etag || previous.sitemapEtag || null,
      brandBuildId: previous.brandBuildId || "",
      learnBuildId: previous.learnBuildId || "",
      runtimeUrl: previous.runtimeUrl || "",
    };
  }

  let brandBuildId = previous.brandBuildId || "";
  let learnBuildId = previous.learnBuildId || "";
  let runtimeUrl = previous.runtimeUrl || "";

  if (!home.unchanged && home.text) {
    brandBuildId = extractBuildIds(home.text)[0] || brandBuildId;
    const fallback = brandBuildId ? [brandManifestUrl(brandBuildId)] : [];
    const loaded = await loadManifestPages(
      home.text,
      home.finalUrl || BRAND_HOME,
      "brand_manifest",
      fallback
    );
    sources.brand_manifest = loaded.pages;
    sources.home_link = pagesFromLinks(home.text, home.finalUrl || BRAND_HOME, "home_link");
    issues.push(...loaded.issues);
  }

  if (!learn.unchanged && learn.text) {
    learnBuildId = extractBuildIds(learn.text)[0] || learnBuildId;
    const fallback = learnBuildId
      ? [learnManifestUrl(learnBuildId, learn.finalUrl || LEARN_HOME)]
      : [];
    const loaded = await loadManifestPages(
      learn.text,
      learn.finalUrl || LEARN_HOME,
      "learn_manifest",
      fallback
    );
    sources.learn_manifest = loaded.pages;
    sources.learn_link = pagesFromLinks(learn.text, learn.finalUrl || LEARN_HOME, "learn_link");
    issues.push(...loaded.issues);
  }

  if (!login.unchanged && login.text) {
    runtimeUrl = extractRuntimeUrl(login.text) || runtimeUrl;
    sources.login_link = [
      ...pagesFromLinks(login.text, login.finalUrl || LOGIN_URL, "login_link"),
      normalizePage(LOGIN_URL, "login_link"),
    ].filter(Boolean);
    if (runtimeUrl) {
      const runtime = await fetchOptional(runtimeUrl, null, "application/javascript");
      if (runtime.text) {
        sources.webapp = pagesFromWebappNames(extractWebappPageNames(runtime.text));
      } else if (runtime.error) {
        issues.push(runtime.error);
      }
    }
  }

  if (!robots.unchanged && robots.text) {
    sources.robots = extractRobotsPaths(robots.text)
      .map((path) => normalizePage(path, "robots"))
      .filter(Boolean);
  }

  if (!sitemap.unchanged && sitemap.text) {
    sources.sitemap = extractSitemapTargets(sitemap.text, SITEMAP_INDEX).pages;
  }

  const pages = mergePageSources(sources);
  return {
    unchanged: false,
    pages,
    sources,
    issues,
    homeEtag: home.etag || previous.homeEtag || null,
    loginEtag: login.etag || previous.loginEtag || null,
    learnEtag: learn.etag || previous.learnEtag || null,
    robotsEtag: robots.etag || previous.robotsEtag || null,
    sitemapEtag: sitemap.etag || previous.sitemapEtag || null,
    brandBuildId,
    learnBuildId,
    runtimeUrl,
  };
}

module.exports = {
  BRAND_CDN,
  BRAND_HOME,
  LEARN_HOME,
  LOGIN_URL,
  ORIGIN,
  REQUEST_TIMEOUT_MS,
  ROBOTS_URL,
  SITEMAP_INDEX,
  SOURCE_ORDER,
  WEBAPP_CDN,
  brandManifestUrl,
  discoverRobinhood,
  extractBuildIds,
  extractManifestUrls,
  extractRobotsPaths,
  extractRuntimeUrl,
  extractSitemapTargets,
  extractWebappPageNames,
  fetchConditional,
  isRobinhoodHost,
  isTrackableRoute,
  learnManifestUrl,
  mergePageSources,
  normalizePage,
  pagesFromRoutes,
  pagesFromWebappNames,
  parseBuildManifest,
  parseSourceGroups,
  titleFromUrl,
};
