"use strict";

const { EventEmitter } = require("events");

/**
 * ZoneWatcher subscribes to Roon transport zone updates and maintains
 * an in-memory snapshot of every zone's state.  It emits granular
 * events that downstream consumers (allowlist filter, progress tracker,
 * scrobble client) can subscribe to.
 *
 * Events:
 *   - "zone_added"     { zone }                 A new zone appeared.
 *   - "zone_removed"   { zone_id }              A zone disappeared.
 *   - "zone_changed"   { zone, prev }           A zone's state or now_playing changed.
 *   - "state_changed"  { zone, prev_state }     Convenience: playback state transition.
 *   - "track_changed"  { zone, prev_now_playing } New track in a zone.
 *   - "seek"           { zone_id, seek_position } Periodic seek update (for progress tracking).
 *   - "subscribed"     { zones }                Initial subscription payload (full zone list).
 *   - "unsubscribed"                           Subscription lost.
 */
class ZoneWatcher extends EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, object>} zone_id → zone snapshot */
        this._zones = new Map();
    }

    /**
     * Attach to a paired core's transport service and subscribe to zones.
     * @param {object} core - Roon core object (from core_paired callback)
     */
    subscribe(core) {
        const transport = core.services.RoonApiTransport;

        transport.subscribe_zones((response, msg) => {
            switch (response) {
                case "Subscribed":
                    this._onSubscribed(msg);
                    break;
                case "Changed":
                    this._onChanged(msg);
                    break;
                case "Unsubscribed":
                    this._onUnsubscribed();
                    break;
                default:
                    // Unknown response — ignore but don't crash.
                    break;
            }
        });
    }

    /* ── Internal handlers ────────────────────────────────────────── */

    _onSubscribed(msg) {
        this._zones.clear();

        const zones = msg.zones || [];
        for (const zone of zones) {
            this._zones.set(zone.zone_id, zone);
        }

        this.emit("subscribed", { zones: Array.from(this._zones.values()) });

        for (const zone of this._zones.values()) {
            this.emit("zone_added", { zone });
        }
    }

    _onChanged(msg) {
        // Removed zones
        if (msg.zones_removed) {
            for (const entry of msg.zones_removed) {
                const prev = this._zones.get(entry.zone_id);
                this._zones.delete(entry.zone_id);
                this.emit("zone_removed", { zone_id: entry.zone_id, zone: prev });
            }
        }

        // Added zones
        if (msg.zones_added) {
            for (const zone of msg.zones_added) {
                this._zones.set(zone.zone_id, zone);
                this.emit("zone_added", { zone });
            }
        }

        // Changed zones
        if (msg.zones_changed) {
            for (const zone of msg.zones_changed) {
                const prev = this._zones.get(zone.zone_id);
                this._zones.set(zone.zone_id, zone);

                this.emit("zone_changed", { zone, prev });

                // Fine-grained events
                if (prev && prev.state !== zone.state) {
                    this.emit("state_changed", {
                        zone,
                        prev_state: prev.state,
                    });
                }

                if (this._trackChanged(prev, zone)) {
                    this.emit("track_changed", {
                        zone,
                        prev_now_playing: prev ? prev.now_playing : undefined,
                    });
                }

                // Always emit seek updates for progress tracking
                if (zone.now_playing && typeof zone.now_playing.seek_position === "number") {
                    this.emit("seek", {
                        zone_id: zone.zone_id,
                        seek_position: zone.now_playing.seek_position,
                        length: zone.now_playing.length,
                    });
                }
            }
        }

        // Zone seek-only updates (Roon batches frequent seek_position changes)
        if (msg.zones_seek_changed) {
            for (const entry of msg.zones_seek_changed) {
                const zone = this._zones.get(entry.zone_id);
                if (zone && zone.now_playing) {
                    const updated = {
                        ...zone,
                        now_playing: {
                            ...zone.now_playing,
                            seek_position: entry.seek_position,
                        },
                    };
                    this._zones.set(entry.zone_id, updated);
                    this.emit("seek", {
                        zone_id: entry.zone_id,
                        seek_position: entry.seek_position,
                        length: zone.now_playing.length,
                    });
                }
            }
        }
    }

    _onUnsubscribed() {
        this._zones.clear();
        this.emit("unsubscribed");
    }

    /**
     * Determine if the now-playing track has changed between snapshots.
     * Uses three_line lines as the identity key.
     */
    _trackChanged(prev, cur) {
        const p = prev && prev.now_playing ? prev.now_playing : null;
        const c = cur && cur.now_playing ? cur.now_playing : null;

        // Track changed if either side is null/undefined
        if (!p || !c) return p !== c;

        const pl = p.three_line || {};
        const cl = c.three_line || {};

        return (
            pl.line1 !== cl.line1 ||
            pl.line2 !== cl.line2 ||
            pl.line3 !== cl.line3
        );
    }

    /* ── Query helpers ─────────────────────────────────────────────── */

    /**
     * Get the current snapshot for a zone.
     * @returns {object|undefined}
     */
    getZone(zone_id) {
        return this._zones.get(zone_id);
    }

    /**
     * Get all current zone snapshots.
     * @returns {object[]}
     */
    getAllZones() {
        return Array.from(this._zones.values());
    }
}

module.exports = { ZoneWatcher };
