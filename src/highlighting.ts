import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import * as textmate from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';
import { HeredocRegion } from './parser';
import { ResolvedTheme, resolveSemanticAppearance, ThemeLoader, TokenAppearance } from './theme';

interface GrammarLocation {
  readonly extension: vscode.Extension<unknown>;
  readonly path: string;
  readonly scopeName: string;
}

interface HighlightRequest {
  readonly regions: HeredocRegion[];
  readonly sourceVersion: number;
}

interface OffsetInterval {
  readonly start: number;
  readonly end: number;
}

interface DecorationStyle extends TokenAppearance {
  /** A ThemeColor reference is used when the theme cannot be read. */
  readonly foreground?: string;
}

interface StyledSegment {
  readonly start: number;
  readonly end: number;
  readonly style: DecorationStyle;
}

interface SemanticSnapshot {
  readonly legend: vscode.SemanticTokensLegend;
  readonly data: Uint32Array;
}

interface SemanticCacheEntry {
  readonly content: string;
  readonly result: Promise<SemanticSnapshot | undefined>;
}

interface SemanticRender {
  readonly segments: StyledSegment[];
  readonly retry: boolean;
}

interface SemanticRetry {
  readonly sourceVersion: number;
  attempts: number;
  timer?: NodeJS.Timeout;
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

function semanticScopeScore(
  selector: string, type: string, modifiers: ReadonlySet<string>, languageId: string,
  supertypes: ReadonlyMap<string, string>,
): number {
  const match = /^([^.:]+)((?:\.[^.:]+)*)(?::(.+))?$/.exec(selector);
  if (!match || (match[3] && match[3] !== languageId)) { return -1; }
  const required = match[2].split('.').filter(Boolean);
  if (required.some(modifier => !modifiers.has(modifier))) { return -1; }
  let typeScore = match[1] === '*' ? 0 : -1;
  let current = type;
  const visited = new Set<string>();
  for (let depth = 0; !visited.has(current); depth++) {
    if (match[1] === current) { typeScore = 100 - depth; break; }
    visited.add(current);
    const parent = supertypes.get(current) ?? (current === 'member' ? 'method' : undefined);
    if (!parent) { break; }
    current = parent;
  }
  return typeScore < 0 ? -1 : typeScore + required.length * 100 + (match[3] ? 10 : 0);
}

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

function* mergeSegments(
  lexical: readonly StyledSegment[], semantic: readonly StyledSegment[],
): Generator<StyledSegment> {
  if (!semantic.length) { yield* lexical; return; }
  const sorted = [...semantic].sort((a, b) => a.start - b.start || a.end - b.end);
  let index = 0;
  for (const token of lexical) {
    let cursor = token.start;
    while (index < sorted.length && sorted[index].end <= cursor) { index++; }
    let next = index;
    while (next < sorted.length && sorted[next].start < token.end) {
      const overlay = sorted[next];
      if (overlay.start > cursor) {
        yield { start: cursor, end: Math.min(overlay.start, token.end), style: token.style };
      }
      const start = Math.max(cursor, overlay.start);
      const end = Math.min(token.end, overlay.end);
      if (start < end) {
        yield { start, end, style: { ...token.style, ...overlay.style } };
        cursor = end;
      }
      if (cursor >= token.end) { break; }
      next++;
    }
    if (cursor < token.end) { yield { start: cursor, end: token.end, style: token.style }; }
  }
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
  private injections = new Map<string, string[]>();
  private semanticSupertypes = new Map<string, string>();
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
    this.injections.clear();
    this.semanticSupertypes.clear();
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
        if (Array.isArray(contribution.injectTo)) {
          for (const target of contribution.injectTo) {
            if (typeof target !== 'string') { continue; }
            const scopes = this.injections.get(target) ?? [];
            if (!scopes.includes(location.scopeName)) { scopes.push(location.scopeName); }
            this.injections.set(target, scopes);
          }
        }
        if (typeof contribution.language === 'string' && !this.byLanguage.has(contribution.language)) {
          this.byLanguage.set(contribution.language, location.scopeName);
        }
      }
    }
    for (const extension of vscode.extensions.all) {
      const types = extension.packageJSON?.contributes?.semanticTokenTypes;
      if (!Array.isArray(types)) { continue; }
      for (const type of types) {
        if (typeof type?.id === 'string' && typeof type?.superType === 'string') {
          this.semanticSupertypes.set(type.id, type.superType);
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
    const candidates: { score: number; scopes: readonly string[] }[] = [];
    const collect = (mapping: ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>,
      sourcePriority: number): void => {
      const entries = mapping instanceof Map ? mapping.entries() : Object.entries(mapping);
      for (const [selector, scopes] of entries) {
        const score = semanticScopeScore(selector, type, modifiers, languageId, this.semanticSupertypes);
        if (score >= 0) { candidates.push({ score: score * 10 + sourcePriority, scopes }); }
      }
    };
    collect(this.semanticScopes.get(languageId) ?? new Map(), 3);
    collect(this.semanticScopes.get('*') ?? new Map(), 2);
    collect(DEFAULT_SEMANTIC_SCOPES, 1);
    candidates.sort((a, b) => b.score - a.score);
    const merged: {
      foreground?: string;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      strikethrough?: boolean;
    } = {};
    for (const candidate of candidates) {
      for (const scope of candidate.scopes) {
        const appearance = await this.appearanceForScope(languageId, scope, hasBaseForeground);
        if (!appearance) { continue; }
        for (const property of [
          'foreground', 'bold', 'italic', 'underline', 'strikethrough',
        ] as const) {
          if (merged[property] === undefined && appearance[property] !== undefined) {
            (merged as Record<string, string | boolean>)[property] = appearance[property]!;
          }
        }
      }
    }
    return Object.keys(merged).length ? merged : undefined;
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
          getInjections: (requestedScope: string) => this.injections.get(requestedScope) ?? [],
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
  private readonly semanticCache = new Map<string, SemanticCacheEntry>();
  private readonly semanticUrisBySource = new Map<string, Set<string>>();
  private readonly semanticRetries = new Map<vscode.TextEditor, SemanticRetry>();
  private readonly extensionListener: vscode.Disposable;
  private readonly editorListener: vscode.Disposable;
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
      this.semanticCache.clear();
      this.semanticUrisBySource.clear();
      for (const editor of this.semanticRetries.keys()) { this.clearSemanticRetry(editor); }
      this.invalidateTheme();
    });
    this.editorListener = vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const editor of new Set([...this.requests.keys(), ...this.painted.keys()])) {
        if (!editors.includes(editor)) { this.clear(editor); }
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

  /** Pre-render every body, including lines outside the viewport. */
  async update(editor: vscode.TextEditor, regions: HeredocRegion[]): Promise<void> {
    if (this.disposed) { return; }
    const oldRequest = this.requests.get(editor);
    if (oldRequest && oldRequest.sourceVersion !== editor.document.version) {
      this.forgetSemanticSource(editor.document.uri.toString());
    }
    const version = (this.versions.get(editor) ?? 0) + 1;
    this.versions.set(editor, version);
    this.requests.set(editor, { regions, sourceVersion: editor.document.version });
    const retry = this.semanticRetries.get(editor);
    if (retry && retry.sourceVersion !== editor.document.version) {
      if (retry.timer) { clearTimeout(retry.timer); }
      this.semanticRetries.delete(editor);
    }
    if (!regions.length) {
      this.forgetSemanticSource(editor.document.uri.toString());
      this.clearSemanticRetry(editor);
      this.paint(editor, new Map(), version);
      return;
    }
    const theme = await this.currentTheme();
    if (!this.isCurrent(editor, version)) { return; }
    const lexical = new Map<HeredocRegion, StyledSegment[]>();
    for (const region of regions) {
      const segments = await this.lexicalSegments(region, theme, () => this.isCurrent(editor, version));
      if (!segments || !this.isCurrent(editor, version)) { return; }
      lexical.set(region, segments);
    }
    const previous = this.painted.get(editor);
    if (!previous?.size) {
      // Give a newly opened editor full-document TextMate colors promptly. The
      // later semantic result is assembled as one replacement, never on scroll.
      const lexicalRanges = await this.rangesFor(editor, regions, lexical, new Map(), version);
      if (!lexicalRanges) { return; }
      this.paint(editor, lexicalRanges, version);
    }
    if (!this.semanticUriForRegion) {
      if (previous?.size) {
        const ranges = await this.rangesFor(editor, regions, lexical, new Map(), version);
        if (ranges) { this.paint(editor, ranges, version); }
      }
      return;
    }
    const renders = await Promise.all(regions.map(region =>
      this.semanticSegments(editor.document, region, theme, () => this.isCurrent(editor, version))));
    if (!this.isCurrent(editor, version)) { return; }
    const semantic = new Map(regions.map((region, index) => [region, renders[index].segments]));
    const byStyle = await this.rangesFor(editor, regions, lexical, semantic, version);
    if (!byStyle) { return; }
    this.paint(editor, byStyle, version);
    if (renders.some(render => render.retry)) {
      this.scheduleSemanticRetry(editor);
    } else {
      this.clearSemanticRetry(editor);
    }
  }

  private isCurrent(editor: vscode.TextEditor, version: number): boolean {
    return !this.disposed && !editor.document.isClosed && this.versions.get(editor) === version &&
      this.requests.get(editor)?.sourceVersion === editor.document.version;
  }

  private async lexicalSegments(
    region: HeredocRegion, theme: ResolvedTheme, isCurrent: () => boolean,
  ): Promise<StyledSegment[] | undefined> {
    const grammar = await this.grammars.forLanguage(region.languageId);
    if (!isCurrent()) { return undefined; }
    const segments: StyledSegment[] = [];
    let ruleStack: textmate.StateStack | null = null;
    let lineStart = 0;
    let processed = 0;
    const content = region.content;
    while (lineStart < content.length) {
      if (++processed % 200 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (!isCurrent()) { return undefined; }
      }
      let lineEnd = lineStart;
      while (lineEnd < content.length && content[lineEnd] !== '\n' && content[lineEnd] !== '\r') { lineEnd++; }
      const line = content.slice(lineStart, lineEnd);
      const add = (from: number, to: number, style: DecorationStyle): void => {
        if (from < to) { segments.push({ start: lineStart + from, end: lineStart + to, style }); }
      };
      if (line.length > 0) {
        if (grammar && line.length <= 20000) {
          try {
            const result = grammar.tokenizeLine2(line, ruleStack, 50);
            if (result.stoppedEarly) {
              add(0, line.length, { foreground: '@editor.foreground' });
              ruleStack = null;
            } else {
              ruleStack = result.ruleStack;
              const colors = this.grammars.getColorMap();
              for (let index = 0; index < result.tokens.length; index += 2) {
                const start = result.tokens[index];
                const end = index + 2 < result.tokens.length ? result.tokens[index + 2] : line.length;
                add(start, Math.min(end, line.length),
                  appearanceFromMetadata(result.tokens[index + 1], colors, theme.hasBaseForeground));
              }
            }
          } catch (error) {
            this.output.appendLine(`Cannot tokenize ${region.languageId}: ${String(error)}`);
            add(0, line.length, { foreground: '@editor.foreground' });
            ruleStack = null;
          }
        } else {
          add(0, line.length, { foreground: '@editor.foreground' });
          ruleStack = null;
        }
      }
      if (lineEnd >= content.length) { break; }
      lineStart = lineEnd + (content[lineEnd] === '\r' && content[lineEnd + 1] === '\n' ? 2 : 1);
    }
    return segments;
  }

  private async rangesFor(
    editor: vscode.TextEditor, regions: readonly HeredocRegion[],
    lexical: ReadonlyMap<HeredocRegion, readonly StyledSegment[]>,
    semantic: ReadonlyMap<HeredocRegion, readonly StyledSegment[]>, version: number,
  ): Promise<Map<string, vscode.Range[]> | undefined> {
    const byStyle = new Map<string, vscode.Range[]>();
    let processed = 0;
    for (const region of regions) {
      const exclusions = mergedExclusions(region, regions);
      for (const segment of mergeSegments(lexical.get(region) ?? [], semantic.get(region) ?? [])) {
        if (++processed % 5000 === 0) {
          await new Promise<void>(resolve => setImmediate(resolve));
          if (!this.isCurrent(editor, version)) { return undefined; }
        }
        this.addRanges(byStyle, segment.style, region, segment.start, segment.end, editor, exclusions);
      }
    }
    return this.isCurrent(editor, version) ? byStyle : undefined;
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
    editor: vscode.TextEditor, exclusions: readonly OffsetInterval[],
  ): void {
    if (localStart >= localEnd) { return; }
    const start = region.sourceOffsets[localStart];
    const end = region.sourceOffsets[localEnd];
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) { return; }
    const key = JSON.stringify(style);
    this.styles.set(key, style);
    const add = (from: number, to: number): void => {
      if (from >= to) { return; }
      let ranges = byStyle.get(key);
      if (!ranges) { ranges = []; byStyle.set(key, ranges); }
      const startPosition = editor.document.positionAt(from);
      const endPosition = editor.document.positionAt(to);
      const previous = ranges[ranges.length - 1];
      if (previous?.end.isEqual(startPosition)) {
        ranges[ranges.length - 1] = new vscode.Range(previous.start, endPosition);
      } else {
        ranges.push(new vscode.Range(startPosition, endPosition));
      }
    };
    let cursor = start;
    for (const exclusion of exclusions) {
      if (exclusion.end <= cursor) { continue; }
      if (exclusion.start >= end) { break; }
      if (exclusion.start > cursor) { add(cursor, Math.min(end, exclusion.start)); }
      cursor = Math.max(cursor, exclusion.end);
      if (cursor >= end) { return; }
    }
    if (cursor < end) { add(cursor, end); }
  }

  private paint(editor: vscode.TextEditor, byStyle: Map<string, vscode.Range[]>, version: number): void {
    if (this.versions.get(editor) !== version || this.disposed) { return; }
    const current = new Set(byStyle.keys());
    // Apply replacement colors before dropping older decoration types so a
    // repaint never exposes the shell grammar's heredoc string color in between.
    for (const [key, ranges] of byStyle) { editor.setDecorations(this.decorationFor(key), ranges); }
    for (const key of this.painted.get(editor) ?? []) {
      if (!current.has(key)) {
        const decoration = this.decorations.get(key);
        if (decoration) { editor.setDecorations(decoration, []); }
      }
    }
    this.painted.set(editor, current);
    this.disposeUnusedDecorations();
  }

  private disposeUnusedDecorations(): void {
    const active = new Set<string>();
    for (const keys of this.painted.values()) {
      for (const key of keys) { active.add(key); }
    }
    for (const [key, decoration] of this.decorations) {
      if (!active.has(key)) {
        decoration.dispose();
        this.decorations.delete(key);
        this.styles.delete(key);
      }
    }
  }

  private async semanticSegments(
    source: vscode.TextDocument, region: HeredocRegion, theme: ResolvedTheme,
    isCurrent: () => boolean,
  ): Promise<SemanticRender> {
    const lease = this.semanticUriForRegion?.(source, region);
    if (!lease) { return { segments: [], retry: false }; }
    try {
      const uri = lease.uri;
      const setting = vscode.workspace.getConfiguration('editor', { uri, languageId: region.languageId })
        .get<boolean | 'configuredByTheme'>('semanticHighlighting.enabled', 'configuredByTheme');
      if (setting === false || (setting !== true && !theme.semanticHighlighting)) {
        return { segments: [], retry: false };
      }
      const key = uri.toString();
      const sourceKey = source.uri.toString();
      const sourceUris = this.semanticUrisBySource.get(sourceKey) ?? new Set<string>();
      sourceUris.add(key);
      this.semanticUrisBySource.set(sourceKey, sourceUris);
      let cached = this.semanticCache.get(key);
      if (!cached || cached.content !== region.content) {
        cached = {
          content: region.content,
          result: Promise.all([
            vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
              'vscode.provideDocumentSemanticTokensLegend', uri),
            vscode.commands.executeCommand<vscode.SemanticTokens>(
              'vscode.provideDocumentSemanticTokens', uri),
          ]).then(([legend, tokens]) => legend && tokens?.data
            ? { legend, data: tokens.data } : undefined).catch(error => {
            this.output.appendLine(`Cannot read semantic tokens for ${region.languageId}: ${String(error)}`);
            return undefined;
          }),
        };
        this.semanticCache.set(key, cached);
        while (this.semanticCache.size > 64) {
          const oldest = this.semanticCache.keys().next().value;
          if (oldest === undefined) { break; }
          this.semanticCache.delete(oldest);
        }
      }
      const snapshot = await cached.result;
      if (!isCurrent()) { return { segments: [], retry: false }; }
      if (!snapshot) {
        if (this.semanticCache.get(key) === cached) { this.semanticCache.delete(key); }
        return { segments: [], retry: true };
      }
      const { legend, data } = snapshot;
      const lineStarts = [0];
      for (let index = 0; index < region.content.length; index++) {
        if (region.content[index] === '\n') { lineStarts.push(index + 1); }
        else if (region.content[index] === '\r' && region.content[index + 1] !== '\n') {
          lineStarts.push(index + 1);
        }
      }
      const segments: StyledSegment[] = [];
      const styleCache = new Map<string, Promise<DecorationStyle | undefined>>();
      let line = 0;
      let character = 0;
      for (let index = 0; index + 4 < data.length; index += 5) {
        if (index > 0 && index % 2500 === 0) {
          await new Promise<void>(resolve => setImmediate(resolve));
          if (!isCurrent()) { return { segments: [], retry: false }; }
        }
        line += data[index];
        character = data[index] ? data[index + 1] : character + data[index + 1];
        const type = legend.tokenTypes[data[index + 3]];
        if (!type || line >= lineStarts.length) { continue; }
        const modifierMask = data[index + 4];
        const modifiers = new Set<string>();
        for (let bit = 0; bit < legend.tokenModifiers.length && bit < 32; bit++) {
          if ((modifierMask & (1 << bit)) !== 0) {
            modifiers.add(legend.tokenModifiers[bit]);
          }
        }
        const styleKey = `${type}\u0000${modifierMask}`;
        let stylePromise = styleCache.get(styleKey);
        if (!stylePromise) {
          stylePromise = this.grammars.semanticAppearance(
            region.languageId, type, modifiers, theme.hasBaseForeground,
          ).then(fallback => resolveSemanticAppearance(
            theme, type, modifiers, region.languageId, fallback,
          ));
          styleCache.set(styleKey, stylePromise);
        }
        const style = await stylePromise;
        if (!isCurrent()) { return { segments: [], retry: false }; }
        if (!style) { continue; }
        const start = lineStarts[line] + character;
        const end = start + data[index + 2];
        const nextLine = line + 1 < lineStarts.length ? lineStarts[line + 1] : region.content.length;
        if (start >= 0 && end <= nextLine && end <= region.content.length) {
          segments.push({ start, end, style });
        }
      }
      return { segments, retry: false };
    } catch (error) {
      this.output.appendLine(`Cannot style semantic tokens for ${region.languageId}: ${String(error)}`);
      return { segments: [], retry: false };
    } finally {
      lease.release();
    }
  }

  private scheduleSemanticRetry(editor: vscode.TextEditor): void {
    let retry = this.semanticRetries.get(editor);
    if (!retry || retry.sourceVersion !== editor.document.version) {
      retry = { sourceVersion: editor.document.version, attempts: 0 };
      this.semanticRetries.set(editor, retry);
    }
    if (retry.timer || retry.attempts >= 3) { return; }
    const delays = [700, 1800, 4000];
    retry.timer = setTimeout(() => {
      retry!.timer = undefined;
      const request = this.requests.get(editor);
      if (request && !editor.document.isClosed && editor.document.version === retry!.sourceVersion) {
        void this.update(editor, request.regions);
      }
    }, delays[retry.attempts++]);
  }

  private clearSemanticRetry(editor: vscode.TextEditor): void {
    const retry = this.semanticRetries.get(editor);
    if (retry?.timer) { clearTimeout(retry.timer); }
    this.semanticRetries.delete(editor);
  }

  private forgetSemanticSource(sourceKey: string): void {
    for (const uri of this.semanticUrisBySource.get(sourceKey) ?? []) { this.semanticCache.delete(uri); }
    this.semanticUrisBySource.delete(sourceKey);
  }

  clear(editor: vscode.TextEditor): void {
    this.versions.set(editor, (this.versions.get(editor) ?? 0) + 1);
    this.requests.delete(editor);
    this.clearSemanticRetry(editor);
    const sourceKey = editor.document.uri.toString();
    if (![...this.requests.keys()].some(other => other.document.uri.toString() === sourceKey)) {
      this.forgetSemanticSource(sourceKey);
    }
    for (const key of this.painted.get(editor) ?? []) {
      const decoration = this.decorations.get(key);
      if (decoration) { editor.setDecorations(decoration, []); }
    }
    this.painted.delete(editor);
    this.disposeUnusedDecorations();
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.extensionListener.dispose();
    this.editorListener.dispose();
    this.themeListener.dispose();
    this.configurationListener.dispose();
    for (const editor of new Set([...this.requests.keys(), ...this.painted.keys()])) {
      this.clear(editor);
    }
    for (const decoration of this.decorations.values()) { decoration.dispose(); }
    this.decorations.clear();
    this.styles.clear();
    this.semanticCache.clear();
    this.semanticUrisBySource.clear();
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
