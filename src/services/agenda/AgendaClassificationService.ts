/**
 * AgendaClassificationService — classifie un item agenda en 'action' ou 'information'
 * via Gemini Flash pour alimenter la home page.
 *
 * 'action'      → affiché dans "Prochaines dates" (peut être en retard)
 *                 ex : contrôle technique, réparation, renouvellement, rendez-vous
 * 'information' → affiché dans "À savoir" (fait passif, jamais en retard)
 *                 ex : fin de garantie, date d'achat, date de fabrication, échéance DPE
 */

import { executeLegacyPrompt } from '@/services/ai/gateway/legacy-prompt';
import { classifyByRulesInMode, resolveClassificationMode } from '@/services/ai/agenda/rules/rules-engine';

/**
 * Passerelle (plan de retrait WF-41) : opération
 * `legacy_classify_home_category` de l'usage AGENDA_INTELLIGENCE (T4).
 * Modèle principal de la version figée de T4, UNE tentative comme avant.
 */
export const LEGACY_CLASSIFY_HOME_CATEGORY_OPERATION = 'legacy_classify_home_category';

/** Compte (et auteur) de l'échéance classée : trace et coût de la passerelle. */
export interface AgendaClassificationContext {
  accountId: number;
  userId?: number;
}

export type HomeCategory = 'action' | 'information';

/**
 * Règles déterministes appliquées AVANT l'appel IA — CDC 15 T4-02, T4-11.
 *
 * PLUS DE COPIE LOCALE : ce service appelle la source unique
 * `ai/agenda/rules` (`classifyByRulesInMode`). Moteur historique EXACT tant
 * que ni `AI_T4_EFFECTS=enabled` ni T4 `master` (test de parité) ; moteur
 * v2 (registre, règles métier stables) sinon ; divergences journalisées en
 * shadow. Retourne null si on ne peut pas décider de façon certaine.
 */
async function classifyByRules(
  title: string,
  description: string | null | undefined,
  originType: string,
  originFieldKey?: string | null,
): Promise<HomeCategory | null> {
  const mode = await resolveClassificationMode();
  return classifyByRulesInMode(
    { title, description: description ?? null, originType, originFieldKey: originFieldKey ?? null }, mode,
  )?.category ?? null;
}

/**
 * Classifie un item agenda (règles, puis modèle via la passerelle).
 * Retourne 'action' en cas d'erreur (fallback sûr : mieux vaut afficher
 * une date d'information dans "Prochaines dates" que la masquer).
 */
export async function classifyAgendaItem(
  title: string,
  description: string | null | undefined,
  originType: string,
  originFieldKey: string | null | undefined,
  ctx: AgendaClassificationContext,
): Promise<HomeCategory> {
  // 1. Règles déterministes d'abord
  const ruleResult = await classifyByRules(title, description, originType, originFieldKey);
  if (ruleResult !== null) return ruleResult;

  // 2. Appel IA via la passerelle — clé ACTIVE du BO, garde d'exploitation de
  //    T4 (arrêt d'urgence, désactivation, suspension : OPS-011, WF-07, WF-08),
  //    disjoncteur. Tout échec, `AI_BLOCKED` compris, retombe sur le repli
  //    déterministe 'action', comme sans clé.
  try {
    const prompt = `Tu es un assistant qui classe des événements agenda en deux catégories :
- "action" : une tâche qui nécessite une intervention physique ou une décision de l'utilisateur (contrôle technique, réparation, rendez-vous, entretien, récupération d'un objet stocké, reprise de pneus, restitution d'un dépôt, etc.)
- "information" : un fait passif qui ne nécessite aucune action de la part de l'utilisateur (fin de garantie, date d'achat, fin de période d'assurance avec reconduction automatique, date d'expiration d'un diagnostic, etc.)

Important :
- Une fin de contrat ou période d'assurance avec reconduction tacite est une "information" — l'assurance se renouvelle automatiquement.
- Une reprise de pneus, récupération d'un véhicule en dépôt, ou tout événement où l'utilisateur doit se déplacer physiquement est une "action".
- En cas de doute sur un contrat de stockage ou gardiennage, préférer "action".

Événement à classer :
Titre : ${title}${description ? `\nDescription : ${description}` : ''}

Réponds UNIQUEMENT avec le mot "action" ou "information", sans ponctuation ni explication.`;

    const result = await executeLegacyPrompt({
      useCaseCode: 'AGENDA_INTELLIGENCE',
      operationCode: LEGACY_CLASSIFY_HOME_CATEGORY_OPERATION,
      accountId: ctx.accountId,
      userId: ctx.userId,
      prompt,
      maxModelAttempts: 1,
    });
    const text = result.data.trim().toLowerCase();

    if (text === 'information') return 'information';
    return 'action'; // par défaut
  } catch {
    // En cas d'erreur IA, fallback 'action' (safe default)
    return 'action';
  }
}
