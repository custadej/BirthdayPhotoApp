'use strict';

const assert = require('assert');
const { createLimiter } = require('../lib/ratelimit');

let t = 1000;
const lim = createLimiter({ max: 5, windowMs: 600_000, now: () => t });
let n = 0;
function ok(name) { n++; console.log(`  PASS  ${name}`); }

for (let i = 0; i < 4; i++) lim.fail('a');
assert.strictEqual(lim.isBlocked('a'), false); ok('4 failures: not blocked');
lim.fail('a');
assert.strictEqual(lim.isBlocked('a'), true); ok('5 failures: blocked');
assert.strictEqual(lim.isBlocked('b'), false); ok('other keys unaffected');
t += 599_000;
assert.strictEqual(lim.isBlocked('a'), true); ok('still blocked inside the window');
t += 2_000;
assert.strictEqual(lim.isBlocked('a'), false); ok('unblocked after 10 minutes');

console.log(`\nRatelimit results: ${n} passed`);
