const { getSetting, recordBinanceSquarePosts, statements, syncBinanceSquareTargets } = require("./db");
const { emitTrackerEvent } = require("./event-stream");
const { buildBinanceSquarePostEvent } = require("./events");
const { DEFAULT_BINANCE_SQUARE_TARGETS } = require("./binance-square-default-targets");
const {
  fetchBinanceSquareWindow,
  resolveBinanceSquareProfile,
} = require("./binance-square");

const SQUARE_DISPATCH_MS = 100;
const SQUARE_MAX_CONCURRENCY = Number(process.env.BINANCE_SQUARE_MAX_CONCURRENCY || 20);
const SQUARE_MAX_TARGETS = Number(process.env.BINANCE_SQUARE_MAX_TARGETS || 300);
const SQUARE_DUMP_THRESHOLD = 5;
const inFlight = new Set();
const nextPollAt = new Map();
const baselinePending = new Set();
let dispatchTimer = null;

function isBinanceSquareEnabled() {
  return getSetting("binance_square_enabled") !== "0";
}

function epochMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function publicBinanceSquareTarget(row) {
  return {
    squareUid: row.square_uid,
    username: row.username,
    displayName: row.display_name,
    avatar: row.avatar,
    biography: row.biography,
    trackedSince: row.created_at,
    pollIntervalSeconds: row.poll_interval_seconds,
    enabled: row.enabled === 1,
    lastPollAt: epochMs(row.last_checked_at),
    lastSuccessAt: row.baselined ? epochMs(row.last_checked_at) : null,
    lastEventAt: null,
    lastError: row.last_error,
    consecutiveFailures: 0,
    pinnedPostCount: row.pinned_post_count,
  };
}

function listPublicBinanceSquareTargets() {
  return statements.listBinanceSquareTargets.all().map(publicBinanceSquareTarget);
}

function countPinned(posts) {
  return posts.filter((post) => post.isPinned).length;
}

function ingestBinanceSquarePage(target, posts) {
  const listed = posts.filter((post) => post.id);
  const pinned = countPinned(listed);
  if (!target.baselined) {
    if (!listed.length) {
      throw new Error(`Binance Square baseline was empty for @${target.username}`);
    }
    recordBinanceSquarePosts(target.square_uid, listed, true);
    statements.markBinanceSquareBaselined.run(pinned, target.square_uid);
    baselinePending.delete(target.square_uid);
    return [];
  }
  const inserted = recordBinanceSquarePosts(target.square_uid, listed, false);
  statements.markBinanceSquareSuccess.run(pinned, target.square_uid);
  if (inserted.length >= SQUARE_DUMP_THRESHOLD) {
    console.warn(
      `[binance-square] archived ${inserted.length} unseen posts for @${target.username} without emit`
    );
    return [];
  }
  return inserted;
}

async function scanBinanceSquareTarget(targetOrId, force = false) {
  const squareUid = typeof targetOrId === "string" ? targetOrId : targetOrId.square_uid;
  const target = statements.getBinanceSquareTarget.get(squareUid);
  if (!target || inFlight.has(squareUid)) return [];
  if (!force && !target.enabled) return [];

  inFlight.add(squareUid);
  try {
    const posts = await fetchBinanceSquareWindow({
      squareUid: target.square_uid,
      username: target.username,
      displayName: target.display_name,
      avatar: target.avatar,
      pinnedPostCount: target.pinned_post_count,
    });
    const discovered = ingestBinanceSquarePage(
      statements.getBinanceSquareTarget.get(squareUid),
      posts
    );
    const current = statements.getBinanceSquareTarget.get(squareUid);
    for (const post of discovered.sort((left, right) => left.createdAt - right.createdAt)) {
      emitTrackerEvent(buildBinanceSquarePostEvent(current, post));
    }
    if (discovered.length) {
      console.log(
        `[binance-square] @${target.username}: ${discovered.length} new post${discovered.length === 1 ? "" : "s"}`
      );
    }
    return discovered;
  } catch (error) {
    statements.markBinanceSquareError.run(String(error.message).slice(0, 500), squareUid);
    console.warn(`[binance-square] @${target.username || squareUid}: ${error.message}`);
    throw error;
  } finally {
    inFlight.delete(squareUid);
  }
}

