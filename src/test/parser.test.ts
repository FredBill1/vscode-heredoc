import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHeredocs } from '../parser.js';

const languages: Record<string, string> = {
  PY: 'python', PYTHON: 'python', YAML: 'yaml', SH: 'shellscript', BASH: 'shellscript',
};
const resolve = (delimiter: string): string | undefined => languages[delimiter];

test('removes single, double, backslash and mixed delimiter quoting', () => {
  const source = [
    "cat <<'P'\"Y\" <<\\YAML <<'P'Y'T'HON",
    'print(1)',
    'PY',
    'name: value',
    'YAML',
    'print(2)',
    'PYTHON',
    '',
  ].join('\n');
  const regions = parseHeredocs(source, resolve);
  assert.deepEqual(regions.map(({ delimiter, languageId, quoted, content }) => ({ delimiter, languageId, quoted, content })), [
    { delimiter: 'PY', languageId: 'python', quoted: true, content: 'print(1)\n' },
    { delimiter: 'YAML', languageId: 'yaml', quoted: true, content: 'name: value\n' },
    { delimiter: 'PYTHON', languageId: 'python', quoted: true, content: 'print(2)\n' },
  ]);
});

test('matches only a complete delimiter line and strips only leading tabs for <<-', () => {
  const source = 'cat <<-PY\n\tprint(1)\n \tPY\n\tPY \n\tPY\n';
  const [region] = parseHeredocs(source, resolve);
  assert.equal(region.content, 'print(1)\n \tPY\nPY \n');
  assert.equal(region.bodyEnd, source.lastIndexOf('\tPY\n'));
  assert.equal(region.terminatorStart, region.bodyEnd);
  assert.equal(region.terminatorEnd, region.bodyEnd + 3);
  assert.equal(region.sourceOffsets.length, region.content.length + 1);
  for (let i = 0; i < region.content.length; i++) {
    assert.equal(source[region.sourceOffsets[i]], region.content[i]);
  }
  assert.equal(region.sourceOffsets[0], source.indexOf('print(1)'));
});

test('unquoted backslash-newline joins lines before checking the delimiter', () => {
  const interrupted = 'cat <<PY\nbody\\\nPY\nPY\n';
  const [region] = parseHeredocs(interrupted, resolve);
  assert.equal(region.content, 'body\\\nPY\n');
  assert.equal(region.terminatorStart, interrupted.lastIndexOf('PY\n'));

  const joined = 'cat <<PY\nprint(1)\nP\\\nY\n';
  const [joinedRegion] = parseHeredocs(joined, resolve);
  assert.equal(joinedRegion.content, 'print(1)\n');
  assert.equal(joinedRegion.terminatorStart, joined.indexOf('P\\\nY'));
  assert.equal(joinedRegion.terminatorEnd, joined.indexOf('Y\n', joinedRegion.terminatorStart) + 1);

  const quoted = "cat <<'PY'\nP\\\nY\nPY\n";
  const [quotedRegion] = parseHeredocs(quoted, resolve);
  assert.equal(quotedRegion.content, 'P\\\nY\n');
  assert.equal(quotedRegion.terminatorStart, quoted.lastIndexOf('PY\n'));
});

test('consumes several heredocs in FIFO order', () => {
  const source = 'cat <<PY <<YAML\nprint(1)\nPY\na: b\nYAML\n';
  const regions = parseHeredocs(source, resolve);
  assert.deepEqual(regions.map(({ delimiter, content }) => [delimiter, content]), [
    ['PY', 'print(1)\n'], ['YAML', 'a: b\n'],
  ]);
  assert.equal(regions[1].bodyStart, source.indexOf('a: b'));
});

test('ignores here strings, quoted text, comments and arithmetic shifts', () => {
  const source = [
    'echo <<<PY',
    "echo '<<PY' \"<<PY\" \\<<PY",
    '# cat <<PY',
    '((value << 2))',
    'echo $((value << 3))',
    'echo $[value << 4]',
    'echo foo#bar',
    'cat <<PY # comment',
    'print(1)',
    'PY',
    '',
  ].join('\n');
  const regions = parseHeredocs(source, resolve);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].content, 'print(1)\n');
});

test('finds heredocs inside a command substitution in double quotes', () => {
  const source = 'answer="$(cat <<PY\nprint(1)\nPY\n)"\necho done\n';
  const [region] = parseHeredocs(source, resolve);
  assert.equal(region.content, 'print(1)\n');
  assert.equal(region.openerStart, source.indexOf('<<PY'));
});

