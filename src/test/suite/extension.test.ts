import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { GrammarLibrary } from '../../highlighting';
import { deactivate } from '../../extension';

const completionLabel = 'HEREDOC_MOCK_COMPLETION';
const hoverText = 'HEREDOC_MOCK_HOVER';
const diagnosticText = 'HEREDOC_MOCK_DIAGNOSTIC';
const eofDiagnosticText = 'HEREDOC_MOCK_EOF';
const fixture = [
  'outside_before',
  "bash <<'SH'",
  "cat <<'MOCK'",
  'alpha',
  'beta',
  'MOCK',
  'SH',
  'outside_after',
  '',
].join('\n');

interface MockState {
  calls: number;
  shadowUri?: vscode.Uri;
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function eventually<T>(
  label: string,
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const started = Date.now();
  let value = await read();
  while (!accept(value) && Date.now() - started < timeoutMs) {
    await pause(100);
    value = await read();
  }
  assert.ok(accept(value), `${label} (timed out)`);
  return value;
}

async function completionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
  const result = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider', document.uri, position,
  );
  return result?.items ?? [];
}

function hasMockCompletion(items: readonly vscode.CompletionItem[]): boolean {
  return items.some(item => item.label === completionLabel);
}

function hoverContains(hover: vscode.Hover, text: string): boolean {
  return hover.contents.some(content =>
    typeof content === 'string' ? content.includes(text) : content.value.includes(text));
}

function definitionTarget(definition: vscode.Location | vscode.LocationLink): {
  uri: vscode.Uri;
  range: vscode.Range;
} {
  return 'targetUri' in definition
    ? { uri: definition.targetUri, range: definition.targetRange }
    : { uri: definition.uri, range: definition.range };
}

function registerMockProviders(state: MockState, diagnostics: vscode.DiagnosticCollection): vscode.Disposable[] {
  const selector: vscode.DocumentSelector = [
    { language: 'plaintext', scheme: 'heredoc-embedded' },
    { language: 'plaintext', scheme: 'file' },
  ];
  return [
    vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems: (document, position) => {
        state.calls++;
        state.shadowUri = document.uri;
        assert.equal(document.lineAt(0).text, 'alpha');
        const item = new vscode.CompletionItem(completionLabel, vscode.CompletionItemKind.Text);
        item.range = new vscode.Range(0, 0, 0, 5);
        item.insertText = 'replacement';
        item.additionalTextEdits = [
          vscode.TextEdit.insert(new vscode.Position(1, 0), 'prefix_'),
          vscode.TextEdit.insert(new vscode.Position(99, 0), 'outside_'),
        ];
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 5), diagnosticText, vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = 'heredoc-mock';
        const eofDiagnostic = new vscode.Diagnostic(
          new vscode.Range(2, 0, 2, 0), eofDiagnosticText, vscode.DiagnosticSeverity.Error,
        );
        eofDiagnostic.source = 'heredoc-mock';
        diagnostics.set(document.uri, [diagnostic, eofDiagnostic]);
        assert.equal(position.line, 0);
        return [item];
      },
    }),
    vscode.languages.registerHoverProvider(selector, {
      provideHover: (document, position) => {
        state.shadowUri = document.uri;
        assert.equal(position.line, 0);
        return new vscode.Hover(hoverText, new vscode.Range(0, 0, 0, 5));
      },
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition: (document, position) => {
        state.shadowUri = document.uri;
        assert.equal(position.line, 0);
        return new vscode.Location(document.uri, new vscode.Range(1, 0, 1, 4));
      },
    }),
  ];
}

