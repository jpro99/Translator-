/** Shared helpers — no provider imports (safe for tests). */

export function cleanTranslated(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function cacheKey(text, from, to) {
  return `${(text || '').trim()}|${from}|${to}`;
}

export function isUsefulTranslation(raw, translated) {
  if (!translated) return false;
  return translated.toLowerCase() !== (raw || '').trim().toLowerCase();
}
