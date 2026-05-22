/**
 * Search Bar Module
 * Header dropdown design - toggles on button click.
 * Results panel implemented as a RAGOT Component for keyed list rendering
 * and scoped event cleanup.
 */

import { ensureFeatureAccess } from '../../utils/authManager.js';
import { videoIcon, imageIcon, fileIcon, folderIcon } from '../../utils/icons.js';
import { Component, createElement, renderList, clear, append, show, hide, $ } from '../../libs/ragot.esm.min.js';
import { getLeafName } from './categoryFilterPill.js';
import { scheduleAutofocus } from '../../utils/focusManager.js';
import { hydrateSearchResults } from '../media/searchDataSource.js';

// ==========================================
// Utility functions
// ==========================================

function escapeHtml(text) {
    // Intentional raw createElement — security-critical DOM sanitiser
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightQuery(filename, query) {
    const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
    return filename.replace(regex, '<span class="gh-search-highlight">$1</span>');
}

function getLayoutModule() {
    const layout = document.documentElement.getAttribute('data-layout');
    return layout === 'streaming'
        ? window.ragotModules?.streamingLayout
        : layout === 'gallery'
            ? window.ragotModules?.galleryLayout
            : null;
}

// ==========================================
// SearchResultsComponent
// Owns only the results container (#search-results-dropdown)
// ==========================================

class SearchResultsComponent extends Component {
    constructor(container, onNavigate) {
        super({
            status: 'idle',   // 'idle' | 'loading' | 'results' | 'message'
            data: null,
            query: '',
            message: '',
            highlightedIndex: -1,
        });
        this.element = container; // We're adopting an existing DOM node, not creating one
        this._isMounted = true;
        this.onNavigate = onNavigate;
    }

    render() {
        const { status, data, query, message } = this.state;

        if (status === 'idle') {
            return createElement('div', {});
        }
        if (status === 'loading') {
            return createElement('div', { className: 'gh-search__loading' }, 'Searching...');
        }
        if (status === 'message') {
            return createElement('div', { className: 'gh-search__message' }, message);
        }

        // status === 'results'
        return this._renderResults(data, query);
    }

    _performUpdate() {
        // Override: directly patch this.element's contents rather than replacing the node
        this._renderQueued = false;
        if (this._pendingState) {
            this.state = { ...this.state, ...this._pendingState };
            this._pendingState = null;
        }
        const newContent = this.render();
        // Clear and replace contents
        clear(this.element);
        if (newContent) append(this.element, newContent);
    }

    showLoading() {
        this.setState({ status: 'loading', highlightedIndex: -1 });
    }

    showMessage(msg) {
        this.setState({ status: 'message', message: msg, highlightedIndex: -1 });
    }

    showResults(data, query, highlightedIndex = -1) {
        this.setState({ status: 'results', data, query, highlightedIndex });
    }

    setHighlightedIndex(index) {
        this.setState({ highlightedIndex: index });
    }

    clear() {
        this.setState({ status: 'idle', data: null, query: '', message: '', highlightedIndex: -1 });
    }

    _renderResults(data, query) {
        this._optionIndex = -1;
        const viewMeta = data.viewMeta || {};
        const fileGroups = data.fileGroups || [];
        const totalMatches = fileGroups.reduce((sum, cat) => sum + cat.total_matches, 0);

        // Build unified locations list (de-duped)
        const locations = this._buildLocations(data);
        const totalLocations = locations.length;

        const container = createElement('div', {
            role: 'listbox',
            'aria-label': 'Search results'
        });

        // Summary
        append(container, createElement('div', {
            className: 'gh-search__summary',
        }, viewMeta.truncated
            ? `Found ${totalLocations} matching locations and ${totalMatches} matching files (showing top results)`
            : `Found ${totalLocations} matching locations and ${totalMatches} matching files`
        ));

        // Locations section
        if (locations.length > 0) {
            append(container, createElement('div', { className: 'gh-search__section-header' }, 'Locations'));
            const locList = createElement('div', {});
            renderList(
                locList,
                locations,
                (loc) => loc.type + ':' + (loc.id || loc.name),
                (loc) => this._renderLocationItem(loc, query)
            );
            append(container, locList);
        }

        // Files section
        if (fileGroups.length > 0) {
            append(container, createElement('div', { className: 'gh-search__section-header' }, 'Files'));
            fileGroups.forEach(category => {
                append(container, this._renderCategoryGroup(category, query));
            });
        }

        return container;
    }

    _buildLocations(data) {
        const viewMeta = data.viewMeta || {};
        const locations = [];
        const seenDisplayNames = new Set();
        const seenCategoryIds = new Set();

        if (viewMeta.matched_categories) {
            viewMeta.matched_categories.forEach(cat => {
                const key = cat.name.toLowerCase();
                if (!seenDisplayNames.has(key)) {
                    locations.push({ type: 'category', id: cat.id, name: cat.name });
                    seenDisplayNames.add(key);
                    seenCategoryIds.add(cat.id);
                }
            });
        }

        if (viewMeta.matched_parent_folders) {
            viewMeta.matched_parent_folders.forEach(pf => {
                const key = pf.name.toLowerCase();
                if (!seenDisplayNames.has(key)) {
                    const baseName = getLeafName(pf.name);
                    locations.push({
                        type: 'parent',
                        name: pf.name,
                        displayName: pf.name,
                        baseName,
                        categoryCount: pf.category_count,
                        categoryIds: pf.category_ids,
                    });
                    seenDisplayNames.add(key);
                }
            });
        }

        if (viewMeta.matched_folders) {
            viewMeta.matched_folders.forEach(folder => {
                const folderName = folder.name || folder.rel_path.split('/').pop();
                const folderKey = folderName.toLowerCase();
                const contextKey = `${folderKey} (${(folder.category_name || '').toLowerCase()})`;

                if (seenDisplayNames.has(folderKey)) return;
                if (seenDisplayNames.has(contextKey)) return;
                if (seenCategoryIds.has(folder.category_id) && !folder.rel_path?.includes('/')) return;

                locations.push({
                    type: 'folder',
                    id: folder.id,
                    name: folderName,
                    relPath: folder.rel_path,
                    categoryId: folder.category_id,
                    categoryName: folder.category_name,
                });
                seenDisplayNames.add(contextKey);
            });
        }

        return locations;
    }

    _renderLocationItem(loc, query) {
        const optionIndex = ++this._optionIndex;
        const isHighlighted = optionIndex === this.state.highlightedIndex;
        const children = [
            createElement('span', {
                className: 'gh-search__item-icon',
                innerHTML: folderIcon(16)
            }),
            createElement('span', {
                className: 'gh-search__result-label',
                innerHTML: highlightQuery(escapeHtml(loc.name), query)
            })
        ];

        if (loc.type === 'parent') {
            children.push(createElement('span', {
                className: 'gh-search__parent-badge',
                textContent: `${loc.categoryCount} subfolders`
            }));
        } else if (loc.type === 'folder') {
            children.push(createElement('span', {
                className: 'gh-search__parent-badge',
                textContent: `in ${loc.categoryName}`
            }));
        }

        return createElement('a', {
            href: '#',
            className: 'gh-search__result location-result',
            id: `search-result-option-${optionIndex}`,
            role: 'option',
            tabindex: '-1',
            'aria-selected': isHighlighted ? 'true' : 'false',
            dataset: { optionIndex: String(optionIndex) },
            onClick: async (e) => {
                e.preventDefault();
                if (loc.type === 'parent') {
                    await navigateToParentFolder(loc.baseName || loc.name, loc.categoryIds);
                } else if (loc.type === 'category') {
                    await navigateToCategory(loc.id, loc.name);
                } else {
                    await navigateToSubfolder(loc.categoryId, loc.relPath, loc.categoryName);
                }
                if (this.onNavigate) this.onNavigate();
            }
        }, ...children);
    }

    _renderCategoryGroup(category, query) {
        const group = createElement('div', { className: 'gh-search__category-group' },
            createElement('div', {
                className: 'gh-search__category-name',
                innerHTML: `${folderIcon(14)} ${escapeHtml(category.category_name)}`
            })
        );

        category.matches.forEach(match => {
            const optionIndex = ++this._optionIndex;
            const isHighlighted = optionIndex === this.state.highlightedIndex;
            const typeIcon = match.type === 'video' ? videoIcon(14) :
                match.type === 'image' ? imageIcon(14) : fileIcon(14);
            const baseName = match.filename.split(/[/\\]/).pop();

            append(group, createElement('a', {
                href: '#',
                className: 'gh-search__result',
                id: `search-result-option-${optionIndex}`,
                role: 'option',
                tabindex: '-1',
                'aria-selected': isHighlighted ? 'true' : 'false',
                dataset: { optionIndex: String(optionIndex) },
                onClick: async (e) => {
                    e.preventDefault();
                    await navigateToResult(category.category_id, match.url);
                    if (this.onNavigate) this.onNavigate();
                }
            },
            createElement('span', {
                className: 'gh-search__item-icon',
                innerHTML: typeIcon
            }),
            createElement('span', {
                className: 'gh-search__result-label',
                innerHTML: highlightQuery(escapeHtml(baseName), query)
            })));
        });

        if (category.total_matches > category.matches.length) {
            append(group, createElement('div', {
                className: 'gh-search__more-hint',
            }, `...and ${category.total_matches - category.matches.length} more`));
        }

        return group;
    }
}

// ==========================================
// Navigation helpers
// ==========================================

async function navigateToResult(categoryId, mediaUrl) {
    if (!window.ragotModules?.mediaLoader) {
        console.error('[SearchBar] mediaLoader not available');
        return;
    }
    await window.ragotModules.mediaLoader.openSingleMediaViewer({ categoryId, mediaUrl });
}

async function navigateToCategory(categoryId, categoryName = null) {
    const lm = getLayoutModule();
    if (lm?.setCategoryFilter) {
        lm.setSubfolderFilter?.(null);
        lm.setCategoryFilter(categoryId, categoryName);
    } else {
        console.warn('[SearchBar] Layout does not support category filtering');
    }
}

async function navigateToParentFolder(parentName, categoryIds = null) {
    const lm = getLayoutModule();
    if (lm?.setParentFilter) {
        lm.setParentFilter(parentName, categoryIds);
    } else {
        console.warn('[SearchBar] Layout does not support parent folder filtering');
    }
}

async function navigateToSubfolder(categoryId, subfolder, categoryName = null) {
    const lm = getLayoutModule();
    if (lm?.setSubfolderFilterAction) {
        lm.setSubfolderFilterAction(categoryId, subfolder, categoryName);
    } else if (lm?.setCategoryFilter) {
        lm.setCategoryFilter(categoryId, categoryName);
    }
}

// ==========================================
// Module init
// ==========================================

class SearchBarComponent extends Component {
    constructor(searchDropdown, searchInput, searchToggleBtn, resultsContainer) {
        super({
            isOpen: false
        });
        this.element = searchDropdown; // adopt existing container
        this._isMounted = true;
        this.searchInput = searchInput;
        this.searchToggleBtn = searchToggleBtn;
        this.results = new SearchResultsComponent(resultsContainer, () => this.close());
        this.searchTimeout = null;
        this._returnFocusEl = null;
        this._closeTimer = null;
        this._pendingCloseHandler = null;
    }

    start() {
        if (this._started) return;
        this._started = true;
        this.onStart();
    }

    stop() {
        if (!this._started) return;
        this._started = false;
        this.onStop();
        for (const l of this._listeners) {
            try {
                if (l._busUnsub) l._busUnsub();
                else if (l.target) l.target.removeEventListener(l.type, l.handler, l.options);
            } catch (e) {
                console.warn(`[SearchBar] Failed to cleanup listener for "${l.type}":`, e);
            }
        }
        this._listeners = [];
    }

    onStart() {
        this.on(this.searchToggleBtn, 'click', (e) => {
            e.stopPropagation();
            this.state.isOpen ? this.close() : this.open();
        });

        this.on(this.searchInput, 'input', (e) => {
            const query = e.target.value.trim();
            if (this.searchTimeout) {
                clearTimeout(this.searchTimeout);
                this.searchTimeout = null;
            }
            if (query.length < 2) {
                this.results.clear();
                return;
            }
            this.searchTimeout = setTimeout(() => this.performSearch(query), 300);
        });

        this.on(this.searchInput, 'keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                this._moveHighlight(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this._moveHighlight(-1);
            } else if (e.key === 'Enter') {
                const activeResult = this._getHighlightedResult();
                if (activeResult) {
                    e.preventDefault();
                    activeResult.click();
                    return;
                }

                const query = this.searchInput.value.trim();
                if (query.length >= 2) {
                    if (this.searchTimeout) {
                        clearTimeout(this.searchTimeout);
                        this.searchTimeout = null;
                    }
                    this.performSearch(query);
                }
            }
        });

        this.on(document, 'click', (e) => {
            if (this.state.isOpen && !this.element.contains(e.target) && !this.searchToggleBtn.contains(e.target)) {
                this.close({ restoreFocus: false });
            }
        });
    }

    onStop() {
        if (this.searchTimeout) {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = null;
        }
        this._cancelPendingClose();
    }

    _cancelPendingClose() {
        if (this._closeTimer) {
            clearTimeout(this._closeTimer);
            this._closeTimer = null;
        }
        if (this._pendingCloseHandler) {
            this.off(this.element, 'transitionend', this._pendingCloseHandler);
            this._pendingCloseHandler = null;
        }
    }

    open() {
        this._cancelPendingClose();
        this._returnFocusEl = document.activeElement;
        show(this.element);
        // Fade in: start transparent, transition to opaque
        this.element.style.opacity = '0';
        requestAnimationFrame(() => {
            this.element.style.transition = `opacity var(--transition-fast) ease`;
            this.element.style.opacity = '1';
        });
        this.state = { ...this.state, isOpen: true };
        this.searchInput.focus({ preventScroll: true });
        scheduleAutofocus(this.searchInput, { frames: 1 });
        this.searchInput.setAttribute('aria-expanded', 'true');
        this.searchToggleBtn.setAttribute('aria-expanded', 'true');
    }

    close({ restoreFocus = true } = {}) {
        this.state = { ...this.state, isOpen: false };

        const finalizeClose = () => {
            if (this.state.isOpen) {
                return;
            }
            this._cancelPendingClose();
            hide(this.element);
            this.element.style.opacity = '';
            this.element.style.transition = '';
        };

        this._cancelPendingClose();

        // Fade out before hiding
        this.element.style.transition = `opacity var(--transition-fast) ease`;
        this.element.style.opacity = '0';

        const computedStyle = typeof window.getComputedStyle === 'function'
            ? window.getComputedStyle(this.element)
            : null;
        const transitionDuration = computedStyle?.transitionDuration || '';
        const hasTransition = /\d/.test(transitionDuration) && !/^0s?(,\s*0s?)*$/.test(transitionDuration);

        if (hasTransition) {
            this._pendingCloseHandler = finalizeClose;
            this.on(this.element, 'transitionend', this._pendingCloseHandler, { once: true });
            this._closeTimer = setTimeout(finalizeClose, 250);
        } else {
            finalizeClose();
        }

        this.searchInput.value = '';
        this.results.clear();
        this.searchInput.setAttribute('aria-activedescendant', '');
        this.searchInput.setAttribute('aria-expanded', 'false');
        this.searchToggleBtn.setAttribute('aria-expanded', 'false');
        if (restoreFocus) {
            (this._returnFocusEl || this.searchToggleBtn)?.focus?.();
        }
    }

    async performSearch(query) {
        const accessGranted = await ensureFeatureAccess();
        if (!accessGranted) {
            this.results.showMessage('Password validation required. Please try again.');
            return;
        }

        this.results.showLoading();

        try {
            const response = await fetch(
                `/api/search?q=${encodeURIComponent(query)}&limit=1800&folders_limit=5000&parent_limit=1200`
            );

            if (!response.ok) {
                const error = await response.json();
                this.results.showMessage(`Search failed: ${error.error || 'Unknown error'}`);
                return;
            }

            const rawData = await response.json();
            const data = await hydrateSearchResults(rawData, query, 1800);
            const viewMeta = data.viewMeta || {};
            const hasAny = (data.fileGroups?.length || 0) + (viewMeta.matched_categories?.length || 0) +
                (viewMeta.matched_parent_folders?.length || 0) + (viewMeta.matched_folders?.length || 0) > 0;

            if (!hasAny) {
                this.results.showMessage(`No results found for "${query}"`);
                this.searchInput.setAttribute('aria-activedescendant', '');
                return;
            }

            this.results.showResults(data, query, 0);
            requestAnimationFrame(() => this._syncHighlightedResult());
        } catch (error) {
            console.error('Search error:', error);
            this.results.showMessage(`Search error: ${error.message}`);
        }
    }

    _getResultOptions() {
        return Array.from(this.results.element.querySelectorAll('[role="option"]'));
    }

    _getHighlightedResult() {
        return this.results.element.querySelector('[role="option"][aria-selected="true"]');
    }

    _moveHighlight(direction) {
        const options = this._getResultOptions();
        if (!options.length) return;

        const currentIndex = options.findIndex(option => option.getAttribute('aria-selected') === 'true');
        const nextIndex = currentIndex === -1
            ? 0
            : (currentIndex + direction + options.length) % options.length;

        this.results.setHighlightedIndex(nextIndex);
        requestAnimationFrame(() => this._syncHighlightedResult());
    }

    _syncHighlightedResult() {
        const options = this._getResultOptions();
        let activeId = '';
        options.forEach((option, index) => {
            const selected = option.getAttribute('aria-selected') === 'true';
            if (selected) {
                activeId = option.id;
                option.scrollIntoView({ block: 'nearest' });
                option.classList.add('highlighted');
            } else {
                option.classList.remove('highlighted');
            }
            option.setAttribute('aria-posinset', String(index + 1));
            option.setAttribute('aria-setsize', String(options.length));
        });
        this.searchInput.setAttribute('aria-activedescendant', activeId);
    }
}

let searchBarComponent = null;

function initSearchBar() {
    if (searchBarComponent) return;

    const searchDropdown = $('#search-dropdown');
    const searchInput = $('#global-search-input');
    const resultsContainer = $('#search-results-dropdown');
    const searchToggleBtn = $('#search-toggle-btn');

    if (!searchDropdown || !searchInput || !resultsContainer || !searchToggleBtn) {
        console.warn('[SearchBar] Elements not found in HTML');
        return;
    }

    searchInput.setAttribute('role', 'combobox');
    searchInput.setAttribute('aria-autocomplete', 'list');
    searchInput.setAttribute('aria-controls', 'search-results-dropdown');
    searchInput.setAttribute('aria-expanded', 'false');
    searchToggleBtn.setAttribute('aria-haspopup', 'listbox');
    searchToggleBtn.setAttribute('aria-expanded', 'false');

    searchBarComponent = new SearchBarComponent(
        searchDropdown,
        searchInput,
        searchToggleBtn,
        resultsContainer
    );
    searchBarComponent.start();

    console.log('[SearchBar] Initialized');
}

function destroySearchBar() {
    if (!searchBarComponent) return;
    searchBarComponent.stop();
    searchBarComponent = null;
}

export { initSearchBar, destroySearchBar };
