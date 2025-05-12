/**
 * Command Popup Module
 * Handles the popup UI for slash commands
 */

import { MOBILE_DEVICE } from '../core/app.js';

// Popup state
let commandPopup = null;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };

// References to input elements
let chatInput = null;

// Global touch state for command list items (moved here for broader access)
const listItemTouchState = {
  isTouching: false,
  tapThreshold: 10 // Small threshold to differentiate tap from scroll
};

/**
 * Initialize the command popup module
 * @param {HTMLElement} inputElement - The chat input element
 */
export function initCommandPopup(inputElement) {
  chatInput = inputElement;
  
  // Set up event listeners
  setupEventListeners();
  
  // Expose the command popup module globally
  if (!window.appModules) {
    window.appModules = {};
  }
  
  // Create the module interface object
  const commandPopupModule = {
    showCommandPopup,
    hideCommandPopup,
    isPopupVisible: () => !!commandPopup
  };
  
  // Expose the module
  window.appModules.commandPopup = commandPopupModule;
  
  // Return the module interface
  return commandPopupModule;
}

/**
 * Set up event listeners for command popup
 */
function setupEventListeners() {
  // Input event listener to monitor value changes
  chatInput.addEventListener('input', (e) => {
    const inputValue = chatInput.value;
    // If popup is open but input doesn't start with slash, close it
    if (commandPopup && !inputValue.startsWith('/')) {
      hideCommandPopup();
    } else if (commandPopup && inputValue.startsWith('/')) {
      // Filter commands based on input
      const filterText = inputValue.substring(1); // Get text after '/'
      filterAndDisplayCommands(filterText);
    }

    // Check for double-slash issue and fix it
    if (inputValue.includes('//')) {
      chatInput.value = inputValue.replace('//', '/');
    }
  });

  // Keydown event for command popup handling
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === '/' && chatInput.value === '' && !commandPopup) {
      e.preventDefault(); // Prevent the slash from being typed
      showCommandPopup();
      chatInput.value = '/'; // Add slash back after preventing default
    } else if (e.key === 'Escape' && commandPopup) {
      e.preventDefault();
      hideCommandPopup();
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && commandPopup && chatInput.value === '/') {
      // Close the popup when removing the slash
      hideCommandPopup();
    } else if (commandPopup && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      // Handle keyboard navigation in popup
      e.preventDefault();
      const items = commandPopup.querySelectorAll('.command-popup-list > div');
      if (items.length === 0) return;
      
      // Find currently highlighted item
      let currentIndex = -1;
      for (let i = 0; i < items.length; i++) {
        if (items[i].style.background === 'rgb(68, 68, 68)') {
          currentIndex = i;
          break;
        }
      }
      
      // Calculate new index
      let newIndex;
      if (e.key === 'ArrowDown') {
        newIndex = currentIndex === -1 || currentIndex === items.length - 1 ? 0 : currentIndex + 1;
      } else {
        newIndex = currentIndex === -1 || currentIndex === 0 ? items.length - 1 : currentIndex - 1;
      }
      
      // Update highlighting
      for (let i = 0; i < items.length; i++) {
        items[i].style.background = i === newIndex ? '#444' : 'transparent';
      }
      
      // Ensure the item is visible by scrolling to it
      items[newIndex].scrollIntoView({ block: 'nearest' });
    } else if (commandPopup && e.key === 'Enter') {
      // Select highlighted item
      const highlightedItem = commandPopup.querySelector('.command-popup-list > div[style*="background: rgb(68, 68, 68)"]');
      if (highlightedItem) {
        highlightedItem.click();
      }
    }
  });

  // Focus handler
  chatInput.addEventListener('focus', () => {
    if (chatInput.value === '/') {
      showCommandPopup();
    }
  });
}

/**
 * Create and show the command popup
 */
