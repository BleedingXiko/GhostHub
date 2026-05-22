/**
 * Tunnel Modal Module
 * Handles the tunnel management modal, its population, and related tunnel operations.
 */

import { saveConfig } from '../../utils/configManager.js';
import { mobileIcon } from '../../utils/icons.js';
import { Module, createElement, attr, clear, append, remove, $, $$ } from '../../libs/ragot.esm.min.js';
import { toast, dialog } from '../../utils/notificationManager.js';
import { SOCKET_EVENTS } from '../../core/socketEvents.js';

function getRuntimeConfig() {
    return window.ragotModules?.appStore?.get?.('config', {}) || {};
}

function getSocket() {
    return window.ragotModules?.appStore?.get?.('socket', null) || null;
}

/**
 * Detect if user is on a desktop/laptop or mobile device
 * @returns {Object} { isDesktop: boolean, isMobile: boolean, platform: string }
 */
function detectDevice() {
    const ua = navigator.userAgent.toLowerCase();

    // Check for iOS devices first (including iPad on iOS 13+ which reports as Mac)
    const isIOS = /iphone|ipod/.test(ua) ||
        (/ipad/.test(ua)) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const isAndroid = /android/.test(ua);
    const isTablet = /ipad/.test(ua) || (isAndroid && !/mobile/.test(ua));
    const isMobile = isIOS || isAndroid || /webos|blackberry|iemobile|opera mini/i.test(ua);
    const isDesktop = !isMobile && !isTablet;

    // Detect specific platforms
    let platform = 'unknown';
    if (isIOS) {
        platform = 'ios';
    } else if (isAndroid) {
        platform = 'android';
    } else if (/windows/i.test(ua)) {
        platform = 'windows';
    } else if (/mac/i.test(ua)) {
        platform = 'macos';
    } else if (/linux/i.test(ua)) {
        platform = 'linux';
    }

    return {
        isDesktop,
        isMobile: isMobile || isTablet,
        isTablet,
        platform,
        // Useful for showing CLI commands
        supportsTerminal: isDesktop || platform === 'linux'
    };
}

// DOM Elements for Tunnel Modal (lazily resolved after DOM is ready)
let tunnelModal = null;
let tunnelModalCloseBtn = null;
let tunnelModalStartBtn = null;
let tunnelModalStopBtn = null;
let tunnelModalSaveSettingsBtn = null;
let tunnelProviderSelect = null;
let pinggyTokenGroup = null;
let pinggyAccessTokenInput = null;
let tunnelLocalPortInput = null;
let tunnelAutoStartCheckbox = null;
let tunnelStatusDisplay = null;

// Mesh/Tailscale specific elements
let meshInfoContainer = null;
let hsJoinCommand = null;
let hsCopyJoinBtn = null;
let hsNodesList = null;

function ensureTunnelDomElementsInitialized() {
    tunnelModal = tunnelModal || $('#tunnel-modal');
    tunnelModalCloseBtn = tunnelModalCloseBtn || $('#tunnel-modal-close-btn');
    tunnelModalStartBtn = tunnelModalStartBtn || $('#tunnel-modal-start-btn');
    tunnelModalStopBtn = tunnelModalStopBtn || $('#tunnel-modal-stop-btn');
    tunnelModalSaveSettingsBtn = tunnelModalSaveSettingsBtn || $('#tunnel-modal-save-settings-btn');
    tunnelProviderSelect = tunnelProviderSelect || $('#tunnel-provider-select');
    pinggyTokenGroup = pinggyTokenGroup || $('#pinggy-token-group');
    pinggyAccessTokenInput = pinggyAccessTokenInput || $('#pinggy-access-token-input');
    tunnelLocalPortInput = tunnelLocalPortInput || $('#tunnel-local-port-input');
    tunnelAutoStartCheckbox = tunnelAutoStartCheckbox || $('#tunnel-auto-start');
    tunnelStatusDisplay = tunnelStatusDisplay || $('#tunnel-status-display');
    meshInfoContainer = meshInfoContainer || $('#mesh-info-container');
    hsJoinCommand = hsJoinCommand || $('#hs-join-command');
    hsCopyJoinBtn = hsCopyJoinBtn || $('#hs-copy-join-btn');
    hsNodesList = hsNodesList || $('#hs-nodes-list');
}

// Cache last known tunnel status to avoid unnecessary DOM updates
let _lastTunnelStatusKey = null;
let _currentTunnelPollMs = null;
let _activeTunnelPollMs = null;
let _tunnelStatusRequestId = 0;
let _tunnelStatusAbortController = null;
let _tunnelStatusRetryTimeoutId = null;

// Startup stage labels for real-time progress
const STARTUP_STAGES = {
    config: { label: 'Generating configuration...', step: 1 },
    headscale: { label: 'Starting Headscale server...', step: 2 },
    joining: { label: 'Joining Pi to mesh network...', step: 3 },
    dns: { label: 'Configuring mesh DNS...', step: 4 },
    keys: { label: 'Generating authentication keys...', step: 5 },
};
const STARTUP_TOTAL_STEPS = 5;

/**
 * Show real-time startup stage progress in the status display.
 */
function _showStartupStage(stage, message) {
    ensureTunnelDomElementsInitialized();
    if (!tunnelStatusDisplay) return;

    const info = STARTUP_STAGES[stage] || { label: message || 'Starting...', step: 0 };
    const progress = info.step > 0 ? ` (${info.step}/${STARTUP_TOTAL_STEPS})` : '';
    // Use the pushed message when it provides more detail than the generic label
    const displayLabel = (message && message !== info.label) ? message : info.label;

    clear(tunnelStatusDisplay);
    append(tunnelStatusDisplay,
        createElement('span', { className: 'tunnel-startup-progress', children: [
            createElement('span', { className: 'tunnel-spinner' }),
            createElement('span', { textContent: ` ${displayLabel}${progress}` }),
        ]})
    );
    tunnelStatusDisplay.className = 'tunnel-status status-starting';
}

