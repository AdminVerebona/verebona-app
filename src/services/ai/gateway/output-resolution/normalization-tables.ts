/**
 * Table CENTRALISÉE des équivalences d'énumération — lot 33D, revue au lot
 * 34D (ticket « contrat runtime source unique de vérité »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 34D — AUCUN RAPPROCHEMENT HEURISTIQUE
 *
 * Le lot 33D rapprochait les noms de champs « proches » (casse, accents,
 * séparateurs : `purchase_date` = `purchaseDate` = `PURCHASE-DATE`, plus une
 * table d'alias génériques `datePurchase`, `date_achat`…) et les valeurs
 * d'énumération sans séparateurs (`purchase-receipt` = `PURCHASE_RECEIPT`).
 * C'est RETIRÉ : un nom de champ inconnu n'est jamais deviné (passe de
 * réparation avec le contrat exact), et une valeur d'énumération n'est
 * remplacée que par :
 *   · la normalisation SÛRE de casse seule (`invoice` → `INVOICE` : même
 *     valeur, casse différente — jamais une autre valeur) ;
 *   · une équivalence EXPLICITE de cette table (`PURCHASE_RECEIPT` →
 *     `RECEIPT`), versionnée (`COMPAT_TABLE_VERSION`), testée, appliquée
 *     seulement à l'étape « mappings de compatibilité » (après un premier
 *     échec de validation) et consignée `compat_mapping`.
 * Les renommages de champs explicites (path, version source → cible) sont
 * dans `compat-mappings.ts`.
 *
 * Une équivalence n'est appliquée que si la valeur canonique figure dans
 * l'énumération attendue À CET ENDROIT et si elle est UNIQUE (aucune
 * conversion ambiguë — tests REPAIR-15).
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * Énumérations : valeur canonique → équivalences EXPLICITES (table de
 * compatibilité, version `COMPAT_TABLE_VERSION` de `compat-mappings.ts`).
 * Comparaison à la casse près SEULEMENT : `purchase-receipt` n'est PAS
 * `PURCHASE_RECEIPT` (lot 34D). Ajouter une équivalence = ajouter une ligne
 * ici, incrémenter `COMPAT_TABLE_VERSION` et compléter les tests RTC/REPAIR.
 */
export const ENUM_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  // Types documentaires (exemple du ticket : PURCHASE_RECEIPT → RECEIPT).
  RECEIPT: ['PURCHASE_RECEIPT', 'SALES_RECEIPT', 'TICKET', 'TICKET_DE_CAISSE', 'CASH_RECEIPT'],
  INVOICE: ['FACTURE', 'BILL'],
  CONTRACT: ['CONTRAT', 'AGREEMENT'],
  OTHER: ['AUTRE', 'MISC', 'UNKNOWN_TYPE'],
  // Confiance qualitative (U11). « low » n'a pas d'équivalent plus bas que
  // `probable` : c'est la valeur la plus prudente du contrat.
  certain: ['high', 'sure', 'certaine', 'very_high', 'confirmed'],
  probable: ['medium', 'likely', 'moderate', 'low', 'uncertain', 'probable_reading'],
  conflictual: ['conflicting', 'conflict', 'contradictory', 'conflictuel', 'conflictuelle'],
  // Cibles d'un fait (U7).
  ASSET: ['BIEN', 'PROPERTY', 'VEHICLE_ASSET'],
  EQUIPMENT: ['EQUIPEMENT', 'ÉQUIPEMENT', 'DEVICE', 'APPLIANCE'],
  ROOM: ['PIECE', 'PIÈCE', 'SPACE'],
  SUPPLIER: ['FOURNISSEUR', 'VENDOR', 'SELLER', 'PROVIDER'],
  DOCUMENT: ['DOC', 'SOURCE_DOCUMENT'],
  GENERIC: ['GENERIQUE', 'GÉNÉRIQUE', 'GENERAL', 'UNKNOWN_TARGET'],
  // Provenance (U2).
  TEXT_EXTRACTION: ['TEXT', 'TEXTUAL', 'OCR', 'EXTRACTION', 'TEXT_EXTRACT'],
  VISUAL_ANALYSIS: ['VISUAL', 'IMAGE', 'VISION', 'VISUAL_OBSERVATION'],
  // Nature temporelle (U13).
  HISTORICAL: ['PAST', 'DONE', 'COMPLETED', 'HISTORIQUE', 'REALISE', 'RÉALISÉ'],
  DEADLINE: ['FUTURE', 'DUE', 'UPCOMING', 'ECHEANCE', 'ÉCHÉANCE'],
  FACT_ONLY: ['FACT', 'INFO', 'INFORMATION'],
  // Récurrence (U12).
  yearly: ['annual', 'annually', 'annuel', 'annuelle', 'every_year'],
  monthly: ['mensuel', 'mensuelle', 'every_month'],
  weekly: ['hebdomadaire', 'every_week'],
  daily: ['quotidien', 'quotidienne', 'every_day'],
  // Types de valeur (FIELD_CATALOG, cellules de tableau).
  number: ['integer', 'int', 'float', 'decimal', 'numeric'],
  boolean: ['bool'],
  string: ['str'],
  // Cellule de tableau : `text` quand `string` n'est pas autorisé à cet endroit.
  text: ['string', 'str', 'texte'],
  amount: ['money', 'currency', 'price', 'montant'],
};

/** Forme de comparaison SÛRE d'une valeur d'énumération : casse et espaces de bord seulement. */
export function caseFold(s: string): string {
  return s.trim().toUpperCase();
}

/**
 * Valeur canonique d'une énumération pour `value`, ou `null` si aucune
 * équivalence UNIQUE n'existe parmi `allowed`. Rend aussi la règle appliquée.
 *
 *   · `enum_case` : même valeur à la casse près (normalisation sûre) ;
 *   · `enum_synonym` : équivalence EXPLICITE de `ENUM_SYNONYMS`, seulement
 *     si `synonyms` est demandé (étape « mappings de compatibilité »).
 * Jamais de rapprochement par ressemblance (séparateurs, accents, préfixes).
 */
export function matchEnum(
  value: string, allowed: readonly string[], opts: { synonyms?: boolean } = {},
): { value: string; rule: 'enum_case' | 'enum_synonym' } | null {
  const c = caseFold(value);
  if (!c) return null;
  const direct = allowed.filter((a) => caseFold(a) === c);
  if (direct.length === 1) return { value: direct[0], rule: 'enum_case' };
  if (direct.length > 1 || !opts.synonyms) return null;
  const viaSynonyme = allowed.filter((a) => (ENUM_SYNONYMS[a] ?? []).some((s) => caseFold(s) === c));
  return viaSynonyme.length === 1 ? { value: viaSynonyme[0], rule: 'enum_synonym' } : null;
}
