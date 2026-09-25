/** A heredoc whose delimiter was resolved to an embedded language. All positions
 * refer to UTF-16 offsets in the original shell document. */
export interface HeredocRegion {
  delimiter: string;
  languageId: string;
  quoted: boolean;
  stripTabs: boolean;
  depth: number;
  openerStart: number;
  bodyStart: number;
  bodyEnd: number;
  terminatorStart?: number;
  terminatorEnd?: number;
  content: string;
  /** Offset of each character in content, followed by its end boundary. */
  sourceOffsets: number[];
}

interface PendingHeredoc {
  delimiter: string;
  languageId: string | undefined;
  quoted: boolean;
  stripTabs: boolean;
  openerStart: number;
}

type Frame =
  | { kind: 'code'; close?: 'command' | 'backtick'; parens: number; wordBoundary: boolean }
  | { kind: 'single' }
  | { kind: 'double' }
  | { kind: 'arithmetic'; parens: number; square: boolean; quote?: 'single' | 'double' };

interface DelimiterWord {
  delimiter: string;
  quoted: boolean;
  next: number;
}

interface Line {
  end: number;
  next: number;
}

function lineAt(text: string, start: number): Line {
  const newline = text.indexOf('\n', start);
  if (newline < 0) {
    return { end: text.length, next: text.length };
  }
  return { end: newline > start && text[newline - 1] === '\r' ? newline - 1 : newline, next: newline + 1 };
}

function isWordEnd(char: string): boolean {
  return /[\s;&|()<>]/.test(char);
}

