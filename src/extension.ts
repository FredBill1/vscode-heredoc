import * as vscode from 'vscode';
import { HeredocHighlighter } from './highlighting';
import { RegionMapper, findInnermostRegion } from './mapping';
import { HeredocRegion, parseHeredocs } from './parser';
import { DocumentMode, RuleResolver } from './rules';
import { ShadowDocument, ShadowLease, ShadowManager } from './shadow';
import { requestTypeScriptSyntaxDiagnostics } from './tsDiagnostics';

interface SourceState {
  document: vscode.TextDocument;
  version: number;
  regions: HeredocRegion[];
  resolver: RuleResolver;
}

interface ResolvedRequest {
  lease: ShadowLease;
  mapper: RegionMapper;
  sourceVersion: number;
}

interface PulledDiagnostics {
  sourceKey: string;
  content: string;
  diagnostics: readonly vscode.Diagnostic[];
}

const DISALLOWED_SHELL_SUFFIX = /\.(?:fish|zsh|zshrc|zprofile|zlogin|zlogout|zshenv|ksh|csh|tcsh|yash)$/i;
const DISALLOWED_SHEBANG = /^#![^\r\n]*\b(?:fish|zsh|ksh|csh|tcsh|yash)(?:\s|$)/;

function waitForSyntaxRetry(ms: number, token: vscode.CancellationToken): Promise<void> {
  if (token.isCancellationRequested) return Promise.resolve();
  return new Promise(resolve => {
    let finished = false;
    let listener: vscode.Disposable | undefined;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      listener?.dispose();
      resolve();
    };
    const timer = setTimeout(done, ms);
    listener = token.onCancellationRequested(done);
    if (token.isCancellationRequested) done();
  });
}

function isSupportedShell(document: vscode.TextDocument, shadows: ShadowManager): boolean {
  if (document.languageId !== 'shellscript' || shadows.isShadowUri(document.uri)) {
    return false;
  }
  if (DISALLOWED_SHELL_SUFFIX.test(document.uri.path)) {
    return false;
  }
  return !DISALLOWED_SHEBANG.test(document.lineCount ? document.lineAt(0).text : '');
}

function cloneCompletion(item: vscode.CompletionItem, mapper: RegionMapper): vscode.CompletionItem | undefined {
  // executeCompletionItemProvider returns an object carrying VS Code-internal
  // metadata. Copy only public fields, otherwise its original shadow range can
  // replace the remapped range when our result crosses another provider boundary.
  const copy = new vscode.CompletionItem(item.label, item.kind);
  copy.detail = item.detail;
  copy.documentation = item.documentation;
  copy.sortText = item.sortText;
  copy.filterText = item.filterText;
  copy.preselect = item.preselect;
  copy.insertText = item.insertText;
  copy.commitCharacters = item.commitCharacters;
  copy.keepWhitespace = item.keepWhitespace;
  copy.tags = item.tags;
  if (item.range) {
    if ('start' in item.range && 'end' in item.range) {
      const mapped = mapper.toSourceRange(item.range as vscode.Range, true);
      if (!mapped || !mapper.withinBody(mapped)) {
        return undefined;
      }
      copy.range = mapped;
    } else {
      const inserting = mapper.toSourceRange(item.range.inserting, true);
      const replacing = mapper.toSourceRange(item.range.replacing, true);
      if (!inserting || !replacing || !mapper.withinBody(inserting) || !mapper.withinBody(replacing)) {
        return undefined;
      }
      copy.range = { inserting, replacing };
    }
  }
  copy.additionalTextEdits = item.additionalTextEdits?.flatMap(edit => {
    const range = mapper.toSourceRange(edit.range, true);
    return range && mapper.withinBody(range) ? [new vscode.TextEdit(range, edit.newText)] : [];
  });
  // Commands supplied by another extension may still reference the hidden URI.
  copy.command = undefined;
  return copy;
}

