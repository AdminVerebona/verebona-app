/**
 * Lot 97A — contrat `t1-billing-period-v1` (demande IA historique
 * `87D-mois-principal-factures`) : pour une facture périodique, T1 dit quelle
 * période est facturée et à quel MOIS elle se rattache principalement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ACTIVATION PRUDENTE (même modèle que `t1-value-decisions-v1`, lot 91D)
 *
 * Le schéma de sortie T1 (v7) ACCEPTE toujours `document.billingPeriod`
 * (champ facultatif, additif). Le code ne le CONSERVE que si la version
 * EFFECTIVE du prompt maître T1 porte le marqueur `t1-billing-period-v1`
 * (texte collé par le PO, docs/exploitation/prompts-a-appliquer-par-le-po.md)
 * et que c'est bien cette version qui a répondu. Sans lui :
 *   · rien n'est persisté : le nommage garde exactement son comportement
 *     (« titre périodique sans mois principal décidé par l'IA ») ;
 *   · rien n'est bloqué (analyse, faits, Opérations, TCO inchangés).
 * Le mois principal n'est exploité par le nommage qu'avec la confiance
 * « certain » (`principalMonthFromAnalysis`) ; le code ne le déduit jamais.
 * Lot 99C : seul un mois ÉCRIT sur le document (`STATED_ON_DOCUMENT`, preuve
 * citée) fait le titre sans décision T3 ; la représentation temporelle est
 * décidée par T3 DOCUMENT_NAMING (`t3-naming-period-v1`). La période facturée
 * (`start` / `end`) reste une donnée T1, lue par le nommage.
 * Coupure d'urgence : `T1_BILLING_PERIOD_ENABLED=0`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { T1BillingPeriod } from '../master/t1-contract';
import type { SourceAnalysisResult } from '../types';

/** Marqueur exact recherché dans le texte du prompt maître T1. */
export const T1_BILLING_PERIOD_CONTRACT = 't1-billing-period-v1';
/** Demande IA d'origine. */
export const T1_BILLING_PERIOD_PENDING_CONTRACT = '87D-mois-principal-factures';

/** Le texte d'un prompt porte-t-il le contrat ? (pure, simple recherche du marqueur) */
export function promptCarriesBillingPeriod(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(T1_BILLING_PERIOD_CONTRACT);
}

export interface BillingPeriodCapability {
  carried: boolean;
  version: string | null;
  reason: 'CARRIED' | 'MARKER_MISSING' | 'DISABLED' | 'UNREADABLE';
}

/** Coupure d'urgence : `T1_BILLING_PERIOD_ENABLED=0`. Pure. */
export const billingPeriodEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.T1_BILLING_PERIOD_ENABLED ?? '1').trim() !== '0';

let cache: { at: number; value: BillingPeriodCapability } | null = null;
const CACHE_MS = 60_000;

/** Réservé aux tests : vide le cache de disponibilité. */
export function __resetBillingPeriodCapabilityCacheForTests(): void { cache = null; }

/** Le prompt T1 effectif porte-t-il le contrat ? Lecture seule, cache 60 s, ne lève pas. */
export async function billingPeriodCapability(): Promise<BillingPeriodCapability> {
  if (!billingPeriodEnabled()) return { carried: false, version: null, reason: 'DISABLED' };
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: BillingPeriodCapability;
  try {
    const { effectivePromptOf } = await import('../../master-prompts/effective-prompt');
    const p = await effectivePromptOf('t1_analyze_document');
    const carried = promptCarriesBillingPeriod(p.text);
    value = { carried, version: p.version, reason: carried ? 'CARRIED' : 'MARKER_MISSING' };
  } catch (e) {
    console.error('[t1-billing-period] version du prompt T1 illisible :', (e as Error).message);
    value = { carried: false, version: null, reason: 'UNREADABLE' };
  }
  cache = { at: Date.now(), value };
  return value;
}

/**
 * Bloc PERSISTÉ avec le résultat d'analyse (pur) : la décision de T1 telle
 * quelle — seule la forme change (preuve `{ quote, page }` lue par le
 * nommage). `null` : contrat non porté, autre version, ou bloc absent.
 */
export function persistedBillingPeriod(
  bp: T1BillingPeriod | undefined,
  cap: Pick<BillingPeriodCapability, 'carried' | 'version'>,
  respondingVersion: string,
): NonNullable<SourceAnalysisResult['document']['billingPeriod']> | null {
  if (!bp || !cap.carried || (cap.version !== null && cap.version !== respondingVersion)) return null;
  return {
    start: bp.start, end: bp.end, principalMonth: bp.principalMonth, principalMonthBasis: bp.principalMonthBasis,
    confidence: bp.confidence,
    evidence: { quote: bp.evidence?.excerpt?.slice(0, 200) ?? null, page: bp.evidence?.page ?? null },
  };
}
