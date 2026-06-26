"use strict";

const { EventEmitter } = require("events");
const { randomInt } = require("crypto");

/* ── Constants ─────────────────────────────────────────────────────── */

/**
 * Custom base32 alphabet used by AT Protocol TIDs (lowercase, digits 2–7).
 * @type {string}
 */
const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

/**
 * Default identifier for the teal.fm Roon scrobbler, used in the
 * `submissionClientAgent` field of play records.
 * @type {string}
 */
const CLIENT_AGENT = "fm.teal.roon-scrobbler/0.1.0";

/**
 * The teal.fm feed.play lexicon collection NSID.
 * @type {string}
 */
const COLLECTION = "fm.teal.alpha.feed.play";

/**
 * Default handle-resolution endpoint (Bluesky's AppView).
 * @type {string}
 */
const DEFAULT_HANDLE_RESOLVER = "https://bsky.social";

/**
 * PLC directory base URL for resolving `did:plc:` identifiers.
 * @type {string}
 */
const PLC_DIRECTORY = "https://plc.directory";

/* ── Errors ────────────────────────────────────────────────────────── */

/**
 * Base class for all teal.fm submission errors.  Carries the original
 * `playData` so callers (e.g. a retry queue in NUM-15) can re-attempt
 * the submission later.
 */
class TealSubmissionError extends Error {
    /**
     * @param {string} message   Human-readable description.
     * @param {object} [opts]
     * @param {number} [opts.status]    HTTP status code (if applicable).
     * @param {*}      [opts.body]      Parsed response body (if any).
     * @param {object} [opts.playData]  The play record that was being submitted.
     * @param {string} [opts.retryAfter] Value of the `Retry-After` header (HTTP 429).
     */
    constructor(message, opts = {}) {
        super(message);
        this.name = "TealSubmissionError";
        this.status = opts.status;
        this.body = opts.body;
        this.playData = opts.playData;
        this.retryAfter = opts.retryAfter;
    }
}

/** Authentication or authorisation failure (HTTP 401 / 403). */
class TealAuthError extends TealSubmissionError {
    constructor(message, opts = {}) {
        super(message, opts);
        this.name = "TealAuthError";
    }
}

/** Rate-limited by the PDS (HTTP 429).  See `retryAfter`. */
class TealRateLimitError extends TealSubmissionError {
    constructor(message, opts = {}) {
        super(message, opts);
        this.name = "TealRateLimitError";
    }
}

/* ── TID generation ────────────────────────────────────────────────── */

/**
 * Generate an AT Protocol TID (timestamp-based identifier).
 *
 * A TID encodes the current time in microseconds as 10 base32 characters
 * (using the custom alphabet) followed by 2 random base32 characters for
 * collision avoidance within the same microsecond.
 *
 * @returns {string} A 12-character TID.
 */
function generateTid() {
    const now = Date.now();
    let str = "";
    let ts = now * 1000; // microseconds since epoch

    for (let i = 0; i < 10; i++) {
        str = TID_ALPHABET[ts & 0x1f] + str;
        ts = Math.floor(ts / 32);
    }

    str += TID_ALPHABET[randomInt(32)];
    str += TID_ALPHABET[randomInt(32)];
    return str;
}

/* ── Artist parsing ────────────────────────────────────────────────── */

/**
 * Parse a Roon `three_line.line1` (artist) string into an array of
 * individual artist names.
 *
 * Roon presents the artist line as a free-form string that may contain
 * multiple artists separated by commas, ampersands, or "feat." / "ft."
 * markers.  We split on the common delimiters and trim each result.
 *
 * @param {string} line1 - The raw artist string from Roon's three_line.
 * @returns {Array<{ artistName: string }>} Array of artist objects (for the lexicon).
 */
function parseArtists(line1) {
    if (!line1 || typeof line1 !== "string") return [];

    const splitRegex = /\s*[,&/]\s*|\s+(?:feat\.?|ft\.?)\s+/i;
    return line1
        .split(splitRegex)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((artistName) => ({ artistName }));
}

/* ── TealClient ────────────────────────────────────────────────────── */

/**
 * TealClient submits qualifying plays to a user's PDS as
 * `fm.teal.alpha.feed.play` records via the AT Protocol.
 *
 * Authentication uses a Bluesky **app password** (not the account password).
 * The client resolves the handle → DID → PDS endpoint, creates a session,
 * and then creates records on the PDS using the access JWT.
 *
 * Events emitted:
 *   - "authenticated" { did, pdsEndpoint }  Session established after `init()`.
 *   - "submitted"     { uri, cid, playData }  Record successfully created.
 *   - "error"         { error, playData }     Submission failed (non-throw path).
 */
