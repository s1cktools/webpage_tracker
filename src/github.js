const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 10_000;

class GitHubApiError extends Error {
  constructor(message, response, details = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = response?.status || 0;
    this.retryAfter = Number(response?.headers.get("retry-after")) || 0;
    const remaining = response?.headers.get("x-ratelimit-remaining");
    this.rateLimitRemaining = remaining === null ? null : Number(remaining);
    this.rateLimitReset = Number(response?.headers.get("x-ratelimit-reset")) || 0;
    this.details = details;
  }
}

function numericHeader(response, name) {
  const value = response.headers.get(name);
  return value === null ? null : Number(value);
}

function parseGitHubTarget(value) {
  let raw = String(value || "").trim();
  if (!raw) throw new Error("Enter a GitHub username or repository.");

  raw = raw.replace(/^@/, "").replace(/^git@github\.com:/i, "");
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) {
      throw new Error("Only github.com URLs are supported.");
    }
    raw = url.pathname;
  } else {
    raw = raw.replace(/^(?:www\.)?github\.com\//i, "");
  }

  const parts = raw
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 1 || parts.length > 2) {
    throw new Error("Use a GitHub username or owner/repository.");
  }

  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/i, "") || null;
  if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(owner)) {
    throw new Error("Invalid GitHub username.");
  }
  if (repo && !/^[a-z\d._-]{1,100}$/i.test(repo)) {
    throw new Error("Invalid GitHub repository name.");
  }

  const kind = repo ? "repo" : "user";
  const targetKey = repo
    ? `${owner.toLowerCase()}/${repo.toLowerCase()}`
    : owner.toLowerCase();
  return { kind, owner, repo, targetKey };
}

function targetEndpoint(target) {
  if (target.kind === "repo") {
    return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits?per_page=100`;
  }
  return `/users/${encodeURIComponent(target.owner)}/repos?type=owner&sort=created&direction=desc&per_page=100`;
}

function normalizeItems(target, data) {
  if (target.kind === "repo") {
    return data.map((commit) => ({
      externalId: commit.sha,
      kind: "commit",
      title: String(commit.commit?.message || commit.sha).split(/\r?\n/, 1)[0].slice(0, 256),
      url: commit.html_url,
      author: commit.author?.login || commit.commit?.author?.name || "unknown",
    }));
  }

  return data.map((repo) => ({
    externalId: String(repo.id),
    kind: "repository",
    title: repo.name,
    url: repo.html_url,
    description: repo.description || "",
  }));
}

async function fetchGitHubTarget(target, token = process.env.GITHUB_TOKEN) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is not configured.");
  }

  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "the-watcher/1.0",
    "x-github-api-version": "2022-11-28",
  };
  if (target.etag) headers["if-none-match"] = target.etag;

  const response = await fetch(`${GITHUB_API}${targetEndpoint(target)}`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const rateLimit = {
    remaining: numericHeader(response, "x-ratelimit-remaining"),
    reset: numericHeader(response, "x-ratelimit-reset") || 0,
  };
  if (response.status === 304) {
    return { unchanged: true, etag: target.etag, items: [], rateLimit };
  }
  if (response.status === 409 && target.kind === "repo") {
    return {
      unchanged: false,
      etag: response.headers.get("etag") || target.etag,
      items: [],
      rateLimit,
    };
  }
  if (!response.ok) {
    let details = {};
    try {
      details = await response.json();
    } catch {}
    throw new GitHubApiError(
      details.message || `GitHub returned ${response.status}`,
      response,
      details
    );
  }

  const data = await response.json();
  return {
    unchanged: false,
    etag: response.headers.get("etag") || target.etag,
    items: normalizeItems(target, data),
    rateLimit,
  };
}

module.exports = {
  GitHubApiError,
  fetchGitHubTarget,
  normalizeItems,
  parseGitHubTarget,
  targetEndpoint,
};
