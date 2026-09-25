import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GrammarLibrary, HeredocHighlighter } from '../../highlighting';
import { parseHeredocs } from '../../parser';
import { ResolvedTheme, resolveSemanticAppearance, ThemeLoader } from '../../theme';

function builtinTheme(id: string): vscode.Uri {
  for (const extension of vscode.extensions.all) {
    const themes = extension.packageJSON?.contributes?.themes;
    if (!Array.isArray(themes)) { continue; }
    const theme = themes.find((item: { id?: string }) => item.id === id);
    if (theme?.path) { return vscode.Uri.joinPath(extension.extensionUri, theme.path); }
  }
  throw new Error(`Built-in theme ${id} is unavailable`);
}

async function colorAt(
  library: GrammarLibrary, theme: ResolvedTheme,
  languageId: string, line: string, character: number,
): Promise<string | undefined> {
  library.setTheme(theme.textmate);
  const grammar = await library.forLanguage(languageId);
  assert.ok(grammar, `${languageId} grammar exists`);
  const tokens = grammar.tokenizeLine2(line, null).tokens;
  let metadata: number | undefined;
  for (let index = 0; index < tokens.length; index += 2) {
    if (tokens[index] > character) { break; }
    metadata = tokens[index + 1];
  }
  return metadata === undefined ? undefined : library.getColorMap()[(metadata >>> 15) & 0x1ff];
}

async function scopesAt(
  library: GrammarLibrary, languageId: string, lines: readonly string[],
  lineIndex: number, character: number,
): Promise<readonly string[]> {
  const grammar = await library.forLanguage(languageId);
  assert.ok(grammar, `${languageId} grammar exists`);
  let state: import('vscode-textmate').StateStack | null = null;
  let scopes: readonly string[] = [];
  for (let index = 0; index <= lineIndex; index++) {
    const result = grammar.tokenizeLine(lines[index], state);
    state = result.ruleStack;
    if (index === lineIndex) {
      scopes = result.tokens.find(token => token.startIndex <= character && token.endIndex > character)?.scopes ?? [];
    }
  }
  return scopes;
}

async function eventually(label: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check() && Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(check(), `${label} (timed out)`);
}

