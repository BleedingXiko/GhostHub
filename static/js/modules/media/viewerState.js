/**
 * Selector-backed helpers for the active media viewer session.
 */

import { selectRecordAt, selectRecordsForView, selectView } from './selectors.js';
import { getAppState, setAppState } from '../../utils/appStateUtils.js';

export function getViewerSession(state = getAppState()) {
    const viewer = state?.viewer || null;
    if (!viewer?.viewKey || !Number.isInteger(viewer.activeIndex)) return null;
    return viewer;
}

export function setViewerSession(viewKey, activeIndex, extra = {}) {
    if (!viewKey || !Number.isInteger(activeIndex) || activeIndex < 0) {
        setAppState('viewer', null);
        return null;
    }
    const viewer = { viewKey, activeIndex, ...extra };
    setAppState('viewer', viewer);
    return viewer;
}

export function clearViewerSession() {
    setAppState('viewer', null);
}

export function getCurrentViewerRecord(state = getAppState()) {
    const viewer = getViewerSession(state);
    return viewer ? selectRecordAt(viewer.viewKey, viewer.activeIndex) : null;
}

export function getViewerRecordAt(index, state = getAppState()) {
    const viewer = getViewerSession(state);
    return viewer ? selectRecordAt(viewer.viewKey, index) : null;
}

export function getKnownViewerRecords(state = getAppState()) {
    const viewer = getViewerSession(state);
    return viewer ? selectRecordsForView(viewer.viewKey) : [];
}

export function getKnownViewerCount(state = getAppState()) {
    const viewer = getViewerSession(state);
    if (!viewer) return 0;
    return selectView(viewer.viewKey)?.orderedIds?.length || 0;
}
