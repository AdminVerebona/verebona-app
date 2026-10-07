/**
 * Motifs d'échec DISTINCTS de T2 — ticket 8b §K, AC17 (lot 29).
 *
 * « Je n'ai rien trouvé » n'est vrai que si une recherche a réellement
 * conclu à l'absence de résultat. Chaque autre situation a son motif, tracé
 * (`CascadeTrace.diagnostic`, `retrieval_methods_json`) et sa phrase :
 *
 *   TARGET_NOT_FOUND       la désignation ne correspond à aucun objet disponible ;
 *   TARGET_AMBIGUOUS       plusieurs candidats aussi plausibles → clarification ;
 *   TARGET_UNAVAILABLE     cible de page / du fil / d'une clarification devenue
 *                          indisponible (archivée, transmise, supprimée) — ticket 14 ;
 *   FIELD_NOT_SET          cible trouvée, information non renseignée ;
 *   SEARCH_NO_RESULT       recherche effectuée, aucun résultat ;
 *   UNDERSTANDING_FAILED   demande non comprise (règles et modèle) ;
 *   TECHNICAL_READ_FAILURE erreur de lecture : tracée, jamais un faux « aucune donnée ».
 */
import { ASSET_NO_LONGER_AVAILABLE_MESSAGE } from './asset-availability';

export const T2_DIAGNOSTICS = [
  'TARGET_NOT_FOUND', 'TARGET_AMBIGUOUS', 'TARGET_UNAVAILABLE', 'FIELD_NOT_SET',
  'SEARCH_NO_RESULT', 'UNDERSTANDING_FAILED', 'TECHNICAL_READ_FAILURE',
] as const;
export type T2Diagnostic = (typeof T2_DIAGNOSTICS)[number];

const TYPES: Record<string, string> = { asset: 'le bien', equipment: 'l’équipement', room: 'la pièce' };

/** Phrase utilisateur d'un motif (jamais un code brut). */
export function diagnosticMessage(code: T2Diagnostic, ctx: { kind?: 'asset' | 'equipment' | 'room'; designation?: string | null } = {}): string {
  switch (code) {
    case 'TARGET_NOT_FOUND': {
      const quoi = TYPES[ctx.kind ?? 'asset'] ?? 'l’élément';
      const nom = ctx.designation ? ` « ${ctx.designation.trim()} »` : '';
      return `Je n’ai pas identifié ${quoi}${nom} parmi vos ${ctx.kind === 'equipment' ? 'équipements' : ctx.kind === 'room' ? 'pièces' : 'biens actifs'}. Précisez son nom tel qu’il apparaît dans Verebona.`;
    }
    case 'TARGET_AMBIGUOUS':
      return 'Plusieurs éléments correspondent à votre demande : précisez lequel.';
    case 'TARGET_UNAVAILABLE':
      return ASSET_NO_LONGER_AVAILABLE_MESSAGE;
    case 'FIELD_NOT_SET':
      return 'Cette information n’est pas renseignée.';
    case 'SEARCH_NO_RESULT':
      return 'Je n’ai rien trouvé de correspondant dans votre compte.';
    case 'UNDERSTANDING_FAILED':
      return 'Je n’ai pas compris précisément votre demande. Pouvez-vous la reformuler en nommant le bien, le document ou l’information recherchée ?';
    case 'TECHNICAL_READ_FAILURE':
      return 'Une erreur technique m’empêche de lire cette information pour le moment. Réessayez dans quelques instants.';
  }
}

/** Erreur de lecture canonique : remonte jusqu'à l'orchestrateur (jamais avalée en « aucun résultat »). */
export class TargetReadError extends Error {
  readonly code = 'TECHNICAL_READ_FAILURE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TargetReadError';
  }
}
