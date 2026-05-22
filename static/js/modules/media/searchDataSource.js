/**
 * Normalize search MediaView payloads and derive display groups through selectors.
 */

import { selectRecordsForView } from './selectors.js';

function categoryNameFor(record, viewMeta) {
    const group = (viewMeta.result_groups || [])
        .find((item) => item.category_id === record.categoryId);
    return group?.category_name || record.categoryId;
}

function recordToSearchMatch(record) {
    return {
        id: record.id,
        filename: record.relPath || record.name,
        name: record.name || record.relPath,
        type: record.type,
        url: record.url,
        thumbnailUrl: record.thumbnailUrl,
    };
}

function buildFileGroups(viewKey, viewMeta) {
    const records = selectRecordsForView(viewKey);
    const recordsById = new Map(records.map((record) => [record.id, record]));
    const groups = [];

    for (const group of viewMeta.result_groups || []) {
        const matches = (group.matches || [])
            .map((id) => recordsById.get(id))
            .filter(Boolean)
            .map(recordToSearchMatch);
        if (matches.length === 0) continue;
        groups.push({
            category_id: group.category_id,
            category_name: group.category_name,
            matches,
            total_matches: group.total_matches || matches.length,
        });
    }

    if (groups.length > 0) return groups;

    const fallbackGroups = new Map();
    for (const record of records) {
        const categoryId = record.categoryId;
        if (!fallbackGroups.has(categoryId)) {
            fallbackGroups.set(categoryId, {
                category_id: categoryId,
                category_name: categoryNameFor(record, viewMeta),
                matches: [],
                total_matches: 0,
            });
        }
        const group = fallbackGroups.get(categoryId);
        group.matches.push(recordToSearchMatch(record));
        group.total_matches += 1;
    }
    return Array.from(fallbackGroups.values());
}

export async function hydrateSearchResults(data, query, limit) {
    const manifest = window.ragotModules?.mediaManifest;
    const ordering = window.ragotModules?.mediaOrdering;
    if (!manifest || !ordering || !data?.viewKey || data.viewType !== 'search') {
        return data;
    }

    const viewKey = data.viewKey || `search::query=${query || ''}::limit=${limit || ''}`;
    const orderedIds = data.orderedIds || [];
    if (data.records || data.missing) {
        manifest.ingest?.(data.records || {}, data.missing || []);
    }
    ordering.ingestView?.(viewKey, {
        ...data,
        viewKey,
        viewType: 'search',
        status: data.status || 'ready',
    });
    manifest.pin(viewKey, orderedIds);
    await manifest.hydrate(orderedIds);

    const viewMeta = data.viewMeta || {};
    return {
        ...data,
        viewKey,
        viewType: 'search',
        viewMeta,
        fileGroups: buildFileGroups(viewKey, viewMeta),
    };
}