function mapLocation(
  location: vscode.Location | vscode.LocationLink,
  shadow: ShadowDocument,
  mapper: RegionMapper,
): vscode.LocationLink | undefined {
  if (location instanceof vscode.Location || 'uri' in location) {
    const candidate = location as vscode.Location;
    if (candidate.uri.toString() !== shadow.uri.toString()) {
      return candidate.uri.scheme === 'file' || candidate.uri.scheme === 'vscode-remote'
        ? { targetUri: candidate.uri, targetRange: candidate.range, targetSelectionRange: candidate.range }
        : undefined;
    }
    const range = mapper.toSourceRange(candidate.range);
    return range && mapper.withinBody(range)
      ? { targetUri: mapper.source.uri, targetRange: range, targetSelectionRange: range }
      : undefined;
  }
  const link = location as vscode.LocationLink;
  const originSelectionRange = link.originSelectionRange
    ? mapper.toSourceRange(link.originSelectionRange)
    : undefined;
  if (link.targetUri.toString() !== shadow.uri.toString()) {
    if (link.targetUri.scheme !== 'file' && link.targetUri.scheme !== 'vscode-remote') {
      return undefined;
    }
    return { ...link, originSelectionRange };
  }
  const targetRange = mapper.toSourceRange(link.targetRange);
  const targetSelectionRange = mapper.toSourceRange(link.targetSelectionRange ?? link.targetRange);
  if (!targetRange || !targetSelectionRange || !mapper.withinBody(targetRange) || !mapper.withinBody(targetSelectionRange)) {
    return undefined;
  }
  return { ...link, targetUri: mapper.source.uri, targetRange, targetSelectionRange, originSelectionRange };
}

