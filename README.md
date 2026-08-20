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

## Certificate subdomain monitoring

Every enabled website also watches Certificate Transparency for newly issued
certificate hostnames below its tracked root. For example, a tracked
`spacex.com` will match `auth.spacex.com`. A shared public CT stream provides
near-real-time updates, while a rate-limited crt.sh sweep builds the initial
silent baseline and catches stream gaps every six hours. No API key or Railway
variable is required.

New subdomains are stored separately from page URLs, shown on the dashboard,
sent to Discord, and emitted as `website_subdomain` events. DNS A/AAAA
resolution is checked after discovery and saved as context; an unresolved name
still alerts because a certificate can be logged before the host goes live.
Wildcard-only names such as `*.example.com` are not treated as concrete hosts.

The public stream has no uptime guarantee. The watcher reconnects with backoff,
detects stale connections, and uses crt.sh as its recovery source. If crt.sh is
temporarily unavailable, live alerts still activate after that first attempt;
the historical baseline is filled silently when crt.sh recovers.

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

1. Deploy this repository as a Railway service.
2. Add a persistent volume mounted at `/data`.
3. Set `DATA_DIR=/data`.
4. Set `DASHBOARD_PASSWORD` to protect the public dashboard with HTTP Basic Auth.
5. Set `GITHUB_TOKEN` if GitHub monitoring will be used.
6. Generate a Railway domain for the service.

The app uses Railway's `PORT` automatically. Run only one replica because the
scanner runs inside the web process and SQLite is a single-file database.

## Discovery limits

There is no universal API listing every URL on a domain. PagePulse detects URLs
exposed in sitemaps or linked from inspected public pages. Completely hidden or
unlinked URLs cannot be discovered reliably. Certificate Transparency improves
subdomain discovery but only covers hostnames included in publicly logged TLS
certificates; it is not a complete DNS inventory.
