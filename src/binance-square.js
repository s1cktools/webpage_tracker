const BASE_URL = "https://www.binance.com";
const HTTP_TIMEOUT_MS = Number(process.env.BINANCE_SQUARE_HTTP_TIMEOUT_MS || 12_000);
const MAX_WINDOW_PAGES = Number(process.env.BINANCE_SQUARE_MAX_WINDOW_PAGES || 10);

async function binanceSquareRequest(method, url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/json",
        lang: "en",
        referer: "https://www.binance.com/en/square",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `${method} ${new URL(url).pathname} returned HTTP ${response.status}: ${text.slice(0, 300)}`
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${method} ${new URL(url).pathname} returned non-JSON content`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUsername(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("Binance Square username is required");
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const match = url.pathname.match(/\/square\/profile\/([^/?#]+)/i);
    if (match) return decodeURIComponent(match[1]).replace(/^@/, "");
  } catch {
    // Treat non-URL input as a username.
  }
  const normalized = value.replace(/^@/, "");
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(normalized)) {
    throw new Error("Invalid Binance Square username or profile URL");
  }
  return normalized;
}

async function resolveBinanceSquareProfile(input) {
  const username = normalizeUsername(input);
  const response = await binanceSquareRequest(
    "POST",
    `${BASE_URL}/bapi/composite/v3/friendly/pgc/user/client`,
    {
      username,
      getFollowCount: true,
      queryFollowersInfo: true,
      queryRelationTokens: true,
    }
  );
  if (!response.success || response.code !== "000000" || !response.data?.squareUid) {
    throw new Error(
      `Binance Square profile lookup failed: ${response.message || response.code || "unknown error"}`
    );
  }
  return {
    squareUid: response.data.squareUid,
    username: response.data.username || username,
    displayName: response.data.displayName || response.data.username || username,
    avatar: stringOrNull(response.data.avatar),
    biography: stringOrNull(response.data.biography),
  };
}

async function fetchBinanceSquarePosts(target, timeOffset = -1, limit = 5) {
  const query = new URLSearchParams({
    targetSquareUid: target.squareUid || target.square_uid,
    timeOffset: String(timeOffset),
    filterType: "ALL",
    limit: String(limit),
  });
  const response = await binanceSquareRequest(
    "GET",
    `${BASE_URL}/bapi/composite/v2/friendly/pgc/content/queryUserProfilePageContentsWithFilter?${query}`
  );
  if (!response.success || response.code !== "000000" || !response.data) {
    throw new Error(
      `Binance Square posts lookup failed: ${response.message || response.code || "unknown error"}`
    );
  }
  return {
    posts: (response.data.contents ?? [])
      .map((value) => mapBinanceSquarePost(value, target))
      .filter(Boolean),
    timeOffset: finiteNumber(response.data.timeOffset),
  };
}

async function fetchBinanceSquareWindow(target) {
  const maxPages = Math.max(1, Math.min(100, MAX_WINDOW_PAGES));
  const pinned = Math.max(0, Number(target.pinnedPostCount ?? target.pinned_post_count ?? 0));
  const firstLimit = Math.min(20, 5 + pinned);
  const firstPage = await fetchBinanceSquarePosts(target, -1, firstLimit);
  const posts = [...firstPage.posts];
  const seenOffsets = new Set();
  let timeOffset = firstPage.timeOffset;
  let pages = 1;

  while (
    posts.filter((post) => !post.isPinned).length < 5
    && timeOffset !== null
    && pages < maxPages
  ) {
    if (seenOffsets.has(timeOffset)) break;
    seenOffsets.add(timeOffset);
    const page = await fetchBinanceSquarePosts(target, timeOffset, 5);
    pages += 1;
    posts.push(...page.posts);
    if (page.posts.length < 5) {
      timeOffset = null;
      break;
    }
    timeOffset = page.timeOffset;
  }

  return dedupePosts(posts);
}

function mapBinanceSquarePost(value, target) {
  if (!value || typeof value !== "object") return null;
  const raw = value;
  const id = stringValue(raw.id);
  if (!id) return null;
  const authorValue = objectValue(raw.author)
    ?? objectValue(raw.contentAuthor)
    ?? objectValue(raw.user)
    ?? {};
  const username = stringValue(authorValue.username)
    ?? stringValue(authorValue.userName)
    ?? target.username;
  const displayName = stringValue(authorValue.displayName)
    ?? stringValue(authorValue.nickname)
    ?? target.displayName
    ?? target.display_name;
  const squareUid = stringValue(authorValue.squareUid)
    ?? stringValue(authorValue.userId)
    ?? target.squareUid
    ?? target.square_uid;
  const bodyText = stringValue(raw.bodyTextOnly)
    ?? stringValue(raw.content)
    ?? stringValue(raw.text)
    ?? plainTextFromBody(raw.body)
    ?? "";
  const title = stringOrNull(raw.title);
  const createdAt = finiteNumber(raw.createTime)
    ?? finiteNumber(raw.createdAt)
    ?? finiteNumber(raw.publishTime)
    ?? 0;
  const contentType = finiteNumber(raw.contentType) ?? 0;
  const cover = stringValue(raw.cover) ?? stringValue(objectValue(raw.coverMeta)?.url);
  const webLink = stringValue(raw.webLink)
    ?? stringValue(raw.shareLink)
    ?? `${BASE_URL}/en/square/post/${encodeURIComponent(id)}`;

  return {
    id,
    title,
    content: bodyText,
    createdAt,
    contentType,
    postType: contentType === 2 ? "article" : contentType === 1 ? "post" : "other",
    isPinned: raw.isStickyToTop === true,
    url: webLink.startsWith("http")
      ? webLink
      : `${BASE_URL}${webLink.startsWith("/") ? "" : "/"}${webLink}`,
    images: collectImages(raw),
    cover,
    author: {
      squareUid,
      username,
      displayName,
      avatar: stringOrNull(authorValue.avatar) ?? target.avatar ?? null,
    },
  };
}

function dedupePosts(posts) {
  const byId = new Map();
  for (const post of posts) {
    if (post?.id && !byId.has(post.id)) byId.set(post.id, post);
  }
  return [...byId.values()];
}

function collectImages(raw) {
  const images = new Set();
  for (const item of arrayValue(raw.imageList)) {
    const url = stringValue(item) ?? stringValue(objectValue(item)?.url);
    if (url) images.add(url);
  }
  for (const item of arrayValue(raw.imageMetaList)) {
    const url = stringValue(objectValue(item)?.url);
    if (url) images.add(url);
  }
  const cover = stringValue(raw.cover) ?? stringValue(objectValue(raw.coverMeta)?.url);
  if (cover) images.add(cover);
  return [...images];
}

function plainTextFromBody(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (!value.trim().startsWith("{") && !value.trim().startsWith("[")) return value;
  try {
    const parsed = JSON.parse(value);
    const fragments = [];
    visitText(parsed, fragments);
    return fragments.join(" ").replace(/\s+/g, " ").trim() || null;
  } catch {
    return value;
  }
}

function visitText(value, fragments) {
  if (typeof value === "string") {
    if (value.trim()) fragments.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitText(item, fragments);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (typeof value.text === "string") {
    fragments.push(value.text.trim());
    return;
  }
  for (const child of Object.values(value)) visitText(child, fragments);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

function stringOrNull(value) {
  return stringValue(value);
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  fetchBinanceSquarePosts,
  fetchBinanceSquareWindow,
  mapBinanceSquarePost,
  normalizeUsername,
  resolveBinanceSquareProfile,
};
