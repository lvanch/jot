// The Vocabulary screen (spec §6 "Screens: Vocabulary", ADR-0007): the names and jargon the Transcriber is biased
// towards. Reads and writes go straight to the `vocabulary` table under RLS (Owner only); the rules are in
// vocabulary.js. It's a screen of its own with a history entry, so Android's back gesture returns to the mic.

import { checkTerm, countLabel, MAX_TERMS, sortTerms, vocabErrorMessage } from './vocabulary.js';
import { $, toast } from './ui.js';

const STATE = 'vocabulary';

/**
 * @param {{ inbox: import('@supabase/supabase-js').SupabaseClient | null, onOpen?: () => void }} deps
 */
export function initVocabulary({ inbox, onOpen = () => {} }) {
  const section = $('vocabulary');
  const openBtn = $('vocab-open');
  const backBtn = $('vocab-back');
  const title = $('vocab-title');
  const count = $('vocab-count');
  const form = $('vocab-form');
  const input = $('vocab-term');
  const addBtn = $('vocab-add');
  const error = $('vocab-error');
  const note = $('vocab-note');
  const retryBtn = $('vocab-retry');
  const list = $('vocab-list');

  /** @type {{ id: number, term: string }[] | null} null until loaded */
  let terms = null;
  let busy = false;
  let loadSeq = 0;

  const isOpen = () => !section.hidden;
  const termsNow = () => (terms ?? []).map((t) => t.term);

  // ---------- Showing it ----------

  function show() {
    if (isOpen()) return;
    onOpen();
    document.body.dataset.screen = STATE;
    section.hidden = false;
    window.scrollTo(0, 0);
    title.focus({ preventScroll: true });
    load();
  }

  function hide() {
    if (!isOpen()) return;
    delete document.body.dataset.screen;
    section.hidden = true;
    error.textContent = '';
    if (!openBtn.hidden) openBtn.focus({ preventScroll: true });
  }

  function open() {
    if (isOpen()) return;
    history.pushState({ jot: STATE }, '');
    show();
  }

  function back() {
    if (history.state?.jot === STATE) history.back(); // popstate hides it
    else hide();
  }

  window.addEventListener('popstate', (e) => (e.state?.jot === STATE && !openBtn.hidden ? show() : hide()));
  openBtn.addEventListener('click', open);
  backBtn.addEventListener('click', back);
  section.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') back();
  });

  // ---------- The list ----------

  function render() {
    const n = terms?.length ?? 0;
    count.textContent = terms ? countLabel(n) : '';
    count.setAttribute('aria-label', terms ? `${n} of ${MAX_TERMS} terms` : '');
    const full = n >= MAX_TERMS;
    input.disabled = !terms || full;
    addBtn.disabled = !terms || full || busy;
    input.placeholder = full ? 'Full: remove a term to add another' : 'Add a name or word';
    if (terms && !n) note.textContent = 'Nothing yet. Add names and words Jot gets wrong, like Ngaio or Fremantle.';
    else if (terms) note.textContent = '';

    list.replaceChildren(
      ...(terms ?? []).map(({ id, term }) => {
        const li = document.createElement('li');
        li.className = 'vocab-row';
        li.dataset.id = String(id);
        const span = document.createElement('span');
        span.className = 'vocab-term';
        span.textContent = term;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'vocab-delete';
        del.setAttribute('aria-label', `Remove ${term}`);
        del.innerHTML =
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        li.append(span, del);
        return li;
      }),
    );
  }

  async function load() {
    const seq = ++loadSeq;
    retryBtn.hidden = true;
    if (!terms) {
      note.textContent = 'Loading…';
      render();
    }
    if (!inbox) return failLoad('Sign in first');
    const { data, error: err } = await inbox.from('vocabulary').select('id, term');
    if (seq !== loadSeq) return; // a newer load is under way
    if (err) return failLoad(vocabErrorMessage(err, '', navigator.onLine));
    terms = sortTerms(data);
    render();
  }

  function failLoad(message) {
    if (terms) {
      toast(message); // keep showing what we had
      return;
    }
    note.textContent = message === 'Needs a connection' ? 'Needs a connection to show your Vocabulary.' : message;
    retryBtn.hidden = false;
    render();
  }

  retryBtn.addEventListener('click', load);

  // ---------- Adding ----------

  async function insert(term) {
    if (!navigator.onLine) return { message: 'Needs a connection' };
    const { data, error: err } = await inbox.from('vocabulary').insert({ term }).select('id, term').single();
    if (err) {
      const stale = err.code === '23505' || err.message === 'vocabulary_full';
      return { message: vocabErrorMessage(err, term, navigator.onLine), stale };
    }
    if (terms) terms = sortTerms([...terms.filter((t) => t.id !== data.id), data]);
    return { row: data };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !terms) return;
    const checked = checkTerm(input.value, termsNow());
    if ('error' in checked) {
      error.textContent = checked.error;
      return;
    }
    busy = true;
    error.textContent = '';
    render();
    const result = await insert(checked.term);
    busy = false;
    if (result.row) {
      input.value = '';
      render();
      flash(result.row.id);
    } else {
      error.textContent = result.message;
      render();
      if (result.stale) load(); // added somewhere else meanwhile
    }
    if (!input.disabled) input.focus();
  });

  input.addEventListener('input', () => {
    error.textContent = '';
  });

  function flash(id) {
    const li = list.querySelector(`[data-id="${id}"]`);
    if (!li) return;
    li.classList.add('is-new');
    li.scrollIntoView({ block: 'nearest' });
    setTimeout(() => li.classList.remove('is-new'), 1200);
  }

  // ---------- Removing, with Undo ----------

  list.addEventListener('click', async (e) => {
    const del = e.target.closest('.vocab-delete');
    if (!del || del.disabled) return;
    const li = del.closest('.vocab-row');
    const id = Number(li.dataset.id);
    const row = terms.find((t) => t.id === id);
    if (!row) return;
    if (!navigator.onLine) return toast('Needs a connection');

    del.disabled = true;
    const { error: err } = await inbox.from('vocabulary').delete().eq('id', id);
    if (err) {
      del.disabled = false;
      return toast(vocabErrorMessage(err, '', navigator.onLine));
    }
    const next = li.nextElementSibling ?? li.previousElementSibling;
    const focusId = next?.dataset.id;
    terms = terms.filter((t) => t.id !== id);
    render();
    const neighbour = focusId && list.querySelector(`[data-id="${focusId}"] .vocab-delete`);
    if (neighbour) neighbour.focus();
    else if (!input.disabled) input.focus();
    toast(`Removed “${row.term}”`, async () => {
      const result = await insert(row.term);
      if (!result.row) return toast(result.message);
      if (isOpen()) {
        render();
        flash(result.row.id);
      }
    });
  });

  return {
    open,
    isOpen,
    /** The Vocabulary is the Owner's: the button shows only when signed in, and signing out closes the screen. */
    setSignedIn(on) {
      openBtn.hidden = !on;
      if (!on) {
        terms = null;
        if (history.state?.jot === STATE) history.replaceState(null, '');
        hide();
      } else if (history.state?.jot === STATE) show(); // reloaded while on this screen
    },
  };
}
