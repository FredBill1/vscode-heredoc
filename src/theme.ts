import * as vscode from 'vscode';
import * as textmate from 'vscode-textmate';
import { parse as parseJsonc } from 'jsonc-parser';
import { SemanticThemeRule, SemanticThemeRules, TokenAppearance } from './semanticTheme';

export { resolveSemanticAppearance, semanticAppearance } from './semanticTheme';
export type { TokenAppearance } from './semanticTheme';

export interface ResolvedTheme extends SemanticThemeRules {
  readonly textmate: textmate.IRawTheme;
  readonly found: boolean;
  readonly hasBaseForeground: boolean;
  readonly semanticHighlighting: boolean;
  readonly semanticTokenColors: Readonly<Record<string, string | TokenAppearance>>;
}

interface ThemeContribution {
  readonly label?: string;
  readonly id?: string;
  readonly path?: string;
  readonly uiTheme?: string;
}

interface ThemeContents {
  colors: Record<string, string>;
  tokenColors: textmate.IRawTheme['settings'];
  semanticTokenColors: Record<string, string | TokenAppearance>;
  semanticTokenRuleEntries: SemanticThemeRule[];
  semanticHighlighting?: boolean;
}

const COLOR_CUSTOMIZATION_SCOPES: Readonly<Record<string, string[]>> = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'punctuation.definition.string'],
  keywords: ['keyword', 'storage'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'support.type', 'storage.type'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'support.variable'],
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function color(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[\da-fA-F]{3,8}$/.test(value) ? value : undefined;
}

function tokenRules(value: unknown): textmate.IRawTheme['settings'] {
  if (!Array.isArray(value)) { return []; }
  return value.flatMap(entry => {
    const item = record(entry);
    const settings = record(item.settings);
    if (!Object.keys(settings).length) { return []; }
    const rule: {
      name?: string;
      scope?: string | string[];
      settings: { foreground?: string; background?: string; fontStyle?: string };
    } = { settings: {} };
    if (typeof item.name === 'string') { rule.name = item.name; }
    if (typeof item.scope === 'string' ||
      (Array.isArray(item.scope) && item.scope.every(scope => typeof scope === 'string'))) {
      rule.scope = item.scope as string | string[];
    }
    if (color(settings.foreground)) { rule.settings.foreground = color(settings.foreground); }
    if (color(settings.background)) { rule.settings.background = color(settings.background); }
    if (typeof settings.fontStyle === 'string') { rule.settings.fontStyle = settings.fontStyle; }
    return [rule];
  });
}

function semanticRules(value: unknown): Record<string, string | TokenAppearance> {
  const rules: Record<string, string | TokenAppearance> = {};
  for (const [selector, raw] of Object.entries(record(value))) {
    if (color(raw)) {
      rules[selector] = color(raw)!;
      continue;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { continue; }
    const item = record(raw);
    const appearance: {
      foreground?: string;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      strikethrough?: boolean;
    } = {};
    if (color(item.foreground)) { appearance.foreground = color(item.foreground); }
    for (const key of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
      if (typeof item[key] === 'boolean') { appearance[key] = item[key] as boolean; }
    }
    if (typeof item.fontStyle === 'string') {
      const words = new Set(item.fontStyle.split(/\s+/));
      appearance.bold = words.has('bold');
      appearance.italic = words.has('italic');
      appearance.underline = words.has('underline');
      appearance.strikethrough = words.has('strikethrough');
    }
    if (Object.keys(appearance).length) { rules[selector] = appearance; }
  }
  return rules;
}

function semanticRuleEntries(value: unknown): SemanticThemeRule[] {
  return Object.entries(semanticRules(value)).map(([selector, appearance]) => ({ selector, appearance }));
}

function scopedSemanticRuleEntries(value: unknown, label: string): SemanticThemeRule[] {
  const all = record(value);
  const entries = semanticRuleEntries(all.rules);
  for (const [key, scoped] of Object.entries(all)) {
    if (key.startsWith('[') && [...key.matchAll(/\[([^\]]+)\]/g)].some(match => match[1] === label)) {
      entries.push(...semanticRuleEntries(record(scoped).rules));
    }
  }
  return entries;
}