class TealClient extends EventEmitter {
    /**
     * @param {Object} config
     * @param {string} config.handle          Bluesky handle (with or without domain suffix).
     * @param {string} config.appPassword     App password for the PDS.
     * @param {string} [config.musicServiceBaseDomain]  Default musicServiceBaseDomain for records ("local", "tidal.com", ...).
     * @param {string} [config.userAgent]     Override for the submissionClientAgent field.
     * @param {string} [config.pdsEndpoint]   Pre-known PDS URL (skips DID resolution).
     * @param {string} [config.handleResolver] Base URL for handle resolution (default: bsky.social).
     */
    constructor(config = {}) {
        super();

        /** @type {string|undefined} */
        this._handle = config.handle;
        /** @type {string|undefined} */
        this._appPassword = config.appPassword;
        /** @type {string} */
        this._musicServiceBaseDomain = config.musicServiceBaseDomain || "local";
        /** @type {string} */
        this._userAgent = config.userAgent || CLIENT_AGENT;
        /** @type {string|undefined} */
        this._pdsEndpoint = config.pdsEndpoint;
        /** @type {string} */
        this._handleResolver = config.handleResolver || DEFAULT_HANDLE_RESOLVER;

        // Session state (populated by init()).
        /** @type {string|undefined} */
        this._did = undefined;
        /** @type {string|undefined} */
        this._accessJwt = undefined;
        /** @type {string|undefined} */
        this._refreshJwt = undefined;
        /** @type {boolean} */
        this._authenticated = false;
    }

    /* ── Public API ─────────────────────────────────────────────────── */

    /**
     * Resolve the handle → DID → PDS endpoint and create an authenticated
     * session.  Must be called (and awaited) before `submit()`.
     *
     * Emits an `"authenticated"` event on success.
     *
     * @returns {Promise<{ did: string, pdsEndpoint: string }>}
     * @throws {TealSubmissionError} If resolution or session creation fails.
     */
    async init() {
        if (!this._handle) {
            throw new TealSubmissionError("Cannot init: no handle configured");
        }
        if (!this._appPassword) {
            throw new TealSubmissionError("Cannot init: no appPassword configured");
        }

        // If a PDS endpoint was supplied directly, skip DID-based endpoint resolution.
        // We still resolve the DID for the repo field (or trust createSession to return it).
        let pdsEndpoint = this._pdsEndpoint;
        let did = undefined;

        // Step 1: Resolve handle → DID.
        if (!this._pdsEndpoint || !this._did) {
            did = await this._resolveDid(this._handle);
            this._did = did;
        } else {
            did = this._did;
        }

        // Step 2: Resolve DID → PDS endpoint (if not pre-supplied).
        if (!pdsEndpoint) {
            pdsEndpoint = await this._resolvePdsEndpoint(did);
        }

        // Normalise: strip trailing slash.
        this._pdsEndpoint = pdsEndpoint.replace(/\/+$/, "");

        // Step 3: Create session.
        await this._createSession();

        this._authenticated = true;
        this.emit("authenticated", { did: this._did, pdsEndpoint: this._pdsEndpoint });
        return { did: this._did, pdsEndpoint: this._pdsEndpoint };
    }

