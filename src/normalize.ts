export function normalizeAnswer(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/&/g, ' and ')
    .replace(/\bst[.]?\b/g, 'saint')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
