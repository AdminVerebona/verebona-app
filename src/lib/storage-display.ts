/**
 * Espace de stockage — affichage dans « Mon abonnement » (lot 26).
 *
 * Fonctions PURES, sans accès base : importables par un composant client.
 * La ligne « Espace de stockage » réutilise la barre de quota de
 * « Biens » / « Documents » (`QuotaBar`), d'où la même forme de donnée :
 * ratio en POURCENT, libellé « X sur Y », alerte à partir de 80 %.
 */

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function fr(value: number, maxDigits: number): string {
  return value.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: maxDigits });
}

/**
 * Taille lisible, en Mo ou Go, virgule française : « 0 Mo », « 0,3 Mo »,
 * « 820 Mo », « 0,98 Go », « 1,2 Go », « 5 Go ». Une décimale sous 10,
 * aucune au-delà ; jamais « 1 000 Mo » (bascule en Go dès 1 000 Mo).
 * Base 1024, comme le contrôle de dépôt.
 */
export function formatStorageAmount(bytes: number | null | undefined): string {
  const b = Math.max(0, Number(bytes ?? 0)) || 0;
  if (b === 0) return '0 Mo';
  if (b < 0.05 * MIB) return '< 0,1 Mo';
  const mo = b / MIB;
  const moDigits = mo < 10 ? 1 : 0;
  const moRounded = Number(mo.toFixed(moDigits));
  if (moRounded < 1000) return `${fr(moRounded, moDigits)} Mo`;
  const go = b / GIB;
  return `${fr(go, go < 1 ? 2 : go < 10 ? 1 : 0)} Go`;
}

export interface StorageQuotaUsage {
  used: number;
  limit: number;
  /** Pourcentage (0–100+), comme les quotas de biens et de documents. */
  ratio: number;
  label: string;
  shouldWarn: boolean;
  isFull: boolean;
}

/** Données de la ligne « Espace de stockage » (format de `QuotaBar`). */
export function buildStorageQuotaUsage(usedBytes: number, limitBytes: number): StorageQuotaUsage {
  const used = Math.max(0, Number(usedBytes) || 0);
  const limit = Math.max(0, Number(limitBytes) || 0);
  const ratio = limit > 0 ? (used / limit) * 100 : 0;
  return {
    used,
    limit,
    ratio,
    label: `${formatStorageAmount(used)} sur ${formatStorageAmount(limit)}`,
    shouldWarn: ratio >= 80,
    isFull: limit > 0 && used >= limit,
  };
}
