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

const FILE_EXTENSIONS: Record<string, string> = {
  python: 'py', yaml: 'yaml', shellscript: 'sh', typescript: 'ts',
  javascript: 'js', json: 'json', sql: 'sql', html: 'html', css: 'css',
  xml: 'xml', markdown: 'md', ruby: 'rb', go: 'go', rust: 'rs',
};

function fileExtension(languageId: string): string {
  return FILE_EXTENSIONS[languageId] ?? (languageId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'txt');
}

function shadowKey(source: vscode.Uri, region: HeredocRegion, mode: string): string {
  return `${source.toString()}\u0000${region.openerStart}\u0000${region.languageId}\u0000${mode}`;
}

/** Keeps all shadow content out of the user's project. */
export class ShadowManager implements vscode.Disposable {
  private readonly shadows = new Map<string, ShadowDocument>();
  private readonly byUri = new Map<string, ShadowDocument>();
  private readonly everShadowUris = new Set<string>();
  private readonly virtualContents = new Map<string, string>();
  private readonly virtualChange = new vscode.EventEmitter<vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly shadowFolder: vscode.Uri;
  private folderReady?: Promise<void>;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly epochs = new Map<string, number>();
  private closing = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    // Current VS Code builds may expose globalStorageUri as vscode-userdata:
    // despite its fsPath pointing at a real directory. Language servers that
    // accept only file: documents need a canonical file URI here.
    const storage = context.storageUri ?? context.globalStorageUri;
    this.shadowFolder = vscode.Uri.joinPath(vscode.Uri.file(storage.fsPath), 'shadow');
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
    return uri.scheme === this.shadowFolder.scheme && uri.path.startsWith(`${this.shadowFolder.path}/`);
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
      // Pylance does not accept our custom in-memory URI, so use a debounced real file.
      return 'file';
    }
    return 'virtual';
  }

  async ensure(source: vscode.TextDocument, region: HeredocRegion, requested: DocumentMode): Promise<ShadowDocument | undefined> {
    const expectedVersion = source.version;
    const epoch = this.epoch(source.uri);
    return this.enqueue(source.uri, () => this.ensureInternal(source, region, requested, expectedVersion, epoch));
  }

  private async ensureInternal(
    source: vscode.TextDocument,
    region: HeredocRegion,
    requested: DocumentMode,
    expectedVersion: number,
    epoch: number,
  ): Promise<ShadowDocument | undefined> {
    if (!this.isCurrent(source, expectedVersion, epoch)) {
      return undefined;
    }
    const mode = this.chooseMode(region.languageId, requested);
    const key = shadowKey(source.uri, region, mode);
    const existing = this.shadows.get(key);
    let createdUri: vscode.Uri | undefined;
    let committed = false;
    try {
      if (existing && !existing.document.isClosed) {
        if (existing.content !== region.content || existing.document.getText() !== region.content) {
          const updated = await this.updateContent(existing, region.content);
          if (!updated) {
            return undefined;
          }
        }
        if (!this.isCurrent(source, expectedVersion, epoch)) {
          return undefined;
        }
        existing.region = region;
        existing.sourceVersion = expectedVersion;
        existing.content = region.content;
        return existing;
      }
      if (existing) {
        await this.release(existing);
      }
      const uri = await this.createUri(key, region.languageId, mode);
      createdUri = uri;
      if (!this.isCurrent(source, expectedVersion, epoch)) {
        return undefined;
      }
      if (mode === 'virtual') {
        this.virtualContents.set(uri.toString(), region.content);
      } else if (mode === 'file') {
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(region.content));
      }
      // Register before openTextDocument: its onDidOpen event fires before this await returns.
      this.everShadowUris.add(uri.toString());
      let document = await vscode.workspace.openTextDocument(uri);
      if (document.languageId !== region.languageId) {
        document = await vscode.languages.setTextDocumentLanguage(document, region.languageId);
      }
      const shadow: ShadowDocument = {
        key, uri: document.uri, document, sourceUri: source.uri,
        sourceVersion: expectedVersion, region, mode, content: region.content,
      };
      if (document.getText() !== region.content) {
        if (!await this.updateContent(shadow, region.content)) {
          return undefined;
        }
      }
      if (document.getText() !== region.content) {
        return undefined;
      }
      if (!this.isCurrent(source, expectedVersion, epoch)) {
        return undefined;
      }
      this.shadows.set(key, shadow);
      this.byUri.set(document.uri.toString(), shadow);
      this.everShadowUris.add(document.uri.toString());
      committed = true;
      return shadow;
    } catch (error) {
      this.output.appendLine(`Cannot create ${region.languageId} shadow: ${String(error)}`);
      return undefined;
    } finally {
      if (createdUri && !committed) {
        this.virtualContents.delete(createdUri.toString());
        if (mode === 'file') {
          try { await vscode.workspace.fs.delete(createdUri); } catch { /* file already gone */ }
        }
      }
    }
  }

  async reconcile(source: vscode.TextDocument, regions: readonly HeredocRegion[], modeFor: (region: HeredocRegion) => DocumentMode): Promise<void> {
    const expectedVersion = source.version;
    const epoch = this.epoch(source.uri);
    await this.enqueue(source.uri, async () => {
      if (!this.isCurrent(source, expectedVersion, epoch)) {
        return;
      }
      const expected = new Set(regions.map(region => shadowKey(source.uri, region, this.chooseMode(region.languageId, modeFor(region)))));
      for (const shadow of [...this.shadows.values()]) {
        if (shadow.sourceUri.toString() === source.uri.toString() && !expected.has(shadow.key)) {
          await this.release(shadow);
        }
      }
      // A small batch keeps language servers responsive when a file contains many blocks.
      for (const region of regions) {
        if (!this.isCurrent(source, expectedVersion, epoch)) {
          return;
        }
        await this.ensureInternal(source, region, modeFor(region), expectedVersion, epoch);
      }
    });
  }

  async releaseSource(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    this.epochs.set(key, this.epoch(uri) + 1);
    await this.enqueue(uri, async () => {
      for (const shadow of [...this.shadows.values()]) {
        if (shadow.sourceUri.toString() === key) {
          await this.release(shadow);
        }
      }
    });
  }

  private epoch(uri: vscode.Uri): number {
    return this.epochs.get(uri.toString()) ?? 0;
  }

  private isCurrent(source: vscode.TextDocument, version: number, epoch: number): boolean {
    return !this.closing && !source.isClosed && source.version === version && this.epoch(source.uri) === epoch;
  }

  private enqueue<T>(uri: vscode.Uri, operation: () => Promise<T>): Promise<T> {
    const key = uri.toString();
    const prior = this.queues.get(key) ?? Promise.resolve();
    const result = prior.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) {
        this.queues.delete(key);
      }
    });
    return result;
  }

  async cleanupStaleFiles(): Promise<void> {
    try {
      await this.readyFolder();
      const entries = await vscode.workspace.fs.readDirectory(this.shadowFolder);
      for (const [name, type] of entries) {
        if (type === vscode.FileType.File && /^[a-f0-9]{32}\./.test(name)) {
          await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.shadowFolder, name));
        }
      }
    } catch (error) {
      this.output.appendLine(`Cannot clean stale shadow files: ${String(error)}`);
    }
  }

  private async createUri(key: string, languageId: string, mode: Exclude<DocumentMode, 'auto'>): Promise<vscode.Uri> {
    const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
    const name = `${hash}.${fileExtension(languageId)}`;
    if (mode === 'file' || mode === 'untitled') {
      await this.readyFolder();
      const fileUri = vscode.Uri.joinPath(this.shadowFolder, name);
      return mode === 'file' ? fileUri : fileUri.with({ scheme: 'untitled' });
    }
    return vscode.Uri.parse(`heredoc-embedded:/${name}`);
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
    const edit = new vscode.WorkspaceEdit();
    edit.replace(shadow.uri, new vscode.Range(shadow.document.positionAt(0), shadow.document.positionAt(shadow.document.getText().length)), content);
    if (!await vscode.workspace.applyEdit(edit)) {
      return false;
    }
    if (shadow.mode === 'file' && !await shadow.document.save()) {
      return false;
    }
    return this.waitForContent(shadow.document, content);
  }

  private async waitForContent(document: vscode.TextDocument, content: string): Promise<boolean> {
    if (document.getText() === content) {
      return true;
    }
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

  private async release(shadow: ShadowDocument): Promise<void> {
    this.shadows.delete(shadow.key);
    this.byUri.delete(shadow.uri.toString());
    this.virtualContents.delete(shadow.uri.toString());
    if (shadow.mode === 'file') {
      try {
        await vscode.workspace.fs.delete(shadow.uri);
      } catch {
        // The file may already have been removed after a previous session.
      }
    }
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      this.closing = true;
      const sources = new Set([
        ...this.queues.keys(),
        ...[...this.shadows.values()].map(shadow => shadow.sourceUri.toString()),
      ]);
      await Promise.all([...sources].map(source => this.releaseSource(vscode.Uri.parse(source))));
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
