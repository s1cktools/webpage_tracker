const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseOpenAiRss } = require("../src/openai");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagepulse-openai-"));
process.env.DATA_DIR = directory;
const { addDiscoveredUrls, db, statements } = require("../src/db");

function trackedOpenAiSiteId() {
  const existing = statements.activeSites
    .all()
    .find((row) => row.hostname === "openai.com");
  if (existing) return existing.id;
  return Number(
    statements.addSite.run("https://openai.com/", "openai.com", "OpenAI").lastInsertRowid
  );
}

test.after(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("parses OpenAI RSS items and canonicalizes links", () => {
  const items = parseOpenAiRss(`
    <rss><channel>
      <item>
        <title><![CDATA[The Hugging Face incident]]></title>
        <link>https://openai.com/index/hugging-face-incident-and-the-road-ahead</link>
        <category>Security</category>
      </item>
      <item>
        <title>Duplicate slash variant</title>
        <link>https://openai.com/index/hugging-face-incident-and-the-road-ahead/</link>
      </item>
      <item>
        <title>Ignore other hosts</title>
        <link>https://example.com/not-openai</link>
      </item>
    </channel></rss>
  `);
  assert.deepEqual(items, [
    {
      url: "https://openai.com/index/hugging-face-incident-and-the-road-ahead/",
      title: "The Hugging Face incident",
      category: "Security",
    },
  ]);
});

test("reads OpenAI category sitemap files from the index", () => {
  const { parseOpenAiSitemapIndex, childSitemapKey } = require("../src/openai");
  assert.deepEqual(
    parseOpenAiSitemapIndex(`
      <sitemapindex>
        <sitemap><loc>https://openai.com/sitemap.xml/product/</loc></sitemap>
        <sitemap><loc>https://openai.com/sitemap.xml/security/</loc></sitemap>
        <sitemap><loc>https://openai.com/sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap.xml/other/</loc></sitemap>
      </sitemapindex>
    `),
    [
      "https://openai.com/sitemap.xml/product/",
      "https://openai.com/sitemap.xml/security/",
    ]
  );
  assert.equal(childSitemapKey("https://openai.com/sitemap.xml/product/"), "product");
});

test("reads page loc values and ignores hreflang alternates", () => {
  const { parseOpenAiSitemapPages } = require("../src/openai");
  assert.deepEqual(
    parseOpenAiSitemapPages(`
      <urlset xmlns:xhtml="http://www.w3.org/1999/xhtml">
        <url>
          <loc>https://openai.com/index/new-model</loc>
          <xhtml:link rel="alternate" hreflang="es-419" href="https://openai.com/es-419/index/new-model/"/>
          <xhtml:link rel="alternate" hreflang="fr-FR" href="https://openai.com/fr-FR/index/new-model/"/>
        </url>
        <url>
          <loc>https://openai.com/index/new-model/</loc>
        </url>
        <url>
          <loc>https://example.com/not-openai</loc>
        </url>
      </urlset>
    `),
    ["https://openai.com/index/new-model/"]
  );
});

test("does not alert twice for slash variants of the same page", () => {
  const siteId = trackedOpenAiSiteId();
  const first = addDiscoveredUrls(
    siteId,
    ["https://openai.com/index/teachers"],
    true
  );
  const second = addDiscoveredUrls(
    siteId,
    ["https://openai.com/index/teachers/"],
    false
  );
  assert.deepEqual(first, ["https://openai.com/index/teachers/"]);
  assert.deepEqual(second, []);
});

test("baselines each OpenAI category sitemap then treats later locs as new", async () => {
  const { getPlaybook } = require("../src/websites");
  const { scanWebsite } = require("../src/website-scanner");
  const siteId = trackedOpenAiSiteId();
  statements.setSetting.run("website_sources_openai", "");

  let productPages = ["https://openai.com/index/already-public/"];
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = new URL(String(input.url || input));
    if (url.pathname === "/sitemap.xml") {
      return new Response(
        "<sitemapindex><sitemap><loc>https://openai.com/sitemap.xml/product/</loc></sitemap></sitemapindex>",
        { status: 200 }
      );
    }
    if (url.pathname === "/sitemap.xml/product/") {
      return new Response(
        `<urlset>${productPages
          .map((page) => `<url><loc>${page}</loc></url>`)
          .join("")}</urlset>`,
        { status: 200 }
      );
    }
    return new Response("missing", { status: 404 });
  };

  try {
    await scanWebsite(getPlaybook("openai.com"));
    const afterBaseline = statements.siteUrls.all(siteId).map((row) => row.url);
    assert.ok(afterBaseline.includes("https://openai.com/index/already-public/"));
    assert.equal(statements.getSite.get(siteId).baselined, 1);
    assert.match(statements.getSetting.get("website_sources_openai")?.value || "", /sitemap:product/);

    productPages = [
      "https://openai.com/index/already-public/",
      "https://openai.com/index/brand-new/",
    ];
    await scanWebsite(getPlaybook("openai.com"));
    const urls = statements.siteUrls.all(siteId).map((row) => row.url);
    assert.ok(urls.includes("https://openai.com/index/brand-new/"));
    const live = db
      .prepare(
        "SELECT is_baseline FROM discovered_urls WHERE site_id = ? AND url = ?"
      )
      .get(siteId, "https://openai.com/index/brand-new/");
    assert.equal(live.is_baseline, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
