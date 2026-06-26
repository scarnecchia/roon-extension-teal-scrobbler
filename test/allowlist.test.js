"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { ZoneAllowlist, NUM_ZONE_SLOTS } = require("../src/allowlist");
const { EventEmitter } = require("events");

describe("ZoneAllowlist", () => {
    describe("isAllowed", () => {
        it("allows all zones when allowlist is empty", () => {
            const al = new ZoneAllowlist({ allowedZoneIds: [] });
            assert.ok(al.isAllowed("any-zone", "Any Name"));
        });

        it("filters by zone ID", () => {
            const al = new ZoneAllowlist({ allowedZoneIds: ["z1", "z2"] });
            assert.ok(al.isAllowed("z1"));
            assert.ok(al.isAllowed("z2"));
            assert.ok(!al.isAllowed("z3"));
        });

        it("filters by display name (case-insensitive)", () => {
            const al = new ZoneAllowlist({
                allowedZoneIds: [],
                allowedZoneNames: ["Kitchen"],
            });
            assert.ok(al.isAllowed("z1", "Kitchen"));
            assert.ok(al.isAllowed("z1", "kitchen"));
            assert.ok(al.isAllowed("z1", "KITCHEN"));
            assert.ok(!al.isAllowed("z1", "Bedroom"));
        });

        it("matches base name of grouped zones", () => {
            const al = new ZoneAllowlist({
                allowedZoneIds: [],
                allowedZoneNames: ["Kitchen"],
            });
            assert.ok(al.isAllowed("z1", "Kitchen + 2"));
            assert.ok(al.isAllowed("z1", "Kitchen + Living Room"));
        });

        it("matches by output_id from known zones", () => {
            const al = new ZoneAllowlist({ allowedZoneIds: ["out-1"] });
            const watcher = new EventEmitter();
            al.attach(watcher);
            watcher.emit("zone_added", {
                zone: {
                    zone_id: "z1",
                    display_name: "NAD CS1",
                    state: "stopped",
                    outputs: [{ output_id: "out-1" }],
                },
            });
            assert.ok(al.isAllowed("z1", "NAD CS1"));
        });

        it("returns false for falsy zone_id", () => {
            const al = new ZoneAllowlist({ allowedZoneIds: ["z1"] });
            assert.ok(!al.isAllowed(null));
            assert.ok(!al.isAllowed(undefined));
            assert.ok(!al.isAllowed(""));
        });
    });

    describe("reconfigure", () => {
        it("updates the allowlist and re-evaluates playing zones", () => {
            const al = new ZoneAllowlist({ allowedZoneIds: [] });
            const watcher = new EventEmitter();
            al.attach(watcher);

            const zone = {
                zone_id: "z1",
                display_name: "Kitchen",
                state: "playing",
                now_playing: { three_line: { line1: "A", line2: "T", line3: "Al" } },
            };
            watcher.emit("zone_added", { zone });

            let stopped = false;
            al.on("playback_stopped", () => { stopped = true; });

            al.reconfigure({ allowedZoneIds: ["z2"], allowedZoneNames: [] });
            assert.ok(stopped, "should emit playback_stopped for newly-disallowed zone");
        });
    });

    describe("grouped zone dedup", () => {
        let al;
        let watcher;

        beforeEach(() => {
            al = new ZoneAllowlist({ allowedZoneIds: [] });
            watcher = new EventEmitter();
            al.attach(watcher);
        });

        it("emits playback_started only for the leader zone", () => {
            let startCount = 0;
            al.on("playback_started", () => startCount++);

            const zone1 = {
                zone_id: "z1",
                display_name: "Kitchen",
                state: "playing",
                now_playing: { three_line: { line1: "A", line2: "T", line3: "Al" } },
            };
            const zone2 = {
                zone_id: "z2",
                display_name: "Living Room",
                state: "playing",
                now_playing: { three_line: { line1: "A", line2: "T", line3: "Al" } },
            };

            watcher.emit("state_changed", { zone: zone1, prev_state: "stopped" });
            watcher.emit("state_changed", { zone: zone2, prev_state: "stopped" });

            assert.equal(startCount, 1, "only the leader should trigger playback_started");
        });

        it("promotes a secondary when the leader stops", () => {
            const track = { line1: "A", line2: "T", line3: "Al" };

            const zone1 = {
                zone_id: "z1", display_name: "Kitchen", state: "playing",
                now_playing: { three_line: track },
            };
            const zone2 = {
                zone_id: "z2", display_name: "Living Room", state: "playing",
                now_playing: { three_line: track },
            };

            watcher.emit("zone_added", { zone: zone1 });
            watcher.emit("zone_added", { zone: zone2 });

            let stopCount = 0;
            al.on("playback_stopped", () => stopCount++);

            const zone1Stopped = { ...zone1, state: "stopped" };
            watcher.emit("state_changed", { zone: zone1Stopped, prev_state: "playing" });

            assert.equal(stopCount, 0, "should promote secondary, not emit stop");
        });
    });

    describe("parseSettings", () => {
        it("parses comma-separated values as zone names", () => {
            const result = ZoneAllowlist.parseSettings({
                allowed_zone_ids: "Kitchen, Living Room",
            });
            assert.deepEqual(result.allowedZoneNames.sort(), ["Kitchen", "Living Room"]);
        });

        it("parses zone picker objects with output_id and name", () => {
            const result = ZoneAllowlist.parseSettings({
                allowed_zone_ids: "",
                allow_zone_1: { output_id: "out-1", name: "NAD CS1" },
                allow_zone_2: { output_id: "out-2", name: "Kitchen" },
            });
            assert.deepEqual(result.allowedZoneIds.sort(), ["out-1", "out-2"]);
            assert.deepEqual(result.allowedZoneNames.sort(), ["Kitchen", "NAD CS1"]);
        });

        it("parses zone picker string values as IDs", () => {
            const result = ZoneAllowlist.parseSettings({
                allowed_zone_ids: "",
                allow_zone_1: "z1",
            });
            assert.deepEqual(result.allowedZoneIds, ["z1"]);
        });

        it("returns empty for no input", () => {
            const result = ZoneAllowlist.parseSettings({});
            assert.deepEqual(result.allowedZoneIds, []);
            assert.deepEqual(result.allowedZoneNames, []);
        });
    });

    describe("getSettingsLayout", () => {
        it("returns layout with zone ID field + per-slot zone pickers", () => {
            const layout = ZoneAllowlist.getSettingsLayout({});
            assert.equal(layout[0].setting, "allowed_zone_ids");
            assert.equal(layout.length, 1 + NUM_ZONE_SLOTS);
            for (let i = 1; i <= NUM_ZONE_SLOTS; i++) {
                assert.equal(layout[i].setting, `allow_zone_${i}`);
                assert.equal(layout[i].type, "zone");
            }
        });
    });
});
