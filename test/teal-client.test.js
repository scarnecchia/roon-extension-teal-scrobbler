"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
    generateTid,
    parseArtists,
    TealClient,
    CLIENT_AGENT,
} = require("../src/teal-client");

describe("generateTid", () => {
    it("returns a 12-character string", () => {
        const tid = generateTid();
        assert.equal(tid.length, 12);
    });

    it("uses only the AT Protocol base32 alphabet", () => {
        const valid = /^[234567a-z]+$/;
        for (let i = 0; i < 50; i++) {
            assert.match(generateTid(), valid);
        }
    });

    it("produces mostly unique values across rapid calls", () => {
        const tids = new Set();
        for (let i = 0; i < 100; i++) {
            tids.add(generateTid());
        }
        // With 2 random chars (1024 combinations) and ms-resolution timestamps,
        // some collisions are possible in a tight loop. Expect >90% unique.
        assert.ok(tids.size > 90, `expected >90 unique TIDs, got ${tids.size}`);
    });
});

describe("parseArtists", () => {
    it("returns empty array for falsy input", () => {
        assert.deepEqual(parseArtists(null), []);
        assert.deepEqual(parseArtists(undefined), []);
        assert.deepEqual(parseArtists(""), []);
    });

    it("returns empty array for non-string input", () => {
        assert.deepEqual(parseArtists(42), []);
        assert.deepEqual(parseArtists({}), []);
    });

    it("parses a single artist", () => {
        assert.deepEqual(parseArtists("Radiohead"), [
            { artistName: "Radiohead" },
        ]);
    });

    it("splits on commas", () => {
        assert.deepEqual(parseArtists("A, B, C"), [
            { artistName: "A" },
            { artistName: "B" },
            { artistName: "C" },
        ]);
    });

    it("splits on ampersands", () => {
        assert.deepEqual(parseArtists("A & B"), [
            { artistName: "A" },
            { artistName: "B" },
        ]);
    });

    it("splits on slashes", () => {
        assert.deepEqual(parseArtists("A / B"), [
            { artistName: "A" },
            { artistName: "B" },
        ]);
    });

    it("splits on feat. and ft.", () => {
        assert.deepEqual(parseArtists("A feat. B"), [
            { artistName: "A" },
            { artistName: "B" },
        ]);
        assert.deepEqual(parseArtists("A ft. B"), [
            { artistName: "A" },
            { artistName: "B" },
        ]);
    });

    it("handles mixed delimiters", () => {
        const result = parseArtists("A, B & C feat. D");
        assert.equal(result.length, 4);
        assert.deepEqual(result.map((a) => a.artistName), ["A", "B", "C", "D"]);
    });

    it("trims whitespace from artist names", () => {
        assert.deepEqual(parseArtists("  A  ,  B  "), [
            { artistName: "A" },
            { artistName: "B" },
        ]);
    });
});

describe("TealClient.buildPlayRecord", () => {
    const makeZone = (line1, line2, line3, length) => ({
        zone_id: "zone-1",
        display_name: "Test Zone",
        state: "playing",
        now_playing: {
            three_line: { line1, line2, line3 },
            length,
            seek_position: 0,
        },
    });

    it("extracts track metadata from zone snapshot", () => {
        const zone = makeZone("Artist", "Track Title", "Album Name", 300);
        const record = TealClient.buildPlayRecord(zone, { duration: 300 });

        assert.equal(record.trackName, "Track Title");
        assert.deepEqual(record.artists, [{ artistName: "Artist" }]);
        assert.equal(record.releaseName, "Album Name");
        assert.equal(record.duration, 300);
        assert.equal(record.submissionClientAgent, CLIENT_AGENT);
    });

    it("defaults musicServiceBaseDomain to 'local'", () => {
        const zone = makeZone("A", "T", "Al", 100);
        const record = TealClient.buildPlayRecord(zone, { duration: 100 });
        assert.equal(record.musicServiceBaseDomain, "local");
    });

    it("uses provided musicServiceBaseDomain", () => {
        const zone = makeZone("A", "T", "Al", 100);
        const record = TealClient.buildPlayRecord(zone, { duration: 100 }, "tidal.com");
        assert.equal(record.musicServiceBaseDomain, "tidal.com");
    });

    it("falls back to now_playing.length when duration not in qualifiedPlayData", () => {
        const zone = makeZone("A", "T", "Al", 250);
        const record = TealClient.buildPlayRecord(zone, {});
        assert.equal(record.duration, 250);
    });

    it("handles missing now_playing gracefully", () => {
        const zone = { zone_id: "z", display_name: "Z", state: "stopped" };
        const record = TealClient.buildPlayRecord(zone, {});
        assert.equal(record.trackName, "Unknown Track");
        assert.deepEqual(record.artists, []);
        assert.equal(record.releaseName, undefined);
        assert.equal(record.duration, undefined);
    });

    it("produces a valid ISO timestamp for playedTime", () => {
        const zone = makeZone("A", "T", "Al", 100);
        const record = TealClient.buildPlayRecord(zone, {});
        assert.doesNotThrow(() => new Date(record.playedTime));
        assert.match(record.playedTime, /^\d{4}-\d{2}-\d{2}T/);
    });
});
