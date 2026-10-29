'use strict';

/**
 * Unit tests for lib/names.js
 * Run with: node tests/names.test.js
 */

const { normalize, levenshtein, tokenMatches, namesMatch, validateName } = require('../lib/names');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function assertEqual(a, b, label) {
  if (a === b) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}  (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
    failed++;
  }
}

// ── normalize ─────────────────────────────────────────────────────────────────
console.log('\nnormalize():');
assertEqual(normalize('Miha Novak'),    'miha novak',  'Miha Novak → miha novak');
assertEqual(normalize('miha nOvak'),    'miha novak',  'miha nOvak → miha novak');
assertEqual(normalize('ŠUŠTAR ANA'),    'sustar ana',  'ŠUŠTAR ANA → sustar ana');
assertEqual(normalize('Šuštar Ana'),    'sustar ana',  'Šuštar Ana → sustar ana');
assertEqual(normalize('Sustar Ana'),    'sustar ana',  'Sustar Ana → sustar ana');
assertEqual(normalize('đorđe Perić'),   'dorde peric', 'đorđe Perić (đ mapping)');
assertEqual(normalize('  Ana   Kos  '), 'ana kos',     'trims and collapses spaces');
assertEqual(normalize(''),              '',            'empty string');

// ── levenshtein ───────────────────────────────────────────────────────────────
console.log('\nlevenshtein():');
assertEqual(levenshtein('miha', 'miha'),    0, 'miha = miha');
assertEqual(levenshtein('mihaa', 'miha'),   1, 'mihaa → miha (delete)');
assertEqual(levenshtein('misha', 'miha'),   1, 'misha → miha (delete)');
assertEqual(levenshtein('miha', 'mia'),     1, 'miha → mia (delete)');
assertEqual(levenshtein('novak', 'navak'),  1, 'novak → navak (subst)');
assertEqual(levenshtein('abc', 'xyz'),      3, 'abc → xyz');
assertEqual(levenshtein('', 'abc'),         3, 'empty → abc');
assertEqual(levenshtein('abc', ''),         3, 'abc → empty');

// ── tokenMatches ──────────────────────────────────────────────────────────────
console.log('\ntokenMatches():');
assert( tokenMatches('miha',  'miha'),  'equal');
assert( tokenMatches('m',     'miha'),  'm prefix of miha');
assert( tokenMatches('miha',  'm'),     'miha starts with m');
assert( tokenMatches('n',     'novak'), 'n prefix of novak');
assert( tokenMatches('mihaa', 'miha'),  'mihaa→miha lev 1, len≥4');
assert( tokenMatches('navak', 'novak'), 'navak→novak lev 1, len≥4');
assert(!tokenMatches('mih',   'novak'), 'mih vs novak: no match');
assert(!tokenMatches('abc',   'xyz'),   'abc vs xyz: no match');
// Short tokens: levenshtein NOT applied for length < 4
assert(!tokenMatches('mih',  'mia'),    'len<4, lev=1 should NOT match');
assert( tokenMatches('mi',   'mi'),     'equal short tokens');
assert( tokenMatches('m',    'm'),      'single char equal');

// ── namesMatch ────────────────────────────────────────────────────────────────
console.log('\nnamesMatch() — required cases against "Miha Novak":');
const MIHA = normalize('Miha Novak'); // 'miha novak'
assert( namesMatch(normalize('miha nOvak'),   MIHA), '"miha nOvak"   matches Miha Novak');
assert( namesMatch(normalize('Miha N'),       MIHA), '"Miha N"       matches Miha Novak');
assert( namesMatch(normalize('M Novak'),      MIHA), '"M Novak"      matches Miha Novak');
assert( namesMatch(normalize('Novak Miha'),   MIHA), '"Novak Miha"   matches Miha Novak (reversed)');
assert( namesMatch(normalize('Mihaa Novak'),  MIHA), '"Mihaa Novak"  matches Miha Novak (typo)');

console.log('\nnamesMatch() — diacritics:');
const SUSTAR = normalize('Sustar Ana');
assert( namesMatch(normalize('Šuštar Ana'), SUSTAR), '"Šuštar Ana" matches "Sustar Ana"');

console.log('\nnamesMatch() — non-matches:');
assert(!namesMatch(normalize('Ana'),       MIHA), 'single token: no match');
assert(!namesMatch(normalize('Maja Kos'),  MIHA), '"Maja Kos" does not match Miha Novak');

// ── "Ana K" / "Ana Kos" ambiguity ────────────────────────────────────────────
console.log('\nLogin flow — "Ana K" vs "Ana Kos":');
const ANA_KOS = normalize('Ana Kos');
const ANA_K   = normalize('Ana K');
// "Ana K" should match "Ana Kos" as a candidate
assert( namesMatch(ANA_K, ANA_KOS), '"Ana K" is a candidate match for "Ana Kos"');
// But the normalized strings are NOT equal, so it must NOT auto-login
assert( ANA_K !== ANA_KOS, '"ana k" !== "ana kos" → requires candidate confirmation');

// ── validateName ──────────────────────────────────────────────────────────────
console.log('\nvalidateName():');
assert( validateName('Miha Novak'),  'valid: two tokens');
assert( validateName('Miha L'),      'valid: initial as second token');
assert( validateName('M Novak'),     'valid: initial as first token');
assert(!validateName('Miha'),        'invalid: only one token');
assert(!validateName('   '),         'invalid: only spaces');
assert(!validateName(''),            'invalid: empty string');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nSome tests FAILED');
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed ✓');
}
