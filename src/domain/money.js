// Money is kept in integer cents everywhere. PayPal wants decimal strings, so convert only at the edge.

export function toCents(value) {
  if (typeof value === 'number') return Math.round(value * 100);
  const m = String(value).trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`Not a money amount: ${value}`);
  const cents = Number(m[2]) * 100 + Number((m[3] || '0').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

export function fromCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function usd(cents) {
  return { currency_code: 'USD', value: fromCents(cents) };
}

export function cartTotalCents(cart) {
  return cart.reduce((sum, line) => sum + line.unitCents * line.qty, 0);
}
