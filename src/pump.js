const { createHash } = require("node:crypto");

const PUMP_PROJECT_ID = "660d9cc8-3cc2-4269-8845-7be9bbed752b";
const PUMP_UPDATE_URL = `https://u.expo.dev/${PUMP_PROJECT_ID}`;
const PUMP_PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.batonresearch.pump&hl=en&gl=US";
const PUMP_CHANNEL = "mainnet";
const PUMP_PLATFORM = "android";
const PUMP_DEFAULT_RUNTIME_VERSION = "26.0.0";
const PLAY_STORE_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 30_000;
const BUNDLE_TIMEOUT_MS = 180_000;
const MAX_SIGNAL_ITEMS = 5_000;
const RUNTIME_CACHE_MS = 10 * 60_000;
let runtimeCache = null;

function isTimeoutError(error) {
  return (
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    /aborted due to timeout/i.test(error?.message || "")
  );
}

async function pumpFetch(url, options, timeoutMs, label) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  }
}

function pumpRuntimeVersion() {
  return process.env.PUMP_RUNTIME_VERSION || PUMP_DEFAULT_RUNTIME_VERSION;
}

function parsePlayStoreVersion(html) {
  const match = String(html).match(
    /\[\[\["(\d+(?:\.\d+){1,3})"\]\],\[\[\[\d+\]\],\[\[\[\d+,"[\d.]+"/
  );
  if (!match) throw new Error("Could not find Pump version on Google Play");
  return match[1];
}

async function resolvePumpRuntimeVersion() {
  if (process.env.PUMP_RUNTIME_VERSION) return process.env.PUMP_RUNTIME_VERSION;
  if (runtimeCache && runtimeCache.expiresAt > Date.now()) return runtimeCache.value;

  try {
    const response = await pumpFetch(
      PUMP_PLAY_STORE_URL,
      { headers: { "user-agent": "Mozilla/5.0 the-watcher/1.0" } },
      PLAY_STORE_TIMEOUT_MS,
      "Google Play"
    );
    if (!response.ok) throw new Error(`Google Play returned ${response.status}`);
    const value = parsePlayStoreVersion(await response.text());
    runtimeCache = { value, expiresAt: Date.now() + RUNTIME_CACHE_MS };
    return value;
  } catch (error) {
    if (runtimeCache) return runtimeCache.value;
    console.warn(`[pump-app] ${error.message}; using ${PUMP_DEFAULT_RUNTIME_VERSION}`);
    runtimeCache = {
      value: PUMP_DEFAULT_RUNTIME_VERSION,
      expiresAt: Date.now() + 60_000,
    };
    return PUMP_DEFAULT_RUNTIME_VERSION;
  }
}

function parseMultipartParts(body, contentType) {
  const boundaryMatch = String(contentType || "").match(/boundary="?([^";]+)"?/i);
  if (!boundaryMatch) throw new Error("Pump returned an invalid multipart response");

  const parts = {};
  for (const rawPart of body.split(`--${boundaryMatch[1]}`)) {
    const part = rawPart.replace(/^\r?\n/, "").replace(/\r?\n--\r?\n?$/, "");
    const separator = part.search(/\r?\n\r?\n/);
    if (separator < 0) continue;
    const headerText = part.slice(0, separator);
    const name = headerText.match(/name="([^"]+)"/i)?.[1];
    if (!name) continue;
    const value = part.slice(separator).replace(/^\r?\n\r?\n/, "").trim();
    parts[name] = JSON.parse(value);
  }
  if (!parts.manifest) throw new Error("Pump response did not include a manifest");
  return parts;
}

async function fetchPumpUpdate({
  updateId = null,
  etag = null,
  runtimeVersion = pumpRuntimeVersion(),
} = {}) {
  const headers = {
    accept: "multipart/mixed,application/expo+json,application/json",
    "expo-api-version": "1",
    "expo-channel-name": PUMP_CHANNEL,
    "expo-platform": PUMP_PLATFORM,
    "expo-protocol-version": "1",
    "expo-runtime-version": runtimeVersion,
    "expo-updates-environment": "BARE",
    "user-agent": "the-watcher/1.0",
  };
  if (updateId) headers["expo-current-update-id"] = updateId;
  if (etag) headers["if-none-match"] = etag;

  const response = await pumpFetch(
    PUMP_UPDATE_URL,
    { headers },
    REQUEST_TIMEOUT_MS,
    "Pump update feed"
  );
  if (response.status === 204 || response.status === 304) {
    return { unchanged: true, updateId, etag };
  }
  if (!response.ok) {
    throw new Error(`Pump update feed returned ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  let parts;
  if (contentType.includes("multipart/")) {
    parts = parseMultipartParts(await response.text(), contentType);
  } else {
    parts = { manifest: await response.json(), extensions: {} };
  }
  const manifest = parts.manifest;
  if (!manifest?.id || !manifest?.launchAsset?.hash) {
    throw new Error("Pump returned an incomplete update manifest");
  }
  return {
    unchanged: false,
    manifest,
    extensions: parts.extensions || {},
    updateId: manifest.id,
    etag: response.headers.get("etag") || etag,
  };
}

async function fetchPumpBundle(manifest, extensions = {}) {
  const authorization =
    extensions.assetRequestHeaders?.[manifest.launchAsset.key]?.authorization;
  const headers = { "user-agent": "the-watcher/1.0" };
  if (authorization) headers.authorization = authorization;

  const response = await pumpFetch(
    manifest.launchAsset.url,
    { headers },
    BUNDLE_TIMEOUT_MS,
    "Pump launch bundle"
  );
  if (!response.ok) {
    throw new Error(`Pump bundle returned ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function uniqueSorted(values) {
  return [...new Set(values)].sort().slice(0, MAX_SIGNAL_ITEMS);
}

function extractBundleSignals(buffer, manifest) {
  const text = buffer.toString("latin1");
  const hosts = [];
  const hostPattern =
    /https?:\/\/((?:[a-z0-9-]+\.)+(?:com|dev|fun|io|net|org|xyz))(?:[/:?#]|$)/gi;
  for (const match of text.matchAll(hostPattern)) {
    const host = match[1].toLowerCase();
    if (
      host.endsWith(".pump.fun") ||
      host === "pump.fun" ||
      /(api|rpc|indexer|client|funding|image|asset|auth|wallet|trade)/.test(host)
    ) {
      hosts.push(host);
    }
  }
  for (const match of text.matchAll(/(?:[a-z0-9-]+\.)+pump\.fun/gi)) {
    hosts.push(match[0].toLowerCase());
  }

  const routes = [];
  const routePattern =
    /\/(?:\(tabs\)|coin|profile|wallet|settings|trade|livestream|bounty|position|chat|coins|wallets)(?:\/[a-zA-Z0-9_[\]()-]+){0,6}/g;
  for (const match of text.matchAll(routePattern)) {
    if (match[0].length <= 120) routes.push(match[0]);
  }

  const textHints = [];
  const hintPattern =
    /\b[A-Z][A-Za-z0-9'’.,!?():/&+-]*(?: [A-Za-z0-9'’.,!?():/&+-]+){2,12}\b/g;
  for (const match of text.matchAll(hintPattern)) {
    const value = match[0].trim();
    if (
      value.length >= 16 &&
      value.length <= 120 &&
      !value.includes("http") &&
      !/[{}<>_=]/.test(value) &&
      (value.match(/[A-Za-z]/g) || []).length / value.length > 0.7
    ) {
      textHints.push(value);
    }
  }

  return {
    assets: uniqueSorted((manifest.assets || []).map((asset) => asset.key).filter(Boolean)),
    hosts: uniqueSorted(hosts),
    routes: uniqueSorted(routes),
    textHints: uniqueSorted(textHints),
  };
}

function diffPumpSignals(previous = {}, current = {}) {
  const changes = [];
  const categories = [
    ["host", "hosts"],
    ["route", "routes"],
    ["text", "textHints"],
    ["asset", "assets"],
  ];
  for (const [category, key] of categories) {
    const before = new Set(previous[key] || []);
    const after = new Set(current[key] || []);
    for (const value of after) {
      if (!before.has(value)) changes.push({ type: "added", category, value });
    }
    for (const value of before) {
      if (!after.has(value)) changes.push({ type: "removed", category, value });
    }
  }
  return changes;
}

function groupPumpChanges(changes = []) {
  const categories = [
    { key: "host", label: "Endpoints" },
    { key: "route", label: "Routes" },
    { key: "text", label: "UI text" },
    { key: "asset", label: "Assets" },
  ];
  const groups = categories.map((category) => ({
    ...category,
    added: [],
    removed: [],
  }));
  const groupsByKey = new Map(groups.map((group) => [group.key, group]));

  for (const change of changes) {
    const group = groupsByKey.get(change.category);
    if (group && (change.type === "added" || change.type === "removed")) {
      group[change.type].push(change.value);
    }
  }

  return groups.map((group) => ({
    ...group,
    count: group.added.length + group.removed.length,
  }));
}

function bundleSha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function safeAssetKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(key) ? key : "";
}

function normalizeAssetExtension(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("image/")) {
    const subtype = raw.slice(6).split("+")[0];
    if (subtype === "jpeg") return ".jpg";
    if (subtype === "svg+xml") return ".svg";
    const cleaned = subtype.replace(/[^a-z0-9]/g, "");
    return cleaned ? `.${cleaned}` : "";
  }
  const extension = raw.startsWith(".") ? raw.slice(1) : raw;
  if (/^[a-z0-9]{1,8}$/.test(extension)) return `.${extension}`;
  return "";
}

function isImageAsset(meta = {}) {
  const contentType = String(meta.contentType || "").toLowerCase();
  const extension = normalizeAssetExtension(meta.fileExtension || meta.type);
  return (
    contentType.startsWith("image/") ||
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"].includes(extension)
  );
}

function describeManifestAssets(manifest = {}) {
  return (manifest.assets || []).flatMap((asset) => {
    const key = String(asset.key || "").trim();
    if (!key) return [];
    const fileExtension = normalizeAssetExtension(
      asset.fileExtension || asset.contentType || asset.type
    );
    const contentType = String(asset.contentType || "").trim();
    return [
      {
        key,
        url: asset.url || null,
        contentType,
        fileExtension,
        hash: asset.hash || null,
      },
    ];
  });
}

function extractPackagerAssetMeta(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("latin1") : String(buffer || "");
  const names = new Map();
  const pattern = /\{[^{}]{0,500}"__packager_asset"[^{}]{0,500}\}/g;
  for (const match of text.matchAll(pattern)) {
    try {
      const json = JSON.parse(match[0]);
      const key = String(json.hash || json.key || "").trim();
      if (!key) continue;
      names.set(key, {
        name: json.name || null,
        type: json.type || null,
        width: Number(json.width) || null,
        height: Number(json.height) || null,
      });
    } catch {
      // Hermes bytecode often leaves this metadata unparseable.
    }
  }
  return names;
}

function mergePumpAssetMeta(manifest, bundleBuffer) {
  const packagerMeta = extractPackagerAssetMeta(bundleBuffer);
  return describeManifestAssets(manifest).map((asset) => {
    const extra = packagerMeta.get(asset.key) || {};
    const fileExtension =
      asset.fileExtension || normalizeAssetExtension(extra.type) || "";
    return {
      ...asset,
      name: extra.name || null,
      type: extra.type || null,
      width: extra.width || null,
      height: extra.height || null,
      fileExtension,
    };
  });
}

async function fetchPumpAsset(asset, extensions = {}) {
  if (!asset?.url) throw new Error("Pump asset is missing a download URL");
  const authorization = extensions.assetRequestHeaders?.[asset.key]?.authorization;
  const headers = { "user-agent": "the-watcher/1.0" };
  if (authorization) headers.authorization = authorization;

  const response = await pumpFetch(
    asset.url,
    { headers },
    REQUEST_TIMEOUT_MS,
    "Pump asset"
  );
  if (!response.ok) {
    throw new Error(`Pump asset returned ${response.status}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") || asset.contentType || "",
  };
}

function formatAssetLabel(key, meta = {}) {
  const extension = normalizeAssetExtension(meta.fileExtension || meta.type);
  if (meta.name) return `${meta.name}${extension}`;
  if (meta.contentType) return meta.contentType;
  if (extension) return extension.slice(1);
  return key;
}

function collectAssetKeys(changes = []) {
  return [
    ...new Set(
      changes
        .filter((change) => change.category === "asset" && change.value)
        .map((change) => change.value)
    ),
  ];
}

function decoratePumpChangeGroups(groups = [], assetsByKey = {}) {
  return groups.map((group) => {
    const decorate = (value) => {
      const meta = assetsByKey[value] || {};
      const label = group.key === "asset" ? formatAssetLabel(value, meta) : value;
      return {
        key: value,
        label,
        contentType: meta.contentType || null,
        previewUrl:
          group.key === "asset" && meta.hasFile && isImageAsset(meta)
            ? `/pump/assets/${encodeURIComponent(value)}`
            : null,
      };
    };
    return {
      ...group,
      added: group.added.map(decorate),
      removed: group.removed.map(decorate),
    };
  });
}

module.exports = {
  BUNDLE_TIMEOUT_MS,
  PLAY_STORE_TIMEOUT_MS,
  PUMP_CHANNEL,
  PUMP_DEFAULT_RUNTIME_VERSION,
  PUMP_PLATFORM,
  PUMP_PLAY_STORE_URL,
  PUMP_PROJECT_ID,
  PUMP_UPDATE_URL,
  REQUEST_TIMEOUT_MS,
  bundleSha256,
  collectAssetKeys,
  decoratePumpChangeGroups,
  describeManifestAssets,
  diffPumpSignals,
  extractBundleSignals,
  extractPackagerAssetMeta,
  fetchPumpAsset,
  fetchPumpBundle,
  fetchPumpUpdate,
  formatAssetLabel,
  groupPumpChanges,
  isImageAsset,
  mergePumpAssetMeta,
  parseMultipartParts,
  parsePlayStoreVersion,
  pumpRuntimeVersion,
  resolvePumpRuntimeVersion,
  safeAssetKey,
};
