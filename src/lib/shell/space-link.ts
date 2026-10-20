/**
 * Liens profonds vers un ESPACE précis — lot 72D (décision PO Q7).
 *
 * Une notification (cloche, push web ou mobile) concerne le compte qui l'a
 * émise. L'utilisateur membre de plusieurs espaces peut la recevoir alors
 * qu'un autre espace est ouvert : le lien porte donc `space=<compte>` ; à
 * l'ouverture, la coquille bascule sur cet espace si l'utilisateur en est
 * membre (le serveur en juge, `POST /api/auth/switch-account`), sinon ouvre
 * l'accueil. Aucun droit n'est accordé par ce paramètre.
 */
export const SPACE_PARAM = 'space';

/** Ajoute `space=<accountId>` à un lien INTERNE (jamais à une URL externe). */
export function withSpaceParam(href: string | null | undefined, accountId: number | null | undefined): string | null {
  if (!href) return href ?? null;
  if (!accountId || !Number.isInteger(accountId) || accountId <= 0) return href;
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  const u = new URL(href, 'https://x.invalid');
  u.searchParams.set(SPACE_PARAM, String(accountId));
  return `${u.pathname}${u.search}${u.hash}`;
}

/** Espace demandé par l'URL courante, et l'URL sans ce paramètre. */
export function readSpaceParam(url: string): { accountId: number | null; cleaned: string } {
  const u = new URL(url, 'https://x.invalid');
  const raw = u.searchParams.get(SPACE_PARAM);
  u.searchParams.delete(SPACE_PARAM);
  const cleaned = `${u.pathname}${u.search}${u.hash}`;
  const n = raw ? Number(raw) : NaN;
  return { accountId: Number.isInteger(n) && n > 0 ? n : null, cleaned };
}
