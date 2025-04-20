/**
 * Chat Manager Module
 * Handles chat functionality using WebSockets with sessionStorage persistence
 */

import { app, MOBILE_DEVICE } from '../core/app.js';

// Session storage keys
const STORAGE_KEY = 'ghosthub_chat_messages';
const STORAGE_TIMESTAMP_KEY = 'ghosthub_chat_timestamp';

// Chat state
const chatState = {
    isExpanded: false,
    messages: [],
    maxMessages: 50, // Maximum number of messages to keep in memory
    unreadCount: 0,
    isJoined: false
};

// DOM elements (will be initialized later)
let chatContainer = null;
let chatMessages = null;
let chatInput = null;
let chatToggle = null;
let chatForm = null;
let latestMessage = null;

// Socket reference (will use the existing socket connection)
let socket = null;

/**
 * Initialize the chat module
 * @param {Object} socketInstance - The existing socket.io instance
 */
function initChat(socketInstance) {
    if (!socketInstance) {
        console.error('Chat initialization failed: No socket instance provided');
        return;
    }
    
    socket = socketInstance;
    
    // Initialize DOM references - use existing elements from index.html
    chatContainer = document.getElementById('chat-container');
    chatMessages = document.getElementById('chat-messages');
    chatInput = document.getElementById('chat-input');
    chatToggle = document.getElementById('chat-toggle');
    chatForm = document.getElementById('chat-form');
    latestMessage = document.getElementById('latest-message');
    
    // Check if all elements exist
    if (!chatContainer || !chatMessages || !chatInput || !chatToggle || !chatForm || !latestMessage) {
        console.error('Chat initialization failed: Missing UI elements');
        console.log('Missing elements:', {
            chatContainer: !!chatContainer,
            chatMessages: !!chatMessages,
            chatInput: !!chatInput,
            chatToggle: !!chatToggle,
            chatForm: !!chatForm,
            latestMessage: !!latestMessage
        });
        return;
    }
    
    console.log('Chat UI elements found successfully');
    
    // Set up event listeners
    setupEventListeners();
    
    // Set up socket event handlers
    setupSocketHandlers();
    
    // Load chat history from localStorage
    loadChatHistory();

    // Remove the beforeunload handler as sessionStorage handles clearing automatically
    // setupBeforeUnloadHandler();

    // Join the chat room
    joinChat();
    
    console.log('Chat module initialized with localStorage persistence');
}

/**
 * Set up the beforeunload event handler to clear chat history when tab/window is closed
 */
/* // Remove the beforeunload handler as sessionStorage handles clearing automatically
function setupBeforeUnloadHandler() {
    window.addEventListener('beforeunload', () => {
        // Clear chat history from localStorage when the tab/window is closed
        clearChatHistory();
        console.log('Chat history cleared on page unload');
    });
}
*/

/**
 * Load chat history from sessionStorage
 */
function loadChatHistory() {
    try {
        const savedMessages = sessionStorage.getItem(STORAGE_KEY); // Use sessionStorage
        if (savedMessages) {
            const parsedMessages = JSON.parse(savedMessages);
            
            // Validate the parsed data is an array
            if (Array.isArray(parsedMessages)) {
                // Add each message to the chat
                parsedMessages.forEach(msg => {
                    // Skip adding the message to the messages array since addMessageToDOM will do that
                    addMessageToDOM(msg, false);
                });
                
                // Update chat state
                chatState.messages = parsedMessages;
                
                // Update latest message display if there are messages
                if (parsedMessages.length > 0) {
                    updateLatestMessage(parsedMessages[parsedMessages.length - 1].message);
                }

                console.log(`Loaded ${parsedMessages.length} messages from sessionStorage`); // Log sessionStorage

                // Scroll to bottom if chat is expanded
                if (chatState.isExpanded) {
                    scrollToBottom();
                }
            }
        }
    } catch (error) {
        console.error('Error loading chat history from sessionStorage:', error); // Log sessionStorage
        // If there's an error, clear the sessionStorage to prevent future errors
        clearChatHistory();
    }
}

