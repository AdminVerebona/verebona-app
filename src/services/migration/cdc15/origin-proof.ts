/**
 * Origine HUMAINE PROUVÉE d'une valeur de fiche — relecture du lot 17
 * (MIG-02, MIG-07). Une valeur lue USER n'est pas toujours une saisie
 * établie : sans information, la lecture suppose USER par prudence, et
 * MIG-03 la pose explicitement (`NO_AI_PROOF_PROTECTED`). Cette présomption
 * PROTÈGE la valeur (jamais écrasée), mais elle ne suffit pas pour écraser
 * AUTRE CHOSE en son nom (colonne historique) ni pour classer un soupçon
 * sans l'utilisateur.
 *
 *   PROVEN     dernière écriture du champ humaine avec cette valeur
 *              (journal 0216) ; ancien `_origin = manual` ; origine
 *              structurée humaine préexistante (sans `__originBasis`) ou
 *              posée par MIG-03 au titre de LEGACY_MANUAL / HUMAN_WRITE_PROVEN ;
 *   PRESUMED   aucune information d'origine, ou USER posé par MIG-03 au
 *              titre de NO_AI_PROOF_PROTECTED ;
 *   AUTOMATIC  origine automatique (structurée, ou ancien `_origin = auto`).
 *
 * MIG-03 écrit le motif dans `<clé>__originBasis` (clé technique).
 */
import { FIELD_ORIGINS, isHumanOrigin } from '@/services/ai/reconciliation/field-origin';
import type { FieldOrigin } from '@/services/ai/evidence/evidence.types';
import { provenOrigin, type FieldWriteEvent } from './history';

export const ORIGIN_BASIS = '__originBasis';
export const PROVEN_BASES = new Set(['LEGACY_MANUAL', 'HUMAN_WRITE_PROVEN']);

export type HumanProof = 'PROVEN' | 'PRESUMED' | 'AUTOMATIC';

/** Preuve d'origine de la valeur lue sous `readKey` (pure, testée). */
export function humanOriginProof(
  kc: Record<string, unknown>, readKey: string, canonicalKey: string, value: unknown, history: FieldWriteEvent[] | undefined,
): HumanProof {
  const last = provenOrigin(history, canonicalKey, value);
  if (last && isHumanOrigin(last.origin)) return 'PROVEN';
  const s = kc[`${readKey}__origin`];
  if (typeof s === 'string' && (FIELD_ORIGINS as string[]).includes(s)) {
    if (!isHumanOrigin(s as FieldOrigin)) return 'AUTOMATIC';
    const basis = kc[`${readKey}${ORIGIN_BASIS}`];
    if (basis === undefined || (typeof basis === 'string' && PROVEN_BASES.has(basis))) return 'PROVEN';
    return 'PRESUMED';
  }
  const legacy = kc[`${readKey}_origin`];
  if (legacy === 'manual') return 'PROVEN';
  if (legacy === 'auto') return 'AUTOMATIC';
  return 'PRESUMED';
}
