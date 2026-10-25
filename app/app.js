'use strict';

(() => {
  const KEY = 'jot.tasks.v1';
  const SYNC_KEY = 'jot.sync.v1'; // { api, key, cursor, uploaded }
  const OUTBOX_KEY = 'jot.outbox.v1'; // changes not yet acknowledged by the server, oldest first
  const UNDO_MS = 5000;
  const INFO_MS = 2500;
  const MAX_TEXT = 2000; // the sync API's limit
  // Phones open Jot to speak; on a laptop the mic waits for a tap.
  const AUTO_LISTEN = window.matchMedia('(pointer: coarse)').matches;

  const $ = (id) => document.getElementById(id);
  const micBtn = $('mic');
  const fabBtn = $('fab');
  const statusEl = $('status');
  const liveEl = $('live');
  const openList = $('open');
  const doneList = $('done');
  const doneWrap = $('done-wrap');
  const doneCount = $('done-count');
  const emptyEl = $('empty');
  const shareBtn = $('share');
  const toastEl = $('toast');
  const toastMsg = $('toast-msg');
  const toastUndo = $('toast-undo');
  const syncEl = $('sync');

  // ---------- Storage ----------

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(data) ? data.filter((t) => t && typeof t.text === 'string') : [];
    } catch {
      return [];
    }
  }

  let tasks = load();

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(tasks));
    } catch {
      toast("Couldn't save — storage is full or blocked");
    }
  }

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // ---------- Tasks ----------

  const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  function clean(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT).trimEnd();
    // Speech results often arrive lowercase; capitalise unless it looks deliberate ("iPhone").
    return /^[a-z](?![A-Z])/.test(t) ? t[0].toUpperCase() + t.slice(1) : t;
  }

  // Deleted tasks stay in storage as tombstones (deletedAt set) so the deletion can sync; the UI never shows them.
  const live = () => tasks.filter((t) => !t.deletedAt);
  const find = (id) => tasks.find((t) => t.id === id);
  const isEditing = () => !!document.querySelector('.task.editing');

  // Each change is saved and shown first; queue() only records it for sync.

  function addTask(raw) {
    const text = clean(raw);
    if (!text) return false;
    const task = { id: uid(), text, createdAt: Date.now(), done: false, doneAt: null };
    tasks.push(task);
    persist();
    render(task.id);
    toast('Saved', () => trashTask(task.id));
    queue({ op: 'put', id: task.id, body: { text, createdAt: task.createdAt, done: false, doneAt: null } });
    return true;
  }

  function trashTask(id) {
    const task = find(id);
    if (!task || task.deletedAt) return false;
    task.deletedAt = Date.now();
    persist();
    render();
    queue({ op: 'delete', id, at: task.deletedAt });
    return true;
  }

  function restoreTask(id) {
    const task = find(id);
    if (!task || !task.deletedAt) return;
    task.deletedAt = null;
    persist();
    render();
    queue({ op: 'patch', id, body: { deletedAt: null } });
  }

  function deleteTask(id) {
    if (trashTask(id)) toast('Deleted', () => restoreTask(id));
  }

  function toggleTask(id) {
    const task = find(id);
    if (!task) return;
    task.done = !task.done;
    task.doneAt = task.done ? Date.now() : null;
    persist();
    render();
    queue({ op: 'patch', id, body: { done: task.done, doneAt: task.doneAt } });
  }

  function editTask(id, raw) {
    const task = find(id);
    if (!task) return;
    const text = clean(raw);
    if (!text) {
      deleteTask(id);
      render();
      return;
    }
    if (text !== task.text) {
      task.text = text;
      persist();
      queue({ op: 'patch', id, body: { text } });
    }
    render();
  }

  // ---------- Rendering ----------

  let swipe = null; // the row being swiped, see below

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const fullFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  function stamp(ms) {
    const d = new Date(ms);
    const now = new Date();
    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (days <= 0) return timeFmt.format(d);
    if (days === 1) return 'Yesterday';
    if (days < 7) return dayFmt.format(d);
    if (d.getFullYear() === now.getFullYear()) return dateFmt.format(d);
    return fullFmt.format(d);
  }

  const TICK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function row(task, flashId) {
    const li = document.createElement('li');
    li.className = 'task' + (task.done ? ' is-done' : '') + (task.id === flashId ? ' is-new' : '');
    li.dataset.id = task.id;

    const inner = document.createElement('div');
    inner.className = 'task-row';

    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'tick';
    tick.setAttribute('role', 'checkbox');
    tick.setAttribute('aria-checked', String(task.done));
    tick.setAttribute('aria-label', task.done ? 'Mark not done' : 'Mark done');
    tick.innerHTML = '<span>' + TICK_SVG + '</span>';

    const body = document.createElement('div');
    body.className = 'task-body';

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = task.text;

    const meta = document.createElement('time');
    meta.className = 'meta';
    meta.dateTime = new Date(task.createdAt).toISOString();
    meta.textContent = stamp(task.createdAt);

    body.append(text, meta);
    inner.append(tick, body);
    li.append(inner);
    return li;
  }

  let renderPending = false;

  function render(flashId) {
    // Re-rendered when the edit or swipe ends.
    if (isEditing() || (swipe && swipe.active)) {
      renderPending = true;
      return;
    }
    renderPending = false;
    const all = live();
    const open = all.filter((t) => !t.done).sort((a, b) => b.createdAt - a.createdAt);
    const done = all.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    openList.replaceChildren(...open.map((t) => row(t, flashId)));
    doneList.replaceChildren(...done.map((t) => row(t)));
    doneCount.textContent = '· ' + done.length;
    doneWrap.hidden = done.length === 0;
    emptyEl.hidden = open.length > 0 || done.length > 0;
    shareBtn.disabled = open.length === 0;
  }

  // ---------- Toast ----------

  let toastTimer = 0;
  let undoFn = null;

  function toast(msg, undo) {
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

  function hideToast() {
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

  // ---------- Speech capture ----------

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const navLang = navigator.language || '';
  const LANG = navLang.toLowerCase().startsWith('en') ? navLang : 'en-US';

  let session = null; // the active recognition run, one task max
  let pendingStart = null; // 'auto' | 'tap' — queued while a previous run winds down

  function setListening(on, status) {
    for (const b of [micBtn, fabBtn]) {
      b.classList.toggle('is-listening', on);
      b.setAttribute('aria-label', on ? 'Stop listening' : 'Start listening');
    }
    micBtn.setAttribute('aria-pressed', String(on));
    statusEl.classList.toggle('is-listening', on);
    statusEl.textContent = status;
  }

  function endMessage(s) {
    if (s.saved) return 'Tap to add another';
    switch (s.error) {
      case 'not-allowed':
      case 'service-not-allowed':
        return s.auto ? 'Tap the mic to start' : 'Microphone blocked — allow it in site settings';
      case 'network':
        return 'Speech needs a connection — tap to retry';
      case 'audio-capture':
        return 'No microphone available — tap to retry';
      case 'no-speech':
        return "Didn't catch that — tap to speak";
      default:
        return 'Tap to speak';
    }
  }

  function startListening(auto) {
    if (!SR) {
      micBtn.classList.add('is-unsupported');
      statusEl.textContent = 'Speech recognition isn’t available in this browser';
      return;
    }
    if (session) {
      if (session.aborting) pendingStart = auto ? 'auto' : 'tap';
      return;
    }

    const r = new SR();
    r.lang = LANG;
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;

    const s = { r, auto, heard: '', saved: false, error: null, aborting: false };
    session = s;

    r.onresult = (e) => {
      if (s.saved) return;
      let finalText = '';
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      s.heard = finalText + interim;
      liveEl.textContent = s.heard.trim();
      if (finalText.trim()) {
        s.saved = addTask(finalText);
        try { r.stop(); } catch { /* already ending */ }
      }
    };

    r.onerror = (e) => {
      s.error = e.error;
    };

    r.onend = () => {
      // Some engines end without marking the last result final; keep what was heard.
      if (!s.saved && s.heard.trim()) s.saved = addTask(s.heard);
      if (session === s) session = null;
      liveEl.textContent = '';
      setListening(false, endMessage(s));
      const next = pendingStart;
      pendingStart = null;
      if (next && document.visibilityState === 'visible') startListening(next === 'auto');
    };

    liveEl.textContent = '';
    setListening(true, 'Listening…');
    try {
      r.start();
    } catch {
      session = null;
      setListening(false, auto ? 'Tap the mic to start' : 'Tap to speak');
    }
  }

  function onMicTap() {
    if (session && !session.aborting) {
      try { session.r.stop(); } catch { /* ignore */ }
      return;
    }
    startListening(false);
  }

  micBtn.addEventListener('click', onMicTap);
  fabBtn.addEventListener('click', onMicTap);

  // ---------- Auto-start on open / return to foreground ----------

  let autoTimer = 0;
  let reloadOnResume = false;

  function onForeground() {
    if (reloadOnResume) {
      location.reload();
      return;
    }
    render(); // refresh relative timestamps
    kick(true);
    if (!AUTO_LISTEN) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      if (document.visibilityState !== 'visible' || isEditing()) return;
      window.scrollTo(0, 0);
      startListening(true);
    }, 150);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      onForeground();
    } else {
      clearTimeout(autoTimer);
      if (session && !session.aborting) {
        session.aborting = true;
        try { session.r.abort(); } catch { /* ignore */ }
      }
    }
  });

  window.addEventListener('pageshow', (e) => {
    if (e.persisted) onForeground();
  });

  // ---------- List interactions: tick, edit, swipe ----------

  let suppressClickUntil = 0;

  function onListClick(e) {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const li = e.target.closest('.task');
    if (!li || li.classList.contains('editing')) return;
    if (e.target.closest('.tick')) {
      toggleTask(li.dataset.id);
    } else if (e.target.closest('.text')) {
      beginEdit(li);
    }
  }

  function beginEdit(li) {
    const id = li.dataset.id;
    const el = li.querySelector('.text');
    const original = el.textContent;
    let cancelled = false;

    li.classList.add('editing');
    try {
      el.contentEditable = 'plaintext-only';
    } catch {
      el.contentEditable = 'true';
    }
    el.setAttribute('enterkeyhint', 'done');
    el.setAttribute('role', 'textbox');
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = () => el.blur();
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish();
      } else if (e.key === 'Escape') {
        cancelled = true;
        finish();
      }
    };
    // Android keyboards don't always send a usable keydown for Enter.
    const onBeforeInput = (e) => {
      if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
        e.preventDefault();
        finish();
      }
    };
    el.addEventListener('keydown', onKey);
    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('blur', () => {
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('beforeinput', onBeforeInput);
      el.contentEditable = 'false';
      li.classList.remove('editing');
      if (cancelled) {
        el.textContent = original;
        render();
        return;
      }
      editTask(id, el.textContent);
    }, { once: true });
  }

  function onPointerDown(e) {
    if (e.button !== 0 || swipe) return;
    const li = e.target.closest('.task');
    if (!li || li.classList.contains('editing')) return;
    swipe = {
      li,
      row: li.querySelector('.task-row'),
      id: li.dataset.id,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      dx: 0,
      active: false,
    };
  }

  function onPointerMove(e) {
    if (!swipe || e.pointerId !== swipe.pointerId) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (!swipe.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        swipe = null;
        return;
      }
      if (dx > -10 || Math.abs(dx) < Math.abs(dy)) return;
      swipe.active = true;
      try { swipe.li.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      swipe.li.classList.add('is-swiping');
      swipe.row.style.transition = 'none';
    }
    swipe.dx = Math.min(0, dx);
    swipe.row.style.transform = `translateX(${swipe.dx}px)`;
  }

  function onPointerUp(e) {
    if (!swipe || e.pointerId !== swipe.pointerId) return;
    const s = swipe;
    swipe = null;
    if (!s.active) return;
    suppressClickUntil = Date.now() + 350;
    const width = s.li.offsetWidth;
    const commit = e.type === 'pointerup' && -s.dx > Math.min(width * 0.35, 140);
    s.row.style.transition = 'transform 0.18s ease-out';
    if (commit) {
      s.row.style.transform = `translateX(${-width}px)`;
      setTimeout(() => deleteTask(s.id), 180);
    } else {
      s.row.style.transform = '';
      setTimeout(() => {
        s.row.style.transition = '';
        s.li.classList.remove('is-swiping');
        if (renderPending) render();
      }, 200);
    }
  }

  for (const list of [openList, doneList]) {
    list.addEventListener('click', onListClick);
    list.addEventListener('pointerdown', onPointerDown);
    list.addEventListener('pointermove', onPointerMove);
    list.addEventListener('pointerup', onPointerUp);
    list.addEventListener('pointercancel', onPointerUp);
  }

  // ---------- Share / copy ----------

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  shareBtn.addEventListener('click', async () => {
    const open = live().filter((t) => !t.done).sort((a, b) => b.createdAt - a.createdAt);
    if (!open.length) {
      toast('Nothing to share');
      return;
    }
    const text = open.map((t) => '- ' + t.text).join('\n');
    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    const n = open.length;
    toast((await copyText(text)) ? `Copied ${n} task${n === 1 ? '' : 's'}` : "Couldn't copy");
  });

  // ---------- Floating mic when the hero is off-screen ----------

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      fabBtn.hidden = entry.isIntersecting;
    }).observe(micBtn);
  }

  // ---------- Sync ----------
  //
  // Optional: with no key, Jot is local-only. Once linked, every change is appended to a persisted outbox
  // and sent in order. Pulls merge server rows into local storage and then re-apply whatever is still in
  // the outbox, so a pull never undoes an unsent local edit. The server's rev orders everything.

  const readJSON = (k) => {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  };
  const writeJSON = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      toast("Couldn't save — storage is full or blocked");
    }
  };

  function loadSync() {
    const s = readJSON(SYNC_KEY);
    return s && typeof s.api === 'string' && typeof s.key === 'string' ? s : null;
  }

  let sync = loadSync();
  const saveSync = () => writeJSON(SYNC_KEY, sync);
  const outbox = () => {
    const o = readJSON(OUTBOX_KEY);
    return Array.isArray(o) ? o : [];
  };
  const saveOutbox = (o) => writeJSON(OUTBOX_KEY, o);

  let problem = null; // null | 'offline' | 'rejected' | 'server'
  let problemCode = 0;
  let wantPull = false;
  let running = false;
  let rerun = false;
  let retryTimer = 0;
  let retryDelay = 0;

  function queue(op) {
    if (!sync) return;
    op.seq = uid();
    const o = outbox();
    o.push(op);
    saveOutbox(o);
    showSync();
    kick();
  }

  // The whole task as the server should store it; used for first sync and to recreate a missing row.
  function putOp(t) {
    const ms = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
    const body = {
      text: t.text.slice(0, MAX_TEXT),
      createdAt: ms(t.createdAt) ?? Date.now(),
      done: !!t.done,
      doneAt: ms(t.doneAt),
      deletedAt: ms(t.deletedAt),
    };
    if (t.fields && typeof t.fields === 'object' && !Array.isArray(t.fields)) body.fields = t.fields;
    return { op: 'put', id: t.id, body, seq: uid() };
  }

  function showSync() {
    let msg = '';
    if (sync) {
      const n = outbox().length;
      const pending = n ? ` · ${n} not synced` : '';
      if (problem === 'rejected') msg = 'Sync key rejected';
      else if (problem === 'server') msg = `Sync error (${problemCode})${pending}`;
      else if (n && (problem === 'offline' || !navigator.onLine)) msg = `Offline${pending}`;
    }
    syncEl.textContent = msg;
    syncEl.classList.toggle('is-error', problem === 'rejected' || problem === 'server');
    syncEl.hidden = !msg;
  }

  function request(method, path, body) {
    const headers = { Authorization: 'Bearer ' + sync.key };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(sync.api + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
    });
  }

  // Server rows replace local copies (unless older than what's held), then unsent changes go back on top.
  function merge(rows) {
    const pending = outbox();
    const looks = (t) => JSON.stringify([t.text, !!t.done, t.doneAt || 0, t.createdAt, !!t.deletedAt]);
    let changed = false;
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || typeof row.text !== 'string') continue;
      const i = tasks.findIndex((t) => t.id === row.id);
      const local = i < 0 ? null : tasks[i];
      if (local && typeof local.rev === 'number' && row.rev < local.rev) continue;
      const next = { ...row };
      for (const op of pending) {
        if (op.id !== row.id) continue;
        if (op.op === 'patch') Object.assign(next, op.body);
        else if (op.op === 'delete' && !next.deletedAt) next.deletedAt = op.at;
      }
      if (!local || looks(local) !== looks(next)) changed = true;
      if (local) tasks[i] = next;
      else tasks.push(next);
    }
    persist();
    if (changed) render();
  }

  function fail(kind, code) {
    problem = kind;
    problemCode = code || 0;
    showSync();
    if (kind !== 'rejected') {
      // Back off while offline or the server is failing; any new change or foregrounding tries again at once.
      retryDelay = Math.min(retryDelay ? retryDelay * 2 : 1000, 60000);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(kick, retryDelay * (0.75 + Math.random() / 2));
    }
  }

  // Take op off the head of the outbox (or swap in its replacement), if it's still there.
  function settle(op, replacement) {
    const o = outbox();
    if (!o.length || o[0].seq !== op.seq) return;
    if (replacement) o[0] = replacement;
    else o.shift();
    saveOutbox(o);
  }

  async function step() {
    if (!sync) return;
    let refused = 0;

    for (let o = outbox(); o.length; o = outbox()) {
      const op = o[0];
      const path = '/tasks/' + encodeURIComponent(op.id);
      let res;
      try {
        if (op.op === 'put') res = await request('PUT', path, op.body);
        else if (op.op === 'patch') res = await request('PATCH', path, op.body);
        else res = await request('DELETE', path);
      } catch {
        return fail('offline');
      }
      if (res.status === 401) return fail('rejected');
      if (res.ok) {
        const row = await res.json().catch(() => null);
        settle(op);
        if (row) merge([row]);
      } else if (res.status === 404 && op.op !== 'put') {
        // The server never got this task: send the whole of it instead.
        const task = find(op.id);
        settle(op, task ? putOp(task) : null);
      } else if (res.status >= 500 || res.status === 408 || res.status === 429) {
        return fail('server', res.status);
      } else {
        // Refused for good (400/413): drop it and re-pull everything so local matches the server again.
        settle(op);
        refused = res.status;
        sync.cursor = 0;
        wantPull = true;
      }
    }

    while (wantPull) {
      let res;
      try {
        res = await request('GET', '/tasks?since=' + (sync.cursor || 0));
      } catch {
        return fail('offline');
      }
      if (res.status === 401) return fail('rejected');
      const page = res.ok ? await res.json().catch(() => null) : null;
      if (!page || !Array.isArray(page.tasks)) return fail('server', res.status);
      merge(page.tasks);
      sync.cursor = page.cursor;
      saveSync();
      wantPull = !!page.more;
    }

    retryDelay = 0;
    problem = refused ? 'server' : null;
    problemCode = refused;
    showSync();
  }

  // One sync run at a time, across tabs too.
  const exclusive = (fn) => (navigator.locks ? navigator.locks.request('jot-sync', fn) : fn());

  // Sends the outbox (and pulls, if asked) now. A rejected key pauses sync until the next pull is asked for.
  async function kick(pull) {
    if (!sync || (problem === 'rejected' && !pull)) return;
    if (pull) wantPull = true;
    clearTimeout(retryTimer);
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        await exclusive(step);
      } while (rerun);
    } finally {
      running = false;
    }
  }

  async function verify() {
    try {
      const res = await request('GET', '/me');
      if (res.status === 401) return fail('rejected');
      const me = res.ok ? await res.json() : null;
      if (me && !undoFn) toast(`Sync on · ${me.device}`);
    } catch {
      // offline: the outbox waits
    }
  }

  function link(api, key) {
    const same = !!sync && sync.api === api;
    sync = { api, key, cursor: same ? sync.cursor : 0, uploaded: same && !!sync.uploaded };
    if (!same) {
      // revs belong to the old server
      for (const t of tasks) delete t.rev;
      persist();
    }
    if (!sync.uploaded) {
      // First sync: send every task this device already has, once.
      saveOutbox(tasks.map(putOp));
      sync.uploaded = true;
    }
    saveSync();
    problem = null;
    showSync();
    verify();
    kick(true);
  }

  // One-time link: https://<jot>/#api=<worker-url>&key=<key>
  function readLink() {
    const hash = location.hash.slice(1);
    if (!/(^|&)(api|key)=/.test(hash)) return;
    const params = {};
    for (const part of hash.split('&')) {
      const i = part.indexOf('=');
      if (i < 1) continue;
      try {
        params[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
      } catch {
        // malformed escape: treat as missing
      }
    }
    // Don't leave the key in the address bar.
    history.replaceState(null, '', location.pathname + location.search);

    let api = null;
    try {
      const u = new URL(params.api);
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol === 'https:' || (local && u.protocol === 'http:')) api = (u.origin + u.pathname).replace(/\/+$/, '');
    } catch {
      // not a URL
    }
    if (!api || !params.key) {
      toast('Sync link is incomplete');
      return;
    }
    link(api, params.key);
  }

  window.addEventListener('hashchange', readLink);
  window.addEventListener('online', () => kick(true));
  window.addEventListener('offline', showSync);
  window.addEventListener('focus', () => kick(true));

  // Another tab changed something: pick it up.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      tasks = load();
      render();
    } else if (e.key === SYNC_KEY) {
      sync = loadSync();
      showSync();
    } else if (e.key === OUTBOX_KEY) {
      showSync();
    }
  });

  // ---------- Service worker ----------

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // A new version took over: pick it up the next time Jot comes to the foreground.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) reloadOnResume = true;
    });
  }

  // ---------- Boot ----------

  readLink();
  render();
  showSync();
  if (document.visibilityState === 'visible') onForeground();
  else kick(true);
})();
