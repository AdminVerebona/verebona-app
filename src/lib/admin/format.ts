/**
 * Formats d'affichage communs du back-office — CDC Back-Office V1 UX-006,
 * UX-007. Sans dépendance serveur : utilisable dans les pages client.
 */

/** Taille lisible en français (« 1,5 Go », « 820 Mo »), base 1024. */
export function formatBytes(bytes: number | null | undefined): string {
  const units = ['octets', 'Ko', 'Mo', 'Go', 'To'];
  let value = Math.max(0, Number(bytes ?? 0));
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: digits })} ${units[unit]}`;
}

/** Date seule (UX-006) : « 25/09/2026 », ou « — ». */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('fr-FR');
}

/** Date et heure (UX-006) : « 25/09/2026 14:32 », ou « — ». */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Montant dans la devise de la transaction (UX-007), en centimes. */
export function formatMoney(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency.toUpperCase() }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
