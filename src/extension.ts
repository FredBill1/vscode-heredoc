import * as vscode from 'vscode';
import { HeredocHighlighter } from './highlighting';
import { RegionMapper, findInnermostRegion } from './mapping';
import { HeredocRegion, parseHeredocs } from './parser';
import { DocumentMode, RuleResolver } from './rules';
import { ShadowDocument, ShadowLease, ShadowManager } from './shadow';

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

const DISALLOWED_SHELL_SUFFIX = /\.(?:fish|zsh|zshrc|zprofile|zlogin|zlogout|zshenv|ksh|csh|tcsh|yash)$/i;
const DISALLOWED_SHEBANG = /^#![^\r\n]*\b(?:fish|zsh|ksh|csh|tcsh|yash)(?:\s|$)/;

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
        this.diagnostics.delete(document.uri);
        void this.shadows.releaseSource(document.uri);
      }
    }));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('heredoc')) {
        for (const state of this.states.values()) {
          this.refresh(state.document);
        }
      }
    }));
    this.disposables.push(vscode.extensions.onDidChange(async () => {
      this.registeredLanguages = new Set(await vscode.languages.getLanguages());
      for (const state of this.states.values()) {
        this.refresh(state.document);
      }
    }));
    this.disposables.push(vscode.window.onDidChangeActiveColorTheme(() => this.refreshVisibleHighlighting()));
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
        this.refreshDiagnostics(key);
        this.updateEditorHighlighting(state);
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

  private refreshDiagnostics(sourceKey: string): void {
    const state = this.states.get(sourceKey);
    if (!state) {
      return;
    }
    const combined: vscode.Diagnostic[] = [];
    for (const shadow of this.shadows.listForSource(state.document.uri)) {
      if (shadow.sourceVersion !== state.document.version || shadow.document.isClosed ||
        shadow.document.getText() !== shadow.content) {
        continue;
      }
      const mapper = new RegionMapper(state.document, shadow.document, shadow.region);
      for (const diagnostic of vscode.languages.getDiagnostics(shadow.uri)) {
        let range = mapper.toSourceRange(diagnostic.range);
        // Parsers commonly report a missing closing token at the virtual EOF.
        // That offset is the source terminator line, so keep the marker on the
        // last body character instead of decorating the shell delimiter.
        if (range?.isEmpty && state.document.offsetAt(range.start) === shadow.region.bodyEnd &&
          shadow.region.content.length > 0) {
          const last = shadow.region.sourceOffsets[shadow.region.content.length - 1];
          const position = state.document.positionAt(last);
          range = new vscode.Range(position, position);
        }
        if (!range || !mapper.withinBody(range)) {
          continue;
        }
        const mapped = new vscode.Diagnostic(range, diagnostic.message, diagnostic.severity);
        mapped.code = diagnostic.code;
        mapped.source = diagnostic.source;
        mapped.tags = diagnostic.tags;
        combined.push(mapped);
      }
    }
    this.diagnostics.set(state.document.uri, combined);
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