/**
 * Show a startup error in the status display.
 */
function _showStartupError(message) {
    ensureTunnelDomElementsInitialized();
    if (!tunnelStatusDisplay) return;
    tunnelStatusDisplay.textContent = `Status: Error - ${message || 'Unknown error'}`;
    tunnelStatusDisplay.className = 'tunnel-status status-stopped';
}

// Variable to track the tunnel status polling interval
let tunnelStatusPollingInterval = null;
const TUNNEL_STATUS_POLL_MS = 10000;
const TUNNEL_STATUS_FETCH_TIMEOUT_MS = 5000;
const TUNNEL_STATUS_RETRY_MS = 2000;
const TUNNEL_SAVE_BUTTON_LABEL = 'Save';
const TUNNEL_SAVE_BUTTON_SAVING_LABEL = 'Saving...';
const managedTimeouts = new Set();

function scheduleManagedTimeout(callback, delayMs) {
    const timeoutId = tunnelModalLifecycle
        ? tunnelModalLifecycle.timeout(() => {
            managedTimeouts.delete(timeoutId);
            callback();
        }, delayMs)
        : setTimeout(() => {
            managedTimeouts.delete(timeoutId);
            callback();
        }, delayMs);
    managedTimeouts.add(timeoutId);
    return timeoutId;
}

function clearManagedTimeouts() {
    for (const timeoutId of managedTimeouts) {
        if (tunnelModalLifecycle) {
            tunnelModalLifecycle.clearTimeout(timeoutId);
        } else {
            clearTimeout(timeoutId);
        }
    }
    managedTimeouts.clear();
}

function clearTunnelStatusPolling() {
    if (tunnelStatusPollingInterval) {
        if (tunnelModalLifecycle) {
            tunnelModalLifecycle.clearInterval(tunnelStatusPollingInterval);
        } else {
            clearInterval(tunnelStatusPollingInterval);
        }
        tunnelStatusPollingInterval = null;
        _activeTunnelPollMs = null;
    }
}

function cancelPendingTunnelStatusRequest() {
    if (_tunnelStatusAbortController) {
        _tunnelStatusAbortController.abort();
        _tunnelStatusAbortController = null;
    }
}

function clearTunnelStatusRetry() {
    if (_tunnelStatusRetryTimeoutId) {
        if (tunnelModalLifecycle) {
            tunnelModalLifecycle.clearTimeout(_tunnelStatusRetryTimeoutId);
        } else {
            clearTimeout(_tunnelStatusRetryTimeoutId);
        }
        _tunnelStatusRetryTimeoutId = null;
    }
}

function scheduleTunnelStatusRetry() {
    if (!isTunnelModalOpen() || _tunnelStatusRetryTimeoutId) return;

    _tunnelStatusRetryTimeoutId = tunnelModalLifecycle
        ? tunnelModalLifecycle.timeout(async () => {
            _tunnelStatusRetryTimeoutId = null;
            _lastTunnelStatusKey = null;
            await updateTunnelStatusDisplay();
        }, TUNNEL_STATUS_RETRY_MS)
        : setTimeout(async () => {
            _tunnelStatusRetryTimeoutId = null;
            _lastTunnelStatusKey = null;
            await updateTunnelStatusDisplay();
        }, TUNNEL_STATUS_RETRY_MS);
}

function startTunnelStatusPolling(callback, delayMs) {
    clearTunnelStatusPolling();
    tunnelStatusPollingInterval = tunnelModalLifecycle
        ? tunnelModalLifecycle.interval(callback, delayMs)
        : setInterval(callback, delayMs);
    _activeTunnelPollMs = delayMs;
}

function isTunnelModalOpen() {
    ensureTunnelDomElementsInitialized();
    return !!tunnelModal && !tunnelModal.classList.contains('hidden');
}

function resetTunnelSaveButtonState() {
    ensureTunnelDomElementsInitialized();
    if (!tunnelModalSaveSettingsBtn) return;

    tunnelModalSaveSettingsBtn.textContent = TUNNEL_SAVE_BUTTON_LABEL;
    tunnelModalSaveSettingsBtn.disabled = false;
}

function ensureTunnelStatusPolling() {
    if (!isTunnelModalOpen()) return;
    const pollMs = _currentTunnelPollMs || TUNNEL_STATUS_POLL_MS;
    if (tunnelStatusPollingInterval && _activeTunnelPollMs === pollMs) return;

    startTunnelStatusPolling(async () => {
        try {
            await updateTunnelStatusDisplay();
        } catch (error) {
            console.error('Error polling tunnel status:', error);
        }
    }, pollMs);
}

class TunnelModalLifecycle extends Module {
    constructor() {
        super();
        this._overlayClickHandler = (event) => {
            if (event.target === tunnelModal) {
                closeTunnelModal();
            }
        };
    }

