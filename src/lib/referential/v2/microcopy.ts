/**
 * Textes de la mascotte et microcopies — CDC V2.0 §17.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES TEXTES SONT DANS LE RÉFÉRENTIEL, PAS DANS LES COMPOSANTS
 *
 * Le §17.1 impose « un message global en haut de l'écran ; aucun message de
 * mascotte dans chaque carte », et un texte qui « s'adapte au nombre
 * d'actions et au mode d'organisation ». Trois variables, quatre écrans : si
 * chaque composant compose sa phrase, les variantes divergent en un mois.
 *
 * ── LA CONTRAINTE QUI SE PERD EN CHEMIN ───────────────────────────────────
 *
 * §17.1, dernier alinéa : « Ne jamais mentionner l'IA, un score de confiance,
 * un prompt, un modèle ou un terme technique. » C'est la règle qu'un
 * développeur pressé enfreint sans y penser, avec un « analyse en cours » ou
 * un « confiance faible » écrit dans un état vide. La centraliser ici la rend
 * vérifiable — le test `microcopy.test.ts` balaie tous les textes.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { OrderMode } from '@/services/to-process/priority';

/** §17.2 — page « À traiter ». */
export function toProcessHeadline(count: number, mode: OrderMode): string {
  if (count === 0) return 'Rien à traiter pour le moment.';
  if (count === 1) return '1 action nécessite votre attention.';
  return mode === 'BY_PRIORITY'
    ? `${count} actions nécessitent votre attention. Les plus importantes sont affichées en premier.`
    : `${count} actions nécessitent votre attention. Les actions sont classées par type.`;
}

export const TO_PROCESS_NO_FILTER_RESULT = 'Aucune action ne correspond à ces filtres.';

/** §17.3 — pages documentaires. */
export function myDocumentsHeadline(unfiledCount: number): string {
  if (unfiledCount === 0) return 'Vos documents sont classés par rubrique.';
  return unfiledCount === 1
    ? "1 document n'a pas encore de rubrique."
    : `${unfiledCount} documents n'ont pas encore de rubrique.`;
}

export const ASSET_DOCUMENTS_HEADLINE = 'Les documents de ce bien sont classés par rubrique.';
export const NO_DOCUMENTS_HEADLINE = 'Aucun document pour le moment.';

/** §17.4 — microcopies d'action. */
export const MICROCOPY = {
  complete: 'Compléter',
  otherChoice: 'Autre',
  arbitrationToast: 'Valeur mise à jour — Annuler',
  missingType: 'Type à compléter',
  unfiledZone: 'Sans rubrique',
  notApplicable: 'Non applicable',
} as const;

/** §7.2 — libellés des natures d'action. */
export const ACTION_KIND_LABELS = {
  ARBITRATE: 'À arbitrer',
  COMPLETE: 'À compléter',
} as const;

/**
 * Vocabulaire interdit dans toute microcopie destinée à l'utilisateur
 * (§17.1). Exporté pour que le test puisse balayer les textes ci-dessus.
 */
export const FORBIDDEN_UX_TERMS: readonly string[] = [
  'IA',
  'intelligence artificielle',
  'confiance',
  'score',
  'prompt',
  'modèle',
  'pipeline',
  'algorithme',
  'analyse automatique',
];
