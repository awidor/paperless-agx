function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function matchesEvidence(candidate: string, evidence?: string): boolean {
  const haystack = normalized(candidate);
  const needle = normalized(evidence ?? "");
  if (!haystack || !needle) return false;
  if (needle.length >= 8 && (haystack.includes(needle) || (haystack.length >= 8 && needle.includes(haystack)))) return true;

  const terms = [...new Set(needle.split(" ").filter((term) => term.length >= 4))]
    .sort((left, right) => right.length - left.length)
    .slice(0, 12);
  const matched = terms.filter((term) => haystack.includes(term));
  return matched.some((term) => term.length >= 6) || matched.length >= 2;
}
