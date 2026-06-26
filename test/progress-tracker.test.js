"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { computeThreshold, ProgressTracker } = require("../src/progress-tracker");
const { EventEmitter } = require("events");

describe("computeThreshold", () => {
    it("returns DEFAULT_THRESHOLD_SECONDS for undefined duration", () => {
        assert.equal(computeThreshold(undefined), 120);
    });

    it("returns DEFAULT_THRESHOLD_SECONDS for non-positive duration", () => {
        assert.equal(computeThreshold(0), 120);
        assert.equal(computeThreshold(-10), 120);
    });

    it("returns DEFAULT_THRESHOLD_SECONDS for NaN / Infinity", () => {
        assert.equal(computeThreshold(NaN), 120);
        assert.equal(computeThreshold(Infinity), 120);
        assert.equal(computeThreshold(-Infinity), 120);
    });

    it("returns DEFAULT_THRESHOLD_SECONDS for non-number types", () => {
        assert.equal(computeThreshold("300"), 120);
        assert.equal(computeThreshold(null), 120);
    });

    it("short track (90s): threshold = whole track", () => {
        // max(min(90, 120), min(45, 240)) = max(90, 45) = 90
        assert.equal(computeThreshold(90), 90);
    });

    it("medium track (200s): threshold = 120s cap", () => {
        // max(min(200, 120), min(100, 240)) = max(120, 100) = 120
        assert.equal(computeThreshold(200), 120);
    });

    it("long track (600s): threshold = 240s (half-track cap)", () => {
        // max(min(600, 120), min(300, 240)) = max(120, 240) = 240
        assert.equal(computeThreshold(600), 240);
    });

    it("very long track (3600s): threshold = 240s cap", () => {
        // max(min(3600, 120), min(1800, 240)) = max(120, 240) = 240
        assert.equal(computeThreshold(3600), 240);
    });

    it("very short track (30s): threshold = 30s (whole track)", () => {
        // max(min(30, 120), min(15, 240)) = max(30, 15) = 30
        assert.equal(computeThreshold(30), 30);
    });

    it("boundary: exactly 120s track", () => {
        // max(min(120, 120), min(60, 240)) = max(120, 60) = 120
        assert.equal(computeThreshold(120), 120);
    });

    it("boundary: exactly 480s (half = 240)", () => {
        // max(min(480, 120), min(240, 240)) = max(120, 240) = 240
        assert.equal(computeThreshold(480), 240);
    });
});

describe("ProgressTracker", () => {
    let tracker;
    let watcher;

    beforeEach(() => {
        tracker = new ProgressTracker();
        watcher = new EventEmitter();
        tracker.attach(watcher);
    });

    function makeZone(zone_id, state, line1, line2, line3, length, seek_position) {
        return {
            zone_id,
            display_name: "Test",
            state,
            now_playing: {
                three_line: { line1, line2, line3 },
                length,
                seek_position: seek_position ?? 0,
            },
        };
    }

    it("emits track_started on zone_added with now_playing", () => {
        let started = false;
        tracker.on("track_started", ({ zone_id, track }) => {
            started = true;
            assert.equal(zone_id, "z1");
            assert.equal(track.line2, "Song");
        });

        watcher.emit("zone_added", {
            zone: makeZone("z1", "playing", "Artist", "Song", "Album", 300),
        });

        assert.ok(started);
    });

    it("emits qualified_play after sufficient seek updates", () => {
        const zone = makeZone("z1", "playing", "Artist", "Song", "Album", 60);

        watcher.emit("zone_added", { zone });

        let qualified = false;
        tracker.on("qualified_play", ({ zone_id, listened_seconds, threshold }) => {
            qualified = true;
            assert.equal(zone_id, "z1");
            assert.equal(threshold, 60);
            assert.ok(listened_seconds >= 60);
        });

        const st = tracker._zones.get("z1");
        st.listened = 59;
        st.last_ts = Date.now() - 2000;
        st.position = 58;

        watcher.emit("seek", { zone_id: "z1", seek_position: 60, length: 60 });

        assert.ok(qualified);
    });

    it("emits qualified_play at most once per track", () => {
        const zone = makeZone("z1", "playing", "Artist", "Song", "Album", 60);
        watcher.emit("zone_added", { zone });

        let count = 0;
        tracker.on("qualified_play", () => count++);

        const st = tracker._zones.get("z1");
        st.listened = 61;
        st.last_ts = Date.now() - 1000;
        st.position = 60;

        watcher.emit("seek", { zone_id: "z1", seek_position: 61, length: 60 });
        watcher.emit("seek", { zone_id: "z1", seek_position: 62, length: 60 });

        assert.equal(count, 1);
    });

    it("emits track_reset when track changes before qualifying", () => {
        const zone1 = makeZone("z1", "playing", "A", "Track1", "Al", 300);
        watcher.emit("zone_added", { zone: zone1 });

        let resetFired = false;
        tracker.on("track_reset", ({ zone_id, track }) => {
            resetFired = true;
            assert.equal(track.line2, "Track1");
        });

        const zone2 = makeZone("z1", "playing", "A", "Track2", "Al", 300);
        watcher.emit("track_changed", { zone: zone2, prev_now_playing: zone1.now_playing });

        assert.ok(resetFired);
    });

    it("does not credit time beyond STALE_WINDOW_SECONDS", () => {
        const zone = makeZone("z1", "playing", "A", "T", "Al", 300);
        watcher.emit("zone_added", { zone });

        const st = tracker._zones.get("z1");
        st.listened = 0;
        st.last_ts = Date.now() - 30_000;
        st.position = 0;

        watcher.emit("seek", { zone_id: "z1", seek_position: 30, length: 300 });

        assert.ok(st.listened < 1, `expected near-zero listened, got ${st.listened}`);
    });

    it("handles backward seek by reducing accumulated time", () => {
        const zone = makeZone("z1", "playing", "A", "T", "Al", 300);
        watcher.emit("zone_added", { zone });

        const st = tracker._zones.get("z1");
        st.listened = 50;
        st.position = 50;
        st.last_ts = Date.now() - 1000;

        watcher.emit("seek", { zone_id: "z1", seek_position: 10, length: 300 });

        assert.ok(st.listened < 50, `expected listened < 50 after rewind, got ${st.listened}`);
        assert.ok(st.listened >= 0, "listened should never go negative");
    });

    it("getProgress returns current state", () => {
        const zone = makeZone("z1", "playing", "A", "T", "Al", 200);
        watcher.emit("zone_added", { zone });

        const progress = tracker.getProgress("z1");
        assert.equal(progress.zone_id, "z1");
        assert.equal(progress.duration, 200);
        assert.equal(progress.is_playing, true);
        assert.equal(progress.scrobbled, false);
    });

    it("getProgress returns undefined for unknown zones", () => {
        assert.equal(tracker.getProgress("unknown"), undefined);
    });

    it("detach removes all listeners", () => {
        tracker.detach(watcher);

        let started = false;
        tracker.on("track_started", () => { started = true; });

        watcher.emit("zone_added", {
            zone: makeZone("z1", "playing", "A", "T", "Al", 300),
        });

        assert.ok(!started);
    });
});
