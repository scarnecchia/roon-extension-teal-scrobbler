"use strict";

const { EventEmitter } = require("events");

/**
 * @typedef {Object} RoonZone
 * @property {string} zone_id       Stable Roon zone identifier.
 * @property {string} display_name  Human-readable name (may contain " + " for groups).
 * @property {string} state         Playback state: "playing" | "paused" | "stopped" | "loading" | ...
 * @property {Object} [now_playing] Current now-playing payload, if any.
 * @property {Object} [now_playing.three_line]
 * @property {string} [now_playing.three_line.line1]  Artist.
 * @property {string} [now_playing.three_line.line2]  Track title.
 * @property {string} [now_playing.three_line.line3]  Album.
 */

/**
 * Number of per-zone picker slots exposed in the Roon settings UI.
 * Users can select up to this many zones to track.
 * @type {number}
 */
const NUM_ZONE_SLOTS = 8;

/**
 * ZoneAllowlist filters the stream of ZoneWatcher events down to a configurable
 * set of zones and de-duplicates plays that originate from grouped Roon zones.
 *
 * When Roon groups zones together (e.g. "Kitchen + Living Room"), every member
 * zone reports the *same* now-playing payload simultaneously.  Without dedup a
 * single physical play would be counted once per grouped member.  ZoneAllowlist
 * detects this by keying on the three_line track signature and only forwarding
 * the first ("leader") zone for any given track.
 *
 * Events emitted (after filtering + dedup):
 *   - "playback_started" { zone }     An allowed zone began playing a new/unique track.
 *   - "playback_stopped" { zone_id }  The leader zone for a track stopped or paused.
 *
 * An empty allowlist means "track all zones".
 */
class ZoneAllowlist extends EventEmitter {
    /**
     * @param {Object} config
     * @param {string[]} [config.allowedZoneIds]    Zone IDs to track. Empty = track all.
     * @param {string[]} [config.allowedZoneNames]  Display names to track (matched case-insensitively, trimmed).
     *                                              Combined with allowedZoneIds (union).
     */
    constructor(config = {}) {
        super();

        /** @type {Set<string>} lowercased + trimmed display names to allow */
        this._allowedNames = new Set(
            (config.allowedZoneNames || [])
                .filter(Boolean)
                .map((n) => String(n).trim().toLowerCase())
        );

        /** @type {Set<string>} zone IDs to allow */
        this._allowedIds = new Set(
            (config.allowedZoneIds || [])
                .filter(Boolean)
                .map((id) => String(id))
        );

        /**
         * Whether the allowlist is empty (track-all mode).
         * @type {boolean}
         */
        this._trackAll = this._allowedIds.size === 0 && this._allowedNames.size === 0;

        /**
         * Snapshot of every known zone we've seen from the watcher, keyed by zone_id.
         * Used so isAllowed() can resolve a zone_id → display_name even when the
         * caller only supplies an ID, and so we can look up secondaries during dedup.
         * @type {Map<string, RoonZone>}
         */
        this._knownZones = new Map();

        /**
         * Set of zone_ids currently in the "playing" state AND allowed.
         * @type {Set<string>}
         */
        this._playingZones = new Set();

        /**
         * Map of track signature → leader zone_id for zones currently playing.
         * Only the leader emits playback_started / playback_stopped.
         * @type {Map<string, string>}
         */
        this._trackLeaders = new Map();
    }

    /* ── Public API ─────────────────────────────────────────────────── */

    /**
     * Determine whether a zone should be tracked.
     *
     * In track-all mode (empty allowlist) every zone is allowed.
     * Otherwise a zone is allowed if its zone_id is in the allowlist OR its
     * display_name matches (case-insensitive, trimmed) an allowed name.
     *
     * @param {string} zone_id       The zone's stable ID.
     * @param {string} [display_name] Optional display name. If omitted, the
     *                                allowlist can only match by ID (or track-all).
     * @returns {boolean}
     */
    isAllowed(zone_id, display_name) {
        if (this._trackAll) return true;
        if (!zone_id) return false;

        if (this._allowedIds.has(String(zone_id))) return true;

        const zone = this._knownZones.get(zone_id);
        if (zone && Array.isArray(zone.outputs)) {
            for (const output of zone.outputs) {
                if (output.output_id && this._allowedIds.has(String(output.output_id))) {
                    return true;
                }
            }
        }

        if (display_name != null) {
            const name = String(display_name).trim().toLowerCase();
            if (this._allowedNames.has(name)) return true;

            const base = _extractBaseName(display_name);
            if (base && this._allowedNames.has(base)) return true;
        }

        return false;
    }