export async function run(): Promise<void> {
  const settings = vscode.workspace.getConfiguration('heredoc');
  const previousRules = settings.inspect<unknown[]>('rules')?.globalValue;
  const previousPresets = settings.inspect<boolean>('enablePresets')?.globalValue;
  const mockState: MockState = { calls: 0 };
  const mockDiagnostics = vscode.languages.createDiagnosticCollection('heredoc-host-mock');
  const disposables = registerMockProviders(mockState, mockDiagnostics);

  try {
    await settings.update('enablePresets', true, vscode.ConfigurationTarget.Global);
    await settings.update('rules', [
      { pattern: 'MOCK', languageId: 'plaintext', documentMode: 'virtual' },
    ], vscode.ConfigurationTarget.Global);

    const extension = vscode.extensions.getExtension('vscode-heredoc-local.vscode-heredoc');
    assert.ok(extension, 'development extension is available');
    await extension.activate();
    assert.equal(vscode.extensions.getExtension('ms-python.python'), undefined,
      'isolated host runs without the Python language service');
    assert.ok((await vscode.languages.getLanguages()).includes('python'),
      'Python remains a registered language for syntax highlighting');
    assert.ok(vscode.extensions.all.some(candidate =>
      candidate.packageJSON?.contributes?.grammars?.some((grammar: { language?: string }) => grammar.language === 'python')),
    'Python TextMate grammar remains available without ms-python.python');
    const grammarOutput = vscode.window.createOutputChannel('Heredoc grammar test');
    assert.ok(await new GrammarLibrary(grammarOutput).forLanguage('python'),
      'built-in Python grammar loads without the Python language service');
    grammarOutput.dispose();

    const source = await vscode.workspace.openTextDocument({ language: 'shellscript', content: fixture });
    const inside = new vscode.Position(3, 2);
    const before = new vscode.Position(0, 3);
    const outerBody = new vscode.Position(2, 3);
    const after = new vscode.Position(7, 3);

    console.log('host: nested shell heredoc forwards completion only inside the inner body');
    const items = await eventually(
      'completion forwarded into inner heredoc',
      () => completionItems(source, inside),
      hasMockCompletion,
    );
    const completion = items.find(item => item.label === completionLabel)!;
    assert.ok(completion.range instanceof vscode.Range);
    assert.equal(completion.range.start.line, 3);
    assert.equal(completion.range.end.line, 3);
    assert.equal(completion.additionalTextEdits?.[0].range.start.line, 4);
    assert.equal(completion.additionalTextEdits?.[0].newText, 'prefix_');
    assert.equal(completion.additionalTextEdits?.length, 1, 'out-of-bounds shadow edit is dropped');
    assert.ok(mockState.shadowUri);
    assert.equal(mockState.shadowUri.scheme, 'heredoc-embedded');

    for (const [label, position] of [['before', before], ['outer', outerBody], ['after', after]] as const) {
      const priorCalls = mockState.calls;
      const outsideItems = await completionItems(source, position);
      assert.equal(hasMockCompletion(outsideItems), false, `${label} has no mock completion`);
      assert.equal(mockState.calls, priorCalls, `${label} did not invoke inner provider`);
    }
    const zshSource = await vscode.workspace.openTextDocument({
      language: 'shellscript',
      content: "#!/usr/bin/env zsh\ncat <<'MOCK'\nalpha\nbeta\nMOCK\n",
    });
    assert.equal(hasMockCompletion(await completionItems(zshSource, new vscode.Position(2, 2))), false,
      'zsh shebang excludes the entire document');

    console.log('host: hover, definition, and diagnostic ranges map to the source');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider', source.uri, inside,
    );
    const hover = hovers?.find(candidate => hoverContains(candidate, hoverText));
    assert.ok(hover, 'mock hover was forwarded');
    assert.equal(hover.range?.start.line, 3);
    assert.equal(hover.range?.end.line, 3);

    const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider', source.uri, inside,
    );
    const mappedDefinition = definitions?.map(definitionTarget).find(target =>
      target.uri.toString() === source.uri.toString() && target.range.start.line === 4);
    assert.ok(mappedDefinition, 'definition points to the inner body in the source document');

    const mappedDiagnostics = await eventually(
      'diagnostic mapped to source heredoc body',
      () => vscode.languages.getDiagnostics(source.uri),
      values => values.some(value => value.message === diagnosticText && value.range.start.line === 3),
    );
    assert.equal(mappedDiagnostics.find(value => value.message === diagnosticText)?.source, 'heredoc-mock');
    const eofDiagnostic = mappedDiagnostics.find(value => value.message === eofDiagnosticText);
    assert.ok(eofDiagnostic, 'EOF diagnostic is retained');
    assert.equal(eofDiagnostic.range.start.line, 4, 'EOF diagnostic stays in body');

    console.log('host: configuration changes remove and restore the embedded language immediately');
    await settings.update('rules', [], vscode.ConfigurationTarget.Global);
    await eventually(
      'removed rule stops forwarding',
      () => completionItems(source, inside),
      values => !hasMockCompletion(values),
    );
    await eventually(
      'mapped diagnostics clear after rule removal',
      () => vscode.languages.getDiagnostics(source.uri),
      values => !values.some(value => value.message === diagnosticText),
    );
    await settings.update('rules', [
      { pattern: 'MOCK', languageId: 'plaintext', documentMode: 'virtual' },
    ], vscode.ConfigurationTarget.Global);
    await eventually(
      'restored rule forwards again',
      () => completionItems(source, inside),
      hasMockCompletion,
    );

    console.log('host: user rule overrides a preset and arbitrary registered languages work');
    await settings.update('rules', [
      { pattern: 'PY', languageId: 'plaintext', documentMode: 'virtual' },
    ], vscode.ConfigurationTarget.Global);
    const prioritySource = await vscode.workspace.openTextDocument({
      language: 'shellscript', content: 'cat <<PY\nalpha\nbeta\nPY\n',
    });
    await eventually(
      'user rule wins over Python preset',
      () => completionItems(prioritySource, new vscode.Position(1, 2)),
      hasMockCompletion,
    );
    await settings.update('rules', [], vscode.ConfigurationTarget.Global);
    await eventually(
      'removing user rule restores the Python preset',
      () => completionItems(prioritySource, new vscode.Position(1, 2)),
      values => !hasMockCompletion(values),
    );

    console.log('host: file shadows avoid unchanged writes and are removed with their rule');
    await settings.update('rules', [
      { pattern: 'FILEMOCK', languageId: 'plaintext', documentMode: 'file' },
    ], vscode.ConfigurationTarget.Global);
    const fileSource = await vscode.workspace.openTextDocument({
      language: 'shellscript',
      content: "cat <<'FILEMOCK'\nalpha\nbeta\nFILEMOCK\n",
    });
    await eventually(
      'file shadow forwards completion',
      () => completionItems(fileSource, new vscode.Position(1, 2)),
      hasMockCompletion,
    );
    const fileShadowUri = mockState.shadowUri;
    assert.ok(fileShadowUri);
    assert.equal(fileShadowUri.scheme, 'file');
    const firstStat = await vscode.workspace.fs.stat(fileShadowUri);
    await completionItems(fileSource, new vscode.Position(1, 2));
    const secondStat = await vscode.workspace.fs.stat(fileShadowUri);
    assert.equal(secondStat.mtime, firstStat.mtime, 'unchanged content does not rewrite the file');
    const firstEdit = new vscode.WorkspaceEdit();
    firstEdit.replace(fileSource.uri, new vscode.Range(1, 0, 1, 5), 'alphaX');
    assert.ok(await vscode.workspace.applyEdit(firstEdit));
    const secondEdit = new vscode.WorkspaceEdit();
    secondEdit.replace(fileSource.uri, new vscode.Range(2, 0, 2, 4), 'betaY');
    assert.ok(await vscode.workspace.applyEdit(secondEdit));
    await eventually(
      'rapid source edits reach the same shadow file',
      async () => Buffer.from(await vscode.workspace.fs.readFile(fileShadowUri)).toString('utf8'),
      value => value === 'alphaX\nbetaY\n',
    );
    await settings.update('rules', [], vscode.ConfigurationTarget.Global);
    await eventually('file shadow removed after rule change', () => exists(fileShadowUri), value => !value);

    console.log('host: deactivation removes remaining file shadows');
    await settings.update('rules', [
      { pattern: 'CLOSEMOCK', languageId: 'plaintext', documentMode: 'file' },
    ], vscode.ConfigurationTarget.Global);
    const closingSource = await vscode.workspace.openTextDocument({
      language: 'shellscript', content: "cat <<'CLOSEMOCK'\nalpha\nbeta\nCLOSEMOCK\n",
    });
    await eventually(
      'shutdown file shadow forwards completion',
      () => completionItems(closingSource, new vscode.Position(1, 2)),
      hasMockCompletion,
    );
    const shutdownShadow = mockState.shadowUri;
    assert.ok(shutdownShadow && await exists(shutdownShadow));
    await deactivate();
    await eventually('file shadow removed at deactivation', () => exists(shutdownShadow), value => !value);
  } finally {
    for (const disposable of disposables) disposable.dispose();
    mockDiagnostics.dispose();
    await settings.update('rules', previousRules, vscode.ConfigurationTarget.Global);
    await settings.update('enablePresets', previousPresets, vscode.ConfigurationTarget.Global);
  }
}