    onStart() {
        ensureTunnelDomElementsInitialized();
        // tunnelToggleBtn is handled by uiController, which will call openTunnelModal
        if (tunnelModalCloseBtn) this.on(tunnelModalCloseBtn, 'click', closeTunnelModal);
        if (tunnelModalStartBtn) this.on(tunnelModalStartBtn, 'click', handleStartTunnel);
        if (tunnelModalStopBtn) this.on(tunnelModalStopBtn, 'click', handleStopTunnel);
        if (tunnelModalSaveSettingsBtn) this.on(tunnelModalSaveSettingsBtn, 'click', handleSaveTunnelSettings);
        if (tunnelProviderSelect) this.on(tunnelProviderSelect, 'change', updatePinggyTokenVisibility);
        if (hsCopyJoinBtn) this.on(hsCopyJoinBtn, 'click', handleCopyHsJoin);
        if (tunnelModal) this.on(tunnelModal, 'click', this._overlayClickHandler);

        const socket = getSocket();
        if (socket) {
            this.onSocket(socket, SOCKET_EVENTS.TUNNEL_STATUS_UPDATE, (data) => {
                _lastTunnelStatusKey = null; // Force fresh render on push
                // Show real-time stage progress during startup
                if (data && data.status === 'starting' && data.stage) {
                    _showStartupStage(data.stage, data.message);
                } else if (data && data.status === 'error') {
                    _showStartupError(data.message);
                } else {
                    updateTunnelStatusDisplay();
                }
            });
        }
    }

    onStop() {
        clearTunnelStatusPolling();
        clearManagedTimeouts();
    }
}

let tunnelModalLifecycle = null;

/**
 * Updates the visibility of Pinggy token input based on provider selection.
 */
function updatePinggyTokenVisibility() {
    if (!tunnelProviderSelect || !pinggyTokenGroup) return;

    const selectedProvider = tunnelProviderSelect.value;
    if (selectedProvider === 'pinggy') {
        pinggyTokenGroup.classList.remove('hidden');
    } else {
        pinggyTokenGroup.classList.add('hidden');
    }
}

/**
 * Checks if eth0 has internet access for Tailscale recommendation
 * @returns {Promise<boolean>} True if eth0 has internet
 */
async function checkEth0Internet() {
    try {
        const response = await fetch('/api/network-health');
        const data = await response.json();
        // Use the explicit has_eth0_internet flag from the backend
        return data.has_eth0_internet === true;
    } catch (error) {
        console.error('Error checking eth0 internet:', error);
        return false;
    }
}

/**
 * Checks if the device is in AP mode or has no Wi-Fi available
 * @returns {Promise<boolean>} True if in AP mode or no Wi-Fi, false otherwise
 */
async function isInAPModeOrNoWifi() {
    try {
        // Get the local IP address from the server
        const response = await fetch('/api/config');
        const data = await response.json();

        // Check if we're in AP mode (192.168.4.x is typical for AP mode)
        const ipAddress = data.server_info?.local_ip || '';

        // Check if IP starts with 192.168.4. (typical AP mode) or if it's 127.0.0.1 (no network)
        const isAPMode = ipAddress.startsWith('192.168.4.');
        const isLocalhost = ipAddress === '127.0.0.1' || ipAddress === 'localhost';

        return isAPMode || isLocalhost;
    } catch (error) {
        console.error('Error checking network mode:', error);
        // If we can't determine, show the warning to be safe
        return true;
    }
}

/**
 * Populates the tunnel modal with current settings from appConfig.
 */
async function populateTunnelModal() {
    ensureTunnelDomElementsInitialized();
    const runtimeConfig = getRuntimeConfig();
    if (!runtimeConfig || !runtimeConfig.python_config) {
        if (tunnelStatusDisplay) tunnelStatusDisplay.textContent = 'Error: App configuration not loaded.';
        return;
    }
    const pythonConfig = runtimeConfig.python_config;
    if (tunnelProviderSelect) tunnelProviderSelect.value = pythonConfig.TUNNEL_PROVIDER || 'mesh';
    if (pinggyAccessTokenInput) pinggyAccessTokenInput.value = pythonConfig.PINGGY_ACCESS_TOKEN || '';
    if (tunnelAutoStartCheckbox) tunnelAutoStartCheckbox.checked = pythonConfig.TUNNEL_AUTO_START || false;

    // Update Pinggy token visibility based on selected provider
    updatePinggyTokenVisibility();

    // Check network mode and show/hide alert accordingly
    const alertElement = $('#tunnel-modal .alert-warning');
    if (alertElement) {
        const shouldShowAlert = await isInAPModeOrNoWifi();
        alertElement.style.display = shouldShowAlert ? 'block' : 'none';

        // Show specific Mesh recommendation if eth0 internet is found
        const eth0HasInternet = await checkEth0Internet();
        if (eth0HasInternet && tunnelProviderSelect) {
            const meshOption = Array.from(tunnelProviderSelect.options).find(opt => opt.value === 'mesh');
            if (meshOption) {
                meshOption.textContent = 'Secure Mesh (Recommended - Direct Access)';
            }
        }
    }

    updateTunnelStatusDisplay(); // Fetch current status from backend
}


/**
 * Opens the tunnel management modal.
 */
function openTunnelModal() {
    ensureTunnelDomElementsInitialized();
    _lastTunnelStatusKey = null; // Force fresh render on open
    resetTunnelSaveButtonState();
    populateTunnelModal();
    if (tunnelModal) tunnelModal.classList.remove('hidden');

    // Initialize tunnel status and start polling if not active
    updateTunnelStatusDisplay();

    // Light fallback poll for node list updates — socket events handle real-time status
    ensureTunnelStatusPolling(); // Slow poll for node list; socket events push status changes
}

/**
 * Closes the tunnel management modal.
 */
function closeTunnelModal() {
    ensureTunnelDomElementsInitialized();
    if (tunnelModal) tunnelModal.classList.add('hidden');

    // Clear any active polling interval when the modal is closed
    clearTunnelStatusPolling();
    clearManagedTimeouts();
    clearTunnelStatusRetry();
    cancelPendingTunnelStatusRequest();
    _currentTunnelPollMs = null;
    _activeTunnelPollMs = null;
    console.log('Tunnel status polling stopped due to modal close');

}

