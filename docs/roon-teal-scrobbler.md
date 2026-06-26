# Roon → teal.fm Scrobbler Extension — Brainstorm & Issue Plan

## Goal

Save the complete brainstorm + Linear issue breakdown for a Roon → teal.fm scrobbler extension to
disk as `docs/roon-teal-scrobbler.md` so it persists across a session restart. This is a
documentation/notes file only — no code implementation in this handoff.

(Background: Linear MCP server is currently `server_unavailable`, so issues could not be created
directly. These notes are the artifact to track until Linear is back.)

## Locked design decisions

- **Auth:** Bluesky **app password** (handle + app password). Matches every existing teal.fm client (teal-cider, malachite, multi-scrobbler).
- **Scrobble threshold:** implement the **lexicon rule** — entire track if <2 min, else half up to 4 min, whichever is longest. Requires a per-zone progress state machine.
- **Zone handling:** **configurable allowlist** of zones to track, with grouped-zone dedup.
- **Linear structure:** one **Epic + sub-issues** per workstream.

## Architecture

```
┌────────────┐   subscribe_zones   ┌──────────────────────┐   createRecord    ┌───────────┐
│  Roon Core │ ──────────────────▶ │  Roon Extension      │ ────────────────▶ │  Your PDS │
│ (transport)│  zone deltas +      │  • zone allowlist    │  fm.teal.alpha.   │ (Bluesky) │
└────────────┘  now_playing        │  • progress tracker  │  feed.play        └───────────┘
                                   │  • teal.fm client    │
                                   └──────────────────────┘
                                            (app password auth)
```

- Node.js, `node-roon-api` + `node-roon-api-transport`, HTTP client for `com.atproto.repo.createRecord`.
- Single long-running process.

## Field mapping (Roon → teal.fm play record)

| teal.fm field | Source | Notes |
|---|---|---|
| `trackName` | `now_playing.three_line.line2` | Required |
| `artists[].artistName` | `now_playing.three_line.line1` (artist line) | parsed from display string |
| `releaseName` | `now_playing.three_line.line3` (album line) | |
| `duration` | `now_playing.length` | seconds |
| `playedTime` | wall-clock at threshold crossing | ISO datetime |
| `submissionClientAgent` | constant, e.g. `fm.teal.roon-scrobbler/0.1.0` | |
| `musicServiceBaseDomain` | `local` (or Tidal/Qobuz if detected) | |
| MbIDs / ISRC | — | not surfaced by Roon transport API; omitted in MVP |

## Lexicon reference

- Record: `fm.teal.alpha.feed.play` (`key: tid`). Required: `trackName`.
- `artists[]` items: `fm.teal.alpha.feed.defs#artist` = `{ artistName (required), artistMbId (optional) }`.
- Submitted via `com.atproto.repo.createRecord` to collection `fm.teal.alpha.feed.play`, authenticated with handle + app password.
- Tracked threshold (from lexicon description): entire track if <2 min, or half the track up to 4 min, whichever is longest.

## Key references

- Roon API: `RoonLabs/node-roon-api`, `RoonLabs/node-roon-api-transport`. `subscribe_zones(cb)` → zone state (playing/paused/loading/stopped) + `now_playing` (display lines, `seek_position`, `length`).
- Analog extension: `fjgalesloot/roon-extension-mqtt`.
- Existing teal.fm clients (submission pattern): teal-cider (Go), ewanc26/malachite (TS), FoxxMD/multi-scrobbler (tealfm client).
- Lexicon source: https://raw.githubusercontent.com/teal-fm/teal/refs/heads/main/lexicons/fm.teal.alpha/feed/play.json

## Risks / caveats

- Display-line parsing (artist/album/track from `line1/2/3`) is heuristic — Roon formats these as strings and line assignment can vary by source. Validate against real zone output before assuming field positions.
- MbIDs unavailable from Roon; plays will lack MusicBrainz enrichment. Separate MB-lookup workstream would be out of MVP scope.
- Grouped zones can double-count unless deduped.

---

## Linear: Epic + sub-issues

### Epic
**Roon → teal.fm scrobbler extension** — build a Node Roon extension that scrobbles qualifying plays to a user's PDS as `fm.teal.alpha.feed.play` records.

### Issue 1 — Scaffold Roon extension + zone subscription
- `node-roon-api` app skeleton (`extension_id`, discovery, pairing).
- Require `RoonApiTransport`, call `subscribe_zones`, log zone/now_playing deltas.
- Deliverable: running extension that pairs with Roon and prints now-playing.
- No dependencies.

### Issue 2 — Configurable zone allowlist
- Settings UI (Roon `RoonApiSettings`) to select which zone(s) to track by id/display name.
- Grouped-zone dedup so grouped playback counts once.
- Depends on #1.

### Issue 3 — Per-zone progress tracker + scrobble threshold
- State machine: accumulate listened-seconds from `seek_position` deltas across play/pause/stop/seek transitions.
- Evaluate lexicon rule (whole track if <2min; else half up to 4min; whichever longest).
- Emit one "qualified play" event with dedup keyed on track identity.
- Depends on #1.

### Issue 4 — teal.fm submission client
- Authenticated `com.atproto.repo.createRecord` to `fm.teal.alpha.feed.play` using handle + app password.
- Map play → record (field mapping table above); generate TID rkey; PDS resolution.
- Depends on #3 (consumes qualified-play events).

### Issue 5 — Settings: credentials + retry queue
- Store teal handle + app password in extension settings (not env).
- On PDS failure, queue plays and retry with backoff so offline periods aren't lost.
- Depends on #4.

### Issue 6 — Packaging, README, error handling
- npm package, run instructions, logging.
- Graceful reconnect on core unpair/reconnect.
- Docs for configuring zones + app password.
- Depends on #2, #4, #5.
