/**
 * Réparation et escalade d'un appel modèle — CDC §15.4, §15.5, §18.6, §9.6, CA-07.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AVANT : TOUT ÉCHEC ESCALADAIT, AUCUNE SORTIE N'ÉTAIT RÉPARÉE
 *
 * L'appel recevait tout le budget restant : la passerelle enchaînait le
 * modèle d'escalade sur n'importe quelle erreur (timeout, 503, sortie
 * invalide). Le §15.4 limite l'escalade à des cas précis, et le §18.6 impose
 * d'abord UNE réparation avec le même modèle pour une sortie invalide.
 *
 * Politique appliquée (≤ 2 appels par message, décomptés sur le budget) :
 *
 *   1er appel : modèle par défaut SEUL.
 *   · sortie invalide (non parsable, hors schéma)  → RÉPARATION, même modèle,
 *     avec la liste des erreurs de validation et le schéma, SANS nouvelle
 *     donnée (§18.6) ; échec → repli déterministe (pas de 3e appel) ;
 *   · sortie vide                                   → ESCALADE (§15.4 a) ;
 *   · règle de qualité explicite de l'appelant      → ESCALADE (§15.4 d, e) ;
 *   · timeout, fournisseur indisponible, arrêt
 *     d'urgence, budget épuisé                      → aucun second appel :
 *     ces cas ne figurent pas au §15.4, le repli déterministe s'applique.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { AiGatewayRequest, AiGatewayResponse } from '@/services/ai/gateway/types';
import { isAiGatewayError } from '@/services/ai/gateway/errors';
import { executeWithinBudget, type AiCallBudget } from './ai-call-budget';
import type { AiRunContext } from './usage-tracking.service';
import { isAssistantFlagOn } from '../config/assistant-flags.server';

export type ModelFailureKind =
  | 'EMPTY_OUTPUT'
  | 'INVALID_OUTPUT'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'BUDGET_EXHAUSTED'
  | 'BLOCKED';

/** Motifs d'escalade autorisés — §15.4, et eux seuls. */
export type EscalationReason =
  | 'EMPTY_OUTPUT'
  | 'COMPLEX_CONTRADICTION'
  | 'SYNTHESIS_FAILED'
  | 'QUALITY_RULE';

export const ALLOWED_ESCALATION_REASONS: readonly EscalationReason[] = [
  'EMPTY_OUTPUT', 'COMPLEX_CONTRADICTION', 'SYNTHESIS_FAILED', 'QUALITY_RULE',
];

/**
 * Nature d'un échec de la passerelle. Les erreurs de validation (issues zod,
 * erreur de parsing) sont extraites SANS l'extrait de la sortie brute : la
 * réparation ne doit recevoir que les erreurs, pas de nouvelles données.
 */
export function classifyModelFailure(e: unknown): { kind: ModelFailureKind; errors: string[] } {
  if (!isAiGatewayError(e)) return { kind: 'UNAVAILABLE', errors: [] };
  // Lot 22 : plafond mensuel de coût IA du compte atteint pendant la demande.
  if (e.code === 'QUOTA_EXCEEDED' || e.code === 'COST_CAP_REACHED') return { kind: 'BUDGET_EXHAUSTED', errors: [] };
  if (e.code === 'AI_BLOCKED') return { kind: 'BLOCKED', errors: [] };
  if (e.code === 'TIMEOUT') return { kind: 'TIMEOUT', errors: [] };
  const msg = e.message ?? '';
  // Sortie vide : rien à parser, extrait vide.
  if (/Aucune structure JSON d[ée]tect[ée]e\.\s*Extrait\s*:\s*$/.test(msg)) return { kind: 'EMPTY_OUTPUT', errors: [] };
  const schema = msg.match(/Sortie non conforme au sch[ée]ma\.\s*(.+?)(?:\s+—\s+|$)/);
  if (schema) return { kind: 'INVALID_OUTPUT', errors: schema[1].split(' | ').map((x) => x.trim()).filter(Boolean).slice(0, 5) };
  const parse = msg.match(/Sortie non parsable\s*:\s*([^.]+)\./);
  if (parse || e.code === 'INVALID_OUTPUT') return { kind: 'INVALID_OUTPUT', errors: [parse ? `JSON invalide : ${parse[1].trim()}` : 'sortie invalide'] };
  if (/timeout|timed out|d[ée]lai/i.test(msg)) return { kind: 'TIMEOUT', errors: [] };
  return { kind: 'UNAVAILABLE', errors: [] };
}

