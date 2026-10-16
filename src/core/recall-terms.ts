/** Shared lexical boundaries for recall and candidate material selection. */
export function recallTerms(text: string): Set<string> {
  const result = new Set<string>();
  for (const match of text.normalize('NFKC').toLowerCase().matchAll(/\p{Script=Han}+|[a-z0-9]+/gu)) {
    const value = match[0];
    if (/^[a-z0-9]/.test(value)) result.add(value);
    else {
      const characters = [...value];
      for (let i = 0; i < characters.length - 1; i++) result.add(characters[i] + characters[i + 1]);
    }
  }
  return result;
}
