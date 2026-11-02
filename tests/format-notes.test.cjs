const test = require('node:test');
const assert = require('node:assert/strict');

test('release-notes preview keeps a few short bullets and drops headings', async () => {
  const { summarizeNotes } = await import('../src/lib/format.js');
  const notes = 'CHANGED\n• First change.\n• Second change.\n• Third change.\n\nFIXED\n• Fourth change.';
  const preview = summarizeNotes(notes);
  assert.deepEqual(preview.lines, ['First change.', 'Second change.', 'Third change.']);
  assert.equal(preview.more, 1);
});

test('long bullets are trimmed on a word boundary and very long notes stay short', async () => {
  const { summarizeNotes } = await import('../src/lib/format.js');
  const long = '• ' + 'word '.repeat(200);
  const preview = summarizeNotes(long.repeat(10));
  assert.ok(preview.lines.every(line => line.length <= 71 && line.endsWith('\u2026')));
  assert.equal(summarizeNotes('no bullets here').lines.length, 0);
  assert.equal(summarizeNotes(null).more, 0);
});