    /**
     * Submit a play record to the PDS.
     *
     * On success, emits a `"submitted"` event and returns `{ uri, cid }`.
     * On failure, throws a `TealSubmissionError` (subclass) with the
     * attempted `playData` attached.  The caller may catch the error and
     * re-queue for retry (NUM-15).
     *
     * If the access JWT has expired (HTTP 401) and a refresh JWT is
     * available, the client will attempt to refresh the session and retry
     * the submission once.
     *
     * @param {Object} playData
     * @param {string} playData.trackName
     * @param {Array<{ artistName: string, artistMbId?: string }>} [playData.artists]
     * @param {string} [playData.releaseName]
     * @param {number} [playData.duration]
     * @param {string} [playData.playedTime]
     * @returns {Promise<{ uri: string, cid: string }>}
     * @throws {TealSubmissionError}
     */
    async submit(playData) {
        if (!this._authenticated || !this._accessJwt) {
            throw new TealSubmissionError(
                "TealClient not initialised — call init() first",
                { playData }
            );
        }

        const record = this._buildRecord(playData);
        const rkey = generateTid();

        try {
            const result = await this._createRecord(record, rkey);
            this.emit("submitted", { ...result, playData });
            return result;
        } catch (err) {
            // If the token expired, try refreshing once and retrying.
            if (err instanceof TealAuthError && this._refreshJwt) {
                try {
                    await this._refreshSession();
                    const result = await this._createRecord(record, rkey);
                    this.emit("submitted", { ...result, playData });
                    return result;
                } catch (retryErr) {
                    // Ensure playData is attached.
                    if (retryErr instanceof TealSubmissionError && !retryErr.playData) {
                        retryErr.playData = playData;
                    }
                    this.emit("error", { error: retryErr, playData });
                    throw retryErr;
                }
            }

            // Attach playData for retry queueing.
            if (err instanceof TealSubmissionError && !err.playData) {
                err.playData = playData;
            }

            // Emit on the error channel for listeners that don't catch promises.
            this.emit("error", { error: err, playData });
            throw err;
        }
    }

    /**
     * Update the client configuration in-place (e.g. when settings change).
     *
     * If the handle or appPassword changes, the client is de-authenticated
     * and `init()` must be called again before submissions will work.
     * NUM-15 will use this when the user updates PDS credentials.
     *
     * @param {Object} config  Same shape as the constructor config.
     */
    reconfigure(config = {}) {
        const handleChanged = config.handle !== undefined && config.handle !== this._handle;
        const passwordChanged =
            config.appPassword !== undefined && config.appPassword !== this._appPassword;

        if (config.handle !== undefined) this._handle = config.handle;
        if (config.appPassword !== undefined) this._appPassword = config.appPassword;
        if (config.musicServiceBaseDomain !== undefined) {
            this._musicServiceBaseDomain = config.musicServiceBaseDomain;
        }
        if (config.userAgent !== undefined) this._userAgent = config.userAgent;
        if (config.pdsEndpoint !== undefined) this._pdsEndpoint = config.pdsEndpoint;
        if (config.handleResolver !== undefined) this._handleResolver = config.handleResolver;

        // Force re-auth if credentials changed.
        if (handleChanged || passwordChanged) {
            this._authenticated = false;
            this._accessJwt = undefined;
            this._refreshJwt = undefined;
            this._did = undefined;
            // If only the PDS endpoint changed, keep the DID but force re-auth.
            this._pdsEndpoint = config.pdsEndpoint || this._pdsEndpoint;
        }
    }

    /**
     * Build a `fm.teal.alpha.feed.play` record from a ProgressTracker
     * `qualified_play` event.
     *
     * This is a **static** helper — no authentication or network access
     * is required.  The caller is responsible for passing the resulting
     * record (or the relevant fields) to `submit()`.
     *
     * @param {Object} zone              Roon zone snapshot.
     * @param {Object} qualifiedPlayData Data from the qualified_play event.
     * @param {number} qualifiedPlayData.listened_seconds
     * @param {number} qualifiedPlayData.threshold
     * @param {number} [qualifiedPlayData.duration]
     * @returns {{ trackName: string, artists: Array<{artistName: string}>, releaseName: (string|undefined), duration: (number|undefined), playedTime: string, submissionClientAgent: string, musicServiceBaseDomain: string }}
     */
    static buildPlayRecord(zone, qualifiedPlayData, musicServiceBaseDomain = "local") {
        const np = zone && zone.now_playing;
        const tl = np && np.three_line ? np.three_line : {};
        const duration = qualifiedPlayData && typeof qualifiedPlayData.duration === "number"
            ? Math.floor(qualifiedPlayData.duration)
            : np && typeof np.length === "number"
                ? Math.floor(np.length)
                : undefined;

        return {
            trackName: String(tl.line2 || "Unknown Track"),
            artists: parseArtists(tl.line1),
            releaseName: tl.line3 ? String(tl.line3) : undefined,
            duration: duration,
            playedTime: new Date().toISOString(),
            submissionClientAgent: CLIENT_AGENT,
            musicServiceBaseDomain,
        };
    }

    /* ── AT Protocol internals ──────────────────────────────────────── */

