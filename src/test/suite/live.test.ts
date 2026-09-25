import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { GrammarLibrary } from '../../highlighting';
import { ThemeLoader } from '../../theme';

function wait(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

function textTabUris(): string[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs.flatMap(tab =>
    tab.input instanceof vscode.TabInputText ? [tab.input.uri.toString()] : []));
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, ms = 12_000): Promise<T> {
  const start = Date.now();
  let value = await read();
  while (!accept(value) && Date.now() - start < ms) {
    await wait(300);
    value = await read();
  }
  return value;
}

async function probe(
  label: string,
  language: string,
  body: string,
  line: number,
  character: number,
  scheme: string,
): Promise<void> {
  const source = await vscode.workspace.openTextDocument({
    language: 'shellscript', content: `cat <<'${label}'\n${body}\n${label}\n`,
  });
  await vscode.window.showTextDocument(source);
  const tabsBeforeShadow = textTabUris();
  const shadow = await until(
    async () => vscode.workspace.textDocuments.find(document =>
      document.uri.toString() !== source.uri.toString() &&
      document.languageId === language && document.getText() === `${body}\n`),
    value => value !== undefined,
  );
  assert.ok(shadow, `${label} shadow document was created`);
  assert.equal(shadow.uri.scheme, scheme, `${label} uses ${scheme}: shadow`);
  assert.deepEqual(textTabUris(), tabsBeforeShadow, `${label} shadow does not occupy an editor tab`);
  assert.equal(textTabUris().includes(shadow.uri.toString()), false);
  if (scheme === 'file') {
    assert.equal(shadow.isDirty, false, `${label} file snapshot stays clean`);
  }

  const sourcePosition = new vscode.Position(line + 1, character);
  const shadowPosition = new vscode.Position(line, character);
  let shadowCompletion = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider', shadow.uri, shadowPosition,
  );
  if (label === 'PY' && !shadowCompletion?.items.some(item => item.label === 'path')) {
    shadowCompletion = await until(async () => vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider', shadow.uri, shadowPosition,
    ), value => !!value?.items.some(item => item.label === 'path'), 20_000);
  }
  const sourceCompletion = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider', source.uri, sourcePosition,
  );
  if (language === 'yaml') {
    await until(async () => vscode.languages.getDiagnostics(shadow.uri), values => values.length > 0, 5_000);
    const mapped = await until(async () => vscode.languages.getDiagnostics(source.uri),
      values => values.some(value => value.range.start.line === 1), 5_000);
    console.log('LIVE YAML diagnostics', label, JSON.stringify([
      vscode.languages.getDiagnostics(shadow.uri).map(value => [value.message, value.range.start.line, value.range.start.character, value.range.end.line, value.range.end.character]),
      mapped.map(value => [value.message, value.range.start.line, value.range.start.character, value.range.end.line, value.range.end.character])
    ]));
    assert.ok(mapped.some(value => value.range.start.line === 1),
      'YAML diagnostics from the real extension map into the heredoc body');
  }
  const shadowLabels = shadowCompletion?.items.slice(0, 20).map(item => String(item.label)) ?? [];
  const sourceLabels = sourceCompletion?.items.slice(0, 20).map(item => String(item.label)) ?? [];
  const targets: Record<string, string> = {
    PY: 'ms-python.vscode-pylance', YAML: 'redhat.vscode-yaml', YAMLFILE: 'redhat.vscode-yaml',
    SH: 'mads-hartmann.bash-ide-vscode', TS: 'vscode.typescript-language-features',
  };
  assert.equal(vscode.extensions.getExtension(targets[label])?.isActive, true,
    `${targets[label]} activated for ${label}`);
  if (label === 'TS') {
    assert.ok(shadowLabels.includes('hello') && sourceLabels.includes('hello'),
      'built-in TypeScript completion reaches the source');
  }
  if (label === 'PY') {
    assert.ok(shadowLabels.includes('path') && sourceLabels.includes('path'),
      'Pylance completion reaches the source');
  }
  if (label === 'SH') {
    assert.ok((shadowCompletion?.items.length ?? 0) > 0 && (sourceCompletion?.items.length ?? 0) > 0,
      'Bash IDE completion reaches the source');
  }
  console.log('LIVE', JSON.stringify({
    label, language, scheme: shadow.uri.scheme,
    shadowCompletions: shadowCompletion?.items.length ?? 0,
    sourceCompletions: sourceCompletion?.items.length ?? 0,
    shadowLabels, sourceLabels,
    diagnostics: vscode.languages.getDiagnostics(shadow.uri).map(item => item.message),
    targetActive: vscode.extensions.getExtension(targets[label])?.isActive,
  }));
}

