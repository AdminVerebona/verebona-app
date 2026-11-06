/**
 * Lot 113A (#692, régression P1) — choix des biens d'une carte « À quel bien
 * rattacher ce document ? » (règle LINK-ASSET).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA RÉGRESSION
 *
 * La carte n'affichait des boutons de biens que lorsque T3 DOCUMENT_ASSET lui
 * avait laissé des CANDIDATS (carte ARBITRATE). Sans candidat, la carte est
 * COMPLETE et `ActionCard` (branche COMPLETE, inchangée depuis le lot 28)
 * n'offrait qu'un bouton générique « Ouvrir ». Le lot 108E (#626 bis, A6) a
 * fait d'une indisponibilité du modèle une issue technique — plus de carte
 * AI_UNAVAILABLE portant les candidats — et ferme les cartes « nées d'une
 * panne » ; avec le lot 105D (une adresse de facturation n'est jamais une
 * preuve), les documents réexaminés retombent en NO_CANDIDATE : carte
 * COMPLETE, « Ouvrir » seul.
 *
 * LA CORRECTION — aucun second moteur de rattachement
 *
 * La carte LINK-ASSET montre TOUJOURS les biens du compte pouvant recevoir le
 * document (non supprimés, ni archivés ni verrouillés — même règle que les
 * sélecteurs 111I), candidats de T3 d'abord. Le clic passe par la route
 * existante `/api/v2/to-process/[publicId]/resolve` (mode `arbitrate`) :
 * écrivain canonique du pont documentaire (`ASSET_LINK_SLOT`), contrôle
 * d'appartenance au compte en base, verrou de la carte (pas de double
 * rattachement), trace `to_process_action_events`, « Annuler ».
 *
 * Lecture : une requête par page (seulement s'il y a une carte LINK-ASSET),
 * bornée au compte de la session ; fonctions de composition pures.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import type { ActionProposal } from './action-model';
import { unnamedLabel } from './card-labels';

/** Règles dont la carte propose directement les biens du compte. */
export const ASSET_LINK_CHOICE_RULES: ReadonlySet<string> = new Set(['LINK-ASSET']);

/** Biens présentés au plus sur une carte (même borne que les sélecteurs de cibles, lot 111I). */
export const ASSET_LINK_CHOICES_MAX = 200;

export interface AssetLinkChoice {
  assetId: number;
  label: string;
  /** Candidat retenu par l'analyse (T3) : affiché en premier, en évidence. */
  suggested: boolean;
}

/**
 * Choix de la carte : `OK` (au moins un bien), `EMPTY` (aucun bien ne peut
 * recevoir le document), `ERROR` (liste illisible — jamais de bouton trompeur).
 */
export type AssetLinkChoicesView =
  | { status: 'OK'; items: AssetLinkChoice[] }
  | { status: 'EMPTY'; items: [] }
  | { status: 'ERROR'; items: [] };

export interface EligibleAsset { id: number; name: string | null }

/** La carte propose-t-elle les biens du compte ? (pure) */
export function isAssetLinkChoiceCard(c: { ruleCode: string; targetType: string; relationKey?: string | null }): boolean {
  return ASSET_LINK_CHOICE_RULES.has(c.ruleCode) && c.targetType === 'DOCUMENT' && (c.relationKey ?? 'assetIds') === 'assetIds';
}

const posInt = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * Composition (pure) : candidats de l'analyse d'abord (ordre de confiance,
 * seulement s'ils restent éligibles), puis les autres biens éligibles dans
 * l'ordre reçu (nom, puis identifiant). Chaque bien une seule fois.
 */
export function buildAssetLinkChoices(proposals: ReadonlyArray<Pick<ActionProposal, 'value' | 'confidence' | 'isCurrentValue'>>, eligible: ReadonlyArray<EligibleAsset>): AssetLinkChoicesView {
  const byId = new Map(eligible.map((a) => [a.id, a]));
  const label = (a: EligibleAsset) => (a.name && a.name.trim() ? a.name.trim() : unnamedLabel('ASSET'));
  const suggested = [...proposals]
    .filter((p) => !p.isCurrentValue)
    .map((p, i) => ({ id: posInt(p.value), c: Number.isFinite(p.confidence) ? p.confidence : 0, i }))
    .filter((p): p is { id: number; c: number; i: number } => p.id !== null && byId.has(p.id))
    .sort((a, b) => b.c - a.c || a.i - b.i);
  const seen = new Set<number>();
  const items: AssetLinkChoice[] = [];
  for (const s of suggested) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    items.push({ assetId: s.id, label: label(byId.get(s.id)!), suggested: true });
  }
  for (const a of eligible) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    items.push({ assetId: a.id, label: label(a), suggested: false });
  }
  return items.length ? { status: 'OK', items } : { status: 'EMPTY', items: [] };
}

/**
 * Biens du compte pouvant recevoir un document : non supprimés, ni archivés
 * ni verrouillés (règle `writable` des cibles 111I). Une requête, bornée.
 */
export async function loadEligibleLinkAssets(accountId: number): Promise<EligibleAsset[]> {
  const rows = (await pgClient.unsafe(
    `SELECT a.id, a.name FROM assets a
      WHERE a.account_id = $1 AND a.deleted_at IS NULL
        AND a.status IS DISTINCT FROM 'ARCHIVED' AND COALESCE(a.lock_state, 'NONE') = 'NONE'
      ORDER BY lower(a.name), a.id
      LIMIT $2`,
    [accountId, ASSET_LINK_CHOICES_MAX] as never[],
  )) as unknown as Array<{ id: number | string; name: string | null }>;
  return rows.map((r) => ({ id: Number(r.id), name: r.name ?? null }));
}
