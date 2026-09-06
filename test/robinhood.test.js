const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BRAND_HOME,
  LEARN_HOME,
  LOGIN_URL,
  ROBOTS_URL,
  SITEMAP_INDEX,
  brandManifestUrl,
  discoverRobinhood,
  extractBuildIds,
  extractManifestUrls,
  extractRobotsPaths,
  extractRuntimeUrl,
  extractSitemapTargets,
  extractWebappPageNames,
  fetchConditional,
  isTrackableRoute,
  learnManifestUrl,
  mergePageSources,
  normalizePage,
  parseBuildManifest,
} = require("../src/robinhood");
const { buildRobinhoodPayload } = require("../src/discord");

const brandManifest = `
self.__BUILD_MANIFEST = function(s){return {
  "/_app": ["static/chunks/pages/_app.js"],
  "/404": ["static/chunks/pages/404.js"],
  "/us/en": [s+"en.js"],
  "/us/en/tboy": [s+"tboy.js"],
  "/us/en/agentic-trading": [s+"agentic.js"],
  "/us/en/sitemap-marketing.xml": [s+"sitemap.js"],
  "/us/en/stocks/[symbolOrId]": [s+"stock.js"],
  sortedPages: ["/_app","/404","/us/en","/us/en/tboy","/us/en/agentic-trading"]
}}
`;

const learnManifest = `
self.__BUILD_MANIFEST = {
  "/[region]/[lang]/learn": ["learn.js"],
  "/[region]/[lang]/learn/weekly-rundown": ["weekly.js"],
  "/[region]/[lang]/learn/articles/[id-or-slug]/[slug]": ["article.js"],
  sortedPages: ["/[region]/[lang]/learn","/[region]/[lang]/learn/weekly-rundown"]
};
`;

const runtimeJs = `
(self.webpackChunk=self.webpackChunk||[]).push([[9],{123:"ATMFinderPage",456:"AgenticRouter",789:"GoldSadBoy",321:"Vendor"}]);
`;

test("keeps public Next.js routes and drops internals and sitemaps", () => {
  const routes = parseBuildManifest(brandManifest);
  assert.deepEqual(routes, [
    "/us/en",
    "/us/en/agentic-trading",
    "/us/en/stocks/[symbolOrId]",
    "/us/en/tboy",
  ]);
  assert.equal(isTrackableRoute("/_app"), false);
  assert.equal(isTrackableRoute("/us/en/tboy"), true);
});

test("extracts build IDs, manifest URLs, and the webapp runtime", () => {
  const html = `
    <script src="https://cdn.robinhood.com/assets/generated_assets/brand/_next/static/abc123abc123abc123abc123abc123abc123abc1/_buildManifest.js"></script>
    <script src="https://cdn.robinhood.com/assets/generated_assets/webapp/runtime-94104270745432441dd9.js"></script>
  `;
  assert.deepEqual(extractBuildIds(html), [
    "abc123abc123abc123abc123abc123abc123abc1",
  ]);
  assert.deepEqual(extractManifestUrls(html, BRAND_HOME), [
    "https://cdn.robinhood.com/assets/generated_assets/brand/_next/static/abc123abc123abc123abc123abc123abc123abc1/_buildManifest.js",
  ]);
  assert.equal(
    extractRuntimeUrl(html),
    "https://cdn.robinhood.com/assets/generated_assets/webapp/runtime-94104270745432441dd9.js"
  );
  assert.match(
    brandManifestUrl("abc123abc123abc123abc123abc123abc123abc1"),
    /_buildManifest\.js$/
  );
  assert.equal(
    learnManifestUrl("def456", LEARN_HOME),
    "https://robinhood.com/us/en/learn/_next/static/def456/_buildManifest.js"
  );
});

test("extracts robots paths and webapp page modules", () => {
  assert.deepEqual(
    extractRobotsPaths(`
User-agent: *
Disallow: /referral/
Disallow: /natedogg/
Allow: /applink/.well-known/
Disallow: /
Sitemap: https://robinhood.com/sitemap.xml
`),
    ["/referral/", "/natedogg/", "/applink/.well-known/"]
  );
  assert.deepEqual(extractWebappPageNames(runtimeJs), [
    "ATMFinderPage",
    "AgenticRouter",
  ]);
});

test("keeps useful sitemap sections and skips ticker dumps", () => {
  const { pages } = extractSitemapTargets(
    `<sitemapindex>
      <sitemap><loc>https://robinhood.com/sitemap-marketing.xml</loc></sitemap>
      <sitemap><loc>https://robinhood.com/sitemap-stocks.xml</loc></sitemap>
      <sitemap><loc>https://careers.robinhood.com/</loc></sitemap>
      <sitemap><loc>https://sherwood.news/sitemap.xml</loc></sitemap>
    </sitemapindex>`,
    SITEMAP_INDEX
  );
  const urls = pages.map((page) => page.url).sort();
  assert.deepEqual(urls, [
    "https://careers.robinhood.com/",
    "https://robinhood.com/sitemap-marketing.xml",
  ]);
});

