/**
 * PWA Installer Module
 * Handles the PWA installation experience
 */

// Store the deferred prompt for later use
let deferredPrompt;
let installButton;

// Initialize the PWA installer when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('Initializing PWA installer...');
    
    // Create an install button and add it to the header
    createInstallButton();
    
    // Register the service worker
    registerServiceWorker();
});

// Create and add the install button to the UI
function createInstallButton() {
    const appHeader = document.querySelector('.app-header');
    if (!appHeader) return;
    
    // Create the install button
    installButton = document.createElement('button');
    installButton.id = 'pwa-install-btn';
    installButton.className = 'pwa-install-btn';
    installButton.textContent = 'Install App';
    installButton.style.display = 'none'; // Hide by default
    
    // Add button styles
    installButton.style.backgroundColor = '#1a1a3a';
    installButton.style.color = 'white';
    installButton.style.border = 'none';
    installButton.style.borderRadius = '4px';
    installButton.style.padding = '8px 12px';
    installButton.style.margin = '0 10px';
    installButton.style.cursor = 'pointer';
    
    // Add the button to the header
    appHeader.appendChild(installButton);
    
    // Add click event listener
    installButton.addEventListener('click', handleInstallClick);
}

// Register the service worker
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/static/sw.js')
            .then(registration => {
                console.log('Service Worker registered with scope:', registration.scope);
            })
            .catch(error => {
                console.error('Service Worker registration failed:', error);
            });
    }
}

// Listen for the beforeinstallprompt event
window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the default browser install prompt
    e.preventDefault();
    
    // Store the event for later use
    deferredPrompt = e;
    
    // Show the install button
    if (installButton) {
        installButton.style.display = 'block';
    }
    
    console.log('App can be installed, showing install button');
});

// Handle the install button click
async function handleInstallClick() {
    if (!deferredPrompt) return;
    
    // Show the install prompt
    deferredPrompt.prompt();
    
    // Wait for the user to respond to the prompt
    const { outcome } = await deferredPrompt.userChoice;
    console.log(`User response to the install prompt: ${outcome}`);
    
    // Clear the deferred prompt variable
    deferredPrompt = null;
    
    // Hide the install button
    if (installButton) {
        installButton.style.display = 'none';
    }
}

// Listen for the appinstalled event
window.addEventListener('appinstalled', (e) => {
    console.log('App was installed');
    
    // Hide the install button
    if (installButton) {
        installButton.style.display = 'none';
    }
});
