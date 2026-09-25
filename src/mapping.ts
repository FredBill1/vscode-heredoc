import * as vscode from 'vscode';
import { HeredocRegion } from './parser';

/** Convert positions between an embedded document and its shell source. */
export class RegionMapper {
  constructor(
    readonly source: vscode.TextDocument,
    readonly embedded: vscode.TextDocument,
    readonly region: HeredocRegion,
  ) {}

  toEmbedded(position: vscode.Position): vscode.Position | undefined {
    const sourceOffset = this.source.offsetAt(position);
    const offsets = this.region.sourceOffsets;
    let low = 0;
    let high = offsets.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (offsets[mid] === sourceOffset) {
        return this.embedded.positionAt(mid);
      }
      if (offsets[mid] < sourceOffset) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return undefined;
  }

  toSource(position: vscode.Position): vscode.Position | undefined {
    if (!this.embedded.validatePosition(position).isEqual(position)) {
      return undefined;
    }
    const offset = this.embedded.offsetAt(position);
    const sourceOffset = this.region.sourceOffsets[offset];
    return sourceOffset === undefined ? undefined : this.source.positionAt(sourceOffset);
  }

  toSourceRange(range: vscode.Range, requireContiguous = false): vscode.Range | undefined {
    if (!this.embedded.validatePosition(range.start).isEqual(range.start) ||
      !this.embedded.validatePosition(range.end).isEqual(range.end)) {
      return undefined;
    }
    const start = this.embedded.offsetAt(range.start);
    const end = this.embedded.offsetAt(range.end);
    if (start > end || end >= this.region.sourceOffsets.length) {
      return undefined;
    }
    if (requireContiguous) {
      for (let index = start; index < end; index++) {
        if (this.region.sourceOffsets[index + 1] !== this.region.sourceOffsets[index] + 1) {
          return undefined;
        }
      }
    }
    return new vscode.Range(
      this.source.positionAt(this.region.sourceOffsets[start]),
      this.source.positionAt(this.region.sourceOffsets[end]),
    );
  }

  withinBody(range: vscode.Range): boolean {
    const start = this.source.offsetAt(range.start);
    const end = this.source.offsetAt(range.end);
    return start >= this.region.bodyStart && start < this.region.bodyEnd && end <= this.region.bodyEnd;
  }
}

export function findInnermostRegion(regions: readonly HeredocRegion[], sourceOffset: number): HeredocRegion | undefined {
  let selected: HeredocRegion | undefined;
  for (const region of regions) {
    if (region.bodyStart <= sourceOffset && sourceOffset < region.bodyEnd &&
      (!selected || region.depth > selected.depth ||
        (region.depth === selected.depth && region.bodyEnd - region.bodyStart < selected.bodyEnd - selected.bodyStart))) {
      selected = region;
    }
  }
  return selected;
}