/**
 * Updates the tunnel status display by fetching from the backend.
 */
async function updateTunnelStatusDisplay() {
    ensureTunnelDomElementsInitialized();
    if (!tunnelStatusDisplay) return;

    clearTunnelStatusRetry();
    cancelPendingTunnelStatusRequest();

    const requestId = ++_tunnelStatusRequestId;
    const abortController = new AbortController();
    _tunnelStatusAbortController = abortController;
    const timeoutId = scheduleManagedTimeout(() => abortController.abort(), TUNNEL_STATUS_FETCH_TIMEOUT_MS);

    try {
        const response = await fetch('/api/tunnel/status', {
            signal: abortController.signal,
            cache: 'no-store',
        });
        const data = await response.json();
        if (requestId !== _tunnelStatusRequestId) return;
        _tunnelStatusAbortController = null;
        const desiredPollMs = data.status === 'starting' ? 2000 : TUNNEL_STATUS_POLL_MS;
        if (_currentTunnelPollMs !== desiredPollMs) {
            _currentTunnelPollMs = desiredPollMs;
            ensureTunnelStatusPolling();
        }

        // Build a key from the parts that affect the display — skip DOM update if unchanged
        const nodeCount = (data.all_nodes || []).length;
        const connectedNodeCount = (data.nodes || []).length;
        const nodeSummary = (data.all_nodes || [])
            .map(node => `${node.id}:${node.last_seen || ''}:${(node.ip_addresses || []).join(',')}`)
            .join(';');
        const connectedSummary = (data.nodes || [])
            .map(node => node.id)
            .join(',');
        const statusKey = response.ok
            ? `${data.status}|${data.provider || ''}|${data.url || ''}|${data.control_url || ''}|${data.app_url || ''}|${data.preauth_key || ''}|${data.stage || ''}|${data.message || ''}|${data.mesh_health || ''}|${data.hs_active ?? ''}|${nodeCount}|${connectedNodeCount}|${nodeSummary}|${connectedSummary}`
            : `error|${response.status}`;
        if (statusKey === _lastTunnelStatusKey) return;
        _lastTunnelStatusKey = statusKey;

        if (response.ok) {
            if (data.status === 'starting') {
                if (data.mesh_health === 'recovering') {
                    clear(tunnelStatusDisplay);
                    append(tunnelStatusDisplay,
                        createElement('span', { className: 'tunnel-startup-progress', children: [
                            createElement('span', { className: 'tunnel-spinner' }),
                            createElement('span', { textContent: ` ${data.message || 'Mesh recovering...'}` }),
                        ]})
                    );
                    tunnelStatusDisplay.className = 'tunnel-status status-starting';
                } else {
                    _showStartupStage(data.stage, data.message);
                }
                if (meshInfoContainer) meshInfoContainer.classList.add('hidden');
            } else if (data.status === 'error') {
                _currentTunnelPollMs = TUNNEL_STATUS_POLL_MS;
                _showStartupError(data.message || 'Mesh startup failed.');
                if (meshInfoContainer) meshInfoContainer.classList.add('hidden');
                scheduleTunnelStatusRetry();
            } else if (data.status === 'running') {
                let displayText = `Status: Running (${data.provider || 'Unknown'})`;
                let accessUrl = '';

                if (data.provider === 'mesh') {
                    // For Mesh/Tailscale - use app_url if provided (e.g. ghosthub.mesh.local)
                    accessUrl = data.app_url || 'http://ghosthub.mesh.local:5000';
                    clear(tunnelStatusDisplay);
                    append(tunnelStatusDisplay,
                        `Status: Running (${data.provider || 'Unknown'}) - Access at: `,
                        createElement('a', { href: accessUrl, target: '_blank', className: 'tunnel-url', textContent: accessUrl })
                    );
                } else if (data.url) {
                    // For other tunnel types
                    clear(tunnelStatusDisplay);
                    append(tunnelStatusDisplay,
                        `Status: Running (${data.provider || 'Unknown'}) - URL: `,
                        createElement('a', { href: data.url, target: '_blank', className: 'tunnel-url', textContent: data.url })
                    );
                } else {
                    tunnelStatusDisplay.textContent = `Status: Running (${data.provider || 'Unknown'}) - URL: Waiting for URL...`;
                }
                tunnelStatusDisplay.className = 'tunnel-status status-running'; // Set class last

                // Show Secure Mesh details if active
                if (data.provider === 'mesh' && meshInfoContainer) {
                    meshInfoContainer.classList.remove('hidden');

                    // Show setup instructions for Tailscale
                    const serverUrl = data.control_url || data.url;
                    if (serverUrl && data.preauth_key) {
                        const preauth_key = data.preauth_key;
                        const device = detectDevice();

                        const setupInfo = createElement('div', { className: 'mesh-setup-instructions' });

                        // Desktop: Show CLI command with copy button
                        if (device.isDesktop) {
                            const joinCommand = `tailscale up --login-server ${serverUrl} --authkey ${preauth_key} --hostname my-device --accept-routes --accept-dns`;
                            const copyBtn = createElement('button', {
                                className: 'copy-command-btn',
                                textContent: 'Copy',
                                onClick: () => copyToClipboard(joinCommand)
                            });

                            clear(setupInfo);
                            append(setupInfo,
                                createElement('div', {
                                    className: 'device-type-badge', children: [
                                        createElement('span', { className: 'badge-icon', textContent: '💻' }),
                                        createElement('span', { textContent: 'Desktop Instructions' })
                                    ]
                                }),
                                createElement('div', {
                                    className: 'mesh-steps-list', children: [
                                        createElement('div', {
                                            className: 'mesh-step', children: [
                                                createElement('span', { className: 'mesh-step-num', textContent: '1' }),
                                                createElement('div', {
                                                    className: 'mesh-step-content', children: [
                                                        createElement('strong', { textContent: 'Install Tailscale' }),
                                                        createElement('span', {
                                                            children: [
                                                                `Download for ${device.platform === 'windows' ? 'Windows' : device.platform === 'macos' ? 'macOS' : 'Linux'}: `,
                                                                createElement('a', { href: 'https://tailscale.com/download', target: '_blank', textContent: 'tailscale.com/download' })
                                                            ]
                                                        })
                                                    ]
                                                })
                                            ]
                                        }),
                                        createElement('div', {
                                            className: 'mesh-step mesh-step-highlight', children: [
                                                createElement('span', { className: 'mesh-step-num', textContent: '2' }),
                                                createElement('div', {
                                                    className: 'mesh-step-content', children: [
                                                        createElement('strong', { textContent: 'Run This Command' }),
                                                        createElement('span', { textContent: 'Open terminal/command prompt and run:' }),
                                                        createElement('div', {
                                                            className: 'mesh-command-box', children: [
                                                                createElement('code', { className: 'mesh-command', textContent: joinCommand }),
                                                                createElement('div', { id: 'copy-btn-container', children: copyBtn })
                                                            ]
                                                        }),
                                                        createElement('div', {
                                                            className: 'mesh-tip', children: [
                                                                createElement('span', { className: 'tip-icon', textContent: '💡' }),
                                                                createElement('span', { innerHTML: 'Replace <code>my-device</code> with your device name' })
                                                            ]
                                                        })
                                                    ]
                                                })
                                            ]
                                        }),
                                        createElement('div', {
                                            className: 'mesh-step', children: [
                                                createElement('span', { className: 'mesh-step-num', textContent: '3' }),
                                                createElement('div', {
                                                    className: 'mesh-step-content', children: [
                                                        createElement('strong', { textContent: 'Access GhostHub' }),
                                                        createElement('span', {
                                                            children: [
                                                                'Once connected, open: ',
                                                                createElement('a', { href: accessUrl, target: '_blank', textContent: accessUrl })
                                                            ]
                                                        })
                                                    ]
                                                })
                                            ]
                                        })
                                    ]
                                })
                            );
                        }
                        // Mobile: Show app-based instructions
                        else {
                            const copyUrlBtn = createElement('button', {
                                textContent: 'Copy',
                                onClick: (e) => copyToClipboard(serverUrl, e.currentTarget)
                            });

                            clear(setupInfo);
                            append(setupInfo,
                                createElement('div', {
                                    className: 'device-type-badge mobile', children: [
                                        createElement('span', { className: 'badge-icon', innerHTML: mobileIcon(16) }),
                                        createElement('span', { textContent: 'Mobile Instructions' })
                                    ]
                                }),
                                createElement('div', {
                                    className: 'mesh-steps-list', children: [
                                        createElement('div', {
                                            className: 'mesh-step', children: [
                                                createElement('span', { className: 'mesh-step-num', textContent: '1' }),
                                                createElement('div', {
                                                    className: 'mesh-step-content', children: [
                                                        createElement('strong', { textContent: 'Install Tailscale App' }),
                                                        createElement('span', { textContent: `Download from ${device.platform === 'ios' ? 'App Store' : 'Play Store'}` }),
                                                        createElement('div', {
                                                            className: 'mesh-store-badges', children: [
                                                                createElement('a', {
                                                                    href: device.platform === 'ios' ? 'https://apps.apple.com/app/tailscale/id1470499037' : 'https://play.google.com/store/apps/details?id=com.tailscale.ipn',
                                                                    target: '_blank',
                                                                    className: 'store-badge',
                                                                    innerHTML: `${mobileIcon(16)} ${device.platform === 'ios' ? 'App Store' : 'Play Store'}`
                                                                })
                                                            ]
                                                        })
                                                    ]
                                                })
                                            ]
                                        }),
                                        createElement('div', {
                                            className: 'mesh-step', children: [
                                                createElement('span', { className: 'mesh-step-num', textContent: '2' }),
                                                createElement('div', {
                                                    className: 'mesh-step-content', children: [
                                                        createElement('strong', { textContent: 'Configure Server' }),
                                                        createElement('span', { textContent: 'In Tailscale app settings, add custom server:' }),
                                                        createElement('div', {
                                                            className: 'mesh-copy-row', children: [
                                                                createElement('code', { textContent: serverUrl }),
                                                                createElement('div', { id: 'copy-url-btn-container', children: copyUrlBtn })
                                                            ]
                                                        })
                                                    ]
                                                })
                                            ]
                                        }),
                                        createElement('div', {
                                            className: 'mesh-step mesh-step-highlight', children: [
                                                createElement('span', { className: 'mesh-step-num', textContent: '3' }),
                                                createElement('div', {
                                                    className: 'mesh-step-content', children: [
                                                        createElement('strong', { textContent: 'Approve Device' }),
                                                        createElement('span', { innerHTML: 'After connecting, copy the <code>nodekey:...</code> from the registration page and paste here:' }),
                                                        createElement('div', {
                                                            className: 'mesh-copy-row', children: [
                                                                createElement('input', { type: 'text', id: 'node-key-input', placeholder: 'Paste nodekey here...' }),
                                                                createElement('button', { id: 'register-device-btn', textContent: 'Add' })
                                                            ]
                                                        })
                                                    ]
                                                })
                                            ]
                                        }),
                                        createElement('div', {
                                            className: 'mesh-step', children: [
                                                createElement('span', { className: 'mesh-step-num', textContent: '4' }),
                                                createElement('div', {
                                                    className: 'mesh-step-content', children: [
                                                        createElement('strong', { textContent: 'Access GhostHub' }),
                                                        createElement('span', {
                                                            children: [
                                                                'Open browser and go to: ',
                                                                createElement('a', { href: accessUrl, target: '_blank', textContent: accessUrl.replace('http://', '') })
                                                            ]
                                                        })
                                                    ]
                                                })
                                            ]
                                        })
                                    ]
                                })
                            );
                        }

                        // Insert into mesh instructions container (always re-render on status change)
                        const meshInstructionsDisplay = $('#mesh-instructions');
                        if (meshInstructionsDisplay) {
                            clear(meshInstructionsDisplay);
                            append(meshInstructionsDisplay, setupInfo);
                        }

                        // Add event listener for register button
                        const registerBtn = $('#register-device-btn');
                        const nodeKeyInput = $('#node-key-input');
                        if (registerBtn && nodeKeyInput) {
                            attr(registerBtn, {
                                onClick: async () => {
                                    const nodeKey = nodeKeyInput.value.trim();
                                    if (!nodeKey) {
                                        toast.error('Please paste the nodekey from the registration page');
                                        return;
                                    }
                                    registerBtn.textContent = 'Adding...';
                                    registerBtn.disabled = true;
                                    try {
                                        const resp = await fetch('/api/tunnel/register-device', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ node_key: nodeKey })
                                        });
                                        const result = await resp.json();
                                        if (result.status === 'success') {
                                            toast.success(result.message);
                                            nodeKeyInput.value = '';
                                            updateTunnelStatusDisplay();
                                        } else {
                                            toast.error('Error: ' + result.message);
                                        }
                                    } catch (err) {
                                        toast.error('Failed to register device: ' + err.message);
                                    } finally {
                                        registerBtn.textContent = 'Add';
                                        registerBtn.disabled = false;
                                    }
                                }
                            });
                        }
                    }

                    // Update Node List - show both connected and offline nodes
                    if (hsNodesList) {
                        const allNodes = data.all_nodes || [];
                        const connectedNodes = data.nodes || [];

                        // Debug logging to help diagnose connection issues
                        console.log('[Mesh Debug] All nodes:', allNodes.length, 'Connected nodes:', connectedNodes.length);
                        if (allNodes.length === 0) {
                            console.warn('[Mesh Debug] No nodes registered. Pi may not have joined mesh successfully.');
                            console.warn('[Mesh Debug] Check: sudo tailscale status on Pi');
                        }

                        if (allNodes.length > 0) {
                            clear(hsNodesList);
                            allNodes.forEach(node => {
                                const isConnected = connectedNodes.some(connected => connected.id === node.id);
                                const statusClass = isConnected ? 'node-online' : 'node-offline';
                                const statusText = isConnected ? 'Online' : 'Offline';
                                const statusIcon = isConnected ? '●' : '○';

                                // Fix date parsing - handle various formats
                                let lastSeen = 'Never';
                                if (node.last_seen) {
                                    try {
                                        const date = new Date(node.last_seen);
                                        if (!isNaN(date.getTime())) {
                                            lastSeen = date.toLocaleString(undefined, {
                                                month: 'short',
                                                day: 'numeric',
                                                hour: '2-digit',
                                                minute: '2-digit'
                                            });
                                        }
                                    } catch (e) {
                                        console.error('Error parsing date:', node.last_seen, e);
                                    }
                                }

                                const ipAddress = node.ip_addresses && node.ip_addresses.length > 0 ? node.ip_addresses[0] : 'N/A';

                                const li = createElement('li', {
                                    className: 'mesh-device-item',
                                    dataset: { nodeId: node.id },
                                    innerHTML: `
                                        <div class="mesh-device-info">
                                            <div class="mesh-device-header">
                                                <span class="mesh-device-name">${node.given_name || node.name}</span>
                                                <span class="mesh-device-status ${statusClass}">
                                                    <span class="status-icon">${statusIcon}</span>
                                                    <span class="status-text">${statusText}</span>
                                                </span>
                                            </div>
                                            <div class="mesh-device-details">
                                                <span class="device-ip">${ipAddress}</span>
                                                <span class="device-separator">•</span>
                                                <span class="device-last-seen">${lastSeen}</span>
                                            </div>
                                            ${node.tags && node.tags.length > 0 ? `
                                                <div class="mesh-device-tags">
                                                    ${node.tags.map(tag => `<span class="device-tag">${tag}</span>`).join('')}
                                                </div>
                                            ` : ''}
                                        </div>
                                        <button class="remove-node-btn" data-node-id="${node.id}" 
                                                title="Remove Device" 
                                                aria-label="Remove ${node.given_name || node.name}">
                                            ×
                                        </button>
                                    `
                                });
                                append(hsNodesList, li);
                            });

                            // Attach event listeners to remove buttons
                            $$('.remove-node-btn', hsNodesList).forEach(btn => {
                                attr(btn, {
                                    onClick: async (e) => {
                                        const nodeId = e.currentTarget.getAttribute('data-node-id');
                                        const nodeElement = e.currentTarget.closest('li');
                                        const nodeName = $('.mesh-device-name', nodeElement).textContent;

                                        if (!await dialog.confirm('Remove device "' + nodeName + '"? This will revoke their access.', { type: 'danger' })) return;
                                        await handleRemoveNode(nodeId);
                                    }
                                });
                            });
                        } else {
                            clear(hsNodesList);
                            append(hsNodesList, createElement('li', {
                                className: 'mesh-node-pending',
                                children: [
                                    createElement('div', { className: 'mesh-node-pending-title', textContent: '⏳ Setting up mesh network...' }),
                                    createElement('div', {
                                        className: 'mesh-node-pending-desc', innerHTML: `
                                        The Pi is connecting to the mesh network. This can take up to 60 seconds.<br>
                                        <br>
                                        If this message persists for more than 2 minutes, try:<br>
                                        • Stop and restart the mesh tunnel<br>
                                        • Check your network connection<br>
                                        • Restart GhostHub from the admin panel
                                    `})
                                ]
                            }));
                        }
                    }
                } else if (meshInfoContainer) {
                    meshInfoContainer.classList.add('hidden');
                }
            } else {
                _currentTunnelPollMs = TUNNEL_STATUS_POLL_MS;
                tunnelStatusDisplay.textContent = `Status: Stopped`;
                tunnelStatusDisplay.className = 'tunnel-status status-stopped';
                if (meshInfoContainer) meshInfoContainer.classList.add('hidden');
            }
        } else {
            _currentTunnelPollMs = TUNNEL_STATUS_POLL_MS;
            tunnelStatusDisplay.textContent = `Status: Error fetching - ${data.message || 'Unknown error'}`;
            tunnelStatusDisplay.className = 'tunnel-status status-stopped'; // Treat error as stopped
            if (meshInfoContainer) meshInfoContainer.classList.add('hidden');
            scheduleTunnelStatusRetry();
        }
    } catch (error) {
        if (requestId !== _tunnelStatusRequestId) return;
        if (error?.name === 'AbortError') return;

        _tunnelStatusAbortController = null;
        _currentTunnelPollMs = TUNNEL_STATUS_POLL_MS;
        console.error('Failed to fetch tunnel status:', error);
        tunnelStatusDisplay.textContent = 'Status: Error fetching status.';
        tunnelStatusDisplay.className = 'tunnel-status status-stopped';
        if (meshInfoContainer) meshInfoContainer.classList.add('hidden');
        scheduleTunnelStatusRetry();
    } finally {
        if (timeoutId) {
            if (tunnelModalLifecycle) {
                tunnelModalLifecycle.clearTimeout(timeoutId);
            } else {
                clearTimeout(timeoutId);
            }
        }
        if (_tunnelStatusAbortController === abortController) {
            _tunnelStatusAbortController = null;
        }
    }
}

