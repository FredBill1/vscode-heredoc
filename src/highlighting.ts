import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import * as textmate from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';
import { HeredocRegion } from './parser';

type ColorCategory = 'plain' | 'comment' | 'string' | 'keyword' | 'type' |
  'number' | 'function' | 'variable' | 'tag' | 'invalid';

interface GrammarLocation {
  readonly extension: vscode.Extension<unknown>;
  readonly path: string;
  readonly scopeName: string;
}

interface HighlightRequest {
  readonly regions: HeredocRegion[];
}

interface OffsetInterval {
  readonly start: number;
  readonly end: number;
}

const COLORS: Record<'dark' | 'light', Record<Exclude<ColorCategory, 'plain'>, string>> = {
  dark: {
    comment: '#6A9955', string: '#CE9178', keyword: '#C586C0', type: '#4EC9B0',
    number: '#B5CEA8', function: '#DCDCAA', variable: '#9CDCFE', tag: '#569CD6',
    invalid: '#F44747',
  },
  light: {
    comment: '#008000', string: '#A31515', keyword: '#0000FF', type: '#267F99',
    number: '#098658', function: '#795E26', variable: '#001080', tag: '#800000',
    invalid: '#CD3131',
  },
};

let wasmReady: Promise<void> | undefined;

async function readyOniguruma(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const bytes = await fs.readFile(require.resolve('vscode-oniguruma/release/onig.wasm'));
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      await oniguruma.loadWASM(buffer);
    })();
  }
  return wasmReady;
}

/**
 * TextMate grammars are exposed in extension manifests, including VS Code's built-in
 * language extensions. The same registry loads grammar includes by scope name.
 */
export class GrammarLibrary {
  private byScope = new Map<string, GrammarLocation>();
  private byLanguage = new Map<string, string>();
  private registry: textmate.Registry | undefined;
  private grammarPromises = new Map<string, Promise<textmate.IGrammar | null>>();

  constructor(private readonly output: vscode.OutputChannel) {
    this.refresh();
  }

  refresh(): void {
    this.byScope.clear();
    this.byLanguage.clear();
    this.registry = undefined;
    this.grammarPromises.clear();

    for (const extension of vscode.extensions.all) {
      const contributions = extension.packageJSON?.contributes?.grammars;
      if (!Array.isArray(contributions)) {
        continue;
      }
      for (const contribution of contributions) {
        if (typeof contribution?.scopeName !== 'string' || typeof contribution?.path !== 'string') {
          continue;
        }
        const location: GrammarLocation = {
          extension,
          path: contribution.path,
          scopeName: contribution.scopeName,
        };
        this.byScope.set(location.scopeName, location);
        if (typeof contribution.language === 'string' && !this.byLanguage.has(contribution.language)) {
          this.byLanguage.set(contribution.language, location.scopeName);
        }
      }
    }
  }

  async forLanguage(languageId: string): Promise<textmate.IGrammar | null> {
    const scope = this.byLanguage.get(languageId);
    if (!scope) {
      return null;
    }
    let promise = this.grammarPromises.get(scope);
    if (!promise) {
      promise = this.load(scope);
      this.grammarPromises.set(scope, promise);
    }
    return promise;
  }

  private async load(scope: string): Promise<textmate.IGrammar | null> {
    try {
      await readyOniguruma();
      if (!this.registry) {
        this.registry = new textmate.Registry({
          onigLib: Promise.resolve({
            createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
            createOnigString: (source: string) => new oniguruma.OnigString(source),
          }),
          loadGrammar: async (requestedScope: string) => {
            const location = this.byScope.get(requestedScope);
            if (!location) {
              return null;
            }
            try {
              const uri = vscode.Uri.joinPath(location.extension.extensionUri, location.path);
              const bytes = await vscode.workspace.fs.readFile(uri);
              return textmate.parseRawGrammar(Buffer.from(bytes).toString('utf8'), location.path);
            } catch (error) {
              this.output.appendLine(`Cannot load grammar ${requestedScope}: ${String(error)}`);
              return null;
            }
          },
        });
      }
      return await this.registry.loadGrammar(scope);
    } catch (error) {
      this.output.appendLine(`Cannot initialize highlighting for ${scope}: ${String(error)}`);
      return null;
    }
  }
}