/** Shell quote removal for a heredoc delimiter word. No expansions are run. */
function readDelimiter(text: string, start: number, end: number): DelimiterWord | undefined {
  let i = start;
  while (i < end && (text[i] === ' ' || text[i] === '\t')) i++;
  if (i >= end || isWordEnd(text[i]) || text[i] === '#') return undefined;

  let delimiter = '';
  let quoted = false;
  let quote: 'single' | 'double' | undefined;
  let started = false;
  for (; i < end; i++) {
    const char = text[i];
    if (quote === 'single') {
      if (char === "'") quote = undefined;
      else delimiter += char;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') {
        quote = undefined;
      } else if (char === '\\' && i + 1 < end && /[\\$`"]/.test(text[i + 1])) {
        delimiter += text[++i];
      } else {
        delimiter += char;
      }
      continue;
    }
    if (isWordEnd(char)) break;
    started = true;
    if (char === "'") {
      quote = 'single';
      quoted = true;
    } else if (char === '"') {
      quote = 'double';
      quoted = true;
    } else if (char === '\\') {
      quoted = true;
      if (i + 1 < end) delimiter += text[++i];
    } else {
      delimiter += char;
    }
  }
  return started ? { delimiter, quoted, next: i } : undefined;
}

interface ScanResult {
  continuation: boolean;
}

/** Scan shell syntax on one physical line, without visiting heredoc bodies. */
function scanLine(
  text: string,
  start: number,
  end: number,
  frames: Frame[],
  pending: PendingHeredoc[],
  resolveLanguage: (delimiter: string) => string | undefined,
): ScanResult {
  let escapedNewline = false;
  let trailingOperator = false;
  for (let i = start; i < end;) {
    const frame = frames[frames.length - 1];
    const char = text[i];

    if (frame.kind === 'single') {
      if (char === "'") frames.pop();
      i++;
      continue;
    }
    if (frame.kind === 'arithmetic') {
      if (frame.quote) {
        if (char === '\\' && frame.quote === 'double') i += Math.min(2, end - i);
        else {
          if ((frame.quote === 'single' && char === "'") || (frame.quote === 'double' && char === '"')) {
            frame.quote = undefined;
          }
          i++;
        }
      } else if (char === "'" || char === '"') {
        frame.quote = char === "'" ? 'single' : 'double';
        i++;
      } else if (char === '\\') {
        i += Math.min(2, end - i);
      } else if (frame.square && char === ']') {
        frames.pop();
        i++;
      } else if (!frame.square && char === '(') {
        frame.parens++;
        i++;
      } else if (!frame.square && char === ')' && --frame.parens === 0) {
        frames.pop();
        i++;
      } else {
        i++;
      }
      continue;
    }
    if (frame.kind === 'double') {
      if (char === '\\' && i + 1 < end) {
        i += 2;
      } else if (char === '\\' && i + 1 === end) {
        escapedNewline = true;
        i++;
      } else if (char === '"') {
        frames.pop();
        i++;
      } else if (char === '$' && text[i + 1] === '(') {
        if (text[i + 2] === '(') {
          frames.push({ kind: 'arithmetic', parens: 2, square: false });
          i += 3;
        } else {
          frames.push({ kind: 'code', close: 'command', parens: 1, wordBoundary: true });
          i += 2;
        }
      } else if (char === '`') {
        frames.push({ kind: 'code', close: 'backtick', parens: 0, wordBoundary: true });
        i++;
      } else {
        i++;
      }
      continue;
    }

    if (char === '\\') {
      frame.wordBoundary = false;
      trailingOperator = false;
      if (i + 1 === end) escapedNewline = true;
      i += Math.min(2, end - i);
      continue;
    }
    if (char === '#' && frame.wordBoundary) break;
    if (char === ' ' || char === '\t' || char === '\r') {
      frame.wordBoundary = true;
      i++;
      continue;
    }
    if (char === "'") {
      frame.wordBoundary = false;
      trailingOperator = false;
      frames.push({ kind: 'single' });
      i++;
      continue;
    }
    if (char === '"') {
      frame.wordBoundary = false;
      trailingOperator = false;
      frames.push({ kind: 'double' });
      i++;
      continue;
    }
    if (char === '`') {
      if (frame.close === 'backtick') frames.pop();
      else {
        frame.wordBoundary = false;
        frames.push({ kind: 'code', close: 'backtick', parens: 0, wordBoundary: true });
      }
      trailingOperator = false;
      i++;
      continue;
    }
    if (char === '$' && text[i + 1] === '(') {
      frame.wordBoundary = false;
      trailingOperator = false;
      if (text[i + 2] === '(') {
        frames.push({ kind: 'arithmetic', parens: 2, square: false });
        i += 3;
      } else {
        frames.push({ kind: 'code', close: 'command', parens: 1, wordBoundary: true });
        i += 2;
      }
      continue;
    }
    if (char === '$' && text[i + 1] === '[') {
      frame.wordBoundary = false;
      trailingOperator = false;
      frames.push({ kind: 'arithmetic', parens: 0, square: true });
      i += 2;
      continue;
    }
    if (char === '(' && text[i + 1] === '(') {
      frame.wordBoundary = false;
      trailingOperator = false;
      frames.push({ kind: 'arithmetic', parens: 2, square: false });
      i += 2;
      continue;
    }
    if (char === '(') {
      if (frame.close === 'command') frame.parens++;
      frame.wordBoundary = true;
      trailingOperator = false;
      i++;
      continue;
    }
    if (char === ')') {
      if (frame.close === 'command' && --frame.parens === 0) frames.pop();
      else frame.wordBoundary = true;
      trailingOperator = false;
      i++;
      continue;
    }
    if (char === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && text[i - 1] !== '<') {
      const stripTabs = text[i + 2] === '-';
      const word = readDelimiter(text, i + (stripTabs ? 3 : 2), end);
      if (word) {
        pending.push({
          delimiter: word.delimiter,
          languageId: resolveLanguage(word.delimiter),
          quoted: word.quoted,
          stripTabs,
          openerStart: i,
        });
        i = word.next;
        frame.wordBoundary = false;
      } else {
        i += stripTabs ? 3 : 2;
        frame.wordBoundary = true;
      }
      trailingOperator = false;
      continue;
    }
    if (char === '|' || char === '&') {
      const doubled = text[i + 1] === char;
      trailingOperator = char === '|' || doubled;
      frame.wordBoundary = true;
      i += doubled ? 2 : 1;
      continue;
    }
    if (char === ';' || char === '<' || char === '>') {
      frame.wordBoundary = true;
      trailingOperator = false;
      i++;
      continue;
    }
    frame.wordBoundary = false;
    trailingOperator = false;
    i++;
  }

  const continuation = escapedNewline || trailingOperator || frames[frames.length - 1].kind !== 'code';
  if (!continuation) {
    // A newline separates shell words even inside a command substitution.
    for (const frame of frames) if (frame.kind === 'code') frame.wordBoundary = true;
  }
  return { continuation };
}

interface ConsumedBody {
  next: number;
  terminated: boolean;
  region?: HeredocRegion;
}

function physicalLineStart(originalText: string, offset: number): number {
  return originalText.lastIndexOf('\n', offset - 1) + 1;
}

