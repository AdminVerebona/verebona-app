/**
 * Carte #813 — un BON DE COMMANDE prouve la commande, jamais la réalisation.
 *
 * Règles PURES, lues dans le référentiel EXISTANT (`DOCUMENT_CATALOG`) : un
 * type documentaire dont une forme de preuve est « COMMANDE — non prouvé »
 * (« Une commande n'établit ni la livraison ni l'exécution ») est une pièce de
 * commande. Aucune liste de types n'est recopiée ici : ajouter un alias au
 * catalogue suffit.
 *
 * Trois consommateurs, une seule définition :
 *   · T1 (`operation-candidates/prepare.ts`) : un achat lu sur une pièce de
 *     commande n'est pas « réalisé » du seul fait du rôle proposé par le
 *     modèle (rôle et montants inchangés : coût de possession intact) ;
 *   · T3 (`consolidation/model.ts`) : même règle sur les candidats DÉJÀ
 *     persistés (stock), sans nouvelle analyse ;
 *   · T4 (`agenda-projection`) et date de présentation : codes des types de
 *     commande, pour reconnaître les preuves qui ne sont que des commandes.
 *
 * Le code donne ce résultat SANS le bloc de prompt facultatif (étape 60).
 */
import { DOCUMENT_CATALOG, resolveDocumentType } from './catalogs';

/** Code de la forme de preuve « commande » du référentiel (`SANS_PREUVE('COMMANDE', …)`). */
const ORDER_PROOF_CODE = 'COMMANDE';

const estCommande = (e: { completionProofs: ReadonlyArray<{ code: string; establishes: string }> } | undefined): boolean =>
  !!e && e.completionProofs.some((p) => p.code === ORDER_PROOF_CODE && p.establishes === 'not_proven');

/** Le type documentaire est-il une pièce de COMMANDE (référentiel) ? Type inconnu ou absent : non. */
export function isOrderDocumentType(code: string | null | undefined): boolean {
  return estCommande(resolveDocumentType(code));
}

/** Rôles de source qui n'établissent rien de plus que le document lui-même : absent, « facture », « autre preuve ». */
const ROLES_SANS_PREUVE_PROPRE: ReadonlySet<string> = new Set(['INVOICE', 'OTHER_EVIDENCE']);

/**
 * Un achat lu sur ce document est-il une COMMANDE SANS PREUVE DE RÉALISATION (pur) ? Oui quand le document
 * est une pièce de commande du référentiel, que le rôle de source proposé est absent, « facture » ou
 * « autre preuve », et qu'aucun paiement n'y est lu (`paid`). Un devis, une commande déclarée (règles
 * QUOTE / ORDER existantes), une preuve de paiement, un acompte, un avoir ou un document contractuel
 * gardent leurs règles : non.
 */
export function isOrderEvidenceWithoutRealization(role: string | null, documentTypeCode: string | null | undefined, paid: boolean): boolean {
  return !paid && isOrderDocumentType(documentTypeCode) && (role === null || ROLES_SANS_PREUVE_PROPRE.has(role));
}

/**
 * Codes (majuscules) des types documentaires de commande du référentiel :
 * code canonique et alias. Constantes du code (jamais une valeur
 * d'utilisateur) : utilisables dans une requête SQL en paramètre de tableau.
 */
export function orderDocumentTypeCodes(): string[] {
  const out = new Set<string>();
  for (const e of DOCUMENT_CATALOG) {
    if (!estCommande(e)) continue;
    out.add(e.code.toUpperCase());
    for (const a of e.aliases ?? []) out.add(a.toUpperCase());
  }
  return [...out].filter((c) => /^[A-Z0-9_]+$/.test(c)).sort();
}
