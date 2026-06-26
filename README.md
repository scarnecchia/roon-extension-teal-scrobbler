# teal.fm Scrobbler for Roon

A Roon extension that scrobbles qualifying plays to your PDS as
`fm.teal.alpha.feed.play` records via the AT Protocol.

## How it works

```
┌────────────┐   subscribe_zones   ┌──────────────────────┐   createRecord    ┌───────────┐
│  Roon Core │ ──────────────────▶ │  Roon Extension      │ ────────────────▶ │  Your PDS │
│ (transport)│  zone deltas +      │  • zone allowlist    │  fm.teal.alpha.   │ (Bluesky) │
└────────────┘  now_playing        │  • progress tracker  │  feed.play        └───────────┘
                                   │  • teal.fm client    │
                                   │  • retry queue       │
                                   └──────────────────────┘
                                            (app password auth)
```

1. **Zone subscription** — Subscribes to Roon's transport service to receive
   real-time playback updates for all zones.
2. **Allowlist filter** — Only tracks zones you select (or all zones if none
   selected). Grouped zones are deduplicated so a grouped play counts once.
3. **Scrobble threshold** — Uses the teal.fm lexicon rule: a play qualifies
   when you've listened to the longest of (a) the entire track if under 2 min,
   or (b) half the track up to 4 min.
4. **Submission** — Qualifying plays are submitted to your PDS via
   `com.atproto.repo.createRecord` using a Bluesky app password.
5. **Retry queue** — Failed submissions are persisted to disk and retried with
   exponential backoff so you never lose a scrobble during downtime.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (tested on Node 25)
- A Roon Core running on your network
- A Bluesky account with an [app password](https://bsky.app/settings/app-passwords)

## Installation

```bash
git clone <repo-url>
cd teal-fm-roon
npm install
```

## Running

```bash
npm start
# or
node src/index.js
```

The extension will start discovering Roon cores on your network. In Roon, go to
**Settings → Extensions** and enable the **teal.fm Scrobbler**.

## Configuration

All settings are configured through the Roon app under **Settings → Extensions →
teal.fm Scrobbler → Settings**:

| Setting | Description |
|---|---|
| **Tracked zones** | Comma-separated zone IDs to track. Leave empty to track ALL zones. |
| **Zone slot 1–8** | Pick specific zones from a dropdown (alternative to comma-separated IDs). |
| **Bluesky Handle** | Your Bluesky handle (e.g. `user.bsky.social`). |
| **Bluesky App Password** | An app password from [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords). **Not** your account password. |
| **Music Service Domain** | Base domain of your music service. Defaults to `local`. |

### Getting an app password

1. Go to <https://bsky.app/settings/app-passwords>
2. Click **Add App Password**
3. Name it "Roon Scrobbler"
4. Copy the generated password into the extension settings

## Architecture

### Modules

| File | Responsibility |
|---|---|
| `src/index.js` | Entry point — Roon extension setup, settings, event wiring |
| `src/zone-watcher.js` | Subscribes to Roon transport zones, emits granular events |
| `src/allowlist.js` | Zone filtering + grouped-zone dedup |
| `src/progress-tracker.js` | Per-zone listened-seconds state machine + threshold logic |
| `src/teal-client.js` | AT Protocol submission client (handle → DID → PDS → createRecord) |
| `src/retry-queue.js` | Disk-persisted retry queue with exponential backoff |

### Scrobble threshold rule

A play qualifies for scrobbling when the listener has heard the **longest** of:

- The entire track (if shorter than 2 minutes), or
- Half the track duration (capped at 4 minutes)

```
threshold = max(min(duration, 120), min(duration / 2, 240))
```

| Track length | Threshold |
|---|---|
| 90s | 90s (whole track) |
| 200s | 120s (2 min) |
| 600s | 240s (4 min) |

### Event pipeline

```
Roon Core
  → ZoneWatcher.subscribe_zones()
    → ZoneAllowlist.attach(watcher)     [filter + dedup]
    → ProgressTracker.attach(watcher)   [accumulate listened time]
      → "qualified_play" event
        → TealClient.submit()           [createRecord to PDS]
          → on failure → RetryQueue     [persist + backoff]
```

## Field mapping (Roon → teal.fm)

| teal.fm field | Roon source | Notes |
|---|---|---|
| `trackName` | `now_playing.three_line.line2` | Required |
| `artists[].artistName` | `now_playing.three_line.line1` | Parsed on `,`, `&`, `feat.` |
| `releaseName` | `now_playing.three_line.line3` | |
| `duration` | `now_playing.length` | Integer seconds |
| `playedTime` | `new Date().toISOString()` | At threshold crossing |
| `submissionClientAgent` | `fm.teal.roon-scrobbler/0.1.0` | |
| `musicServiceBaseDomain` | Settings (default: `local`) | |

> **Note:** MbIDs and ISRCs are not available from the Roon transport API and
> are omitted in this MVP.

## License

Apache-2.0
