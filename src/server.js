const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const { getSetting, statements } = require("./db");
const {
  BINANCE_POLL_INTERVAL_MS,
  isBinanceEnabled,
  scanBinanceUi,
  startBinanceScanner,
} = require("./binance-scanner");
const { getBinanceNamespaceUrl } = require("./binance");
const {
  isAuthorizedProbe,
  processBinanceObservation,
} = require("./binance-observations");
const {
  addBinanceSquareTargetFromInput,
  isBinanceSquareEnabled,
  listPublicBinanceSquareTargets,
  scanBinanceSquareTarget,
  startBinanceSquareScanner,
  updateBinanceSquareTarget,
} = require("./binance-square-scanner");
const { processPumpObservation } = require("./pump-observations");
const { canonicalSiteHostname } = require("./ct");
const { attachEventStream, tokensMatch } = require("./event-stream");
const {
  getCtStatus,
  refreshCertspotterWatchlist,
  scanCtSite,
  startCtScanner,
  stopCertspotterManager,
} = require("./ct-scanner");
const { parseGitHubTarget } = require("./github");
const {
  GITHUB_POLL_INTERVAL_MS,
  scanGitHubTarget,
  startGithubScanner,
} = require("./github-scanner");
const {
  PUMP_POLL_INTERVAL_MS,
  isPumpEnabled,
  scanPumpApp,
  startPumpScanner,
} = require("./pump-scanner");
const {
  ROBINHOOD_POLL_INTERVAL_MS,
  isRobinhoodEnabled,
  scanRobinhood,
  startRobinhoodScanner,
} = require("./robinhood-scanner");
const { decoratePumpChangeGroups, collectAssetKeys, groupPumpChanges } = require("./pump");
const { getPumpAssetFile, getPumpAssetsByKeys } = require("./pump-assets");
const { applyObservations } = require("./observations");
const { getWatchlist } = require("./watchlist");
const { getPlaybook } = require("./websites");
const {
  WEBSITE_POLL_INTERVAL_MS,
  scanWebsiteBySiteId,
  startWebsiteScanner,
  syncWebsitePlaybooks,
} = require("./website-scanner");
const {
  addYouTubeChannelFromInput,
  isYouTubeEnabled,
  listPublicYouTubeChannels,
  scanYouTubeChannel,
  startYouTubeScanner,
  updateYouTubeChannel,
} = require("./youtube-scanner");

