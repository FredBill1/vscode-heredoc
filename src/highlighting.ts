import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import * as textmate from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';
import { HeredocRegion } from './parser';
import { ResolvedTheme, semanticAppearance, ThemeLoader, TokenAppearance } from './theme';

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

interface DecorationStyle extends TokenAppearance {
  /** A ThemeColor reference is used when the theme cannot be read. */
  readonly foreground?: string;
}

interface SemanticSegment {
  readonly region: HeredocRegion;
  readonly start: number;
  readonly end: number;
  readonly style: DecorationStyle;
}

const FONT_STYLE_OFFSET = 11;
const FOREGROUND_OFFSET = 15;
const FOREGROUND_MASK = 0x1ff;

const DEFAULT_SEMANTIC_SCOPES: Readonly<Record<string, readonly string[]>> = {
  namespace: ['entity.name.namespace'],
  type: ['entity.name.type'],
  'type.defaultLibrary': ['support.type'],
  struct: ['storage.type.struct'],
  class: ['entity.name.type.class'],
  'class.defaultLibrary': ['support.class'],
  interface: ['entity.name.type.interface'],
  enum: ['entity.name.type.enum'],
  function: ['entity.name.function'],
  'function.defaultLibrary': ['support.function'],
  method: ['entity.name.function.member'],
  macro: ['entity.name.function.preprocessor'],
  variable: ['variable.other.readwrite', 'entity.name.variable'],
  'variable.readonly': ['variable.other.constant'],
  'variable.readonly.defaultLibrary': ['support.constant'],
  parameter: ['variable.parameter'],
  property: ['variable.other.property'],
  'property.readonly': ['variable.other.constant.property'],
  enumMember: ['variable.other.enummember'],
  event: ['variable.other.event'],
};