    /**
     * Attach to a ZoneWatcher and begin filtering its event stream.
     *
     * Registers listeners for zone_added, zone_removed, zone_changed,
     * state_changed, and track_changed.  Returns `this` for chaining.
     * The bound listener references are stored on `this._listeners` so a
     * future `detach()` could remove them cleanly.
     *
     * @param {import("./zone-watcher").ZoneWatcher} watcher
     * @returns {ZoneAllowlist}
     */
    attach(watcher) {
        this._listeners = {
            zone_added:    ({ zone }) => this._onZoneAdded(zone),
            zone_removed:  ({ zone_id, zone }) => this._onZoneRemoved(zone_id, zone),
            zone_changed:  ({ zone, prev }) => this._onZoneChanged(zone, prev),
            state_changed: ({ zone, prev_state }) => this._onStateChanged(zone, prev_state),
            track_changed: ({ zone }) => this._onTrackChanged(zone),
        };

        for (const [evt, fn] of Object.entries(this._listeners)) {
            watcher.on(evt, fn);
        }

        return this;
    }

    /**
     * Detach from a previously-attached ZoneWatcher.
     * @param {import("./zone-watcher").ZoneWatcher} watcher
     */
    detach(watcher) {
        if (!this._listeners) return;
        for (const [evt, fn] of Object.entries(this._listeners)) {
            watcher.off(evt, fn);
        }
        this._listeners = null;
    }

    /**
     * Update the allowlist configuration in-place (e.g. when settings change).
     * Re-evaluates all known zones against the new allowlist.
     *
     * @param {Object} config Same shape as the constructor config.
     */
    reconfigure(config = {}) {
        this._allowedNames = new Set(
            (config.allowedZoneNames || [])
                .filter(Boolean)
                .map((n) => String(n).trim().toLowerCase())
        );
        this._allowedIds = new Set(
            (config.allowedZoneIds || [])
                .filter(Boolean)
                .map((id) => String(id))
        );
        this._trackAll = this._allowedIds.size === 0 && this._allowedNames.size === 0;

        // Re-evaluate playing zones: some may now be disallowed.
        for (const zone_id of Array.from(this._playingZones)) {
            const zone = this._knownZones.get(zone_id);
            if (zone && !this.isAllowed(zone_id, zone.display_name)) {
                this._playingZones.delete(zone_id);
                this._clearLeadershipForZone(zone_id);
                this.emit("playback_stopped", { zone_id });
            }
        }
    }

    /* ── RoonApiSettings integration ────────────────────────────────── */

    /**
     * Build a RoonApiSettings layout array for selecting tracked zones.
     *
     * Roon's "zone" setting type renders a dropdown of all current zones.
     * We expose `NUM_ZONE_SLOTS` independent slots so the user can pick up to
     * that many zones.  Each slot's `setting` key is `allow_zone_<n>`.
     *
     * @param {Object} [currentValues] Current saved settings (setting key → value).
     * @returns {Object[]} Layout array suitable for `new RoonApiSettings(...)`.
     */
    static getSettingsLayout(currentValues = {}) {
        const layout = [
            {
                type: "string",
                title: "Tracked zones",
                setting: "allowed_zone_ids",
                description:
                    "Comma-separated zone IDs to track. Leave empty to track ALL zones.",
            },
        ];

        // Provide explicit per-zone pickers for convenience; values are zone_ids.
        for (let i = 1; i <= NUM_ZONE_SLOTS; i++) {
            const key = `allow_zone_${i}`;
            layout.push({
                type: "zone",
                title: `Zone slot ${i}`,
                setting: key,
                description: i === 1 ? "Pick a zone to track (optional)." : undefined,
            });
        }

        return layout;
    }

