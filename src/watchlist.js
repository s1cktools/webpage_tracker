const { BINANCE_UI_NAMESPACES } = require("./binance");
const { getSetting, statements } = require("./db");
const { isBinanceEnabled } = require("./binance-scanner");
const { isBinanceSquareEnabled, listPublicBinanceSquareTargets } = require("./binance-square-scanner");
const { isPumpEnabled } = require("./pump-scanner");
const { isRobinhoodEnabled } = require("./robinhood-scanner");
const { isYouTubeEnabled, listPublicYouTubeChannels } = require("./youtube-scanner");

function getWatchlist() {
  return {
    flags: {
      websites: true,
      certificate_transparency: true,
      github: true,
      binance_ui: isBinanceEnabled(),
      pump_app: isPumpEnabled(),
      robinhood: isRobinhoodEnabled(),
      youtube: isYouTubeEnabled(),
      binance_square: isBinanceSquareEnabled(),
    },
    sites: statements.activeSites.all().map((site) => ({
      id: site.id,
      url: site.url,
      hostname: site.hostname,
      nickname: site.nickname,
      ignore_locales: site.ignore_locales === 1,
      enabled: site.enabled === 1,
    })),
    github_targets: statements.activeGithubTargets.all().map((target) => ({
      id: target.id,
      kind: target.kind,
      owner: target.owner,
      repo: target.repo,
      target_key: target.target_key,
      enabled: target.enabled === 1,
    })),
    youtube_channels: listPublicYouTubeChannels()
      .filter((channel) => channel.status === "active")
      .map((channel) => ({
        channel_id: channel.channelId,
        handle: channel.handle,
        title: channel.title,
        poll_interval_seconds: channel.pollIntervalSeconds,
        enabled: true,
      })),
    binance_square_targets: listPublicBinanceSquareTargets()
      .filter((target) => target.enabled)
      .map((target) => ({
        square_uid: target.squareUid,
        username: target.username,
        display_name: target.displayName,
        avatar: target.avatar,
        poll_interval_seconds: target.pollIntervalSeconds,
        enabled: true,
        pinned_post_count: target.pinnedPostCount,
      })),
    binance_ui_namespaces: BINANCE_UI_NAMESPACES.slice(),
    settings: {
      youtube_enabled: getSetting("youtube_enabled") !== "0",
      binance_square_enabled: getSetting("binance_square_enabled") !== "0",
      binance_ui_enabled: getSetting("binance_ui_enabled") !== "0",
      pump_app_enabled: getSetting("pump_app_enabled") !== "0",
      robinhood_pages_enabled: getSetting("robinhood_pages_enabled") !== "0",
    },
  };
}

module.exports = { getWatchlist };
