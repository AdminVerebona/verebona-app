/**
 * Carte #821 — CATÉGORIE DE DÉPENSE d'un achat, pour le nom de l'opération
 * (« Achat de carburant »). PUR.
 *
 * D'OÙ VIENT LA CATÉGORIE : du seul référentiel de catégories de dépense que
 * porte l'application — les catégories de DÉPENSES D'USAGE du coût de
 * possession (lot 108C : carburant, recharge électrique, péages ; « Autre »
 * n'est jamais reconnue automatiquement). Leur vocabulaire (`USAGE_LEXICON`)
 * et leurs libellés (`USAGE_BUDGET_CATEGORY_LABELS`) sont ceux du coût de
 * possession : aucune liste de mots, aucun libellé n'est ajouté ici.
 *
 * QUAND ELLE EST ÉTABLIE : quand un texte fiable de l'achat — la désignation
 * retenue par le moteur de titrage du justificatif, sinon le résumé du
 * candidat — N'EST QUE la formulation d'une catégorie (`usageCategoryOfWording`,
 * texte entier). Une désignation plus précise garde la priorité (elle nomme
 * l'achat) ; un fournisseur, un bien, un montant ne désignent jamais une
 * catégorie.
 *
 * Cette lecture NOMME seulement : elle ne change ni le type de l'opération, ni
 * son poste dans le coût de possession, ni le classement des dépenses d'usage.
 */
import { USAGE_BUDGET_CATEGORY_LABELS } from '../tco/model';
import { usageCategoryOfWording } from '../tco/usage-complement';

/** Libellé du référentiel pour le texte, s'il n'est QUE la formulation d'une catégorie de dépense ; null sinon. */
export function expenseCategoryLabelOfWording(wording: string): string | null {
  const c = usageCategoryOfWording(wording);
  return c ? USAGE_BUDGET_CATEGORY_LABELS[c] : null;
}