async function syntaxDiagnosticProbe(
  label: 'TS' | 'JS' | 'YAML' | 'PY' | 'SH',
  language: string,
  invalidBody: string,
  validBody: string,
  required: boolean,
): Promise<void> {
  const source = await vscode.workspace.openTextDocument({
    language: 'shellscript', content: `cat <<'${label}'\n${invalidBody}\n${label}\n`,
  });
  await vscode.window.showTextDocument(source);
  const tabsBeforeShadow = textTabUris();
  const shadow = await until(
    async () => vscode.workspace.textDocuments.find(document =>
      document.uri.toString() !== source.uri.toString() && document.languageId === language &&
      document.getText() === `${invalidBody}\n`),
    value => value !== undefined,
  );
  assert.ok(shadow, `${label} invalid-code shadow document was created`);
  assert.deepEqual(textTabUris(), tabsBeforeShadow, `${label} diagnostics do not open a hidden tab`);
  if (shadow.uri.scheme === 'file') {
    assert.equal(shadow.isDirty, false, `${label} snapshot stays clean while diagnostics run`);
  }

  const bodyEndLine = 1 + invalidBody.split('\n').length;
  const isBodyError = (value: vscode.Diagnostic): boolean =>
    value.severity === vscode.DiagnosticSeverity.Error &&
    value.range.start.line >= 1 && value.range.start.line < bodyEndLine;
  const diagnostics = await until(async () => vscode.languages.getDiagnostics(source.uri),
    values => values.some(isBodyError), required ? 30_000 : 5_000);
  const shadowDiagnostics = vscode.languages.getDiagnostics(shadow.uri);
  console.log('LIVE SYNTAX', JSON.stringify({
    label,
    shadowUri: shadow.uri.toString(),
    shadowDiagnostics: shadowDiagnostics.map(value => [value.message, value.range.start.line, value.range.start.character]),
    sourceDiagnostics: diagnostics.map(value => [value.message, value.range.start.line, value.range.start.character]),
  }));
  if (required) {
    assert.ok(diagnostics.some(isBodyError), `${label} syntax error is reported in the heredoc body`);
    const bodyErrors = diagnostics.filter(isBodyError);
    assert.ok(bodyErrors.every(value => !value.range.isEmpty),
      `${label} syntax errors have a visible range`);
    const keys = bodyErrors.map(value => [
      value.message, value.code ?? '', value.range.start.line, value.range.start.character,
      value.range.end.line, value.range.end.character,
    ].join('\u0000'));
    assert.equal(new Set(keys).size, keys.length, `${label} passive and requested diagnostics do not duplicate`);
  } else if (shadowDiagnostics.some(value => value.severity === vscode.DiagnosticSeverity.Error)) {
    assert.ok(diagnostics.some(isBodyError), `${label} published hidden-document errors map into the source`);
  }

  if (required) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(source.uri, new vscode.Range(1, 0, bodyEndLine, 0), `${validBody}\n`);
    assert.ok(await vscode.workspace.applyEdit(edit), `${label} source correction succeeds`);
    const cleared = await until(async () => vscode.languages.getDiagnostics(source.uri),
      values => !values.some(isBodyError), 30_000);
    assert.equal(cleared.some(isBodyError), false, `${label} syntax diagnostic clears after correction`);
    assert.equal(textTabUris().some(uri => uri === shadow.uri.toString()), false,
      `${label} diagnostics never reveal a shadow tab`);
    assert.ok(vscode.workspace.textDocuments.filter(document =>
      document.uri.scheme === 'file' && document.uri.path.includes('/shadow/')).every(document => !document.isDirty),
    `${label} file snapshots remain clean after correction`);
  }
}

