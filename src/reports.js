const { createAlertReport } = require("./db");
const { getPublicBaseUrl } = require("./events");
const { fallbackTitle } = require("./discord");

function reportUrl(id) {
  return `${getPublicBaseUrl()}/reports/${encodeURIComponent(id)}`;
}

function saveReport(kind, title, subtitle, items) {
  const id = createAlertReport(kind, title, { subtitle, items });
  return { id, url: reportUrl(id) };
}

function saveWebsitePagesReport(site, urls, titles = new Map(), sources = new Map()) {
  const name = site.nickname || site.hostname;
  return saveReport(
    "pages",
    `${name} · new pages`,
    `${urls.length} pages discovered on ${site.hostname}`,
    urls.map((url) => ({
      label: titles.get(url) || fallbackTitle(url),
      value: url,
      url,
      meta: sources.get(url) || "discovery",
    }))
  );
}

function saveSubdomainsReport(site, entries) {
  const name = site.nickname || site.hostname;
  return saveReport(
    "subdomains",
    `${name} · new subdomains`,
    `${entries.length} certificate subdomains discovered for ${site.hostname}`,
    entries.map((entry) => ({
      label: entry.hostname,
      value: entry.hostname,
      url: `https://${entry.hostname}/`,
      meta: [entry.source, entry.dnsStatus].filter(Boolean).join(" · "),
    }))
  );
}

function saveGithubReport(target, items) {
  const targetName =
    target.kind === "repo"
      ? `github.com/${target.owner}/${target.repo}`
      : `github.com/${target.owner}`;
  return saveReport(
    "github",
    `${targetName} · new ${target.kind === "repo" ? "commits" : "repositories"}`,
    `${items.length} GitHub updates discovered`,
    items.map((item) => ({
      label: item.title,
      value: item.description || item.author || "",
      url: item.url,
      meta: [item.kind, item.author].filter(Boolean).join(" · "),
    }))
  );
}

function saveBinanceReport(event) {
  return saveReport(
    "binance",
    `${event.namespace} · Binance UI changes`,
    `${event.changes.length} extracted translation changes`,
    event.changes.map((change) => ({
      type: change.type,
      label: change.key,
      oldValue: change.oldValue,
      newValue: change.newValue,
    }))
  );
}

module.exports = {
  reportUrl,
  saveBinanceReport,
  saveGithubReport,
  saveSubdomainsReport,
  saveWebsitePagesReport,
};
