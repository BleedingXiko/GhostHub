/**
 * Normalized media record manifest.
 */

import { Module } from '../../libs/ragot.esm.min.js';
import { getShowHiddenHeaders } from '../../utils/showHiddenManager.js';

const HYDRATION_BATCH_DELAY_MS = 16;
const HYDRATION_BATCH_SIZE = 200;
const DEFAULT_MAX_RECORDS = 1200;
const LOW_MEMORY_MAX_RECORDS = 500;
const STANDARD_MAX_RECORDS = 1200;
const PRO_MAX_RECORDS = 2500;
const MAX_MISSING = 4000;
const FAILED_RETRY_BASE_MS = 750;
const FAILED_RETRY_MAX_MS = 10000;

function shallowRecordEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.is(a[key], b[key]));
}

// Manifest budgets are intentionally small for Raspberry Pi targets:
// LOW_MEMORY keeps a 2GB device responsive, STANDARD fits typical 4GB units,
// and PRO only expands on browsers that report 8GB+ device memory.
export function getManifestRecordBudget(
    runtime = globalThis.window?.ragotModules?.appRuntime,
    nav = globalThis.navigator
) {
    if (runtime?.LOW_MEMORY_DEVICE === true) return LOW_MEMORY_MAX_RECORDS;

    const deviceMemory = Number(nav?.deviceMemory);
    if (Number.isFinite(deviceMemory)) {
        if (deviceMemory <= 2) return LOW_MEMORY_MAX_RECORDS;
        if (deviceMemory >= 8) return PRO_MAX_RECORDS;
        return STANDARD_MAX_RECORDS;
    }

    return DEFAULT_MAX_RECORDS;
}

export class MediaManifestModule extends Module {
    constructor() {
        super({ version: 0 });
        this.records = new Map();
        this.recordsVersion = 0;
        this.missing = new Set();
        this.dirtyIds = new Set();
        this._pendingDirtyIds = new Set();
        this.failed = new Map();
        this._lru = new Map();
        this._touchCounter = 0;
        this._pins = new Map();
        this._queue = new Set();
        this._inFlight = new Set();
        this._flushTimer = null;
        this._retryTimer = null;
    }

    get(id) {
        const record = this.records.get(id) || null;
        if (record) this._touch(id);
        return record;
    }

    has(id) {
        return this.records.has(id);
    }

    isMissing(id) {
        return this.missing.has(id);
    }

    isFailed(id) {
        return this.failed.has(id);
    }

    getMany(ids) {
        return (ids || []).map((id) => this.get(id)).filter(Boolean);
    }

    ingest(records = {}, missing = []) {
        let changed = false;
        for (const [id, record] of Object.entries(records || {})) {
            if (!id || !record) continue;
            const previous = this.records.get(id);
            const recordChanged = !previous || !shallowRecordEqual(previous, record);
            const missingChanged = this.missing.delete(id);
            const failedChanged = this.failed.delete(id);
            if (recordChanged) {
                this.records.set(id, record);
                this._markDirty(id);
            }
            this._touch(id);
            changed = changed || recordChanged || missingChanged || failedChanged;
        }
        for (const id of missing || []) {
            if (!id) continue;
            const missingChanged = !this.missing.has(id);
            const failedChanged = this.failed.delete(id);
            if (missingChanged) {
                this.missing.add(id);
                this._markDirty(id);
            }
            changed = changed || missingChanged || failedChanged;
        }
        if (!changed) return;
        this._capMissing();
        this._evict();
        this._bumpRecords();
    }

    requestHydration(ids) {
        const missingIds = [];
        const now = Date.now();
        for (const id of ids || []) {
            if (!id || this.records.has(id) || this.missing.has(id) || this._inFlight.has(id)) continue;
            const failure = this.failed.get(id);
            if (failure && failure.retryAt > now) continue;
            this._queue.add(id);
            missingIds.push(id);
        }
        if (missingIds.length > 0) this._scheduleFlush();
        return missingIds;
    }

