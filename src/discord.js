const { getBinanceNamespaceUrl } = require("./binance");

const EMBED_RED = 0xef4444;
const GITHUB_PURPLE = 0x6e40c9;
const BINANCE_GREEN = 0x2ebd85;
const BINANCE_AMBER = 0xf0b90b;
const BINANCE_RED = 0xef4444;
const PUMP_GREEN = 0x86efac;
const CT_BLUE = 0x38bdf8;
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

function buildSubdomainPayload(_site, entries, _scanDurationMs = 0, now = new Date()) {
  const shown = entries.slice(0, MAX_VISIBLE_URLS);
  const extra = entries.length - shown.length;
  return {
    username: "the watcher",
    allowed_mentions: { parse: [] },
    content: extra > 0 ? `+${extra} more subdomains were discovered.` : undefined,
    embeds: shown.map((entry) => ({
      color: CT_BLUE,
      title: entry.hostname,
      url: `https://${entry.hostname}/`,
      footer: { text: "NEW SUBDOMAIN" },
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

function formatBinanceValue(value, limit = 120) {
  const text = String(value ?? "")
    .replace(/```/g, "'''")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatBinanceChanges(changes) {
  const counts = { added: 0, changed: 0, removed: 0 };
  const lines = [];
  for (const change of changes) {
    counts[change.type]++;
    if (lines.join("\n").length >= 700) continue;
    if (change.type === "added") {
      lines.push(`+ ${change.key} = ${formatBinanceValue(change.newValue)}`);
    } else if (change.type === "removed") {
      lines.push(`- ${change.key}`);
    } else {
      lines.push(
        `! ${change.key}: ${formatBinanceValue(change.oldValue, 55)} → ${formatBinanceValue(change.newValue, 55)}`
      );
    }
  }

  const shown = lines.length;
  const summary = `+${counts.added} added · ~${counts.changed} changed · -${counts.removed} removed`;
  const remainder =
    changes.length > shown ? `\n… ${changes.length - shown} more changes` : "";
  return `${summary}\n\`\`\`diff\n${lines.join("\n")}${remainder}\n\`\`\``;
}

function buildBinancePayload(events, scanDurationMs, now = new Date()) {
  return {
    username: "the watcher",
    allowed_mentions: { parse: [] },
    embeds: events.map((event) => {
      const types = new Set(event.changes.map((change) => change.type));
      const color =
        types.size === 1 && types.has("added")
          ? BINANCE_GREEN
          : types.size === 1 && types.has("removed")
            ? BINANCE_RED
            : BINANCE_AMBER;
      return {
        color,
        author: { name: "binance.com UI" },
        title: `${event.namespace} updated`,
        url: getBinanceNamespaceUrl(event.namespace),
        description: formatBinanceChanges(event.changes),
        footer: {
          text: `BINANCE UI · i18n · ${scanDurationMs}ms`,
        },
        timestamp: now.toISOString(),
      };
    }),
  };
}

function formatPumpValue(value, limit = 100) {
  const text = String(value || "")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function buildPumpPayload(update, scanDurationMs, now = new Date()) {
  const grouped = {
    added: { asset: [], host: [], route: [], text: [] },
    removed: { asset: [], host: [], route: [], text: [] },
  };
  for (const change of update.changes) {
    grouped[change.type]?.[change.category]?.push(change.value);
  }

  const sections = [];
  const addSection = (title, values, limit = 8) => {
    if (!values.length) return;
    const shown = values.slice(0, limit).map((value) => `+ ${formatPumpValue(value)}`);
    if (values.length > shown.length) shown.push(`… ${values.length - shown.length} more`);
    sections.push(`**${title}**\n\`\`\`diff\n${shown.join("\n")}\n\`\`\``);
  };
  addSection("New endpoints", grouped.added.host);
  addSection("New routes", grouped.added.route);
  addSection("New UI text", grouped.added.text, 6);

  const addedAssets = grouped.added.asset.length;
  const removedAssets = grouped.removed.asset.length;
  const removedSignals =
    grouped.removed.host.length +
    grouped.removed.route.length +
    grouped.removed.text.length;
  const summary = [
    `${update.changes.length} extracted changes`,
    `${addedAssets} assets added`,
    `${removedAssets} assets removed`,
    `${removedSignals} readable signals removed`,
  ].join(" · ");
  if (!sections.length) {
    sections.push("Bundle changed; no new readable endpoint, route, or UI text was extracted.");
  }

  return {
    username: "the watcher",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        color: PUMP_GREEN,
        author: { name: "pump.fun app" },
        title: `New app update · ${update.runtimeVersion}`,
        url: "https://u.expo.dev/660d9cc8-3cc2-4269-8845-7be9bbed752b",
        description: `${summary}\n\n${sections.join("\n").slice(0, 3500)}`,
        fields: [
          { name: "Update", value: update.updateId, inline: false },
          {
            name: "Published",
            value: update.publishedAt || "unknown",
            inline: false,
          },
        ],
        footer: { text: `PUMP APP · expo · ${scanDurationMs}ms` },
        timestamp: now.toISOString(),
      },
    ],
  };
}

module.exports = {
  buildDiscordPayload,
  buildGitHubPayload,
  buildBinancePayload,
  buildPumpPayload,
  buildSubdomainPayload,
  displayUrl,
  fallbackTitle,
  formatBinanceChanges,
};
