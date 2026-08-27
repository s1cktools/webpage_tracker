const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  canonicalizePageUrl,
  discoverSite,
  excludeTranslatedUrls,
  extractLinks,
  extractPageTitle,
  extractSitemapEntries,
  normalizeDiscoveredUrl,
  normalizeSiteUrl,
  pageUrlAliases,
} = require("../src/discovery");

test("normalizes a website entered without a protocol", () => {
  assert.equal(normalizeSiteUrl("openai.com"), "https://openai.com/");
});

test("rejects local addresses", () => {
  assert.throws(() => normalizeSiteUrl("http://127.0.0.1:3000"), /not allowed/);
});

test("keeps same-domain and subdomain links while removing tracking parameters", () => {
  const html = `
    <a href="/introducing-gpt-6?utm_source=home">Launch</a>
    <a href="https://docs.example.com/whats-new">Docs</a>
    <a href="https://other.test/page">External</a>
  `;
  assert.deepEqual(
    [...extractLinks(html, "https://example.com/", "example.com")].sort(),
    [
      "https://docs.example.com/whats-new/",
      "https://example.com/introducing-gpt-6/",
    ]
  );
});

test("extracts pages and nested sitemaps", () => {
  const pages = extractSitemapEntries(
    "<urlset><url><loc>https://example.com/new</loc></url></urlset>",
    "https://example.com/sitemap.xml",
    "example.com"
  );
  assert.deepEqual(pages.pageUrls, ["https://example.com/new/"]);

  const index = extractSitemapEntries(
    "<sitemapindex><sitemap><loc>/posts.xml</loc></sitemap></sitemapindex>",
    "https://example.com/sitemap.xml",
    "example.com"
  );
  assert.deepEqual(index.sitemapUrls, ["https://example.com/posts.xml"]);
});

test("drops fragments and external URLs", () => {
  assert.equal(
    normalizeDiscoveredUrl("/docs#intro", "https://example.com", "example.com"),
    "https://example.com/docs/"
  );
  assert.equal(
    normalizeDiscoveredUrl("https://elsewhere.com", "https://example.com", "example.com"),
    null
  );
});

test("filters translated paths while keeping default English URLs", () => {
  const urls = [
    "https://solana.com/docs/core",
    "https://solana.com/en/docs/core",
    "https://solana.com/fr/docs/core",
    "https://solana.com/pt-br/docs/core",
    "https://solana.com/news/update",
  ];

  assert.deepEqual(excludeTranslatedUrls(urls), [
    "https://solana.com/docs/core",
    "https://solana.com/en/docs/core",
    "https://solana.com/news/update",
  ]);
});

test("extracts a useful page title from metadata", () => {
  const html = `
    <html>
      <head>
        <title>Fallback title</title>
        <meta property="og:title" content="  Service disruption on Claude services  ">
      </head>
      <body><h1>Heading</h1></body>
    </html>
  `;

  assert.equal(extractPageTitle(html), "Service disruption on Claude services");
});

test("aborts an in-progress sitemap discovery", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/robots.txt") {
      response.end("User-agent: *");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("scan deadline reached")),
    30
  );

  try {
    await assert.rejects(
      discoverSite(
        `http://127.0.0.1:${port}/`,
        undefined,
        undefined,
        { signal: controller.signal }
      ),
      /scan deadline reached/
    );
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("canonicalizes page URLs with a trailing slash and slash aliases", () => {
  assert.equal(
    canonicalizePageUrl("https://openai.com/index/hugging-face-incident-and-the-road-ahead"),
    "https://openai.com/index/hugging-face-incident-and-the-road-ahead/"
  );
  assert.equal(
    canonicalizePageUrl("https://openai.com/index/hugging-face-incident-and-the-road-ahead/"),
    "https://openai.com/index/hugging-face-incident-and-the-road-ahead/"
  );
  assert.equal(canonicalizePageUrl("https://openai.com/report.pdf"), "https://openai.com/report.pdf");
  assert.deepEqual(
    pageUrlAliases("https://openai.com/index/foo").sort(),
    [
      "https://openai.com/index/foo",
      "https://openai.com/index/foo/",
    ].sort()
  );
});
