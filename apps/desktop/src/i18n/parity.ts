function flattenKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

export function findMissingKeys(locales: Record<string, unknown>): string[] {
  const keysByLocale = Object.entries(locales).map(
    ([locale, data]) => [locale, new Set(flattenKeys(data))] as const,
  );
  const allKeys = new Set(keysByLocale.flatMap(([, keys]) => [...keys]));
  const missing: string[] = [];
  for (const [locale, keys] of keysByLocale) {
    for (const key of allKeys) if (!keys.has(key)) missing.push(`${locale}: ${key}`);
  }
  return missing.sort();
}