/** Consigne de réparation : le schéma attendu et les erreurs, rien d'autre (§18.6). */
export function repairInstruction(schemaDescription: string, errors: string[]): string {
  const liste = (errors.length ? errors : ['sortie invalide']).map((x) => `- ${x.replace(/[<>]/g, ' ').slice(0, 200)}`).join('\n');
  return [
    'CORRECTION DEMANDÉE : ta réponse précédente ne respectait pas le format attendu.',
    `Erreurs de validation :\n${liste}`,
    `Format attendu : ${schemaDescription}`,
    'Réponds de nouveau, UNIQUEMENT avec ce JSON, à partir des mêmes données, sans rien ajouter.',
  ].join('\n');
}

export interface PolicyCallResult<T> {
  res: AiGatewayResponse<T>;
  path: 'first' | 'repair' | 'escalation';
  /** Motifs tracés (réparation, escalade), dans l'ordre. */
  events: string[];
  /** Erreurs de validation de la 1re sortie, quand une réparation a eu lieu (§18.6). */
  repairErrors?: string[];
}

export interface PolicyCallOptions<T> {
  budget: AiCallBudget | undefined;
  /** Construit la requête ; `repair` fourni pour la tentative de réparation. */
  build: (variant: { repair?: string[]; escalation?: boolean }) => AiGatewayRequest<T>;
  trace?: AiRunContext;
  /** Description courte du schéma, transmise à la réparation. */
  schemaDescription: string;
}

/**
 * Premier appel, puis au plus UN second : réparation (sortie invalide) ou
 * escalade (sortie vide). Lève l'erreur d'origine quand aucun second appel
 * n'est permis ; l'appelant applique alors son repli déterministe.
 */
export async function callWithRepairOrEscalation<T>(o: PolicyCallOptions<T>): Promise<PolicyCallResult<T>> {
  const events: string[] = [];
  try {
    const res = await executeWithinBudget(o.budget, o.build({}), o.trace, { modelAttempts: 1 });
    return { res, path: 'first', events };
  } catch (e) {
    const f = classifyModelFailure(e);
    const reste = !o.budget || o.budget.canCall();
    if (f.kind === 'INVALID_OUTPUT' && reste) {
      events.push('REPAIR:INVALID_OUTPUT');
      const res = await executeWithinBudget(o.budget, o.build({ repair: f.errors }), o.trace, { modelAttempts: 1 })
        .catch((e2: unknown) => {
          // Réparation en échec : les erreurs d'origine restent lisibles par
          // l'appelant (action inventée, champ inconnu…).
          if (e2 && typeof e2 === 'object') (e2 as { repairErrors?: string[] }).repairErrors = f.errors;
          throw e2;
        });
      return { res, path: 'repair', events, repairErrors: f.errors };
    }
    if (f.kind === 'EMPTY_OUTPUT' && reste && isAssistantFlagOn('fallback_model')) {
      events.push('ESCALATION:EMPTY_OUTPUT');
      const res = await escalate(o);
      return { res, path: 'escalation', events };
    }
    throw e;
  }
}

/**
 * Escalade explicite vers le modèle de repli seul (rang 1), pour un motif du
 * §15.4. Lève si le budget ou la configuration ne le permettent pas.
 */
export async function escalate<T>(o: PolicyCallOptions<T>): Promise<AiGatewayResponse<T>> {
  return executeWithinBudget(o.budget, o.build({ escalation: true }), o.trace, { modelAttempts: 1, firstModelIndex: 1 });
}

/** Un second appel d'escalade est-il encore possible pour ce message ? */
export function canEscalate(budget: AiCallBudget | undefined): boolean {
  return isAssistantFlagOn('fallback_model') && (!budget || budget.canCall());
}
