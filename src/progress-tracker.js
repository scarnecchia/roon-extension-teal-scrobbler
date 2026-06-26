"use strict";

const { EventEmitter } = require("events");

/* ── Tunable constants ──────────────────────────────────────────────── */

/**
 * How far (in seconds) the observed seek_position may diverge from the
 * wall-clock-predicted position before we treat it as a user-initiated
 * seek rather than normal playback drift.
 */
const SEEK_TOLERANCE_SECONDS = 5;

/**
 * Upper bound on a single accumulation interval. If the wall-clock gap
 * between two updates exceeds this (e.g. laptop sleep, stalled network),
 * we refuse to credit it as listening time. Prevents phantom inflation.
 */
const STALE_WINDOW_SECONDS = 10;

/**
 * Default threshold (seconds) used when a track has no known duration.
 * Matches the "short track" cap from the teal.fm scrobble rule.
 */
const DEFAULT_THRESHOLD_SECONDS = 120;

const SHORT_TRACK_CAP_SECONDS = 120; // "whole track" branch cap (2 min)
const HALF_TRACK_CAP_SECONDS = 240;  // "half track" branch cap (4 min)

/* ── Core threshold logic ───────────────────────────────────────────── */

/**
 * Compute the scrobble threshold (in seconds) for a track of the given
 * duration, following the teal.fm lexicon rule:
 *
 *   threshold = max( min(duration, 120), min(duration / 2, 240) )
 *
 * i.e. a play qualifies once the listener has heard the LONGEST of:
 *   - the entire track (for tracks shorter than 2 minutes), or
 *   - half the track (capped at 4 minutes).
 *
 * Examples:
 *   - 90s  track → max(90, 45)   = 90s  (listen to the whole thing)
 *   - 200s track → max(120, 100) = 120s (listen to 2 min)
 *   - 600s track → max(120, 240) = 240s (listen to 4 min)
 *
 * @param {number|undefined} duration - Track length in seconds. May be
 *   undefined / non-finite / non-positive for streams with no duration.
 * @returns {number} Threshold in seconds (always a positive finite number).
 */
function computeThreshold(duration) {
    if (typeof duration !== "number" || !isFinite(duration) || duration <= 0) {
        return DEFAULT_THRESHOLD_SECONDS;
    }
    const wholeBranch = Math.min(duration, SHORT_TRACK_CAP_SECONDS);
    const halfBranch = Math.min(duration / 2, HALF_TRACK_CAP_SECONDS);
    return Math.max(wholeBranch, halfBranch);
}

/* ── ProgressTracker ────────────────────────────────────────────────── */

/**
 * Per-zone state machine that accumulates "listened seconds" for the
 * currently-playing track in each Roon zone and emits a `qualified_play`
 * event once the scrobble threshold has been reached.
 *
 * Time-accumulation model
 * -----------------------
 * Roon delivers periodic `seek` updates containing the current playback
 * position (`seek_position`) and track `length`. Between two consecutive
 * updates we know how much wall-clock time elapsed. While a zone is
 * `playing` we credit that wall-clock interval as listening time, with
 * two corrections for user seeks:
 *
 *   - Forward seek (position jumps far ahead of prediction): only the
 *     wall-clock interval is credited — the skipped range is NOT counted
 *     as listened.
 *   - Backward seek (position jumps behind prediction): the wall-clock
 *     interval is credited, then the accumulator is reduced by the size
 *     of the rewind (floored at 0), reflecting that the listener moved
 *     away from content they had been approaching.
 *
 * This yields an accurate, monotonic-ish estimate of genuine listening
 * without ever counting skipped content.
 *
 * Events emitted:
 *   - "qualified_play" { zone_id, zone, listened_seconds, threshold, duration }
 *       Emitted at most once per track when listened_seconds >= threshold.
 *   - "track_started"  { zone_id, track }
 *       A new track began playing in the zone.
 *   - "track_reset"    { zone_id, track, listened_seconds }
 *       A track ended or was stopped before reaching the threshold.
 */
