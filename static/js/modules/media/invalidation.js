/**
 * Socket bridge for media manifest/order invalidation.
 */

import { Module, bus } from '../../libs/ragot.esm.min.js';
import { APP_EVENTS } from '../../core/appEvents.js';
import { SOCKET_EVENTS } from '../../core/socketEvents.js';
import { renameVideoProgress } from '../../utils/progressDB.js';

function categoryIdFromMediaUrl(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url, window.location.origin);
        const parts = parsed.pathname.split('/').filter(Boolean);
        return parts[0] === 'media' ? decodeURIComponent(parts[1] || '') || null : null;
    } catch (_) {
        const parts = String(url).split('?')[0].split('#')[0].split('/').filter(Boolean);
        return parts[0] === 'media' ? decodeURIComponent(parts[1] || '') || null : null;
    }
}

export class MediaInvalidationModule extends Module {
    constructor(manifest, ordering) {
        super({});
        this._manifest = manifest;
        this._ordering = ordering;
        this._socket = null;
        this._lastRenameEventKey = null;
    }

    attachSocket(socket) {
        if (!socket || socket === this._socket) return;
        this._socket = socket;
        this.onSocket(socket, SOCKET_EVENTS.CATEGORY_UPDATED, (payload) => this._handleCategoryUpdated(payload || {}));
        this.onSocket(socket, SOCKET_EVENTS.USB_MOUNTS_CHANGED, () => this.invalidateAll());
    }

    invalidateForCategory(categoryId, { refetch = true, wipeManifest = true } = {}) {
        if (!categoryId) return;
        const entries = this._entriesForCategory(categoryId);
        if (wipeManifest) this._manifest.invalidateCategory(categoryId);
        this._ordering.invalidateCategoryViews(categoryId);
        if (refetch) this._refetchEntries(entries);
    }

    invalidateAll({ refetch = true } = {}) {
        const entries = this._entriesForAll();
        this._manifest.clear();
        this._ordering.invalidateAllViews();
        if (refetch) this._refetchEntries(entries);
    }

    _handleCategoryUpdated(payload) {
        if (payload.reason === 'file_renamed') {
            this._emitFileRenamedUpdated(payload.old_path || payload.old_media_url, payload.new_path || payload.new_media_url);
        }

        const categoryIds = this._categoryIdsFromPayload(payload);
        const invalidatedIds = Array.isArray(payload.invalidatedIds)
            ? payload.invalidatedIds
            : [];

        if (payload.invalidateAll === true) {
            this.invalidateAll();
            return;
        }

        // If the server told us exactly which ids died (rename/delete), drop
        // only those records. Do NOT wipe the whole category's manifest —
        // that empties every still-valid card on screen until the refetch lands.
        const surgical = invalidatedIds.length > 0;

        // Snapshot which views referenced the dead ids BEFORE dropping them.
        // dropIdsFromAllViews mutates orderedIds in place, so doing this lookup
        // afterwards would always return []. The gallery_timeline view is
        // global (no category in its viewKey or params), so the category-scoped
        // sweep below could miss it if the surgical payload doesn't pass a
        // category_id — but the orderedIds snapshot still picks it up. Without
        // this refetch, clicking the renamed file's card hits
        // findMediaIndexByUrl → -1 → viewer opens index 0 (wrong media).
        const entriesByOrderedIds = surgical
            ? this._entriesContainingIds(invalidatedIds)
            : [];

        if (surgical) {
            this._manifest.invalidateIds(invalidatedIds);
            // Drop the dead ids from every view's orderedIds too. This flips
            // each affected view's orderedIds reference *now* so subscribers
            // (CategoryRowComponent, gallery DateGroup, etc.) treat it as a
            // structural change and rebuild their virtual scrollers — instead
            // of just calling vs.reset() which leaves stale chunk DOM around
            // (wrong card positions, wrong click targets) until the refetch
            // lands. The refetch then triggers another rebuild with the new
            // ids in place.
            this._ordering.dropIdsFromAllViews(invalidatedIds);
        }

        if (categoryIds.length > 0) {
            categoryIds.forEach((categoryId) => this.invalidateForCategory(categoryId, {
                wipeManifest: !surgical,
            }));
        }

        if (entriesByOrderedIds.length > 0) {
            // Mark stale + refetch any cross-category views (gallery timeline,
            // search results, what's new, etc.) that the per-category sweep
            // didn't already cover. invalidateView is idempotent so the
            // overlap with the category sweep is safe.
            for (const { viewKey } of entriesByOrderedIds) {
                this._ordering.invalidateView(viewKey);
            }
            this._refetchEntries(entriesByOrderedIds);
        }
    }