function categoryForScopes(scopes: readonly string[]): ColorCategory {
  for (let index = scopes.length - 1; index >= 0; index--) {
    const scope = scopes[index];
    if (/(^|\.)invalid(\.|$)/.test(scope)) { return 'invalid'; }
    if (/(^|\.)(comment|punctuation\.definition\.comment)(\.|$)/.test(scope)) { return 'comment'; }
    if (/(^|\.)(string|punctuation\.definition\.string)(\.|$)/.test(scope)) { return 'string'; }
    if (/(^|\.)(constant\.numeric|constant\.language)(\.|$)/.test(scope)) { return 'number'; }
    if (/(^|\.)(keyword|storage)(\.|$)/.test(scope)) { return 'keyword'; }
    if (/(^|\.)(entity\.name\.type|entity\.name\.class|support\.type|support\.class)(\.|$)/.test(scope)) { return 'type'; }
    if (/(^|\.)(entity\.name\.function|support\.function)(\.|$)/.test(scope)) { return 'function'; }
    if (/(^|\.)(variable|support\.variable)(\.|$)/.test(scope)) { return 'variable'; }
    if (/(^|\.)(entity\.name\.tag)(\.|$)/.test(scope)) { return 'tag'; }
  }
  return 'plain';
}

function mergedExclusions(region: HeredocRegion, allRegions: readonly HeredocRegion[]): OffsetInterval[] {
  const intervals = allRegions
    .filter(other => other !== region && other.depth > region.depth &&
      other.bodyStart < region.bodyEnd && other.bodyEnd > region.bodyStart)
    .map(other => ({
      start: Math.max(region.bodyStart, other.bodyStart),
      end: Math.min(region.bodyEnd, other.bodyEnd),
    }))
    .sort((a, b) => a.start - b.start);
  const merged: OffsetInterval[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, interval.end) };
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

export class HeredocHighlighter implements vscode.Disposable {
  private readonly grammars: GrammarLibrary;
  private readonly decorations = new Map<string, vscode.TextEditorDecorationType>();
  private readonly painted = new Map<vscode.TextEditor, Set<string>>();
  private readonly requests = new Map<vscode.TextEditor, HighlightRequest>();
  private readonly versions = new WeakMap<vscode.TextEditor, number>();
  private readonly extensionListener: vscode.Disposable;
  private readonly editorListener: vscode.Disposable;
  private readonly viewportListener: vscode.Disposable;
  private disposed = false;

