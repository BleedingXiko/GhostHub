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

/**
 * Initialize the command popup module
 * @param {HTMLElement} inputElement - The chat input element
 */
export function initCommandPopup(inputElement) {
  chatInput = inputElement;
  
  // Set up event listeners
  setupEventListeners();
  
  return {
    showCommandPopup,
    hideCommandPopup,
    isPopupVisible: () => !!commandPopup
  };
}

/**
 * Set up event listeners for command popup
 */
function setupEventListeners() {
  // Input event listener to monitor value changes
  chatInput.addEventListener('input', (e) => {
    // If popup is open but input doesn't start with slash, close it
    if (commandPopup && !chatInput.value.startsWith('/')) {
      hideCommandPopup();
    }
    
    // Check for double-slash issue and fix it
    if (chatInput.value.includes('//')) {
      chatInput.value = chatInput.value.replace('//', '/');
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
    transition: opacity 0.2s ease, transform 0.2s ease;
    opacity: 0;
    user-select: none;
    transform: translateY(10px);
    bottom: 60px;
    left: 10px;
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

  // Get all commands and their help text
  const commands = Object.entries(window.appModules.commandHandler.commands);
  
  // Create command list
  const commandList = document.createElement('div');
  commandList.className = 'command-popup-list';
  commandList.style.cssText = `
    max-height: ${MOBILE_DEVICE ? '180px' : '220px'};
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding-right: 5px;
  `;

  commands.forEach(([name, cmd]) => {
    const cmdItem = document.createElement('div');
    cmdItem.style.cssText = `
      padding: 8px;
      cursor: pointer;
      border-radius: 4px;
      margin: 2px 0;
      display: flex;
      flex-direction: column;
      transition: background-color 0.15s ease;
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
    // Extract just the description part from help text
    const helpText = cmd.getHelpText();
    const descriptionPart = helpText.includes(' - ') ? helpText.split(' - ')[1] : helpText;
    cmdDesc.textContent = descriptionPart;
    
    cmdItem.appendChild(cmdName);
    cmdItem.appendChild(cmdDesc);
    
    cmdItem.addEventListener('mouseover', () => {
      cmdItem.style.background = '#444';
    });
    
    cmdItem.addEventListener('mouseout', () => {
      cmdItem.style.background = 'transparent';
    });
    
    // Handle click for both mobile and desktop
    cmdItem.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Ensure we don't add an extra space if the command doesn't take arguments
      const cmdHasArgs = helpText.includes('{') || helpText.includes('[') || 
                       helpText.toLowerCase().includes('optional') || 
                       helpText.includes('<');
      
      // Set input value to just the command name if it doesn't take args, or add a space if it does
      chatInput.value = cmdHasArgs ? `/${name} ` : `/${name}`;
      chatInput.focus();
      hideCommandPopup();
    });
    
    commandList.appendChild(cmdItem);
  });

  commandPopup.appendChild(commandList);

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
  
  // Remove event listeners
  document.removeEventListener('mousemove', drag);
  document.removeEventListener('mouseup', stopDrag);
  document.removeEventListener('touchmove', dragTouch);
  document.removeEventListener('touchend', stopDragTouch);
  
  // Animate out
  commandPopup.style.opacity = '0';
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
  
  // Remove transform for precise positioning
  if (commandPopup.style.transform) {
    commandPopup.style.transform = '';
  }
  
  // Calculate new position
  const x = e.clientX - dragOffset.x;
  const y = e.clientY - dragOffset.y;
  
  // Apply new position
  updatePosition(x, y);
  
  e.preventDefault();
  e.stopPropagation();
}

/**
 * Drag the popup (touch event)
 * @param {TouchEvent} e - The touch event
 */
function dragTouch(e) {
  if (!isDragging || !commandPopup) return;
  
  // Remove transform for precise positioning
  if (commandPopup.style.transform) {
    commandPopup.style.transform = '';
  }
  
  // Calculate new position
  const x = e.touches[0].clientX - dragOffset.x;
  const y = e.touches[0].clientY - dragOffset.y;
  
  // Apply new position
  updatePosition(x, y);
  
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
  
  // Apply position - use fixed positioning
  commandPopup.style.position = 'fixed';
  commandPopup.style.left = `${constrainedX}px`;
  commandPopup.style.top = `${constrainedY}px`;
  // Clear bottom position when dragging
  commandPopup.style.bottom = 'auto';
  commandPopup.style.transform = 'none';
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