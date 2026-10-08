/**
 * Tables CENTRALISÉES de normalisation — lot 33D (ticket « réussite malgré
 * les désalignements », §3 et §5).
 *
 * Une seule source pour tous les traitements (T1 à T6) : une équivalence
 * n'est appliquée que si la valeur canonique figure dans l'énumération (ou
 * la clé dans l'objet) attendue À CET ENDROIT, et si elle est UNIQUE — une
 * équivalence qui désignerait deux valeurs autorisées n'est jamais appliquée
 * (aucune conversion ambiguë).
 *
 * Ajouter une ligne ici suffit : la normalisation pilotée par le schéma
 * (`normalize.ts`) la prend en compte partout, et les tests DIAG/REPAIR
 * vérifient qu'aucune équivalence n'est ambiguë.
 */

/**
 * Énumérations : valeur canonique → synonymes rencontrés dans les sorties.
 * La comparaison ignore la casse, les accents, espaces, tirets et
 * soulignés (`purchase-receipt` = `PURCHASE_RECEIPT`).
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

/**
 * Noms de champs alternatifs : clé canonique → variantes. S'ajoute à
 * l'équivalence automatique de casse et de séparateurs (`purchase_date` =
 * `purchaseDate` = `PURCHASE-DATE`), appliquée sans table.
 */
export const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  purchaseDate: ['datePurchase', 'date_achat', 'dateAchat', 'achatDate', 'date_d_achat'],
  documentDate: ['date_document', 'dateDocument', 'docDate', 'document_date_value'],
  amountCents: ['amount_in_cents', 'montantCentimes', 'montant_centimes', 'totalCents'],
  supplier: ['fournisseur', 'vendor', 'seller'],
  title: ['titre'],
  transcription: ['fullText', 'full_text', 'ocrText', 'ocr_text'],
  normalizedValue: ['normalized', 'valueNormalized', 'valeurNormalisee'],
  canonicalKey: ['fieldKey', 'field_key', 'cleCanonique'],
  canonicalUnit: ['unit', 'unite', 'unité'],
  rawValue: ['valueRaw', 'valeurBrute'],
  evidence: ['preuve', 'proof'],
  visualEvidence: ['visual_proof', 'preuveVisuelle'],
  hasExploitableContent: ['exploitable', 'hasContent', 'has_exploitable_content_flag'],
  evidenceSignals: ['signals', 'indices'],
  assetCandidate: ['candidateAsset', 'asset_candidate'],
};

/** Forme de comparaison d'un nom ou d'une valeur : sans casse, accents ni séparateurs. */
export function canon(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Valeur canonique d'une énumération pour `value`, ou `null` si aucune
 * équivalence UNIQUE n'existe parmi `allowed`. Rend aussi la règle appliquée.
 */
export function matchEnum(value: string, allowed: readonly string[]): { value: string; rule: 'enum_case' | 'enum_synonym' } | null {
  const c = canon(value);
  if (!c) return null;
  const direct = allowed.filter((a) => canon(a) === c);
  if (direct.length === 1) return { value: direct[0], rule: 'enum_case' };
  if (direct.length > 1) return null;
  const viaSynonyme = allowed.filter((a) => (ENUM_SYNONYMS[a] ?? []).some((s) => canon(s) === c));
  return viaSynonyme.length === 1 ? { value: viaSynonyme[0], rule: 'enum_synonym' } : null;
}

/**
 * Clé canonique d'un nom de champ reçu, parmi `known`, ou `null` (aucune
 * correspondance, ou plusieurs).
 */
export function matchField(received: string, known: readonly string[]): string | null {
  const c = canon(received);
  const direct = known.filter((k) => canon(k) === c);
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return null;
  const viaAlias = known.filter((k) => (FIELD_ALIASES[k] ?? []).some((a) => canon(a) === c));
  return viaAlias.length === 1 ? viaAlias[0] : null;
}