export function showCommandPopup() {
  // Remove existing popup if any
  if (commandPopup) {
    commandPopup.remove();
  }

  // Disable media navigation while popup is open
  if (window.appInstance) {
    window.appInstance.state.navigationDisabled = true;
  }

  // Create popup container
  commandPopup = document.createElement('div');
  commandPopup.className = 'command-popup';
  commandPopup.style.cssText = `
    position: fixed;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 8px;
    padding: 10px;
    width: 90%;
    max-width: 300px;
    z-index: 1000;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    font-size: 14px;
    transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    opacity: 0;
    user-select: none;
    transform: translateY(10px);
    bottom: 60px;
    left: 10px;
    will-change: transform, opacity;
  `;

  // Create header with drag handle
  const header = document.createElement('div');
  header.className = 'command-popup-header';
  header.style.cssText = `
    font-weight: bold;
    color: #ccc;
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid #444;
    cursor: move;
    display: flex;
    justify-content: space-between;
    align-items: center;
  `;
  
  const title = document.createElement('span');
  title.textContent = 'Available Commands';
  header.appendChild(title);
  
  // Add close button
  const closeBtn = document.createElement('span');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `
    cursor: pointer;
    padding: 0 4px;
    color: #888;
    font-size: 16px;
  `;
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideCommandPopup();
  });
  header.appendChild(closeBtn);
  
  // Add drag functionality to header
  header.addEventListener('mousedown', startDrag);
  header.addEventListener('touchstart', startDragTouch, { passive: false });
  
  commandPopup.appendChild(header);

  // Create command list (structure only, content filled by filterAndDisplayCommands)
  const commandList = document.createElement('div');
  commandList.className = 'command-popup-list';
  commandList.style.cssText = `
    max-height: ${MOBILE_DEVICE ? '180px' : '220px'};
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding-right: 5px;
    overscroll-behavior: contain;
  `;
  commandPopup.appendChild(commandList); // Append the empty list container

  // Initial population of commands
  filterAndDisplayCommands(''); // Show all commands initially

  // Add click outside listener to close popup
  const closePopupHandler = function(e) {
    if (!commandPopup || (!commandPopup.contains(e.target) && e.target !== chatInput)) {
      hideCommandPopup();
      document.removeEventListener('click', closePopupHandler);
    }
  };
  
  // Global event listeners for drag
  document.addEventListener('mousemove', drag);
  document.addEventListener('mouseup', stopDrag);
  document.addEventListener('touchmove', dragTouch, { passive: false });
  document.addEventListener('touchend', stopDragTouch);
  
  // Slight delay before adding click handler to avoid immediate closing
  setTimeout(() => {
    document.addEventListener('click', closePopupHandler);
  }, 100);

  document.body.appendChild(commandPopup);
  
  // Animate in
  setTimeout(() => {
    commandPopup.style.opacity = '1';
    commandPopup.style.transform = 'translateY(0)';
  }, 10);
}

/**
 * Hide and remove the command popup
 */
export function hideCommandPopup() {
  if (!commandPopup) return;
  
  // Re-enable media navigation when popup is closed
  if (window.appInstance) {
    window.appInstance.state.navigationDisabled = false;
  }
  
  // Remove event listeners
  document.removeEventListener('mousemove', drag);
  document.removeEventListener('mouseup', stopDrag);
  document.removeEventListener('touchmove', dragTouch, { passive: false });
  document.removeEventListener('touchend', stopDragTouch);
  
  // Animate out with GPU acceleration
  commandPopup.style.opacity = '0';
  commandPopup.style.transform = 'translateY(10px) translateZ(0)';
  setTimeout(() => {
    if (commandPopup) {
      commandPopup.remove();
      commandPopup = null;
    }
  }, 200);
}

/**
 * Start dragging (mouse event)
 * @param {MouseEvent} e - The mouse event
 */
function startDrag(e) {
  if (e.target.closest('.command-popup-header') && !e.target.closest('.command-popup-header > span:last-child')) {
    isDragging = true;
    
    const rect = commandPopup.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;
    
    // Add dragging class
    commandPopup.classList.add('dragging');
    
    e.preventDefault();
    e.stopPropagation();
  }
}

/**
 * Start dragging (touch event)
 * @param {TouchEvent} e - The touch event
 */
function startDragTouch(e) {
  if (e.target.closest('.command-popup-header') && !e.target.closest('.command-popup-header > span:last-child')) {
    isDragging = true;
    
    const rect = commandPopup.getBoundingClientRect();
    dragOffset.x = e.touches[0].clientX - rect.left;
    dragOffset.y = e.touches[0].clientY - rect.top;
    
    // Add dragging class
    commandPopup.classList.add('dragging');
    
    e.preventDefault();
    e.stopPropagation();
  }
}

/**
 * Drag the popup (mouse event)
 * @param {MouseEvent} e - The mouse event
 */
function drag(e) {
  if (!isDragging || !commandPopup) return;
  
  // Use requestAnimationFrame for smoother animation
  requestAnimationFrame(() => {
    // Remove transform for precise positioning
    if (commandPopup.style.transform) {
      commandPopup.style.transform = 'translateZ(0)'; // Keep GPU acceleration
    }
    
    // Calculate new position
    const x = e.clientX - dragOffset.x;
    const y = e.clientY - dragOffset.y;
    
    // Apply new position
    updatePosition(x, y);
  });
  
  e.preventDefault();
  e.stopPropagation();
}