function themeSpecific(value: unknown, label: string): Record<string, unknown> {
  const all = record(value);
  const selected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(all)) {
    if (!key.startsWith('[')) { selected[key] = entry; }
  }
  for (const [key, entry] of Object.entries(all)) {
    if (key.startsWith('[') && [...key.matchAll(/\[([^\]]+)\]/g)].some(match => match[1] === label)) {
      for (const [name, specific] of Object.entries(record(entry))) {
        if (name === 'textMateRules' && Array.isArray(selected[name]) && Array.isArray(specific)) {
          selected[name] = [...selected[name] as unknown[], ...specific];
        } else if (name === 'rules') {
          selected[name] = { ...record(selected[name]), ...record(specific) };
        } else {
          selected[name] = specific;
        }
      }
    }
  }
  return selected;
}

function choiceForCurrentTheme(): { extension: vscode.Extension<unknown>; path: string } | undefined {
  const configured = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme', '');
  const names = new Set([configured, configured.replace(/^Default\s+/i, '')]);
  const kind = vscode.window.activeColorTheme.kind;
  const candidates: { extension: vscode.Extension<unknown>; contribution: ThemeContribution }[] = [];
  for (const extension of vscode.extensions.all) {
    const contributions = extension.packageJSON?.contributes?.themes;
    if (!Array.isArray(contributions)) { continue; }
    for (const contribution of contributions as ThemeContribution[]) {
      if (contribution?.path &&
        (names.has(contribution.label ?? '') || names.has(contribution.id ?? ''))) {
        candidates.push({ extension, contribution });
      }
    }
  }
  const selected = candidates.find(candidate => {
    const uiTheme = candidate.contribution.uiTheme;
    return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
      ? uiTheme === 'vs' || uiTheme === 'hc-light'
      : uiTheme === 'vs-dark' || uiTheme === 'hc-black';
  }) ?? candidates[0];
  return selected?.contribution.path
    ? { extension: selected.extension, path: selected.contribution.path } : undefined;
}

function tokenTypeSupertypes(): Record<string, string> {
  // VS Code's built-in deprecated `member` token type inherits from `method`.
  const superTypes: Record<string, string> = Object.create(null);
  superTypes.member = 'method';
  for (const extension of vscode.extensions.all) {
    const contributions = extension.packageJSON?.contributes?.semanticTokenTypes;
    if (!Array.isArray(contributions)) { continue; }
    for (const contribution of contributions) {
      if (typeof contribution?.id === 'string' && typeof contribution?.superType === 'string') {
        superTypes[contribution.id] = contribution.superType;
      }
    }
  }
  return superTypes;
}

/** Read JSONC or TextMate plist themes, including inherited color themes. */
export class ThemeLoader {
  constructor(private readonly output: vscode.OutputChannel) {}

  async load(override?: { uri: vscode.Uri; label: string }): Promise<ResolvedTheme> {
    const selected = choiceForCurrentTheme();
    const label = override?.label ?? vscode.workspace.getConfiguration('workbench').get<string>('colorTheme', '');
    let found = false;
    let contents: ThemeContents = {
      colors: {}, tokenColors: [], semanticTokenColors: {}, semanticTokenRuleEntries: [],
      semanticHighlighting: undefined,
    };
    if (selected || override) {
      const uri = override?.uri ?? vscode.Uri.joinPath(selected!.extension.extensionUri, selected!.path);
      try {
        contents = await this.readTheme(uri, new Set());
        found = true;
      } catch (error) {
        this.output.appendLine(`Cannot read color theme ${label}: ${String(error)}`);
      }
    }

    const uiCustom = themeSpecific(
      vscode.workspace.getConfiguration('workbench').get<unknown>('colorCustomizations'), label,
    );
    const tokenCustom = themeSpecific(
      vscode.workspace.getConfiguration('editor').get<unknown>('tokenColorCustomizations'), label,
    );
    const semanticCustom = themeSpecific(
      vscode.workspace.getConfiguration('editor').get<unknown>('semanticTokenColorCustomizations'), label,
    );
    const foreground = color(uiCustom['editor.foreground']) ?? color(contents.colors['editor.foreground']);
    const settings: textmate.IRawTheme['settings'] = [
      ...(foreground ? [{ settings: { foreground } }] : []),
      ...contents.tokenColors,
    ];
    for (const [key, scopes] of Object.entries(COLOR_CUSTOMIZATION_SCOPES)) {
      const foreground = color(tokenCustom[key]);
      if (foreground) { settings.push({ scope: scopes, settings: { foreground } }); }
    }
    settings.push(...tokenRules(tokenCustom.textMateRules));
    const hasBaseForeground = settings.some(rule => !rule.scope && color(rule.settings.foreground));
    const semanticThemeRuleEntries = contents.semanticTokenRuleEntries;
    const semanticUserRuleEntries = scopedSemanticRuleEntries(
      vscode.workspace.getConfiguration('editor').get<unknown>('semanticTokenColorCustomizations'), label,
    );
    const semanticThemeColors = contents.semanticTokenColors;
    const semanticUserColors = Object.fromEntries(semanticUserRuleEntries.map(
      ({ selector, appearance }) => [selector, appearance],
    ));
    const semanticTokenColors = { ...semanticThemeColors, ...semanticUserColors };
    const semanticHighlighting = typeof semanticCustom.enabled === 'boolean'
      ? semanticCustom.enabled
      : typeof tokenCustom.semanticHighlighting === 'boolean'
        ? tokenCustom.semanticHighlighting
        : contents.semanticHighlighting ?? false;
    return {
      textmate: { settings },
      found,
      hasBaseForeground,
      semanticHighlighting,
      semanticTokenColors,
      semanticThemeColors,
      semanticUserColors,
      semanticThemeRuleEntries,
      semanticUserRuleEntries,
      semanticTokenTypeSupertypes: tokenTypeSupertypes(),
    };
  }

