const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildBinancePayload,
  buildDiscordPayload,
  buildGitHubPayload,
  buildSubdomainPayload,
} = require("../src/discord");

const site = {
  hostname: "openai.com",
  nickname: "OpenAI",
};
const now = new Date("2026-08-17T09:20:00.000Z");

test("builds a clean single-page embed with its full URL", () => {
  const payload = buildDiscordPayload(
    site,
    ["https://openai.com/research/gpt-6"],
    now
  );

  assert.equal(payload.embeds[0].author.name, "openai.com");
  assert.equal(payload.embeds[0].title, "GPT 6");
  assert.equal(payload.embeds[0].url, "https://openai.com/research/gpt-6");
  assert.equal(payload.embeds[0].description, "https://openai.com/research/gpt-6");
  assert.equal(payload.username, "the watcher");
  assert.equal(payload.embeds[0].footer.text, "NEW PAGE · discovery · 0ms");
});

test("builds a capped multi-page embed", () => {
  const urls = Array.from(
    { length: 12 },
    (_, index) => `https://openai.com/page-${index + 1}`
  );
  const payload = buildDiscordPayload(site, urls, now);

  assert.equal(payload.embeds.length, 10);
  assert.equal(payload.content, "+2 more new pages were discovered.");
  assert.equal(payload.embeds[9].title, "Page 10");
});

test("links page, subdomain, and GitHub overflow to exact reports", () => {
  const reportUrl = "https://tracker.example/reports/report-123";
  const urls = Array.from(
    { length: 12 },
    (_, index) => `https://openai.com/page-${index + 1}`
  );
  const pagePayload = buildDiscordPayload(
    site,
    urls,
    now,
    new Map(),
    new Map(),
    0,
    reportUrl
  );
  assert.match(pagePayload.content, /View all 12/);
  assert.match(pagePayload.content, /report-123/);

  const entries = urls.map((_, index) => ({
    hostname: `sub-${index}.openai.com`,
  }));
  const subdomainPayload = buildSubdomainPayload(site, entries, 0, now, reportUrl);
  assert.match(subdomainPayload.content, /View all 12/);

  const items = urls.map((url, index) => ({
    kind: "commit",
    title: `Commit ${index}`,
    url,
  }));
  const githubPayload = buildGitHubPayload(
    { kind: "repo", owner: "openai", repo: "codex" },
    items,
    0,
    now,
    reportUrl
  );
  assert.match(githubPayload.content, /View all 12/);
});

test("uses fetched titles for new page labels", () => {
  const url = "https://openai.com/research/gpt-6";
  const titles = new Map([[url, "Introducing GPT-6"]]);
  const sources = new Map([[url, "sitemap"]]);
  const payload = buildDiscordPayload(site, [url], now, titles, sources, 3821);

  assert.equal(payload.embeds[0].title, "Introducing GPT-6");
  assert.equal(payload.embeds[0].footer.text, "NEW PAGE · sitemap · 3821ms");
});

test("builds GitHub commit embeds", () => {
  const payload = buildGitHubPayload(
    { kind: "repo", owner: "openai", repo: "codex" },
    [{
      kind: "commit",
      title: "Add repository monitoring",
      url: "https://github.com/openai/codex/commit/abc123",
      author: "octocat",
    }],
    42,
    now
  );

  assert.equal(payload.embeds[0].author.name, "github.com/openai/codex");
  assert.equal(payload.embeds[0].title, "Add repository monitoring");
  assert.match(payload.embeds[0].description, /by octocat/);
  assert.equal(payload.embeds[0].footer.text, "NEW COMMIT · github · 42ms");
});

test("builds certificate subdomain embeds", () => {
  const payload = buildSubdomainPayload(
    site,
    [{ hostname: "auth.openai.com", source: "certspotter", dnsStatus: "unchecked" }],
    12,
    now
  );
  assert.equal(payload.embeds[0].title, "auth.openai.com");
  assert.equal(payload.embeds[0].url, "https://auth.openai.com/");
  assert.equal(payload.embeds[0].footer.text, "NEW SUBDOMAIN");
  assert.equal(payload.embeds[0].description, undefined);
  assert.equal(payload.embeds[0].author, undefined);
});

test("links truncated Binance changes to their exact report", () => {
  const changes = Array.from({ length: 30 }, (_, index) => ({
    type: "added",
    key: `translation.key.${index}`,
    newValue: `A long translated value for item ${index}`,
  }));
  const payload = buildBinancePayload(
    [{
      namespace: "web",
      changes,
      reportUrl: "https://tracker.example/reports/binance-report",
    }],
    10,
    now
  );

  assert.match(payload.embeds[0].description, /more changes/);
  assert.match(payload.embeds[0].description, /View all 30 changes/);
  assert.match(payload.embeds[0].description, /binance-report/);
});