/**
 * Drag the popup (touch event)
 * @param {TouchEvent} e - The touch event
 */
function dragTouch(e) {
  if (!isDragging || !commandPopup) return;
  
  // Use requestAnimationFrame for smoother animation
  requestAnimationFrame(() => {
    // Remove transform for precise positioning
    if (commandPopup.style.transform) {
      commandPopup.style.transform = 'translateZ(0)'; // Keep GPU acceleration
    }
    
    // Calculate new position
    const x = e.touches[0].clientX - dragOffset.x;
    const y = e.touches[0].clientY - dragOffset.y;
    
    // Apply new position
    updatePosition(x, y);
  });
  
  e.preventDefault();
  e.stopPropagation();
}

/**
 * Update the position of the popup
 * @param {number} x - The x position
 * @param {number} y - The y position
 */
function updatePosition(x, y) {
  // Get viewport dimensions
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  
  // Get popup dimensions
  const popupWidth = commandPopup.offsetWidth;
  const popupHeight = commandPopup.offsetHeight;
  
  // Constrain position to viewport
  const constrainedX = Math.max(0, Math.min(x, viewportWidth - popupWidth));
  const constrainedY = Math.max(0, Math.min(y, viewportHeight - popupHeight));
  
  // Apply position - use fixed positioning with transform for GPU acceleration
  commandPopup.style.position = 'fixed';
  commandPopup.style.left = `${constrainedX}px`;
  commandPopup.style.top = `${constrainedY}px`;
  // Clear bottom position when dragging
  commandPopup.style.bottom = 'auto';
  commandPopup.style.transform = 'translateZ(0)';
}

/**
 * Stop dragging (mouse event)
 */
function stopDrag() {
  if (isDragging) {
    isDragging = false;
    
    // Remove active class
    if (commandPopup) {
      commandPopup.classList.remove('dragging');
    }
  }
}

/**
 * Stop dragging (touch event)
 */
function stopDragTouch() {
  if (isDragging) {
    isDragging = false;
    
    // Remove active class
    if (commandPopup) {
      commandPopup.classList.remove('dragging');
    }
  }
}

/**
 * Filter and display commands in the popup
 * @param {string} filterText - The text to filter commands by
 */
