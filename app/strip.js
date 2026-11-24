// The recent-Captures strip: the only list Jot keeps in v2 (spec §6, ADRs 0004 and 0006). From here the Owner can
// undo a park, restore a discarded Item, fix a mis-heard word while the Item is still in the Inbox, and retry or
// throw away a Capture the Transcriber refused. Every change to an Item goes through the lifecycle functions.

import { actionErrorMessage, addParked, applyServer, readCache, rows, updateCached, writeCache } from './recent.js';
import { allCaptures } from './store.js';
import { $, toast } from './ui.js';

const CONFIRM_MS = 3000;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
function stamp(ms) {
  const d = new Date(ms);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? timeFmt.format(d) : `Yesterday ${timeFmt.format(d)}`;
}

const LABEL = { discarded: 'Discarded', processed: 'Processed' };
const CAPTURE_TEXT = { queued: 'Queued', uploading: 'Transcribing…', failed: 'Couldn’t transcribe' };

/**
 * @param {{
 *   inbox: import('@supabase/supabase-js').SupabaseClient | null,
 *   uploader: { retry: (id: string) => Promise<void>, throwAway: (id: string) => Promise<void> },
 * }} deps
 */
export function initStrip({ inbox, uploader }) {
  const section = $('recent');
  const list = $('recent-list');
  let cache = readCache(localStorage);
  let editing = false;
  let renderPending = false;
  let armed = null; // { id, timer } for a Throw away waiting for its second tap

  const save = (next) => {
    cache = next;
    writeCache(localStorage, cache);
  };

  function button(cls, label, ariaLabel) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `row-action ${cls}`;
    b.textContent = label;
    if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
    return b;
  }

  function rowEl(r) {
    const li = document.createElement('li');
    li.className = `row is-${r.status}`;
    li.dataset.id = r.id;
    li.dataset.kind = r.kind;

    const main = document.createElement('div');
    main.className = 'row-main';
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = r.kind === 'item' ? r.text : CAPTURE_TEXT[r.status] ?? 'Queued';
    if (r.kind === 'item' && r.status === 'inbox') {
      text.tabIndex = 0;
      text.setAttribute('role', 'button');
      text.setAttribute('aria-label', `Edit: ${r.text}`);
    }
    const meta = document.createElement('span');
    meta.className = 'row-meta';
    meta.textContent = [stamp(r.at), LABEL[r.status]].filter(Boolean).join(' · ');
    main.append(text, meta);
    li.append(main);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (r.kind === 'item' && r.status === 'discarded') actions.append(button('restore', 'Restore'));
    if (r.kind === 'capture' && r.status === 'failed') {
      actions.append(button('retry', 'Retry'), button('throw-away', armed?.id === r.id ? 'Sure?' : 'Throw away'));
    }
    if (actions.childElementCount) li.append(actions);
    return li;
  }

  async function render() {
    if (editing) {
      renderPending = true;
      return;
    }
    renderPending = false;
    const records = await allCaptures().catch(() => []);
    const items = rows(records, cache, Date.now());
    list.replaceChildren(...items.map(rowEl));
    section.hidden = items.length === 0;
  }

  /** Re-reads the cached Items' Text and state from the Inbox: someone may have processed or edited them. */
  async function refresh() {
    if (!inbox || !navigator.onLine || !cache.length) return render();
    const { data, error } = await inbox.from('items').select('id, text, status').in('id', cache.map((c) => c.id));
    if (!error && data) save(applyServer(cache, data));
    return render();
  }

  /** Calls a lifecycle function on one Item and caches what comes back. Returns the Item, or null on failure. */
  async function act(fn, args) {
    if (!navigator.onLine) {
      toast('Needs a connection');
      return null;
    }
    if (!inbox) {
      toast('Sign in first');
      return null;
    }
    const { data, error } = await inbox.rpc(fn, args);
    if (error) {
      toast(actionErrorMessage(error, navigator.onLine));
      if (error.message === 'wrong_state' || error.message === 'not_found') await refresh();
      else await render();
      return null;
    }
    save(updateCached(cache, data.id, { text: data.text, status: data.status }));
    await render();
    return data;
  }

  async function discard(id) {
    if (await act('discard_item', { item_id: id })) toast('Discarded');
  }

  async function restore(id) {
    if (await act('restore_item', { item_id: id })) toast('Restored');
  }

  // ---------- Fixing a mis-heard word: edit the Text in place ----------

  function beginEdit(li) {
    const id = li.dataset.id;
    const el = li.querySelector('.row-text');
    const original = el.textContent;
    let cancelled = false;
    editing = true;
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
    el.addEventListener(
      'blur',
      async () => {
        el.removeEventListener('keydown', onKey);
        el.removeEventListener('beforeinput', onBeforeInput);
        el.contentEditable = 'false';
        li.classList.remove('editing');
        editing = false;
        const next = el.textContent.replace(/\s+/g, ' ').trim();
        if (cancelled || next === original) {
          el.textContent = original;
          return render();
        }
        if (!next) {
          el.textContent = original;
          toast('Text can’t be empty');
          return render();
        }
        el.textContent = next;
        if (!(await act('edit_item_text', { item_id: id, new_text: next }))) el.textContent = original;
        if (renderPending) render();
      },
      { once: true },
    );
  }

  // ---------- Taps ----------

  list.addEventListener('click', async (e) => {
    const li = e.target.closest('.row');
    if (!li || li.classList.contains('editing')) return;
    const id = li.dataset.id;

    if (e.target.closest('.restore')) return restore(id);
    if (e.target.closest('.retry')) {
      await uploader.retry(id);
      return render();
    }
    if (e.target.closest('.throw-away')) {
      if (armed?.id === id) {
        clearTimeout(armed.timer);
        armed = null;
        await uploader.throwAway(id);
        toast('Thrown away');
        return render();
      }
      if (armed) clearTimeout(armed.timer);
      armed = { id, timer: setTimeout(() => ((armed = null), render()), CONFIRM_MS) };
      return render();
    }
    if (e.target.closest('.row-text') && li.dataset.kind === 'item') {
      if (li.classList.contains('is-inbox')) beginEdit(li);
      else if (li.classList.contains('is-processed')) toast('Already processed');
    }
  });

  list.addEventListener('keydown', (e) => {
    const text = e.target.closest('.row-text[role="button"]');
    if (text && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      beginEdit(text.closest('.row'));
    }
  });

  return {
    render,
    refresh,
    discard,
    /** A Capture was just parked: show it as an Item. */
    parked(item) {
      save(addParked(cache, item, Date.now()));
      render();
    },
  };
}