/**
 * Copy text to clipboard with fallback for unsupported browsers
 */
function copyToClipboard(text, buttonElement = null) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            if (buttonElement) {
                const originalText = buttonElement.textContent;
                buttonElement.textContent = '✓';
                scheduleManagedTimeout(() => {
                    buttonElement.textContent = originalText;
                }, 1000);
            }
        }).catch(err => {
            console.error('Failed to copy to clipboard:', err);
            fallbackCopy(text);
        });
    } else {
        fallbackCopy(text);
    }
}

// Expose for inline mesh setup buttons
/**
 * Fallback copy method using document.execCommand
 */
function fallbackCopy(text) {
    const textArea = createElement('textarea', {
        value: text,
        style: { position: 'fixed', left: '-999999px', top: '-999999px' }
    });
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
        document.execCommand('copy');
        toast.success('Text copied to clipboard!');
    } catch (err) {
        console.error('Fallback copy failed:', err);
        toast.error('Failed to copy. Please copy manually: ' + text);
    }

    remove(textArea);
}

/**
 * Handles saving tunnel specific settings (provider, token, port).
 */
async function handleSaveTunnelSettings() {
    const runtimeConfig = getRuntimeConfig();
    if (!runtimeConfig) {
        toast.error('App configuration not loaded. Cannot save tunnel settings.');
        return;
    }

    const newPythonConfig = { ...(runtimeConfig.python_config || {}) }; // Create a copy to modify

    newPythonConfig.TUNNEL_PROVIDER = tunnelProviderSelect ? tunnelProviderSelect.value : 'none';
    newPythonConfig.PINGGY_ACCESS_TOKEN = pinggyAccessTokenInput ? pinggyAccessTokenInput.value : '';
    newPythonConfig.TUNNEL_LOCAL_PORT = tunnelLocalPortInput ? parseInt(tunnelLocalPortInput.value, 10) : 5000;
    newPythonConfig.TUNNEL_AUTO_START = tunnelAutoStartCheckbox ? tunnelAutoStartCheckbox.checked : false;

    const fullNewConfig = {
        ...runtimeConfig,
        python_config: newPythonConfig
    };

    try {
        if (tunnelModalSaveSettingsBtn) {
            tunnelModalSaveSettingsBtn.textContent = TUNNEL_SAVE_BUTTON_SAVING_LABEL;
            tunnelModalSaveSettingsBtn.disabled = true;
        }
        const result = await saveConfig(fullNewConfig); // Use the global saveConfig
        toast.success(result.message || 'Tunnel settings saved successfully!');
    } catch (error) {
        console.error('Failed to save tunnel settings:', error);
        toast.error('Error saving tunnel settings: ' + (error.message || 'Unknown error'));
    } finally {
        resetTunnelSaveButtonState();
    }
}

