/** Convert offsets in a raw snapshot to the native editor's LF text. */
export function editorOffset(source: string, offset: number): number {
  let result = offset;
  for (let index = source.indexOf("\r\n"); index >= 0 && index < offset; index = source.indexOf("\r\n", index + 2)) {
    result--;
  }
  return result;
}

/** Build the raw-to-editor CRLF coordinate map once for a file's indexed ranges. */
export function editorCoordinates(source: string): <T extends { from: number; to: number }>(range: T) => T {
  const carriageReturns: number[] = [];
  for (let index = source.indexOf("\r\n"); index >= 0; index = source.indexOf("\r\n", index + 2)) {
    carriageReturns.push(index);
  }
  function convert(offset: number): number {
    let low = 0;
    let high = carriageReturns.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (carriageReturns[mid] < offset) low = mid + 1;
      else high = mid;
    }
    return offset - low;
  }
  return function map<T extends { from: number; to: number }>(range: T): T {
    return { ...range, from: convert(range.from), to: convert(range.to) };
  };
}
