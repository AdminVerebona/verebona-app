/**
 * Autorisation EFFECTIVE d'appeler un modèle depuis l'assistant (T2) —
 * lot 113AE, Trello #728 (décision PO du 09/11/2026).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS DROITS DISTINCTS, CÔTÉ SERVEUR
 *
 *   1. T2 COGNITIF — `registries/capability-registry.ts` : toutes les offres
 *      actives (Standard, Premium, Premium Duo, essai actif) ont le même T2
 *      (compréhension, arbitrage, réponse, revalidation, aide, synthèse…).
 *   2. AUTORISATION EFFECTIVE D'APPEL MODÈLE — CE module, prédicat UNIQUE
 *      utilisé par TOUS les appels IA de l'assistant (UNDERSTAND, ARBITRATE,
 *      ANSWER, REVALIDATE, aide, reprises de clarification, ports) :
 *        · droits réels du compte (`getEntitlements`) : lecture permise,
 *          écriture permise, aucune restriction, statut réel `active` ou
 *          `trialing` (essai actif), offre connue ;
 *        · flags du §39 (`VEREBONA_ASSISTANT_AI_ENABLED`,
 *          `VEREBONA_ASSISTANT_ACCOUNT_AI`) lus à chaque demande.
 *      L'arrêt d'urgence / état du traitement T2, le budget d'appels du
 *      message, le plafond mensuel et le plafond de coût du compte restent
 *      appliqués EN PLUS, au même endroit qu'avant (orchestrateur et
 *      passerelle) : ce prédicat ne les contourne jamais.
 *      Un compte en lecture seule (essai échu), impayé (`past_due`), résilié
 *      (`canceled`) ou sans abonnement (`none`) : ZÉRO appel modèle, y compris
 *      en reprise de clarification ou en revalidation.
 *   3. DROIT PREMIUM MÉTIER — `premiumFeatures` des droits, contrôlé par
 *      fonctionnalité (TCO, dossiers, synchronisation d'agenda). Jamais
 *      déduit de l'éligibilité IA, jamais simulé : un compte Standard n'a
 *      JAMAIS `premiumFeatures = true` ni `planType = PREMIUM`.
 *
 * Les traces portent l'offre commerciale RÉELLE (`commercialPlan`) : un
 * compte Standard reste « standard » dans les journaux et le BO.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { EntitlementPlan, Entitlements } from '@/services/entitlements.service';
import type { AssistantRequestInput } from '../types/contracts';
import { getAssistantConfig } from '../config/assistant-config';
import { isAssistantFlagOn } from '../config/assistant-flags.server';
import { isT2CognitivePlan } from '../registries/capability-registry';
import { assistantPlanLimit } from './plan-eligibility';

/** Motif de refus des appels modèle pour le COMPTE (hors flags et budgets). */
export type AssistantAiDenial = 'TRIAL_EXPIRED' | 'SUBSCRIPTION_REQUIRED' | 'NO_ACCESS';

/** Accès IA du compte, calculé côté serveur à partir des droits réels. */
export interface AssistantAiAccess {
  /** Le compte peut-il déclencher un appel modèle T2 ? */
  modelCalls: boolean;
  /** Motif du refus (`null` : autorisé). */
  denial: AssistantAiDenial | null;
  /** Offre commerciale RÉELLE (`getEntitlements().plan`) — traces et BO, jamais simulée. */
  commercialPlan: EntitlementPlan;
  /** Statut réel de l'abonnement (`trialing`, `active`, `readonly`, `past_due`, `canceled`, `none`). */
  status: string;
  /** Droit Premium MÉTIER réel (TCO, dossiers prêts à l'usage, synchronisation d'agenda). */
  premiumFeatures: boolean;
  /** Écriture permise (commandes, créations). */
  canWrite: boolean;
}

/** Statuts réels qui ouvrent les appels modèle : abonnement actif ou essai actif. */
const STATUTS_ACTIFS: ReadonlySet<string> = new Set(['active', 'trialing']);