/**
 * Handles starting the tunnel.
 */
async function handleStartTunnel() {
    if (tunnelModalStartBtn) {
        tunnelModalStartBtn.textContent = 'Starting...';
        tunnelModalStartBtn.disabled = true;
    }
    // Show animated startup indicator immediately
    _showStartupStage('config', null);

    clearTunnelStatusPolling();

    try {
        await handleSaveTunnelSettings();

        const provider = tunnelProviderSelect ? tunnelProviderSelect.value : 'none';
        const localPort = tunnelLocalPortInput ? parseInt(tunnelLocalPortInput.value, 10) : 5000;
        let pinggyToken = '';
        if (provider === 'pinggy') {
            pinggyToken = pinggyAccessTokenInput ? pinggyAccessTokenInput.value : '';
        }

        if (provider === 'none') {
            toast.error('Please select a tunnel provider.');
            if (tunnelModalStartBtn) {
                tunnelModalStartBtn.textContent = 'Start Tunnel';
                tunnelModalStartBtn.disabled = false;
            }
            if (tunnelStatusDisplay) tunnelStatusDisplay.textContent = 'Status: Not Active';
            return;
        }

        const body = {
            provider: provider,
            local_port: localPort
        };
        if (provider === 'pinggy') {
            body.pinggy_token = pinggyToken;
        }

        // Start fast polling immediately — backend runs startup in the background
        // and pushes socket events, but polling is a safety net.
        _currentTunnelPollMs = 2000;
        ensureTunnelStatusPolling();

        const response = await fetch('/api/tunnel/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        const data = await response.json();

        if (data.status === 'starting' || data.status === 'success') {
            // Startup is running in the background — socket events will push
            // real-time stage updates; polling is the fallback.
            if (data.status === 'success') {
                toast.success(data.message || 'Tunnel started successfully!');
            }
            _lastTunnelStatusKey = null;
        } else {
            toast.error('Error starting tunnel: ' + (data.message || 'Unknown error'));
            _lastTunnelStatusKey = null;
            await updateTunnelStatusDisplay();
        }
    } catch (error) {
        console.error('Failed to start tunnel:', error);
        toast.error('Error starting tunnel: ' + error.toString());
        _lastTunnelStatusKey = null;
        await updateTunnelStatusDisplay();
        ensureTunnelStatusPolling();
    } finally {
        if (tunnelModalStartBtn) {
            tunnelModalStartBtn.textContent = 'Start Tunnel';
            tunnelModalStartBtn.disabled = false;
        }
    }
}

/**
 * Handles stopping the tunnel.
 */
async function handleStopTunnel() {
    if (tunnelModalStopBtn) {
        tunnelModalStopBtn.textContent = 'Stopping...';
        tunnelModalStopBtn.disabled = true;
    }
    if (tunnelStatusDisplay) {
        tunnelStatusDisplay.textContent = 'Status: Stopping...';
        tunnelStatusDisplay.className = 'tunnel-status status-starting';
    }

    // Always clear any existing polling interval before proceeding
    clearTunnelStatusPolling();
    console.log('Tunnel status polling stopped due to tunnel stop request');

    try {
        const response = await fetch('/api/tunnel/stop', { method: 'POST' });
        const data = await response.json();

        if (response.ok && data.status === 'success') {
            toast.success(data.message || 'Tunnel stopped successfully!');
        } else {
            toast.error('Error stopping tunnel: ' + (data.message || 'Unknown error'));
        }
    } catch (error) {
        console.error('Failed to stop tunnel:', error);
        toast.error('Error stopping tunnel: ' + error.toString());
    } finally {
        if (tunnelModalStopBtn) {
            tunnelModalStopBtn.textContent = 'Stop Tunnel';
            tunnelModalStopBtn.disabled = false;
        }
        await updateTunnelStatusDisplay(); // Refresh status
        ensureTunnelStatusPolling();
    }
}

/**
 * Handles removing a node from the mesh network
 */
async function handleRemoveNode(nodeId) {
    try {
        const response = await fetch('/api/tunnel/remove-node', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ node_id: nodeId })
        });
        const result = await response.json();

        if (result.status === 'success') {
            toast.success('Device removed successfully!');
            updateTunnelStatusDisplay(); // Refresh node list
        } else {
            toast.error('Error removing device: ' + result.message);
        }
    } catch (error) {
        console.error('Failed to remove device:', error);
        toast.error('Failed to remove device: ' + error.message);
    }
}

