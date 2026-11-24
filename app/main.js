// Jot v2: capture-only (ADR-0004). This boots the shell: sign-in, the account menu, the mic, and the service
// worker. The queue (#9) and the recent-Captures strip (#10) plug in here as they land.

import { configured, createInbox } from './inbox.js';
import { initCapture } from './capture.js';
import { initSignIn, showSignIn } from './signin.js';
import { $, setStatus, toast } from './ui.js';

const inbox = configured ? createInbox() : null;

// ---------- Signed in or not ----------

const accountBtn = $('account');
const menu = $('account-menu');

function render(session) {
  const signedIn = !!session;
  showSignIn(!signedIn);
  accountBtn.hidden = !signedIn;
  $('account-email').textContent = session?.user?.email ?? '';
  if (!signedIn) closeMenu();
}

if (inbox) {
  initSignIn(inbox);
  inbox.auth.onAuthStateChange((_event, session) => render(session));
  const { data } = await inbox.auth.getSession();
  render(data.session);
} else {
  initSignIn(null, { disabledReason: "Jot isn't connected to its Inbox yet." });
  render(null);
}

// ---------- Account menu: who's signed in, and sign out ----------

function openMenu() {
  menu.hidden = false;
  accountBtn.setAttribute('aria-expanded', 'true');
  $('sign-out').focus();
}

function closeMenu() {
  menu.hidden = true;
  accountBtn.setAttribute('aria-expanded', 'false');
}

accountBtn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !accountBtn.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menu.hidden) {
    closeMenu();
    accountBtn.focus();
  }
});

$('sign-out').addEventListener('click', async () => {
  closeMenu();
  // 'local': this device only; other devices stay signed in.
  const { error } = await inbox.auth.signOut({ scope: 'local' });
  toast(error ? "Couldn't sign out. Try again." : 'Signed out');
});

// ---------- Mic: each kept Recording becomes a Capture ----------

const micBtn = $('mic');
const fabBtn = $('fab');

initCapture({
  onCapture(capture) {
    // The queue (#9) takes over from here. Until then, say what was recorded and announce it, so tests can see it.
    setStatus(`Recorded ${(capture.durationMs / 1000).toFixed(1)} s · sending arrives with the queue`);
    const { id, blob, mimeType, durationMs, device, stop } = capture;
    window.dispatchEvent(
      new CustomEvent('jot:capture', { detail: { id, size: blob.size, mimeType, durationMs, device, stop } }),
    );
  },
});

if ('IntersectionObserver' in window) {
  new IntersectionObserver(([entry]) => {
    fabBtn.hidden = entry.isIntersecting;
  }).observe(micBtn);
}

// ---------- Service worker: pick up new versions the next time Jot comes to the foreground ----------

let reloadOnResume = false;

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) reloadOnResume = true;
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && reloadOnResume) location.reload();
});
