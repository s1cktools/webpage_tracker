const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const { getSetting, pruneDiscoveredUrls, statements } = require("./db");
const {
  BINANCE_POLL_INTERVAL_MS,
  isBinanceEnabled,
  scanBinanceUi,
  startBinanceScanner,
} = require("./binance-scanner");
const { isTranslatedUrl, normalizeSiteUrl } = require("./discovery");
const { attachEventStream } = require("./event-stream");
const { getCtStatus, scanCtSite, startCtScanner } = require("./ct-scanner");
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
const { groupPumpChanges } = require("./pump");
const { POLL_INTERVAL_MS, scanSite, startScanner } = require("./scanner");

const app = express();
const port = Number(process.env.PORT) || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (request, response) => {
  response.status(200).send("ok");
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

  return response.render("pump-update", {
    update,
    groups: groupPumpChanges(changes),
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
    sites: statements.listSites.all(),
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
    recentReports: statements.recentAlertReports.all(10),
    reportCount: statements.countAlertReports.get().count,
    webhookConfigured: Boolean(webhook),
    githubConfigured: Boolean(process.env.GITHUB_TOKEN),
    pollSeconds: POLL_INTERVAL_MS / 1000,
    githubPollSeconds: GITHUB_POLL_INTERVAL_MS / 1000,
    binancePollSeconds: BINANCE_POLL_INTERVAL_MS / 1000,
    pumpPollSeconds: PUMP_POLL_INTERVAL_MS / 1000,
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

app.post("/sites", (request, response) => {
  try {
    const url = normalizeSiteUrl(request.body.url);
    const hostname = new URL(url).hostname;
    const nickname = String(request.body.nickname || hostname)
      .trim()
      .slice(0, 40);
    const result = statements.addSite.run(url, hostname, nickname || hostname);
    scanSite(Number(result.lastInsertRowid));
    scanCtSite(Number(result.lastInsertRowid));
    response.redirect("/?message=Site added. Building its baseline now.");
  } catch (error) {
    const message =
      String(error.message).includes("UNIQUE constraint failed")
        ? "That site is already being tracked."
        : error.message;
    response.redirect(`/?error=${encodeURIComponent(message)}`);
  }
});

app.post("/sites/:id/toggle", (request, response) => {
  statements.toggleSite.run(Number(request.params.id));
  response.redirect("/?message=Site status updated.");
});

app.post("/sites/:id/locales", (request, response) => {
  const siteId = Number(request.params.id);
  statements.toggleLocales.run(siteId);
  const site = statements.getSite.get(siteId);
  const removed = site?.ignore_locales
    ? pruneDiscoveredUrls(siteId, isTranslatedUrl)
    : 0;
  response.redirect(
    `/?message=${encodeURIComponent(
      site?.ignore_locales
        ? `English-only enabled. Removed ${removed} translated URLs.`
        : "All languages enabled."
    )}`
  );
});

app.post("/sites/:id/scan", (request, response) => {
  const siteId = Number(request.params.id);
  scanSite(siteId);
  scanCtSite(siteId);
  response.redirect("/?message=Scan started.");
});

app.post("/sites/:id/delete", (request, response) => {
  statements.deleteSite.run(Number(request.params.id));
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

app.use((request, response) => response.status(404).send("Not found"));

const httpServer = http.createServer(app);
attachEventStream(httpServer);

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`PagePulse listening on http://localhost:${port}`);
  startScanner();
  startCtScanner();
  startGithubScanner();
  startBinanceScanner();
  startPumpScanner();
});