  constructor(_context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    this.grammars = new GrammarLibrary(output);
    this.extensionListener = vscode.extensions.onDidChange(() => {
      this.grammars.refresh();
      for (const [editor, request] of this.requests) {
        void this.update(editor, request.regions);
      }
    });
    this.editorListener = vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const editor of new Set([...this.requests.keys(), ...this.painted.keys()])) {
        if (!editors.includes(editor)) { this.clear(editor); }
      }
    });
    this.viewportListener = vscode.window.onDidChangeTextEditorVisibleRanges(event => {
      const request = this.requests.get(event.textEditor);
      if (request) {
        void this.update(event.textEditor, request.regions);
      }
    });
  }

  /** Paint only body characters; sourceOffsets maps token boundaries to the source document. */
  async update(editor: vscode.TextEditor, regions: HeredocRegion[]): Promise<void> {
    if (this.disposed) { return; }
    const version = (this.versions.get(editor) ?? 0) + 1;
    this.versions.set(editor, version);
    this.requests.set(editor, { regions });

    const byStyle = new Map<string, vscode.Range[]>();
    const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';

    const visible = editor.visibleRanges
      .map(range => ({
        start: editor.document.offsetAt(range.start),
        end: editor.document.offsetAt(range.end),
      }))
      .filter(range => range.end > range.start)
      .sort((a, b) => a.start - b.start);
    const viewportStart = visible[0]?.start ?? Number.POSITIVE_INFINITY;
    const viewportEnd = visible.reduce((end, range) => Math.max(end, range.end), Number.NEGATIVE_INFINITY);

    for (const region of regions) {
      if (this.versions.get(editor) !== version) { return; }
      if (region.bodyEnd <= viewportStart || region.bodyStart >= viewportEnd) { continue; }
      const grammar = await this.grammars.forLanguage(region.languageId);
      if (this.versions.get(editor) !== version) { return; }
      const exclusions = mergedExclusions(region, regions);
      let ruleStack: textmate.StateStack | null = null;
      let lineStart = 0;
      const content = region.content;

      while (lineStart < content.length) {
        let lineEnd = lineStart;
        while (lineEnd < content.length && content[lineEnd] !== '\n' && content[lineEnd] !== '\r') {
          lineEnd++;
        }
        const line = content.slice(lineStart, lineEnd);
        const paint = (from: number, to: number, category: ColorCategory): void => {
          if (from >= to) { return; }
          const start = region.sourceOffsets[lineStart + from];
          const end = region.sourceOffsets[lineStart + to];
          if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) { return; }
          const style = `${theme}:${category}`;
          const addVisible = (from: number, to: number): void => {
            for (const viewport of visible) {
              if (viewport.end <= from) { continue; }
              if (viewport.start >= to) { break; }
              const clippedStart = Math.max(from, viewport.start);
              const clippedEnd = Math.min(to, viewport.end);
              if (clippedStart < clippedEnd) {
                let ranges = byStyle.get(style);
                if (!ranges) { ranges = []; byStyle.set(style, ranges); }
                ranges.push(new vscode.Range(editor.document.positionAt(clippedStart),
                  editor.document.positionAt(clippedEnd)));
              }
            }
          };
          let cursor = start;
          for (const exclusion of exclusions) {
            if (exclusion.end <= cursor) { continue; }
            if (exclusion.start >= end) { break; }
            if (exclusion.start > cursor) {
              addVisible(cursor, Math.min(end, exclusion.start));
            }
            cursor = Math.max(cursor, exclusion.end);
            if (cursor >= end) { return; }
          }
          if (cursor < end) {
            addVisible(cursor, end);
          }
        };

        if (line.length > 0) {
          if (grammar && line.length <= 20000) {
            try {
              const result = grammar.tokenizeLine(line, ruleStack, 50);
              if (result.stoppedEarly) {
                paint(0, line.length, 'plain');
                ruleStack = null;
              } else {
                ruleStack = result.ruleStack;
                for (const token of result.tokens) {
                  paint(token.startIndex, Math.min(token.endIndex, line.length), categoryForScopes(token.scopes));
                }
              }
            } catch (error) {
              this.output.appendLine(`Cannot tokenize ${region.languageId}: ${String(error)}`);
              paint(0, line.length, 'plain');
              ruleStack = null;
            }
          } else {
            paint(0, line.length, 'plain');
            ruleStack = null;
          }
        }
        if (lineEnd >= content.length) { break; }
        lineStart = lineEnd + (content[lineEnd] === '\r' && content[lineEnd + 1] === '\n' ? 2 : 1);
      }
    }

    if (this.versions.get(editor) !== version || this.disposed) { return; }
    const current = new Set(byStyle.keys());
    for (const key of this.painted.get(editor) ?? []) {
      if (!current.has(key)) {
        const decoration = this.decorations.get(key);
        if (decoration) { editor.setDecorations(decoration, []); }
      }
    }
    for (const [key, ranges] of byStyle) {
      editor.setDecorations(this.decorationFor(key), ranges);
    }
    this.painted.set(editor, current);
  }

  clear(editor: vscode.TextEditor): void {
    this.versions.set(editor, (this.versions.get(editor) ?? 0) + 1);
    this.requests.delete(editor);
    for (const key of this.painted.get(editor) ?? []) {
      const decoration = this.decorations.get(key);
      if (decoration) { editor.setDecorations(decoration, []); }
    }
    this.painted.delete(editor);
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.extensionListener.dispose();
    this.editorListener.dispose();
    this.viewportListener.dispose();
    for (const editor of new Set([...this.requests.keys(), ...this.painted.keys()])) {
      this.clear(editor);
    }
    for (const decoration of this.decorations.values()) { decoration.dispose(); }
    this.decorations.clear();
  }

  private decorationFor(key: string): vscode.TextEditorDecorationType {
    let decoration = this.decorations.get(key);
    if (!decoration) {
      const [theme, category] = key.split(':') as ['dark' | 'light', ColorCategory];
      const color = category === 'plain'
        ? new vscode.ThemeColor('editor.foreground')
        : COLORS[theme][category];
      decoration = vscode.window.createTextEditorDecorationType({
        color,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      });
      this.decorations.set(key, decoration);
    }
    return decoration;
  }
}
