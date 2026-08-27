const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagepulse-websites-"));
process.env.DATA_DIR = directory;
const { db, statements } = require("../src/db");
const http = require("node:http");
const {
  collectHtmlLinksSource,
  parseRssItems,
  parseSpaceXUpdates,
  pagesFromUrlset,
} = require("../src/website-feeds");
const {
  BNB_SITEMAPS,
  WEBSITE_PLAYBOOKS,
  WHITEHOUSE_RSS,
  WHITEHOUSE_SITEMAPS,
  getPlaybook,
} = require("../src/websites");
const { syncWebsitePlaybooks } = require("../src/website-scanner");

test.after(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("registers the hardcoded website playbooks", () => {
  assert.deepEqual(
    WEBSITE_PLAYBOOKS.map((playbook) => playbook.hostname),
    [
      "openai.com",
      "spacex.com",
      "bnbchain.org",
      "whitehouse.gov",
      "grok.com",
      "x.ai",
      "pump.fun",
      "solana.com",
      "anthropic.com",
      "claude.com",
    ]
  );
  assert.equal(getPlaybook("www.openai.com")?.key, "openai");
  assert.equal(getPlaybook("missing.test"), null);
});

test("parses SpaceX CMS updates into unique update URLs", () => {
  assert.deepEqual(
    parseSpaceXUpdates([
      { updateId: "terafab", title: "Breaking Ground on Terafab in Texas", link: null },
      { updateId: "terafab", title: "Duplicate", link: null },
      { updateId: "xai-joins-spacex", title: "xAI joins SpaceX", link: "https://www.spacex.com/updates/" },
      { title: "Missing id" },
    ]),
    [
      {
        url: "https://www.spacex.com/updates/terafab/",
        title: "Breaking Ground on Terafab in Texas",
        source: "cms",
      },
      {
        url: "https://www.spacex.com/updates/",
        title: "xAI joins SpaceX",
        source: "cms",
      },
    ]
  );
});

test("parses RSS and sitemap locs for the allowed host only", () => {
  const items = parseRssItems(
    `<rss><channel>
      <item><title>Hello</title><link>https://solana.com/news/hello</link></item>
      <item><title>Skip</title><link>https://example.com/news/nope</link></item>
    </channel></rss>`,
    "solana.com"
  );
  assert.deepEqual(items, [
    { url: "https://solana.com/news/hello/", title: "Hello", source: "rss" },
  ]);

  const pages = pagesFromUrlset(
    `<urlset>
      <url><loc>https://www.anthropic.com/news/new-model</loc></url>
      <url><loc>https://www.anthropic.com/sitemap.xml</loc></url>
      <url><loc>https://example.com/elsewhere</loc></url>
    </urlset>`,
    "anthropic.com"
  );
  assert.deepEqual(pages, [
    { url: "https://www.anthropic.com/news/new-model/", title: "", source: "sitemap" },
  ]);
});

test("hardcodes White House RSS and content sitemaps only", () => {
  assert.deepEqual(
    WHITEHOUSE_RSS.map((entry) => entry[0]),
    ["rss:news", "rss:articles", "rss:actions", "rss:briefings", "rss:fact-sheets", "rss:remarks"]
  );
  assert.deepEqual(
    WHITEHOUSE_SITEMAPS.map((entry) => entry[1]),
    [
      "https://www.whitehouse.gov/post-sitemap.xml",
      "https://www.whitehouse.gov/post-sitemap2.xml",
      "https://www.whitehouse.gov/post-sitemap3.xml",
      "https://www.whitehouse.gov/page-sitemap.xml",
    ]
  );
  assert.ok(BNB_SITEMAPS.some((entry) => entry[1].includes("/en/blog/sitemap.xml")));
});

test("collects listing-page links for the matching path", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`
      <a href="/news/new-model">New</a>
      <a href="/about">Ignore</a>
      <a href="https://example.com/news/nope">External</a>
    `);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = new URL(String(input.url || input));
    const response = await originalFetch(`http://127.0.0.1:${port}${url.pathname}`);
    return response;
  };
  try {
    const result = await collectHtmlLinksSource(
      "news-html",
      "https://x.ai/news",
      { allowedRoot: "x.ai", pathIncludes: "/news/" }
    );
    assert.equal(result.error, null);
    assert.deepEqual(
      result.pages.map((page) => page.url),
      ["https://x.ai/news/new-model/"]
    );
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("syncs playbooks into sqlite and disables unknown sites", () => {
  statements.addSite.run("https://example.com/", "example.com", "Example");
  syncWebsitePlaybooks();
  const sites = statements.listSites.all();
  assert.equal(sites.filter((site) => site.hostname === "openai.com").length, 1);
  assert.equal(sites.find((site) => site.hostname === "solana.com")?.ignore_locales, 1);
  assert.equal(sites.find((site) => site.hostname === "example.com")?.enabled, 0);
  assert.equal(sites.find((site) => site.hostname === "spacex.com")?.url, "https://www.spacex.com/");
});