    /**
     * Resolve a Bluesky handle to a DID.
     *
     * @param {string} handle - The handle (may include domain suffix).
     * @returns {Promise<string>} The DID.
     * @throws {TealSubmissionError}
     * @private
     */
    async _resolveDid(handle) {
        const url =
            `${this._handleResolver}/xrpc/com.atproto.identity.resolveHandle` +
            `?handle=${encodeURIComponent(handle)}`;

        let resp;
        try {
            resp = await fetch(url, {
                method: "GET",
                headers: { "Accept": "application/json" },
            });
        } catch (err) {
            throw new TealSubmissionError(
                `Failed to resolve handle "${handle}": ${err.message}`,
                { playData: null }
            );
        }

        if (!resp.ok) {
            const body = await this._safeJson(resp);
            throw new TealSubmissionError(
                `Handle resolution failed for "${handle}" (HTTP ${resp.status})`,
                { status: resp.status, body }
            );
        }

        const data = await resp.json();
        if (!data.did) {
            throw new TealSubmissionError(
                `Handle resolution returned no DID for "${handle}"`
            );
        }
        return data.did;
    }

    /**
     * Resolve a DID to its PDS service endpoint URL.
     *
     * Supports both `did:plc:` (via PLC directory) and `did:web:`
     * (via `.well-known/did.json`).
     *
     * @param {string} did
     * @returns {Promise<string>} PDS serviceEndpoint URL.
     * @throws {TealSubmissionError}
     * @private
     */
    async _resolvePdsEndpoint(did) {
        let didDocUrl;
        if (did.startsWith("did:plc:")) {
            didDocUrl = `${PLC_DIRECTORY}/${encodeURIComponent(did)}`;
        } else if (did.startsWith("did:web:")) {
            const domain = did.slice("did:web:".length);
            didDocUrl = `https://${domain}/.well-known/did.json`;
        } else {
            throw new TealSubmissionError(`Unsupported DID method: ${did}`);
        }

        let resp;
        try {
            resp = await fetch(didDocUrl, {
                method: "GET",
                headers: { "Accept": "application/json" },
            });
        } catch (err) {
            throw new TealSubmissionError(
                `Failed to fetch DID document for ${did}: ${err.message}`
            );
        }

        if (!resp.ok) {
            throw new TealSubmissionError(
                `DID document fetch failed for ${did} (HTTP ${resp.status})`,
                { status: resp.status }
            );
        }

        const doc = await resp.json();
        const services = Array.isArray(doc.service) ? doc.service : [];
        const pdsService = services.find(
            (s) => s && s.id === "#atproto_pds"
        );

        if (!pdsService || !pdsService.serviceEndpoint) {
            throw new TealSubmissionError(
                `No #atproto_pds service endpoint in DID document for ${did}`
            );
        }

        return pdsService.serviceEndpoint;
    }

