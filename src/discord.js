const EMBED_RED = 0xef4444;
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

module.exports = { buildDiscordPayload, displayUrl, fallbackTitle };