    /**
     * Parse raw RoonApiSettings values into an allowlist config.
     *
     * Accepts both the comma-separated `allowed_zone_ids` string and the
     * per-slot `allow_zone_<n>` zone pickers, merging them into a single
     * de-duplicated set of zone IDs.  An empty result means "track all".
     *
     * @param {Object} values Raw settings object from the save callback.
     * @returns {{ allowedZoneIds: string[], allowedZoneNames: string[] }}
     */
    static parseSettings(values = {}) {
        const ids = new Set();
        const names = new Set();

        const raw = values.allowed_zone_ids;
        if (typeof raw === "string") {
            for (const part of raw.split(",")) {
                const val = part.trim();
                if (val) names.add(val);
            }
        }

        for (let i = 1; i <= NUM_ZONE_SLOTS; i++) {
            const v = values[`allow_zone_${i}`];
            if (v && typeof v === "object" && v.output_id) {
                ids.add(v.output_id);
                if (v.name) names.add(v.name);
            } else if (typeof v === "string" && v.trim()) {
                ids.add(v.trim());
            }
        }

        return {
            allowedZoneIds: Array.from(ids),
            allowedZoneNames: Array.from(names),
        };
    }

    /* ── Internal event handlers ────────────────────────────────────── */

    /** @param {RoonZone} zone */
    _onZoneAdded(zone) {
        this._knownZones.set(zone.zone_id, zone);

        // If the zone is already playing when it first appears, treat it as a start.
        if (zone.state === "playing" && this.isAllowed(zone.zone_id, zone.display_name)) {
            this._handlePlayStart(zone);
        }
    }

    /** @param {string} zone_id @param {RoonZone} [zone] */
    _onZoneRemoved(zone_id, zone) {
        this._knownZones.delete(zone_id);

        if (this._playingZones.has(zone_id)) {
            this._handlePlayStop(zone_id);
        }
    }

    /**
     * Coarse-grained zone_changed: ensure our known-zones map stays fresh and
     * reconcile play state.  Most logic is handled by state_changed/track_changed,
     * but this catches cases where state events are missed.
     *
     * @param {RoonZone} zone
     * @param {RoonZone} [prev]
     */
    _onZoneChanged(zone, prev) {
        this._knownZones.set(zone.zone_id, zone);
    }

    /**
     * Handle a playback state transition for an allowed zone.
     *
     * @param {RoonZone} zone
     * @param {string} prev_state
     */
    _onStateChanged(zone, prev_state) {
        this._knownZones.set(zone.zone_id, zone);

        if (!this.isAllowed(zone.zone_id, zone.display_name)) return;

        const nowPlaying = zone.state === "playing";
        const wasPlaying = this._playingZones.has(zone.zone_id);

        if (nowPlaying && !wasPlaying) {
            this._handlePlayStart(zone);
        } else if (!nowPlaying && wasPlaying) {
            this._handlePlayStop(zone.zone_id);
        }
    }

    /**
     * Handle a track change within an already-playing allowed zone.
     * This drives a new playback_started (subject to dedup) for the new track.
     *
     * @param {RoonZone} zone
     */
    _onTrackChanged(zone) {
        this._knownZones.set(zone.zone_id, zone);

        if (!this.isAllowed(zone.zone_id, zone.display_name)) return;
        if (zone.state !== "playing") return;
        if (!this._playingZones.has(zone.zone_id)) {
            // Not previously tracked as playing — let state_changed handle it.
            this._handlePlayStart(zone);
            return;
        }

        // Already playing; the track identity changed. Re-run dedup for the new track.
        // First, clear this zone's leadership of its *previous* track.
        this._clearLeadershipForZone(zone.zone_id);

        // Re-enter as if starting fresh for the new track.
        this._handlePlayStart(zone);
    }

    /* ── Dedup core ─────────────────────────────────────────────────── */

