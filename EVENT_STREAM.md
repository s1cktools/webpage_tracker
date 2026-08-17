# Event stream listener

## Configuration

The webpage tracker must have this Railway variable:

```env
EVENT_STREAM_TOKEN=your_shared_secret
```

The data server needs:

```env
WEBPAGE_TRACKER_URL=https://your-tracker.up.railway.app
WEBPAGE_TRACKER_TOKEN=your_shared_secret
```

Both token values must match.

## Connect

Install the Socket.IO client in the data server:

```sh
npm install socket.io-client
```

Connect to the `/events` namespace and listen for `tracker_event`:

```js
const { io } = require("socket.io-client");

const tracker = io(`${process.env.WEBPAGE_TRACKER_URL}/events`, {
  transports: ["websocket"],
  auth: {
    token: process.env.WEBPAGE_TRACKER_TOKEN,
  },
});

tracker.on("connect", () => {
  console.log("Connected to webpage tracker");
});

tracker.on("tracker_event", (event) => {
  // Forward this event through the data server's existing client feed.
  console.log(event);
});

tracker.on("connect_error", (error) => {
  console.error("Webpage tracker connection failed:", error.message);
});

tracker.on("disconnect", (reason) => {
  console.log("Webpage tracker disconnected:", reason);
});
```

Socket.IO reconnects automatically.

## Event envelope

Every event has exactly four top-level fields:

```json
{
  "event_id": "67a68fa2-55c8-45d9-9419-a341c6119742",
  "event_type": "website_page",
  "detected_at": "2026-08-17T13:33:04.215Z",
  "data": {}
}
```

## Event types

### `website_page`

```json
{
  "website_name": "OpenAI",
  "hostname": "openai.com",
  "title": "Introducing GPT-6",
  "url": "https://openai.com/index/introducing-gpt-6/",
  "discovery_source": "sitemap"
}
```

### `github_commit`

```json
{
  "owner": "openai",
  "repository": "codex",
  "commit_sha": "abc123",
  "title": "Add repository monitoring",
  "author": "octocat",
  "url": "https://github.com/openai/codex/commit/abc123",
  "committed_at": "2026-08-17T13:30:00.000Z"
}
```

### `github_repository`

```json
{
  "owner": "openai",
  "repository": "new-project",
  "description": "A newly published project.",
  "url": "https://github.com/openai/new-project",
  "created_at": "2026-08-17T13:31:00.000Z"
}
```

### `binance_ui`

```json
{
  "namespace": "activity-ui",
  "locale": "en",
  "url": "https://bin.bnbstatic.com/api/i18n/-/web/cms/en/activity-ui",
  "changes": [
    {
      "change_type": "added",
      "key": "financialstore-page-title",
      "new_value": "Financial Store"
    },
    {
      "change_type": "changed",
      "key": "financialstore-guide-title",
      "old_value": "Discover",
      "new_value": "Explore"
    },
    {
      "change_type": "removed",
      "key": "old-feature-title",
      "old_value": "Old Feature"
    }
  ]
}
```

There is no replay. Events emitted while the data server is disconnected are
not sent later.
