/**
 * Fullscreen Manager Module
 * Handles fullscreen functionality for videos across different browsers
 */

// Detect iOS device
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

// Cross-browser fullscreen API methods
function getFullscreenAPI(element) {
    // Return the appropriate fullscreen API methods based on browser support
    const apis = {
        requestFullscreen: element.requestFullscreen || 
                          element.webkitRequestFullscreen || 
                          element.mozRequestFullScreen || 
                          element.msRequestFullscreen,
        exitFullscreen: document.exitFullscreen || 
                       document.webkitExitFullscreen || 
                       document.mozCancelFullScreen || 
                       document.msExitFullscreen,
        fullscreenElement: document.fullscreenElement || 
                          document.webkitFullscreenElement || 
                          document.mozFullScreenElement || 
                          document.msFullscreenElement,
        fullscreenEnabled: document.fullscreenEnabled || 
                          document.webkitFullscreenEnabled || 
                          document.mozFullScreenEnabled || 
                          document.msFullscreenEnabled,
        fullscreenchange: 'fullscreenchange',
        fullscreenerror: 'fullscreenerror'
    };

    // Set the correct event names based on browser
    if (element.webkitRequestFullscreen) {
        apis.fullscreenchange = 'webkitfullscreenchange';
        apis.fullscreenerror = 'webkitfullscreenerror';
    } else if (element.mozRequestFullScreen) {
        apis.fullscreenchange = 'mozfullscreenchange';
        apis.fullscreenerror = 'mozfullscreenerror';
    } else if (element.msRequestFullscreen) {
        apis.fullscreenchange = 'MSFullscreenChange';
        apis.fullscreenerror = 'MSFullscreenError';
    }

    return apis;
}

// Toggle fullscreen for a video element
function toggleFullscreen(videoElement) {
    // Get chat container reference
    const chatContainer = document.getElementById('chat-container');
    
    // Special handling for iOS
    if (isIOS) {
        // For iOS, we need to use the webkitEnterFullscreen API
        if (videoElement.webkitSupportsFullscreen) {
            if (!videoElement.webkitDisplayingFullscreen) {
                // Temporarily remove playsinline attribute for iOS fullscreen
                videoElement.removeAttribute('playsinline');
                videoElement.removeAttribute('webkit-playsinline');
                
                // Request fullscreen
                videoElement.webkitEnterFullscreen();
                
                // Play the video (iOS requires playback to be initiated by user action)
                videoElement.play().catch(e => console.error("iOS play failed:", e));
            } else {
                // Exit fullscreen
                videoElement.webkitExitFullscreen();
                
                // Restore playsinline attribute
                videoElement.setAttribute('playsinline', 'true');
                videoElement.setAttribute('webkit-playsinline', 'true');
            }
        } else {
            console.warn("iOS fullscreen not supported for this video");
            
            // Fallback: try standard fullscreen API
            tryStandardFullscreen(videoElement);
        }
    } else {
        // Standard fullscreen for non-iOS devices
        tryStandardFullscreen(videoElement);
    }
}

// Try standard fullscreen API
function tryStandardFullscreen(videoElement) {
    const fullscreenAPI = getFullscreenAPI(videoElement);
    
    if (!document[fullscreenAPI.fullscreenElement]) {
        // Enter fullscreen
        videoElement[fullscreenAPI.requestFullscreen]()
            .then(() => {
                // Ensure chat container remains visible in fullscreen
                ensureChatVisibilityInFullscreen();
            })
            .catch(err => {
                console.error(`Error attempting to enable fullscreen: ${err.message}`);
            });
    } else {
        // Exit fullscreen
        document[fullscreenAPI.exitFullscreen]();
    }
}

// Ensure chat container remains visible in fullscreen
function ensureChatVisibilityInFullscreen() {
    // Get chat container reference
    const chatContainer = document.getElementById('chat-container');
    if (!chatContainer) return;
    
    // Add a class to indicate fullscreen mode
    document.documentElement.classList.add('is-fullscreen');
    
    // Make sure chat is visible above fullscreen content
    chatContainer.style.zIndex = '9999';
}

// Add fullscreen button to video
function addFullscreenButton(mediaElement) {
    // Only add fullscreen button to video elements
    if (mediaElement.tagName !== 'VIDEO') {
        return;
    }
    
    // If the video is not in the DOM yet, wait for it to be added
    if (!mediaElement.parentElement) {
        console.log('Video element has no parent yet, waiting for it to be added to DOM');
        // Use a MutationObserver to detect when the video is added to the DOM
        const observer = new MutationObserver((mutations, obs) => {
            if (document.body.contains(mediaElement)) {
                console.log('Video element now in DOM, adding fullscreen button');
                obs.disconnect(); // Stop observing once found
                // Add the button now that the element is in the DOM
                addFullscreenButtonToElement(mediaElement);
            }
        });
        
        // Start observing the document body for changes
        observer.observe(document.body, { childList: true, subtree: true });
        
        // Set a timeout to stop the observer after a reasonable time
        setTimeout(() => {
            observer.disconnect();
        }, 5000);
        
        return;
    }
    
    // If the video is already in the DOM, add the button immediately
    addFullscreenButtonToElement(mediaElement);
}

