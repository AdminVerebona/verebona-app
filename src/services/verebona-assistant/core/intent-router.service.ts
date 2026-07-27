/**
 * Routeur d'intentions — CDC §9.1 à §9.5.
 *
 * Ordre STRICT (§9.4). Gemini (classification) n'est sollicité qu'en dernier recours,
 * si les étapes déterministes n'ont pas tranché. Produit un `IntentRoute` (§9.5).
 *
 * Ce service ne fait AUCUN appel réseau lui-même : l'étape de classification IA est
 * déléguée à l'orchestrateur (qui contrôle le budget et l'éligibilité).
 */
import type { IntentRoute, Confidence } from '../types/contracts';
import type { VerebonaIntent } from '../types/intents';
import { isPlanAiEligible } from '../registries/capability-registry';
import { getIntentDefinition } from '../registries/intent-registry';
import { allowedActionsFor } from '../registries/action-registry';

export interface RouteContext {
  message: string;
  planType: string;
  hasPendingClarification: boolean;
  pageRoute?: string;
}

/** Résultat du routage déterministe : soit une route, soit « escalade classification ». */
export type RouteOutcome =
  | { kind: 'route'; route: IntentRoute }
  | { kind: 'needs_classification'; normalized: string };

const GREETINGS = /^(bonjour|bonsoir|salut|coucou|hello|hey|yo)\b/i;
const THANKS = /\b(merci|thanks|nickel|parfait|super)\b/i;
const GOODBYE = /\b(au revoir|à bientôt|bye|à plus|adieu)\b/i;
const OPEN_VERB = /\b(ouvre|ouvrir|montre|affiche|va sur|accède|accéder|emmène[- ]moi)\b/i;
const HELP_HOWTO = /\b(comment|comment faire|comment je|how to)\b/i;
const HELP_EXPLAIN = /\b(à quoi sert|c'est quoi|qu'est[- ]ce que|que veut dire|signifie)\b/i;
const COUNT = /\b(combien|nombre de|count)\b/i;
const DEADLINE = /\b(échéance|expire|expiration|à renouveler|renouvellement|quand)\b/i;
const EXPORT = /\b(export|exporter|dossier|pdf|transmettre)\b/i;
const SUPPLIER = /\b(fournisseur|prestataire|artisan|réparateur)\b/i;
const AGENDA = /\b(agenda|rendez[- ]vous|planning|calendrier)\b/i;
const DOC = /\b(document|facture|garantie|contrat|manuel|notice|certificat)\b/i;
const SUMMARY = /\b(résume|résumé|synthèse|fais le point|bilan|panorama)\b/i;
const COMPARE = /\b(compare|comparer|différence|versus|par rapport)\b/i;
const TIMELINE = /\b(historique|chronologie|timeline|au fil du temps|évolution)\b/i;
const UNSAFE = /\b(ignore (les|tes) instructions|system prompt|jailbreak|drop table|<script)/i;

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ').slice(0, 2000);
}

function buildRoute(
  intent: VerebonaIntent,
  confidence: Confidence,
  planType: string,
  reason: string,
  requiresRetrieval?: boolean,
): IntentRoute {
  const def = getIntentDefinition(intent);
  return {
    intent,
    confidence,
    accountScope: 'server-enforced', // le vrai account_id est injecté serveur (§13.2)
    entityHints: [],
    requiresRetrieval: requiresRetrieval ?? def.requiresRetrieval,
    aiEligible: def.geminiEligible && isPlanAiEligible(planType),
    clarificationRequired: false,
    allowedActionTypes: allowedActionsFor(intent),
    routeReason: reason,
  };
}

/**
 * Routage déterministe. Retourne une route directe ou signale une classification IA.
 */
export function routeDeterministic(ctx: RouteContext): RouteOutcome {
  const msg = normalize(ctx.message);
  const R = (i: VerebonaIntent, c: Confidence, reason: string, rr?: boolean): RouteOutcome => ({
    kind: 'route',
    route: buildRoute(i, c, ctx.planType, reason, rr),
  });

  // Étape 1 — Sécurité / anti-injection (§9.4.1, §29.2)
  if (UNSAFE.test(msg)) return R('UNSAFE_OR_MALICIOUS', 'exact', 'motif malveillant détecté');

  // Étape 2 — Réponse à une clarification en attente (§9.4.2)
  if (ctx.hasPendingClarification) return R('CLARIFICATION_ANSWER', 'exact', 'clarification en attente');

  // Étape 3 — Politesses (§9.4.3)
  if (GREETINGS.test(msg)) return R('GREETING', 'exact', 'salutation');
  if (GOODBYE.test(msg)) return R('GOODBYE', 'exact', 'fin déchange');
  if (THANKS.test(msg) && msg.length < 40) return R('THANKS', 'exact', 'remerciement');

  // Étape 4 — Aide produit (§9.4.4)
  if (HELP_EXPLAIN.test(msg)) return R('PRODUCT_HELP_EXPLAIN', 'probable', 'explication fonction');
  if (HELP_HOWTO.test(msg) && !DOC.test(msg)) return R('PRODUCT_HELP_HOW_TO', 'probable', 'how-to produit');

  // Étape 5 — Navigation explicite (§9.4.5)
  if (OPEN_VERB.test(msg)) return R('NAVIGATION_OPEN', 'probable', 'verbe douverture');

  // Étape 6 — Intentions « données » déterministes (§9.4.6)
  if (COUNT.test(msg)) return R('ACCOUNT_TO_PROCESS', 'probable', 'comptage', true);
  if (EXPORT.test(msg)) return R('EXPORT_HELP', 'probable', 'aide export');

  // Étape 7 — Synthèse / comparaison / chronologie (candidats IA — §9.4.7)
  if (SUMMARY.test(msg)) return R('ACCOUNT_SUMMARY', 'probable', 'synthèse', true);
  if (COMPARE.test(msg)) return R('ACCOUNT_COMPARISON', 'probable', 'comparaison', true);
  if (TIMELINE.test(msg)) return R('ACCOUNT_TIMELINE', 'probable', 'chronologie', true);

  // Étape 8 — Recherche compte par type d'objet (§9.4.8)
  if (SUPPLIER.test(msg)) return R('ACCOUNT_SEARCH_SUPPLIER', 'probable', 'recherche fournisseur', true);
  if (AGENDA.test(msg) || DEADLINE.test(msg)) return R('ACCOUNT_SEARCH_AGENDA', 'probable', 'recherche agenda', true);
  if (DOC.test(msg)) return R('ACCOUNT_SEARCH_DOCUMENT', 'probable', 'recherche document', true);

  // Étape 9 — Escalade classification IA (dernier recours — §9.4.9)
  return { kind: 'needs_classification', normalized: msg };
}
