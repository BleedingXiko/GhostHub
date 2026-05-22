/**
 * Media ordering cache for normalized media views.
 */

import { Module } from '../../libs/ragot.esm.min.js';
import { getShowHiddenHeaders } from '../../utils/showHiddenManager.js';
import { cachedFetch } from '../../utils/requestCache.js';
import { mediaManifest } from './manifest.js';

const ORDER_TIMEOUT_MS = 30000;
const MAX_VIEWS = 64;

const IDLE_VIEW = Object.freeze({
    viewKey: null,
    viewType: null,
    orderedIds: Object.freeze([]),
    hasMore: false,
    pageToken: null,
    viewMeta: Object.freeze({}),
    status: 'idle',
    error: null,
    requestId: 0,
    params: Object.freeze({}),
});

function sameOrderedIds(a = [], b = []) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export class MediaOrderingModule extends Module {
    constructor() {
        super({ version: 0 });
        this.orders = new Map();
    }

    getOrder(viewKey) {
        return this.selectView(viewKey);
    }

    selectView(viewKey) {
        const entry = this.orders.get(viewKey);
        if (entry) {
            this._touch(viewKey, entry);
            return entry;
        }
        return {
            ...IDLE_VIEW,
            viewKey: viewKey || null,
            orderedIds: [],
            viewMeta: {},
            params: {},
        };
    }

    ingestView(viewKey, view = {}) {
        if (!viewKey) return this.selectView(viewKey);
        const previous = this.selectView(viewKey);
        const next = {
            ...previous,
            ...view,
            viewKey,
            viewType: view.viewType || view.view || previous.viewType || null,
            orderedIds: sameOrderedIds(previous.orderedIds, view.orderedIds)
                ? previous.orderedIds
                : (Array.isArray(view.orderedIds) ? view.orderedIds : []),
            hasMore: view.hasMore === true,
            pageToken: view.pageToken || null,
            viewMeta: view.viewMeta || {},
            status: view.status || 'ready',
            error: view.error || null,
            params: view.params || previous.params || {},
            paramsKey: view.params ? this._paramsKey(view.params) : previous.paramsKey,
            abortController: null,
        };
        this._touch(viewKey, next);
        this._evictViews();
        this._bump();
        return next;
    }

    async requestOrder(viewKey, viewType, params = {}, options = {}) {
        if (!viewKey || !viewType) throw new Error('viewKey and viewType are required');
        const previous = this.orders.get(viewKey);
        const paramsKey = this._paramsKey(params);
        const appending = this._isAppendRequest(params, options);
        if (
            !appending &&
            previous?.status === 'ready' &&
            previous.viewType === viewType &&
            previous.paramsKey === paramsKey &&
            options.bypassClientCache !== true
        ) {
            return previous;
        }
        previous?.abortController?.abort?.();

        const requestId = (previous?.requestId || 0) + 1;
        const abortController = new AbortController();
        const timeoutId = this.timeout(() => abortController.abort(), ORDER_TIMEOUT_MS);

        // If the caller supplied an external abort signal, listen on it to
        // cascade the abort into our internal controller.
        let externalAbortCleanup = null;
        if (options.signal) {
            if (options.signal.aborted) {
                abortController.abort();
            } else {
                const onExternalAbort = () => abortController.abort();
                options.signal.addEventListener('abort', onExternalAbort, { once: true });
                externalAbortCleanup = () => options.signal.removeEventListener('abort', onExternalAbort);
            }
        }

        const entry = {
            viewKey,
            orderedIds: previous?.orderedIds || [],
            hasMore: previous?.hasMore || false,
            pageToken: previous?.pageToken || null,
            viewMeta: previous?.viewMeta || {},
            status: 'fetching',
            error: null,
            requestId,
            abortController,
            viewType,
            params,
            paramsKey,
        };
        this._touch(viewKey, entry);
        this._evictViews();
        this._bump();

        const url = this._buildUrl(viewType, params);
        try {
            const fetchOptions = {
                headers: getShowHiddenHeaders(),
                signal: abortController.signal,
                timeout: ORDER_TIMEOUT_MS,
            };
            const response = options.bypassClientCache
                ? await fetch(url, { ...fetchOptions, cache: 'no-store' })
                : await cachedFetch(url, fetchOptions);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const current = this.orders.get(viewKey);
            if (!current || current.requestId !== requestId) return current;
            const incomingIds = Array.isArray(data.orderedIds) ? data.orderedIds : [];
            const orderedIds = appending
                ? this._mergeIds(previous?.orderedIds || [], incomingIds)
                : incomingIds;
            this._manifest().ingest(data.records || {}, data.missing || []);
            const next = {
                ...current,
                orderedIds,
                hasMore: data.hasMore === true,
                pageToken: data.pageToken || null,
                viewMeta: data.viewMeta || {},
                status: 'ready',
                error: null,
                abortController: null,
            };
            this._touch(viewKey, next);
            this._evictViews();
            this._bump();
            return next;
        } catch (error) {
            const current = this.orders.get(viewKey);
            if (!current || current.requestId !== requestId) return current;
            const next = {
                ...current,
                status: 'error',
                error: error?.name === 'AbortError' ? 'Request timed out or was cancelled' : String(error?.message || error),
                abortController: null,
            };
            this._touch(viewKey, next);
            this._evictViews();
            this._bump();
            return next;
        } finally {
            this.clearTimeout(timeoutId);
            externalAbortCleanup?.();
        }
    }

    invalidateView(viewKey) {
        const entry = this.orders.get(viewKey);
        if (!entry) return;
        entry?.abortController?.abort?.();
        // Mark stale in place. Keep orderedIds so the layout keeps showing the
        // last known list until the refetch lands (otherwise every rename/hide
        // would flash the row empty). Use Map.set on an existing key — _touch
        // would re-insert at tail and break iteration in invalidateCategoryViews.
        this.orders.set(viewKey, {
            ...entry,
            status: 'stale',
            abortController: null,
        });
        this._bump();
    }

    /**
     * Drop specific ids from every view's orderedIds.
     *
     * Surgical invalidation (rename, delete) needs the row to rebuild its
     * VS *immediately* — not only after the refetch lands. The row decides
     * to rebuild when the orderedIds *reference* changes; just removing the
     * record from the manifest leaves the same orderedIds array in place,
     * so the row falls back to vs.reset() which does NOT re-render chunks.
     * Returning a fresh array here flips the reference and forces a rebuild
     * before the refetch arrives, then a second rebuild when the new data
     * lands.
     */
    dropIdsFromAllViews(ids) {
        const idSet = new Set((ids || []).filter(Boolean));
        if (idSet.size === 0) return;
        let changed = false;
        for (const [viewKey, entry] of this.orders) {
            const orderedIds = entry?.orderedIds;
            if (!Array.isArray(orderedIds) || orderedIds.length === 0) continue;
            if (!orderedIds.some((id) => idSet.has(id))) continue;
            const next = orderedIds.filter((id) => !idSet.has(id));
            this.orders.set(viewKey, { ...entry, orderedIds: next });
            changed = true;
        }
        if (changed) this._bump();
    }

    invalidateCategoryViews(categoryId) {
        if (!categoryId) return;
        for (const [viewKey, entry] of this.orders) {
            if (viewKey.includes(`::${categoryId}`) || entry?.params?.category_id === categoryId) {
                this.invalidateView(viewKey);
            }
        }
    }

    /**
     * Mark every cached order entry stale. Used when global visibility flips
     * (show_hidden toggle) — every cached order was computed under the prior
     * visibility flag, and any read that finds status==='ready' would otherwise
     * skip the network and return the wrong orderedIds + viewMeta.subfolders.
     */
    invalidateAllViews() {
        const keys = Array.from(this.orders.keys());
        for (const viewKey of keys) {
            const entry = this.orders.get(viewKey);
            entry?.abortController?.abort?.();
            if (entry) {
                this.orders.set(viewKey, {
                    ...entry,
                    status: 'stale',
                    abortController: null,
                });
            }
        }
        this._bump();
    }

    onStop() {
        for (const entry of this.orders.values()) {
            entry?.abortController?.abort?.();
        }
        this.orders.clear();
    }

    _buildUrl(viewType, params) {
        const query = new URLSearchParams();
        query.set('view', viewType);
        Object.entries(params || {}).forEach(([key, value]) => {
            if (value === null || value === undefined || value === '') return;
            query.set(key, String(value));
        });
        return `/api/media/order?${query.toString()}`;
    }

    _paramsKey(params) {
        return JSON.stringify(Object.entries(params || {}).sort(([a], [b]) => a.localeCompare(b)));
    }

    _isAppendRequest(params = {}, options = {}) {
        if (options.append === true) return true;
        if (Object.prototype.hasOwnProperty.call(params || {}, 'pageToken')) return true;
        const page = Number(params?.page);
        return Number.isFinite(page) && page > 1;
    }

    _mergeIds(previousIds = [], nextIds = []) {
        const merged = [];
        const seen = new Set();
        for (const id of [...previousIds, ...nextIds]) {
            if (!id || seen.has(id)) continue;
            seen.add(id);
            merged.push(id);
        }
        return merged;
    }

    _touch(viewKey, entry) {
        if (!viewKey) return;
        this.orders.delete(viewKey);
        this.orders.set(viewKey, entry);
    }

    _evictViews() {
        while (this.orders.size > MAX_VIEWS) {
            const [viewKey, entry] = this.orders.entries().next().value || [];
            if (!viewKey) return;
            entry?.abortController?.abort?.();
            this.orders.delete(viewKey);
            this._manifest().unpin(viewKey);
        }
    }

    _manifest() {
        return globalThis.window?.ragotModules?.mediaManifest || mediaManifest;
    }

    _bump() {
        this.setState({ version: this.state.version + 1 });
    }
}

export const mediaOrdering = new MediaOrderingModule();