class HeredocExtension implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('Shell Heredoc');
  private readonly shadows: ShadowManager;
  private readonly highlighter: HeredocHighlighter;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('heredoc');
  private readonly states = new Map<string, SourceState>();
  private readonly syncTimers = new Map<string, NodeJS.Timeout>();
  private readonly syntaxRequests = new Map<string, vscode.CancellationTokenSource>();
  private readonly pulledDiagnostics = new Map<string, PulledDiagnostics>();
  private readonly disposables: vscode.Disposable[] = [];
  private registeredLanguages = new Set<string>();
  private shutdownPromise?: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.shadows = new ShadowManager(context, this.output);
    this.highlighter = new HeredocHighlighter(context, this.output, (source, region) => {
      const lease = this.shadows.pinCurrent(source, region);
      return lease ? { uri: lease.shadow.uri, release: lease.release } : undefined;
    });
    this.disposables.push(this.output, this.diagnostics, this.shadows, this.highlighter);
  }

  async activate(): Promise<void> {
    this.registeredLanguages = new Set(await vscode.languages.getLanguages());
    await this.shadows.cleanupStaleFiles();
    this.disposables.push(vscode.workspace.onDidOpenTextDocument(document => this.refresh(document)));
    this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => this.refresh(event.document)));
    this.disposables.push(vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString();
      if (this.states.delete(key)) {
        this.cancelSync(key);
        this.cancelSyntaxRequests(key);
        this.clearPulledForSource(document.uri);
        this.diagnostics.delete(document.uri);
        void this.shadows.releaseSource(document.uri);
      }
    }));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('heredoc')) {
        for (const state of this.states.values()) {
          this.refresh(state.document);
        }
      } else if (event.affectsConfiguration('typescript') || event.affectsConfiguration('javascript')) {
        this.pulledDiagnostics.clear();
        for (const state of this.states.values()) {
          this.cancelSyntaxRequests(state.document.uri.toString());
          this.scheduleSync(state);
        }
      }
    }));
    this.disposables.push(vscode.extensions.onDidChange(async () => {
      this.registeredLanguages = new Set(await vscode.languages.getLanguages());
      this.pulledDiagnostics.clear();
      for (const state of this.states.values()) {
        this.refresh(state.document);
      }
    }));
    this.disposables.push(vscode.window.onDidChangeVisibleTextEditors(() => this.refreshVisibleHighlighting()));
    this.disposables.push(vscode.languages.onDidChangeDiagnostics(event => {
      const affected = new Set<string>();
      for (const uri of event.uris) {
        const shadow = this.shadows.getByUri(uri);
        if (shadow) {
          affected.add(shadow.sourceUri.toString());
        }
      }
      for (const key of affected) {
        this.refreshDiagnostics(key);
      }
    }));
    this.registerProviders();
    for (const document of vscode.workspace.textDocuments) {
      this.refresh(document);
    }
  }

  private registerProviders(): void {
    const selector: vscode.DocumentSelector = [{ language: 'shellscript' }];
    this.disposables.push(vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems: async (document, position, token, context) => {
        const resolved = await this.resolveRequest(document, position, token);
        if (!resolved) {
          return undefined;
        }
        const { lease, mapper, sourceVersion } = resolved;
        const { shadow } = lease;
        try {
          const embeddedPosition = mapper.toEmbedded(position);
          if (!embeddedPosition) {
            return undefined;
          }
          const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider', shadow.uri, embeddedPosition, context.triggerCharacter,
          );
          if (token.isCancellationRequested || document.version !== sourceVersion || !list) {
            return undefined;
          }
          const items = list.items.flatMap(item => {
            const mapped = cloneCompletion(item, mapper);
            return mapped ? [mapped] : [];
          });
          return new vscode.CompletionList(items, list.isIncomplete);
        } finally {
          lease.release();
        }
      },
    }, '.', ':', '/', '@', '$', '-'));

    this.disposables.push(vscode.languages.registerHoverProvider(selector, {
      provideHover: async (document, position, token) => {
        const resolved = await this.resolveRequest(document, position, token);
        if (!resolved) {
          return undefined;
        }
        const { lease, mapper, sourceVersion } = resolved;
        const { shadow } = lease;
        try {
          const embeddedPosition = mapper.toEmbedded(position);
          if (!embeddedPosition) {
            return undefined;
          }
          const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider', shadow.uri, embeddedPosition,
          );
          if (token.isCancellationRequested || document.version !== sourceVersion || !hovers?.length) {
            return undefined;
          }
          const contents = hovers.flatMap(hover => hover.contents);
          const range = hovers.find(hover => hover.range)?.range;
          const mappedRange = range ? mapper.toSourceRange(range) : undefined;
          return mappedRange && mapper.withinBody(mappedRange)
            ? new vscode.Hover(contents, mappedRange)
            : new vscode.Hover(contents);
        } finally {
          lease.release();
        }
      },
    }));

    this.disposables.push(vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition: async (document, position, token) => {
        const resolved = await this.resolveRequest(document, position, token);
        if (!resolved) {
          return undefined;
        }
        const { lease, mapper, sourceVersion } = resolved;
        const { shadow } = lease;
        try {
          const embeddedPosition = mapper.toEmbedded(position);
          if (!embeddedPosition) {
            return undefined;
          }
          const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
            'vscode.executeDefinitionProvider', shadow.uri, embeddedPosition,
          );
          if (token.isCancellationRequested || document.version !== sourceVersion || !locations) {
            return undefined;
          }
          return locations.flatMap(location => {
            const mapped = mapLocation(location, shadow, mapper);
            return mapped ? [mapped] : [];
          });
        } finally {
          lease.release();
        }
      },
    }));
  }

  private async resolveRequest(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<ResolvedRequest | undefined> {
    if (!isSupportedShell(document, this.shadows) || token.isCancellationRequested) {
      return undefined;
    }
    const sourceVersion = document.version;
    const state = this.currentState(document);
    const region = findInnermostRegion(state.regions, document.offsetAt(position));
    if (!region) {
      return undefined;
    }
    const rule = state.resolver.resolve(region.delimiter);
    if (!rule) {
      return undefined;
    }
    const lease = await this.shadows.acquire(document, region, rule.documentMode, token);
    if (!lease) {
      return undefined;
    }
    const { shadow } = lease;
    if (token.isCancellationRequested || document.version !== sourceVersion ||
      shadow.sourceVersion !== sourceVersion) {
      lease.release();
      return undefined;
    }
    return { lease, mapper: new RegionMapper(document, shadow.document, region), sourceVersion };
  }

  private currentState(document: vscode.TextDocument): SourceState {
    const existing = this.states.get(document.uri.toString());
    if (existing && existing.version === document.version) {
      return existing;
    }
    return this.refresh(document)!;
  }

  private refresh(document: vscode.TextDocument): SourceState | undefined {
    const key = document.uri.toString();
    if (!isSupportedShell(document, this.shadows)) {
      if (this.states.delete(key)) {
        this.cancelSync(key);
        this.cancelSyntaxRequests(key);
        this.clearPulledForSource(document.uri);
        this.diagnostics.delete(document.uri);
        void this.shadows.releaseSource(document.uri);
      }
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === key) {
          this.highlighter.clear(editor);
        }
      }
      return undefined;
    }
    const settings = vscode.workspace.getConfiguration('heredoc', document.uri);
    const resolver = new RuleResolver(
      settings.get<unknown>('rules', []),
      settings.get<boolean>('enablePresets', true),
      this.registeredLanguages,
      message => this.output.appendLine(message),
    );
    const regions = parseHeredocs(document.getText(), delimiter => resolver.resolve(delimiter)?.languageId);
    const state: SourceState = { document, version: document.version, regions, resolver };
    this.states.set(key, state);
    this.cancelSyntaxRequests(key);
    this.diagnostics.delete(document.uri);
    this.updateEditorHighlighting(state);
    this.scheduleSync(state);
    return state;
  }

  private scheduleSync(state: SourceState): void {
    const key = state.document.uri.toString();
    this.cancelSync(key);
    this.syncTimers.set(key, setTimeout(async () => {
      this.syncTimers.delete(key);
      if (this.states.get(key) !== state || state.document.isClosed) {
        return;
      }
      const modeFor = (region: HeredocRegion): DocumentMode =>
        state.resolver.resolve(region.delimiter)?.documentMode ?? 'auto';
      await this.shadows.reconcile(state.document, state.regions, modeFor);
      if (this.states.get(key) === state) {
        this.prunePulledForSource(state.document.uri);
        this.refreshDiagnostics(key);
        this.updateEditorHighlighting(state);
        this.requestSyntaxDiagnostics(state);
      }
    }, 250));
  }

  private cancelSync(key: string): void {
    const timer = this.syncTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.syncTimers.delete(key);
    }
  }

  private cancelSyntaxRequests(key: string): void {
    const request = this.syntaxRequests.get(key);
    if (request) {
      request.cancel();
      request.dispose();
      this.syntaxRequests.delete(key);
    }
  }

  private clearPulledForSource(uri: vscode.Uri): void {
    const sourceKey = uri.toString();
    for (const [shadowKey, result] of this.pulledDiagnostics) {
      if (result.sourceKey === sourceKey) this.pulledDiagnostics.delete(shadowKey);
    }
  }

  private prunePulledForSource(uri: vscode.Uri): void {
    const sourceKey = uri.toString();
    const active = new Map(this.shadows.listForSource(uri).map(shadow =>
      [shadow.uri.toString(), shadow.content]));
    for (const [shadowKey, result] of this.pulledDiagnostics) {
      if (result.sourceKey === sourceKey && active.get(shadowKey) !== result.content) {
        this.pulledDiagnostics.delete(shadowKey);
      }
    }
  }

  private isCurrentDiagnosticShadow(state: SourceState, shadow: ShadowDocument): boolean {
    return this.states.get(state.document.uri.toString()) === state &&
      !state.document.isClosed && state.document.version === state.version &&
      shadow.sourceVersion === state.version && !shadow.document.isClosed &&
      state.regions.includes(shadow.region) &&
      shadow.document.getText() === shadow.content &&
      this.shadows.getByUri(shadow.uri) === shadow;
  }

  private requestSyntaxDiagnostics(state: SourceState): void {
    if (!vscode.extensions.getExtension('vscode.typescript-language-features')) return;
    const sourceKey = state.document.uri.toString();
    const shadows = this.shadows.listForSource(state.document.uri);
    const candidates = state.regions.flatMap(region => {
      if (region.languageId !== 'typescript' && region.languageId !== 'javascript') return [];
      const requested = state.resolver.resolve(region.delimiter)?.documentMode ?? 'auto';
      const mode = this.shadows.chooseMode(region.languageId, requested);
      const shadow = shadows.find(item => item.region === region && item.mode === mode);
      if (!shadow || !this.isCurrentDiagnosticShadow(state, shadow)) return [];
      if (this.pulledDiagnostics.get(shadow.uri.toString())?.content === shadow.content) return [];
      return [{ shadow, requested }];
    });
    if (!candidates.length) return;
    this.cancelSyntaxRequests(sourceKey);
    const request = new vscode.CancellationTokenSource();
    this.syntaxRequests.set(sourceKey, request);
    void Promise.allSettled(candidates.map(async ({ shadow, requested }) => {
      const outcome = await this.pullSyntaxDiagnostics(state, shadow, request.token);
      if (outcome === 'ok' && requested === 'auto' && shadow.mode === 'virtual') {
        await this.shadows.releaseSupplementalFile(state.document.uri, shadow.region, state.version);
        if (this.states.get(sourceKey) === state) {
          this.prunePulledForSource(state.document.uri);
          this.refreshDiagnostics(sourceKey);
        }
        return;
      }
      if (outcome !== 'retryWithFile' || requested !== 'auto' || shadow.mode !== 'virtual' ||
        request.token.isCancellationRequested || this.states.get(sourceKey) !== state) return;
      // Keep the primary in-memory document for language features. Some tsserver
      // builds can only address file: documents through their diagnostic command.
      const fallback = await this.shadows.ensure(state.document, shadow.region, 'file', request.token);
      if (fallback) await this.pullSyntaxDiagnostics(state, fallback, request.token);
    })).then(results => {
      for (const result of results) {
        if (result.status === 'rejected') {
          this.output.appendLine(`Cannot collect embedded syntax diagnostics: ${String(result.reason)}`);
        }
      }
      if (this.syntaxRequests.get(sourceKey) === request) this.syntaxRequests.delete(sourceKey);
      request.dispose();
    });
  }

  private async pullSyntaxDiagnostics(
    state: SourceState, shadow: ShadowDocument, token: vscode.CancellationToken,
  ): Promise<'ok' | 'retryWithFile' | 'unsupported'> {
    if (token.isCancellationRequested || !this.isCurrentDiagnosticShadow(state, shadow)) return 'unsupported';
    const lease = this.shadows.pin(shadow);
    if (!lease) return 'unsupported';
    try {
      let result = await requestTypeScriptSyntaxDiagnostics(shadow, token);
      // Activation can complete before tsserver is ready. Retry only that
      // transient response; an empty successful diagnostic list is final.
      for (const waitMs of [350, 900, 1800]) {
        if (result.kind !== 'unsupported' || !result.retryLater || token.isCancellationRequested ||
          !this.isCurrentDiagnosticShadow(state, shadow)) break;
        await waitForSyntaxRetry(waitMs, token);
        if (token.isCancellationRequested || !this.isCurrentDiagnosticShadow(state, shadow)) break;
        result = await requestTypeScriptSyntaxDiagnostics(shadow, token);
      }
      if (token.isCancellationRequested || !this.isCurrentDiagnosticShadow(state, shadow)) return 'unsupported';
      if (result.kind === 'unsupported') return result.retryWithFile ? 'retryWithFile' : 'unsupported';
      this.pulledDiagnostics.set(shadow.uri.toString(), {
        sourceKey: state.document.uri.toString(), content: shadow.content, diagnostics: result.diagnostics,
      });
      this.refreshDiagnostics(state.document.uri.toString());
      return 'ok';
    } finally {
      lease.release();
    }
  }

  private refreshDiagnostics(sourceKey: string): void {
    const state = this.states.get(sourceKey);
    if (!state) {
      return;
    }
    const combined: vscode.Diagnostic[] = [];
    const seen = new Set<string>();
    for (const shadow of this.shadows.listForSource(state.document.uri)) {
      if (!this.isCurrentDiagnosticShadow(state, shadow)) continue;
      const mapper = new RegionMapper(state.document, shadow.document, shadow.region);
      const pulled = this.pulledDiagnostics.get(shadow.uri.toString());
      const diagnostics = [
        ...vscode.languages.getDiagnostics(shadow.uri),
        ...(pulled?.content === shadow.content ? pulled.diagnostics : []),
      ];
      for (const diagnostic of diagnostics) {
        const mapped = this.mapDiagnostic(state, shadow, mapper, diagnostic);
        if (!mapped) continue;
        const code = typeof mapped.code === 'object' ? mapped.code.value : mapped.code;
        const identity = `${mapped.range.start.line}:${mapped.range.start.character}:` +
          `${mapped.range.end.line}:${mapped.range.end.character}:` +
          `${code === undefined ? `message:${mapped.message}` : `code:${code}`}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        combined.push(mapped);
      }
    }
    this.diagnostics.set(state.document.uri, combined);
  }

  private mapDiagnostic(
    state: SourceState, shadow: ShadowDocument, mapper: RegionMapper, diagnostic: vscode.Diagnostic,
  ): vscode.Diagnostic | undefined {
    let range = mapper.toSourceRange(diagnostic.range);
    if (!range) return undefined;
    if (range.isEmpty) {
      // A parser may report a missing token at virtual EOF, which maps to the
      // shell terminator. Anchor the squiggle on a real character in the body.
      const content = shadow.region.content;
      if (!content.length) return undefined;
      let index = Math.min(shadow.document.offsetAt(diagnostic.range.start), content.length - 1);
      while (index > 0 && (content[index] === '\r' || content[index] === '\n')) index--;
      const start = shadow.region.sourceOffsets[index];
      if (start === undefined || start < shadow.region.bodyStart || start >= shadow.region.bodyEnd) return undefined;
      const end = Math.min(start + 1, shadow.region.bodyEnd);
      if (end <= start) return undefined;
      range = new vscode.Range(state.document.positionAt(start), state.document.positionAt(end));
    }
    if (!mapper.withinBody(range)) return undefined;
    const start = state.document.offsetAt(range.start);
    const end = state.document.offsetAt(range.end);
    // A shell heredoc may itself contain a nested heredoc of another language.
    // The outer language server must not annotate that inner body.
    if (state.regions.some(region => region !== shadow.region && region.depth > shadow.region.depth &&
      start < region.bodyEnd && end > region.bodyStart)) return undefined;
    const mapped = new vscode.Diagnostic(range, diagnostic.message, diagnostic.severity);
    mapped.code = diagnostic.code;
    mapped.source = diagnostic.source;
    mapped.tags = diagnostic.tags;
    if (diagnostic.relatedInformation?.length) {
      mapped.relatedInformation = diagnostic.relatedInformation.flatMap(info => {
        if (info.location.uri.toString() !== shadow.uri.toString()) {
          return info.location.uri.scheme === 'file' || info.location.uri.scheme === 'vscode-remote'
            ? [info] : [];
        }
        const relatedRange = mapper.toSourceRange(info.location.range);
        return relatedRange && mapper.withinBody(relatedRange)
          ? [new vscode.DiagnosticRelatedInformation(
            new vscode.Location(state.document.uri, relatedRange), info.message,
          )] : [];
      });
    }
    return mapped;
  }

  private updateEditorHighlighting(state: SourceState): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === state.document.uri.toString()) {
        void this.highlighter.update(editor, state.regions);
      }
    }
  }

  private refreshVisibleHighlighting(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const state = this.states.get(editor.document.uri.toString());
      if (state) {
        void this.highlighter.update(editor, state.regions);
      }
    }
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      for (const timer of this.syncTimers.values()) {
        clearTimeout(timer);
      }
      this.syncTimers.clear();
      for (const key of [...this.syntaxRequests.keys()]) this.cancelSyntaxRequests(key);
      this.pulledDiagnostics.clear();
      await this.shadows.shutdown();
      for (const disposable of this.disposables) {
        disposable.dispose();
      }
    })();
    return this.shutdownPromise;
  }

  dispose(): void {
    void this.shutdown();
  }
}

let activeExtension: HeredocExtension | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  activeExtension = new HeredocExtension(context);
  context.subscriptions.push(activeExtension);
  await activeExtension.activate();
}

export async function deactivate(): Promise<void> {
  await activeExtension?.shutdown();
  activeExtension = undefined;
}
