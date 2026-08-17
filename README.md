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

## Railway

1. Deploy this repository as a Railway service.
2. Add a persistent volume mounted at `/data`.
3. Set `DATA_DIR=/data`.
4. Set `DASHBOARD_PASSWORD` to protect the public dashboard with HTTP Basic Auth.
5. Generate a Railway domain for the service.

The app uses Railway's `PORT` automatically. Run only one replica because the
scanner runs inside the web process and SQLite is a single-file database.

## Discovery limits

There is no universal API listing every URL on a domain. PagePulse detects URLs
exposed in sitemaps or linked from inspected public pages. Completely hidden or
unlinked URLs cannot be discovered reliably.
