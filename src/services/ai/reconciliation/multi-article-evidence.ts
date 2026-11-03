/**
 * Lot 107D — preuves de PRIX non attribuables : montant de transaction d'un
 * justificatif à plusieurs articles (ticket P1 « Draisienne »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CAUSE DÉMONTRÉE PAR LE CODE (reproduite en e2e L107D-E2E-01)
 *
 * La projection T1 refusait déjà le total d'un ticket à plusieurs lignes
 * (ACQUISITION_PRICE_NOT_ATTRIBUTABLE) quand les lignes étaient lisibles,
 * mais trois chemins faisaient encore d'un montant de PANIER une preuve
 * `acquisitionPrice` :
 *   1. T3 « Informations » (lot 76J, `materializeAcquisitionPrices`) : le
 *      coût réalisé TOTAL du candidat Opération ACQUISITION du ticket (cible
 *      certaine : l'objet acheté) devenait une preuve ordinaire du prix —
 *      précisément quand T1 avait refusé le total ;
 *   2. un fait `acquisitionPrice` rendu par le modèle avec le total pour
 *      extrait (aucun contrôle de rôle sur un fait du modèle) ;
 *   3. la règle « justificatif d'achat du bien » quand la transcription ne
 *      laissait pas compter les lignes (nombre non établi → total gardé en
 *      `probable`, proposé par T3).
 * Une valeur saisie par l'utilisateur (USER) contredite par cette preuve →
 * MANUAL_VALUE_CONTRADICTED → carte « À arbitrer » (proposition = total).
 *
 * CE QUE FAIT CE MODULE (lecture seule, aucune écriture)
 *
 * Avant toute décision T3 (bien, équipement, rattrapage, contrôle de
 * cohérence), les preuves du prix d'acquisition dont la SOURCE est un
 * justificatif à plusieurs articles (profil relu dans la couche A persistée,
 * `document_source_units`, ou la transcription conservée) et dont la valeur
 * est un montant de transaction — et celui d'aucune ligne — sont ÉCARTÉES,
 * avec leur motif : elles restent en base (jamais supprimées), tracées dans
 * le rapport T3 et le contrôle COH-PRICE-MULTI-ARTICLE.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { resolveAlias } from '@/services/canonical/registry';
import {
  buildReceiptProfile, classifyAmount, linesOfSourceUnits, linesOfTranscription, parseMoneyCents,
  type AmountRole, type ReceiptProfile,
} from '@/services/ai/source-analysis/projection/amount-roles';
import { PROJECTION_RULES } from '@/services/ai/source-analysis/projection/rules';
import type { FieldEvidence } from '../evidence/evidence.types';
import type { CurrentValue, ReconciliationDecision } from './types';

/** Clé canonique concernée (prix d'acquisition d'un bien ou d'un équipement). */
export const PRICE_FIELD = 'acquisitionPrice';

/** Motif stable d'une preuve écartée. */
export const BASKET_EXCLUSION_REASON = 'BASKET_TOTAL_MULTI_ARTICLE';

export interface ExcludedAmountEvidence {
  evidenceId: number;
  sourceId: number;
  value: unknown;
  cents: number;
  reason: typeof BASKET_EXCLUSION_REASON;
  /** Rôles du montant sur le justificatif (TOTAL_PAID, SUBTOTAL, PAYMENT…). */
  summaryRoles: AmountRole[];
  projectionRule: string | null;
}

/** Règles qui portent une LIGNE d'article (jamais écartées : elles ne sont pas le total). */
const REGLES_LIGNE = new Set<string>([PROJECTION_RULES.PURCHASE_LINE_ACQUISITION_PRICE, PROJECTION_RULES.PURCHASE_LINE_ATTRIBUTED]);

export const isPriceField = (fieldKey: string): boolean => (resolveAlias(fieldKey) ?? fieldKey) === PRICE_FIELD;

/** Valeur d'une preuve de prix → centimes (euros stockés en nombre ou en texte). */
export function evidenceCents(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value === 'string') {
    const n = Number(value.replace(',', '.'));
    if (value.trim() && Number.isFinite(n)) return Math.round(n * 100);
    return parseMoneyCents(value);
  }
  return null;
}

/** Cache des profils pour un passage (un document lu une fois). */
export type ReceiptProfileCache = Map<number, ReceiptProfile | null>;

