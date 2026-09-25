import assert from 'node:assert/strict';
import * as vscode from 'vscode';

function wait(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

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
  const shadow = await until(
    async () => vscode.workspace.textDocuments.find(document =>
      document.uri.toString() !== source.uri.toString() &&
      document.languageId === language && document.getText() === `${body}\n`),
    value => value !== undefined,
  );
  assert.ok(shadow, `${label} shadow document was created`);
  assert.equal(shadow.uri.scheme, scheme, `${label} uses ${scheme}: shadow`);

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
  const ours = vscode.extensions.getExtension('vscode-heredoc-local.vscode-heredoc');
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
  } finally {
    await settings.update('rules', previousRules, vscode.ConfigurationTarget.Global);
    await settings.update('enablePresets', previousPresets, vscode.ConfigurationTarget.Global);
  }
}