function filterAndDisplayCommands(filterText = '') {
  if (!commandPopup) return;

  const commandList = commandPopup.querySelector('.command-popup-list');
  if (!commandList) return;

  // Clear existing items
  commandList.innerHTML = '';

  const allCommands = Object.entries(window.appModules.commandHandler.commands);
  
  const filteredCommands = allCommands.filter(([name, cmd]) => 
    name.toLowerCase().startsWith(filterText.toLowerCase())
  );

  // Sort commands: exact matches first, then by length, then alphabetically
  filteredCommands.sort(([nameA], [nameB]) => {
    const lowerFilterText = filterText.toLowerCase();
    const lowerNameA = nameA.toLowerCase();
    const lowerNameB = nameB.toLowerCase();

    const isExactA = lowerNameA === lowerFilterText;
    const isExactB = lowerNameB === lowerFilterText;

    if (isExactA && !isExactB) return -1;
    if (!isExactA && isExactB) return 1;
    
    // If both or neither are exact, sort by how much of the command matches the start
    const startsWithA = lowerNameA.startsWith(lowerFilterText);
    const startsWithB = lowerNameB.startsWith(lowerFilterText);

    if (startsWithA && !startsWithB) return -1;
    if (!startsWithA && startsWithB) return 1;

    // If both start with the filter, prioritize shorter command names (closer match)
    if (lowerNameA.length !== lowerNameB.length) {
      return lowerNameA.length - lowerNameB.length;
    }
    
    // Finally, alphabetical order
    return lowerNameA.localeCompare(lowerNameB);
  });
  
  if (filteredCommands.length === 0) {
    const noResultsItem = document.createElement('div');
    noResultsItem.style.cssText = `
      padding: 8px;
      color: #aaa;
      text-align: center;
      font-style: italic;
    `;
    noResultsItem.textContent = 'No commands match';
    commandList.appendChild(noResultsItem);
    return;
  }

  filteredCommands.forEach(([name, cmd]) => {
    const cmdItem = document.createElement('div');
    cmdItem.style.cssText = `
      padding: 8px;
      cursor: pointer;
      border-radius: 4px;
      margin: 2px 0;
      display: flex;
      flex-direction: column;
      transition: background-color 0.1s ease;
      will-change: background-color;
    `;
    
    const cmdName = document.createElement('div');
    cmdName.style.cssText = `
      font-weight: bold;
      color: #fff;
      margin-bottom: 3px;
    `;
    cmdName.textContent = `/${name}`;
    
    const cmdDesc = document.createElement('div');
    cmdDesc.style.cssText = `
      font-size: 12px;
      color: #aaa;
    `;
    const helpText = cmd.getHelpText();
    const descriptionPart = helpText.includes(' - ') ? helpText.split(' - ')[1] : helpText;
    cmdDesc.textContent = descriptionPart;
    
    cmdItem.appendChild(cmdName);
    cmdItem.appendChild(cmdDesc);
    
    cmdItem.addEventListener('mouseover', () => {
      cmdItem.style.background = '#444';
      cmdItem.style.transform = 'translateZ(0)';
    });
    
    cmdItem.addEventListener('mouseout', () => {
      cmdItem.style.background = 'transparent';
      cmdItem.style.transform = '';
    });
    
    let touchStartY = 0;
    let touchStartTime = 0;
    let hasMoved = false;
    
    cmdItem.addEventListener('touchstart', (e) => {
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      hasMoved = false;
      listItemTouchState.isTouching = true; // Use global state
    }, { passive: true });
    
    cmdItem.addEventListener('touchmove', (e) => {
      const delta = Math.abs(e.touches[0].clientY - touchStartY);
      if (delta > listItemTouchState.tapThreshold) { // Use global threshold
        hasMoved = true;
      }
    }, { passive: true });
    
    cmdItem.addEventListener('touchend', (e) => {
      const touchDuration = Date.now() - touchStartTime;
      listItemTouchState.isTouching = false; // Reset global state
      
      if (!hasMoved && touchDuration < 300) {
        e.preventDefault();
        selectCommand(name, helpText);
      }
    });
    
    cmdItem.addEventListener('click', (e) => {
      if (!listItemTouchState.isTouching) { // Check global state
        selectCommand(name, helpText);
        e.preventDefault();
        e.stopPropagation();
      }
    });
    
    commandList.appendChild(cmdItem);
  });

  // Highlight the first item automatically if there are results
  const items = commandList.querySelectorAll('.command-popup-list > div');
  if (items.length > 0 && !items[0].textContent.includes('No commands match')) {
    items[0].style.background = '#444';
    items[0].scrollIntoView({ block: 'nearest' });
  }
}

/**
 * Select a command and update the input
 * @param {string} name - Command name
 * @param {string} helpText - Command help text
 */
function selectCommand(name, helpText) {
  // Make sure chat is expanded first
  const chatContainer = document.getElementById('chat-container');
  const isChatCollapsed = chatContainer && chatContainer.classList.contains('collapsed');
  
  if (isChatCollapsed) {
    // Expand chat first
    if (window.appModules && window.appModules.chatManager && typeof window.appModules.chatManager.expandChat === 'function') {
      window.appModules.chatManager.expandChat();
    } else {
      // Fallback method
      chatContainer.classList.remove('collapsed');
      chatContainer.classList.add('expanded');
    }
  }
  
  // Determine if the command takes arguments
  const cmdHasArgs = helpText.includes('{') || helpText.includes('[') || 
                     helpText.toLowerCase().includes('optional') || 
                     helpText.includes('<');
  
  if (cmdHasArgs) {
    // Command has arguments: populate input with space and focus for user to type args.
    chatInput.value = `/${name} `;
    setTimeout(() => {
      chatInput.focus();
    }, 50);
  } else {
    // Command does not have arguments: set input value and attempt to process immediately.
    chatInput.value = `/${name}`;
    let processed = false;
    if (window.appModules && 
        window.appModules.commandHandler && 
        typeof window.appModules.commandHandler.processCommand === 'function') {
      try {
        // processCommand is expected to handle UI like clearing input or showing errors.
        processed = window.appModules.commandHandler.processCommand(chatInput.value);
      } catch (err) {
        console.error(`Error auto-processing command /${name}:`, err);
        processed = false; // Ensure it's false if processCommand throws
      }
    }

    if (processed) {
      // If command was successfully processed, commandHandler should have handled input clearing or focus.
      // As a best practice for sendMessage in chatManager, we clear chatInput if command is handled.
      chatInput.value = ''; 
    } else {
      // Command processing failed, or handler not available, or command was not fully handled.
      // Leave command in input and focus, so user can manually submit or edit.
      setTimeout(() => {
        chatInput.focus();
      }, 50);
    }
  }
  
  // Close the popup
  hideCommandPopup();
} 