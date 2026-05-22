/**
 * /search and /find commands
 * Search for media files across all categories by filename.
 * Displays clickable results as chat messages (local only).
 */

import { ensureFeatureAccess } from '../utils/authManager.js';
import { createElement, append, attr, remove } from '../libs/ragot.esm.min.js';
import * as Icons from '../utils/icons.js';
import { getLeafName } from '../modules/ui/categoryFilterPill.js';
import { hydrateSearchResults } from '../modules/media/searchDataSource.js';

const SEARCH_API_FILE_LIMIT = 2500;
const SEARCH_API_FOLDER_LIMIT = 5000;
const SEARCH_API_PARENT_LIMIT = 1200;

// Render in chunks to avoid UI jank on large result sets.
const SEARCH_SECTION_CHUNK = 80;
const SEARCH_FILE_GROUP_CHUNK = 8;
const SEARCH_FILE_MATCH_CHUNK = 40;

export const search = {
    description: '• Search for media files by filename across all categories.',
    keepChatOpen: true,
    getHelpText: () => '• /search <query> - Search for media files by filename (min 2 chars).',
    execute: async (socket, displayLocalMessage, args) => {
        const accessGranted = await ensureFeatureAccess();
        if (!accessGranted) {
            displayLocalMessage('Password required.', { icon: 'stop' });
            return;
        }

        const query = args ? args.trim() : '';

        if (!query || query.length < 2) {
            displayLocalMessage('Usage: /search <query> (minimum 2 characters)');
            return;
        }

        displayLocalMessage(`Searching for "${query}"...`);

        try {
            const response = await fetch(
                `/api/search?q=${encodeURIComponent(query)}&limit=${SEARCH_API_FILE_LIMIT}&folders_limit=${SEARCH_API_FOLDER_LIMIT}&parent_limit=${SEARCH_API_PARENT_LIMIT}`
            );

            if (!response.ok) {
                const error = await response.json();
                displayLocalMessage(`Search failed: ${error.error || 'Unknown error'}`);
                return;
            }

            const rawData = await response.json();
            const data = await hydrateSearchResults(rawData, query, SEARCH_API_FILE_LIMIT);
            const meta = data.viewMeta || {};
            const fileGroups = data.fileGroups || [];

            const hasFiles = fileGroups.length > 0;
            const hasCategories = meta.matched_categories && meta.matched_categories.length > 0;
            const hasParentFolders = meta.matched_parent_folders && meta.matched_parent_folders.length > 0;
            const hasFolders = meta.matched_folders && meta.matched_folders.length > 0;

            if (!hasFiles && !hasCategories && !hasParentFolders && !hasFolders) {
                displayLocalMessage(`No results found for "${query}".`, { icon: 'search' });
                return;
            }

            const totalInAllCategories = fileGroups.reduce((sum, cat) => sum + cat.total_matches, 0);
            const totalLocations = (meta.matched_categories ? meta.matched_categories.length : 0)
                + (meta.matched_parent_folders ? meta.matched_parent_folders.length : 0)
                + (meta.matched_folders ? meta.matched_folders.length : 0);

            const resultsEl = displaySearchResults(data, query, totalInAllCategories, totalLocations);
            displayLocalMessage(resultsEl, { isHtml: true, persist: false, icon: 'search' });

        } catch (error) {
            console.error('Search error:', error);
            displayLocalMessage(`Search error: ${error.message}`, { icon: 'x' });
        }
    }
};

/**
 * Display search results in chat as a grouped accordion.
 * Each section (Categories, Folders, Files) collapses/expands independently.
 * Files is always open; others start collapsed when multiple groups exist.
 */