export async function run(): Promise<void> {
  const output = vscode.window.createOutputChannel('Heredoc theme test');
  const loader = new ThemeLoader(output);
  const library = new GrammarLibrary(output);
  const tokenSettings = vscode.workspace.getConfiguration('editor');
  const previousTokenCustom = tokenSettings.inspect<unknown>('tokenColorCustomizations')?.globalValue;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'heredoc-theme-test-'));
  try {
    console.log('theme: built-in dark/light rules yield different Python token colors');
    const dark = await loader.load({ uri: builtinTheme('Dark+'), label: 'Dark+' });
    const light = await loader.load({ uri: builtinTheme('Light+'), label: 'Light+' });
    assert.ok(dark.found && light.found);
    assert.ok(dark.hasBaseForeground && light.hasBaseForeground);
    const samples = [
      { languageId: 'python', code: 'print("hello")' },
      { languageId: 'yaml', code: 'name: "hello"' },
      { languageId: 'typescript', code: 'const value = "hello";' },
    ];
    for (const { languageId, code } of samples) {
      const character = code.indexOf('hello');
      const darkString = await colorAt(library, dark, languageId, code, character);
      const lightString = await colorAt(library, light, languageId, code, character);
      assert.ok(darkString?.startsWith('#') && lightString?.startsWith('#'), `${languageId} is colored`);
      assert.notEqual(darkString?.toLowerCase(), lightString?.toLowerCase(),
        `${languageId} uses the active theme`);
    }
    console.log('theme: target language grammar injections are loaded');
    const jsdocLines = ['/**', ' * @param value description', ' */', 'function f(value: string) {}'];
    const jsdocScopes = await scopesAt(library, 'typescript', jsdocLines, 1,
      jsdocLines[1].indexOf('param'));
    assert.ok(jsdocScopes.some(scope => scope.endsWith('.jsdoc')),
      `TypeScript JSDoc injection is active: ${jsdocScopes.join(' ')}`);
    const code = samples[0].code;
    const character = code.indexOf('hello');
    const darkString = await colorAt(library, dark, 'python', code, character);
    const lightString = await colorAt(library, light, 'python', code, character);
    assert.ok(darkString && lightString);

    console.log('theme: token customizations update TextMate colors');
    await tokenSettings.update('tokenColorCustomizations', { strings: '#123456' },
      vscode.ConfigurationTarget.Global);
    const customized = await loader.load({ uri: builtinTheme('Dark+'), label: 'Dark+' });
    assert.equal((await colorAt(library, customized, 'python', code, character))?.toLowerCase(), '#123456');
    await tokenSettings.update('tokenColorCustomizations', { strings: '#abcdef' },
      vscode.ConfigurationTarget.Global);
    const changed = await loader.load({ uri: builtinTheme('Dark+'), label: 'Dark+' });
    assert.equal((await colorAt(library, changed, 'python', code, character))?.toLowerCase(), '#abcdef');

    console.log('theme: JSONC includes, plist token rules, and semantic scope fallback load');
    const basePath = path.join(temporary, 'base.json');
    const childPath = path.join(temporary, 'child.json');
    const plistPath = path.join(temporary, 'syntax.tmTheme');
    await fs.writeFile(basePath, '{ // base theme\n "colors": { "editor.foreground": "#112233" },\n "tokenColors": [{ "scope": "entity.name.function", "settings": { "foreground": "#665544" } }],\n "semanticTokenColors": { "function": { "foreground": "#112233", "italic": true } },\n}', 'utf8');
    await fs.writeFile(plistPath, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>settings</key><array><dict><key>scope</key><string>string</string><key>settings</key><dict><key>foreground</key><string>#abcdef</string></dict></dict></array></dict></plist>', 'utf8');
    await fs.writeFile(childPath, '{ "include": "./base.json", "tokenColors": "./syntax.tmTheme", "semanticTokenColors": { "function": { "bold": true } }, "semanticHighlighting": true }', 'utf8');
    await tokenSettings.update('tokenColorCustomizations', undefined, vscode.ConfigurationTarget.Global);
    const inherited = await loader.load({ uri: vscode.Uri.file(childPath), label: 'Heredoc Fixture' });
    assert.ok(inherited.found && inherited.hasBaseForeground && inherited.semanticHighlighting);
    assert.equal((await colorAt(library, inherited, 'python', code, character))?.toLowerCase(), '#abcdef');
    const fallback = await library.semanticAppearance('python', 'function', new Set(), inherited.hasBaseForeground);
    assert.equal(fallback?.foreground?.toLowerCase(), '#665544');
    const semanticConfiguration = vscode.workspace.getConfiguration('editor');
    const savedSemanticCustom = semanticConfiguration.inspect<unknown>('semanticTokenColorCustomizations')?.globalValue;
    try {
      await semanticConfiguration.update('semanticTokenColorCustomizations', {
        rules: { function: { italic: false } },
      }, vscode.ConfigurationTarget.Global);
      const layered = await loader.load({ uri: vscode.Uri.file(childPath), label: 'Heredoc Fixture' });
      assert.deepEqual(resolveSemanticAppearance(layered, 'function', new Set(), 'python'), {
        foreground: '#112233', bold: true, italic: false,
      }, 'included, child and user semantic rules preserve independent properties');
    } finally {
      await semanticConfiguration.update('semanticTokenColorCustomizations', savedSemanticCustom,
        vscode.ConfigurationTarget.Global);
    }

    if (process.env.HEREDOC_LIMEGRAY_THEME_PATH) {
      console.log('theme: installed LimeGray theme resolves its foreground and token rules');
      const lime = await loader.load({
        uri: vscode.Uri.file(process.env.HEREDOC_LIMEGRAY_THEME_PATH), label: 'LimeGray',
      });
      assert.ok(lime.found && lime.hasBaseForeground);
      const foreground = lime.textmate.settings.find(rule => !rule.scope)?.settings.foreground;
      assert.equal(foreground?.toLowerCase(), '#dde7d8');
      for (const { languageId, code } of samples) {
        assert.equal((await colorAt(library, lime, languageId, code, code.indexOf('hello')))?.toLowerCase(),
          '#d0ff00', `${languageId} uses LimeGray string color`);
      }
    }

    console.log('theme: switching themes and token settings repaints a visible heredoc');
    const workbenchSettings = vscode.workspace.getConfiguration('workbench');
    const previousTheme = workbenchSettings.inspect<string>('colorTheme')?.globalValue;
    const source = await vscode.workspace.openTextDocument({
      language: 'shellscript', content: "cat <<'PY'\nprint('hello')\nPY\n",
    });
    const editor = await vscode.window.showTextDocument(source);
    const regions = parseHeredocs(source.getText(), delimiter => delimiter === 'PY' ? 'python' : undefined);
    const highlighter = new HeredocHighlighter({} as vscode.ExtensionContext, output);
    const colors = (): string[] => {
      const state = highlighter as unknown as { painted: Map<vscode.TextEditor, Set<string>> };
      return [...state.painted.get(editor) ?? []].flatMap(key => {
        const style = JSON.parse(key) as { foreground?: string };
        return style.foreground ? [style.foreground.toLowerCase()] : [];
      });
    };
    try {
      await workbenchSettings.update('colorTheme', 'Dark+', vscode.ConfigurationTarget.Global);
      await highlighter.update(editor, regions);
      await eventually('dark theme color applied', () => colors().includes(darkString.toLowerCase()));
      await workbenchSettings.update('colorTheme', 'Light+', vscode.ConfigurationTarget.Global);
      await eventually('light theme change repaints', () => colors().includes(lightString.toLowerCase()));
      await tokenSettings.update('tokenColorCustomizations', { strings: '#556677' },
        vscode.ConfigurationTarget.Global);
      await eventually('token customization repaints', () => colors().includes('#556677'));
    } finally {
      highlighter.dispose();
      await workbenchSettings.update('colorTheme', previousTheme, vscode.ConfigurationTarget.Global);
    }

    console.log('theme: an offscreen heredoc is painted before scrolling into view');
    const prefix = Array.from({ length: 320 }, (_, index) => `# filler ${index}`).join('\n');
    const offscreen = await vscode.workspace.openTextDocument({
      language: 'shellscript', content: `${prefix}\ncat <<'PY'\nprint('offscreen')\nPY\n`,
    });
    const offscreenEditor = await vscode.window.showTextDocument(offscreen);
    offscreenEditor.revealRange(new vscode.Range(0, 0, 0, 0));
    const offscreenRegions = parseHeredocs(offscreen.getText(),
      delimiter => delimiter === 'PY' ? 'python' : undefined);
    const paintedRanges: vscode.Range[] = [];
    const probeEditor = {
      document: offscreen,
      visibleRanges: [new vscode.Range(0, 0, 20, 0)],
      setDecorations(_decoration: vscode.TextEditorDecorationType, ranges: readonly vscode.Range[]) {
        paintedRanges.push(...ranges);
      },
    } as unknown as vscode.TextEditor;
    const offscreenHighlighter = new HeredocHighlighter({} as vscode.ExtensionContext, output);
    try {
      await offscreenHighlighter.update(probeEditor, offscreenRegions);
      assert.ok(paintedRanges.some(range => range.start.line === 321),
        'decoration snapshot includes the body outside the visible range');
      assert.ok(paintedRanges.every(range =>
        offscreen.offsetAt(range.start) >= offscreenRegions[0].bodyStart &&
        offscreen.offsetAt(range.end) <= offscreenRegions[0].bodyEnd),
      'highlighting never decorates shell text outside the heredoc body');
      await offscreenHighlighter.update(offscreenEditor, offscreenRegions);
      const versions = (offscreenHighlighter as unknown as {
        versions: WeakMap<vscode.TextEditor, number>;
      }).versions;
      const beforeScroll = versions.get(offscreenEditor);
      offscreenEditor.revealRange(new vscode.Range(321, 0, 321, 0));
      await eventually('scroll reveals the heredoc', () =>
        offscreenEditor.visibleRanges.some(range => range.start.line <= 321 && range.end.line >= 321));
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(versions.get(offscreenEditor), beforeScroll,
        'scrolling alone does not restart highlighting');
    } finally {
      offscreenHighlighter.dispose();
    }

    console.log('theme: semantic classifications are reused when only colors change');
    const semanticSettings = vscode.workspace.getConfiguration('editor');
    const previousSemanticCustom = semanticSettings.inspect<unknown>('semanticTokenColorCustomizations')?.globalValue;
    const shadow = await vscode.workspace.openTextDocument({ language: 'python', content: 'value = 1\n' });
    const semanticSource = await vscode.workspace.openTextDocument({
      language: 'shellscript', content: "cat <<'PY'\nvalue = 1\nPY\n",
    });
    const semanticEditor = await vscode.window.showTextDocument(semanticSource);
    const semanticRegions = parseHeredocs(semanticSource.getText(),
      delimiter => delimiter === 'PY' ? 'python' : undefined);
    const legend = new vscode.SemanticTokensLegend(['variable'], ['readonly']);
    let providerCalls = 0;
    const provider = vscode.languages.registerDocumentSemanticTokensProvider(
      { language: 'python', scheme: 'untitled' }, {
        provideDocumentSemanticTokens(document) {
          if (document.uri.toString() !== shadow.uri.toString()) { return undefined; }
          providerCalls++;
          const builder = new vscode.SemanticTokensBuilder(legend);
          builder.push(new vscode.Range(0, 0, 0, 5), 'variable', ['readonly']);
          return builder.build();
        },
      }, legend,
    );
    const semanticHighlighter = new HeredocHighlighter({} as vscode.ExtensionContext, output,
      () => ({ uri: shadow.uri, release() {} }));
    const semanticColors = (): string[] => {
      const state = semanticHighlighter as unknown as { painted: Map<vscode.TextEditor, Set<string>> };
      return [...state.painted.get(semanticEditor) ?? []].flatMap(key => {
        const style = JSON.parse(key) as { foreground?: string };
        return style.foreground ? [style.foreground.toLowerCase()] : [];
      });
    };
    try {
      await semanticSettings.update('semanticTokenColorCustomizations', {
        enabled: true, rules: { 'variable.readonly:python': { foreground: '#2468ac', bold: true } },
      }, vscode.ConfigurationTarget.Global);
      await semanticHighlighter.update(semanticEditor, semanticRegions);
      await eventually('semantic style applied', () => semanticColors().includes('#2468ac'));
      assert.ok(providerCalls > 0, 'semantic token provider was queried');
      const callsBeforeRestyle = providerCalls;
      await semanticSettings.update('semanticTokenColorCustomizations', {
        enabled: true, rules: { 'variable.readonly:python': { foreground: '#765432', bold: true } },
      }, vscode.ConfigurationTarget.Global);
      await eventually('cached semantic token restyled', () => semanticColors().includes('#765432'));
      assert.equal(providerCalls, callsBeforeRestyle,
        'theme changes reuse semantic classifications from the same shadow content');

      const finalRanges = new Map<vscode.TextEditorDecorationType, readonly vscode.Range[]>();
      const semanticProbe = {
        document: semanticSource,
        visibleRanges: [new vscode.Range(0, 0, 0, 0)],
        setDecorations(decoration: vscode.TextEditorDecorationType, ranges: readonly vscode.Range[]) {
          finalRanges.set(decoration, ranges);
        },
      } as unknown as vscode.TextEditor;
      await semanticHighlighter.update(semanticProbe, semanticRegions);
      const spans = [...finalRanges.values()].flat().map(range => ({
        start: semanticSource.offsetAt(range.start), end: semanticSource.offsetAt(range.end),
      })).sort((a, b) => a.start - b.start || a.end - b.end);
      assert.ok(spans.length > 0, 'semantic and lexical tokens produce a decoration snapshot');
      for (let index = 1; index < spans.length; index++) {
        assert.ok(spans[index - 1].end <= spans[index].start,
          'semantic and lexical decorations do not overlap');
      }
      assert.equal(providerCalls, callsBeforeRestyle,
        'a second editor reuses semantic classifications for the same shadow content');
    } finally {
      semanticHighlighter.dispose();
      provider.dispose();
      await semanticSettings.update('semanticTokenColorCustomizations', previousSemanticCustom,
        vscode.ConfigurationTarget.Global);
    }
  } finally {
    await tokenSettings.update('tokenColorCustomizations', previousTokenCustom,
      vscode.ConfigurationTarget.Global);
    await fs.rm(temporary, { recursive: true, force: true });
    output.dispose();
  }
}
