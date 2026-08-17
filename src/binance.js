const BINANCE_UI_BASE = "https://bin.bnbstatic.com/api/i18n/-/web/cms/en";
const REQUEST_TIMEOUT_MS = 10_000;

const BINANCE_UI_NAMESPACES = [
  "accounts-ui",
  "activity-ui",
  "BioSecMiniprogram",
  "binance-chat",
  "c2c-ui",
  "cftoken-ui",
  "com-exchange-hub",
  "com-widget",
  "earn-btcy-ui",
  "earn-common",
  "earn-sol-ui",
  "earn-ui",
  "exchange-airdrop-ui",
  "exchange-deposit-withdraw-status-page-ui",
  "exchange-ocbs",
  "exchange-officialVerification-page-ui",
  "exchange-wallet",
  "fiat-components",
  "fiat-landing",
  "growth-game-ui",
  "kyc-errorCode",
  "lending-ui",
  "megadrop",
  "Navigation",
  "new2fa",
  "oauth",
  "proof-ui",
  "stock_landing_page",
  "support-center",
  "universal",
  "widget-common",
];

function valueText(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function diffObjects(previous, current) {
  const changes = [];
  const previousKeys = new Set(Object.keys(previous));
  const currentKeys = new Set(Object.keys(current));

  for (const key of [...currentKeys].sort()) {
    const newValue = valueText(current[key]);
    if (!previousKeys.has(key)) {
      changes.push({ type: "added", key, newValue });
    } else {
      const oldValue = valueText(previous[key]);
      if (oldValue !== newValue) {
        changes.push({ type: "changed", key, oldValue, newValue });
      }
    }
  }

  for (const key of [...previousKeys].sort()) {
    if (!currentKeys.has(key)) {
      changes.push({
        type: "removed",
        key,
        oldValue: valueText(previous[key]),
      });
    }
  }
  return changes;
}

async function fetchBinanceNamespace(namespace, etag = null) {
  const headers = {
    accept: "application/json",
    "user-agent": "the-watcher/1.0",
  };
  if (etag) headers["if-none-match"] = etag;

  const response = await fetch(
    `${BINANCE_UI_BASE}/${encodeURIComponent(namespace)}`,
    {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  if (response.status === 304) {
    return { unchanged: true, etag, data: null };
  }
  if (!response.ok) {
    throw new Error(`Binance returned ${response.status} for ${namespace}`);
  }

  const data = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Binance returned invalid JSON for ${namespace}`);
  }
  return {
    unchanged: false,
    etag: response.headers.get("etag") || etag,
    data,
  };
}

module.exports = {
  BINANCE_UI_BASE,
  BINANCE_UI_NAMESPACES,
  diffObjects,
  fetchBinanceNamespace,
  valueText,
};
