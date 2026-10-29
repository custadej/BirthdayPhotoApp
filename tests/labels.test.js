'use strict';

const assert = require('assert');
const Labels = require('../lib/labels');
const { SEED_TASKS } = require('../lib/seed-tasks');

let n = 0;
function t(name, fn) { fn(); n++; console.log(`  PASS  ${name}`); }

t('ordinals 1-10', () => {
  const w = ['Prva', 'Druga', 'Tretja', 'Četrta', 'Peta', 'Šesta', 'Sedma', 'Osma', 'Deveta', 'Deseta'];
  w.forEach((x, i) => assert.strictEqual(Labels.ordinalLabel(i + 1), `${x} slika`));
});
t('ordinal above 10 uses "n. slika"', () => {
  assert.strictEqual(Labels.ordinalLabel(11), '11. slika');
  assert.strictEqual(Labels.ordinalLabel(25), '25. slika');
});
t('label without caption or task uses ordinal', () => {
  assert.strictEqual(Labels.photoLabel({ caption: null, ordinal: 3, name: 'Ana K' }), 'Tretja slika - Ana K');
  assert.strictEqual(Labels.photoLabel({ caption: '   ', ordinal: 1, name: 'Ana K' }), 'Prva slika - Ana K');
});
t('caption: "{caption} - {Name}", no second line without task', () => {
  assert.deepStrictEqual(Labels.describe({ caption: 'Torta!', ordinal: 3, name: 'Ana K' }), { label: 'Torta! - Ana K', task: '' });
});
t('caption + task: second line "Naloga: {task_text}"', () => {
  assert.deepStrictEqual(
    Labels.describe({ caption: 'Torta!', ordinal: 3, name: 'Ana K', taskText: 'Slikaj torto ali sladico', taskLabel: 'Slika torte ali sladice' }),
    { label: 'Torta! - Ana K', task: 'Naloga: Slikaj torto ali sladico' });
});
t('task without caption: task_label as the title, no second line', () => {
  assert.deepStrictEqual(
    Labels.describe({ caption: null, ordinal: 2, name: 'Jana Novak', taskText: 'Slikaj nekoga, ki pleše', taskLabel: 'Slika nekoga, ki pleše' }),
    { label: 'Slika nekoga, ki pleše - Jana Novak', task: '' });
});
t('task without label falls back to task_text', () => {
  assert.strictEqual(Labels.describe({ ordinal: 2, name: 'Jana Novak', taskText: 'Slikaj nekoga, ki pleše', taskLabel: null }).label, 'Slikaj nekoga, ki pleše - Jana Novak');
  assert.strictEqual(Labels.describe({ ordinal: 2, name: 'Jana Novak', taskText: 'Slikaj nekoga, ki pleše', taskLabel: '  ' }).label, 'Slikaj nekoga, ki pleše - Jana Novak');
});
t('cleanCaption trims, caps at 140, empty -> null', () => {
  assert.strictEqual(Labels.cleanCaption('  hej  '), 'hej');
  assert.strictEqual(Labels.cleanCaption('   '), null);
  assert.strictEqual(Labels.cleanCaption(undefined), null);
  assert.strictEqual(Array.from(Labels.cleanCaption('č'.repeat(300))).length, 140);
});
t('taskLine', () => {
  assert.strictEqual(Labels.taskLine('Slikaj torto ali sladico'), 'Naloga: Slikaj torto ali sladico');
  assert.strictEqual(Labels.taskLine(null), '');
});
t('captionForTask: untouched prefill (any case, padded) becomes null', () => {
  assert.strictEqual(Labels.captionForTask('Slika nekoga, ki pleše', 'Slika nekoga, ki pleše'), null);
  assert.strictEqual(Labels.captionForTask('  SLIKA NEKOGA, KI PLEŠE ', 'Slika nekoga, ki pleše'), null);
  assert.strictEqual(Labels.captionForTask('', 'Slika nekoga, ki pleše'), null);
});
t('captionForTask: changed text is kept', () => {
  assert.strictEqual(Labels.captionForTask('Slika plesalcev na odru', 'Slika nekoga, ki pleše'), 'Slika plesalcev na odru');
  assert.strictEqual(Labels.captionForTask('Moj opis', ''), 'Moj opis');
});
t('seed list: 37 tasks, every one with text and label', () => {
  assert.strictEqual(SEED_TASKS.length, 37);
  assert.ok(SEED_TASKS.every(x => x.text && x.label));
  assert.strictEqual(SEED_TASKS[0].label, 'Slika nekoga, ki pleše');
});

console.log(`\nLabels results: ${n} passed`);