function appearanceFromMetadata(metadata: number, colorMap: readonly string[], hasBaseForeground: boolean): DecorationStyle {
  const foregroundId = (metadata >>> FOREGROUND_OFFSET) & FOREGROUND_MASK;
  const fontStyle = (metadata >>> FONT_STYLE_OFFSET) & 0xf;
  return {
    foreground: foregroundId > 1 || hasBaseForeground
      ? colorMap[foregroundId] ?? '@editor.foreground' : '@editor.foreground',
    italic: Boolean(fontStyle & 1),
    bold: Boolean(fontStyle & 2),
    underline: Boolean(fontStyle & 4),
    strikethrough: Boolean(fontStyle & 8),
  };
}

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
  private semanticStylePromises = new Map<string, Promise<DecorationStyle | undefined>>();
  private semanticScopes = new Map<string, Map<string, string[]>>();
  private semanticGrammarId = 0;
  private theme: textmate.IRawTheme | undefined;

  constructor(private readonly output: vscode.OutputChannel) {
    this.refresh();
  }

  refresh(): void {
    this.byScope.clear();
    this.byLanguage.clear();
    this.registry = undefined;
    this.grammarPromises.clear();
    this.semanticStylePromises.clear();
    this.semanticScopes.clear();

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
    for (const extension of vscode.extensions.all) {
      const contributions = extension.packageJSON?.contributes?.semanticTokenScopes;
      if (!Array.isArray(contributions)) { continue; }
      for (const contribution of contributions) {
        const language = typeof contribution?.language === 'string' ? contribution.language : '*';
        let bySelector = this.semanticScopes.get(language);
        if (!bySelector) { bySelector = new Map(); this.semanticScopes.set(language, bySelector); }
        if (!contribution?.scopes || typeof contribution.scopes !== 'object') { continue; }
        for (const [selector, scopes] of Object.entries(contribution.scopes as Record<string, unknown>)) {
          if (Array.isArray(scopes) && scopes.every(scope => typeof scope === 'string')) {
            bySelector.set(selector, scopes as string[]);
          }
        }
      }
    }
  }

  setTheme(theme: textmate.IRawTheme): void {
    this.theme = theme;
    this.registry?.setTheme(theme);
    this.semanticStylePromises.clear();
  }

  getColorMap(): string[] {
    return this.registry?.getColorMap() ?? [];
  }

  async semanticAppearance(
    languageId: string, type: string, modifiers: ReadonlySet<string>, hasBaseForeground: boolean,
  ): Promise<DecorationStyle | undefined> {
    const selectors = [
      `${type}.readonly.defaultLibrary`, `${type}.readonly`, `${type}.defaultLibrary`, type,
    ].filter(selector => {
      const required = selector.slice(type.length).split('.').filter(Boolean);
      return required.every(modifier => modifiers.has(modifier));
    });
    for (const selector of selectors) {
      const scopes = this.semanticScopes.get(languageId)?.get(selector) ??
        this.semanticScopes.get('*')?.get(selector) ?? DEFAULT_SEMANTIC_SCOPES[selector] ?? [];
      for (const scope of scopes) {
        const appearance = await this.appearanceForScope(languageId, scope, hasBaseForeground);
        if (appearance) { return appearance; }
      }
    }
    return undefined;
  }

  private async appearanceForScope(
    languageId: string, scope: string, hasBaseForeground: boolean,
  ): Promise<DecorationStyle | undefined> {
    const key = `${languageId}\u0000${scope}`;
    let promise = this.semanticStylePromises.get(key);
    if (!promise) {
      promise = (async () => {
        const grammar = await this.forLanguage(languageId);
        if (!grammar || !this.registry) { return undefined; }
        const baseScope = this.byLanguage.get(languageId)!;
        const raw = {
          scopeName: `${baseScope}.heredoc.semantic.${++this.semanticGrammarId}`,
          patterns: [{ match: 'b', name: scope }],
          repository: {},
        } as unknown as textmate.IRawGrammar;
        const synthetic = await this.registry.addGrammar(raw);
        const tokens = synthetic.tokenizeLine2('ab', null).tokens;
        const baseMetadata = tokens[1];
        let namedMetadata: number | undefined;
        for (let index = 0; index < tokens.length; index += 2) {
          if (tokens[index] <= 1) { namedMetadata = tokens[index + 1]; }
        }
        if (namedMetadata === undefined) { return undefined; }
        const baseForeground = (baseMetadata >>> FOREGROUND_OFFSET) & FOREGROUND_MASK;
        const namedForeground = (namedMetadata >>> FOREGROUND_OFFSET) & FOREGROUND_MASK;
        const baseFont = (baseMetadata >>> FONT_STYLE_OFFSET) & 0xf;
        const namedFont = (namedMetadata >>> FONT_STYLE_OFFSET) & 0xf;
        const appearance: {
          foreground?: string;
          italic?: boolean;
          bold?: boolean;
          underline?: boolean;
          strikethrough?: boolean;
        } = {};
        if (namedForeground !== baseForeground) {
          appearance.foreground = namedForeground > 1 || hasBaseForeground
            ? this.getColorMap()[namedForeground] ?? '@editor.foreground' : '@editor.foreground';
        }
        for (const [bit, property] of [
          [1, 'italic'], [2, 'bold'], [4, 'underline'], [8, 'strikethrough'],
        ] as const) {
          if (Boolean(namedFont & bit) !== Boolean(baseFont & bit)) {
            appearance[property] = Boolean(namedFont & bit);
          }
        }
        return Object.keys(appearance).length ? appearance : undefined;
      })().catch(error => {
        this.output.appendLine(`Cannot resolve semantic scope ${scope}: ${String(error)}`);
        return undefined;
      });
      this.semanticStylePromises.set(key, promise);
    }
    return promise;
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
          theme: this.theme,
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
  private readonly themes: ThemeLoader;
  private readonly decorations = new Map<string, vscode.TextEditorDecorationType>();
  private readonly styles = new Map<string, DecorationStyle>();
  private readonly painted = new Map<vscode.TextEditor, Set<string>>();
  private readonly requests = new Map<vscode.TextEditor, HighlightRequest>();
  private readonly versions = new WeakMap<vscode.TextEditor, number>();
  private readonly extensionListener: vscode.Disposable;
  private readonly editorListener: vscode.Disposable;
  private readonly viewportListener: vscode.Disposable;
  private readonly themeListener: vscode.Disposable;
  private readonly configurationListener: vscode.Disposable;
  private themePromise: Promise<ResolvedTheme> | undefined;
  private themeGeneration = 0;
  private disposed = false;

  constructor(
    _context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly semanticUriForRegion?: (source: vscode.TextDocument, region: HeredocRegion) =>
      { uri: vscode.Uri; release(): void } | undefined,
  ) {
    this.grammars = new GrammarLibrary(output);
    this.themes = new ThemeLoader(output);
    this.extensionListener = vscode.extensions.onDidChange(() => {
      this.grammars.refresh();
      this.invalidateTheme();
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
    this.themeListener = vscode.window.onDidChangeActiveColorTheme(() => this.invalidateTheme());
    this.configurationListener = vscode.workspace.onDidChangeConfiguration(event => {
      if ([
        'workbench.colorTheme', 'workbench.colorCustomizations',
        'editor.tokenColorCustomizations', 'editor.semanticTokenColorCustomizations',
        'editor.semanticHighlighting.enabled',
      ].some(setting => event.affectsConfiguration(setting))) {
        this.invalidateTheme();
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
    const theme = await this.currentTheme();
    if (this.versions.get(editor) !== version || this.disposed) { return; }

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
        const paint = (from: number, to: number, style: DecorationStyle): void =>
          this.addRanges(byStyle, style, region, lineStart + from, lineStart + to,
            editor, visible, exclusions);

        if (line.length > 0) {
          if (grammar && line.length <= 20000) {
            try {
              const result = grammar.tokenizeLine2(line, ruleStack, 50);
              if (result.stoppedEarly) {
                paint(0, line.length, { foreground: '@editor.foreground' });
                ruleStack = null;
              } else {
                ruleStack = result.ruleStack;
                const colors = this.grammars.getColorMap();
                for (let index = 0; index < result.tokens.length; index += 2) {
                  const start = result.tokens[index];
                  const end = index + 2 < result.tokens.length ? result.tokens[index + 2] : line.length;
                  const metadata = result.tokens[index + 1];
                  paint(start, Math.min(end, line.length),
                    appearanceFromMetadata(metadata, colors, theme.hasBaseForeground));
                }
              }
            } catch (error) {
              this.output.appendLine(`Cannot tokenize ${region.languageId}: ${String(error)}`);
              paint(0, line.length, { foreground: '@editor.foreground' });
              ruleStack = null;
            }
          } else {
            paint(0, line.length, { foreground: '@editor.foreground' });
            ruleStack = null;
          }
        }
        if (lineEnd >= content.length) { break; }
        lineStart = lineEnd + (content[lineEnd] === '\r' && content[lineEnd + 1] === '\n' ? 2 : 1);
      }
    }

    this.paint(editor, byStyle, version);

    // Semantic providers may start after the TextMate paint. Keep the lexical
    // colors visible while asking the already-open embedded document for tokens.
    if (this.semanticUriForRegion) {
      const visibleRegions = regions.filter(region =>
        region.bodyEnd > viewportStart && region.bodyStart < viewportEnd);
      const segments = await Promise.all(visibleRegions.map(region =>
        this.semanticSegments(editor.document, region, theme)));
      if (this.versions.get(editor) !== version || this.disposed) { return; }
      for (const segment of segments.flat()) {
        const exclusions = mergedExclusions(segment.region, regions);
        this.addRanges(byStyle, segment.style, segment.region, segment.start, segment.end,
          editor, visible, exclusions);
      }
      this.paint(editor, byStyle, version);
    }
  }

  private async currentTheme(): Promise<ResolvedTheme> {
    if (!this.themePromise) {
      const generation = this.themeGeneration;
      this.themePromise = this.themes.load().then(theme => {
        if (generation === this.themeGeneration) { this.grammars.setTheme(theme.textmate); }
        return theme;
      });
    }
    return this.themePromise;
  }

  private invalidateTheme(): void {
    this.themeGeneration++;
    this.themePromise = undefined;
    for (const [editor, request] of this.requests) {
      void this.update(editor, request.regions);
    }
  }

  private addRanges(
    byStyle: Map<string, vscode.Range[]>, style: DecorationStyle,
    region: HeredocRegion, localStart: number, localEnd: number,
    editor: vscode.TextEditor, visible: readonly OffsetInterval[], exclusions: readonly OffsetInterval[],
  ): void {
    if (localStart >= localEnd) { return; }
    const start = region.sourceOffsets[localStart];
    const end = region.sourceOffsets[localEnd];
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) { return; }
    const key = JSON.stringify(style);
    this.styles.set(key, style);
    const addVisible = (from: number, to: number): void => {
      for (const viewport of visible) {
        if (viewport.end <= from) { continue; }
        if (viewport.start >= to) { break; }
        const clippedStart = Math.max(from, viewport.start);
        const clippedEnd = Math.min(to, viewport.end);
        if (clippedStart < clippedEnd) {
          let ranges = byStyle.get(key);
          if (!ranges) { ranges = []; byStyle.set(key, ranges); }
          ranges.push(new vscode.Range(editor.document.positionAt(clippedStart),
            editor.document.positionAt(clippedEnd)));
        }
      }
    };
    let cursor = start;
    for (const exclusion of exclusions) {
      if (exclusion.end <= cursor) { continue; }
      if (exclusion.start >= end) { break; }
      if (exclusion.start > cursor) { addVisible(cursor, Math.min(end, exclusion.start)); }
      cursor = Math.max(cursor, exclusion.end);
      if (cursor >= end) { return; }
    }
    if (cursor < end) { addVisible(cursor, end); }
  }

  private paint(editor: vscode.TextEditor, byStyle: Map<string, vscode.Range[]>, version: number): void {
    if (this.versions.get(editor) !== version || this.disposed) { return; }
    const current = new Set(byStyle.keys());
    for (const key of this.painted.get(editor) ?? []) {
      if (!current.has(key)) {
        const decoration = this.decorations.get(key);
        if (decoration) { editor.setDecorations(decoration, []); }
      }
    }
    for (const [key, ranges] of byStyle) { editor.setDecorations(this.decorationFor(key), ranges); }
    this.painted.set(editor, current);
  }

  private async semanticSegments(
    source: vscode.TextDocument, region: HeredocRegion, theme: ResolvedTheme,
  ): Promise<SemanticSegment[]> {
    const lease = this.semanticUriForRegion?.(source, region);
    if (!lease) { return []; }
    try {
      const uri = lease.uri;
      const setting = vscode.workspace.getConfiguration('editor', { uri, languageId: region.languageId })
        .get<boolean | 'configuredByTheme'>('semanticHighlighting.enabled', 'configuredByTheme');
      if (setting === false || (setting !== true && !theme.semanticHighlighting)) { return []; }
      const [legend, tokens] = await Promise.all([
        vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
          'vscode.provideDocumentSemanticTokensLegend', uri),
        vscode.commands.executeCommand<vscode.SemanticTokens>(
          'vscode.provideDocumentSemanticTokens', uri),
      ]);
      if (!legend || !tokens?.data) { return []; }
      const lineStarts = [0];
      for (let index = 0; index < region.content.length; index++) {
        if (region.content[index] === '\n') { lineStarts.push(index + 1); }
        else if (region.content[index] === '\r' && region.content[index + 1] !== '\n') {
          lineStarts.push(index + 1);
        }
      }
      const segments: SemanticSegment[] = [];
      let line = 0;
      let character = 0;
      for (let index = 0; index + 4 < tokens.data.length; index += 5) {
        line += tokens.data[index];
        character = tokens.data[index] ? tokens.data[index + 1] : character + tokens.data[index + 1];
        const type = legend.tokenTypes[tokens.data[index + 3]];
        if (!type || line >= lineStarts.length) { continue; }
        const modifiers = new Set<string>();
        for (let bit = 0; bit < legend.tokenModifiers.length && bit < 32; bit++) {
          if ((tokens.data[index + 4] & (1 << bit)) !== 0) {
            modifiers.add(legend.tokenModifiers[bit]);
          }
        }
        const style = semanticAppearance(theme.semanticTokenColors, type, modifiers, region.languageId) ??
          await this.grammars.semanticAppearance(region.languageId, type, modifiers, theme.hasBaseForeground);
        if (!style) { continue; }
        const start = lineStarts[line] + character;
        const end = start + tokens.data[index + 2];
        const nextLine = line + 1 < lineStarts.length ? lineStarts[line + 1] : region.content.length;
        if (start >= 0 && end <= nextLine && end <= region.content.length) {
          segments.push({ region, start, end, style });
        }
      }
      return segments;
    } catch (error) {
      this.output.appendLine(`Cannot read semantic tokens for ${region.languageId}: ${String(error)}`);
      return [];
    } finally {
      lease.release();
    }
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
    this.themeListener.dispose();
    this.configurationListener.dispose();
    for (const editor of new Set([...this.requests.keys(), ...this.painted.keys()])) {
      this.clear(editor);
    }
    for (const decoration of this.decorations.values()) { decoration.dispose(); }
    this.decorations.clear();
    this.styles.clear();
  }

  private decorationFor(key: string): vscode.TextEditorDecorationType {
    let decoration = this.decorations.get(key);
    if (!decoration) {
      const style = this.styles.get(key) ?? {};
      decoration = vscode.window.createTextEditorDecorationType({
        color: style.foreground === '@editor.foreground'
          ? new vscode.ThemeColor('editor.foreground') : style.foreground,
        fontWeight: style.bold === undefined ? undefined : style.bold ? 'bold' : 'normal',
        fontStyle: style.italic === undefined ? undefined : style.italic ? 'italic' : 'normal',
        textDecoration: style.underline === undefined && style.strikethrough === undefined
          ? undefined
          : [style.underline ? 'underline' : '', style.strikethrough ? 'line-through' : '']
            .filter(Boolean).join(' ') || 'none',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      });
      this.decorations.set(key, decoration);
    }
    return decoration;
  }
}
