const { getSetting, recordYouTubeVideos, syncYouTubeChannels, statements } = require("./db");
const { emitTrackerEvent } = require("./event-stream");
const { buildYouTubeVideoEvent } = require("./events");
const { DEFAULT_YOUTUBE_CHANNELS } = require("./youtube-default-channels");
const { getLatestVideos, resolveYouTubeChannel } = require("./youtube");

const YOUTUBE_DISPATCH_MS = 250;
const YOUTUBE_MAX_CONCURRENCY = Number(process.env.YOUTUBE_MAX_CONCURRENCY || 10);
const YOUTUBE_DUMP_THRESHOLD = 5;
const inFlight = new Set();
const nextPollAt = new Map();
const baselinePending = new Set();
let dispatchTimer = null;

function isYouTubeEnabled() {
  return getSetting("youtube_enabled") !== "0";
}

function publicYouTubeChannel(row) {
  return {
    channelId: row.channel_id,
    handle: row.handle,
    title: row.title,
    status: row.enabled ? "active" : "paused",
    trackedSince: row.created_at,
    pollIntervalSeconds: row.poll_interval_seconds,
    aiAnalysisEnabled: row.ai_analysis_enabled === 1,
    lastInnerTubeAt: row.last_checked_at,
    lastError: row.last_error,
  };
}

function listPublicYouTubeChannels() {
  return statements.listYouTubeChannels.all().map(publicYouTubeChannel);
}

function ingestYouTubePage(channel, videos) {
  const listed = videos.filter((video) => video.videoId);
  if (!channel.baselined) {
    if (!listed.length) {
      throw new Error(`YouTube baseline was empty for ${channel.channel_id}`);
    }
    recordYouTubeVideos(channel.channel_id, listed, true);
    statements.markYouTubeBaselined.run(channel.channel_id);
    baselinePending.delete(channel.channel_id);
    return [];
  }
  const inserted = recordYouTubeVideos(channel.channel_id, listed, false);
  statements.markYouTubeSuccess.run(channel.channel_id);
  if (inserted.length >= YOUTUBE_DUMP_THRESHOLD) {
    console.warn(
      `[youtube] archived ${inserted.length} unseen videos for ${channel.channel_id} without emit`
    );
    return [];
  }
  return inserted;
}

async function scanYouTubeChannel(channelOrId, force = false) {
  const channelId = typeof channelOrId === "string" ? channelOrId : channelOrId.channel_id;
  const channel = statements.getYouTubeChannel.get(channelId);
  if (!channel || inFlight.has(channelId)) return [];
  if (!force && !channel.enabled) return [];

  inFlight.add(channelId);
  try {
    const videos = await getLatestVideos({
      channelId: channel.channel_id,
      title: channel.title,
    });
    const discovered = ingestYouTubePage(statements.getYouTubeChannel.get(channelId), videos);
    const current = statements.getYouTubeChannel.get(channelId);
    for (const video of discovered) {
      emitTrackerEvent(buildYouTubeVideoEvent(current, video));
    }
    if (discovered.length) {
      console.log(`[youtube] ${channel.title}: ${discovered.length} new video${discovered.length === 1 ? "" : "s"}`);
    }
    return discovered;
  } catch (error) {
    statements.markYouTubeError.run(String(error.message).slice(0, 500), channelId);
    console.warn(`[youtube] ${channel.title || channelId}: ${error.message}`);
    throw error;
  } finally {
    inFlight.delete(channelId);
  }
}

async function addYouTubeChannelFromInput(input, pollIntervalSeconds = 15) {
  const resolved = await resolveYouTubeChannel(input);
  const existing = statements.getYouTubeChannel.get(resolved.channelId);
  if (existing) {
    return { channel: publicYouTubeChannel(existing), created: false };
  }
  const interval = [2, 15, 30].includes(Number(pollIntervalSeconds))
    ? Number(pollIntervalSeconds)
    : 15;
  statements.addYouTubeChannel.run(
    resolved.channelId,
    resolved.handle,
    resolved.title,
    interval
  );
  const channel = statements.getYouTubeChannel.get(resolved.channelId);
  baselinePending.add(channel.channel_id);
  nextPollAt.set(channel.channel_id, Date.now());
  void scanYouTubeChannel(channel, true).catch(() => undefined);
  return { channel: publicYouTubeChannel(channel), created: true };
}

function updateYouTubeChannel(channelId, update) {
  const existing = statements.getYouTubeChannel.get(channelId);
  if (!existing) return null;
  statements.updateYouTubeChannel.run(
    update.pollIntervalSeconds ?? null,
    update.aiAnalysisEnabled === undefined ? null : update.aiAnalysisEnabled ? 1 : 0,
    channelId
  );
  return publicYouTubeChannel(statements.getYouTubeChannel.get(channelId));
}

function dispatchYouTube() {
  if (!isYouTubeEnabled()) {
    scheduleYouTubeDispatch();
    return;
  }
  const now = Date.now();
  const channels = statements.activeYouTubeChannels.all();
  const activeIds = new Set(channels.map((channel) => channel.channel_id));
  for (const channelId of nextPollAt.keys()) {
    if (!activeIds.has(channelId)) nextPollAt.delete(channelId);
  }
  channels.forEach((channel, index) => {
    if (!nextPollAt.has(channel.channel_id)) {
      nextPollAt.set(channel.channel_id, now + index * 50);
    }
    if (!channel.baselined) baselinePending.add(channel.channel_id);
  });
  const due = channels.filter((channel) => (
    !inFlight.has(channel.channel_id)
    && (nextPollAt.get(channel.channel_id) ?? 0) <= now
  ));
  for (const channel of due) {
    if (inFlight.size >= YOUTUBE_MAX_CONCURRENCY) break;
    const waitMs = (baselinePending.has(channel.channel_id) ? 60 : channel.poll_interval_seconds) * 1000;
    nextPollAt.set(channel.channel_id, now + waitMs);
    void scanYouTubeChannel(channel).catch(() => undefined);
  }
  scheduleYouTubeDispatch();
}

function scheduleYouTubeDispatch() {
  dispatchTimer = setTimeout(dispatchYouTube, YOUTUBE_DISPATCH_MS);
  dispatchTimer.unref();
}

function startYouTubeScanner() {
  const synced = syncYouTubeChannels(DEFAULT_YOUTUBE_CHANNELS);
  if (synced.added || synced.updated) {
    console.log(`[youtube] synced +${synced.added} ~${synced.updated} channels`);
  }
  dispatchYouTube();
}

module.exports = {
  YOUTUBE_DUMP_THRESHOLD,
  addYouTubeChannelFromInput,
  ingestYouTubePage,
  isYouTubeEnabled,
  listPublicYouTubeChannels,
  publicYouTubeChannel,
  scanYouTubeChannel,
  startYouTubeScanner,
  updateYouTubeChannel,
};
