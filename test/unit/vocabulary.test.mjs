import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTerm, countLabel, MAX_TERMS, normalizeTerm, sortTerms, vocabErrorMessage } from '../../app/vocabulary.js';

test('terms are trimmed and inner spaces collapsed, as the database stores them', () => {
  assert.equal(normalizeTerm('  Ngaio  '), 'Ngaio');
  assert.equal(normalizeTerm('Fremantle\t  Doctors\n'), 'Fremantle Doctors');
  assert.equal(normalizeTerm(undefined), '');
});

test('checkTerm accepts a good term, normalized', () => {
  assert.deepEqual(checkTerm('  Kalgoorlie ', ['Ngaio']), { term: 'Kalgoorlie' });
  assert.deepEqual(checkTerm('x'.repeat(50), []), { term: 'x'.repeat(50) });
  assert.deepEqual(checkTerm('one two three four five', []), { term: 'one two three four five' });
  assert.deepEqual(checkTerm('Māori', []), { term: 'Māori' });
});

test('checkTerm refuses empty, long, wordy and bracketed terms', () => {
  assert.match(checkTerm('   ', []).error, /Type a name/);
  assert.match(checkTerm('x'.repeat(51), []).error, /50 characters/);
  assert.match(checkTerm('one two three four five six', []).error, /5 words/);
  for (const c of ['<', '>', '{', '}', '[', ']', '\\']) assert.match(checkTerm(`a${c}b`, []).error, /Leave out/, c);
});

test('characters count as characters, not UTF-16 units', () => {
  assert.deepEqual(checkTerm('🦘'.repeat(50), []), { term: '🦘'.repeat(50) });
  assert.match(checkTerm('🦘'.repeat(51), []).error, /50 characters/);
});

test('duplicates are refused whatever the case, naming the term already there', () => {
  assert.equal(checkTerm('ngaio', ['Ngaio']).error, '“Ngaio” is already in your Vocabulary.');
  assert.equal(checkTerm(' NGAIO ', ['Ngaio']).error, '“Ngaio” is already in your Vocabulary.');
  assert.deepEqual(checkTerm('Ngaio Marsh', ['Ngaio']), { term: 'Ngaio Marsh' });
});

test('nothing more is added at the cap', () => {
  const full = Array.from({ length: MAX_TERMS }, (_, i) => `t${i}`);
  assert.match(checkTerm('new', full).error, /full \(100\)/);
  assert.deepEqual(checkTerm('new', full.slice(1)), { term: 'new' });
});

test('the list is A–Z ignoring case, and the count reads n/100', () => {
  const rows = [
    { id: 3, term: 'fremantle' },
    { id: 1, term: 'Ngaio' },
    { id: 2, term: 'Ashby' },
  ];
  assert.deepEqual(sortTerms(rows).map((r) => r.term), ['Ashby', 'fremantle', 'Ngaio']);
  assert.equal(rows[0].term, 'fremantle', 'sorts a copy');
  assert.equal(countLabel(12), '12/100');
});

test('database errors read as sentences', () => {
  assert.equal(vocabErrorMessage({ code: '23505' }, 'Ngaio'), '“Ngaio” is already in your Vocabulary.');
  assert.match(vocabErrorMessage({ code: 'P0001', message: 'vocabulary_full' }), /full \(100\)/);
  assert.match(vocabErrorMessage({ code: '23514' }), /can’t use that one/);
  assert.equal(vocabErrorMessage({ code: '42501' }), 'Sign in first');
  assert.equal(vocabErrorMessage({ message: 'TypeError: Failed to fetch' }), 'Needs a connection');
  assert.equal(vocabErrorMessage({ code: '23505' }, 'x', false), 'Needs a connection');
  assert.equal(vocabErrorMessage({ message: '?' }), 'Couldn’t do that. Try again.');
});