/**
 * Save chat history to sessionStorage
 */
function saveChatHistory() {
    try {
        // Save messages to sessionStorage
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(chatState.messages)); // Use sessionStorage

        // Save timestamp of when the messages were saved
        sessionStorage.setItem(STORAGE_TIMESTAMP_KEY, Date.now().toString()); // Use sessionStorage
    } catch (error) {
        console.error('Error saving chat history to sessionStorage:', error); // Log sessionStorage
    }
}

/**
 * Clear chat history from sessionStorage
 */
function clearChatHistory() {
    try {
        sessionStorage.removeItem(STORAGE_KEY); // Use sessionStorage
        sessionStorage.removeItem(STORAGE_TIMESTAMP_KEY); // Use sessionStorage
    } catch (error) {
        console.error('Error clearing chat history from sessionStorage:', error); // Log sessionStorage
    }
}

// Function removed as we're using the existing chat UI from index.html

/**
 * Set up event listeners for chat UI elements
 */
function setupEventListeners() {
    // Toggle chat expansion when clicking the toggle button
    chatToggle.addEventListener('click', toggleChat);
    
    // Toggle chat expansion when clicking the header
    document.getElementById('chat-header').addEventListener('click', (e) => {
        // Don't toggle if clicking directly on the toggle button (it has its own handler)
        if (!e.target.closest('#chat-toggle')) {
            toggleChat();
        }
    });
    
    // Submit message on form submit
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        sendMessage();
    });
    
    // Auto-collapse chat when clicking outside
    document.addEventListener('click', (e) => {
        if (chatState.isExpanded && 
            !chatContainer.contains(e.target) && 
            !e.target.closest('#chat-container')) {
            collapseChat();
        }
    });
    
    // Prevent clicks inside chat from propagating to document
    chatContainer.addEventListener('click', (e) => {
        e.stopPropagation();
    });
}

/**
 * Set up socket event handlers for chat
 */
function setupSocketHandlers() {
    // Handle incoming chat messages
    socket.on('chat_message', (data) => {
        addMessage(data);
    });
    
    // Handle chat notifications (join/leave)
    socket.on('chat_notification', (data) => {
        addNotification(data);
    });
}

/**
 * Join the chat room
 */
function joinChat() {
    if (!socket || chatState.isJoined) return;
    
    socket.emit('join_chat');
    chatState.isJoined = true;
    console.log('Joined chat room');
}

/**
 * Leave the chat room
 */
function leaveChat() {
    if (!socket || !chatState.isJoined) return;
    
    socket.emit('leave_chat');
    chatState.isJoined = false;
    console.log('Left chat room');
}

/**
 * Toggle chat expansion state
 */
function toggleChat() {
    if (chatState.isExpanded) {
        collapseChat();
    } else {
        expandChat();
    }
}

/**
 * Expand the chat container
 */
function expandChat() {
    chatContainer.classList.remove('collapsed');
    chatContainer.classList.add('expanded');
    chatState.isExpanded = true;
    chatState.unreadCount = 0;
    
    // Clear unread indicator
    chatToggle.removeAttribute('data-count');
    chatToggle.classList.remove('has-unread');
    
    // Focus the input field
    setTimeout(() => {
        chatInput.focus();
    }, 300);
    
    // Scroll to the bottom of the chat
    scrollToBottom();
}

/**
 * Collapse the chat container
 */
function collapseChat() {
    chatContainer.classList.remove('expanded');
    chatContainer.classList.add('collapsed');
    chatState.isExpanded = false;
}

/**
 * Send a chat message
 */
function sendMessage() {
    const message = chatInput.value.trim();
    
    if (!message) return;
    
    // Emit the message event
    socket.emit('chat_message', {
        message: message,
        timestamp: Date.now()
    });
    
    // Clear the input field
    chatInput.value = '';
    
    // Focus the input field again
    chatInput.focus();
}

