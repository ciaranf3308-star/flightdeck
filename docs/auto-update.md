# FlightDeck auto-update

The installed Windows app can update itself — no manual download.

## How it works

1. **Check**: on startup (30 s after launch, then every 24 h) and on demand from
   Settings → App updates, the API fetches the configured update feed.
2. **Feed** (`latest.json` over HTTPS):
   ```json
   {
     "version": "0.2.1",
     "url": "https://example.com/flightdeck/FlightDeck-Setup-0.2.1.exe",
     "sha256": "<64 hex chars>",
     "notes": "What changed"
   }
   ```
3. **Download**: the API downloads the installer and verifies its SHA-256 against
   the feed. A hash mismatch deletes the file and aborts — nothing executes.
4. **Apply** (Windows only): the API launches the installer with `/S` (silent —
   no UAC prompt, it's a per-user install) and shuts down. The installer stops
   the running backend first (files would otherwise be locked), replaces the
   bundle, and reopens FlightDeck automatically. Saved flights and settings live
   in the local SQLite DB, which the installer never touches.

The UI shows a banner when an update is available; Settings → App updates has
Download and **Install & restart** buttons, plus the feed URL and auto-check toggle.

## Feed requirements

- Served over **https://** (`http://localhost` allowed for testing only).
- The download URL must also be https://.
- Bump `version` in the root `package.json` before building — the installer,
  the bundled API (`/api/health`), and the feed's `version` must all agree,
  otherwise the app will either miss the update or loop on it.

## Hosting the feed

The updater is fully built, but the feed needs a stable HTTPS home.
Recommended: **GitHub Releases** in a FlightDeck repo.

One command publishes a release (builds the installer, hashes it, writes
`latest.json`, creates the GitHub release with both files as assets):

```bash
./installer/publish-release.sh owner/repo "What's new in 0.2.2"
```

The app's feed URL is then:

```
https://github.com/owner/repo/releases/latest/download/latest.json
```

Two ways to point the app at it:

1. **Per install**: paste it once in Settings → App updates → Update feed URL.
2. **Baked in**: set `"url"` in `installer/update-feed.json` before building —
   every install from that build phones home automatically (an explicit setting
   still overrides it; unchecking "Check automatically" opts out).

Until a feed URL exists anywhere, the updater stays dormant: no checks, no
banners, no network traffic.

## Security notes

- No code signing yet: the SHA-256 check is the integrity mechanism. Only point
  the feed at hosting you control, over HTTPS.
- `POST /api/update/apply` is Windows-only (501 elsewhere) and only runs a
  previously hash-verified download.
- The update check never sends anything out — it's a plain GET of latest.json.
