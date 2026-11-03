function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `text` with the search terms wrapped in `<mark>`. With `words`, a term marks
 * the whole word it starts ("bill" marks all of "billing"), never part of one.
 */
export function Marked({ text, terms, words = false }: { text: string; terms: string[]; words?: boolean }) {
  const clean = terms.filter((term) => term.length > 0);
  if (clean.length === 0) return <>{text}</>;
  let pattern: RegExp;
  try {
    const alternatives = clean.map(escapeRegExp).join("|");
    pattern = new RegExp(words ? `((?<![\\p{L}\\p{N}])(?:${alternatives})[\\p{L}\\p{N}]*)` : `(${alternatives})`, "giu");
  } catch {
    return <>{text}</>;
  }
  const parts = text.split(pattern);
  return <>{parts.map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>))}</>;
}
