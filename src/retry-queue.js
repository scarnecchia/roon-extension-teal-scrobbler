"use strict";

const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

/**
 * RetryQueue buffers play submissions that failed (network error, auth
 * failure, rate limit) and retries them with exponential backoff.
 *
 * Plays are persisted to a JSON file on disk so they survive extension
 * restarts — a user whose PDS was temporarily unreachable will not lose
 * scrobbles.
 *
 * Events:
 *   - "retried"    { playData, result }   A queued play was successfully submitted.
 *   - "failed"     { playData, error }     A retry attempt failed; play remains queued.
 *   - "dropped"    { playData }            A play was dropped after max attempts.
 *   - "drained"                           The queue is empty (all plays submitted).
 *   - "enqueue"    { playData, queueSize } A play was added to the queue.
 */

/**
 * Default backoff configuration (exponential with jitter).
 */
const DEFAULTS = {
    maxAttempts:   10,         // total attempts per play before dropping
    baseDelayMs:   5_000,      // initial backoff (5s)
    maxDelayMs:    600_000,    // cap at 10 min
    flushIntervalMs: 30_000,   // periodic retry sweep (30s)
    maxQueueSize:  500,        // drop oldest plays if queue exceeds this
};

class RetryQueue extends EventEmitter {
    /**
     * @param {Object} [opts]
     * @param {number} [opts.maxAttempts]
     * @param {number} [opts.baseDelayMs]
     * @param {number} [opts.maxDelayMs]
     * @param {number} [opts.flushIntervalMs]
     * @param {number} [opts.maxQueueSize]
     * @param {string} [opts.persistPath]  File path for disk persistence. If omitted, in-memory only.
     */
    constructor(opts = {}) {
        super();
        this._opts = { ...DEFAULTS, ...opts };

        /** @type {Array<{ playData: object, attempts: number, nextAttempt: number }>} */
        this._queue = [];

        /** @type {Function|null} Submit function provided by TealClient */
        this._submitFn = null;

        this._flushTimer = null;
        this._flushing = false;
        this._persistTimer = null;

        // Load persisted queue from disk.
        if (this._opts.persistPath) {
            this._load();
        }
    }

    /* ── Public API ─────────────────────────────────────────────────── */

    /**
     * Register the submission function. Typically:
     *   queue.setSubmitFn((playData) => tealClient.submit(playData));
     *
     * @param {Function} fn  Async function: playData → { uri, cid }
     */
    setSubmitFn(fn) {
        this._submitFn = fn;
    }

    /**
     * Add a failed play to the queue.  The play will be retried according
     * to the backoff schedule on the next flush cycle.
     *
     * @param {object} playData  The play record to retry.
     */
    enqueue(playData) {
        // Enforce max queue size (drop oldest).
        if (this._queue.length >= this._opts.maxQueueSize) {
            const dropped = this._queue.shift();
            this.emit("dropped", { playData: dropped.playData });
            console.warn(
                `[retry] Queue full (${this._opts.maxQueueSize}) — dropping oldest play`
            );
        }

        const entry = {
            playData,
            attempts: 0,
            nextAttempt: Date.now() + this._delayFor(0),
        };
        this._queue.push(entry);
        this._persist();

        this.emit("enqueue", { playData, queueSize: this._queue.length });
    }

    /**
     * Start the periodic retry flush. Requires setSubmitFn() to have been called.
     */
    start() {
        if (this._flushTimer) return;
        this._flushTimer = setInterval(
            () => this.flush(),
            this._opts.flushIntervalMs
        );
        // Don't keep the process alive just for the timer.
        if (this._flushTimer.unref) this._flushTimer.unref();
    }

    /**
     * Stop the periodic retry flush.
     */
    stop() {
        if (this._flushTimer) {
            clearInterval(this._flushTimer);
            this._flushTimer = null;
        }
        if (this._persistTimer) {
            clearTimeout(this._persistTimer);
            this._persistTimer = null;
        }
        this._persistSync();
    }