    hydrate(ids, timeoutMs = 15000, signal = null) {
        const targetIds = (ids || []).filter(Boolean);
        if (signal?.aborted) {
            return Promise.resolve(this.getMany(targetIds));
        }
        this.requestHydration(targetIds);
        if (this._isSettled(targetIds)) {
            return Promise.resolve(this.getMany(targetIds));
        }
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                unsubscribe?.();
                this.clearTimeout(timerId);
                cleanupSignal?.();
                resolve(this.getMany(targetIds));
            };
            const unsubscribe = this.subscribe(() => {
                if (this._isSettled(targetIds)) finish();
            });
            const timerId = this.timeout(finish, timeoutMs);

            let cleanupSignal = null;
            if (signal) {
                const onAbort = () => finish();
                signal.addEventListener('abort', onAbort, { once: true });
                cleanupSignal = () => signal.removeEventListener('abort', onAbort);
            }
        });
    }

    pin(viewKey, ids) {
        if (!viewKey) return;
        const nextIds = new Set((ids || []).filter(Boolean));
        const previous = this._pins.get(viewKey);
        if (previous && previous.size === nextIds.size) {
            let same = true;
            for (const id of nextIds) {
                if (!previous.has(id)) {
                    same = false;
                    break;
                }
            }
            if (same) return;
        }
        this._pins.set(viewKey, nextIds);
    }

    unpin(viewKey) {
        if (!viewKey) return;
        this._pins.delete(viewKey);
    }

    invalidateIds(ids) {
        let changed = false;
        for (const id of ids || []) {
            let idChanged = false;
            if (this.records.delete(id)) idChanged = true;
            if (this.missing.delete(id)) idChanged = true;
            if (this.failed.delete(id)) idChanged = true;
            if (idChanged) {
                changed = true;
                this._markDirty(id);
            }
            this._lru.delete(id);
            this._queue.delete(id);
            this._inFlight.delete(id);
        }
        if (changed) this._bumpRecords();
    }

    invalidateCategory(categoryId) {
        if (!categoryId) return;
        const dropIds = [];
        for (const [id, record] of this.records) {
            if (record?.categoryId === categoryId) dropIds.push(id);
        }
        for (const id of this.missing) {
            if (id.startsWith(`${categoryId}::`)) dropIds.push(id);
        }
        for (const id of this.failed.keys()) {
            if (id.startsWith(`${categoryId}::`)) dropIds.push(id);
        }
        this.invalidateIds(dropIds);
    }

    clear() {
        for (const id of this.records.keys()) this._markDirty(id);
        for (const id of this.missing) this._markDirty(id);
        for (const id of this.failed.keys()) this._markDirty(id);
        this.records.clear();
        this.missing.clear();
        this.failed.clear();
        this._lru.clear();
        this._queue.clear();
        this._inFlight.clear();
        this._bumpRecords();
    }

    onStop() {
        if (this._flushTimer) {
            this.clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
        if (this._retryTimer) {
            this.clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
    }

    _scheduleFlush() {
        if (this._flushTimer) return;
        this._flushTimer = this.timeout(() => {
            this._flushTimer = null;
            this._flushHydrationQueue();
        }, HYDRATION_BATCH_DELAY_MS);
    }

    async _flushHydrationQueue() {
        if (this._queue.size === 0) return;
        const ids = Array.from(this._queue);
        this._queue.clear();
        for (let start = 0; start < ids.length; start += HYDRATION_BATCH_SIZE) {
            const batch = ids.slice(start, start + HYDRATION_BATCH_SIZE)
                .filter((id) => !this.records.has(id) && !this.missing.has(id) && !this._inFlight.has(id));
            if (batch.length === 0) continue;
            batch.forEach((id) => this._inFlight.add(id));
            await this._hydrateBatch(batch);
        }
    }

    async _hydrateBatch(ids) {
        try {
            const response = await fetch('/api/media/records', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...getShowHiddenHeaders(),
                },
                body: JSON.stringify({ ids }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            
            const returnedRecords = data.records || {};
            const returnedMissing = data.missing || [];
            
            const missingFallback = [...returnedMissing];
            for (const id of ids) {
                if (!returnedRecords[id] && !returnedMissing.includes(id)) {
                    missingFallback.push(id);
                }
            }
            this.ingest(returnedRecords, missingFallback);
        } catch (error) {
            console.error('[MediaManifest] Hydration failed:', error);
            const now = Date.now();
            ids.forEach((id) => {
                const previous = this.failed.get(id);
                const attempts = (previous?.attempts || 0) + 1;
                const delay = Math.min(
                    FAILED_RETRY_MAX_MS,
                    FAILED_RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 5)),
                );
                this.failed.set(id, {
                    attempts,
                    retryAt: now + delay,
                    error: String(error?.message || error),
                });
            });
            this._scheduleRetry();
            this._bump();
        } finally {
            ids.forEach((id) => this._inFlight.delete(id));
        }
    }

    _touch(id) {
        this._touchCounter += 1;
        this._lru.set(id, this._touchCounter);
    }

    _markDirty(id) {
        if (id) this._pendingDirtyIds.add(id);
    }

    _capMissing() {
        if (this.missing.size <= MAX_MISSING) return;
        const dropCount = Math.max(1, Math.ceil(MAX_MISSING * 0.25));
        for (const id of this.missing) {
            this.missing.delete(id);
            if (this.missing.size <= MAX_MISSING - dropCount) break;
        }
    }

    _pinnedIds() {
        const pinned = new Set();
        for (const ids of this._pins.values()) {
            ids.forEach((id) => pinned.add(id));
        }
        return pinned;
    }

    _isSettled(ids) {
        const now = Date.now();
        return (ids || []).every((id) => {
            if (this.records.has(id) || this.missing.has(id)) return true;
            const failure = this.failed.get(id);
            return Boolean(failure && failure.retryAt > now);
        });
    }

    _scheduleRetry() {
        if (this._retryTimer || this.failed.size === 0) return;
        const now = Date.now();
        const nextRetryAt = Math.min(...Array.from(this.failed.values()).map((failure) => failure.retryAt));
        const delay = Math.max(0, nextRetryAt - now);
        this._retryTimer = this.timeout(() => {
            this._retryTimer = null;
            this._retryFailedPinnedIds();
        }, delay);
    }

    _retryFailedPinnedIds() {
        const now = Date.now();
        const pinned = this._pinnedIds();
        const retryIds = [];
        for (const [id, failure] of this.failed.entries()) {
            if (failure.retryAt > now) continue;
            if (!pinned.has(id)) {
                this.failed.delete(id);
                continue;
            }
            if (this.records.has(id) || this.missing.has(id) || this._inFlight.has(id)) continue;
            retryIds.push(id);
        }
        retryIds.forEach((id) => this._queue.add(id));
        if (retryIds.length > 0) this._scheduleFlush();
        if (this.failed.size > 0) this._scheduleRetry();
        if (retryIds.length > 0) this._bump();
    }

    _evict() {
        const maxRecords = getManifestRecordBudget();
        if (this.records.size <= maxRecords) return;
        const pinned = this._pinnedIds();
        const candidates = Array.from(this._lru.entries())
            .filter(([id]) => !pinned.has(id))
            .sort((a, b) => a[1] - b[1]);
        for (const [id] of candidates) {
            if (this.records.size <= maxRecords) break;
            this.records.delete(id);
            this._lru.delete(id);
        }
    }

    _bump() {
        this.setState({ version: this.state.version + 1 });
    }

    _bumpRecords() {
        this.dirtyIds = new Set([
            ...this.dirtyIds,
            ...this._pendingDirtyIds,
        ]);
        this._pendingDirtyIds.clear();
        this.recordsVersion += 1;
        const recordsVersion = this.recordsVersion;
        this._bump();
        const clearDirtyIds = () => {
            if (this.recordsVersion === recordsVersion) {
                this.dirtyIds = new Set();
            }
        };
        if (typeof queueMicrotask === 'function') {
            queueMicrotask(clearDirtyIds);
        } else {
            Promise.resolve().then(clearDirtyIds);
        }
    }
}

export const mediaManifest = new MediaManifestModule();
