const { randomUUID } = require("node:crypto");
const { BINANCE_UI_BASE } = require("./binance");

function createEvent(eventType, data, detectedAt = new Date()) {
  return {
    event_id: randomUUID(),
    event_type: eventType,
    detected_at: new Date(detectedAt).toISOString(),
    data,
  };
}

function buildWebsitePageEvent(site, url, title, discoverySource, detectedAt) {
  return createEvent(
    "website_page",
    {
      website_name: site.nickname || site.hostname,
      hostname: site.hostname,
      title,
      url,
      discovery_source: discoverySource || "discovery",
    },
    detectedAt
  );
}

function buildGithubEvent(target, item, detectedAt = new Date()) {
  if (item.kind === "commit") {
    return createEvent(
      "github_commit",
      {
        owner: target.owner,
        repository: target.repo,
        commit_sha: item.externalId,
        title: item.title,
        author: item.author,
        url: item.url,
        committed_at: item.committedAt || new Date(detectedAt).toISOString(),
      },
      detectedAt
    );
  }

  return createEvent(
    "github_repository",
    {
      owner: target.owner,
      repository: item.title,
      description: item.description || "",
      url: item.url,
      created_at: item.createdAt || new Date(detectedAt).toISOString(),
    },
    detectedAt
  );
}

function buildBinanceUiEvent(namespace, changes, detectedAt) {
  return createEvent(
    "binance_ui",
    {
      namespace,
      locale: "en",
      url: `${BINANCE_UI_BASE}/${encodeURIComponent(namespace)}`,
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
    detectedAt
  );
}

function buildAnsemCoinEvent(coin, detectedAt = new Date()) {
  return createEvent(
    "ansem_coin",
    {
      name: coin.name,
      ticker: coin.ticker,
      slug: coin.slug,
      contract_address: coin.mint,
      creator_wallet: coin.creatorWallet,
      status: coin.status,
      created_at: coin.createdAt,
      url: "https://ansem.io/",
    },
    detectedAt
  );
}

module.exports = {
  buildAnsemCoinEvent,
  buildBinanceUiEvent,
  buildGithubEvent,
  buildWebsitePageEvent,
  createEvent,
};
