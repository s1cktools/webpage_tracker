const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const { getSetting, statements } = require("./db");
const { normalizeSiteUrl } = require("./discovery");
const { POLL_INTERVAL_MS, scanSite, startScanner } = require("./scanner");

const app = express();
const port = Number(process.env.PORT) || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "..", "public")));

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
  response.render("index", {
    sites: statements.listSites.all(),
    recentUrls: statements.recentUrls.all(30),
    webhookConfigured: Boolean(webhook),
    pollSeconds: POLL_INTERVAL_MS / 1000,
    message: request.query.message || "",
    error: request.query.error || "",
  });
});

app.post("/sites", (request, response) => {
  try {
    const url = normalizeSiteUrl(request.body.url);
    const hostname = new URL(url).hostname;
    const result = statements.addSite.run(url, hostname);
    scanSite(Number(result.lastInsertRowid));
    response.redirect("/?message=Site added. Building its baseline now.");
  } catch (error) {
    const message =
      error.code === "SQLITE_CONSTRAINT_UNIQUE"
        ? "That site is already being tracked."
        : error.message;
    response.redirect(`/?error=${encodeURIComponent(message)}`);
  }
});

app.post("/sites/:id/toggle", (request, response) => {
  statements.toggleSite.run(Number(request.params.id));
  response.redirect("/?message=Site status updated.");
});

app.post("/sites/:id/scan", (request, response) => {
  scanSite(Number(request.params.id));
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

app.use((request, response) => response.status(404).send("Not found"));

app.listen(port, "0.0.0.0", () => {
  console.log(`PagePulse listening on http://localhost:${port}`);
  startScanner();
});
