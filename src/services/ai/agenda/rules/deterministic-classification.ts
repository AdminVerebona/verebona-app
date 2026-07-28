/**
 * Classification déterministe — CDC §4.4.3, étape 1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * REPRISE À L'IDENTIQUE des règles de `AgendaClassificationService.classifyByRules`.
 *
 * Ces motifs fonctionnent et couvrent la majorité des cas : les modifier serait
 * une régression fonctionnelle déguisée en refonte. Seul change ce qui doit
 * changer — l'appel modèle passe derrière la gateway et son prompt est versionné.
 *
 * Critère d'acceptation n°17 : « Aucun appel modèle n'est émis sur un cas que
 * les règles tranchent. »
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { HomeCategory, AgendaClassificationInput } from '../types';

/**
 * Motifs d'ACTION — l'utilisateur doit intervenir physiquement ou décider.
 * Évalués AVANT les motifs informatifs : une « fin de contrat de gardiennage »
 * est une action (il faut aller récupérer l'objet), pas une information.
 */
const ACTION_PATTERNS: RegExp[] = [
  /contrôle technique/i, /revision/i, /révision/i,
  /réparation/i, /reparation/i,
  /renouvellement/i,
  /rendez-vous/i, /rdv/i,
  /entretien/i,
  /intervention/i,
  /installation/i,
  /inspection/i,
  /visite/i,
  /nettoyage/i,
  /remplacement/i,
  /paiement/i, /facture/i,
  // Stockage, gardiennage, dépôt : une reprise physique est requise.
  /reprise/i, /restitution/i, /récupération/i, /recuperation/i,
  /gardiennage/i, /stockage/i, /dépôt.*pneu/i, /pneu.*dépôt/i,
  /pneu.*hiver/i, /pneu.*été/i, /pneu.*saison/i,
  /fin.*contrat.*(gardiennage|stockage|dépôt|depot|pneu)/i,
  /(gardiennage|stockage|dépôt|depot|pneu).*fin.*contrat/i,
];

/** Motifs d'INFORMATION — faits passifs, aucune action attendue. */
const INFO_PATTERNS: RegExp[] = [
  /fin de garantie/i, /garantie.*expir/i, /expir.*garantie/i,
  /fin.*(p[eé]riode|contrat).*assurance/i,
  /assurance.*fin/i, /assurance.*expir/i, /expiration.*assurance/i,
  /reconduction/i, /renouvellement.*auto/i,
  // « Achat — Vélo » est informatif, « Achat Pneus Discount → Reprise » ne l'est pas :
  // le motif d'action `reprise` a déjà tranché plus haut.
  /date d['']achat/i, /^achat\b/i,
  /fabrication/i,
  /dpe/i, /diagnostic/i,
  /décennale/i,
  /échéance.*contrat/i, /fin.*contrat/i,
];

/**
 * Retourne la catégorie si une règle tranche, `null` si le cas est réellement
 * ambigu — seul cas où un appel modèle est justifié.
 */
export function classifyByRules(input: AgendaClassificationInput): HomeCategory | null {
  // Un événement dérivé d'un champ de bien est un fait, pas une tâche.
  if (input.originType === 'asset_field') return 'information';

  const title = input.title.toLowerCase();

  for (const p of ACTION_PATTERNS) {
    if (p.test(title)) return 'action';
  }
  for (const p of INFO_PATTERNS) {
    if (p.test(title)) return 'information';
  }

  return null;
}

/** Expose les motifs pour les tests de non-régression. */
export function getClassificationPatterns(): { action: RegExp[]; information: RegExp[] } {
  return { action: ACTION_PATTERNS, information: INFO_PATTERNS };
}
