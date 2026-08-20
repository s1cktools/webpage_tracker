# PagePulse

A small Node.js dashboard that watches website sitemaps and public links, stores
discovered URLs in SQLite, and sends batched Discord webhook alerts for new URLs.

## Run locally

```sh
npm install
npm start
```

Open `http://localhost:3000`, save a Discord webhook, and add a website. The
first scan silently records existing URLs; later discoveries trigger alerts.
The web app and periodic scanners run directly with Node. The direct
Certificate Transparency monitor is included in the production Docker image;
use Docker locally when testing that process end to end:

```sh
docker build -t pagepulse .
docker run --rm -p 3000:3000 -v pagepulse-data:/data pagepulse
```

## Certificate subdomain monitoring

Every enabled website also watches Certificate Transparency for newly issued
certificate hostnames below its tracked root. For example, a tracked
`spacex.com` will match `auth.spacex.com`. PagePulse runs the open-source
Cert Spotter monitor inside its container and tails the Chrome and Apple log
lists directly, including classic RFC 6962 and modern static-ct-api logs. A
rate-limited crt.sh sweep builds the initial silent baseline and runs every six
hours as an independent historical cross-check. No CT API key, public relay, or
Railway variable is required.

New subdomains are stored separately from page URLs, shown on the dashboard,
sent to Discord, and emitted as `website_subdomain` events. DNS A/AAAA
resolution is checked after discovery and saved as context; an unresolved name
still alerts because a certificate can be logged before the host goes live.
Wildcard-only names such as `*.example.com` are not treated as concrete hosts.

Cert Spotter stores a cursor for every CT log under the same persistent data
directory as PagePulse. It resumes and catches up after restarts without losing
entries, reloads the browser log lists, audits append-only consistency, and
reports lag or log failures through the dashboard. The tracked-domain watchlist
is rebuilt whenever a site is added, paused, resumed, or removed. A daily
Cert Spotter test certificate silently exercises the full local hook path.

If crt.sh is temporarily unavailable, direct monitoring still activates after
that first baseline attempt; the historical baseline is filled silently when
crt.sh recovers.

## GitHub monitoring

Set `GITHUB_TOKEN`, then add either a GitHub username or an `owner/repository`
from the dashboard. Repository targets watch commits on the default branch.
User targets watch for newly created repositories. Existing commits or
repositories are saved as a silent baseline before alerts begin.

For public data, a classic personal access token needs no extra scopes. A
fine-grained token needs read access to metadata and contents. Private
repositories require the token to have access to those repositories.

GitHub targets are checked every five seconds. The watcher sends stored ETags
with each request, accepts `304 Not Modified` responses, and pauses when GitHub
reports that a rate limit has been reached.

## Binance UI monitoring

The built-in Binance monitor checks 39 English web UI translation namespaces
and the native app's 27,000+ string XML bundle every five seconds. It uses
ETags, silently saves the first snapshot, then compares individual keys and
values. Discord alerts summarize added, modified, and removed UI strings and
include a limited set of changed lines. The dashboard can pause the monitor,
trigger a manual check, and display recent changes or endpoint errors.

## Pump app monitoring

The Pump monitor checks the Android `mainnet` Expo update channel every five
seconds. It silently saves the current OTA release as a baseline, then alerts on
each new update ID. When the launch bundle changes, it compares extracted API
hosts, app routes, UI text hints, and asset keys. The current runtime is
discovered automatically from Google Play every ten minutes. The optional
`PUMP_RUNTIME_VERSION` variable exists only as an emergency override. Each
saved update has a readable `/pump/updates/:updateId` detail page. Railway
builds event links automatically; set `WEBPAGE_TRACKER_PUBLIC_URL` when using
another host.

## Event stream

Set `EVENT_STREAM_TOKEN` to expose an authenticated Socket.IO namespace at
`/events` on the app's existing URL. Every post-baseline website page, website
subdomain, GitHub, Binance, or Pump discovery is broadcast as `tracker_event`:

```json
{
  "event_id": "67a68fa2-55c8-45d9-9419-a341c6119742",
  "event_type": "website_page",
  "detected_at": "2026-08-17T13:33:04.215Z",
  "data": {}
}
```

The supported event types are `website_page`, `website_subdomain`, `github_commit`,
`github_repository`, `binance_ui`, and `pump_app_update`. A data server can
subscribe with:

```js
import { io } from "socket.io-client";

const socket = io("https://your-watcher.example/events", {
  transports: ["websocket"],
  auth: { token: process.env.WEBPAGE_TRACKER_TOKEN },
});

socket.on("tracker_event", (event) => {
  // Forward event to the data server's connected clients.
});
```

The stream intentionally has no queue or replay. Events emitted while no
subscriber is connected are not retained for later delivery. Discord delivery
continues independently.

See [EVENT_STREAM.md](EVENT_STREAM.md) for the complete listener setup and
event payloads.

## Railway

1. Deploy this repository as a Railway service. Railway builds the included
   Dockerfile, which pins Cert Spotter `v0.24.2`.
2. Add a persistent volume mounted at `/data`.
3. Set `DASHBOARD_PASSWORD` to protect the public dashboard with HTTP Basic Auth.
4. Set `GITHUB_TOKEN` if GitHub monitoring will be used.
5. Generate a Railway domain for the service.

The image already stores data under `/data` and Railway refuses to deploy it
without that volume. The app uses Railway's `PORT` automatically. Run only one replica because the
scanners and Cert Spotter supervisor run inside the web process and SQLite is a
single-file database. The volume preserves both `tracker.db` and Cert Spotter's
per-log cursor state.

## Discovery limits

There is no universal API listing every URL on a domain. PagePulse detects URLs
exposed in sitemaps or linked from inspected public pages. Completely hidden or
unlinked URLs cannot be discovered reliably. Certificate Transparency improves
subdomain discovery but only covers hostnames included in publicly logged TLS
certificates; it is not a complete DNS inventory.