/**
 * Profil des montants d'un document, relu dans la couche A persistée
 * (unités de la source), à défaut dans la transcription conservée. `null` :
 * rien de lisible (aucune exclusion possible : prudence, comportement antérieur).
 */
export async function loadReceiptProfile(accountId: number, fileId: number, cache?: ReceiptProfileCache): Promise<ReceiptProfile | null> {
  if (cache?.has(fileId)) return cache.get(fileId)!;
  let profile: ReceiptProfile | null = null;
  try {
    const { loadDocumentSourceUnits } = await import('@/services/ai/source-analysis/source-units/repository');
    const units = await loadDocumentSourceUnits(fileId, { accountId, kinds: ['DOCUMENT_METADATA', 'TEXT_BLOCK', 'LABEL_VALUE', 'TABLE_ROW'], limit: 5_000 });
    if (units.length > 0) {
      const { lines, documentTotalCents } = linesOfSourceUnits(units);
      profile = buildReceiptProfile(lines, documentTotalCents);
    } else {
      const { pgClient } = await import('@/db');
      const [x] = (await pgClient.unsafe(
        `SELECT full_text, amount_cents FROM document_extractions WHERE file_id = $1 AND account_id = $2 LIMIT 1`,
        [fileId, accountId] as never[],
      )) as unknown as Array<{ full_text: string | null; amount_cents: number | string | null }>;
      if (x?.full_text) profile = buildReceiptProfile(linesOfTranscription(x.full_text), x.amount_cents == null ? null : Number(x.amount_cents));
    }
  } catch (e) {
    console.error(`[t3-multi-articles] profil du document ${fileId} illisible (aucune exclusion) :`, (e as Error).message);
    profile = null;
  }
  cache?.set(fileId, profile);
  return profile;
}

/**
 * Preuves d'un champ → preuves retenues / écartées (montant de transaction
 * d'un justificatif à plusieurs articles). Champ autre que le prix : tout
 * est retenu. Ne lève jamais.
 */
export async function screenAmountEvidence(
  accountId: number, fieldKey: string, evidences: FieldEvidence[], cache: ReceiptProfileCache = new Map(),
): Promise<{ kept: FieldEvidence[]; excluded: ExcludedAmountEvidence[] }> {
  if (!isPriceField(fieldKey) || evidences.length === 0) return { kept: evidences, excluded: [] };
  const kept: FieldEvidence[] = [];
  const excluded: ExcludedAmountEvidence[] = [];
  for (const e of evidences) {
    const cents = evidenceCents(e.value);
    if (e.sourceType !== 'document' || cents === null || (e.projectionRule && REGLES_LIGNE.has(e.projectionRule))) { kept.push(e); continue; }
    const profile = await loadReceiptProfile(accountId, e.sourceId, cache);
    const c = profile && profile.multiArticle ? classifyAmount(profile, cents) : null;
    if (c?.role === 'BASKET') {
      excluded.push({ evidenceId: e.id, sourceId: e.sourceId, value: e.value, cents, reason: BASKET_EXCLUSION_REASON,
        summaryRoles: c.summaryRoles, projectionRule: e.projectionRule ?? null });
      continue;
    }
    kept.push(e);
  }
  return { kept, excluded };
}

/**
 * Décision quand TOUTES les preuves du prix ont été écartées (pure) :
 *   · valeur en place renseignée → `keep` NON_ATTRIBUTABLE_AMOUNT : la
 *     contradiction n'existe plus, l'arbitrage ouvert est clos (pont « À
 *     traiter » : RESOLVE), aucune écriture ;
 *   · champ vide → `ignore` NO_EVIDENCE (comme sans preuve : une complétion
 *     légitime n'est pas fermée, aucune valeur inventée).
 */
export function nonAttributableDecision(fieldKey: string, current: CurrentValue | null, excluded: readonly ExcludedAmountEvidence[]): ReconciliationDecision {
  const vide = !current || current.normalized === null || current.normalized === '';
  return vide
    ? { fieldKey, currentValue: current?.value ?? null, proposedValue: null, action: 'ignore', reasonCode: 'NO_EVIDENCE', confidence: 'conflictual',
      evidenceIds: excluded.map((e) => e.evidenceId), deterministic: true }
    : { fieldKey, currentValue: current!.value, proposedValue: current!.value, action: 'keep', reasonCode: 'NON_ATTRIBUTABLE_AMOUNT', confidence: 'certain',
      evidenceIds: excluded.map((e) => e.evidenceId), deterministic: true };
}
