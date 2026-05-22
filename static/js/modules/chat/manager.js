/**
 * Chat Manager Component
 * Handles chat functionality using WebSockets with sessionStorage persistence
 */

import { isSafeToToggleFullscreen } from '../playback/fullscreen.js';
import { initCommandHandler } from './commandHandler.js';
import { ensureFeatureAccess } from '../../utils/authManager.js';
import { initCommandPopup } from './commandPopup.js';
import { Component, Module, createElement, append, css, $, $$, morphDOM, renderList } from '../../libs/ragot.esm.min.js';
import * as Icons from '../../utils/icons.js';
import { SOCKET_EVENTS } from '../../core/socketEvents.js';
import { toast } from '../../utils/notificationManager.js';
import { scheduleAutofocus } from '../../utils/focusManager.js';
import { navigateToState } from '../sync/manager.js';

const STORAGE_KEY = 'ghosthub_chat_messages';
const STORAGE_TIMESTAMP_KEY = 'ghosthub_chat_timestamp';
const STORAGE_JOINED_KEY = 'ghosthub_chat_joined';
const STORAGE_CHAT_POSITION_X = 'ghosthub_chat_position_x';
const STORAGE_CHAT_POSITION_Y = 'ghosthub_chat_position_y';

function escapeHTML(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function shouldKeepChatOpenForCommand(command) {
    return command?.keepChatOpen === true;
}

export class ChatComponent extends Component {
    constructor(socket) {
        super({
            isExpanded: false,
            messages: [],
            unreadCount: 0,
            isJoined: false,
            latestMessage: 'Chat',
            x: sessionStorage.getItem(STORAGE_CHAT_POSITION_X) || null,
            y: sessionStorage.getItem(STORAGE_CHAT_POSITION_Y) || null
        });
        this.socket = socket;
        this.maxMessages = 50;
        // Holds live DOM nodes for HTML messages; keyed by message._htmlId.
        // Never stored in state — avoids morphDOM corruption and JSON serialization failures.
        this._htmlNodes = new Map();
        this._htmlIdCounter = 0;
        this.commandHandler = initCommandHandler(socket, this.displayCommandFeedback.bind(this));

        // Dragging state (volatile state, not in this.state to avoid re-renders during move)
        this.dragData = {
            active: false,
            startX: 0,
            startY: 0,
            initialX: 0,
            initialY: 0,
            moved: false,
            pendingX: 0,
            pendingY: 0,
            rafId: null
        };

        // Self-bind handlers for document listeners
        this._onDragMove = this._onDragMove.bind(this);
        this._onDragEnd = this._onDragEnd.bind(this);
    }

    start() {
        if (this._isMounted) return this;
        const existing = $('#chat-container');
        if (existing) {
            this.mountBefore(existing);
            existing.remove();
            console.log('[ChatManager] Initialized: Replaced static HTML with live Component.');
        } else {
            this.mount(document.body);
            console.log('[ChatManager] Initialized: Mounted to body.');
        }
        return this;
    }

    stop() {
        this.unmount();
        return this;
    }

    onStop() {
        if (this.dragData?.rafId) {
            cancelAnimationFrame(this.dragData.rafId);
            this.dragData.rafId = null;
        }
    }

    syncFromModule() {
        // Reserved for Module -> Component state sync contracts.
    }

    onStart() {
        this.loadChatHistory();
        this.joinChat();

        // Drag handlers are always attached while mounted.
        // Guarded by dragData.active to avoid handler churn/leaks.
        this.on(document, 'mousemove', this._onDragMove);
        this.on(document, 'mouseup', this._onDragEnd);
        this.on(document, 'touchmove', this._onDragMove, { passive: false });
        this.on(document, 'touchend', this._onDragEnd);
    }

    normalizeMessageOptions(isHtml = false, persist = false, icon = null) {
        if (typeof isHtml === 'object' && isHtml !== null) {
            return {
                isHtml: Boolean(isHtml.isHtml),
                persist: Boolean(isHtml.persist),
                icon: isHtml.icon ?? null,
                surface: isHtml.surface ?? null,
                tone: isHtml.tone ?? null
            };
        }

        return {
            isHtml: Boolean(isHtml),
            persist: Boolean(persist),
            icon,
            surface: null,
            tone: null
        };
    }

    /**
     * Set up command popup when input ref is ready.
     * This handles potential re-renders by ensuring the popup is tied to the current DOM node.
     */
    _setInputRef(el) {
        this.refs.input = el;
        if (!el) return;

        if (!this.commandPopupManager) {
            this.commandPopupManager = initCommandPopup(el);
        } else {
            // Keep popup manager bound to the current input after re-renders.
            this.commandPopupManager.input = el;
        }
    }

    render() {
        const { isExpanded, messages, unreadCount, latestMessage, x, y } = this.state;

        const containerStyle = {};
        if (x !== null && y !== null) {
            containerStyle.left = x;
            containerStyle.top = y;
            containerStyle.bottom = 'auto';
            containerStyle.right = 'auto';
        }

        // Return the full root container to allow morphDOM to manage lifecycle properly
        return createElement('div', {
            id: 'chat-container',
            className: `chat-container ${isExpanded ? 'expanded' : 'collapsed'} ${unreadCount > 0 ? 'has-unread' : ''}`,
            style: containerStyle
        },
            // Header: Handles dragging and Toggling
            createElement('div', {
                className: 'chat-header',
                onMouseDown: (e) => this._handleDragStart(e),
                onTouchStart: (e) => this._handleDragStart(e),
                onClick: (e) => this._handleHeaderClick(e)
            },
                createElement('div', { className: 'latest-message', textContent: latestMessage }),
                createElement('div', { className: 'chat-controls' },
                    createElement('button', {
                        className: 'chat-toggle',
                        onClick: (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            this.toggleChat();
                        }
                    }),
                    unreadCount > 0 ? createElement('div', {
                        className: 'chat-unread-badge',
                        textContent: unreadCount > 99 ? '99+' : unreadCount
                    }) : null
                )
            ),

            // Body: Messages and Input
            createElement('div', { className: 'chat-body' },
                createElement('div', {
                    className: 'chat-messages',
                    ref: this.ref('messagesList')
                },
                    messages.map(msg => this._renderMessage(msg))
                ),
                createElement('form', {
                    className: 'chat-form',
                    onSubmit: (e) => { e.preventDefault(); this.sendMessage(); }
                },
                    createElement('input', {
                        type: 'text',
                        className: 'chat-input',
                        placeholder: 'Type a message...',
                        ref: (el) => this._setInputRef(el)
                    }),
                    createElement('button', { type: 'submit', className: 'chat-send' },
                        createElement('svg', { viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', strokeWidth: '2', innerHTML: '<line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>' })
                    )
                )
            )
        );
    }

    _renderMessage(data) {
        if (data.isNotification) {
            return createElement('div', { className: 'chat-notification', textContent: data.message });
        }
        if (data.isLocalSystem) {
            const el = createElement('div', { className: `chat-local-system ${data.isHtml ? 'chat-local-html' : ''}` });

            // Modern Icon Rendering
            if (data.icon && Icons[`${data.icon}Icon`]) {
                const iconSvg = Icons[`${data.icon}Icon`](14);
                const iconContainer = createElement('span', { className: 'chat-system-icon', innerHTML: iconSvg });
                append(el, iconContainer);
            }

            if (data.isHtml) {
                if (data._htmlId != null) {
                    // Retrieve the live node from the side-channel Map.
                    // morphDOM never sees the HTMLElement in state, so it can't corrupt it.
                    const liveNode = this._htmlNodes.get(data._htmlId);
                    if (liveNode) append(el, liveNode);
                } else if (data.message instanceof HTMLElement) {
                    append(el, data.message);
                } else {
                    const content = createElement('span', { innerHTML: data.message });
                    append(el, content);
                }
            } else {
                const content = createElement('span', { textContent: data.message });
                append(el, content);
            }
            return el;
        }

        const timeString = data.timestamp ? new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const displayUserId = data.user_id || (data.from ? data.from.substring(0, 8) : 'Unknown');

        if (data.isCommandMessage && data.cmd === 'myview') {
            return this._renderMyViewMessage(data, displayUserId, timeString);
        }

        return createElement('div', { className: 'chat-message' },
            createElement('span', {
                className: 'chat-user copyable',
                dataset: { copy: data.user_id || data.from || '' },
                textContent: displayUserId,
                onClick: (e) => this._handleUserClick(e)
            }),
            createElement('span', { className: 'chat-text', innerHTML: data.message ? escapeHTML(data.message) : '' }),
            timeString ? createElement('span', { className: 'chat-time', textContent: timeString }) : null
        );
    }

    _renderMyViewMessage(data, displayUserId, timeString) {
        const { arg } = data;
        const filename = arg.filename || 'Unknown file';
        const thumbnail = arg.thumbnail_url ? createElement('img', {
            src: arg.thumbnail_url,
            className: 'myview-thumbnail',
            alt: filename,
            onError: (e) => { e.currentTarget.style.display = 'none'; }
        }) : null;

        return createElement('div', { className: 'chat-message' },
            createElement('span', {
                className: 'chat-user copyable',
                dataset: { copy: data.from || '' },
                textContent: displayUserId,
                onClick: (e) => this._handleUserClick(e)
            }),
            createElement('span', { className: 'chat-text' },
                createElement('div', { className: 'myview-container' },
                    thumbnail ? createElement('div', { children: [thumbnail] }) : null,
                    createElement('div', { className: 'myview-info' },
                        createElement('div', { className: 'myview-header', textContent: 'Shared a view' }),
                        createElement('div', { className: 'myview-filename', title: filename, textContent: filename }),
                        createElement('span', {
                            className: 'command-link',
                            textContent: 'Jump to this view',
                            onClick: (e) => { e.stopPropagation(); this._handleJumpClick(data); }
                        })
                    )
                )
            ),
            createElement('span', { className: 'chat-time', textContent: timeString })
        );
    }

    async _handleJumpClick(data) {
        const accessGranted = await ensureFeatureAccess();
        if (!accessGranted) {
            this.displayLocalSystemMessage('Password validation required to access this shared view.');
            return;
        }
        const { category_id, mediaId } = data.arg;
        this.displayLocalSystemMessage(`Navigating to shared view...`);

        const success = await navigateToState(category_id, mediaId, 'SharedView', data.arg);
        if (!success) {
            this.displayLocalSystemMessage(`Error: Could not load the shared view.`);
        }
    }

    async _handleUserClick(e) {
        e.stopPropagation();
        const copyable = e.currentTarget;
        const textToCopy = copyable.dataset.copy;
        if (!textToCopy) return;

        const showFeedback = () => {
            const originalText = copyable.textContent;
            copyable.textContent = 'Copied!';
            copyable.classList.add('copied');
            this.timeout(() => {
                copyable.textContent = originalText;
                copyable.classList.remove('copied');
            }, 1500);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
            try {
                await navigator.clipboard.writeText(textToCopy);
                showFeedback();
                return;
            } catch (_) { /* fall through to execCommand fallback */ }
        }

        try {
            const textarea = document.createElement('textarea');
            textarea.value = textToCopy;
            Object.assign(textarea.style, { position: 'fixed', left: '-999999px', top: '-999999px' });
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
            showFeedback();
        } catch (err) {
            console.error('Fallback copy failed:', err);
        }
    }

    _handleHeaderClick(e) {
        // Prevent toggle if we were just dragging
        if (!this.dragData.moved && !e.target.closest('.chat-toggle')) {
            this.toggleChat();
        }
    }

    _handleDragStart(e) {
        if (e.target.closest('.chat-toggle')) return;

        const touch = e.touches ? e.touches[0] : e;
        const rect = this.element.getBoundingClientRect();

        this.dragData = {
            active: true,
            startX: touch.clientX,
            startY: touch.clientY,
            initialX: rect.left,
            initialY: rect.top,
            moved: false,
            pendingX: rect.left,
            pendingY: rect.top,
            rafId: null
        };

        this.element.classList.add('dragging');

    }

    _applyDragPosition(x, y) {
        if (!this.element) return;
        css(this.element, {
            left: `${x}px`,
            top: `${y}px`,
            bottom: 'auto',
            right: 'auto'
        });
    }

    _scheduleDragPosition(x, y) {
        this.dragData.pendingX = x;
        this.dragData.pendingY = y;
        if (this.dragData.rafId) return;

        this.dragData.rafId = requestAnimationFrame(() => {
            this.dragData.rafId = null;
            this._applyDragPosition(this.dragData.pendingX, this.dragData.pendingY);
        });
    }

    _onDragMove(e) {
        if (!this.dragData.active) return;

        const touch = e.touches ? e.touches[0] : e;
        const dx = touch.clientX - this.dragData.startX;
        const dy = touch.clientY - this.dragData.startY;

        // Threshold to distinguish click from drag (5px)
        if (!this.dragData.moved && Math.hypot(dx, dy) > 5) {
            this.dragData.moved = true;
        }

        if (this.dragData.moved) {
            e.preventDefault();
            const x = this.dragData.initialX + dx;
            const y = this.dragData.initialY + dy;

            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const cw = this.element.offsetWidth;
            const ch = this.element.offsetHeight;

            const constrainedX = Math.max(0, Math.min(x, vw - cw));
            const constrainedY = Math.max(0, Math.min(y, vh - ch));

            // Throttle DOM writes to one per frame to keep dragging smooth.
            this._scheduleDragPosition(constrainedX, constrainedY);
        }
    }

    _onDragEnd() {
        if (!this.dragData.active) return;

        this.element.classList.remove('dragging');

        if (this.dragData.moved) {
            if (this.dragData.rafId) {
                cancelAnimationFrame(this.dragData.rafId);
                this.dragData.rafId = null;
                this._applyDragPosition(this.dragData.pendingX, this.dragData.pendingY);
            }

            // Commit final position to state so it survives re-renders
            const rect = this.element.getBoundingClientRect();
            const pos = {
                x: `${rect.left}px`,
                y: `${rect.top}px`
            };
            this.setState(pos);
            sessionStorage.setItem(STORAGE_CHAT_POSITION_X, pos.x);
            sessionStorage.setItem(STORAGE_CHAT_POSITION_Y, pos.y);
        }

        this.dragData.active = false;
    }

    resolveToastType(options, message) {
        const requestedTone = typeof options?.tone === 'string' ? options.tone.toLowerCase() : '';
        if (requestedTone && toast[requestedTone]) return requestedTone;

        const icon = typeof options?.icon === 'string' ? options.icon : '';
        if (icon === 'checkCircle') return 'success';
        if (icon === 'stop') return 'warning';
        if (icon === 'x') return 'error';

        const text = String(message || '').toLowerCase();
        if (/(^|\b)(error|failed|cannot|unknown|invalid|timed out|timeout)(\b|:)/.test(text)) {
            return 'error';
        }
        if (/(^|\b)(warning|password validation required|slow down|rate limit)(\b|:)/.test(text)) {
            return 'warning';
        }
        if (/(^|\b)(done|saved|added|removed|broadcasting|started|loaded|selected)(\b|:)/.test(text)) {
            return 'success';
        }

        return 'info';
    }

    displayCommandFeedback(message, isHtml = false, persist = false, icon = null) {
        const options = this.normalizeMessageOptions(isHtml, persist, icon);

        const isElement = typeof HTMLElement !== 'undefined' && message instanceof HTMLElement;
        const wantsChatSurface = options.surface === 'chat' || (isElement && options.surface !== 'toast');

        if (wantsChatSurface) {
            this.displayLocalSystemMessage(message, options);
            return;
        }

        const toastType = this.resolveToastType(options, message);
        toast.show(message, toastType, {
            isHtml: options.isHtml && typeof message === 'string',
            persist: options.isHtml && typeof message === 'string'
        });
    }

    joinChat() {
        const hasJoined = sessionStorage.getItem(STORAGE_JOINED_KEY) === 'true';
        if (hasJoined) this.socket.emit(SOCKET_EVENTS.REJOIN_CHAT);
        else {
            this.socket.emit(SOCKET_EVENTS.JOIN_CHAT);
            sessionStorage.setItem(STORAGE_JOINED_KEY, 'true');
        }
        this.setState({ isJoined: true });
    }

    toggleChat() {
        console.log('[ChatManager] toggleChat triggered. Current state - expanded:', this.state.isExpanded, 'joined:', this.state.isJoined);

        // Remove the restrictive fullscreen check for now to ensure chat expansion works correctly.
        // It's just a DOM class change and shouldn't cause issues even if a transition is in progress.
        if (this.state.isExpanded) {
            this.collapseChat();
        } else {
            this.expandChat();
        }

        // Use attribute on body to help CSS or other modules detect the state
        document.body.setAttribute('data-chat-expanded', !this.state.isExpanded);
    }

    expandChat() {
        this.setState({ isExpanded: true, unreadCount: 0 });
        this.timeout(() => {
            // Clamp position to viewport after expand changes element size
            if (this.element) {
                const rect = this.element.getBoundingClientRect();
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const ew = this.element.offsetWidth;
                const eh = this.element.offsetHeight;

                if (rect.right > vw || rect.bottom > vh || rect.left < 0 || rect.top < 0) {
                    const clampedX = Math.max(0, Math.min(rect.left, vw - ew));
                    const clampedY = Math.max(0, Math.min(rect.top, vh - eh));
                    const pos = { x: `${clampedX}px`, y: `${clampedY}px` };
                    css(this.element, { left: pos.x, top: pos.y, bottom: 'auto', right: 'auto' });
                    this.state.x = pos.x;
                    this.state.y = pos.y;
                    sessionStorage.setItem(STORAGE_CHAT_POSITION_X, pos.x);
                    sessionStorage.setItem(STORAGE_CHAT_POSITION_Y, pos.y);
                }
            }
            this.scrollToBottom();
            if (this.refs.input) scheduleAutofocus(this.refs.input);
        }, 100);
    }

    collapseChat() {
        // Close command popup if open
        if (this.commandPopupManager?.isPopupVisible?.()) {
            this.commandPopupManager.hideCommandPopup();
        }
        this.setState({ isExpanded: false });
    }

    sendMessage() {
        if (!this.refs.input) return;
        const message = this.refs.input.value.trim();
        if (!message) return;

        if (this.commandHandler && message.startsWith('/')) {
            if (this.commandHandler.processCommand(message)) {
                this.refs.input.value = '';
                const normalized = message.replace(/^\/+/, '').trim();
                const commandName = normalized.split(/\s+/)[0]?.toLowerCase();
                const command = this.commandHandler.commands?.[commandName];
                if (!shouldKeepChatOpenForCommand(command)) {
                    this.collapseChat();
                }
                return;
            }
        }
        this.socket.emit(SOCKET_EVENTS.CHAT_MESSAGE, { message, timestamp: Date.now() });
        this.refs.input.value = '';
    }

    addMessage(data) {
        const messages = [...this.state.messages, data];
        if (messages.length > this.maxMessages) {
            const evicted = messages.shift();
            // Release any live DOM node held for an evicted HTML message.
            if (evicted?._htmlId != null) this._htmlNodes.delete(evicted._htmlId);
        }

        const updates = { messages };
        if (!this.state.isExpanded) updates.unreadCount = this.state.unreadCount + 1;
        if (!data.isCommandMessage) updates.latestMessage = data.message;

        this.setState(updates);
        this.saveChatHistory();
        if (this.state.isExpanded) this.timeout(() => this.scrollToBottom(), 10);
    }

    addNotification(data) {
        this.addMessage({ ...data, isNotification: true, timestamp: Date.now() });
    }

    displayLocalSystemMessage(message, isHtml = false, persist = false, icon = null) {
        const options = this.normalizeMessageOptions(isHtml, persist, icon);

        const msg = {
            isLocalSystem: true,
            isHtml: options.isHtml,
            icon: options.icon,
            timestamp: Date.now()
        };

        if (options.isHtml && message instanceof HTMLElement) {
            // Store the live DOM node in a side-channel Map; put only a stable numeric
            // ID in state so JSON.stringify and morphDOM never touch the real node.
            const htmlId = ++this._htmlIdCounter;
            this._htmlNodes.set(htmlId, message);
            msg._htmlId = htmlId;
            msg.message = null; // never serialized as a DOM node
        } else {
            msg.message = message;
        }

        const messages = [...this.state.messages, msg];
        this.setState({ messages });

        // Auto-remove plain (non-html, non-persist) messages after 2 s.
        // HTML result messages are intentionally kept until the user dismisses them.
        if (!options.persist && !options.isHtml) {
            this.timeout(() => {
                this.setState({ messages: this.state.messages.filter(m => m !== msg) });
            }, 2000);
        }
        if (this.state.isExpanded) this.timeout(() => this.scrollToBottom(), 10);
    }

    scrollToBottom() {
        if (this.refs.messagesList) {
            this.refs.messagesList.scrollTop = this.refs.messagesList.scrollHeight;
        }
    }

    loadChatHistory() {
        try {
            const saved = sessionStorage.getItem(STORAGE_KEY);
            if (saved) {
                const messages = JSON.parse(saved);
                if (Array.isArray(messages)) {
                    this.setState({ messages });
                    if (messages.length > 0) this.setState({ latestMessage: messages[messages.length - 1].message });
                }
            }
        } catch (e) {
            sessionStorage.removeItem(STORAGE_KEY);
        }
    }

    saveChatHistory() {
        // Exclude HTML messages — they hold live DOM references that can't survive
        // JSON serialization or a page reload, so there's nothing useful to persist.
        const serializable = this.state.messages.filter(m => !m.isHtml);
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
    }
}

class ChatLifecycleModule extends Module {
    constructor(socket) {
        super({ initialized: false });
        this.socket = socket;
        this.chatInstance = null;
    }

    onStart() {
        this.chatInstance = new ChatComponent(this.socket);
        this.adoptComponent(this.chatInstance, {
            startMethod: 'start',
            stopMethod: 'stop',
            sync: (component, state) => component.syncFromModule(state)
        });

        this.setState({ initialized: true });

        this.onSocket(this.socket, SOCKET_EVENTS.CHAT_MESSAGE, (data) => this.chatInstance?.addMessage(data));
        this.onSocket(this.socket, SOCKET_EVENTS.CHAT_NOTIFICATION, (data) => this.chatInstance?.addNotification(data));
        this.onSocket(this.socket, SOCKET_EVENTS.COMMAND, (data) => {
            if (data?.cmd === 'myview' && data.from && data.arg) {
                this.chatInstance?.addMessage({ ...data, isCommandMessage: true, timestamp: Date.now() });
            }
        });
        this.onSocket(this.socket, SOCKET_EVENTS.VIEW_INFO_RESPONSE, (data) => {
            if (!this.chatInstance) return;
            if (data?.error) {
                this.chatInstance.displayLocalSystemMessage(`View Error: ${data.error}`);
                return;
            }
            if (data?.category_id && data.mediaId) {
                navigateToState(data.category_id, data.mediaId, 'ViewCommand', data);
            }
        });

    }

    onStop() {
        this.chatInstance = null;
    }
}

let chatLifecycle = null;

export function initChat(socket) {
    if (chatLifecycle) {
        if (chatLifecycle.socket !== socket) {
            chatLifecycle.stop();
            chatLifecycle = null;
        } else {
            return chatLifecycle;
        }
    }
    chatLifecycle = new ChatLifecycleModule(socket).start();
    return chatLifecycle;
}

function getChatInstance() {
    return chatLifecycle?.chatInstance || null;
}

export function getRegistryServices() {
    const commandHandler = {
        processCommand: (message) => getChatInstance()?.commandHandler?.processCommand?.(message) ?? false
    };
    Object.defineProperty(commandHandler, 'commands', {
        enumerable: true,
        configurable: true,
        get() {
            return getChatInstance()?.commandHandler?.commands || {};
        }
    });

    const commandPopup = {
        showCommandPopup: () => getChatInstance()?.commandPopupManager?.showCommandPopup?.(),
        hideCommandPopup: () => getChatInstance()?.commandPopupManager?.hideCommandPopup?.(),
        isPopupVisible: () => getChatInstance()?.commandPopupManager?.isPopupVisible?.() ?? false
    };
    Object.defineProperty(commandPopup, 'input', {
        enumerable: true,
        configurable: true,
        get() {
            return getChatInstance()?.refs?.input || null;
        },
        set(el) {
            const popupManager = getChatInstance()?.commandPopupManager;
            if (popupManager) {
                popupManager.input = el;
            }
        }
    });
    return { commandHandler, commandPopup };
}

export function expandChat() { if (chatLifecycle?.chatInstance) chatLifecycle.chatInstance.expandChat(); }
export function collapseChat() { if (chatLifecycle?.chatInstance) chatLifecycle.chatInstance.collapseChat(); }
export function toggleChat() { if (chatLifecycle?.chatInstance) chatLifecycle.chatInstance.toggleChat(); }
export function displayLocalSystemMessage(m, h, p) { if (chatLifecycle?.chatInstance) chatLifecycle.chatInstance.displayLocalSystemMessage(m, h, p); }
export function displayClickableCommandMessage(d) { if (chatLifecycle?.chatInstance) chatLifecycle.chatInstance.addMessage({ ...d, isCommandMessage: true, timestamp: Date.now() }); }

export function cleanupChat() {
    if (!chatLifecycle) return;
    chatLifecycle.stop();
    chatLifecycle = null;
}
