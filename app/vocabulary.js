// The Vocabulary's rules, kept pure so they're unit-tested (test/unit/vocabulary.test.mjs). Spec §3 `vocabulary`
// and §6 "Screens: Vocabulary"; ADR-0007. The database enforces all of this too: these checks only give a friendly
// message before a request, and `vocabErrorMessage` gives one when the database says no anyway.

export const MAX_TERMS = 100;
export const MAX_CHARS = 50;
export const MAX_WORDS = 5;

const BANNED = /[<>{}[\]\\]/;
const fullMessage = `Your Vocabulary is full (${MAX_TERMS}). Remove a term to add another.`;

/** Trimmed, inner whitespace collapsed to one space: what the database stores. */
export function normalizeTerm(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

const sameTerm = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * Checks a term before adding it.
 * @param {string} raw what was typed
 * @param {string[]} existing the terms already in the Vocabulary
 * @returns {{ term: string } | { error: string }}
 */
export function checkTerm(raw, existing) {
  const term = normalizeTerm(raw);
  if (!term) return { error: 'Type a name or word first.' };
  if ([...term].length > MAX_CHARS) return { error: `Keep it to ${MAX_CHARS} characters.` };
  if (term.split(' ').length > MAX_WORDS) return { error: `Keep it to ${MAX_WORDS} words.` };
  if (BANNED.test(term)) return { error: 'Leave out < > { } [ ] and \\.' };
  const dup = existing.find((t) => sameTerm(t, term));
  if (dup !== undefined) return { error: `“${dup}” is already in your Vocabulary.` };
  if (existing.length >= MAX_TERMS) return { error: fullMessage };
  return { term };
}

/** A–Z, ignoring case, so a term is easy to find. */
export function sortTerms(rows) {
  return [...rows].sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: 'base' }) || a.id - b.id);
}

/** `12/100` */
export const countLabel = (n) => `${n}/${MAX_TERMS}`;

/**
 * A sentence for an error from reading or writing the `vocabulary` table.
 * @param {{ code?: string, message?: string, status?: number } | null} error
 * @param {string} [term] the term being added, for the duplicate message
 */
export function vocabErrorMessage(error, term = '', online = true) {
  const msg = String(error?.message ?? '');
  if (!online || /Failed to fetch|NetworkError|fetch failed/i.test(msg)) return 'Needs a connection';
  if (msg === 'vocabulary_full') return fullMessage;
  if (error?.code === '23505') return term ? `“${term}” is already in your Vocabulary.` : 'That’s already in your Vocabulary.';
  if (error?.code === '23514') return 'Jot can’t use that one: keep it short, with no < > { } [ ] or \\.';
  if (error?.code === '42501' || error?.code === 'PGRST301' || error?.status === 401) return 'Sign in first';
  return 'Couldn’t do that. Try again.';
}
