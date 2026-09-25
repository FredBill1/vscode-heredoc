import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSemanticAppearance, SemanticThemeRules, TokenAppearance } from '../semanticTheme';

function theme(
  themeRules: Record<string, string | TokenAppearance>,
  userRules: Record<string, string | TokenAppearance> = {},
  superTypes: Record<string, string> = {},
): SemanticThemeRules {
  return {
    semanticThemeColors: themeRules,
    semanticUserColors: userRules,
    semanticTokenTypeSupertypes: superTypes,
  };
}

test('semantic selectors match arbitrary modifiers, wildcard types, and languages', () => {
  const rules = theme({
    '*': '#111111',
    '*.decorator': '#222222',
    'function.decorator': '#333333',
    'function.decorator:python': '#444444',
    'function.decorator.async:python': '#555555',
  });
  assert.deepEqual(resolveSemanticAppearance(rules, 'function',
    new Set(['decorator', 'async', 'declaration']), 'python'), { foreground: '#555555' });
  assert.deepEqual(resolveSemanticAppearance(rules, 'function',
    new Set(['decorator', 'declaration']), 'python'), { foreground: '#444444' });
  assert.deepEqual(resolveSemanticAppearance(rules, 'variable',
    new Set(['decorator']), 'python'), { foreground: '#222222' });
  assert.deepEqual(resolveSemanticAppearance(rules, 'function',
    new Set(['decorator']), 'typescript'), { foreground: '#333333' });
});

test('derived semantic token types match parent selectors with the right specificity', () => {
  const rules = theme({
    'method': '#111111',
    'method.static': '#222222',
    'customCall': '#333333',
    'function': '#444444',
  }, {}, { customCall: 'method', method: 'function' });
  assert.deepEqual(resolveSemanticAppearance(rules, 'customCall', new Set(['static']), 'python'),
    { foreground: '#222222' });
  assert.deepEqual(resolveSemanticAppearance(rules, 'customCall', new Set(), 'python'),
    { foreground: '#333333' });
});

test('theme and user selectors merge each property by score, then use TextMate fallback', () => {
  const rules = theme({
    'variable': { foreground: '#111111', italic: true },
    'variable.readonly': { foreground: '#222222' },
  }, {
    'variable': { foreground: '#333333', bold: true },
    'variable.readonly': { italic: false },
  });
  assert.deepEqual(resolveSemanticAppearance(rules, 'variable', new Set(['readonly']), 'python', {
    foreground: '#aaaaaa', bold: false, italic: true, underline: true, strikethrough: false,
  }), {
    foreground: '#222222', bold: true, italic: false, underline: true, strikethrough: false,
  });
});

test('a user rule at equal specificity overrides only the properties it names', () => {
  const rules = theme({
    'function:python': { foreground: '#111111', italic: true },
  }, {
    'function:python': { italic: false, underline: true },
  });
  assert.deepEqual(resolveSemanticAppearance(rules, 'function', new Set(), 'python'), {
    foreground: '#111111', italic: false, underline: true,
  });
  assert.equal(resolveSemanticAppearance(rules, 'function', new Set(), 'yaml'), undefined);
});

test('inherited and scoped duplicate selectors retain their order and unaffected properties', () => {
  const rules: SemanticThemeRules = {
    ...theme({ 'function': { bold: true } }, { 'function': { underline: true } }),
    semanticThemeRuleEntries: [
      { selector: 'function', appearance: { foreground: '#111111', italic: true } },
      { selector: 'function', appearance: { bold: true } },
    ],
    semanticUserRuleEntries: [
      { selector: 'function', appearance: { foreground: '#222222' } },
      { selector: 'function', appearance: { italic: false } },
    ],
  };
  assert.deepEqual(resolveSemanticAppearance(rules, 'function', new Set(), 'python'), {
    foreground: '#222222', italic: false, bold: true,
  });
});

test('invalid selectors and cycles in contributed type hierarchy do not apply or hang', () => {
  const rules = theme({
    'type..readonly': '#111111',
    'type:python:yaml': '#222222',
    'type.readonly': '#333333',
  }, {}, { type: 'custom', custom: 'type' });
  assert.deepEqual(resolveSemanticAppearance(rules, 'type', new Set(['readonly']), 'python'),
    { foreground: '#333333' });
});