function displaySearchResults(data, query, totalMatches, totalLocations) {
    const viewMeta = data.viewMeta || {};
    const fileGroups = data.fileGroups || [];
    const totalFiles = fileGroups.reduce((s, c) => s + c.total_matches, 0);

    const summaryMeta = [];
    if (totalLocations > 0) summaryMeta.push(`${totalLocations} location${totalLocations !== 1 ? 's' : ''}`);
    if (totalFiles > 0) summaryMeta.push(`${totalFiles} file${totalFiles !== 1 ? 's' : ''}`);
    if (viewMeta.truncated) summaryMeta.push('truncated');

    // Deduplication
    const seenCatNames = new Set();
    const seenCatIds = new Set();
    (viewMeta.matched_categories || []).forEach(cat => {
        if (cat.name) seenCatNames.add(cat.name.toLowerCase());
        seenCatIds.add(cat.id);
    });

    const matchedCategories = viewMeta.matched_categories || [];
    const dedupedParents = (viewMeta.matched_parent_folders || []).filter(
        pf => !seenCatNames.has(pf.name.toLowerCase())
    );
    const dedupedFolders = (viewMeta.matched_folders || []).filter(folder => {
        const name = (folder.name || folder.rel_path.split('/').pop()).toLowerCase();
        if (seenCatNames.has(name)) return false;
        if (seenCatIds.has(folder.category_id) && (!folder.rel_path || !folder.rel_path.includes('/'))) return false;
        return true;
    });

    const groupCount = [matchedCategories, dedupedParents, dedupedFolders, fileGroups]
        .filter(g => g && g.length > 0).length;
    const autoOpen = groupCount <= 1;

    const groups = [];

    if (matchedCategories.length > 0) {
        groups.push(createAccordionGroup(
            'Categories', matchedCategories.length,
            matchedCategories, cat => createCategoryResultLink(cat, query),
            SEARCH_SECTION_CHUNK, autoOpen
        ));
    }
    if (dedupedParents.length > 0) {
        groups.push(createAccordionGroup(
            'Parent Folders', dedupedParents.length,
            dedupedParents, pf => createParentFolderResultLink(pf, query),
            SEARCH_SECTION_CHUNK, autoOpen
        ));
    }
    if (dedupedFolders.length > 0) {
        groups.push(createAccordionGroup(
            'Subfolders', dedupedFolders.length,
            dedupedFolders, f => createSubfolderResultLink(f, query),
            SEARCH_SECTION_CHUNK, autoOpen
        ));
    }
    if (fileGroups.length > 0) {
        groups.push(createAccordionGroup(
            'Files', totalFiles,
            fileGroups, cg => createFileCategoryGroup(cg, query),
            SEARCH_FILE_GROUP_CHUNK, true
        ));
    }

    return createElement('div', { className: 'sr-wrapper' },
        createElement('div', {
            className: 'sr-header',
            textContent: summaryMeta.length ? summaryMeta.join(' · ') : 'No matches'
        }),
        createElement('div', { className: 'sr-body' }, ...groups)
    );
}

/**
 * Create a collapsible accordion group.
 * onClick wired via createElement so it goes through RAGOT _ragotHandlers.
 * classList.toggle('open') is intentional — 'open' is not the 'hidden' class
 * that RAGOT toggle() manages, so direct classList use is correct here.
 */
function createAccordionGroup(label, count, items, renderItem, chunkSize, startOpen) {
    const content = createElement('div', {
        className: `sr-group-content${startOpen ? ' open' : ''}`
    });

    let rendered = false;
    const renderContent = () => {
        if (rendered) return;
        rendered = true;
        appendChunkedItems(content, items, renderItem, chunkSize, 'Show more');
    };

    if (startOpen) renderContent();

    const header = createElement('button', {
        type: 'button',
        className: `sr-group-header${startOpen ? ' open' : ''}`,
        'aria-expanded': startOpen ? 'true' : 'false',
        onClick: () => {
            const isOpen = header.classList.toggle('open');
            content.classList.toggle('open', isOpen);
            attr(header, { 'aria-expanded': isOpen ? 'true' : 'false' });
            if (isOpen) renderContent();
        }
    },
        createElement('span', { className: 'sr-group-chevron' }),
        createElement('span', { className: 'sr-group-label', textContent: label }),
        createElement('span', { className: 'sr-group-badge', textContent: String(count) })
    );

    return createElement('div', { className: 'sr-group' }, header, content);
}

function createLoadMoreButton(label, onClick) {
    return createElement('button', {
        type: 'button',
        className: 'sr-load-more',
        textContent: label,
        onClick
    });
}

/**
 * Append items to a container in lazy chunks.
 * Uses RAGOT append() instead of raw appendChild/DocumentFragment.
 */
function appendChunkedItems(container, items, renderItem, chunkSize, moreLabel) {
    if (!Array.isArray(items) || items.length === 0) return;

    let index = 0;

    const appendNextChunk = () => {
        const end = Math.min(index + chunkSize, items.length);
        const nodes = [];
        for (; index < end; index++) {
            const node = renderItem(items[index], index);
            if (node) nodes.push(node);
        }
        append(container, ...nodes);

        if (index < items.length) {
            const remaining = items.length - index;
            const btn = createLoadMoreButton(`${moreLabel} (${remaining} more)`, () => {
                remove(btn);
                appendNextChunk();
            });
            append(container, btn);
        }
    };

    appendNextChunk();
}

// ── Result link builders ──────────────────────────────────────────────────────
// All use createElement with children — no raw appendChild calls.

function createCategoryResultLink(cat, query) {
    return createElement('a', {
        href: '#',
        className: 'search-result-link category-link',
        onClick: async (e) => {
            e.preventDefault();
            await navigateToCategory(cat.id, cat.name);
        }
    },
        createElement('span', { className: 'gh-search__item-icon', innerHTML: Icons.folderIcon(14) }),
        createElement('span', { className: 'gh-search__result-label', innerHTML: highlightQuery(escapeHtml(cat.name), query) })
    );
}

function createParentFolderResultLink(pf, query) {
    let baseName = getLeafName(pf.name);

    return createElement('a', {
        href: '#',
        className: 'search-result-link parent-link',
        onClick: async (e) => {
            e.preventDefault();
            await navigateToParentFolder(baseName, pf.category_ids);
        }
    },
        createElement('span', { className: 'gh-search__item-icon', innerHTML: Icons.folderIcon(14) }),
        createElement('span', {
            className: 'gh-search__result-label',
            innerHTML: `${highlightQuery(escapeHtml(pf.name), query)}<span class="sr-subfolder-count">${pf.category_count} subfolders</span>`
        })
    );
}