/**
 * Add a message to the DOM
 * @param {Object} data - The message data
 * @param {boolean} saveToState - Whether to add the message to the state (default: true)
 */
function addMessageToDOM(data, saveToState = true) {
    // Create message element
    const messageEl = document.createElement('div');
    messageEl.className = 'chat-message';
    
    // Format timestamp if provided
    let timeString = '';
    if (data.timestamp) {
        const date = new Date(data.timestamp);
        timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    // Set message content
    messageEl.innerHTML = `
        <span class="chat-user">${data.user_id || 'Unknown'}</span>
        <span class="chat-text">${escapeHTML(data.message)}</span>
        ${timeString ? `<span class="chat-time">${timeString}</span>` : ''}
    `;
    
    // Add to messages array if saveToState is true
    if (saveToState) {
        chatState.messages.push(data);
        
        // Limit the number of messages in memory
        if (chatState.messages.length > chatState.maxMessages) {
            chatState.messages.shift();
        }
        
        // Save to localStorage
        saveChatHistory();
    }
    
    // Add to DOM
    chatMessages.appendChild(messageEl);
}

/**
 * Add a notification to the DOM
 * @param {Object} data - The notification data
 * @param {boolean} saveToState - Whether to add the notification to the state (default: true)
 */
function addNotificationToDOM(data, saveToState = true) {
    // Create notification element
    const notificationEl = document.createElement('div');
    notificationEl.className = 'chat-notification';
    notificationEl.textContent = data.message;
    
    // Add to DOM
    chatMessages.appendChild(notificationEl);
    
    // Add to messages array if saveToState is true
    if (saveToState) {
        // Add a type field to distinguish notifications from messages
        const notificationData = {
            ...data,
            isNotification: true
        };
        
        chatState.messages.push(notificationData);
        
        // Limit the number of messages in memory
        if (chatState.messages.length > chatState.maxMessages) {
            chatState.messages.shift();
        }
        
        // Save to localStorage
        saveChatHistory();
    }
}

/**
 * Add a message to the chat
 * @param {Object} data - The message data
 */
function addMessage(data) {
    // Add message to DOM
    addMessageToDOM(data);
    
    // Update latest message display
    updateLatestMessage(data.message);
    
    // Increment unread count if chat is collapsed
    if (!chatState.isExpanded) {
        chatState.unreadCount++;
        updateUnreadIndicator();
    }
    
    // Scroll to bottom if chat is expanded
    if (chatState.isExpanded) {
        scrollToBottom();
    }
}

/**
 * Add a notification to the chat
 * @param {Object} data - The notification data
 */
function addNotification(data) {
    // Add notification to DOM
    addNotificationToDOM(data);
    
    // Update latest message display
    updateLatestMessage(data.message);
    
    // Increment unread count if chat is collapsed
    if (!chatState.isExpanded) {
        chatState.unreadCount++;
        updateUnreadIndicator();
    }
    
    // Scroll to bottom if chat is expanded
    if (chatState.isExpanded) {
        scrollToBottom();
    }
}

/**
 * Update the latest message display
 * @param {string} message - The message text
 */
function updateLatestMessage(message) {
    if (latestMessage) {
        latestMessage.textContent = message;
    }
}

/**
 * Update the unread message indicator
 */
function updateUnreadIndicator() {
    if (chatState.unreadCount > 0) {
        chatToggle.setAttribute('data-count', chatState.unreadCount);
        chatToggle.classList.add('has-unread');
    } else {
        chatToggle.removeAttribute('data-count');
        chatToggle.classList.remove('has-unread');
    }
}

/**
 * Scroll the chat messages to the bottom
 */
function scrollToBottom() {
    if (chatMessages) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text - The text to escape
 * @returns {string} - The escaped text
 */
function escapeHTML(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Export functions needed by other modules
export {
    initChat,
    joinChat,
    leaveChat,
    toggleChat
};
