const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fetchGitHubTarget,
  GitHubApiError,
  normalizeItems,
  parseGitHubTarget,
  targetEndpoint,
} = require("../src/github");

test("parses GitHub users and repository URLs", () => {
  assert.deepEqual(parseGitHubTarget("@openai"), {
    kind: "user",
    owner: "openai",
    repo: null,
    targetKey: "openai",
  });
  assert.deepEqual(parseGitHubTarget("https://github.com/OpenAI/codex.git"), {
    kind: "repo",
    owner: "OpenAI",
    repo: "codex",
    targetKey: "openai/codex",
  });
});

test("rejects non-GitHub URLs and invalid targets", () => {
  assert.throws(() => parseGitHubTarget("https://example.com/user/repo"), /github\.com/);
  assert.throws(() => parseGitHubTarget("owner/repo/extra"), /owner\/repository/);
});

test("builds stable endpoints for each target type", () => {
  assert.equal(
    targetEndpoint({ kind: "repo", owner: "openai", repo: "codex" }),
    "/repos/openai/codex/commits?per_page=100"
  );
  assert.equal(
    targetEndpoint({ kind: "user", owner: "openai" }),
    "/users/openai/repos?type=owner&sort=created&direction=desc&per_page=100"
  );
});

test("normalizes commits and repositories", () => {
  assert.deepEqual(
    normalizeItems(
      { kind: "repo" },
      [{
        sha: "abc123",
        html_url: "https://github.com/openai/codex/commit/abc123",
        author: { login: "octocat" },
        commit: {
          message: "Add monitor\n\nDetails",
          committer: { date: "2026-08-17T13:30:00.000Z" },
        },
      }]
    ),
    [{
      externalId: "abc123",
      kind: "commit",
      title: "Add monitor",
      url: "https://github.com/openai/codex/commit/abc123",
      author: "octocat",
      committedAt: "2026-08-17T13:30:00.000Z",
    }]
  );

  assert.equal(
    normalizeItems(
      { kind: "user" },
      [{ id: 42, name: "new-repo", html_url: "https://github.com/openai/new-repo", description: null }]
    )[0].externalId,
    "42"
  );
});

test("uses ETags and accepts unchanged responses", async (context) => {
  let request;
  context.mock.method(global, "fetch", async (url, options) => {
    request = { url, options };
    return new Response(null, {
      status: 304,
      headers: {
        etag: '"saved"',
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": "1786959999",
      },
    });
  });

  const result = await fetchGitHubTarget(
    { kind: "repo", owner: "openai", repo: "codex", etag: '"saved"' },
    "test-token"
  );
  assert.equal(request.options.headers["if-none-match"], '"saved"');
  assert.equal(request.options.headers.authorization, "Bearer test-token");
  assert.equal(result.unchanged, true);
  assert.equal(result.rateLimit.remaining, 4999);
});

test("exposes rate-limit details from GitHub errors", async (context) => {
  context.mock.method(global, "fetch", async () =>
    new Response(JSON.stringify({ message: "secondary rate limit" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "30" },
    })
  );

  await assert.rejects(
    fetchGitHubTarget(
      { kind: "user", owner: "openai", repo: null, etag: null },
      "test-token"
    ),
    (error) =>
      error instanceof GitHubApiError &&
      error.status === 429 &&
      error.retryAfter === 30
  );
});
