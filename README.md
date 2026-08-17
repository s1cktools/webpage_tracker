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

The built-in Binance monitor checks the discovered English UI translation
namespaces every five seconds. It uses ETags, silently saves the first JSON
snapshot, then compares individual keys and values. Discord alerts summarize
added, modified, and removed UI strings and include a limited set of changed
lines. The dashboard can pause the monitor, trigger a manual check, and display
recent changes or endpoint errors.

## Ansem coin monitoring

The built-in Ansem monitor polls `https://ansem.io/api/coins` every second.
Its first successful response is stored silently as a baseline. Each newly
observed mint then triggers the configured Discord webhook and an `ansem_coin`
stream event containing the complete contract address. Set
`ANSEM_POLL_INTERVAL_MS` to override the interval (minimum 250ms).

## Event stream

Set `EVENT_STREAM_TOKEN` to expose an authenticated Socket.IO namespace at
`/events` on the app's existing URL. Every post-baseline website, GitHub, or
Binance discovery is broadcast as `tracker_event` in this minimal shape:

```json
{
  "event_id": "67a68fa2-55c8-45d9-9419-a341c6119742",
  "event_type": "website_page",
  "detected_at": "2026-08-17T13:33:04.215Z",
  "data": {}
}
```

The supported event types are `website_page`, `github_commit`,
`github_repository`, `binance_ui`, and `ansem_coin`. A data server can subscribe with:

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
unlinked URLs cannot be discovered reliably.