/** Accès IA d'un compte à partir de ses droits (pure, testée). */
export function assistantAiAccessFromEntitlements(
  e: Pick<Entitlements, 'plan' | 'status' | 'premiumFeatures' | 'canWrite'> & { canRead?: boolean; isRestricted?: boolean },
): AssistantAiAccess {
  const limite = assistantPlanLimit(e);
  const actif = limite === null
    && e.canRead !== false
    && e.isRestricted !== true
    && e.plan !== 'none'
    && STATUTS_ACTIFS.has(e.status);
  return {
    modelCalls: actif,
    // Statut non reconnu mais écriture permise : prudence, aucun appel,
    // motif « offre requise » (jamais un accès implicite).
    denial: actif ? null : limite ?? 'SUBSCRIPTION_REQUIRED',
    commercialPlan: e.plan,
    status: e.status,
    premiumFeatures: e.premiumFeatures === true,
    canWrite: e.canWrite === true,
  };
}

/** Accès IA d'un compte, lu dans ses droits effectifs (source de vérité serveur). */
export async function resolveAssistantAiAccess(accountId: number): Promise<AssistantAiAccess> {
  const { getEntitlements } = await import('@/services/entitlements.service');
  return assistantAiAccessFromEntitlements(await getEntitlements(accountId));
}

type AccessInput = Pick<AssistantRequestInput, 'aiAccess' | 'planLimit' | 'planType'>;

/**
 * Le COMPTE autorise-t-il un appel modèle pour cette demande ?
 *
 * Les routes (`/api/verebona/messages`, réponse à une clarification)
 * fournissent TOUJOURS `aiAccess`. Sans lui (appel interne historique,
 * tests), règle prudente équivalente : aucune limite de compte ET offre
 * cognitive T2 — une limite `planLimit` suffit à tout couper.
 */
export function accountAllowsModelCalls(input: AccessInput): boolean {
  if (input.aiAccess) return input.aiAccess.modelCalls === true;
  return !input.planLimit && isT2CognitivePlan(String(input.planType ?? ''));
}

/** Flags du §39 qui coupent toute IA de l'assistant, lus à chaque appel. */
export function assistantAiFlagsOn(): boolean {
  return getAssistantConfig().aiEnabled && isAssistantFlagOn('account_ai');
}

/**
 * PRÉDICAT UNIQUE — un appel modèle de l'assistant est-il permis pour cette
 * demande ? Flags §39 ET droits réels du compte. Budget du message, plafonds
 * et arrêt d'urgence s'appliquent en plus, là où ils s'appliquaient déjà.
 */
export function isAssistantModelCallAllowed(input: AccessInput): boolean {
  return assistantAiFlagsOn() && accountAllowsModelCalls(input);
}

/**
 * Limite de compte à EXPLIQUER (« Voir les offres ») : celle des droits, ou
 * celle transmise historiquement par la route. Indépendante de l'offre
 * cognitive (un compte restreint garde le code `STANDARD`).
 */
export function accountLimitOf(input: AccessInput): 'TRIAL_EXPIRED' | 'SUBSCRIPTION_REQUIRED' | null {
  const d = input.aiAccess?.denial;
  if (d === 'TRIAL_EXPIRED' || d === 'SUBSCRIPTION_REQUIRED') return d;
  return input.planLimit ?? null;
}

/**
 * Droit Premium MÉTIER pour cette demande (dossiers prêts à l'usage, TCO…).
 * `undefined` : inconnu (appel interne sans droits) — l'appelant applique sa
 * règle historique. Jamais déduit de l'éligibilité IA.
 */
export function premiumBusinessRightOf(input: Pick<AssistantRequestInput, 'aiAccess'>): boolean | undefined {
  if (!input.aiAccess) return undefined;
  return input.aiAccess.premiumFeatures && input.aiAccess.canWrite;
}

/** Trace d'accès versée dans la cascade (offre RÉELLE, aucun contenu). */
export function accessTraceOf(input: AccessInput): NonNullable<import('../types/contracts').CascadeTrace['access']> {
  return input.aiAccess
    ? {
      commercialPlan: input.aiAccess.commercialPlan, status: input.aiAccess.status,
      modelCalls: input.aiAccess.modelCalls, denial: input.aiAccess.denial, premiumFeatures: input.aiAccess.premiumFeatures,
      source: 'entitlements',
    }
    : { commercialPlan: null, status: null, modelCalls: accountAllowsModelCalls(input), denial: input.planLimit ?? null, premiumFeatures: null, source: 'legacy' };
}