/**
 * Copies the Headscale join command to clipboard
 */
async function handleCopyHsJoin() {
    if (hsJoinCommand && hsJoinCommand.textContent) {
        try {
            copyToClipboard(hsJoinCommand.textContent);
            toast.success('Tailscale join command copied to clipboard!');
        } catch (error) {
            console.error('Error copying join command:', error);
        }
    }
}

/**
 * Initializes the tunnel modal event listeners.
 */
function initTunnelModal() {
    ensureTunnelDomElementsInitialized();
    // Add inline styles for tunnel URLs if not already in CSS
    if (!$('#tunnel-modal-inline-styles')) {
        document.head.appendChild(createElement('style', {
            id: 'tunnel-modal-inline-styles',
            textContent: `
        .tunnel-url {
            font-weight: bold;
            color: #0066cc;
            text-decoration: underline;
            transition: all 0.2s ease;
        }
        .tunnel-url:hover {
            color: #004080;
        }
        .cloudflare-url {
            color: #f48120;
        }
        .cloudflare-url:hover {
            color: #bf6012;
        }
        .pinggy-url {
            color: #2fac66;
        }
        .pinggy-url:hover {
            color: #238a4f;
        }
    `
        }));
    }

    if (!tunnelModalLifecycle) {
        tunnelModalLifecycle = new TunnelModalLifecycle();
    }
    tunnelModalLifecycle.start();
    console.log('Tunnel Modal Initialized');
}

export { initTunnelModal, openTunnelModal };
