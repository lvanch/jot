// Jot v2: capture-only (ADR-0004). This boots the shell: sign-in, the account menu, the mic, the queue, the
// recent-Captures strip, and the service worker.

import { initCapture } from './capture.js';
import { configured, createInbox, functionsUrl, SUPABASE_PUBLISHABLE_KEY } from './inbox.js';
import { initSignIn, showSignIn } from './signin.js';
import { initStrip } from './strip.js';
import { $, setStatus, toast } from './ui.js';
import { createUploader } from './uploader.js';

const inbox = configured ? createInbox() : null;

// ---------- Status line: the mic speaks while listening, otherwise the queue, otherwise the mic's last word ----------

let captureText = 'Tap to speak';
let listening = false;
let queueText = null;

function renderStatus() {
  setStatus(listening ? captureText : (queueText ?? captureText), listening);
}

// ---------- The queue: every kept Recording goes to transcribe and becomes an Item ----------

let strip = null; // the recent-Captures strip, set up below; the queue's callbacks only fire once it exists

const uploader = createUploader({
  inbox,
  functionsUrl,
  publishableKey: SUPABASE_PUBLISHABLE_KEY,
  onStatus(text) {
    queueText = text;
    renderStatus();
    strip?.render(); // the queue changed
  },
  onParked(item) {
    captureText = 'Tap to add another';
    renderStatus();
    strip?.parked(item);
    toast('Parked', () => strip?.discard(item.id)); // Undo discards it (ADR-0003)
    window.dispatchEvent(new CustomEvent('jot:parked', { detail: { id: item.id, text: item.text } }));
  },
  onEmpty() {
    captureText = 'Didn’t catch that — tap to speak';
    renderStatus();
  },
  onFailed() {
    toast('Couldn’t transcribe that one');
  },
});

// ---------- The recent-Captures strip ----------

strip = initStrip({ inbox, uploader });
strip.render();

// ---------- Signed in or not ----------

const accountBtn = $('account');
const menu = $('account-menu');

function render(session) {
  const signedIn = !!session;
  showSignIn(!signedIn);
  accountBtn.hidden = !signedIn;
  $('account-email').textContent = session?.user?.email ?? '';
  if (!signedIn) closeMenu();
  uploader.setSignedIn(signedIn);
  if (signedIn) strip.refresh();
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

// ---------- Mic: each kept Recording becomes a Capture, and goes in the queue ----------

const micBtn = $('mic');
const fabBtn = $('fab');

initCapture({
  onStatus(text, isListening) {
    captureText = text;
    listening = isListening;
    renderStatus();
  },
  onCapture(capture) {
    uploader.add(capture);
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

// Send what's waiting: now (after a crash or reload mid-upload), when the network returns, and on foreground.
uploader.resume();
window.addEventListener('online', () => uploader.kick(true));
window.addEventListener('offline', () => uploader.kick());

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
  if (document.visibilityState !== 'visible') return;
  if (reloadOnResume) location.reload();
  else {
    uploader.kick(true);
    strip.refresh(); // someone may have processed or edited an Item meanwhile
  }
});
