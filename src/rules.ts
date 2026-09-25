export type DocumentMode = 'auto' | 'virtual' | 'untitled' | 'file';

export interface RuleSetting {
  pattern: string;
  languageId: string;
  flags?: string;
  documentMode?: DocumentMode;
}

export interface ResolvedRule {
  languageId: string;
  documentMode: DocumentMode;
  preset: boolean;
}

interface CompiledRule {
  regex: RegExp;
  rule: ResolvedRule;
}

const PRESET_SETTINGS: readonly RuleSetting[] = [
  { pattern: 'PY|PYTHON', languageId: 'python', flags: 'i' },
  { pattern: 'YML|YAML', languageId: 'yaml', flags: 'i' },
  { pattern: 'SH|SHELL|BASH', languageId: 'shellscript', flags: 'i' },
  { pattern: 'TS|TYPESCRIPT', languageId: 'typescript', flags: 'i' },
  { pattern: 'JS|JAVASCRIPT', languageId: 'javascript', flags: 'i' },
  { pattern: 'JSON', languageId: 'json', flags: 'i' },
  { pattern: 'SQL', languageId: 'sql', flags: 'i' },
  { pattern: 'HTML|HTM', languageId: 'html', flags: 'i' },
  { pattern: 'CSS', languageId: 'css', flags: 'i' },
  { pattern: 'XML', languageId: 'xml', flags: 'i' },
  { pattern: 'MD|MARKDOWN', languageId: 'markdown', flags: 'i' },
  { pattern: 'RB|RUBY', languageId: 'ruby', flags: 'i' },
  { pattern: 'GO|GOLANG', languageId: 'go', flags: 'i' },
  { pattern: 'RS|RUST', languageId: 'rust', flags: 'i' },
];

export const presets = PRESET_SETTINGS;

/** Match delimiters as complete strings; user rules always precede presets. */
export class RuleResolver {
  private readonly rules: CompiledRule[] = [];

  constructor(
    userRules: unknown,
    enablePresets: boolean,
    knownLanguages?: ReadonlySet<string>,
    report: (message: string) => void = () => undefined,
  ) {
    const user = Array.isArray(userRules) ? userRules : [];
    for (let index = 0; index < user.length; index++) {
      this.add(user[index], false, knownLanguages, message => report(`heredoc.rules[${index}]: ${message}`));
    }
    if (enablePresets) {
      for (const setting of PRESET_SETTINGS) {
        this.add(setting, true, knownLanguages, report);
      }
    }
  }

  resolve(delimiter: string): ResolvedRule | undefined {
    for (const { regex, rule } of this.rules) {
      regex.lastIndex = 0;
      if (regex.test(delimiter)) {
        return rule;
      }
    }
    return undefined;
  }

  private add(
    candidate: unknown,
    preset: boolean,
    knownLanguages: ReadonlySet<string> | undefined,
    report: (message: string) => void,
  ): void {
    if (typeof candidate !== 'object' || candidate === null) {
      report('expected an object');
      return;
    }
    const setting = candidate as Partial<RuleSetting>;
    if (typeof setting.pattern !== 'string' || setting.pattern.length === 0 ||
      typeof setting.languageId !== 'string' || setting.languageId.length === 0) {
      report('pattern and languageId must be non-empty strings');
      return;
    }
    if (knownLanguages && !knownLanguages.has(setting.languageId)) {
      report(`language "${setting.languageId}" is not registered`);
      return;
    }
    const mode = setting.documentMode ?? 'auto';
    if (!['auto', 'virtual', 'untitled', 'file'].includes(mode)) {
      report(`unsupported documentMode "${mode}"`);
      return;
    }
    const flags = setting.flags ?? '';
    if (typeof flags !== 'string') {
      report('flags must be a string');
      return;
    }
    try {
      // A wrapper avoids accidental substring matches, including with alternations.
      const regex = new RegExp(`^(?:${setting.pattern})$`, flags);
      this.rules.push({
        regex,
        rule: { languageId: setting.languageId, documentMode: mode, preset },
      });
    } catch (error) {
      report(`invalid regular expression: ${String(error)}`);
    }
  }
}
