export function normalizePaidBankDescription(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().trim().replace(/\s+/g, ' ');
}

export function isInternalCashBank(value) {
  return normalizePaidBankDescription(value) === 'CAIXA INTERNO';
}

// Account descriptions are private configuration, never bundled into the
// application. A caller supplies only the aliases it is permitted to inspect.
// Digits and punctuation remain part of identity; conflicting matches do not
// select an account arbitrarily.
export function officialPaidBankName(value, aliases = []) {
  if (!Array.isArray(aliases)) return null;
  const source = normalizePaidBankDescription(value);
  if (!source) return null;
  const matches = new Set();
  for (const alias of aliases) {
    if (alias && typeof alias.source === 'string' && typeof alias.official_name === 'string'
      && alias.official_name.trim() && normalizePaidBankDescription(alias.source) === source) matches.add(alias.official_name.trim());
  }
  return matches.size === 1 ? [...matches][0] : null;
}
