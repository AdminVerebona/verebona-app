/**
 * Choix proposés à chaque rang de la chaîne principal → repli 1 → repli 2 —
 * lot 32B (ticket « modèles réellement utilisables par traitement », §3, §4).
 *
 * Module PUR, sans dépendance serveur : partagé par l'écran du BO et les
 * tests. La base d'éligibilité est la MÊME pour les trois rangs
 * (`modelsByTreatment[treatment]`, calculée par `usableModelsForTreatment`) ;
 * un modèle déjà choisi à un autre rang de la chaîne en est retiré. La
 * validation serveur interdisant les doublons reste en place.
 */

export type ChainRank = 'primaryModel' | 'fallback1' | 'fallback2';

export interface ChainSelection {
  primaryModel: string | null;
  fallback1: string | null;
  fallback2: string | null;
}

export interface ChainOption {
  model: string;
  /** Valeur enregistrée qui n'est plus utilisable : affichée, jamais proposée. */
  unusable?: boolean;
  label: string;
}

export const CHAIN_RANKS: readonly ChainRank[] = ['primaryModel', 'fallback1', 'fallback2'];

/**
 * Options d'un rang : modèles utilisables, moins ceux choisis aux AUTRES
 * rangs. La valeur courante du rang, si elle n'est plus utilisable, est
 * ajoutée en tête, marquée — en lecture seule « — indisponible », dans un
 * brouillon « — invalide, à remplacer » —, pour qu'une version historique
 * reste lisible sans que le modèle redevienne un choix.
 */
export function chainOptions(
  usable: readonly string[],
  chain: ChainSelection,
  rank: ChainRank,
  opts: { readOnly: boolean; reasonOf?: (model: string) => string | null } = { readOnly: false },
): ChainOption[] {
  const autres = new Set(CHAIN_RANKS.filter((r) => r !== rank).map((r) => chain[r]).filter((m): m is string => Boolean(m)));
  const out: ChainOption[] = usable.filter((m) => !autres.has(m)).map((m) => ({ model: m, label: m }));
  const courant = chain[rank];
  if (courant && !usable.includes(courant)) {
    const motif = opts.reasonOf?.(courant) ?? null;
    out.unshift({
      model: courant,
      unusable: true,
      label: `${courant} — ${opts.readOnly ? 'indisponible' : 'invalide, à remplacer'}${motif ? ` (${motif})` : ''}`,
    });
  }
  return out;
}

/** Rangs dont la valeur enregistrée n'est plus utilisable (brouillon : promotion bloquée). */
export function unusableRanks(usable: readonly string[], chain: ChainSelection): ChainRank[] {
  return CHAIN_RANKS.filter((r) => chain[r] && !usable.includes(chain[r]!));
}
