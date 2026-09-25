import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuleResolver, presets } from '../rules.js';

const languages = new Set([
  'python', 'yaml', 'shellscript', 'typescript', 'javascript', 'json',
  'sql', 'html', 'css', 'xml', 'markdown', 'ruby', 'go', 'rust', 'my-language',
]);

test('all fourteen preset language groups use case-insensitive full delimiter matching', () => {
  const resolver = new RuleResolver([], true, languages);
  assert.equal(presets.length, 14);
  for (const [delimiter, language] of [
    ['py', 'python'], ['yaml', 'yaml'], ['BASH', 'shellscript'],
    ['ts', 'typescript'], ['javascript', 'javascript'], ['JSON', 'json'],
    ['SQL', 'sql'], ['HTM', 'html'], ['css', 'css'], ['xml', 'xml'],
    ['MD', 'markdown'], ['ruby', 'ruby'], ['GOLANG', 'go'], ['rs', 'rust'],
  ]) {
    assert.equal(resolver.resolve(delimiter)?.languageId, language, delimiter);
  }
  assert.equal(resolver.resolve('PY_SUFFIX'), undefined);
  assert.equal(resolver.resolve('PYTHON3'), undefined);
});

test('user rules precede presets and preserve the first matching rule', () => {
  const resolver = new RuleResolver([
    { pattern: 'PY|CONFIG', languageId: 'my-language', documentMode: 'file' },
    { pattern: 'PY', languageId: 'yaml' },
  ], true, languages);
  assert.deepEqual(resolver.resolve('PY'), {
    languageId: 'my-language', documentMode: 'file', preset: false,
  });
  assert.equal(resolver.resolve('YAML')?.languageId, 'yaml');
});

test('disabling presets does not imply automatic languageId matching', () => {
  const resolver = new RuleResolver([], false, languages);
  assert.equal(resolver.resolve('python'), undefined);
});

test('invalid patterns, modes and unknown languages are reported and ignored', () => {
  const errors: string[] = [];
  const resolver = new RuleResolver([
    { pattern: '(', languageId: 'python' },
    { pattern: 'FOO', languageId: 'absent' },
    { pattern: 'BAR', languageId: 'python', documentMode: 'bogus' },
    { pattern: 'TEST', languageId: 'my-language', flags: 'i' },
  ], false, languages, error => errors.push(error));
  assert.equal(errors.length, 3);
  assert.equal(resolver.resolve('foo'), undefined);
  assert.equal(resolver.resolve('test')?.languageId, 'my-language');
});
