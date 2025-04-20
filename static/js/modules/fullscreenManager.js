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
            .catch(err => {
                console.error(`Error attempting to enable fullscreen: ${err.message}`);
            });
    } else {
        // Exit fullscreen
        document[fullscreenAPI.exitFullscreen]();
    }
}

// Add fullscreen button to video
function addFullscreenButton(mediaElement) {
    // Only add fullscreen button to video elements
    if (mediaElement.tagName !== 'VIDEO') {
        return;
    }
    
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
    
    // Add click event listener
    fullscreenBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
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
    });
}

export {
    toggleFullscreen,
    addFullscreenButton,
    setupFullscreenChangeListener
};
