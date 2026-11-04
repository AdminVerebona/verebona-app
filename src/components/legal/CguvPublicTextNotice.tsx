'use client';

/**
 * Lot 108L — état explicite « CGUV non disponibles sur le site public ».
 *
 * Affiché à l'inscription (classique, Google / Apple) quand la version
 * présentée n'est pas consultable sur le site public de l'environnement :
 * aucune acceptation n'est alors possible (le serveur la refuse aussi,
 * `CGUV_PUBLIC_TEXT_UNAVAILABLE`, Supervision ouverte), et AUCUN lien de
 * substitution n'est proposé (ni l'application, ni une autre version).
 */
export const CGUV_PUBLIC_TEXT_NOTICE =
  'Les CGUV en vigueur sont en cours de publication sur le site Verebona. La création de compte reprendra dès leur mise en ligne : réessayez un peu plus tard.';

export function CguvPublicTextNotice({ versionCode }: { versionCode?: string | null }) {
  return (
    <p role="status" data-testid="cguv-public-text-unavailable" className="text-sm rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3 text-[color:var(--text-muted)]">
      {CGUV_PUBLIC_TEXT_NOTICE}
      {versionCode ? <span className="block text-xs mt-1">Version {versionCode}</span> : null}
    </p>
  );
}

/** Pur : la version reçue de `/api/legal/cguv/current` peut-elle être acceptée ? */
export function cguvAcceptable(data: { publicText?: unknown; permalinkUrl?: unknown } | null | undefined): boolean {
  if (!data) return true; // non chargée : le serveur tranche (fail-closed côté serveur)
  if (data.publicText === 'NOT_ON_PUBLIC_SITE') return false;
  return typeof data.permalinkUrl === 'string' && /^https?:\/\//.test(data.permalinkUrl);
}
