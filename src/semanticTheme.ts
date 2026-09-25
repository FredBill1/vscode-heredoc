/** The subset of VS Code token styles that decorations can reproduce. */
export interface TokenAppearance {
  readonly foreground?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
}

export interface SemanticThemeRule {
  readonly selector: string;
  readonly appearance: string | TokenAppearance;
}

/** Keep theme and user rules separate: equal-specificity user rules are applied last. */
export interface SemanticThemeRules {
  readonly semanticThemeColors: Readonly<Record<string, string | TokenAppearance>>;
  readonly semanticUserColors: Readonly<Record<string, string | TokenAppearance>>;
  readonly semanticTokenTypeSupertypes: Readonly<Record<string, string>>;
  /** Ordered entries preserve duplicate selectors in inherited or scoped themes. */
  readonly semanticThemeRuleEntries?: readonly SemanticThemeRule[];
  readonly semanticUserRuleEntries?: readonly SemanticThemeRule[];
}

const STYLE_PROPERTIES = [
  'foreground', 'bold', 'italic', 'underline', 'strikethrough',
] as const satisfies readonly (keyof TokenAppearance)[];

const IDENTIFIER = /^\w[-\w+]*$/;

function selectorScore(
  selector: string, hierarchy: readonly string[], modifiers: ReadonlySet<string>, languageId: string,
): number {
  const [classifier, selectorLanguage, extraLanguage] = selector.split(':');
  if (!classifier || extraLanguage !== undefined ||
    (selectorLanguage !== undefined && (!IDENTIFIER.test(selectorLanguage) || selectorLanguage !== languageId))) {
    return -1;
  }
  const [selectorType, ...selectorModifiers] = classifier.split('.');
  if ((!IDENTIFIER.test(selectorType) && selectorType !== '*') ||
    selectorModifiers.some(modifier => !IDENTIFIER.test(modifier) || !modifiers.has(modifier))) {
    return -1;
  }
  let score = selectorLanguage === undefined ? 0 : 10;
  if (selectorType !== '*') {
    const level = hierarchy.indexOf(selectorType);
    if (level < 0) { return -1; }
    score += 100 - level;
  }
  return score + selectorModifiers.length * 100;
}

function typeHierarchy(type: string, superTypes: Readonly<Record<string, string>>): string[] {
  const hierarchy = [type];
  const seen = new Set(hierarchy);
  let current = type;
  while (Object.prototype.hasOwnProperty.call(superTypes, current) &&
    typeof superTypes[current] === 'string' && !seen.has(superTypes[current])) {
    current = superTypes[current];
    hierarchy.push(current);
    seen.add(current);
  }
  return hierarchy;
}

/**
 * Mirror ColorThemeData.getTokenStyle: each property has its own highest-scoring
 * selector, theme rules precede user rules, and TextMate defaults fill only holes.
 */
export function resolveSemanticAppearance(
  theme: SemanticThemeRules,
  type: string,
  modifiers: ReadonlySet<string>,
  languageId: string,
  fallback?: TokenAppearance,
): TokenAppearance | undefined {
  const hierarchy = typeHierarchy(type, theme.semanticTokenTypeSupertypes);
  const result: Record<string, string | boolean | undefined> = {};
  const scores: Record<string, number> = {};
  for (const property of STYLE_PROPERTIES) { scores[property] = -1; }

  const themeEntries = theme.semanticThemeRuleEntries ??
    Object.entries(theme.semanticThemeColors).map(([selector, appearance]) => ({ selector, appearance }));
  const userEntries = theme.semanticUserRuleEntries ??
    Object.entries(theme.semanticUserColors).map(([selector, appearance]) => ({ selector, appearance }));
  for (const rules of [themeEntries, userEntries]) {
    for (const { selector, appearance: raw } of rules) {
      const score = selectorScore(selector, hierarchy, modifiers, languageId);
      if (score < 0) { continue; }
      const style: TokenAppearance = typeof raw === 'string' ? { foreground: raw } : raw;
      for (const property of STYLE_PROPERTIES) {
        const value = style[property];
        if (value !== undefined && score >= scores[property]) {
          result[property] = value;
          scores[property] = score;
        }
      }
    }
  }

  if (fallback) {
    for (const property of STYLE_PROPERTIES) {
      if (result[property] === undefined && fallback[property] !== undefined) {
        result[property] = fallback[property];
      }
    }
  }
  return Object.keys(result).length ? result as TokenAppearance : undefined;
}

/** Compatibility helper for call sites that only have one source of semantic rules. */
export function semanticAppearance(
  rules: Readonly<Record<string, string | TokenAppearance>>,
  type: string,
  modifiers: ReadonlySet<string>,
  languageId: string,
): TokenAppearance | undefined {
  return resolveSemanticAppearance({
    semanticThemeColors: rules,
    semanticUserColors: {},
    semanticTokenTypeSupertypes: {},
  }, type, modifiers, languageId);
}
