/**
 * Minimal PWA Installer
 * Handles the PWA installation prompt with a subtle floating button
 */

let deferredPrompt;
let installButton;

document.addEventListener('DOMContentLoaded', () => {
    createInstallButton();
    registerServiceWorker();
});

function createInstallButton() {
    const button = document.createElement('button');
    button.id = 'pwa-install-btn';
    button.textContent = 'Install App ✨';
    button.style.cssText = `
        display: none;
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #222;
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 10px 14px;
        font-size: 14px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        cursor: pointer;
        z-index: 1000;
        transition: opacity 0.2s ease;
    `;

    const close = document.createElement('span');
    close.textContent = '×';
    close.style.cssText = `
        margin-left: 10px;
        font-weight: bold;
        cursor: pointer;
    `;
    close.onclick = () => button.remove();
    button.appendChild(close);

    button.addEventListener('click', async (e) => {
        if (e.target === close) return; // Ignore if the close button was clicked
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        console.log(`User response: ${outcome}`);
        deferredPrompt = null;
        button.remove();
    });

    document.body.appendChild(button);
    installButton = button;
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/static/sw.js')
            .then(reg => console.log('SW registered:', reg.scope))
            .catch(err => console.error('SW registration failed:', err));
    }
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installButton) installButton.style.display = 'block';
    console.log('Install prompt ready, showing button');
});

window.addEventListener('appinstalled', () => {
    console.log('App was installed');
    if (installButton) installButton.remove();
});