test('parses nested shell heredocs after finding the outer boundary', () => {
  const source = 'cat <<SH\ncat <<PY\nprint(1)\nPY\nSH\n';
  const regions = parseHeredocs(source, resolve);
  assert.deepEqual(regions.map(({ delimiter, depth }) => [delimiter, depth]), [['SH', 0], ['PY', 1]]);
  assert.equal(regions[0].content, 'cat <<PY\nprint(1)\nPY\n');
  assert.equal(regions[1].content, 'print(1)\n');
  assert.equal(regions[1].openerStart, source.indexOf('<<PY'));
});

test('nested ranges retain physical positions when parent strips tabs', () => {
  const source = 'cat <<-SH\n\tcat <<PY\n\tprint(1)\n\tPY\n\tSH\n';
  const regions = parseHeredocs(source, resolve);
  assert.deepEqual(regions.map(({ delimiter, depth }) => [delimiter, depth]), [['SH', 0], ['PY', 1]]);
  assert.equal(regions[0].content, 'cat <<PY\nprint(1)\nPY\n');
  assert.equal(regions[1].bodyStart, source.indexOf('\tprint(1)'));
  assert.equal(regions[1].bodyEnd, source.indexOf('\tPY\n'));
  assert.equal(regions[1].sourceOffsets[0], source.indexOf('print(1)'));
  assert.equal(regions[1].terminatorStart, source.indexOf('\tPY\n'));
  for (const region of regions) {
    assert.equal(region.sourceOffsets.length, region.content.length + 1);
    for (let i = 1; i < region.sourceOffsets.length; i++) {
      assert.ok(region.sourceOffsets[i] > region.sourceOffsets[i - 1], 'source offsets remain strictly increasing');
    }
    assert.equal(region.sourceOffsets.at(-1), region.bodyEnd);
  }
});

test('preserves CRLF content and UTF-16 positions', () => {
  const source = '😀\r\ncat <<PY\r\nprint(1)\r\nPY\r\n';
  const [region] = parseHeredocs(source, resolve);
  assert.equal(region.content, 'print(1)\r\n');
  assert.equal(region.openerStart, source.indexOf('<<PY'));
  assert.equal(region.sourceOffsets[region.content.length - 2], source.indexOf('\r\nPY'));
  assert.equal(region.bodyEnd, source.indexOf('PY\r\n', source.indexOf('print(1)')));
});

test('an unmatched outer heredoc still hides its body from shell parsing', () => {
  const source = 'cat <<DATA\ncat <<PY\nprint(1)\nPY\nDATA\n';
  assert.deepEqual(parseHeredocs(source, resolve), []);
});

test('reparsing after an incomplete heredoc recovers at its inserted terminator', () => {
  const incomplete = 'cat <<PY\nprint(1)\ncat <<YAML\na: b\n';
  const [before] = parseHeredocs(incomplete, resolve);
  assert.equal(before.content, 'print(1)\ncat <<YAML\na: b\n');
  assert.equal(before.terminatorStart, undefined);
  const complete = 'cat <<PY\nprint(1)\nPY\ncat <<YAML\na: b\nYAML\n';
  assert.deepEqual(parseHeredocs(complete, resolve).map(({ delimiter, content }) => [delimiter, content]), [
    ['PY', 'print(1)\n'], ['YAML', 'a: b\n'],
  ]);
});

test('an unterminated first heredoc consumes later queued delimiters as body text', () => {
  const source = 'cat <<PY <<YAML\nprint(1)\nYAML\n';
  const regions = parseHeredocs(source, resolve);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].delimiter, 'PY');
  assert.equal(regions[0].content, 'print(1)\nYAML\n');
  assert.equal(regions[0].terminatorStart, undefined);
});

test('finds command substitution heredocs with same-line and later-line openers', () => {
  const sameLine = 'value=$(echo start; cat <<PY\nprint(1)\nPY\n)\n';
  assert.equal(parseHeredocs(sameLine, resolve)[0].content, 'print(1)\n');
  const laterLine = 'value=$(\necho start\ncat <<PY\nprint(2)\nPY\n)\n';
  assert.equal(parseHeredocs(laterLine, resolve)[0].content, 'print(2)\n');
});

test('delays queued bodies over a continued command line', () => {
  const source = 'cat <<PY |\n  sed s/x/y/\nprint(1)\nPY\n';
  const [region] = parseHeredocs(source, resolve);
  assert.equal(region.content, 'print(1)\n');
  const escaped = 'cat <<PY \\\n  | cat\nprint(1)\nPY\n';
  assert.equal(parseHeredocs(escaped, resolve)[0].content, 'print(1)\n');
});

test('records an empty unterminated body when the opener is at EOF', () => {
  const source = 'cat <<PY';
  const [region] = parseHeredocs(source, resolve);
  assert.equal(region.content, '');
  assert.equal(region.bodyStart, source.length);
  assert.equal(region.bodyEnd, source.length);
  assert.equal(region.terminatorStart, undefined);
  assert.deepEqual(region.sourceOffsets, [source.length]);
});
