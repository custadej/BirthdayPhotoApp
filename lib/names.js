'use strict';

/**
 * Normalize a name string for fuzzy matching:
 * - NFD decomposition to separate base chars from combining marks
 * - Map đ/Đ → d/D (no canonical decomposition in Unicode)
 * - Strip combining marks (accents, etc.)
 * - Lowercase
 * - Replace non-letter chars with space
 * - Collapse multiple spaces, trim
 */
function normalize(s) {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFD')
    .replace(/[đĐ]/g, m => (m === 'đ' ? 'd' : 'D'))
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokenize a normalized name string */
function tokenize(s) {
  return normalize(s).split(' ').filter(Boolean);
}

/** Standard Levenshtein edit distance */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = edit distance between a[0..i-1] and b[0..j-1]
  const dp = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = new Array(n + 1).fill(0);
    dp[i][0] = i;
  }
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Two normalized tokens match if:
 * - They are equal, OR
 * - One is a prefix of the other (min 1 char), OR
 * - Both have length >= 4 and Levenshtein distance <= 1
 */
function tokenMatches(a, b) {
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  if (a.length >= 4 && b.length >= 4 && levenshtein(a, b) <= 1) return true;
  return false;
}

/**
 * Check whether two normalized name strings match.
 * Uses only the FIRST and LAST token of each name.
 * Tries both normal and reversed order.
 *
 * @param {string} norm1 - already-normalized name
 * @param {string} norm2 - already-normalized name
 */
function namesMatch(norm1, norm2) {
  const t1 = norm1.split(' ').filter(Boolean);
  const t2 = norm2.split(' ').filter(Boolean);
  if (t1.length < 2 || t2.length < 2) return false;

  const a1 = t1[0];
  const a2 = t1[t1.length - 1];
  const b1 = t2[0];
  const b2 = t2[t2.length - 1];

  // Normal order: first↔first, last↔last
  if (tokenMatches(a1, b1) && tokenMatches(a2, b2)) return true;
  // Reversed: first↔last, last↔first  (handles "Novak Miha" matching "Miha Novak")
  if (tokenMatches(a1, b2) && tokenMatches(a2, b1)) return true;
  return false;
}

/**
 * Validate that a raw name string produces at least 2 tokens.
 * Returns true if valid, false if not (show Slovenian error to user).
 */
function validateName(rawName) {
  return tokenize(rawName).length >= 2;
}

module.exports = { normalize, tokenize, levenshtein, tokenMatches, namesMatch, validateName };
