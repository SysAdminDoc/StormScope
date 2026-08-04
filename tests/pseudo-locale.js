'use strict';

const PSEUDO_LOCALE = 'x-pseudo';

function expandString(value, ratio = 0.35) {
  const text = String(value == null ? '' : value);
  const extra = Math.max(1, Math.ceil(text.length * ratio));
  return `⟦${text}${'·'.repeat(extra)}⟧`;
}

function expandCatalog(catalog, ratio = 0.35) {
  return Object.fromEntries(Object.entries(catalog).map(([key, value]) => [key, expandString(value, ratio)]));
}

function missingKeySentinels(catalog, keys) {
  return [...new Set(keys)].filter((key) => {
    const value = catalog[key];
    return typeof value !== 'string' || !value.trim() || value === key;
  });
}

module.exports = Object.freeze({
  PSEUDO_LOCALE,
  expandString,
  expandCatalog,
  missingKeySentinels
});
