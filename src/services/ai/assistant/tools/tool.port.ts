/**
 * Contrat des outils de lecture — CDC Assistant §4.3.4.
 *
 * « L'assistant doit disposer d'outils serveur en lecture seule. Le modèle
 *   sélectionne des outils, il ne reçoit jamais une sérialisation du compte. »
 *
 * TROIS INVARIANTS, tenus par le typage et vérifiés par les tests :
 *
 *  1. LECTURE SEULE — aucun outil n'expose d'écriture. Le type de retour ne
 *     permet pas d'exprimer une mutation.
 *  2. BORNÉ AU COMPTE — `accountId` est obligatoire, et le filtre SQL
 *     correspondant est vérifié par le registre au chargement.
 *  3. SOURCÉ — tout élément renvoyé porte une référence vérifiable, faute de
 *     quoi il ne pourra pas être cité dans la réponse (§4.3.6).
 */

/** Référence d'une source citable, revalidée avant affichage. */
export interface SourceRef {
  type: 'document' | 'web_link' | 'asset' | 'agenda' | 'equipment' | 'supplier' | 'field_evidence';
  id: number;
  label: string;
  /** Extrait littéral, plafonné avant transmission au modèle. */
  excerpt?: string;
  page?: number;
}

export interface ToolResult<T = unknown> {
  data: T;
  sources: SourceRef[];
  /** true si le résultat a été tronqué par les plafonds du §31.2. */
  truncated: boolean;
}

export interface ToolContext {
  /** Périmètre absolu : aucun outil ne peut lire hors de ce compte. */
  accountId: number;
  userId: number;
  /** Plafond de résultats, dérivé du budget par demande (§31.2). */
  maxResults: number;
}

export interface AssistantTool<P = Record<string, unknown>, R = unknown> {
  readonly name: string;
  readonly description: string;
  /** Schéma des paramètres, exposé au modèle pour la sélection d'outils. */
  readonly parameters: Record<string, string>;
  execute(params: P, ctx: ToolContext): Promise<ToolResult<R>>;
}

/**
 * Plafonds du CDC Assistant §31.2. Centralisés : un dépassement ne doit jamais
 * dépendre de la vigilance de l'auteur d'un outil.
 */
export const ASSISTANT_LIMITS = {
  maxSourcesRetrieved: 8,
  maxSourcesDisplayed: 5,
  maxExcerptChars: 1500,
  maxDisplayedExcerptChars: 240,
  maxAiCallsPerMessage: 2,
  maxInputTokens: 12_000,
  maxOutputTokens: 500,
} as const;

/** Tronque un extrait avant transmission au modèle. */
export function clampExcerpt(
  text: string | null | undefined,
  max: number = ASSISTANT_LIMITS.maxExcerptChars,
): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