test("normalizes Robinhood URLs and prefers first-class sources", () => {
  const page = normalizePage("/us/en/tboy?utm_source=x#top", "brand_manifest");
  assert.equal(page.url, "https://robinhood.com/us/en/tboy");
  assert.equal(page.title, "Tboy");
  const merged = mergePageSources({
    home_link: [normalizePage("/us/en/tboy", "home_link")],
    brand_manifest: [normalizePage("/us/en/tboy", "brand_manifest")],
  });
  assert.equal(merged[0].source, "brand_manifest");
});

test("uses ETags for unchanged Robinhood checks", async (context) => {
  let headers;
  context.mock.method(global, "fetch", async (_url, options) => {
    headers = options.headers;
    return new Response(null, { status: 304 });
  });
  const result = await fetchConditional(BRAND_HOME, '"saved"');
  assert.equal(headers["if-none-match"], '"saved"');
  assert.equal(result.unchanged, true);
});

test("discovers pages from manifests, robots, sitemap, links, and webapp names", async (context) => {
  context.mock.method(global, "fetch", async (url) => {
    const href = String(url);
    if (href === BRAND_HOME) {
      return new Response(
        `<html><a href="/us/en/legend">Legend</a>
        <script src="https://cdn.robinhood.com/assets/generated_assets/brand/_next/static/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/_buildManifest.js"></script></html>`,
        { status: 200, headers: { etag: '"home"' } }
      );
    }
    if (href === LEARN_HOME) {
      return new Response(
        `<html><a href="/us/en/learn/library">Library</a>
        <script src="/us/en/learn/_next/static/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/_buildManifest.js"></script></html>`,
        { status: 200, headers: { etag: '"learn"' } }
      );
    }
    if (href === LOGIN_URL) {
      return new Response(
        `<html><script src="https://cdn.robinhood.com/assets/generated_assets/webapp/runtime-94104270745432441dd9.js"></script></html>`,
        { status: 200, headers: { etag: '"login"' } }
      );
    }
    if (href === ROBOTS_URL) {
      return new Response("Disallow: /natedogg/\n", {
        status: 200,
        headers: { etag: '"robots"' },
      });
    }
    if (href === SITEMAP_INDEX) {
      return new Response(
        "<sitemapindex><sitemap><loc>https://robinhood.com/sitemap-marketing.xml</loc></sitemap></sitemapindex>",
        { status: 200, headers: { etag: '"sitemap"' } }
      );
    }
    if (href.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/_buildManifest.js")) {
      return new Response(brandManifest, { status: 200 });
    }
    if (href.includes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/_buildManifest.js")) {
      return new Response(learnManifest, { status: 200 });
    }
    if (href.includes("runtime-94104270745432441dd9.js")) {
      return new Response(runtimeJs, { status: 200 });
    }
    throw new Error(`unexpected fetch ${href}`);
  });

  const result = await discoverRobinhood();
  const urls = result.pages.map((page) => page.url);
  assert.equal(result.unchanged, false);
  assert.ok(urls.includes("https://robinhood.com/us/en/tboy"));
  assert.ok(urls.includes("https://robinhood.com/us/en/legend"));
  assert.ok(urls.includes("https://robinhood.com/us/en/learn/library"));
  assert.ok(urls.includes("https://robinhood.com/[region]/[lang]/learn/weekly-rundown"));
  assert.ok(urls.includes("https://robinhood.com/natedogg"));
  assert.ok(urls.includes("https://robinhood.com/sitemap-marketing.xml"));
  assert.ok(urls.includes("https://robinhood.com/login#AgenticRouter"));
  assert.equal(result.homeEtag, '"home"');
});

test("returns unchanged when every Robinhood ETag still matches", async (context) => {
  context.mock.method(global, "fetch", async () => new Response(null, { status: 304 }));
  const result = await discoverRobinhood({
    baselined: true,
    homeEtag: '"home"',
    loginEtag: '"login"',
    learnEtag: '"learn"',
    robotsEtag: '"robots"',
    sitemapEtag: '"sitemap"',
    sourcesJson: JSON.stringify({
      brand_manifest: [normalizePage("/us/en/tboy", "brand_manifest")],
    }),
  });
  assert.equal(result.unchanged, true);
  assert.equal(result.pages[0].path, "/us/en/tboy");
});

test("builds Robinhood Discord embeds with a report overflow link", () => {
  const now = new Date("2026-09-06T01:00:00.000Z");
  const pages = Array.from({ length: 12 }, (_, index) => ({
    url: `https://robinhood.com/us/en/page-${index + 1}`,
    path: `/us/en/page-${index + 1}`,
    host: "robinhood.com",
    source: "brand_manifest",
    title: `Page ${index + 1}`,
  }));
  const payload = buildRobinhoodPayload(
    pages,
    418,
    now,
    "https://tracker.example/reports/rh"
  );
  assert.equal(payload.embeds.length, 10);
  assert.equal(payload.embeds[0].author.name, "robinhood.com");
  assert.equal(payload.embeds[0].title, "Page 1");
  assert.equal(payload.embeds[0].footer.text, "NEW PAGE · brand_manifest · 418ms");
  assert.match(payload.content, /View all 12/);
  assert.match(payload.content, /reports\/rh/);
});
