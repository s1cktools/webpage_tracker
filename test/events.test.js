const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildBinanceUiEvent,
  buildGithubEvent,
  buildPumpAppUpdateEvent,
  buildWebsitePageEvent,
  buildWebsiteSubdomainEvent,
} = require("../src/events");

const detectedAt = new Date("2026-08-17T13:33:04.215Z");

function assertEnvelope(event, eventType) {
  assert.match(
    event.event_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  assert.equal(event.event_type, eventType);
  assert.equal(event.detected_at, detectedAt.toISOString());
  assert.deepEqual(Object.keys(event).sort(), [
    "data",
    "detected_at",
    "event_id",
    "event_type",
  ]);
}

test("builds a minimal website page event", () => {
  const event = buildWebsitePageEvent(
    { nickname: "OpenAI", hostname: "openai.com" },
    "https://openai.com/gpt-6",
    "Introducing GPT-6",
    "sitemap",
    detectedAt,
    "https://tracker.example/reports/pages",
    12
  );

  assertEnvelope(event, "website_page");
  assert.deepEqual(event.data, {
    website_name: "OpenAI",
    hostname: "openai.com",
    title: "Introducing GPT-6",
    summary: "12 new pages discovered on openai.com",
    report_url: "https://tracker.example/reports/pages",
    item_count: 12,
    url: "https://openai.com/gpt-6",
    discovery_source: "sitemap",
  });
});

test("builds a certificate subdomain event", () => {
  const event = buildWebsiteSubdomainEvent(
    { nickname: "SpaceX", hostname: "spacex.com" },
    {
      hostname: "auth.spacex.com",
      source: "certspotter",
      dnsStatus: "unchecked",
      wildcard: false,
    },
    detectedAt,
    "https://tracker.example/reports/subdomains",
    3
  );
  assertEnvelope(event, "website_subdomain");
  assert.deepEqual(event.data, {
    website_name: "SpaceX",
    root_hostname: "spacex.com",
    hostname: "auth.spacex.com",
    title: "auth.spacex.com",
    summary: "3 new subdomains discovered for spacex.com",
    report_url: "https://tracker.example/reports/subdomains",
    item_count: 3,
    discovery_source: "certspotter",
    dns_status: "unchecked",
    wildcard_observation: false,
  });
});

test("builds GitHub commit and repository events", () => {
  const commit = buildGithubEvent(
    { owner: "openai", repo: "codex" },
    {
      kind: "commit",
      externalId: "abc123",
      title: "Add monitoring",
      author: "octocat",
      url: "https://github.com/openai/codex/commit/abc123",
      committedAt: "2026-08-17T13:30:00.000Z",
    },
    detectedAt,
    "https://tracker.example/reports/github",
    4
  );
  assertEnvelope(commit, "github_commit");
  assert.equal(commit.data.commit_sha, "abc123");
  assert.equal(commit.data.committed_at, "2026-08-17T13:30:00.000Z");
  assert.equal(commit.data.report_url, "https://tracker.example/reports/github");
  assert.equal(commit.data.item_count, 4);

  const repository = buildGithubEvent(
    { owner: "openai", repo: null },
    {
      kind: "repository",
      title: "new-project",
      description: "New project",
      url: "https://github.com/openai/new-project",
      createdAt: "2026-08-17T13:31:00.000Z",
    },
    detectedAt,
    "https://tracker.example/reports/github-repos",
    2
  );
  assertEnvelope(repository, "github_repository");
  assert.equal(repository.data.repository, "new-project");
  assert.equal(repository.data.created_at, "2026-08-17T13:31:00.000Z");
  assert.equal(repository.data.title, "new-project");
  assert.equal(repository.data.item_count, 2);
});

test("builds a snake_case Binance UI event", () => {
  const event = buildBinanceUiEvent(
    "activity-ui",
    [
      { type: "added", key: "new-title", newValue: "New title" },
      {
        type: "changed",
        key: "description",
        oldValue: "Before",
        newValue: "After",
      },
      { type: "removed", key: "old-title", oldValue: "Old title" },
    ],
    detectedAt,
    "https://tracker.example/reports/binance"
  );

  assertEnvelope(event, "binance_ui");
  assert.deepEqual(event.data.changes[0], {
    change_type: "added",
    key: "new-title",
    new_value: "New title",
  });
  assert.equal(event.data.locale, "en");
  assert.equal(event.data.report_url, "https://tracker.example/reports/binance");
  assert.equal(event.data.item_count, 3);
});

test("builds a bounded snake_case Pump app update event", () => {
  const event = buildPumpAppUpdateEvent(
    {
      updateId: "new-update",
      previousUpdateId: "old-update",
      runtimeVersion: "26.0.0",
      publishedAt: "2026-08-18T08:00:00.000Z",
      launchHash: "launch-hash",
      changes: [
        { type: "added", category: "route", value: "/bounty/create" },
      ],
    },
    detectedAt
  );

  assertEnvelope(event, "pump_app_update");
  assert.equal(event.data.package_name, "com.batonresearch.pump");
  assert.equal(event.data.runtime_version, "26.0.0");
  assert.equal(event.data.previous_update_id, "old-update");
  assert.match(event.data.url, /\/pump\/updates\/new-update$/);
  assert.equal(event.data.report_url, event.data.url);
  assert.equal(event.data.item_count, 1);
  assert.equal(event.data.change_count, 1);
  assert.deepEqual(event.data.changes[0], {
    change_type: "added",
    category: "route",
    value: "/bounty/create",
  });
});
