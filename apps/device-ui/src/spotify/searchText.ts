/** Edit the actual selection, including code-point-safe backspace for emoji. */
export function editSearchText(value: string, start: number, end: number, text: string | null) {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  if (text === null && from === to) {
    const lastCharacter = Array.from(value.slice(0, from)).at(-1) || '';
    const previous = from - lastCharacter.length;
    return { value: value.slice(0, previous) + value.slice(to), caret: previous };
  }
  const inserted = text || '';
  return { value: value.slice(0, from) + inserted + value.slice(to), caret: from + inserted.length };
}