    /**
     * Create a new session on the PDS using app-password auth.
     * Stores the access and refresh JWTs.
     *
     * @returns {Promise<void>}
     * @throws {TealAuthError}
     * @private
     */
    async _createSession() {
        const url = `${this._pdsEndpoint}/xrpc/com.atproto.server.createSession`;

        let resp;
        try {
            resp = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                body: JSON.stringify({
                    identifier: this._handle,
                    password: this._appPassword,
                }),
            });
        } catch (err) {
            throw new TealSubmissionError(
                `Failed to create session: ${err.message}`
            );
        }

        if (!resp.ok) {
            const body = await this._safeJson(resp);
            const msg =
                body && body.message
                    ? body.message
                    : `Session creation failed (HTTP ${resp.status})`;
            if (resp.status === 401 || resp.status === 403) {
                throw new TealAuthError(
                    `Authentication failed: ${msg}. Check your handle and app password.`,
                    { status: resp.status, body }
                );
            }
            throw new TealSubmissionError(msg, { status: resp.status, body });
        }

        const data = await resp.json();
        this._accessJwt = data.accessJwt;
        this._refreshJwt = data.refreshJwt;
        if (data.did) this._did = data.did;
        // Some PDSes return the canonical handle; update ours.
        if (data.handle) this._handle = data.handle;
    }

    /**
     * Refresh an expired session using the refresh JWT.
     *
     * @returns {Promise<void>}
     * @private
     */
    async _refreshSession() {
        const url = `${this._pdsEndpoint}/xrpc/com.atproto.server.refreshSession`;

        let resp;
        try {
            resp = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Authorization": `Bearer ${this._refreshJwt}`,
                },
            });
        } catch (err) {
            throw new TealSubmissionError(
                `Failed to refresh session: ${err.message}`
            );
        }

        if (!resp.ok) {
            // Refresh failed — force full re-init on next call.
            this._authenticated = false;
            this._accessJwt = undefined;
            this._refreshJwt = undefined;
            const body = await this._safeJson(resp);
            throw new TealAuthError(
                `Session refresh failed (HTTP ${resp.status})`,
                { status: resp.status, body }
            );
        }

        const data = await resp.json();
        this._accessJwt = data.accessJwt;
        this._refreshJwt = data.refreshJwt || this._refreshJwt;
    }

    /**
     * Create a record on the PDS.
     *
     * @param {Object} record - The play record (without collection/repo wrapper).
     * @param {string} rkey   - The TID record key.
     * @returns {Promise<{ uri: string, cid: string }>}
     * @throws {TealSubmissionError|TealAuthError|TealRateLimitError}
     * @private
     */
    async _createRecord(record, rkey) {
        const url = `${this._pdsEndpoint}/xrpc/com.atproto.repo.createRecord`;

        let resp;
        try {
            resp = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Authorization": `Bearer ${this._accessJwt}`,
                },
                body: JSON.stringify({
                    repo: this._did,
                    collection: COLLECTION,
                    rkey: rkey,
                    record: record,
                }),
            });
        } catch (err) {
            throw new TealSubmissionError(
                `Network error creating record: ${err.message}`
            );
        }

        if (!resp.ok) {
            const body = await this._safeJson(resp);

            if (resp.status === 401 || resp.status === 403) {
                throw new TealAuthError(
                    `Auth error creating record (HTTP ${resp.status})`,
                    { status: resp.status, body }
                );
            }

            if (resp.status === 429) {
                const retryAfter = resp.headers.get("Retry-After") || undefined;
                throw new TealRateLimitError(
                    `Rate limited by PDS (HTTP 429)`,
                    { status: 429, body, retryAfter }
                );
            }

            const msg =
                body && body.message
                    ? body.message
                    : `Record creation failed (HTTP ${resp.status})`;
            throw new TealSubmissionError(msg, {
                status: resp.status,
                body,
            });
        }

        const data = await resp.json();
        return { uri: data.uri, cid: data.cid };
    }

    /* ── Helpers ────────────────────────────────────────────────────── */

    /**
     * Build the final record object from user-supplied playData, filling
     * in defaults from client config.
     *
     * @param {Object} playData
     * @returns {Object} Record ready for createRecord.
     * @private
     */
    _buildRecord(playData) {
        const record = {
            $type: COLLECTION,
            trackName: String(playData.trackName || "Unknown Track").slice(0, 256),
        };

        // Prefer the modern `artists` array; fall back to nothing.
        if (Array.isArray(playData.artists) && playData.artists.length > 0) {
            record.artists = playData.artists.map((a) => ({
                artistName: String(a.artistName).slice(0, 256),
                ...(a.artistMbId ? { artistMbId: String(a.artistMbId) } : {}),
            }));
        }

        if (playData.releaseName != null) {
            record.releaseName = String(playData.releaseName).slice(0, 256);
        }

        if (typeof playData.duration === "number" && isFinite(playData.duration)) {
            record.duration = Math.floor(playData.duration);
        }

        if (playData.playedTime) {
            record.playedTime = String(playData.playedTime);
        } else {
            record.playedTime = new Date().toISOString();
        }

        record.submissionClientAgent = this._userAgent;
        record.musicServiceBaseDomain = this._musicServiceBaseDomain;

        return record;
    }

    /**
     * Safely parse a JSON response body, returning null on failure.
     *
     * @param {Response} resp
     * @returns {Promise<*>}
     * @private
     */
    async _safeJson(resp) {
        try {
            return await resp.json();
        } catch (_err) {
            return null;
        }
    }

    /* ── Accessors ──────────────────────────────────────────────────── */

    /**
     * Whether the client currently holds an active session.
     * @returns {boolean}
     */
    isAuthenticated() {
        return this._authenticated;
    }

    /**
     * The resolved DID (available after `init()`).
     * @returns {string|undefined}
     */
    getDid() {
        return this._did;
    }

    /**
     * The resolved PDS endpoint URL (available after `init()`).
     * @returns {string|undefined}
     */
    getPdsEndpoint() {
        return this._pdsEndpoint;
    }
}

/* ── Module exports ────────────────────────────────────────────────── */

module.exports = {
    TealClient,
    TealSubmissionError,
    TealAuthError,
    TealRateLimitError,
    generateTid,
    parseArtists,
    CLIENT_AGENT,
    COLLECTION,
};
