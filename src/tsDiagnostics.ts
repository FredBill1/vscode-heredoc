import * as vscode from 'vscode';
import { ShadowDocument } from './shadow';

export type TypeScriptSyntaxResult =
  | { kind: 'ok'; diagnostics: vscode.Diagnostic[] }
  | { kind: 'unsupported'; retryWithFile: boolean; retryLater?: true };

function unsupported(retryWithFile = false, retryLater = false): TypeScriptSyntaxResult {
  return retryLater
    ? { kind: 'unsupported', retryWithFile, retryLater: true }
    : { kind: 'unsupported', retryWithFile };
}

function unsupportedUri(message: unknown): boolean {
  return typeof message === 'string' &&
    /(?:unsupported|unknown|unexpected|invalid)\s+(?:uri|scheme|resource)/i.test(message);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function position(location: unknown, document: vscode.TextDocument): vscode.Position | undefined {
  const value = record(location);
  if (!value || !Number.isInteger(value.line) || !Number.isInteger(value.offset)) return undefined;
  const line = value.line as number;
  const offset = value.offset as number;
  if (line < 1 || line > document.lineCount || offset < 1 ||
    offset > document.lineAt(line - 1).text.length + 1) return undefined;
  return new vscode.Position(line - 1, offset - 1);
}

function range(value: Record<string, unknown>, document: vscode.TextDocument): vscode.Range | undefined {
  const start = position(value.startLocation ?? value.start, document);
  const end = position(value.endLocation ?? value.end, document);
  if (start && end && !end.isBefore(start)) return new vscode.Range(start, end);

  // With includeLinePosition, tsserver also includes absolute UTF-16 offsets.
  // These cover responses whose line/offset pair is unavailable or malformed.
  if (typeof value.start === 'number' && Number.isSafeInteger(value.start) &&
    typeof value.length === 'number' && Number.isSafeInteger(value.length) &&
    value.start >= 0 && value.length >= 0 &&
    value.start + value.length <= document.getText().length) {
    return new vscode.Range(document.positionAt(value.start), document.positionAt(value.start + value.length));
  }
  return undefined;
}

function severity(category: unknown): vscode.DiagnosticSeverity {
  switch (category) {
    case 'warning': case 0: return vscode.DiagnosticSeverity.Warning;
    case 'suggestion': case 2: return vscode.DiagnosticSeverity.Hint;
    case 'message': case 3: return vscode.DiagnosticSeverity.Information;
    default: return vscode.DiagnosticSeverity.Error;
  }
}

function diagnosticMessage(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value;
  if (depth > 8) return undefined;
  const chain = record(value);
  if (!chain) return undefined;
  const head = diagnosticMessage(chain.messageText, depth + 1);
  if (!head) return undefined;
  const children = Array.isArray(chain.next)
    ? chain.next.flatMap(child => {
      const line = diagnosticMessage(child, depth + 1);
      return line ? [line] : [];
    })
    : [];
  return [head, ...children].join('\n');
}

/** Parse the public command's tsserver protocol response, including an empty success body. */
export function parseTypeScriptSyntaxResponse(
  response: unknown,
  document: vscode.TextDocument,
): TypeScriptSyntaxResult {
  const envelope = record(response);
  if (envelope?.type === 'noContent') {
    // A file may have opened in VS Code before the TypeScript extension has
    // finished syncing it to tsserver. Give that path a bounded later retry.
    return document.uri.scheme === 'file'
      ? unsupported(false, true)
      : unsupported(document.uri.scheme === 'heredoc-embedded');
  }
  if (envelope?.type === 'noServer' || envelope?.type === 'cancelled') {
    return unsupported(false, true);
  }
  if (!envelope || envelope.type !== 'response' || envelope.success === false || !Array.isArray(envelope.body)) {
    return unsupported(document.uri.scheme === 'heredoc-embedded' && unsupportedUri(envelope?.message));
  }
  const diagnostics: vscode.Diagnostic[] = [];
  for (const item of envelope.body) {
    const raw = record(item);
    if (!raw) continue;
    // The normal protocol Diagnostic uses `text`; includeLinePosition switches
    // to DiagnosticWithLinePosition, whose field is `message`.
    const message = diagnosticMessage(raw.text) ?? diagnosticMessage(raw.message) ??
      diagnosticMessage(raw.messageText);
    if (!message) continue;
    const span = range(raw, document);
    if (!span) continue;
    const diagnostic = new vscode.Diagnostic(span, message, severity(raw.category));
    if (typeof raw.code === 'number' || typeof raw.code === 'string') diagnostic.code = raw.code;
    diagnostic.source = typeof raw.source === 'string'
      ? raw.source
      : document.languageId === 'javascript' ? 'js' : 'ts';
    diagnostics.push(diagnostic);
  }
  // A nonempty but unrecognizable body is not an authoritative "no errors" result.
  if (envelope.body.length > 0 && diagnostics.length === 0) return unsupported();
  return { kind: 'ok', diagnostics };
}

/** Ask VS Code's enabled built-in JavaScript/TypeScript extension to parse a shadow document. */
export async function requestTypeScriptSyntaxDiagnostics(
  shadow: ShadowDocument,
  token?: vscode.CancellationToken,
): Promise<TypeScriptSyntaxResult> {
  if (token?.isCancellationRequested ||
    shadow.document.languageId !== 'typescript' && shadow.document.languageId !== 'javascript') {
    return unsupported();
  }
  const extension = vscode.extensions.getExtension('vscode.typescript-language-features');
  if (!extension) return unsupported();
  try {
    if (!extension.isActive) await extension.activate();
    if (token?.isCancellationRequested) return unsupported();
    const response = await vscode.commands.executeCommand<unknown>(
      'typescript.tsserverRequest',
      'syntacticDiagnosticsSync',
      { file: shadow.uri, includeLinePosition: true },
      undefined,
      token,
    );
    return token?.isCancellationRequested
      ? unsupported()
      : parseTypeScriptSyntaxResponse(response, shadow.document);
  } catch (error) {
    return unsupported(shadow.mode === 'virtual' && unsupportedUri(String(error)));
  }
}
