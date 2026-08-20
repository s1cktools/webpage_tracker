const { randomUUID } = require("node:crypto");
const { getBinanceNamespaceUrl } = require("./binance");

function createEvent(eventType, data, detectedAt = new Date()) {
  return {
    event_id: randomUUID(),
    event_type: eventType,
    detected_at: new Date(detectedAt).toISOString(),
    data,
  };
}

function getPublicBaseUrl() {
  const configured = String(process.env.WEBPAGE_TRACKER_PUBLIC_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  const railwayDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  if (railwayDomain) return `https://${railwayDomain.replace(/\/+$/, "")}`;
  return `http://localhost:${Number(process.env.PORT) || 3000}`;
}

function displayData(data, title, summary, reportUrl, itemCount) {
  return {
    ...data,
    title,
    summary,
    ...(reportUrl ? { report_url: reportUrl } : {}),
    item_count: itemCount,
  };
}

function buildWebsitePageEvent(
  site,
  url,
  title,
  discoverySource,
  detectedAt,
  reportUrl = null,
  itemCount = 1
) {
  return createEvent(
    "website_page",
    displayData(
      {
        website_name: site.nickname || site.hostname,
        hostname: site.hostname,
        url,
        discovery_source: discoverySource || "discovery",
      },
      title,
      `${itemCount} new page${itemCount === 1 ? "" : "s"} discovered on ${site.hostname}`,
      reportUrl,
      itemCount
    ),
    detectedAt
  );
}

function buildWebsiteSubdomainEvent(
  site,
  entry,
  detectedAt = new Date(),
  reportUrl = null,
  itemCount = 1
) {
  return createEvent(
    "website_subdomain",
    displayData(
      {
        website_name: site.nickname || site.hostname,
        root_hostname: site.hostname,
        hostname: entry.hostname,
        discovery_source: entry.source || "certificate_transparency",
        dns_status: entry.dnsStatus || "unchecked",
        wildcard_observation: Boolean(entry.wildcard),
      },
      entry.hostname,
      `${itemCount} new subdomain${itemCount === 1 ? "" : "s"} discovered for ${site.hostname}`,
      reportUrl,
      itemCount
    ),
    detectedAt
  );
}

function buildGithubEvent(
  target,
  item,
  detectedAt = new Date(),
  reportUrl = null,
  itemCount = 1
) {
  const targetName = target.repo ? `${target.owner}/${target.repo}` : target.owner;
  if (item.kind === "commit") {
    return createEvent(
      "github_commit",
      displayData(
        {
          owner: target.owner,
          repository: target.repo,
          commit_sha: item.externalId,
          author: item.author,
          url: item.url,
          committed_at: item.committedAt || new Date(detectedAt).toISOString(),
        },
        item.title,
        `${itemCount} new commit${itemCount === 1 ? "" : "s"} discovered for ${targetName}`,
        reportUrl,
        itemCount
      ),
      detectedAt
    );
  }

  return createEvent(
    "github_repository",
    displayData(
      {
        owner: target.owner,
        repository: item.title,
        description: item.description || "",
        url: item.url,
        created_at: item.createdAt || new Date(detectedAt).toISOString(),
      },
      item.title,
      `${itemCount} new repositor${itemCount === 1 ? "y" : "ies"} discovered for ${targetName}`,
      reportUrl,
      itemCount
    ),
    detectedAt
  );
}

function buildBinanceUiEvent(
  namespace,
  changes,
  detectedAt,
  reportUrl = null
) {
  return createEvent(
    "binance_ui",
    displayData(
      {
        namespace,
        locale: "en",
        url: getBinanceNamespaceUrl(namespace),
        changes: changes.map((change) => {
          const output = {
            change_type: change.type,
            key: change.key,
          };
          if (change.oldValue !== undefined) output.old_value = change.oldValue;
          if (change.newValue !== undefined) output.new_value = change.newValue;
          return output;
        }),
      },
      `${namespace} updated`,
      `${changes.length} Binance UI change${changes.length === 1 ? "" : "s"}`,
      reportUrl,
      changes.length
    ),
    detectedAt
  );
}

function buildPumpAppUpdateEvent(update, detectedAt) {
  const shownChanges = update.changes.slice(0, 200);
  const reportUrl = `${getPublicBaseUrl()}/pump/updates/${encodeURIComponent(update.updateId)}`;
  return createEvent(
    "pump_app_update",
    displayData(
      {
        app_name: "pump.fun",
        package_name: "com.batonresearch.pump",
        platform: "android",
        channel: "mainnet",
        runtime_version: update.runtimeVersion,
        update_id: update.updateId,
        previous_update_id: update.previousUpdateId || null,
        published_at: update.publishedAt,
        launch_asset_hash: update.launchHash,
        manifest_url:
          "https://u.expo.dev/660d9cc8-3cc2-4269-8845-7be9bbed752b",
        url: reportUrl,
        change_count: update.changes.length,
        changes_truncated: shownChanges.length < update.changes.length,
        changes: shownChanges.map((change) => ({
          change_type: change.type,
          category: change.category,
          value: change.value,
        })),
      },
      `pump.fun app update ${update.runtimeVersion}`,
      `${update.changes.length} extracted app change${update.changes.length === 1 ? "" : "s"}`,
      reportUrl,
      update.changes.length
    ),
    detectedAt
  );
}

module.exports = {
  buildBinanceUiEvent,
  buildGithubEvent,
  buildPumpAppUpdateEvent,
  buildWebsitePageEvent,
  buildWebsiteSubdomainEvent,
  createEvent,
  getPublicBaseUrl,
};
