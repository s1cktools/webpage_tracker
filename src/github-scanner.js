const {
  addGithubItems,
  addGithubLog,
  getSetting,
  statements,
} = require("./db");
const { buildGitHubPayload } = require("./discord");
const { fetchGitHubTarget, GitHubApiError } = require("./github");

const GITHUB_POLL_INTERVAL_MS = 5_000;
const LOG_INTERVAL_MS = 5 * 60_000;
const MAX_CONCURRENCY = 3;
const scanning = new Set();
const lastLogAt = new Map();
let blockedUntil = 0;

function logOccasionally(targetId, type, level, message) {
  const key = `${targetId}:${type}`;
  const now = Date.now();
  if (now - (lastLogAt.get(key) || 0) < LOG_INTERVAL_MS) return;
  lastLogAt.set(key, now);
  addGithubLog(targetId, level, message);
}

function applyRateLimitBackoff(error) {
  if (!(error instanceof GitHubApiError) || ![403, 429].includes(error.status)) return;
  const retryAt = error.retryAfter
    ? Date.now() + error.retryAfter * 1_000
    : error.rateLimitReset
      ? error.rateLimitReset * 1_000
      : Date.now() + 60_000;
  blockedUntil = Math.max(blockedUntil, retryAt);
}

async function sendGitHubAlert(target, items, scanDurationMs) {
  const webhookUrl = getSetting("discord_webhook_url");
  if (!webhookUrl || items.length === 0) return;

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildGitHubPayload(target, items, scanDurationMs)),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Discord webhook returned ${response.status}`);
}

async function scanGitHubTarget(targetOrId) {
  const target =
    typeof targetOrId === "object"
      ? targetOrId
      : statements.getGithubTarget.get(targetOrId);
  if (!target || scanning.has(target.id) || Date.now() < blockedUntil) return;

  scanning.add(target.id);
  const startedAt = Date.now();
  try {
    const result = await fetchGitHubTarget(target);
    if (!result.unchanged) {
      const inserted = addGithubItems(target.id, result.items, !target.baselined);
      if (target.baselined) {
        await sendGitHubAlert(target, inserted, Date.now() - startedAt);
        if (inserted.length) {
          const noun =
            target.kind === "repo"
              ? inserted.length === 1 ? "commit" : "commits"
              : inserted.length === 1 ? "repository" : "repositories";
          addGithubLog(
            target.id,
            "new",
            `${inserted.length} new ${noun}`
          );
        }
      } else {
        statements.markGithubBaselined.run(target.id);
        addGithubLog(target.id, "info", `baseline complete · ${result.items.length} items`);
      }
    }

    statements.markGithubSuccess.run(result.etag, target.id);
    logOccasionally(
      target.id,
      "heartbeat",
      "info",
      `check complete · ${Date.now() - startedAt}ms`
    );

    if (
      Number.isFinite(result.rateLimit.remaining) &&
      result.rateLimit.remaining >= 0 &&
      result.rateLimit.remaining <= 10 &&
      result.rateLimit.reset
    ) {
      blockedUntil = Math.max(blockedUntil, result.rateLimit.reset * 1_000);
      addGithubLog(target.id, "warn", "GitHub rate limit low; waiting for reset.");
    }
  } catch (error) {
    applyRateLimitBackoff(error);
    statements.markGithubError.run(String(error.message).slice(0, 500), target.id);
    logOccasionally(target.id, "error", "error", error.message);
    console.error(`[github] ${target.target_key}:`, error.message);
  } finally {
    scanning.delete(target.id);
  }
}

async function scanAllGithub() {
  if (Date.now() < blockedUntil) return;
  const targets = statements.activeGithubTargets.all();
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENCY, targets.length) },
    async () => {
      while (nextIndex < targets.length) {
        const target = targets[nextIndex++];
        await scanGitHubTarget(target);
      }
    }
  );
  await Promise.allSettled(workers);
}

function startGithubScanner() {
  scanAllGithub();
  const timer = setInterval(scanAllGithub, GITHUB_POLL_INTERVAL_MS);
  timer.unref();
}

module.exports = {
  GITHUB_POLL_INTERVAL_MS,
  scanAllGithub,
  scanGitHubTarget,
  startGithubScanner,
};
