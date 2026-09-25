import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { HeredocRegion } from './parser';
import { DocumentMode } from './rules';

export interface ShadowDocument {
  key: string;
  uri: vscode.Uri;
  document: vscode.TextDocument;
  sourceUri: vscode.Uri;
  sourceVersion: number;
  region: HeredocRegion;
  mode: Exclude<DocumentMode, 'auto'>;
  content: string;
}

/** A forwarded provider must keep its snapshot alive until the provider returns. */
export interface ShadowLease {
  shadow: ShadowDocument;
  release(): void;
}

const FILE_EXTENSIONS: Record<string, string> = {
  python: 'py', yaml: 'yaml', shellscript: 'sh', typescript: 'ts',
  javascript: 'js', json: 'json', sql: 'sql', html: 'html', css: 'css',
  xml: 'xml', markdown: 'md', ruby: 'rb', go: 'go', rust: 'rs',
};
const FILE_SETTLE_MS = 120;
const RETIRED_GRACE_MS = 750;

function fileExtension(languageId: string): string {
  return FILE_EXTENSIONS[languageId] ?? (languageId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'txt');
}

function shadowKey(source: vscode.Uri, region: HeredocRegion, mode: string): string {
  return `${source.toString()}\u0000${region.openerStart}\u0000${region.languageId}\u0000${mode}`;
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Keeps all shadow content out of the user's project. */
export class ShadowManager implements vscode.Disposable {
  private readonly shadows = new Map<string, ShadowDocument>();
  private readonly byUri = new Map<string, ShadowDocument>();
  private readonly everShadowUris = new Set<string>();
  private readonly virtualContents = new Map<string, string>();
  private readonly virtualChange = new vscode.EventEmitter<vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly shadowRoot: vscode.Uri;
  private readonly shadowFolder: vscode.Uri;
  private readonly sessionId = `session-${process.pid}-${crypto.randomUUID()}`;
  private folderReady?: Promise<void>;
  private nextSnapshot = 0;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly epochs = new Map<string, number>();
  private readonly fileCache = new Map<string, ShadowDocument>();
  private readonly fileSnapshots = new Set<ShadowDocument>();
  private readonly retired = new Set<ShadowDocument>();
  private readonly leases = new Map<ShadowDocument, number>();
  private readonly cleanupTimers = new Map<ShadowDocument, NodeJS.Timeout>();
  private readonly deleting = new Map<ShadowDocument, Promise<void>>();
  private readonly drainWaiters = new Set<() => void>();
  private activeLeases = 0;
  private closing = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    // Current VS Code builds may expose globalStorageUri as vscode-userdata:
    // despite its fsPath pointing at a real directory. Language servers that
    // accept only file: documents need a canonical file URI here.
    const storage = context.storageUri ?? context.globalStorageUri;
    this.shadowRoot = vscode.Uri.joinPath(vscode.Uri.file(storage.fsPath), 'shadow');
    // storageUri is shared by VS Code windows for the same workspace. A unique
    // directory prevents either window from writing or deleting the other's file.
    this.shadowFolder = vscode.Uri.joinPath(this.shadowRoot, this.sessionId);
    this.disposables.push(this.virtualChange);
    this.disposables.push(vscode.workspace.registerTextDocumentContentProvider('heredoc-embedded', {
      onDidChange: this.virtualChange.event,
      provideTextDocumentContent: uri => this.virtualContents.get(uri.toString()) ?? '',
    }));
  }

  isShadowUri(uri: vscode.Uri): boolean {
    if (uri.scheme === 'heredoc-embedded') {
      return true;
    }
    if (this.byUri.has(uri.toString()) || this.everShadowUris.has(uri.toString())) {
      return true;
    }
    // Also exclude snapshots made by another instance of this extension.
    return (uri.scheme === this.shadowRoot.scheme || uri.scheme === 'untitled') &&
      uri.path.startsWith(`${this.shadowRoot.path}/`);
  }

  getByUri(uri: vscode.Uri): ShadowDocument | undefined {
    return this.byUri.get(uri.toString());
  }

  listForSource(uri: vscode.Uri): ShadowDocument[] {
    return [...this.shadows.values()].filter(shadow => shadow.sourceUri.toString() === uri.toString());
  }

  chooseMode(languageId: string, requested: DocumentMode): Exclude<DocumentMode, 'auto'> {
    if (requested !== 'auto') {
      return requested;
    }
    if (languageId === 'shellscript' && vscode.extensions.getExtension('mads-hartmann.bash-ide-vscode')) {
      return 'file';
    }
    if (languageId === 'python' && vscode.extensions.getExtension('ms-python.vscode-pylance')) {
      // Untitled documents cannot be programmatically closed and may trigger save prompts.
      // Pylance does not accept our custom in-memory URI, so use a real file.
      return 'file';
    }
    return 'virtual';
  }

  /** Ensure a shadow for proactive language-service diagnostics. */
  async ensure(
    source: vscode.TextDocument,
    region: HeredocRegion,
    requested: DocumentMode,
    token?: vscode.CancellationToken,
  ): Promise<ShadowDocument | undefined> {
    const expectedVersion = source.version;
    const epoch = this.epoch(source.uri);
    return this.enqueue(source.uri, () =>
      this.ensureInternal(source, region, requested, expectedVersion, epoch, token, true));
  }

  /** Pin the exact URI used by a completion, hover, or definition request. */
  async acquire(
    source: vscode.TextDocument,
    region: HeredocRegion,
    requested: DocumentMode,
    token?: vscode.CancellationToken,
  ): Promise<ShadowLease | undefined> {
    const expectedVersion = source.version;
    const epoch = this.epoch(source.uri);
    return this.enqueue(source.uri, async () => {
      const shadow = await this.ensureInternal(source, region, requested, expectedVersion, epoch, token, true);
      if (!shadow || !this.isCurrent(source, expectedVersion, epoch, token)) {
        return undefined;
      }
      return this.lease(shadow);
    });
  }

  /** Pin an already-current shadow for an asynchronous semantic-token request. */
  pinCurrent(source: vscode.TextDocument, region: HeredocRegion): ShadowLease | undefined {
    if (this.closing || source.isClosed) return undefined;
    const shadow = [...this.shadows.values()].find(candidate =>
      candidate.sourceUri.toString() === source.uri.toString() &&
      candidate.sourceVersion === source.version &&
      candidate.region.openerStart === region.openerStart &&
      candidate.region.languageId === region.languageId &&
      candidate.region.bodyStart === region.bodyStart &&
      candidate.region.bodyEnd === region.bodyEnd &&
      candidate.content === region.content &&
      !candidate.document.isClosed &&
      (candidate.mode !== 'file' || !candidate.document.isDirty));
    return shadow ? this.lease(shadow) : undefined;
  }

  private lease(shadow: ShadowDocument): ShadowLease {
    this.leases.set(shadow, (this.leases.get(shadow) ?? 0) + 1);
    this.activeLeases++;
    let released = false;
    return {
      shadow,
      release: () => {
        if (released) return;
        released = true;
        const count = (this.leases.get(shadow) ?? 1) - 1;
        if (count > 0) this.leases.set(shadow, count);
        else this.leases.delete(shadow);
        this.activeLeases--;
        if (this.retired.has(shadow) && count <= 0) this.scheduleCleanup(shadow, 0);
        if (this.activeLeases === 0) {
          for (const resolve of this.drainWaiters) resolve();
          this.drainWaiters.clear();
        }
      },
    };
  }

  private async ensureInternal(
    source: vscode.TextDocument,
    region: HeredocRegion,
    requested: DocumentMode,
    expectedVersion: number,
    epoch: number,
    token: vscode.CancellationToken | undefined,
    settleFile: boolean,
  ): Promise<ShadowDocument | undefined> {
    if (!this.isCurrent(source, expectedVersion, epoch, token)) return undefined;
    const mode = this.chooseMode(region.languageId, requested);
    const key = shadowKey(source.uri, region, mode);
    const existing = this.shadows.get(key);
    if (existing && !existing.document.isClosed) {
      if (mode === 'file') {
        // A file snapshot is immutable. Never edit or save its open TextDocument.
        if (!existing.document.isDirty && existing.content === region.content &&
          existing.document.getText() === region.content) {
          if (!this.isCurrent(source, expectedVersion, epoch, token)) return undefined;
          existing.region = region;
          existing.sourceVersion = expectedVersion;
          return existing;
        }
      } else {
        if (existing.content !== region.content || existing.document.getText() !== region.content) {
          if (!await this.updateContent(existing, region.content)) return undefined;
        }
        if (!this.isCurrent(source, expectedVersion, epoch, token)) return undefined;
        existing.region = region;
        existing.sourceVersion = expectedVersion;
        existing.content = region.content;
        return existing;
      }
    }
    if (existing) this.retire(existing);

    if (mode === 'file') {
      const cacheKey = `${key}\u0000${hash(region.content)}`;
      const cached = this.fileCache.get(cacheKey);
      if (cached && !cached.document.isClosed && !cached.document.isDirty &&
        cached.content === region.content && cached.document.getText() === region.content) {
        if (!this.isCurrent(source, expectedVersion, epoch, token)) return undefined;
        this.activateShadow(cached, region, expectedVersion);
        return cached;
      }
      if (settleFile) {
        // Completion requests can race each keystroke. Let the source settle
        // before allocating a new path, then discard superseded requests.
        await delay(FILE_SETTLE_MS);
        if (!this.isCurrent(source, expectedVersion, epoch, token)) return undefined;
      }
    }

    let uri: vscode.Uri;
    try {
      uri = await this.createUri(key, region.languageId, mode, region.content);
    } catch (error) {
      this.output.appendLine(`Cannot create ${region.languageId} shadow URI: ${String(error)}`);
      return undefined;
    }
    let committed = false;
    try {
      if (!this.isCurrent(source, expectedVersion, epoch, token)) return undefined;
      if (mode === 'virtual') {
        this.virtualContents.set(uri.toString(), region.content);
      } else if (mode === 'file') {
        // This path is new and belongs only to this session. It will never be
        // overwritten while its TextDocument is open.
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(region.content));
      }
      this.everShadowUris.add(uri.toString());
      let document = await vscode.workspace.openTextDocument(uri);
      if (document.languageId !== region.languageId) {
        document = await vscode.languages.setTextDocumentLanguage(document, region.languageId);
      }
      const shadow: ShadowDocument = {
        key, uri: document.uri, document, sourceUri: source.uri,
        sourceVersion: expectedVersion, region, mode, content: region.content,
      };
      if (mode !== 'file' && document.getText() !== region.content) {
        if (!await this.updateContent(shadow, region.content)) return undefined;
      }
      if (document.getText() !== region.content || document.isDirty && mode === 'file' ||
        !this.isCurrent(source, expectedVersion, epoch, token)) return undefined;
      this.activateShadow(shadow, region, expectedVersion);
      if (mode === 'file') {
        this.fileCache.set(`${key}\u0000${hash(region.content)}`, shadow);
        this.fileSnapshots.add(shadow);
      }
      committed = true;
      return shadow;
    } catch (error) {
      this.output.appendLine(`Cannot create ${region.languageId} shadow: ${String(error)}`);
      return undefined;
    } finally {
      if (!committed) {
        this.virtualContents.delete(uri.toString());
        if (mode === 'file') {
          try { await vscode.workspace.fs.delete(uri); } catch { /* write may not have happened */ }
        }
      }
    }
  }

  private activateShadow(shadow: ShadowDocument, region: HeredocRegion, version: number): void {
    const timer = this.cleanupTimers.get(shadow);
    if (timer) clearTimeout(timer);
    this.cleanupTimers.delete(shadow);
    this.retired.delete(shadow);
    shadow.region = region;
    shadow.sourceVersion = version;
    this.shadows.set(shadow.key, shadow);
    this.byUri.set(shadow.uri.toString(), shadow);
    this.everShadowUris.add(shadow.uri.toString());
  }

  async reconcile(source: vscode.TextDocument, regions: readonly HeredocRegion[], modeFor: (region: HeredocRegion) => DocumentMode): Promise<void> {
    const expectedVersion = source.version;
    const epoch = this.epoch(source.uri);
    await this.enqueue(source.uri, async () => {
      if (!this.isCurrent(source, expectedVersion, epoch)) return;
      const expected = new Set(regions.map(region => shadowKey(source.uri, region, this.chooseMode(region.languageId, modeFor(region)))));
      for (const shadow of [...this.shadows.values()]) {
        if (shadow.sourceUri.toString() === source.uri.toString() && !expected.has(shadow.key)) this.retire(shadow);
      }
      // A small batch keeps language servers responsive when a file contains many blocks.
      for (const region of regions) {
        if (!this.isCurrent(source, expectedVersion, epoch)) return;
        await this.ensureInternal(source, region, modeFor(region), expectedVersion, epoch, undefined, false);
      }
    });
  }

  async releaseSource(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    this.epochs.set(key, this.epoch(uri) + 1);
    await this.enqueue(uri, async () => {
      for (const shadow of [...this.shadows.values()]) {
        if (shadow.sourceUri.toString() === key) this.retire(shadow, true);
      }
      // Also reclaim a recently retired snapshot waiting for its grace period.
      const owned = [...this.fileSnapshots].filter(shadow => shadow.sourceUri.toString() === key);
      for (const shadow of owned) {
        if (this.retired.has(shadow)) await this.cleanupSnapshot(shadow);
      }
    });
  }

  private epoch(uri: vscode.Uri): number {
    return this.epochs.get(uri.toString()) ?? 0;
  }

  private isCurrent(source: vscode.TextDocument, version: number, epoch: number, token?: vscode.CancellationToken): boolean {
    return !this.closing && !source.isClosed && source.version === version &&
      this.epoch(source.uri) === epoch && !token?.isCancellationRequested;
  }

  private enqueue<T>(uri: vscode.Uri, operation: () => Promise<T>): Promise<T> {
    const key = uri.toString();
    const prior = this.queues.get(key) ?? Promise.resolve();
    const result = prior.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return result;
  }

  /** Remove only abandoned session directories; never sweep another live instance. */
  async cleanupStaleFiles(): Promise<void> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.shadowRoot);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.Directory || name === this.sessionId) continue;
        const match = /^session-(\d+)-[0-9a-f-]{36}$/.exec(name);
        if (!match || this.processMayBeAlive(Number(match[1]))) continue;
        const folder = vscode.Uri.joinPath(this.shadowRoot, name);
        const files = await vscode.workspace.fs.readDirectory(folder);
        for (const [fileName, fileType] of files) {
          if (fileType !== vscode.FileType.File) continue;
          const uri = vscode.Uri.joinPath(folder, fileName);
          // A previously opened or dirty document may still need its backing
          // file. Leave it and its directory in place.
          if (vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString())) continue;
          try { await vscode.workspace.fs.delete(uri); } catch { /* another process may have claimed it */ }
        }
        try { await vscode.workspace.fs.delete(folder); } catch { /* opened files remain */ }
      }
      // Legacy versions used unowned files directly under shadowRoot. Their
      // owner cannot be determined, so preserve them instead of deleting a
      // different window's live shadow on activation.
    } catch (error) {
      if (!['FileNotFound', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        this.output.appendLine(`Cannot clean stale shadow files: ${String(error)}`);
      }
    }
  }

  private processMayBeAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but is inaccessible. Unknown errors
      // also take the conservative path and keep its files.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private async createUri(key: string, languageId: string, mode: Exclude<DocumentMode, 'auto'>, content: string): Promise<vscode.Uri> {
    const keyHash = hash(key).slice(0, 20);
    const name = mode === 'file'
      ? `${keyHash}-${hash(content).slice(0, 20)}-${(this.nextSnapshot++).toString(36)}.${fileExtension(languageId)}`
      : `${keyHash}.${fileExtension(languageId)}`;
    if (mode === 'file' || mode === 'untitled') {
      await this.readyFolder();
      const fileUri = vscode.Uri.joinPath(this.shadowFolder, name);
      return mode === 'file' ? fileUri : fileUri.with({ scheme: 'untitled' });
    }
    return vscode.Uri.parse(`heredoc-embedded:/${this.sessionId}/${name}`);
  }

  private async readyFolder(): Promise<void> {
    this.folderReady ??= Promise.resolve(vscode.workspace.fs.createDirectory(this.shadowFolder));
    return this.folderReady;
  }

  private async updateContent(shadow: ShadowDocument, content: string): Promise<boolean> {
    if (shadow.mode === 'virtual') {
      this.virtualContents.set(shadow.uri.toString(), content);
      const changed = this.waitForContent(shadow.document, content);
      this.virtualChange.fire(shadow.uri);
      return changed;
    }
    if (shadow.mode === 'file') return false;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(shadow.uri, new vscode.Range(shadow.document.positionAt(0), shadow.document.positionAt(shadow.document.getText().length)), content);
    if (!await vscode.workspace.applyEdit(edit)) return false;
    return this.waitForContent(shadow.document, content);
  }

  private async waitForContent(document: vscode.TextDocument, content: string): Promise<boolean> {
    if (document.getText() === content) return true;
    return new Promise(resolve => {
      const listener = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.toString() === document.uri.toString() && event.document.getText() === content) {
          clearTimeout(timeout);
          listener.dispose();
          resolve(true);
        }
      });
      const timeout = setTimeout(() => {
        listener.dispose();
        resolve(document.getText() === content);
      }, 1500);
    });
  }

  private retire(shadow: ShadowDocument, immediate = false): void {
    if (this.shadows.get(shadow.key) === shadow) this.shadows.delete(shadow.key);
    if (this.byUri.get(shadow.uri.toString()) === shadow) this.byUri.delete(shadow.uri.toString());
    if (shadow.mode === 'file') {
      this.retired.add(shadow);
      this.scheduleCleanup(shadow, immediate ? 0 : RETIRED_GRACE_MS);
    } else {
      this.virtualContents.delete(shadow.uri.toString());
    }
  }

  private scheduleCleanup(shadow: ShadowDocument, waitMs: number): void {
    const old = this.cleanupTimers.get(shadow);
    if (old) clearTimeout(old);
    if ((this.leases.get(shadow) ?? 0) > 0) return;
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(shadow);
      void this.cleanupSnapshot(shadow);
    }, waitMs);
    this.cleanupTimers.set(shadow, timer);
  }

  private cleanupSnapshot(shadow: ShadowDocument): Promise<void> {
    const prior = this.deleting.get(shadow);
    if (prior) return prior;
    const work = (async () => {
      if (!this.retired.has(shadow) || (this.leases.get(shadow) ?? 0) > 0) return;
      const timer = this.cleanupTimers.get(shadow);
      if (timer) clearTimeout(timer);
      this.cleanupTimers.delete(shadow);
      const cacheKey = `${shadow.key}\u0000${hash(shadow.content)}`;
      if (this.fileCache.get(cacheKey) === shadow) this.fileCache.delete(cacheKey);
      if (shadow.document.isDirty) {
        // This must have been modified outside this manager. Never discard it.
        this.output.appendLine(`Preserving dirty shadow file ${shadow.uri.fsPath}`);
      } else {
        try { await vscode.workspace.fs.delete(shadow.uri); } catch { /* already removed */ }
      }
      this.retired.delete(shadow);
      this.fileSnapshots.delete(shadow);
      if (this.closing && this.fileSnapshots.size === 0) {
        try { await vscode.workspace.fs.delete(this.shadowFolder); } catch { /* dirty files may remain */ }
      }
    })();
    this.deleting.set(shadow, work);
    void work.finally(() => this.deleting.delete(shadow));
    return work;
  }

  private async waitForLeases(): Promise<void> {
    if (this.activeLeases === 0) return;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        this.drainWaiters.delete(done);
        resolve();
      }, 2_000);
      const done = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.drainWaiters.add(done);
    });
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      this.closing = true;
      const sources = new Set([
        ...this.queues.keys(),
        ...[...this.shadows.values()].map(shadow => shadow.sourceUri.toString()),
        ...[...this.fileSnapshots].map(shadow => shadow.sourceUri.toString()),
      ]);
      await Promise.all([...sources].map(source => this.releaseSource(vscode.Uri.parse(source))));
      await this.waitForLeases();
      await Promise.all([...this.fileSnapshots].map(shadow => this.cleanupSnapshot(shadow)));
      for (const disposable of this.disposables) disposable.dispose();
      try { await vscode.workspace.fs.delete(this.shadowFolder); } catch { /* some snapshot may still be in use */ }
    })();
    return this.shutdownPromise;
  }

  dispose(): void {
    void this.shutdown();
  }
}