  private async readTheme(uri: vscode.Uri, seen: Set<string>): Promise<ThemeContents> {
    const key = uri.toString();
    if (seen.has(key)) { throw new Error(`Circular theme include: ${key}`); }
    seen.add(key);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const source = Buffer.from(bytes).toString('utf8');
      const errors: import('jsonc-parser').ParseError[] = [];
      const raw = uri.path.toLowerCase().endsWith('.tmtheme')
        ? textmate.parseRawGrammar(source, uri.path) as unknown
        : parseJsonc(source, errors, { allowTrailingComma: true });
      if (errors.length) { throw new Error(`Invalid JSONC theme: ${uri.toString()}`); }
      const theme = record(raw);
      if (!Object.keys(theme).length) { throw new Error(`Empty or invalid color theme: ${uri.toString()}`); }
      let base: ThemeContents = {
        colors: {}, tokenColors: [], semanticTokenColors: {}, semanticTokenRuleEntries: [],
        semanticHighlighting: undefined,
      };
      if (typeof theme.include === 'string') {
        base = await this.readTheme(vscode.Uri.joinPath(uri, '..', theme.include), seen);
      }
      const fromFile = typeof theme.tokenColors === 'string'
        ? await this.readTokenFile(vscode.Uri.joinPath(uri, '..', theme.tokenColors))
        : tokenRules(theme.tokenColors ?? theme.settings);
      const ownColors: Record<string, string> = {};
      for (const [id, value] of Object.entries(record(theme.colors))) {
        if (color(value)) { ownColors[id] = color(value)!; }
      }
      return {
        colors: { ...base.colors, ...ownColors },
        tokenColors: [...base.tokenColors, ...fromFile],
        semanticTokenColors: { ...base.semanticTokenColors, ...semanticRules(theme.semanticTokenColors) },
        semanticTokenRuleEntries: [
          ...base.semanticTokenRuleEntries, ...semanticRuleEntries(theme.semanticTokenColors),
        ],
        semanticHighlighting: typeof theme.semanticHighlighting === 'boolean'
          ? theme.semanticHighlighting : base.semanticHighlighting,
      };
    } finally {
      seen.delete(key);
    }
  }

  private async readTokenFile(uri: vscode.Uri): Promise<textmate.IRawTheme['settings']> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const source = Buffer.from(bytes).toString('utf8');
    const errors: import('jsonc-parser').ParseError[] = [];
    const raw = uri.path.toLowerCase().endsWith('.tmtheme')
      ? textmate.parseRawGrammar(source, uri.path) as unknown
      : parseJsonc(source, errors, { allowTrailingComma: true });
    if (errors.length) { throw new Error(`Invalid JSONC token color file: ${uri.toString()}`); }
    const data = record(raw);
    return tokenRules(data.settings ?? data.tokenColors);
  }
}
