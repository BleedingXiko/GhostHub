/**
 * Shared selectors for normalized media views.
 *
 * This is the only layer that projects ordered media ids into hydrated records.
 */

import { mediaManifest } from './manifest.js';
import { mediaOrdering } from './ordering.js';

const EMPTY_VIEW = Object.freeze({
    viewKey: null,
    viewType: null,
    orderedIds: Object.freeze([]),
    status: 'idle',
    hasMore: false,
    pageToken: null,
    viewMeta: Object.freeze({}),
    error: null,
});

const projectionCache = new WeakMap();

function getRecordsVersion() {
    const manifest = getManifestModule();
    return manifest.recordsVersion ?? manifest.state?.version ?? 0;
}

function getManifestModule() {
    return globalThis.window?.ragotModules?.mediaManifest || mediaManifest;
}

function getOrderingModule() {
    return globalThis.window?.ragotModules?.mediaOrdering || mediaOrdering;
}

function normalizeView(viewKey, view) {
    if (!view) return { ...EMPTY_VIEW, viewKey };
    return {
        viewKey,
        viewType: view.viewType || null,
        orderedIds: Array.isArray(view.orderedIds) ? view.orderedIds : [],
        status: view.status || 'idle',
        hasMore: view.hasMore === true,
        pageToken: view.pageToken || null,
        viewMeta: view.viewMeta || {},
        error: view.error || null,
        params: view.params || {},
    };
}

export function selectView(viewKey) {
    if (!viewKey) return null;
    const ordering = getOrderingModule();
    if (typeof ordering.selectView === 'function') {
        return normalizeView(viewKey, ordering.selectView(viewKey));
    }
    return normalizeView(viewKey, ordering.getOrder(viewKey));
}

export function selectParams(viewKey) {
    return selectView(viewKey)?.params || {};
}

export function selectRecordsForView(viewKey) {
    const view = selectView(viewKey);
    const orderedIds = view?.orderedIds || [];
    if (orderedIds.length === 0) return [];

    const recordsVersion = getRecordsVersion();
    const cached = projectionCache.get(orderedIds);
    if (cached && cached.recordsVersion === recordsVersion) {
        return cached.records;
    }

    const records = getManifestModule().getMany(orderedIds);
    projectionCache.set(orderedIds, { recordsVersion, records });
    return records;
}

export function selectRecordAt(viewKey, index) {
    const id = selectIdAt(viewKey, index);
    return id ? getManifestModule().get(id) : null;
}

export function selectFilteredRecords(records, mediaFilter = 'all') {
    if (!Array.isArray(records) || mediaFilter === 'all' || !mediaFilter) {
        return records || [];
    }
    return records.filter((record) => record?.type === mediaFilter);
}

export function selectChunkRecords(viewKey, chunkStart, chunkSize, mediaFilter = 'all') {
    const view = selectView(viewKey);
    if (!view?.orderedIds?.length) return [];
    const start = Math.max(0, Number(chunkStart) || 0);
    const size = Math.max(0, Number(chunkSize) || 0);
    const ids = view.orderedIds.slice(start, start + size);
    const records = getManifestModule().getMany(ids);
    return selectFilteredRecords(records, mediaFilter);
}

export function selectIdAt(viewKey, index) {
    const view = selectView(viewKey);
    const numericIndex = Number(index);
    if (!view || !Number.isInteger(numericIndex) || numericIndex < 0) return null;
    return view.orderedIds?.[numericIndex] || null;
}

export function selectIndexOf(viewKey, id) {
    if (!id) return -1;
    const view = selectView(viewKey);
    if (!view?.orderedIds) return -1;
    return view.orderedIds.indexOf(id);
}

/**
 * Returns ids in the window that have neither been hydrated nor confirmed
 * missing. Drives mediaManifest.requestHydration. Does not include 404'd ids.
 */
export function selectUnhydratedIdsInWindow(viewKey, start, end) {
    const view = selectView(viewKey);
    if (!view?.orderedIds?.length) return [];
    const from = Math.max(0, Number(start) || 0);
    const to = Math.max(from, Number(end) || from);
    return view.orderedIds
        .slice(from, to)
        .filter((id) => {
            const manifest = getManifestModule();
            return id && manifest.isMissing(id) === false && manifest.has(id) === false;
        });
}

export function subscribeView(viewKey, callback, options = {}) {
    if (!viewKey || typeof callback !== 'function') return () => {};
    const ordering = getOrderingModule();
    const manifest = getManifestModule();
    const initialView = selectView(viewKey);
    let previousOrderedIds = initialView?.orderedIds || [];
    let previousRecordsVersion = getRecordsVersion();
    let previousStatus = initialView?.status || 'idle';

    const notifyIfChanged = () => {
        const next = selectView(viewKey);
        const nextOrderedIds = next?.orderedIds || [];
        const nextRecordsVersion = getRecordsVersion();
        const nextStatus = next?.status || 'idle';
        const dirtyIds = manifest.dirtyIds instanceof Set ? manifest.dirtyIds : new Set();
        const orderChanged = nextOrderedIds !== previousOrderedIds;
        const statusChanged = nextStatus !== previousStatus;
        const recordsChanged = (
            nextRecordsVersion !== previousRecordsVersion &&
            nextOrderedIds.some((id) => dirtyIds.has(id))
        );
        if (!orderChanged && !recordsChanged && !statusChanged) return;
        previousOrderedIds = nextOrderedIds;
        previousRecordsVersion = nextRecordsVersion;
        previousStatus = nextStatus;
        callback(next);
    };

    const unsubscribeOrdering = ordering.subscribe(notifyIfChanged);
    const unsubscribeManifest = manifest.subscribe(notifyIfChanged);
    let active = true;
    const unsubscribe = () => {
        if (!active) return;
        active = false;
        unsubscribeOrdering?.();
        unsubscribeManifest?.();
    };
    options?.owner?.addCleanup?.(unsubscribe);
    return unsubscribe;
}