// Helper function to actually add the fullscreen button to a video element
function addFullscreenButtonToElement(mediaElement) {
    // Remove any existing fullscreen buttons in the container
    if (mediaElement.parentElement) {
        const existingButtons = mediaElement.parentElement.querySelectorAll('.fullscreen-btn');
        existingButtons.forEach(btn => btn.remove());
    }
    
    // Create fullscreen button
    const fullscreenBtn = document.createElement('button');
    fullscreenBtn.className = 'fullscreen-btn';
    fullscreenBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
        </svg>
    `;
    
    // Add click event listener with debounce to prevent rapid clicks
    let lastClickTime = 0;
    fullscreenBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Debounce to prevent rapid clicks
        const now = Date.now();
        if (now - lastClickTime < 500) { // 500ms debounce
            console.log('Ignoring rapid fullscreen click');
            return;
        }
        lastClickTime = now;
        
        // Check if it's safe to toggle fullscreen
        if (!isSafeToToggleFullscreen()) {
            console.log('Not safe to toggle fullscreen right now');
            return;
        }
        
        // For iOS, we need to ensure the video is ready to play
        if (isIOS && mediaElement.paused) {
            // iOS requires playback to be initiated by user action
            mediaElement.play().then(() => {
                toggleFullscreen(mediaElement);
            }).catch(e => {
                console.error("iOS play failed:", e);
                // Try fullscreen anyway
                toggleFullscreen(mediaElement);
            });
        } else {
            toggleFullscreen(mediaElement);
        }
    });
    
    // Store a reference to the video element on the button
    fullscreenBtn.videoElement = mediaElement;
    
    // Add button to video container
    if (mediaElement.parentElement) {
        mediaElement.parentElement.appendChild(fullscreenBtn);
    }
}

// Handle fullscreen change events
function setupFullscreenChangeListener() {
    const fullscreenAPI = getFullscreenAPI(document.documentElement);
    
    document.addEventListener(fullscreenAPI.fullscreenchange, () => {
        const isFullscreen = !!document[fullscreenAPI.fullscreenElement];
        console.log(`Fullscreen state changed: ${isFullscreen ? 'entered' : 'exited'}`);
        
        // Update UI based on fullscreen state if needed
        const fullscreenBtns = document.querySelectorAll('.fullscreen-btn');
        fullscreenBtns.forEach(btn => {
            btn.classList.toggle('active', isFullscreen);
        });
        
        // Update chat container visibility
        if (isFullscreen) {
            ensureChatVisibilityInFullscreen();
        } else {
            // Reset when exiting fullscreen
            document.documentElement.classList.remove('is-fullscreen');
            
            // Get chat container reference
            const chatContainer = document.getElementById('chat-container');
            if (chatContainer) {
                // Reset any fullscreen-specific styles
                chatContainer.style.zIndex = ''; // Reset to CSS default
                
                // Add a small delay to ensure fullscreen is fully exited before allowing chat interactions
                setTimeout(() => {
                    // Set a flag to indicate fullscreen has been properly exited
                    window.fullscreenExited = true;
                    
                    // Clear the flag after a short period to allow normal operation
                    setTimeout(() => {
                        window.fullscreenExited = false;
                    }, 1000);
                }, 100);
            }
        }
    });
}

// Add a function to check if we're in a safe state to toggle fullscreen
function isSafeToToggleFullscreen() {
    // If we've just exited fullscreen, prevent immediate re-entry
    if (window.fullscreenExited) {
        console.log('Preventing immediate fullscreen re-entry after exit');
        return false;
    }
    
    // Check if we're currently in the middle of a rapid navigation
    if (window.appInstance && window.appInstance.state) {
        const now = Date.now();
        const lastNavTime = window.appInstance.state.lastNavigationTime || 0;
        
        // If we've navigated within the last 300ms, consider it unsafe
        if (now - lastNavTime < 300) {
            console.log('Preventing fullscreen during rapid navigation');
            return false;
        }
    }
    
    // Check if the document is in a state where fullscreen is allowed
    const fullscreenAPI = getFullscreenAPI(document.documentElement);
    if (!document[fullscreenAPI.fullscreenEnabled]) {
        console.log('Fullscreen not enabled in document');
        return false;
    }
    
    return true;
}

// Function to ensure fullscreen buttons are added to all active videos
// This can be called periodically to ensure buttons are present
function ensureFullscreenButtons() {
    const activeVideos = document.querySelectorAll('video.active');
    activeVideos.forEach(video => {
        // Check if this video already has a fullscreen button
        const hasButton = video.parentElement && 
                          video.parentElement.querySelector('.fullscreen-btn');
        
        if (!hasButton) {
            console.log('Adding missing fullscreen button to active video');
            addFullscreenButton(video);
        }
    });
}

export {
    toggleFullscreen,
    addFullscreenButton,
    setupFullscreenChangeListener,
    isSafeToToggleFullscreen,
    ensureFullscreenButtons
};