function consumeBody(
  text: string,
  offsets: number[],
  originalText: string,
  start: number,
  pending: PendingHeredoc,
  depth: number,
): ConsumedBody {
  let cursor = start;
  let bodyEnd = text.length;
  let terminatorStart: number | undefined;
  let terminatorEnd: number | undefined;
  let next = text.length;
  while (cursor < text.length) {
    // For an unquoted delimiter, Bash removes backslash-newline before it
    // checks the terminator. A joined line can therefore create a delimiter,
    // or prevent a physical delimiter line from ending the body.
    let candidate = '';
    let candidateNext = cursor;
    let candidateEnd = cursor;
    while (candidateNext < text.length) {
      const line = lineAt(text, candidateNext);
      let contentStart = candidateNext;
      if (pending.stripTabs) while (contentStart < line.end && text[contentStart] === '\t') contentStart++;
      let part = text.slice(contentStart, line.end);
      candidateEnd = line.end;
      candidateNext = line.next;
      const trailing = part.match(/\\+$/)?.[0].length ?? 0;
      const joined = !pending.quoted && trailing % 2 === 1 && candidateNext < text.length;
      if (joined) part = part.slice(0, -1);
      candidate += part;
      if (!joined) break;
    }
    if (candidate === pending.delimiter) {
      bodyEnd = cursor;
      terminatorStart = cursor;
      terminatorEnd = candidateEnd;
      next = candidateNext;
      break;
    }
    cursor = candidateNext;
  }

  const terminated = terminatorStart !== undefined;
  if (pending.languageId === undefined) return { next, terminated };
  let content = '';
  const sourceOffsets: number[] = [];
  cursor = start;
  while (cursor < bodyEnd) {
    const line = lineAt(text, cursor);
    let contentStart = cursor;
    if (pending.stripTabs) while (contentStart < line.end && text[contentStart] === '\t') contentStart++;
    for (let i = contentStart; i < Math.min(line.next, bodyEnd); i++) {
      content += text[i];
      sourceOffsets.push(offsets[i]);
    }
    cursor = line.next;
  }
  const originalBodyStart = start === 0 || text[start - 1] === '\n'
    ? physicalLineStart(originalText, offsets[start])
    : offsets[start];
  const originalBodyEnd = terminatorStart === undefined
    ? offsets[bodyEnd]
    : physicalLineStart(originalText, offsets[bodyEnd]);
  sourceOffsets.push(originalBodyEnd);
  return {
    next,
    terminated,
    region: {
      delimiter: pending.delimiter,
      languageId: pending.languageId,
      quoted: pending.quoted,
      stripTabs: pending.stripTabs,
      depth,
      openerStart: offsets[pending.openerStart],
      bodyStart: originalBodyStart,
      bodyEnd: originalBodyEnd,
      ...(terminatorStart === undefined ? {} : {
        terminatorStart: physicalLineStart(originalText, offsets[terminatorStart]),
        terminatorEnd: offsets[terminatorEnd!],
      }),
      content,
      sourceOffsets,
    },
  };
}

function parseMapped(
  text: string,
  offsets: number[],
  originalText: string,
  resolveLanguage: (delimiter: string) => string | undefined,
  depth: number,
): HeredocRegion[] {
  const frames: Frame[] = [{ kind: 'code', parens: 0, wordBoundary: true }];
  const pending: PendingHeredoc[] = [];
  const regions: HeredocRegion[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const line = lineAt(text, cursor);
    const { continuation } = scanLine(text, cursor, line.end, frames, pending, resolveLanguage);
    cursor = line.next;
    if (continuation || pending.length === 0) continue;
    while (pending.length > 0) {
      const body = consumeBody(text, offsets, originalText, cursor, pending.shift()!, depth);
      if (body.region) regions.push(body.region);
      cursor = body.next;
      if (!body.terminated) {
        pending.length = 0;
        break;
      }
    }
  }
  // An opener on an incomplete final line still owns an empty, unterminated body.
  while (pending.length > 0) {
    const body = consumeBody(text, offsets, originalText, cursor, pending.shift()!, depth);
    if (body.region) regions.push(body.region);
    cursor = body.next;
    if (!body.terminated) break;
  }
  for (const region of [...regions]) {
    if (region.languageId === 'shellscript' && region.content.length > 0) {
      regions.push(...parseMapped(region.content, region.sourceOffsets, originalText, resolveLanguage, depth + 1));
    }
  }
  regions.sort((a, b) => a.openerStart - b.openerStart || a.depth - b.depth);
  return regions;
}

/** Parse sh/Bash heredocs. The caller chooses languages from complete, quote-removed delimiters. */
export function parseHeredocs(text: string, resolveLanguage: (delimiter: string) => string | undefined): HeredocRegion[] {
  const offsets = Array.from({ length: text.length + 1 }, (_, i) => i);
  return parseMapped(text, offsets, text, resolveLanguage, 0);
}
