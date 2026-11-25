// Stand-in for Jot v1's app.js: all the cut-over test needs is v1's service worker, registered the way v1 did it.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
