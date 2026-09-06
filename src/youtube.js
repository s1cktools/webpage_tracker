const CHANNEL_ID_PATTERN = /^UC[\w-]{22}$/;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const HTTP_TIMEOUT_MS = Number(process.env.YOUTUBE_HTTP_TIMEOUT_MS || 12_000);

let innerTubeConfig = null;
let innerTubeRefresh = null;

function extractChannelId(input) {
  const direct = String(input).match(/(?:^|\/)(UC[\w-]{22})(?:[/?#]|$)/)?.[1] ?? null;
  return direct && CHANNEL_ID_PATTERN.test(direct) ? direct : null;
}

function extractHandle(input) {
  return String(input).match(/(?:youtube\.com\/)?(@[\w.-]{3,30})(?:[/?#]|$)/i)?.[1] ?? null;
}

function extractConfigValue(html, key) {
  const marker = `"${key}":"`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = markerIndex + marker.length;
  const end = html.indexOf('"', start);
  return end > start ? html.slice(start, end) : null;
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  if (typeof value.simpleText === "string") return value.simpleText;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.runs)) {
    const text = value.runs
      .map((run) => (run && typeof run === "object" && typeof run.text === "string" ? run.text : ""))
      .join("");
    if (text) return text;
  }
  return null;
}

function findNamedText(value, names, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return null;
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key)) {
      const text = textValue(child);
      if (text) return text;
    }
  }
  for (const child of Object.values(value)) {
    const text = findNamedText(child, names, depth + 1);
    if (text) return text;
  }
  return null;
}

function rendererTitle(object) {
  return (
    textValue(object.title) ||
    textValue(object.headline) ||
    findNamedText(object.metadata, new Set(["title", "headline", "primaryText"])) ||
    findNamedText(object.overlayMetadata, new Set(["title", "headline", "primaryText"]))
  );
}

function findThumbnail(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  const images = Array.isArray(value.thumbnails)
    ? value.thumbnails
    : Array.isArray(value.sources)
      ? value.sources
      : null;
  if (images) {
    for (let index = images.length - 1; index >= 0; index -= 1) {
      if (typeof images[index]?.url === "string") return images[index].url;
    }
  }
  for (const child of Object.values(value)) {
    const thumbnail = findThumbnail(child, depth + 1);
    if (thumbnail) return thumbnail;
  }
  return undefined;
}

function extractInnerTubeVideos(data, channel) {
  const videos = new Map();
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    const videoId =
      typeof value.videoId === "string"
        ? value.videoId
        : typeof value.contentId === "string"
          ? value.contentId
          : null;
    const title = rendererTitle(value);
    if (videoId && VIDEO_ID_PATTERN.test(videoId) && title && !videos.has(videoId)) {
      videos.set(videoId, {
        videoId,
        channelId: channel.channelId,
        title,
        channelTitle: channel.title,
        thumbnailUrl: findThumbnail(value),
      });
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(data);
  return [...videos.values()].slice(0, 30);
}

function extractAssignedJson(html, variable) {
  const markerIndex = html.indexOf(variable);
  if (markerIndex < 0) return null;
  const start = html.indexOf("{", markerIndex);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, index + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function findObjectWithKey(value, key) {
  if (!value || typeof value !== "object") return null;
  if (key in value) return value;
  for (const child of Object.values(value)) {
    const found = findObjectWithKey(child, key);
    if (found) return found;
  }
  return null;
}

function matchFirst(value, patterns) {
  for (const pattern of patterns) {
    const match = value.match(pattern)?.[1];
    if (match) return match;
  }
  return null;
}

function decodeHtml(value) {
  return value?.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'") ?? null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function youtubeRequest(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      cookie: "SOCS=CAI",
      ...options.headers,
    },
    body: options.body,
    redirect: "follow",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
}

async function refreshInnerTubeConfig(channelId) {
  const response = await youtubeRequest(`https://www.youtube.com/channel/${channelId}/videos`);
  if (response.status !== 200) {
    throw new Error(`InnerTube configuration page returned HTTP ${response.status}`);
  }
  const apiKey = extractConfigValue(response.body, "INNERTUBE_API_KEY");
  const clientVersion = extractConfigValue(response.body, "INNERTUBE_CLIENT_VERSION");
  const visitorData = extractConfigValue(response.body, "VISITOR_DATA");
  if (!apiKey || !clientVersion || !visitorData) {
    throw new Error("Could not extract InnerTube configuration");
  }
  return { apiKey, clientVersion, visitorData, expiresAt: Date.now() + 30 * 60_000 };
}

async function getInnerTubeConfig(channelId, force = false) {
  if (!force && innerTubeConfig && innerTubeConfig.expiresAt > Date.now()) return innerTubeConfig;
  if (innerTubeRefresh) return innerTubeRefresh;
  innerTubeRefresh = refreshInnerTubeConfig(channelId);
  try {
    innerTubeConfig = await innerTubeRefresh;
    return innerTubeConfig;
  } finally {
    innerTubeRefresh = null;
  }
}

async function browseUploads(channel, config) {
  const endpoint = `https://www.youtube.com/youtubei/v1/browse?prettyPrint=false&key=${encodeURIComponent(config.apiKey)}`;
  return youtubeRequest(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-youtube-client-name": "1",
      "x-youtube-client-version": config.clientVersion,
      "x-goog-visitor-id": safeDecode(config.visitorData),
      origin: "https://www.youtube.com",
      referer: `https://www.youtube.com/playlist?list=UU${channel.channelId.slice(2)}`,
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: "WEB",
          clientVersion: config.clientVersion,
          visitorData: config.visitorData,
          hl: "en",
          gl: "US",
        },
      },
      browseId: `VLUU${channel.channelId.slice(2)}`,
    }),
  });
}

