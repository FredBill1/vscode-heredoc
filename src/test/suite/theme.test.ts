import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GrammarLibrary, HeredocHighlighter } from '../../highlighting';
import { parseHeredocs } from '../../parser';
import { ResolvedTheme, ThemeLoader } from '../../theme';

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
    await fs.writeFile(basePath, '{ // base theme\n "colors": { "editor.foreground": "#112233" },\n "tokenColors": [{ "scope": "entity.name.function", "settings": { "foreground": "#665544" } }],\n}', 'utf8');
    await fs.writeFile(plistPath, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>settings</key><array><dict><key>scope</key><string>string</string><key>settings</key><dict><key>foreground</key><string>#abcdef</string></dict></dict></array></dict></plist>', 'utf8');
    await fs.writeFile(childPath, '{ "include": "./base.json", "tokenColors": "./syntax.tmTheme", "semanticHighlighting": true }', 'utf8');
    await tokenSettings.update('tokenColorCustomizations', undefined, vscode.ConfigurationTarget.Global);
    const inherited = await loader.load({ uri: vscode.Uri.file(childPath), label: 'Heredoc Fixture' });
    assert.ok(inherited.found && inherited.hasBaseForeground && inherited.semanticHighlighting);
    assert.equal((await colorAt(library, inherited, 'python', code, character))?.toLowerCase(), '#abcdef');
    const fallback = await library.semanticAppearance('python', 'function', new Set(), inherited.hasBaseForeground);
    assert.equal(fallback?.foreground?.toLowerCase(), '#665544');

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
  } finally {
    await tokenSettings.update('tokenColorCustomizations', previousTokenCustom,
      vscode.ConfigurationTarget.Global);
    await fs.rm(temporary, { recursive: true, force: true });
    output.dispose();
  }
}
