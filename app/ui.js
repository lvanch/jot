// Small shared UI pieces: element lookup, the toast (with optional Undo), and the status line.

export const $ = (id) => document.getElementById(id);

const UNDO_MS = 5000;
const INFO_MS = 2500;

const toastEl = $('toast');
const toastMsg = $('toast-msg');
const toastUndo = $('toast-undo');
let toastTimer = 0;
let undoFn = null;

export function toast(msg, undo) {
  clearTimeout(toastTimer);
  undoFn = undo || null;
  toastMsg.textContent = undo ? msg + ' ·' : msg;
  toastUndo.hidden = !undo;
  toastEl.hidden = false;
  document.body.classList.add('toast-on');
  void toastEl.offsetWidth; // start the transition from the hidden state
  toastEl.classList.add('show');
  toastTimer = setTimeout(hideToast, undo ? UNDO_MS : INFO_MS);
}

export function hideToast() {
  clearTimeout(toastTimer);
  undoFn = null;
  toastEl.classList.remove('show');
  toastEl.hidden = true;
  document.body.classList.remove('toast-on');
}

toastUndo.addEventListener('click', () => {
  const fn = undoFn;
  hideToast();
  if (fn) fn();
});

const statusEl = $('status');

export function setStatus(text, listening = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('is-listening', listening);
}
