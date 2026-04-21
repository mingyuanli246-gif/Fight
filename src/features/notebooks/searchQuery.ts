function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeSearchQuery(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function splitExactSearchTokens(value: string) {
  const normalized = normalizeSearchQuery(value);

  if (!normalized) {
    return [] as string[];
  }

  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const token of normalized.split(" ")) {
    const nextToken = token.trim();

    if (!nextToken) {
      continue;
    }

    const dedupeKey = nextToken.toLocaleLowerCase("zh-CN");

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    tokens.push(nextToken);
  }

  return tokens;
}

export function buildExactSearchPattern(value: string | string[]) {
  const tokens = Array.isArray(value) ? value : splitExactSearchTokens(value);

  if (tokens.length === 0) {
    return null;
  }

  const pattern = tokens
    .map((token) => escapeRegExp(token))
    .sort((left, right) => right.length - left.length)
    .join("|");

  return new RegExp(pattern, "giu");
}
