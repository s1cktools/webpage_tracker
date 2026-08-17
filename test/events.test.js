const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildBinanceUiEvent,
  buildGithubEvent,
  buildWebsitePageEvent,
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
    detectedAt
  );

  assertEnvelope(event, "website_page");
  assert.deepEqual(event.data, {
    website_name: "OpenAI",
    hostname: "openai.com",
    title: "Introducing GPT-6",
    url: "https://openai.com/gpt-6",
    discovery_source: "sitemap",
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
    detectedAt
  );
  assertEnvelope(commit, "github_commit");
  assert.equal(commit.data.commit_sha, "abc123");
  assert.equal(commit.data.committed_at, "2026-08-17T13:30:00.000Z");

  const repository = buildGithubEvent(
    { owner: "openai", repo: null },
    {
      kind: "repository",
      title: "new-project",
      description: "New project",
      url: "https://github.com/openai/new-project",
      createdAt: "2026-08-17T13:31:00.000Z",
    },
    detectedAt
  );
  assertEnvelope(repository, "github_repository");
  assert.equal(repository.data.repository, "new-project");
  assert.equal(repository.data.created_at, "2026-08-17T13:31:00.000Z");
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
    detectedAt
  );

  assertEnvelope(event, "binance_ui");
  assert.deepEqual(event.data.changes[0], {
    change_type: "added",
    key: "new-title",
    new_value: "New title",
  });
  assert.equal(event.data.locale, "en");
});