async function inspectLiveThemes(): Promise<void> {
  const output = vscode.window.createOutputChannel('Heredoc live theme test');
  const loader = new ThemeLoader(output);
  const grammars = new GrammarLibrary(output);
  const workbench = vscode.workspace.getConfiguration('workbench');
  const previousTheme = workbench.inspect<string>('colorTheme')?.globalValue;
  const themeExtensions = vscode.extensions.all.filter(extension =>
    Array.isArray(extension.packageJSON?.contributes?.themes) &&
    extension.packageJSON.contributes.themes.some((theme: { label?: string }) => theme.label === 'LimeGray'));
  console.log('LIVE LimeGray theme contributions', themeExtensions.map(extension => extension.id));
  const hasLimeGray = themeExtensions.length > 0;
  const labels = hasLimeGray ? ['LimeGray', 'Dark+', 'Light+'] : ['Dark+', 'Light+'];
  try {
    for (const label of labels) {
      await workbench.update('colorTheme', label, vscode.ConfigurationTarget.Global);
      const theme = await loader.load();
      assert.ok(theme.found, `${label} contribution resolves as the active theme`);
      grammars.setTheme(theme.textmate);
      for (const [language, line] of [
        ['python', 'print("hello")'],
        ['yaml', 'name: "hello"'],
        ['typescript', 'const value = "hello";'],
      ] as const) {
        const grammar = await grammars.forLanguage(language);
        assert.ok(grammar, `${language} grammar available with ${label}`);
        const tokens = grammar.tokenizeLine2(line, null).tokens;
        const offset = line.indexOf('hello');
        let metadata = tokens[1];
        for (let index = 0; index < tokens.length; index += 2) {
          if (tokens[index] > offset) { break; }
          metadata = tokens[index + 1];
        }
        const color = grammars.getColorMap()[(metadata >>> 15) & 0x1ff];
        assert.ok(color?.startsWith('#'), `${label} ${language} string has a theme color`);
        if (label === 'LimeGray') {
          assert.equal(color.toLowerCase(), '#d0ff00', `${language} uses LimeGray string color`);
        }
      }
      console.log('LIVE THEME', label, 'Python/YAML/TypeScript grammar colors resolved');
    }
  } finally {
    await workbench.update('colorTheme', previousTheme, vscode.ConfigurationTarget.Global);
    output.dispose();
  }
}

export async function run(): Promise<void> {
  const targetIds = [
    'ms-python.python', 'ms-python.vscode-pylance',
    'redhat.vscode-yaml', 'mads-hartmann.bash-ide-vscode',
    'vscode.typescript-language-features',
  ];
  console.log('LIVE extensions', JSON.stringify(targetIds.map(id => ({
    id, installed: !!vscode.extensions.getExtension(id),
    active: vscode.extensions.getExtension(id)?.isActive,
  }))));
  const ours = vscode.extensions.getExtension('fredbill1.vscode-heredoc');
  assert.ok(ours);
  await ours.activate();

  const settings = vscode.workspace.getConfiguration('heredoc');
  const previousRules = settings.inspect<unknown[]>('rules')?.globalValue;
  const previousPresets = settings.inspect<boolean>('enablePresets')?.globalValue;
  try {
    await settings.update('rules', [], vscode.ConfigurationTarget.Global);
    await settings.update('enablePresets', true, vscode.ConfigurationTarget.Global);
    await probe('TS', 'typescript', 'const word = { hello: 1 };\nword.', 1, 5, 'heredoc-embedded');
    await probe('PY', 'python', 'import os\nos.pa', 1, 5, 'file');
    await probe('YAML', 'yaml', 'key: [1, 2', 0, 7, 'heredoc-embedded');
    await settings.update('rules', [
      { pattern: 'YAMLFILE', languageId: 'yaml', documentMode: 'file' },
    ], vscode.ConfigurationTarget.Global);
    await probe('YAMLFILE', 'yaml', 'fileprobe: [1, 2', 0, 13, 'file');
    await probe('SH', 'shellscript', 'echo hel', 0, 8, 'file');
    await syntaxDiagnosticProbe('TS', 'typescript', 'const value: = 1;', 'const value: number = 1;', true);
    await syntaxDiagnosticProbe('JS', 'javascript', 'const value = ;', 'const value = 1;', true);
    await syntaxDiagnosticProbe('YAML', 'yaml', 'items: [1, 2', 'items: [1, 2]', true);
    await syntaxDiagnosticProbe('PY', 'python', 'def broken(:\n    pass', 'def broken():\n    pass', false);
    await syntaxDiagnosticProbe('SH', 'shellscript', 'if then\n  echo broken\nfi', 'if true; then\n  echo fixed\nfi', false);
    await inspectLiveThemes();
  } finally {
    await settings.update('rules', previousRules, vscode.ConfigurationTarget.Global);
    await settings.update('enablePresets', previousPresets, vscode.ConfigurationTarget.Global);
  }
}