    /**
     * Attempt to submit all due plays. Called periodically by start()
     * or manually after the client reconnects.
     */
    async flush() {
        if (this._flushing || !this._submitFn || this._queue.length === 0) {
            return;
        }
        this._flushing = true;

        try {
            const now = Date.now();
            const due = this._queue.filter((e) => e.nextAttempt <= now);

            for (const entry of due) {
                const success = await this._trySubmit(entry);
                if (success) {
                    // Remove from queue.
                    const idx = this._queue.indexOf(entry);
                    if (idx !== -1) this._queue.splice(idx, 1);
                } else {
                    // Check if exhausted.
                    if (entry.attempts >= this._opts.maxAttempts) {
                        const idx = this._queue.indexOf(entry);
                        if (idx !== -1) this._queue.splice(idx, 1);
                        this.emit("dropped", { playData: entry.playData });
                        console.warn(
                            `[retry] Play dropped after ${entry.attempts} attempts`
                        );
                    }
                }
            }

            this._persist();

            if (this._queue.length === 0) {
                this.emit("drained");
            }
        } finally {
            this._flushing = false;
        }
    }

    /**
     * Current queue depth.
     * @returns {number}
     */
    get size() {
        return this._queue.length;
    }

    /* ── Internals ──────────────────────────────────────────────────── */

    /**
     * Attempt a single submission, updating the entry's attempt count
     * and next-attempt time.
     *
     * @returns {Promise<boolean>} true if successful, false if it should be retried.
     */
    async _trySubmit(entry) {
        entry.attempts++;

        try {
            const result = await this._submitFn(entry.playData);
            this.emit("retried", { playData: entry.playData, result });
            console.log(
                `[retry] Play submitted after ${entry.attempts} attempt(s)`
            );
            return true;
        } catch (err) {
            this.emit("failed", { playData: entry.playData, error: err });
            console.error(
                `[retry] Attempt ${entry.attempts}/${this._opts.maxAttempts} failed: ${err.message}`
            );

            // Schedule next attempt with backoff.
            entry.nextAttempt = Date.now() + this._delayFor(entry.attempts);
            return false;
        }
    }

    /**
     * Compute the backoff delay for a given attempt number (0-indexed).
     * Exponential: base * 2^attempt, capped at maxDelay, with ±25% jitter.
     *
     * @param {number} attempt  Zero-indexed attempt number.
     * @returns {number} Delay in milliseconds.
     */
    _delayFor(attempt) {
        const exponential = this._opts.baseDelayMs * Math.pow(2, attempt);
        const capped = Math.min(exponential, this._opts.maxDelayMs);
        const jitter = capped * (0.75 + Math.random() * 0.5); // ±25%
        return Math.floor(jitter);
    }

    /* ── Persistence ────────────────────────────────────────────────── */

    _persist() {
        if (!this._opts.persistPath) return;
        if (this._persistTimer) return;
        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            this._persistNow();
        }, 500);
        if (this._persistTimer.unref) this._persistTimer.unref();
    }

    _persistSync() {
        if (!this._opts.persistPath) return;
        try {
            const dir = path.dirname(this._opts.persistPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this._opts.persistPath, JSON.stringify(this._queue), "utf8");
        } catch (err) {
            console.warn(`[retry] Failed to persist queue: ${err.message}`);
        }
    }

    _persistNow() {
        if (!this._opts.persistPath) return;
        try {
            const dir = path.dirname(this._opts.persistPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFile(
                this._opts.persistPath,
                JSON.stringify(this._queue),
                "utf8",
                (err) => {
                    if (err) console.warn(`[retry] Failed to persist queue: ${err.message}`);
                }
            );
        } catch (err) {
            console.warn(`[retry] Failed to persist queue: ${err.message}`);
        }
    }

    /**
     * Load the queue from disk (best-effort).
     */
    _load() {
        if (!this._opts.persistPath) return;
        try {
            if (!fs.existsSync(this._opts.persistPath)) return;
            const data = fs.readFileSync(this._opts.persistPath, "utf8");
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
                // Reset attempt timing so persisted plays are retried soon.
                this._queue = parsed.map((e) => ({
                    playData: e.playData,
                    attempts: e.attempts || 0,
                    nextAttempt: Date.now(),
                }));
                if (this._queue.length > 0) {
                    console.log(
                        `[retry] Loaded ${this._queue.length} queued play(s) from disk`
                    );
                }
            }
        } catch (err) {
            console.warn(`[retry] Failed to load persisted queue: ${err.message}`);
        }
    }
}

module.exports = { RetryQueue };