class ProgressTracker extends EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, object>} zone_id → per-zone state */
        this._zones = new Map();
        /** Bound listener references so we can detach cleanly. */
        this._listeners = null;
    }

    /* ── Public API ────────────────────────────────────────────────── */

    /**
     * Subscribe to a ZoneWatcher's events.
     * @param {import("./zone-watcher").ZoneWatcher} watcher
     */
    attach(watcher) {
        // Detach first to avoid double-binding if attach() is called twice.
        if (this._listeners) this.detach(watcher);

        const onZoneAdded = ({ zone }) => this._onZoneAdded(zone);
        const onZoneRemoved = ({ zone_id }) => this._zones.delete(zone_id);
        const onStateChanged = ({ zone, prev_state }) =>
            this._onStateChanged(zone, prev_state);
        const onTrackChanged = ({ zone, prev_now_playing }) =>
            this._onTrackChanged(zone, prev_now_playing);
        const onSeek = ({ zone_id, seek_position, length }) =>
            this._onSeek(zone_id, seek_position, length);

        this._listeners = {
            zone_added: onZoneAdded,
            zone_removed: onZoneRemoved,
            state_changed: onStateChanged,
            track_changed: onTrackChanged,
            seek: onSeek,
        };

        watcher.on("zone_added", onZoneAdded);
        watcher.on("zone_removed", onZoneRemoved);
        watcher.on("state_changed", onStateChanged);
        watcher.on("track_changed", onTrackChanged);
        watcher.on("seek", onSeek);

        this._watcher = watcher;
    }

    /**
     * Unsubscribe from a previously-attached ZoneWatcher.
     * @param {import("./zone-watcher").ZoneWatcher} watcher
     */
    detach(watcher) {
        if (!this._listeners) return;
        const w = watcher || this._watcher;
        if (w) {
            w.off("zone_added", this._listeners.zone_added);
            w.off("zone_removed", this._listeners.zone_removed);
            w.off("state_changed", this._listeners.state_changed);
            w.off("track_changed", this._listeners.track_changed);
            w.off("seek", this._listeners.seek);
        }
        this._listeners = null;
    }

    /**
     * Get a debug snapshot of accumulated progress for a zone. Flushes any
     * in-flight playing interval first so the value is current.
     * @param {string} zone_id
     * @returns {object|undefined} Progress info, or undefined if the zone
     *   is unknown to the tracker.
     */
    getProgress(zone_id) {
        const st = this._zones.get(zone_id);
        if (!st) return undefined;
        this._flush(st);
        return {
            zone_id,
            track: st.track,
            duration: st.duration,
            threshold: st.threshold,
            listened_seconds: st.listened,
            is_playing: st.is_playing,
            scrobbled: st.scrobbled,
        };
    }

    /* ── Event handlers ────────────────────────────────────────────── */

    /**
     * A zone appeared (either at subscription time or later). Seed its
     * state so an already-playing track is tracked immediately.
     */
    _onZoneAdded(zone) {
        const st = this._newState(zone.zone_id);
        st.zone = zone;
        st.state = zone.state || null;
        this._zones.set(zone.zone_id, st);

        const np = zone.now_playing;
        if (np) {
            this._initTrack(st, np);
            st.is_playing = zone.state === "playing";
            st.position = _seekOf(np);
            st.last_ts = st.is_playing ? Date.now() : null;
            if (st.track) {
                this.emit("track_started", { zone_id: zone.zone_id, track: st.track });
            }
        }
    }

    /** Playback state transition (playing / paused / stopped / loading). */
    _onStateChanged(zone, _prev_state) {
        const st = this._ensureZone(zone);
        st.zone = zone;
        st.state = zone.state || st.state;

        // Keep duration/threshold fresh in case length arrived late.
        if (zone.now_playing) {
            this._refreshDuration(st, zone.now_playing);
            if (!st.track) this._initTrack(st, zone.now_playing);
        }

        const playing = zone.state === "playing";

        if (playing && !st.is_playing) {
            // (Re)starting playback — begin a fresh accumulation interval.
            st.is_playing = true;
            st.last_ts = Date.now();
            st.position = _seekOf(zone.now_playing);
        } else if (!playing && st.is_playing) {
            // Leaving "playing" — credit the final segment and pause.
            this._flush(st);
            st.is_playing = false;
        }

        // A transition to "stopped" ends the current play attempt. We keep
        // the per-zone state (so a resume of the SAME track cannot
        // re-scrobble) but emit track_reset if it never qualified.
        if (zone.state === "stopped" && st.track && !st.scrobbled) {
            this.emit("track_reset", {
                zone_id: zone.zone_id,
                track: st.track,
                listened_seconds: st.listened,
            });
        }

        this._checkQualified(zone.zone_id, st);
    }

    /** A new track started in a zone. */
    _onTrackChanged(zone, _prev_now_playing) {
        const st = this._ensureZone(zone);
        st.zone = zone;
        st.state = zone.state || st.state;

        // Finalize the outgoing track.
        if (st.track) {
            this._flush(st);
            if (!st.scrobbled) {
                this.emit("track_reset", {
                    zone_id: zone.zone_id,
                    track: st.track,
                    listened_seconds: st.listened,
                });
            }
        }

        // Seed the incoming track.
        const np = zone.now_playing;
        this._initTrack(st, np || {});
        st.is_playing = zone.state === "playing";
        st.position = _seekOf(np);
        st.last_ts = st.is_playing ? Date.now() : null;

        if (st.track) {
            this.emit("track_started", { zone_id: zone.zone_id, track: st.track });
        }
        this._checkQualified(zone.zone_id, st);
    }

    /** Periodic seek-position update from Roon. */
    _onSeek(zone_id, seek_position, length) {
        const st = this._zones.get(zone_id);
        if (!st) return; // ignore seeks for zones we don't know about

        if (typeof length === "number" && isFinite(length) && length > 0) {
            st.duration = length;
            st.threshold = computeThreshold(length);
        }

        if (
            st.is_playing &&
            st.last_ts != null &&
            typeof seek_position === "number" &&
            typeof st.position === "number"
        ) {
            const now = Date.now();
            const dtWall = (now - st.last_ts) / 1000;

            if (dtWall > 0 && dtWall <= STALE_WINDOW_SECONDS) {
                const expected = st.position + dtWall;
                const diff = seek_position - expected; // signed

                if (diff > SEEK_TOLERANCE_SECONDS) {
                    // Forward seek: credit only genuine wall-clock listening,
                    // never the skipped range.
                    st.listened += dtWall;
                } else if (diff < -SEEK_TOLERANCE_SECONDS) {
                    // Backward seek: credit the wall-clock interval, then
                    // subtract the rewind magnitude (floor at 0).
                    const rewind = -diff;
                    st.listened = Math.max(0, st.listened + dtWall - rewind);
                } else {
                    // Normal continuous playback.
                    st.listened += dtWall;
                }
            }
            // If dtWall exceeds STALE_WINDOW we skip crediting (likely a
            // sleep/stall) and just re-anchor on this update.
        }

        if (typeof seek_position === "number") {
            st.position = seek_position;
        }
        st.last_ts = Date.now();

        this._checkQualified(zone_id, st);
    }

    /* ── Internals ─────────────────────────────────────────────────── */

    /**
     * Credit any in-flight playing interval up to "now" and re-check the
     * threshold. Used by getProgress and state transitions.
     * @param {object} st - per-zone state
     */
    _flush(st) {
        if (!st.is_playing || st.last_ts == null) return;
        const now = Date.now();
        const dtWall = (now - st.last_ts) / 1000;
        if (dtWall > 0 && dtWall <= STALE_WINDOW_SECONDS) {
            st.listened += dtWall;
        }
        st.last_ts = now;
        this._checkQualified(st.zone_id, st);
    }

    /**
     * Emit `qualified_play` exactly once per track when the threshold is met.
     */
    _checkQualified(zone_id, st) {
        if (st.scrobbled) return;
        if (st.listened >= st.threshold) {
            st.scrobbled = true;
            this.emit("qualified_play", {
                zone_id,
                zone: st.zone,
                listened_seconds: st.listened,
                threshold: st.threshold,
                duration: st.duration,
            });
        }
    }

    /** Ensure a zone-state object exists (creating if necessary). */
    _ensureZone(zone) {
        let st = this._zones.get(zone.zone_id);
        if (!st) {
            st = this._newState(zone.zone_id);
            st.zone = zone;
            this._zones.set(zone.zone_id, st);
        }
        return st;
    }

    /** Construct a fresh per-zone state object. */
    _newState(zone_id) {
        return {
            zone_id,
            zone: null,
            track: null,          // { line1, line2, line3 } identity
            duration: undefined,  // seconds
            threshold: DEFAULT_THRESHOLD_SECONDS,
            listened: 0,          // accumulated seconds
            position: 0,          // last seek_position basis
            last_ts: null,        // ms timestamp of last update while playing
            is_playing: false,
            state: null,          // playing | paused | stopped | loading
            scrobbled: false,     // dedup flag
        };
    }

    /**
     * Seed track identity + duration + threshold for a freshly-seen track.
     * Resets accumulation and the dedup flag.
     */
    _initTrack(st, nowPlaying) {
        const np = nowPlaying || {};
        const tl = np.three_line
            ? {
                  line1: np.three_line.line1,
                  line2: np.three_line.line2,
                  line3: np.three_line.line3,
              }
            : null;

        st.track = tl;
        st.duration =
            typeof np.length === "number" && np.length > 0 ? np.length : undefined;
        st.threshold = computeThreshold(st.duration);
        st.listened = 0;
        st.scrobbled = false;
        st.position = _seekOf(np);
    }

    /** Update duration/threshold if a length value just became known. */
    _refreshDuration(st, nowPlaying) {
        if (
            typeof nowPlaying.length === "number" &&
            isFinite(nowPlaying.length) &&
            nowPlaying.length > 0 &&
            nowPlaying.length !== st.duration
        ) {
            st.duration = nowPlaying.length;
            st.threshold = computeThreshold(nowPlaying.length);
        }
    }
}

/* ── Helpers ────────────────────────────────────────────────────────── */

/**
 * Safely extract seek_position from a now_playing object.
 * @param {object|undefined} np
 * @returns {number} seek_position in seconds, or 0 if unknown.
 */
function _seekOf(np) {
    if (np && typeof np.seek_position === "number" && isFinite(np.seek_position)) {
        return np.seek_position;
    }
    return 0;
}

module.exports = { ProgressTracker, computeThreshold };
