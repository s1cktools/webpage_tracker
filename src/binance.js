const BINANCE_UI_BASE = "https://bin.bnbstatic.com/api/i18n/-/web/cms/en";
const BINANCE_APP_NAMESPACE = "BINANCE_APP_80306b0de";
const BINANCE_APP_URL =
  "https://bin.bnbstatic.com/api/i18n/-/web/cms/sp/BINANCE_APP_80306b0de/en/ns/app.xml";
const REQUEST_TIMEOUT_MS = 10_000;

const BINANCE_UI_NAMESPACES = [
  "BINANCE_APP_80306b0de",
  "Binance-copy-trading",
  "MPC-wallet",
  "Trading-Insight",
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
  "futures-ui",
  "growth-game-ui",
  "growth-platform",
  "kyc-errorCode",
  "lending-ui",
  "megadrop",
  "mini-notification-center",
  "Navigation",
  "new2fa",
  "news-ui",
  "oauth",
  "proof-ui",
  "stock_landing_page",
  "support-center",
  "trade-ui",
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

function getBinanceNamespaceUrl(namespace) {
  if (namespace === BINANCE_APP_NAMESPACE) return BINANCE_APP_URL;
  return `${BINANCE_UI_BASE}/${encodeURIComponent(namespace)}`;
}

function decodeXmlText(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_match, decimal) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAndroidStrings(xml) {
  const strings = {};
  const pattern = /<string\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g;
  for (const match of xml.matchAll(pattern)) {
    strings[decodeXmlText(match[1])] = decodeXmlText(match[2]);
  }
  return strings;
}

async function fetchBinanceNamespace(namespace, etag = null) {
  const headers = {
    accept:
      namespace === BINANCE_APP_NAMESPACE
        ? "application/xml"
        : "application/json",
    "user-agent": "the-watcher/1.0",
  };
  if (etag) headers["if-none-match"] = etag;

  const response = await fetch(getBinanceNamespaceUrl(namespace), {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const responseMetadata = {
    etag: response.headers.get("etag") || etag,
    lastModified: response.headers.get("last-modified") || null,
    versionId: response.headers.get("x-amz-version-id") || null,
  };
  if (response.status === 304) {
    return { unchanged: true, ...responseMetadata, data: null };
  }
  if (!response.ok) {
    throw new Error(`Binance returned ${response.status} for ${namespace}`);
  }

  const data =
    namespace === BINANCE_APP_NAMESPACE
      ? parseAndroidStrings(await response.text())
      : await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Binance returned invalid translations for ${namespace}`);
  }
  if (namespace === BINANCE_APP_NAMESPACE && Object.keys(data).length === 0) {
    throw new Error(`Binance returned empty translations for ${namespace}`);
  }
  return {
    unchanged: false,
    ...responseMetadata,
    data,
  };
}

module.exports = {
  BINANCE_APP_NAMESPACE,
  BINANCE_APP_URL,
  BINANCE_UI_BASE,
  BINANCE_UI_NAMESPACES,
  diffObjects,
  fetchBinanceNamespace,
  getBinanceNamespaceUrl,
  parseAndroidStrings,
  valueText,
};
