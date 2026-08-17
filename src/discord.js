const EMBED_RED = 0xef4444;
const MAX_VISIBLE_URLS = 10;

function markdownEscape(value) {
  return String(value).replace(/([\\`*_[\]()~>])/g, "\\$1");
}

function displayUrl(rawUrl, siteHostname) {
  const url = new URL(rawUrl);
  const path = `${url.pathname}${url.search}` || "/";
  return url.hostname === siteHostname ? path : `${url.hostname}${path}`;
}

function buildDiscordPayload(site, urls, now = new Date()) {
  const nickname = site.nickname || site.hostname;
  const single = urls.length === 1;
  const shown = urls.slice(0, MAX_VISIBLE_URLS);
  const lines = shown.map((url, index) => {
    const label = markdownEscape(displayUrl(url, site.hostname));
    return `**${String(index + 1).padStart(2, "0")}**  [${label}](<${url}>)`;
  });

  if (urls.length > shown.length) {
    lines.push(`*+${urls.length - shown.length} more URLs*`);
  }

  return {
    username: "PagePulse",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        color: EMBED_RED,
        title: single
          ? `New ${nickname} Page Detected`
          : `${urls.length} New ${nickname} Pages Detected`,
        url: single ? urls[0] : undefined,
        description: lines.join("\n"),
        footer: { text: `PagePulse • ${site.hostname}` },
        timestamp: now.toISOString(),
      },
    ],
  };
}

module.exports = { buildDiscordPayload, displayUrl };
