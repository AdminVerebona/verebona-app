/**
 * « Pourquoi ? » : règle ou calcul appliqué, et limites — CDC §19.8.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE « POURQUOI ? » NE MONTRAIT QUE LES AFFIRMATIONS
 *
 * La route d'explication rendait chaque affirmation, sa nature (lu, calculé,
 * synthétisé) et ses sources. Le §19.8 demande aussi la RÈGLE ou le CALCUL
 * qui a produit la réponse, et ses LIMITES (sources insuffisantes,
 * contradiction, document en analyse, résultats partiels…).
 *
 * Tout est déjà tracé par la cascade (`verebona_request_runs.
 * retrieval_methods_json` : stratégie, motifs d'escalade, suffisance) et par
 * le message (`support_level`). Ce module traduit ces codes internes en
 * phrases courtes — jamais le raisonnement interne ni un code brut (§19.8).
 * ══════════════════════════════════════════════════════════════════════════
 */

export interface ExplanationTrace {
  strategy?: string | null;
  answeredBy?: string | null;
  sufficiency?: string | null;
  escalationReasons?: string[] | null;
}

export interface ExplanationDetails {
  /** Règle ou calcul appliqué, en une phrase ; `null` si inconnu. */
  rule: string | null;
  /** Limites et contradictions, dédoublonnées. */
  limits: string[];
}

/** Règle par stratégie exacte, puis par préfixe (du plus long au plus court). */
const REGLES: ReadonlyArray<[string, string]> = [
  ['structured.count_documents', 'Calcul : nombre de documents enregistrés dans votre compte pour le périmètre demandé.'],
  ['structured.count_assets', 'Calcul : nombre de biens enregistrés dans votre compte.'],
  ['structured.count_agenda', 'Calcul : nombre d’échéances à venir enregistrées dans votre agenda.'],
  ['structured.sum_amounts', 'Calcul : somme des montants des documents concernés.'],
  ['structured.next_deadline', 'Règle : échéances à venir triées par date, la plus proche en premier.'],
  ['structured.deadline_of', 'Règle : date de l’échéance correspondante lue dans votre agenda.'],
  ['structured.purchase_date', 'Lecture directe de la date d’achat enregistrée sur la fiche du bien.'],
  ['structured.list_', 'Règle : liste des éléments enregistrés qui correspondent à la demande.'],
  ['structured.document_status', 'Lecture du statut d’analyse enregistré pour le document.'],
  ['structured.plan_limit', 'Règle : fonctions incluses dans votre offre.'],
  ['structured.exports', 'Règle : liste des exports et dossiers générés pour vos biens.'],
  ['retrieval.t1_fact', 'Lecture d’une information extraite de vos documents.'],
  ['retrieval.t1_table', 'Lecture d’une cellule de tableau (ligne et colonne) dans un document.'],
  ['retrieval.document_status', 'Lecture du statut d’analyse du document trouvé.'],
  ['retrieval.near', 'Recherche élargie (orthographe proche) après une recherche sans résultat.'],
  ['retrieval.', 'Recherche dans vos biens, documents, échéances et fournisseurs, classée par pertinence.'],
  ['help.', 'Article du Centre d’aide Verebona.'],
  ['llm.', 'Réponse rédigée uniquement à partir des sources affichées.'],
  ['reference.', 'Élément désigné dans la conversation, revérifié dans votre compte.'],
  ['template.', 'Réponse type de l’application.'],
  ['clarification.', 'Plusieurs éléments correspondaient : une précision a été demandée.'],
  ['command.', 'Aperçu d’une action, exécutée seulement après votre confirmation.'],
  ['timeout.', 'Recherche interrompue par le délai de réponse.'],
  ['fallback.', 'Aucune réponse exacte : les éléments les plus proches sont listés.'],
];

/** Limites par motif d'escalade (préfixe). */
const LIMITES: ReadonlyArray<[string, string]> = [
  ['TIMEOUT:PARTIAL_RESULTS', 'La recherche a été interrompue : les résultats peuvent être incomplets.'],
  ['DOCUMENT:IN_ANALYSIS', 'Un document est encore en cours d’analyse : certaines informations ne sont pas encore lisibles.'],
  ['DOCUMENT:ANALYSIS_FAILED', 'L’analyse automatique d’un document n’a pas abouti.'],
  ['DOCUMENT:FOUND_WITHOUT_INFO', 'Le document trouvé ne contient pas l’information demandée.'],
  ['PLAN_LIMIT:', 'Les réponses rédigées ne sont pas incluses dans votre offre actuelle.'],
  ['AI_MONTHLY_BUDGET_EXCEEDED', 'Réponse construite sans rédaction automatique (plafond mensuel atteint).'],
  ['N3:AI_BUDGET_EXHAUSTED', 'Réponse construite sans rédaction automatique.'],
  ['N3:AI_BLOCKED', 'Réponse construite sans rédaction automatique (service momentanément indisponible).'],
  ['N3:GENERATION_UNAVAILABLE', 'Réponse construite sans rédaction automatique (service momentanément indisponible).'],
  ['REVALIDATION:', 'Une information a été revérifiée dans le document source.'],
  ['HELP_CONTRADICTION:', 'Deux articles d’aide se contredisent : aucun n’a été retenu.'],
];

function premiere(table: ReadonlyArray<[string, string]>, code: string): string | null {
  for (const [prefixe, texte] of table) if (code === prefixe || code.startsWith(prefixe)) return texte;
  return null;
}

/**
 * Règle et limites d'une réponse, à partir de sa trace et de son niveau de
 * soutien. Ne lève jamais ; une trace absente donne `{ rule: null, limits }`.
 */
export function explanationDetails(
  trace: ExplanationTrace | null | undefined,
  supportLevel: string | null | undefined,
): ExplanationDetails {
  const limits: string[] = [];
  const ajoute = (t: string | null) => { if (t && !limits.includes(t)) limits.push(t); };

  if (supportLevel === 'conflicting' || trace?.sufficiency === 'CONFLICTING') {
    ajoute('Les sources se contredisent : les valeurs divergentes sont indiquées dans la réponse, sans arbitrage.');
  }
  if (supportLevel === 'insufficient' || supportLevel === 'partial') {
    ajoute('Les sources disponibles ne suffisent pas à répondre complètement.');
  }
  for (const motif of trace?.escalationReasons ?? []) ajoute(premiere(LIMITES, String(motif)));

  const strategy = trace?.strategy ? String(trace.strategy) : '';
  return { rule: strategy ? premiere(REGLES, strategy) : null, limits };
}
