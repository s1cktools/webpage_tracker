# PagePulse

A small Node.js dashboard that watches a hardcoded list of website feeds, stores
discovered URLs in SQLite, and sends Discord webhook alerts for new pages.

## Run locally

```sh
npm install
npm start
```

Open `http://localhost:3000` and save a Discord webhook. Website targets are
hardcoded in `src/websites.js` — there is no add-a-domain form. On startup the
app upserts that watchlist, silently baselines each feed, and later discoveries
trigger alerts.
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
`spacex.com` will match `auth.spacex.com`. Adding `www.spacex.com` is treated as
the same site: the apex is stored once, `www` is not recorded as a subdomain,
and Cert Spotter watches `.spacex.com`. PagePulse runs the open-source
Cert Spotter monitor inside its container and tails the Chrome and Apple log
lists directly, including classic RFC 6962 and modern static-ct-api logs. The
initial silent baseline is seeded from [crt.name](https://crt.name/), a
deduplicated subdomain index built from the CT firehose plus historical sources.
That API is free and keyless at 100 requests per IP per day; the same budget is
shared by their MCP endpoint and by [subfaster](https://github.com/melvinsh/subfaster)'s
`crt` source. PagePulse calls the HTTP API directly, honors `X-Ratelimit-Remaining`,
and rechecks each site at most once per day. If crt.name is unavailable while a
site still needs a baseline, a crt.sh lookup is used as a fallback. Optional
`CRT_NAME_TOKEN` raises the limit if you are in their closed beta. No other CT
API key, public relay, or Railway variable is required.

New subdomains are stored separately from page URLs, shown on the dashboard,
sent to Discord, and emitted as `website_subdomain` events. DNS A/AAAA
resolution is checked after discovery and saved as context; an unresolved name
still alerts because a certificate can be logged before the host goes live.
Wildcard-only names such as `*.example.com` are not treated as concrete hosts.

Cert Spotter stores a cursor for every CT log under the same persistent data
directory as PagePulse. It resumes and catches up after restarts without losing
entries, reloads the browser log lists, audits append-only consistency, and
reports lag or log failures through the dashboard. The tracked-domain watchlist
is rebuilt whenever the hardcoded watchlist is synced or a site is paused or
resumed. A daily
Cert Spotter test certificate silently exercises the full local hook path.

If crt.name is temporarily unavailable, direct monitoring still activates after
that first baseline attempt; the historical baseline is filled silently when
crt.name recovers, or from crt.sh if a fallback lookup succeeds.

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

For lower CDN detection latency, the same repository can also run stateless
`binance-probe` services in other regions. Despite the legacy role name, each
probe runs both the Binance and Pump pollers plus a health endpoint. It forwards
changed snapshots and Expo manifests to the primary service, which rejects
stale versions, deduplicates updates, stores the resulting data, and remains the
only service that emits Socket.IO and Discord alerts.

## Pump app monitoring

The Pump monitor checks the Android `mainnet` Expo update channel every five
seconds. It silently saves the current OTA release as a baseline, then alerts on
each new update ID. When the launch bundle changes, it compares extracted API
hosts, app routes, UI text hints, and asset keys. The current runtime is
discovered automatically from Google Play every ten minutes. The optional
`PUMP_RUNTIME_VERSION` variable exists only as an emergency override. Each
saved update has a readable `/pump/updates/:updateId` detail page. Railway
builds event links automatically; set `WEBPAGE_TRACKER_PUBLIC_URL` when using
another host. Regional probes use the same Expo update ID deduplication and
forward new manifests to the primary, where bundles and image assets are
downloaded once.

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

1. Deploy this repository as the primary Railway service. Railway builds the included
   Dockerfile, which pins Cert Spotter `v0.24.2`.
2. Add a persistent volume mounted at `/data`.
3. Set `DASHBOARD_PASSWORD` to protect the public dashboard with HTTP Basic Auth.
4. Set `GITHUB_TOKEN` if GitHub monitoring will be used.
5. Optionally set `CRT_NAME_TOKEN` if you have crt.name closed-beta access.
6. Generate a strong `BINANCE_PROBE_SECRET` and a Railway domain for the service.

To add regional Binance and Pump probes, create two more Railway services from
the same repository in different regions. Do not attach volumes. Set these
variables on each probe:

```text
APP_ROLE=binance-probe
BINANCE_PROBE_SECRET=the-same-secret-as-primary
```

Set `BINANCE_PROBE_SECRET` once as a shared Railway variable available to the
primary and probes. The probe ID comes from its Railway service name, and the
primary defaults to `https://webtracker.up.railway.app`. `PRIMARY_URL` and
`PROBE_ID` remain available only as optional overrides. Probe services do not
need `DATA_DIR`, `DASHBOARD_PASSWORD`, `GITHUB_TOKEN`, `EVENT_STREAM_TOKEN`, or
a Discord webhook.

The image stores primary data under `/data`. Run only one primary replica
because the scanners and Cert Spotter supervisor run inside the web process and
SQLite is a single-file database. Its volume preserves both `tracker.db` and
Cert Spotter's per-log cursor state. Additional services must use
`APP_ROLE=binance-probe`, not another primary replica.

## Website playbooks

Each watched site has a hardcoded feed list in `src/websites.js`. The generic
“add any domain” crawler is gone. To watch another host, add a playbook there
and restart. Trailing-slash and no-slash versions of the same path are stored
once.

| Site | What we poll |
| --- | --- |
| OpenAI | [news RSS](https://openai.com/news/rss.xml) + every `/sitemap.xml/{category}/` file |
| SpaceX | [updates CMS JSON](https://content.spacex.com/api/spacex-website/updates) — HTML has no sitemap |
| BNB Chain | blog sitemap (posts) + `sitemap-0.xml` + opbnb/greenfield sitemaps. No RSS. |
| White House | six category RSS feeds (news, articles, actions, briefings, fact sheets, remarks) plus `post-sitemap{,2,3}.xml` and `page-sitemap.xml`. Taxonomy/gallery/EOP sitemaps are skipped. |
| Grok | `/sitemap.xml` — eight product pages, no blog |
| x.ai | `/news` HTML listing (server-rendered) + site sitemap + [docs.x.ai sitemap](https://docs.x.ai/sitemap.xml). No official RSS. |
| pump.fun | marketing `/sitemap.xml` (docs have no XML; the mobile app has its own monitor) |
| Solana | [news RSS](https://solana.com/news/rss.xml) + news sitemap + podcasts sitemap + full site sitemap (English paths only) |
| Anthropic | `/news` HTML listing + one live sitemap (news, engineering, research). No official RSS. |
| Claude | `/blog` HTML listing + site sitemap + docs sitemap (English paths only) |

Certificate Transparency still watches subdomains of these roots. Completely
hidden or unlisted URLs cannot be discovered.