    _emitFileRenamedUpdated(oldPath, newPath) {
        if (!oldPath || !newPath) return;
        const eventKey = `${oldPath}::${newPath}`;
        if (eventKey === this._lastRenameEventKey) return;
        this._lastRenameEventKey = eventKey;
        this.timeout(() => {
            if (this._lastRenameEventKey === eventKey) this._lastRenameEventKey = null;
        }, 1000);
        try {
            renameVideoProgress(oldPath, newPath);
        } catch (error) {
            console.warn('[MediaInvalidation] Failed to update renamed progress:', error);
        }
        bus.emit(APP_EVENTS.FILE_RENAMED_UPDATED, { oldPath, newPath });
    }

    _entriesContainingIds(ids) {
        const idSet = new Set((ids || []).filter(Boolean));
        if (idSet.size === 0) return [];
        return this._entriesForAll().filter(({ entry }) => {
            const orderedIds = entry?.orderedIds || [];
            for (const id of orderedIds) {
                if (idSet.has(id)) return true;
            }
            return false;
        });
    }

    _categoryIdsFromPayload(payload = {}) {
        const raw = []
            .concat(payload.category_ids || [])
            .concat(payload.categoryIds || [])
            .concat(payload.categories || [])
            .concat(payload.category_id || [])
            .concat(payload.categoryId || []);
        const fromPaths = [
            categoryIdFromMediaUrl(payload.old_path || payload.old_media_url),
            categoryIdFromMediaUrl(payload.new_path || payload.new_media_url),
            categoryIdFromMediaUrl(payload.media_url),
        ].filter(Boolean);
        return Array.from(new Set([...raw, ...fromPaths]
            .map((value) => String(value || '').trim())
            .filter(Boolean)));
    }

    _entriesForCategory(categoryId) {
        return this._entriesForAll().filter(({ viewKey, entry }) => {
            return viewKey.includes(`::${categoryId}`) ||
                this._paramsIncludeCategory(entry?.params, categoryId) ||
                this._isGlobalCategoryView(entry);
        });
    }

    _isGlobalCategoryView(entry) {
        if (!entry?.viewType) return false;
        const params = entry.params || {};
        if (params.category_id || params.categoryId || params.category_ids || params.categoryIds) return false;
        return ['gallery_timeline', 'gallery_month', 'whats_new'].includes(entry.viewType);
    }

    _paramsIncludeCategory(params = {}, categoryId) {
        if (!categoryId) return false;
        const target = String(categoryId);
        const single = params.category_id || params.categoryId;
        if (String(single || '') === target) return true;
        const multi = []
            .concat(params.category_ids || [])
            .concat(params.categoryIds || []);
        return multi.some((value) => {
            if (Array.isArray(value)) return value.map(String).includes(target);
            return String(value || '')
                .split(',')
                .map((part) => part.trim())
                .includes(target);
        });
    }

    _entriesForAll() {
        return Array.from(this._ordering.orders?.entries?.() || [])
            .map(([viewKey, entry]) => ({ viewKey, entry }))
            .filter(({ entry }) => entry?.viewType && entry?.params);
    }

    _refetchEntries(entries) {
        for (const { viewKey, entry } of entries || []) {
            this._ordering.requestOrder(viewKey, entry.viewType, entry.params, {
                bypassClientCache: true,
            }).then((order) => {
                const orderedIds = order?.orderedIds || [];
                this._manifest.pin(viewKey, orderedIds);
                return this._manifest.hydrate(orderedIds);
            }).catch((error) => {
                console.error('[MediaInvalidation] Refetch failed:', error);
            });
        }
    }
}