    /**
     * Record a play start for an allowed zone and emit playback_started
     * unless another zone is already the leader for the same track signature
     * (grouped-zone dedup).
     *
     * @param {RoonZone} zone
     */
    _handlePlayStart(zone) {
        this._playingZones.add(zone.zone_id);

        const sig = _trackSignature(zone);
        if (!sig) {
            // No track identity available — emit without dedup so the play isn't lost.
            this.emit("playback_started", { zone });
            return;
        }

        const existingLeader = this._trackLeaders.get(sig);
        if (existingLeader && existingLeader !== zone.zone_id) {
            // Another zone is already the leader for this track → suppress.
            // (This zone is a grouped member / duplicate.)
            return;
        }

        // No leader yet (or we already are) — become the leader and emit.
        this._trackLeaders.set(sig, zone.zone_id);
        this.emit("playback_started", { zone });
    }

    /**
     * Record a play stop for a zone and emit playback_stopped if this zone
     * was the leader for its track.  If other zones are still playing the
     * same track (group members), promote one of them instead of emitting stop.
     *
     * @param {string} zone_id
     */
    _handlePlayStop(zone_id) {
        this._playingZones.delete(zone_id);

        const sig = this._clearLeadershipForZone(zone_id);

        if (!sig) {
            // We never had a leader entry (or no track identity) — emit stop directly.
            this.emit("playback_stopped", { zone_id });
            return;
        }

        // Look for another currently-playing, allowed zone with the same signature
        // to promote as the new leader (group member taking over).
        const promoted = this._findPlayingZoneBySignature(sig, zone_id);
        if (promoted) {
            this._trackLeaders.set(sig, promoted.zone_id);
            // Do NOT emit playback_stopped — playback continues under a new leader.
            return;
        }

        // No successor — the physical play has ended.
        this.emit("playback_stopped", { zone_id });
    }

    /**
     * Remove the given zone's leadership entry for its current track, if any.
     * Returns the signature that was cleared (or undefined).
     *
     * @param {string} zone_id
     * @returns {string|undefined}
     */
    _clearLeadershipForZone(zone_id) {
        for (const [sig, leader] of this._trackLeaders) {
            if (leader === zone_id) {
                this._trackLeaders.delete(sig);
                return sig;
            }
        }
        return undefined;
    }

    /**
     * Find a known, allowed, currently-playing zone (other than `excludeId`)
     * whose now_playing matches the given track signature.
     *
     * @param {string} sig
     * @param {string} excludeId
     * @returns {RoonZone|undefined}
     */
    _findPlayingZoneBySignature(sig, excludeId) {
        for (const zone of this._knownZones.values()) {
            if (zone.zone_id === excludeId) continue;
            if (!this._playingZones.has(zone.zone_id)) continue;
            if (!this.isAllowed(zone.zone_id, zone.display_name)) continue;
            if (_trackSignature(zone) === sig) return zone;
        }
        return undefined;
    }
}

/* ── Pure helpers ──────────────────────────────────────────────────── */

/**
 * Compute a stable signature string for a zone's current track, based on the
 * three_line payload (artist / title / album).  Returns an empty string when
 * the now_playing or three_line data is absent.
 *
 * @param {RoonZone} zone
 * @returns {string}
 */
function _trackSignature(zone) {
    const np = zone && zone.now_playing;
    const tl = np && np.three_line;
    if (!tl) return "";
    return `${tl.line1 || ""}\u0000${tl.line2 || ""}\u0000${tl.line3 || ""}`;
}

/**
 * Extract the "base" member name from a possibly-grouped display name.
 * Roon renders groups as "Kitchen + 2" or "Kitchen + Living Room".
 * Returns the first member name, lowercased + trimmed, or "" if none.
 *
 * @param {string} display_name
 * @returns {string}
 */
function _extractBaseName(display_name) {
    if (!display_name) return "";
    const first = String(display_name).split("+")[0];
    return first.trim().toLowerCase();
}

module.exports = {
    ZoneAllowlist,
    NUM_ZONE_SLOTS,
};