async function addBinanceSquareTargetFromInput(input, pollIntervalSeconds = 15) {
  const resolved = await resolveBinanceSquareProfile(input);
  const existing = statements.getBinanceSquareTarget.get(resolved.squareUid)
    || statements.getBinanceSquareTargetByUsername.get(resolved.username);
  if (existing) {
    return { target: publicBinanceSquareTarget(existing), created: false };
  }
  if (statements.countBinanceSquareTargets.get().count >= SQUARE_MAX_TARGETS) {
    throw new Error(`Binance Square profile limit of ${SQUARE_MAX_TARGETS} reached`);
  }
  const interval = [2, 15, 30].includes(Number(pollIntervalSeconds))
    ? Number(pollIntervalSeconds)
    : 15;
  statements.addBinanceSquareTarget.run(
    resolved.squareUid,
    resolved.username,
    resolved.displayName,
    resolved.avatar,
    resolved.biography,
    interval
  );
  const target = statements.getBinanceSquareTarget.get(resolved.squareUid);
  baselinePending.add(target.square_uid);
  nextPollAt.set(target.square_uid, Date.now());
  void scanBinanceSquareTarget(target, true).catch(() => undefined);
  return { target: publicBinanceSquareTarget(target), created: true };
}

function updateBinanceSquareTarget(squareUid, update) {
  const existing = statements.getBinanceSquareTarget.get(squareUid);
  if (!existing) return null;
  statements.updateBinanceSquareTarget.run(
    update.pollIntervalSeconds ?? null,
    update.enabled === undefined ? null : update.enabled ? 1 : 0,
    squareUid
  );
  const current = statements.getBinanceSquareTarget.get(squareUid);
  if (current.enabled) nextPollAt.set(squareUid, Date.now());
  else nextPollAt.delete(squareUid);
  return publicBinanceSquareTarget(current);
}

function dispatchBinanceSquare() {
  if (!isBinanceSquareEnabled()) {
    scheduleBinanceSquareDispatch();
    return;
  }
  const now = Date.now();
  const targets = statements.activeBinanceSquareTargets.all();
  const activeIds = new Set(targets.map((target) => target.square_uid));
  for (const squareUid of nextPollAt.keys()) {
    if (!activeIds.has(squareUid)) nextPollAt.delete(squareUid);
  }
  targets.forEach((target, index) => {
    if (!nextPollAt.has(target.square_uid)) {
      nextPollAt.set(target.square_uid, now + index * 50);
    }
    if (!target.baselined) baselinePending.add(target.square_uid);
  });
  const due = targets.filter((target) => (
    !inFlight.has(target.square_uid)
    && (nextPollAt.get(target.square_uid) ?? 0) <= now
  ));
  for (const target of due) {
    if (inFlight.size >= SQUARE_MAX_CONCURRENCY) break;
    const waitMs = (baselinePending.has(target.square_uid) ? 60 : target.poll_interval_seconds) * 1000;
    nextPollAt.set(target.square_uid, now + waitMs);
    void scanBinanceSquareTarget(target).catch(() => undefined);
  }
  scheduleBinanceSquareDispatch();
}

function scheduleBinanceSquareDispatch() {
  dispatchTimer = setTimeout(dispatchBinanceSquare, SQUARE_DISPATCH_MS);
  dispatchTimer.unref();
}

function startBinanceSquareScanner() {
  const synced = syncBinanceSquareTargets(DEFAULT_BINANCE_SQUARE_TARGETS);
  if (synced.added || synced.updated) {
    console.log(`[binance-square] synced +${synced.added} ~${synced.updated} profiles`);
  }
  dispatchBinanceSquare();
}

module.exports = {
  SQUARE_DUMP_THRESHOLD,
  addBinanceSquareTargetFromInput,
  ingestBinanceSquarePage,
  isBinanceSquareEnabled,
  listPublicBinanceSquareTargets,
  publicBinanceSquareTarget,
  scanBinanceSquareTarget,
  startBinanceSquareScanner,
  updateBinanceSquareTarget,
};