function createSubfolderResultLink(folder, query) {
    const folderDisplayName = folder.name || folder.rel_path.split('/').pop();

    return createElement('a', {
        href: '#',
        className: 'search-result-link folder-link',
        onClick: async (e) => {
            e.preventDefault();
            await navigateToSubfolder(folder.category_id, folder.rel_path, folder.category_name);
        }
    },
        createElement('span', { className: 'gh-search__item-icon', innerHTML: Icons.folderIcon(14) }),
        createElement('span', {
            className: 'gh-search__result-label',
            innerHTML: `${highlightQuery(escapeHtml(folderDisplayName), query)}<span class="sr-subfolder-count">in ${escapeHtml(folder.category_name)}</span>`
        })
    );
}

function createFileCategoryGroup(category, query) {
    const matches = Array.isArray(category.matches) ? category.matches : [];

    const group = createElement('div', { className: 'gh-search__category-group' },
        createElement('div', { className: 'gh-search__category-name' },
            createElement('span', { innerHTML: Icons.folderIcon(12) }),
            createElement('span', { textContent: category.category_name })
        )
    );

    appendChunkedItems(
        group,
        matches,
        match => createFileResultLink(category.category_id, match, query),
        SEARCH_FILE_MATCH_CHUNK,
        'Show more files'
    );

    if (category.total_matches > matches.length) {
        append(group, createElement('div', {
            className: 'gh-search__more-hint',
            textContent: `...and ${category.total_matches - matches.length} more`
        }));
    }

    return group;
}

function createFileResultLink(categoryId, match, query) {
    const name = match.name || (match.url ? match.url.split('/').pop() : 'Unknown');
    const isVideo = match.type === 'video';

    return createElement('a', {
        href: '#',
        className: 'search-result-link file-link',
        onClick: async (e) => {
            e.preventDefault();
            await navigateToResult(categoryId, match.url);
        }
    },
        createElement('span', {
            className: 'gh-search__item-icon',
            innerHTML: isVideo ? Icons.videoIcon(14) : Icons.imageIcon(14)
        }),
        createElement('span', { className: 'gh-search__result-label', innerHTML: highlightQuery(escapeHtml(name), query) })
    );
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function highlightQuery(filename, query) {
    const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
    return filename.replace(regex, '<span class="gh-search-highlight">$1</span>');
}

function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Navigation helpers ────────────────────────────────────────────────────────

async function navigateToResult(categoryId, mediaUrl) {
    if (!window.ragotModules?.mediaLoader) {
        console.error('[Search] mediaLoader not available');
        return;
    }
    await window.ragotModules.mediaLoader.openSingleMediaViewer({ categoryId, mediaUrl });
}

async function navigateToCategory(categoryId, categoryName = null) {
    const currentLayout = document.documentElement.getAttribute('data-layout');
    const layoutModule = currentLayout === 'streaming'
        ? window.ragotModules.streamingLayout
        : currentLayout === 'gallery'
            ? window.ragotModules.galleryLayout
            : null;

    if (layoutModule && typeof layoutModule.setCategoryFilter === 'function') {
        if (typeof layoutModule.setSubfolderFilter === 'function') {
            layoutModule.setSubfolderFilter(null);
        }
        layoutModule.setCategoryFilter(categoryId, categoryName);
    } else {
        console.warn(`[ChatCommand] Layout ${currentLayout} does not support category filtering`);
    }
}

async function navigateToParentFolder(parentName, categoryIds = null) {
    const currentLayout = document.documentElement.getAttribute('data-layout');
    const layoutModule = currentLayout === 'streaming'
        ? window.ragotModules.streamingLayout
        : currentLayout === 'gallery'
            ? window.ragotModules.galleryLayout
            : null;

    if (layoutModule && typeof layoutModule.setParentFilter === 'function') {
        layoutModule.setParentFilter(parentName, categoryIds);
    } else {
        console.warn(`[ChatCommand] Layout ${currentLayout} does not support parent folder filtering`);
    }
}

async function navigateToSubfolder(categoryId, subfolder, categoryName = null) {
    const currentLayout = document.documentElement.getAttribute('data-layout');
    const layoutModule = currentLayout === 'streaming'
        ? window.ragotModules.streamingLayout
        : currentLayout === 'gallery'
            ? window.ragotModules.galleryLayout
            : null;

    if (layoutModule && typeof layoutModule.setSubfolderFilterAction === 'function') {
        layoutModule.setSubfolderFilterAction(categoryId, subfolder, categoryName);
    } else if (layoutModule && typeof layoutModule.setCategoryFilter === 'function') {
        console.warn(`[ChatCommand] Layout ${currentLayout} does not support subfolder filtering, falling back to category`);
        layoutModule.setCategoryFilter(categoryId, categoryName);
    }
}

// Also export as 'find' alias
export const find = {
    ...search,
    description: '• Alias for /search - Search for media files by filename.',
    getHelpText: () => '• /find <query> - Alias for /search.'
};
