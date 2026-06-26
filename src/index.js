"use strict";

const RoonApi          = require("node-roon-api");
const RoonApiStatus    = require("node-roon-api-status");
const RoonApiTransport = require("node-roon-api-transport");
const RoonApiSettings  = require("node-roon-api-settings");

const fs = require("fs");
const path = require("path");

const { ZoneWatcher }     = require("./zone-watcher");
const { ZoneAllowlist }   = require("./allowlist");
const { ProgressTracker } = require("./progress-tracker");
const { TealClient }      = require("./teal-client");
const { RetryQueue }      = require("./retry-queue");

/**
 * teal.fm Scrobbler — Roon Extension
 *
 * Scrobbles qualifying plays to a user's PDS as fm.teal.alpha.feed.play records.
 *
 * Architecture:
 *   Roon Core → ZoneWatcher → { ZoneAllowlist (filter), ProgressTracker (threshold) }
 *                                   → qualified_play → teal client (NUM-14+)
 */

const EXTENSION_ID    = "fm.teal.roon-scrobbler";
const DISPLAY_NAME    = "teal.fm Scrobbler";
const DISPLAY_VERSION = "0.1.0";

// ── Core modules ────────────────────────────────────────────────────

const watcher = new ZoneWatcher();
const envZoneIds = (process.env.TEAL_ALLOWED_ZONE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const allowlist = new ZoneAllowlist({ allowedZoneIds: envZoneIds });
const tracker = new ProgressTracker();

// teal.fm submission client (configured with credentials from settings).
let tealClient = null;
let tealClientReady = false;

// Retry queue with disk persistence so offline plays aren't lost.
const retryQueue = new RetryQueue({
    persistPath: path.join(__dirname, "..", "config", "retry-queue.json"),
});
retryQueue.on("retried", ({ result }) => {
    console.log(`[retry] Play submitted on retry: ${result.uri}`);
});
retryQueue.on("dropped", ({ playData }) => {
    console.warn(`[retry] Play permanently dropped: ${playData.trackName}`);
});
retryQueue.on("drained", () => {
    console.log("[retry] Queue drained — all plays submitted");
});

// ── Settings ────────────────────────────────────────────────────────

let _settings = {
    allowed_zone_ids: process.env.TEAL_ALLOWED_ZONE_IDS || "",
    teal_handle: process.env.TEAL_HANDLE || "",
    teal_app_password: process.env.TEAL_APP_PASSWORD || "",
    music_service_domain: process.env.TEAL_MUSIC_SERVICE_DOMAIN || "local",
};

// ── Roon extension setup ────────────────────────────────────────────

const roon = new RoonApi({
    extension_id:    EXTENSION_ID,
    display_name:    DISPLAY_NAME,
    display_version: DISPLAY_VERSION,
    publisher:       "teal.fm",
    email:           "contact@teal.fm",
    website:         "https://teal.fm",

    core_paired(core) {
        console.log(
            `[core] Paired: ${core.display_name} ` +
            `(v${core.display_version}, id ${core.core_id})`
        );
        watcher.subscribe(core);
    },

    core_unpaired(core) {
        console.log(
            `[core] Unpaired: ${core.display_name} (id ${core.core_id})`
        );
    },
});

function buildSettingsLayout() {
    const layout = ZoneAllowlist.getSettingsLayout(_settings);
    layout.push(
        {
            type: "string",
            title: "Bluesky Handle",
            setting: "teal_handle",
        },
        {
            type: "string",
            title: "Bluesky App Password",
            setting: "teal_app_password",
        },
        {
            type: "string",
            title: "Music Service Domain",
            setting: "music_service_domain",
        }
    );
    return layout;
}

const svc_settings = new RoonApiSettings(roon, {
    get_settings: function (cb) {
        cb({
            values: _settings,
            layout: buildSettingsLayout(),
        });
    },
    save_settings: function (req, isdryrun, ignored) {
        if (req.body.settings && req.body.settings.values) {
            _settings = req.body.settings.values;
        }
        req.send_complete("Success", {
            settings: {
                values: _settings,
                layout: buildSettingsLayout(),
            },
        });

        if (!isdryrun) {
            const config = ZoneAllowlist.parseSettings(_settings);
            allowlist.reconfigure(config);
            console.log(
                `[settings] Allowlist updated: ` +
                (config.allowedZoneIds.length === 0
                    ? "tracking ALL zones"
                    : `${config.allowedZoneIds.length} zone(s)`)
            );

            // Configure teal.fm client if credentials are present.
            if (_settings.teal_handle && _settings.teal_app_password) {
                configureTealClient();
            }
        }
    },
});

const svc_status = new RoonApiStatus(roon);

roon.init_services({
    required_services: [RoonApiTransport],
    provided_services: [svc_status, svc_settings],
});

svc_status.set_status("teal.fm scrobbler running", false);

// ── Wire up event pipeline ──────────────────────────────────────────

// Allowlist filters zone events and handles grouped-zone dedup.
allowlist.attach(watcher);

// ProgressTracker accumulates listened time and emits qualified_play.
tracker.attach(watcher);

// Zone events (NUM-11 deliverable — logging)
let _seekCount = 0;
watcher.on("seek", ({ zone_id, seek_position }) => {
    _seekCount++;
    if (_seekCount <= 5 || _seekCount % 50 === 0) {
        const progress = tracker.getProgress(zone_id);
        console.log(
            `[debug] seek #${_seekCount} zone=${zone_id.slice(-8)} pos=${seek_position} ` +
            `listened=${progress ? progress.listened_seconds.toFixed(1) : "?"} ` +
            `threshold=${progress ? progress.threshold : "?"} ` +
            `scrobbled=${progress ? progress.scrobbled : "?"}`
        );
    }
});

watcher.on("subscribed", ({ zones }) => {
    console.log(`[zones] Subscribed — ${zones.length} zone(s) active`);
});

watcher.on("state_changed", ({ zone, prev_state }) => {
    const np = zone.now_playing;
    const title = np && np.three_line ? np.three_line.line2 : "?";
    console.log(
        `[state] ${zone.display_name}: ${prev_state} → ${zone.state}  « ${title} »`
    );
});

watcher.on("track_changed", ({ zone, prev_now_playing }) => {
    const np = zone.now_playing;
    const curTitle = np && np.three_line ? np.three_line.line2 : "?";
    const curArtist = np && np.three_line ? np.three_line.line1 : "?";
    const curAlbum = np && np.three_line ? np.three_line.line3 : "?";
    const prevTitle = prev_now_playing && prev_now_playing.three_line
        ? prev_now_playing.three_line.line2
        : "?";

    console.log(
        `[track] ${zone.display_name}: « ${prevTitle} » → « ${curTitle} » ` +
        `by ${curArtist} from ${curAlbum}`
    );
    if (np) {
        console.log(
            `        length: ${np.length ?? "?"}s  seek: ${np.seek_position ?? "?"}s`
        );
    }
});

// Allowlist events
allowlist.on("playback_started", ({ zone }) => {
    console.log(`[allowlist] Playback started in ${zone.display_name}`);
});

allowlist.on("playback_stopped", ({ zone_id }) => {
    console.log(`[allowlist] Playback stopped (${zone_id})`);
});

// ProgressTracker events
tracker.on("track_started", ({ zone_id, track }) => {
    console.log(
        `[tracker] Track started in ${zone_id}: ${track ? track.line2 : "?"}`
    );
});

tracker.on("track_reset", ({ zone_id, track, listened_seconds }) => {
    console.log(
        `[tracker] Track reset in ${zone_id}: ${track ? track.line2 : "?"} ` +
        `(${listened_seconds.toFixed(1)}s listened — did not qualify)`
    );
});

// Qualified play — forward to the teal.fm submission client.
tracker.on("qualified_play", ({ zone_id, zone, listened_seconds, threshold, duration }) => {
    const np = zone && zone.now_playing;
    const title = np && np.three_line ? np.three_line.line2 : "?";
    const artist = np && np.three_line ? np.three_line.line1 : "?";

    // Only act on zones the allowlist permits.
    if (!allowlist.isAllowed(zone_id, zone && zone.display_name)) {
        return;
    }

    console.log(
        `[scrobble] QUALIFIED PLAY: « ${title} » by ${artist} — ` +
        `${listened_seconds.toFixed(1)}s / ${threshold}s threshold ` +
        `(duration: ${duration ?? "?"}s) in ${zone.display_name}`
    );

    if (!tealClient) {
        console.log("[scrobble] Skipping — teal.fm client not configured");
        return;
    }

    const playRecord = TealClient.buildPlayRecord(zone, { duration }, _settings.music_service_domain);

    if (!tealClientReady) {
        console.log("[scrobble] Client not ready — queuing play");
        retryQueue.enqueue(playRecord);
        return;
    }

    tealClient.submit(playRecord).catch((err) => {
        console.error(`[scrobble] Submission failed: ${err.message} — queuing for retry`);
        retryQueue.enqueue(playRecord);
    });
});

watcher.on("unsubscribed", () => {
    console.log("[zones] Subscription lost");
});

// ── Teal client management ──────────────────────────────────────────

let _configuring = false;

async function configureTealClient() {
    if (_configuring) return;
    _configuring = true;
    const handle = _settings.teal_handle;
    const appPassword = _settings.teal_app_password;
    const musicServiceBaseDomain = _settings.music_service_domain || "local";

    if (!handle || !appPassword) {
        console.log("[teal] No credentials configured — submissions disabled");
        tealClientReady = false;
        return;
    }

    const config = { handle, appPassword, musicServiceBaseDomain };

    if (tealClient) {
        tealClient.reconfigure(config);
    } else {
        tealClient = new TealClient(config);
        tealClient.on("authenticated", ({ did, pdsEndpoint }) => {
            console.log(`[teal] Authenticated as ${did} via ${pdsEndpoint}`);
        });
        tealClient.on("submitted", ({ uri }) => {
            console.log(`[teal] Play submitted: ${uri}`);
        });
        tealClient.on("error", ({ error, playData }) => {
            console.error(`[teal] Submission error: ${error.message}`);
        });
    }

    tealClientReady = false;
    try {
        await tealClient.init();
        tealClientReady = true;
        console.log("[teal] Client ready — submissions enabled");

        retryQueue.setSubmitFn((playData) => tealClient.submit(playData));
        retryQueue.start();
        if (retryQueue.size > 0) {
            console.log(`[teal] Flushing ${retryQueue.size} queued play(s)`);
            retryQueue.flush();
        }
    } catch (err) {
        console.error(`[teal] Authentication failed: ${err.message}`);
        console.error("[teal] Submissions disabled — check credentials in settings");
    } finally {
        _configuring = false;
    }
}

// ── Start ───────────────────────────────────────────────────────────

roon.start_discovery();

console.log(`${DISPLAY_NAME} v${DISPLAY_VERSION} — discovering Roon cores…`);

if (_settings.teal_handle && _settings.teal_app_password) {
    configureTealClient();
}

// ── Graceful shutdown ───────────────────────────────────────────────

function shutdown(signal) {
    console.log(`\n[shutdown] Received ${signal} — cleaning up…`);

    retryQueue.stop();
    console.log(`[shutdown] Retry queue stopped (${retryQueue.size} play(s) persisted)`);

    if (tealClient) {
        console.log("[shutdown] Teal client closed");
    }

    console.log("[shutdown] Goodbye");
    process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Catch uncaught errors so a single bad event doesn't crash the extension.
process.on("uncaughtException", (err) => {
    console.error("[fatal] Uncaught exception:", err.message);
    console.error(err.stack);
});
process.on("unhandledRejection", (reason) => {
    console.error("[fatal] Unhandled rejection:", reason);
});

module.exports = { roon, watcher, allowlist, tracker };