const app = express();
const port = Number(process.env.PORT) || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.use(express.urlencoded({ extended: false }));
app.use("/v1", express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function requireScrapeToken(request, response, next) {
  const expected = process.env.EVENT_STREAM_TOKEN;
  if (!expected) {
    return response.status(503).json({ error: "EVENT_STREAM_TOKEN is not configured" });
  }
  const authorization = String(request.headers.authorization || "");
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!tokensMatch(provided, expected)) {
    return response.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

function sendYouTubeError(response, error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("already") || message.includes("UNIQUE") ? 409 : 400;
  return response.status(status).json({ error: message });
}

function sendSquareError(response, error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("limit") ? 409 : 400;
  return response.status(status).json({ error: message });
}

app.get("/health", (request, response) => {
  response.status(200).send("ok");
});

app.post(
  "/internal/binance/observations",
  (request, response, next) => {
    if (isAuthorizedProbe(request.headers.authorization)) return next();
    return response.status(401).json({ error: "Unauthorized" });
  },
  express.json({ limit: "10mb" }),
  async (request, response) => {
    try {
      const result = await processBinanceObservation(request.body);
      if (result.status === "deferred") {
        return response.status(503).json({ status: "retry" });
      }
      return response.status(202).json({ status: result.status });
    } catch (error) {
      const invalid = /^(Unknown|Invalid|Missing)/.test(error.message);
      console.error("[binance-ingest]", error.message);
      return response
        .status(invalid ? 400 : 500)
        .json({ error: invalid ? error.message : "Observation processing failed" });
    }
  }
);

app.post(
  "/internal/pump/observations",
  (request, response, next) => {
    if (isAuthorizedProbe(request.headers.authorization)) return next();
    return response.status(401).json({ error: "Unauthorized" });
  },
  express.json({ limit: "10mb" }),
  async (request, response) => {
    try {
      const result = await processPumpObservation(request.body);
      return response.status(202).json({ status: result.status });
    } catch (error) {
      const invalid = /^(Invalid|Missing|Pump updateId)/.test(error.message);
      console.error("[pump-ingest]", error.message);
      return response
        .status(invalid ? 400 : 500)
        .json({ error: invalid ? error.message : "Observation processing failed" });
    }
  }
);

app.get("/v1/youtube/channels", requireScrapeToken, (_request, response) => {
  response.json({ channels: listPublicYouTubeChannels() });
});

app.post("/v1/youtube/channels", requireScrapeToken, async (request, response) => {
  try {
    const channel = typeof request.body?.channel === "string" ? request.body.channel : "";
    if (channel.trim().length < 3) {
      return response.status(400).json({
        error: "channel must be a YouTube handle, URL, or channel ID",
      });
    }
    const result = await addYouTubeChannelFromInput(
      channel,
      request.body.pollIntervalSeconds
    );
    return response.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    return sendYouTubeError(response, error);
  }
});

app.get("/v1/youtube/channels/:channelId", requireScrapeToken, (request, response) => {
  const channel = listPublicYouTubeChannels().find(
    (item) => item.channelId === request.params.channelId
  );
  if (!channel) return response.status(404).json({ error: "Channel not found" });
  return response.json({ channel });
});

app.patch("/v1/youtube/channels/:channelId", requireScrapeToken, (request, response) => {
  const update = {};
  if (request.body?.pollIntervalSeconds !== undefined) {
    if (![2, 15, 30].includes(Number(request.body.pollIntervalSeconds))) {
      return response.status(400).json({
        error: "pollIntervalSeconds must be 2, 15, or 30",
      });
    }
    update.pollIntervalSeconds = Number(request.body.pollIntervalSeconds);
  }
  if (request.body?.aiAnalysisEnabled !== undefined) {
    if (typeof request.body.aiAnalysisEnabled !== "boolean") {
      return response.status(400).json({
        error: "aiAnalysisEnabled must be a boolean",
      });
    }
    update.aiAnalysisEnabled = request.body.aiAnalysisEnabled;
  }
  if (!Object.keys(update).length) {
    return response.status(400).json({
      error: "At least one channel setting is required",
    });
  }
  const channel = updateYouTubeChannel(request.params.channelId, update);
  if (!channel) return response.status(404).json({ error: "Channel not found" });
  return response.json({ channel });
});

app.delete("/v1/youtube/channels/:channelId", requireScrapeToken, (request, response) => {
  const existing = statements.getYouTubeChannel.get(request.params.channelId);
  if (!existing) return response.status(404).json({ error: "Channel not found" });
  statements.deleteYouTubeChannel.run(request.params.channelId);
  return response.status(204).end();
});

app.get("/v1/binance-square/targets", requireScrapeToken, (_request, response) => {
  response.json({ targets: listPublicBinanceSquareTargets() });
});

app.post("/v1/binance-square/targets", requireScrapeToken, async (request, response) => {
  try {
    const profile = typeof request.body?.profile === "string"
      ? request.body.profile
      : typeof request.body?.target === "string"
        ? request.body.target
        : "";
    if (profile.trim().length < 2) {
      return response.status(400).json({
        error: "profile must be a Binance Square username or profile URL",
      });
    }
    if (
      request.body.pollIntervalSeconds !== undefined &&
      ![2, 15, 30].includes(Number(request.body.pollIntervalSeconds))
    ) {
      return response.status(400).json({
        error: "pollIntervalSeconds must be 2, 15, or 30",
      });
    }
    const result = await addBinanceSquareTargetFromInput(
      profile,
      request.body.pollIntervalSeconds
    );
    return response.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    return sendSquareError(response, error);
  }
});

app.get("/v1/binance-square/targets/:squareUid", requireScrapeToken, (request, response) => {
  const target = listPublicBinanceSquareTargets().find(
    (item) => item.squareUid === request.params.squareUid
  );
  if (!target) {
    return response.status(404).json({ error: "Binance Square profile not found" });
  }
  return response.json({ target });
});

app.patch("/v1/binance-square/targets/:squareUid", requireScrapeToken, (request, response) => {
  const update = {};
  if (request.body?.pollIntervalSeconds !== undefined) {
    if (![2, 15, 30].includes(Number(request.body.pollIntervalSeconds))) {
      return response.status(400).json({
        error: "pollIntervalSeconds must be 2, 15, or 30",
      });
    }
    update.pollIntervalSeconds = Number(request.body.pollIntervalSeconds);
  }
  if (request.body?.enabled !== undefined) {
    if (typeof request.body.enabled !== "boolean") {
      return response.status(400).json({ error: "enabled must be a boolean" });
    }
    update.enabled = request.body.enabled;
  }
  if (!Object.keys(update).length) {
    return response.status(400).json({
      error: "At least one profile setting is required",
    });
  }
  const target = updateBinanceSquareTarget(request.params.squareUid, update);
  if (!target) {
    return response.status(404).json({ error: "Binance Square profile not found" });
  }
  return response.json({ target });
});

app.delete("/v1/binance-square/targets/:squareUid", requireScrapeToken, (request, response) => {
  const existing = statements.getBinanceSquareTarget.get(request.params.squareUid);
  if (!existing) {
    return response.status(404).json({ error: "Binance Square profile not found" });
  }
  statements.deleteBinanceSquareTarget.run(request.params.squareUid);
  return response.status(204).end();
});

app.get("/v1/watchlist", requireScrapeToken, (_request, response) => {
  response.json(getWatchlist());
});

app.post("/v1/observations", requireScrapeToken, async (request, response) => {
  const items = request.body?.items;
  if (!Array.isArray(items)) {
    return response.status(400).json({ error: "items must be an array" });
  }
  if (items.length > 200) {
    return response.status(400).json({ error: "items is limited to 200 per request" });
  }
  const result = await applyObservations(request.body);
  return response.json(result);
});

app.get("/pump/assets/:key", (request, response) => {
  const file = getPumpAssetFile(request.params.key);
  if (!file) return response.status(404).send("Asset not found.");
  response.setHeader("cache-control", "public, max-age=86400, immutable");
  return response.sendFile(file.absolutePath, {
    headers: { "content-type": file.contentType },
  });
});

app.get("/pump/updates/:updateId", (request, response) => {
  const update = statements.getPumpUpdate.get(request.params.updateId);
  if (!update) return response.status(404).send("Pump app update not found.");

  let changes = [];
  try {
    changes = JSON.parse(update.changes_json);
  } catch {
    return response.status(500).send("Saved Pump app update is invalid.");
  }

  const assetsByKey = getPumpAssetsByKeys(collectAssetKeys(changes));
  return response.render("pump-update", {
    update,
    groups: decoratePumpChangeGroups(groupPumpChanges(changes), assetsByKey),
  });
});

app.get("/reports", (_request, response) => {
  response.render("reports", {
    reports: statements.recentAlertReports.all(500),
  });
});

app.get("/reports/:reportId", (request, response) => {
  const report = statements.getAlertReport.get(request.params.reportId);
  if (!report) return response.status(404).send("Update report not found.");

  let payload;
  try {
    payload = JSON.parse(report.payload_json);
  } catch {
    return response.status(500).send("Saved update report is invalid.");
  }
  if (!payload.sourceUrl && report.kind === "binance") {
    const suffix = " · Binance UI changes";
    const namespace = report.title.endsWith(suffix)
      ? report.title.slice(0, -suffix.length)
      : "";
    if (namespace) payload.sourceUrl = getBinanceNamespaceUrl(namespace);
  }

  return response.render("report", { report, payload });
});

if (process.env.DASHBOARD_PASSWORD) {
  app.use((request, response, next) => {
    const [scheme, encoded = ""] = (request.headers.authorization || "").split(" ");
    const provided = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
    const expected = process.env.DASHBOARD_PASSWORD;
    const valid =
      scheme === "Basic" &&
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

    if (valid) return next();
    response.set("WWW-Authenticate", 'Basic realm="PagePulse"');
    return response.status(401).send("Authentication required.");
  });
}

app.get("/", (request, response) => {
  const webhook = getSetting("discord_webhook_url");
  const ctStatus = getCtStatus();
  response.render("index", {
    sites: statements.listSites.all().map((site) => ({
      ...site,
      playbook: getPlaybook(canonicalSiteHostname(site.hostname) || site.hostname),
    })),
    recentUrls: statements.recentUrls.all(30),
    recentSubdomains: statements.recentSubdomains.all(30),
    ctStatus,
    githubTargets: statements.listGithubTargets.all(),
    recentGithubItems: statements.recentGithubItems.all(20),
    binanceNamespaces: statements.listBinanceNamespaces.all(),
    recentBinanceChanges: statements.recentBinanceChanges.all(30),
    binanceChangeCount: statements.countBinanceChanges.get().count,
    binanceEnabled: isBinanceEnabled(),
    pumpState: statements.getPumpState.get(),
    recentPumpUpdates: statements.recentPumpUpdates.all(10),
    pumpUpdateCount: statements.countPumpUpdates.get().count,
    pumpEnabled: isPumpEnabled(),
    robinhoodState: statements.getRobinhoodState.get(),
    recentRobinhoodPages: statements.recentRobinhoodPages.all(30),
    robinhoodPageCount: statements.countRobinhoodPages.get().count,
    robinhoodDiscoveryCount: statements.countRobinhoodDiscoveries.get().count,
    robinhoodEnabled: isRobinhoodEnabled(),
    youtubeChannels: statements.listYouTubeChannels.all(),
    recentYouTubeVideos: statements.recentYouTubeVideos.all(20),
    youtubeVideoCount: statements.countYouTubeVideos.get().count,
    youtubeDiscoveryCount: statements.countYouTubeDiscoveries.get().count,
    youtubeEnabled: isYouTubeEnabled(),
    binanceSquareTargets: statements.listBinanceSquareTargets.all(),
    recentBinanceSquarePosts: statements.recentBinanceSquarePosts.all(20),
    binanceSquarePostCount: statements.countBinanceSquarePosts.get().count,
    binanceSquareDiscoveryCount: statements.countBinanceSquareDiscoveries.get().count,
    binanceSquareEnabled: isBinanceSquareEnabled(),
    satellites: statements.listSatellites.all(),
    recentReports: statements.recentAlertReports.all(10),
    reportCount: statements.countAlertReports.get().count,
    webhookConfigured: Boolean(webhook),
    githubConfigured: Boolean(process.env.GITHUB_TOKEN),
    pollSeconds: WEBSITE_POLL_INTERVAL_MS / 1000,
    githubPollSeconds: GITHUB_POLL_INTERVAL_MS / 1000,
    binancePollSeconds: BINANCE_POLL_INTERVAL_MS / 1000,
    pumpPollSeconds: PUMP_POLL_INTERVAL_MS / 1000,
    robinhoodPollSeconds: ROBINHOOD_POLL_INTERVAL_MS / 1000,
    youtubePollSeconds: 15,
    message: request.query.message || "",
    error: request.query.error || "",
  });
});

app.get("/preview", (request, response) => {
  response.render("preview");
});

app.get("/logs", (request, response) => {
  const sites = statements.listSites.all();
  const githubTargets = statements.listGithubTargets.all();
  const requestedSiteId = Number(request.query.site);
  const requestedGithubId = Number(request.query.github);
  const selectedSite = sites.find((site) => site.id === requestedSiteId) || null;
  const selectedGithub =
    githubTargets.find((target) => target.id === requestedGithubId) || null;

  const websiteLogs = selectedGithub
    ? []
    : (selectedSite
        ? statements.siteLogs.all(selectedSite.id, 100)
        : statements.globalLogs.all(100)
      ).map((log) => ({
        ...log,
        targetName: log.nickname,
        targetUrl: `/logs?site=${log.site_id}`,
      }));
  const githubLogs = selectedSite
    ? []
    : (selectedGithub
        ? statements.targetGithubLogs.all(selectedGithub.id, 100)
        : statements.globalGithubLogs.all(100)
      ).map((log) => ({
        ...log,
        targetName: log.target_name,
        targetUrl: `/logs?github=${log.target_id}`,
      }));
  const logs = [...websiteLogs, ...githubLogs]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    .slice(0, 100);

  response.render("logs", {
    sites,
    githubTargets,
    selectedSite,
    selectedGithub,
    logs,
  });
});

app.post("/github-targets", (request, response) => {
  try {
    const parsed = parseGitHubTarget(request.body.target);
    const nickname = String(request.body.nickname || parsed.targetKey)
      .trim()
      .slice(0, 40);
    const result = statements.addGithubTarget.run(
      parsed.targetKey,
      parsed.kind,
      parsed.owner,
      parsed.repo,
      nickname || parsed.targetKey
    );
    scanGitHubTarget(Number(result.lastInsertRowid));
    response.redirect("/?message=GitHub target added. Building its baseline now.");
  } catch (error) {
    const message = String(error.message).includes("UNIQUE constraint failed")
      ? "That GitHub target is already being monitored."
      : error.message;
    response.redirect(`/?error=${encodeURIComponent(message)}`);
  }
});

app.post("/github-targets/:id/toggle", (request, response) => {
  statements.toggleGithubTarget.run(Number(request.params.id));
  response.redirect("/?message=GitHub target status updated.");
});

app.post("/github-targets/:id/scan", (request, response) => {
  scanGitHubTarget(Number(request.params.id));
  response.redirect("/?message=GitHub check started.");
});

app.post("/github-targets/:id/delete", (request, response) => {
  statements.deleteGithubTarget.run(Number(request.params.id));
  response.redirect("/?message=GitHub target removed.");
});

app.post("/sites/:id/toggle", (request, response) => {
  statements.toggleSite.run(Number(request.params.id));
  refreshCertspotterWatchlist();
  response.redirect("/?message=Site status updated.");
});

app.post("/sites/:id/scan", (request, response) => {
  const siteId = Number(request.params.id);
  scanWebsiteBySiteId(siteId, { force: true });
  scanCtSite(siteId);
  response.redirect("/?message=Scan started.");
});

app.post("/sites/:id/delete", (request, response) => {
  statements.deleteSite.run(Number(request.params.id));
  refreshCertspotterWatchlist();
  response.redirect("/?message=Site removed.");
});

app.post("/settings/webhook", (request, response) => {
  const value = String(request.body.webhook || "").trim();

  if (value) {
    try {
      const url = new URL(value);
      const validHost = ["discord.com", "discordapp.com"].includes(url.hostname);
      if (url.protocol !== "https:" || !validHost || !url.pathname.startsWith("/api/webhooks/")) {
        throw new Error();
      }
    } catch {
      return response.redirect("/?error=Enter a valid Discord webhook URL.");
    }
  }

  statements.setSetting.run("discord_webhook_url", value);
  return response.redirect(
    `/?message=${encodeURIComponent(value ? "Discord webhook saved." : "Discord webhook cleared.")}`
  );
});

app.post("/settings/webhook/clear", (request, response) => {
  statements.setSetting.run("discord_webhook_url", "");
  response.redirect("/?message=Discord webhook cleared.");
});

app.post("/binance/toggle", (request, response) => {
  const enabled = !isBinanceEnabled();
  statements.setSetting.run("binance_ui_enabled", enabled ? "1" : "0");
  if (enabled) scanBinanceUi();
  response.redirect(`/?message=Binance UI monitor ${enabled ? "resumed" : "paused"}.`);
});

app.post("/binance/scan", (request, response) => {
  scanBinanceUi(true);
  response.redirect("/?message=Binance UI check started.");
});

app.post("/pump/toggle", (request, response) => {
  const enabled = !isPumpEnabled();
  statements.setSetting.run("pump_app_enabled", enabled ? "1" : "0");
  if (enabled) scanPumpApp();
  response.redirect(`/?message=Pump app monitor ${enabled ? "resumed" : "paused"}.`);
});

app.post("/pump/scan", (request, response) => {
  scanPumpApp(true);
  response.redirect("/?message=Pump app check started.");
});

app.post("/robinhood/toggle", (request, response) => {
  const enabled = !isRobinhoodEnabled();
  statements.setSetting.run("robinhood_pages_enabled", enabled ? "1" : "0");
  if (enabled) scanRobinhood();
  response.redirect(
    `/?message=Robinhood page monitor ${enabled ? "resumed" : "paused"}.`
  );
});

app.post("/robinhood/scan", (request, response) => {
  scanRobinhood(true);
  response.redirect("/?message=Robinhood page check started.");
});

app.post("/youtube/toggle", (request, response) => {
  const enabled = !isYouTubeEnabled();
  statements.setSetting.run("youtube_enabled", enabled ? "1" : "0");
  response.redirect(`/?message=YouTube monitor ${enabled ? "resumed" : "paused"}.`);
});

app.post("/youtube/channels", async (request, response) => {
  try {
    const result = await addYouTubeChannelFromInput(request.body.channel);
    response.redirect(
      `/?message=${encodeURIComponent(
        `${result.channel.title}${
          result.created ? " added. Building its baseline now." : " is already tracked."
        }`
      )}`
    );
  } catch (error) {
    response.redirect(`/?error=${encodeURIComponent(error.message)}`);
  }
});

app.post("/youtube/channels/:channelId/scan", (request, response) => {
  scanYouTubeChannel(request.params.channelId, true).catch(() => undefined);
  response.redirect("/?message=YouTube check started.");
});

app.post("/youtube/channels/:channelId/toggle", (request, response) => {
  statements.toggleYouTubeChannel.run(request.params.channelId);
  response.redirect("/?message=YouTube channel status updated.");
});

app.post("/youtube/channels/:channelId/delete", (request, response) => {
  statements.deleteYouTubeChannel.run(request.params.channelId);
  response.redirect("/?message=YouTube channel removed.");
});

app.post("/binance-square/toggle", (request, response) => {
  const enabled = !isBinanceSquareEnabled();
  statements.setSetting.run("binance_square_enabled", enabled ? "1" : "0");
  response.redirect(
    `/?message=Binance Square monitor ${enabled ? "resumed" : "paused"}.`
  );
});

app.post("/binance-square/targets", async (request, response) => {
  try {
    const result = await addBinanceSquareTargetFromInput(request.body.profile);
    response.redirect(
      `/?message=${encodeURIComponent(
        `@${result.target.username}${
          result.created ? " added. Building its baseline now." : " is already tracked."
        }`
      )}`
    );
  } catch (error) {
    response.redirect(`/?error=${encodeURIComponent(error.message)}`);
  }
});

app.post("/binance-square/targets/:squareUid/scan", (request, response) => {
  scanBinanceSquareTarget(request.params.squareUid, true).catch(() => undefined);
  response.redirect("/?message=Binance Square check started.");
});

app.post("/binance-square/targets/:squareUid/toggle", (request, response) => {
  statements.toggleBinanceSquareTarget.run(request.params.squareUid);
  response.redirect("/?message=Binance Square profile status updated.");
});

app.post("/binance-square/targets/:squareUid/delete", (request, response) => {
  statements.deleteBinanceSquareTarget.run(request.params.squareUid);
  response.redirect("/?message=Binance Square profile removed.");
});

app.use((request, response) => response.status(404).send("Not found"));

const httpServer = http.createServer(app);
attachEventStream(httpServer);

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`PagePulse listening on http://localhost:${port}`);
  syncWebsitePlaybooks();
  refreshCertspotterWatchlist();
  startWebsiteScanner();
  startCtScanner();
  startGithubScanner();
  startBinanceScanner();
  startPumpScanner();
  startRobinhoodScanner();
  startYouTubeScanner();
  startBinanceSquareScanner();
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  httpServer.close();
  const forceExit = setTimeout(() => process.exit(1), 14_000);
  try {
    await stopCertspotterManager();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    console.error("[shutdown]", error.message);
    process.exit(1);
  }
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