async function getLatestVideos(channel) {
  let config = await getInnerTubeConfig(channel.channelId);
  let response = await browseUploads(channel, config);
  if ([400, 401, 403].includes(response.status)) {
    config = await getInnerTubeConfig(channel.channelId, true);
    response = await browseUploads(channel, config);
  }
  if (response.status !== 200) throw new Error(`InnerTube returned HTTP ${response.status}`);
  try {
    return extractInnerTubeVideos(JSON.parse(response.body), channel);
  } catch (error) {
    if (error.message.startsWith("InnerTube")) throw error;
    throw new Error("InnerTube returned malformed JSON");
  }
}

async function resolveYouTubeChannel(input) {
  const normalized = String(input).trim();
  const directId = extractChannelId(normalized);
  const handle = extractHandle(normalized);
  if (!directId && !handle) {
    throw new Error("Expected a YouTube @handle, handle URL, or UC channel ID");
  }
  const url = directId && !handle
    ? `https://www.youtube.com/channel/${directId}`
    : `https://www.youtube.com/${encodeURIComponent(handle)}`;
  const response = await youtubeRequest(url);
  if (response.status !== 200) {
    throw new Error(`YouTube returned HTTP ${response.status} while resolving channel`);
  }
  const initialData = extractAssignedJson(response.body, "ytInitialData");
  const metadata = initialData ? findObjectWithKey(initialData, "channelMetadataRenderer") : null;
  const renderer = metadata?.channelMetadataRenderer;
  const htmlId =
    (typeof renderer?.externalId === "string" ? renderer.externalId : null) ||
    matchFirst(response.body, [
      /"externalId":"(UC[\w-]{22})"/,
      /"channelId":"(UC[\w-]{22})"/,
      /youtube\.com\/channel\/(UC[\w-]{22})/,
    ]);
  const channelId = htmlId || directId;
  if (!channelId || !CHANNEL_ID_PATTERN.test(channelId)) {
    throw new Error("Could not extract a stable channel ID from YouTube");
  }
  const title =
    (typeof renderer?.title === "string" ? renderer.title : null) ||
    decodeHtml(matchFirst(response.body, [/<meta property="og:title" content="([^"]+)"/])) ||
    handle ||
    channelId;
  return {
    channelId,
    handle: extractHandle(typeof renderer?.vanityChannelUrl === "string" ? renderer.vanityChannelUrl : "") || handle,
    title,
  };
}

function resetInnerTubeConfig() {
  innerTubeConfig = null;
  innerTubeRefresh = null;
}

module.exports = {
  extractChannelId,
  extractConfigValue,
  extractHandle,
  extractInnerTubeVideos,
  getLatestVideos,
  resetInnerTubeConfig,
  resolveYouTubeChannel,
};
