import assert from 'node:assert/strict';
import test from 'node:test';
import { ShadowDocument } from '../shadow';

class Position {
  constructor(readonly line: number, readonly character: number) {}
  isBefore(other: Position): boolean {
    return this.line < other.line || this.line === other.line && this.character < other.character;
  }
}

class Range {
  constructor(readonly start: Position, readonly end: Position) {}
}

class Diagnostic {
  code?: string | number;
  source?: string;
  constructor(readonly range: Range, readonly message: string, readonly severity: number) {}
}

let extension: { isActive: boolean; activate(): Promise<void> } | undefined;
let execute: (...args: unknown[]) => Promise<unknown> = async () => undefined;
const vscodeMock = {
  Position, Range, Diagnostic,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  extensions: { getExtension: () => extension },
  commands: { executeCommand: (...args: unknown[]) => execute(...args) },
};

// Unit tests run without a VS Code host. Replace only the vscode module while
// loading the adapter, then restore the loader for the rest of the test process.
const loader = require('node:module') as { _load: (...args: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = (request: unknown, ...args: unknown[]) =>
  request === 'vscode' ? vscodeMock : originalLoad.call(loader, request, ...args);
const adapter = require('../tsDiagnostics') as typeof import('../tsDiagnostics');
loader._load = originalLoad;

function document(text: string, languageId = 'typescript', scheme = 'heredoc-embedded') {
  const lines = text.split(/\r\n|\n|\r/);
  return {
    uri: { scheme }, languageId, lineCount: lines.length,
    getText: () => text,
    lineAt: (line: number) => ({ text: lines[line] }),
    positionAt: (offset: number) => {
      const before = text.slice(0, offset);
      const chunks = before.split(/\r\n|\n|\r/);
      return new Position(chunks.length - 1, chunks[chunks.length - 1].length);
    },
  } as unknown as ShadowDocument['document'];
}

test('empty successful tsserver body differs from unsupported or failed requests', () => {
  const virtual = document('const value = 1;');
  assert.deepEqual(adapter.parseTypeScriptSyntaxResponse({ type: 'response', success: true, body: [] }, virtual),
    { kind: 'ok', diagnostics: [] });
  assert.deepEqual(adapter.parseTypeScriptSyntaxResponse({ type: 'noContent' }, virtual),
    { kind: 'unsupported', retryWithFile: true });
  assert.deepEqual(adapter.parseTypeScriptSyntaxResponse({ type: 'noContent' }, document('', 'typescript', 'file')),
    { kind: 'unsupported', retryWithFile: false, retryLater: true });
  assert.deepEqual(adapter.parseTypeScriptSyntaxResponse({ type: 'noServer' }, virtual),
    { kind: 'unsupported', retryWithFile: false, retryLater: true });
  assert.deepEqual(adapter.parseTypeScriptSyntaxResponse({ type: 'cancelled' }, virtual),
    { kind: 'unsupported', retryWithFile: false, retryLater: true });
  assert.deepEqual(adapter.parseTypeScriptSyntaxResponse({ type: 'response', success: false, body: [] }, virtual),
    { kind: 'unsupported', retryWithFile: false });
  assert.deepEqual(adapter.parseTypeScriptSyntaxResponse({
    type: 'response', success: false, message: 'Unsupported URI scheme',
  }, virtual), { kind: 'unsupported', retryWithFile: true });
  assert.deepEqual(adapter.parseTypeScriptSyntaxResponse({ type: 'response', success: true, body: [{}] }, virtual),
    { kind: 'unsupported', retryWithFile: false });
});

test('tsserver 1-based locations, UTF-16 offsets, codes and severities are preserved', () => {
  const input = document('const a = ;\r\nnext();', 'javascript');
  const result = adapter.parseTypeScriptSyntaxResponse({
    type: 'response', success: true, body: [
      { text: 'Expression expected.', start: { line: 1, offset: 11 },
        end: { line: 1, offset: 12 }, category: 'error', code: 1109, source: 'custom-ts' },
      { message: { messageText: 'Suggestion', next: [{ messageText: 'Nested reason' }] },
        start: 13, length: 4, category: 'suggestion', code: 9999 },
      { message: 'Invalid span', start: { line: 99, offset: 1 },
        end: { line: 99, offset: 2 }, category: 'warning' },
    ],
  }, input);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  assert.equal(result.diagnostics.length, 2);
  assert.deepEqual(result.diagnostics[0].range, new Range(new Position(0, 10), new Position(0, 11)));
  assert.equal(result.diagnostics[0].code, 1109);
  assert.equal(result.diagnostics[0].severity, 0);
  assert.equal(result.diagnostics[0].source, 'custom-ts');
  assert.deepEqual(result.diagnostics[1].range, new Range(new Position(1, 0), new Position(1, 4)));
  assert.equal(result.diagnostics[1].severity, 3);
  assert.equal(result.diagnostics[1].source, 'js');
  assert.equal(result.diagnostics[1].message, 'Suggestion\nNested reason');
});

test('adapter checks the built-in extension and forwards the cancellation token', async () => {
  const body = document('let a = ;');
  const shadow = { uri: body.uri, document: body, mode: 'virtual' } as ShadowDocument;
  const calls: unknown[][] = [];
  let activations = 0;
  extension = { isActive: false, async activate() { activations++; this.isActive = true; } };
  execute = async (...args) => {
    calls.push(args);
    return { type: 'response', success: true, body: [] };
  };
  const token = { isCancellationRequested: false } as never;
  assert.deepEqual(await adapter.requestTypeScriptSyntaxDiagnostics(shadow, token),
    { kind: 'ok', diagnostics: [] });
  assert.equal(activations, 1);
  assert.deepEqual(calls[0], [
    'typescript.tsserverRequest', 'syntacticDiagnosticsSync',
    { file: body.uri, includeLinePosition: true }, undefined, token,
  ]);

  assert.deepEqual(await adapter.requestTypeScriptSyntaxDiagnostics(shadow,
    { isCancellationRequested: true } as never),
  { kind: 'unsupported', retryWithFile: false });
  assert.equal(calls.length, 1);
  extension = undefined;
  assert.deepEqual(await adapter.requestTypeScriptSyntaxDiagnostics(shadow),
    { kind: 'unsupported', retryWithFile: false });
});

test('a request cancelled while awaiting tsserver cannot publish stale errors', async () => {
  const body = document('let a = ;');
  const shadow = { uri: body.uri, document: body, mode: 'virtual' } as ShadowDocument;
  extension = { isActive: true, async activate() {} };
  const token = { isCancellationRequested: false };
  execute = async () => {
    token.isCancellationRequested = true;
    return { type: 'response', success: true, body: [
      { text: 'Expression expected.', start: { line: 1, offset: 9 },
        end: { line: 1, offset: 10 }, category: 'error' },
    ] };
  };
  assert.deepEqual(await adapter.requestTypeScriptSyntaxDiagnostics(shadow, token as never),
    { kind: 'unsupported', retryWithFile: false });
});
