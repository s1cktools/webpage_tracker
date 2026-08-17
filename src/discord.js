const EMBED_RED = 0xef4444;
const GITHUB_PURPLE = 0x6e40c9;
const MAX_VISIBLE_URLS = 10;

function displayUrl(rawUrl, siteHostname) {
  const url = new URL(rawUrl);
  const path = `${url.pathname}${url.search}` || "/";
  return url.hostname === siteHostname ? path : `${url.hostname}${path}`;
}

function fallbackTitle(rawUrl) {
  const url = new URL(rawUrl);
  const segment = url.pathname.split("/").filter(Boolean).at(-1);
  if (!segment) return url.hostname;

  const acronyms = new Set(["ai", "api", "gpt", "pdf", "rss"]);
  const smallWords = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "the", "to"]);
  return decodeURIComponent(segment)
    .replace(/\.[a-z\d]+$/i, "")
    .split(/[-_]+/)
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (acronyms.has(lower)) return lower.toUpperCase();
      if (index > 0 && smallWords.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function buildDiscordPayload(
  site,
  urls,
  now = new Date(),
  titles = new Map(),
  sources = new Map(),
  scanDurationMs = 0
) {
  const shown = urls.slice(0, MAX_VISIBLE_URLS);
  const extra = urls.length - shown.length;

  return {
    username: "the watcher",
    allowed_mentions: { parse: [] },
    content: extra > 0 ? `+${extra} more new pages were discovered.` : undefined,
    embeds: shown.map((url) => ({
      color: EMBED_RED,
      author: { name: site.hostname },
      title: titles.get(url) || fallbackTitle(url),
      url,
      description: url,
      footer: {
        text: `NEW PAGE · ${sources.get(url) || "discovery"} · ${scanDurationMs}ms`,
      },
      timestamp: now.toISOString(),
    })),
  };
}

function buildGitHubPayload(target, items, scanDurationMs, now = new Date()) {
  const shown = items.slice(0, MAX_VISIBLE_URLS);
  const extra = items.length - shown.length;
  const targetName =
    target.kind === "repo"
      ? `github.com/${target.owner}/${target.repo}`
      : `github.com/${target.owner}`;

  return {
    username: "the watcher",
    allowed_mentions: { parse: [] },
    content: extra > 0 ? `+${extra} more GitHub updates were discovered.` : undefined,
    embeds: shown.map((item) => {
      const details =
        item.kind === "commit" && item.author
          ? `${item.url}\n\nby ${item.author}`
          : [item.url, item.description].filter(Boolean).join("\n\n");
      return {
        color: GITHUB_PURPLE,
        author: { name: targetName },
        title: item.title,
        url: item.url,
        description: details,
        footer: {
          text: `${item.kind === "commit" ? "NEW COMMIT" : "NEW REPO"} · github · ${scanDurationMs}ms`,
        },
        timestamp: now.toISOString(),
      };
    }),
  };
}

module.exports = {
  buildDiscordPayload,
  buildGitHubPayload,
  displayUrl,
  fallbackTitle,
};
