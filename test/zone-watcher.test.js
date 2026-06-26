"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { ZoneWatcher } = require("../src/zone-watcher");

describe("ZoneWatcher", () => {
    let watcher;

    beforeEach(() => {
        watcher = new ZoneWatcher();
    });

    function fakeCore(callback) {
        return {
            services: {
                RoonApiTransport: {
                    subscribe_zones: callback,
                },
            },
        };
    }

    describe("subscribe + Subscribed", () => {
        it("emits subscribed event with all zones", () => {
            let subscribedPayload;
            watcher.on("subscribed", (data) => { subscribedPayload = data; });

            const zones = [
                { zone_id: "z1", state: "playing" },
                { zone_id: "z2", state: "stopped" },
            ];

            const core = fakeCore((cb) => cb("Subscribed", { zones }));
            watcher.subscribe(core);

            assert.equal(subscribedPayload.zones.length, 2);
        });

        it("emits zone_added for each zone", () => {
            const added = [];
            watcher.on("zone_added", ({ zone }) => added.push(zone.zone_id));

            const core = fakeCore((cb) => cb("Subscribed", {
                zones: [{ zone_id: "z1" }, { zone_id: "z2" }],
            }));
            watcher.subscribe(core);

            assert.deepEqual(added, ["z1", "z2"]);
        });
    });

    describe("Changed - zones_changed", () => {
        it("emits state_changed when state differs", () => {
            const core = fakeCore((cb) => {
                cb("Subscribed", { zones: [{ zone_id: "z1", state: "playing" }] });
                cb("Changed", {
                    zones_changed: [{ zone_id: "z1", state: "paused" }],
                });
            });

            let stateEvent;
            watcher.on("state_changed", (data) => { stateEvent = data; });
            watcher.subscribe(core);

            assert.equal(stateEvent.prev_state, "playing");
            assert.equal(stateEvent.zone.state, "paused");
        });

        it("emits track_changed when three_line differs", () => {
            const core = fakeCore((cb) => {
                cb("Subscribed", {
                    zones: [{
                        zone_id: "z1", state: "playing",
                        now_playing: { three_line: { line1: "A", line2: "T1", line3: "Al" } },
                    }],
                });
                cb("Changed", {
                    zones_changed: [{
                        zone_id: "z1", state: "playing",
                        now_playing: { three_line: { line1: "B", line2: "T2", line3: "Al2" } },
                    }],
                });
            });

            let trackEvent;
            watcher.on("track_changed", (data) => { trackEvent = data; });
            watcher.subscribe(core);

            assert.equal(trackEvent.prev_now_playing.three_line.line2, "T1");
            assert.equal(trackEvent.zone.now_playing.three_line.line2, "T2");
        });

        it("emits seek for zone_seek_changed without mutating the stored zone", () => {
            const core = fakeCore((cb) => {
                cb("Subscribed", {
                    zones: [{
                        zone_id: "z1", state: "playing",
                        now_playing: { three_line: { line1: "A", line2: "T", line3: "Al" }, length: 300, seek_position: 0 },
                    }],
                });
                cb("Changed", {
                    zone_seek_changed: [{ zone_id: "z1", seek_position: 42 }],
                });
            });

            const seekEvents = [];
            watcher.on("seek", (data) => seekEvents.push(data));
            watcher.subscribe(core);

            assert.equal(seekEvents.length, 1);
            assert.equal(seekEvents[0].seek_position, 42);

            const stored = watcher.getZone("z1");
            assert.equal(stored.now_playing.seek_position, 42);
        });
    });

    describe("Changed - zones_added / zones_removed", () => {
        it("handles zones_added in Changed messages", () => {
            const core = fakeCore((cb) => {
                cb("Subscribed", { zones: [] });
                cb("Changed", {
                    zones_added: [{ zone_id: "z1", state: "stopped" }],
                });
            });

            let added;
            watcher.on("zone_added", ({ zone }) => { added = zone; });
            watcher.subscribe(core);

            assert.equal(added.zone_id, "z1");
            assert.ok(watcher.getZone("z1"));
        });

        it("handles zones_removed in Changed messages", () => {
            const core = fakeCore((cb) => {
                cb("Subscribed", { zones: [{ zone_id: "z1", state: "stopped" }] });
                cb("Changed", {
                    zones_removed: [{ zone_id: "z1" }],
                });
            });

            let removedId;
            watcher.on("zone_removed", ({ zone_id }) => { removedId = zone_id; });
            watcher.subscribe(core);

            assert.equal(removedId, "z1");
            assert.equal(watcher.getZone("z1"), undefined);
        });
    });

    describe("Unsubscribed", () => {
        it("clears zones and emits unsubscribed", () => {
            const core = fakeCore((cb) => {
                cb("Subscribed", { zones: [{ zone_id: "z1" }] });
                cb("Unsubscribed");
            });

            let unsub = false;
            watcher.on("unsubscribed", () => { unsub = true; });
            watcher.subscribe(core);

            assert.ok(unsub);
            assert.equal(watcher.getAllZones().length, 0);
        });
    });

    describe("query helpers", () => {
        it("getZone returns the zone snapshot", () => {
            const core = fakeCore((cb) => {
                cb("Subscribed", { zones: [{ zone_id: "z1", state: "playing" }] });
            });
            watcher.subscribe(core);

            const z = watcher.getZone("z1");
            assert.equal(z.zone_id, "z1");
        });

        it("getAllZones returns all current zones", () => {
            const core = fakeCore((cb) => {
                cb("Subscribed", { zones: [{ zone_id: "z1" }, { zone_id: "z2" }] });
            });
            watcher.subscribe(core);

            assert.equal(watcher.getAllZones().length, 2);
        });
    });
});
