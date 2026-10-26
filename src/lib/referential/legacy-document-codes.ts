/**
 * Anciens codes documentaires — TABLE UNIQUE (lot 30, ticket « Référentiels »).
 *
 * Module SANS dépendance : il est lu par le catalogue métier
 * (`services/canonical/registry/catalogs.ts`) et par le résolveur
 * documentaire (`lib/referential/document-codes.ts`), qui ne doivent pas
 * s'importer l'un l'autre.
 *
 * Ces codes viennent d'anciens prompts IA, d'anciennes saisies ou d'anciens
 * seeds. Ils ne sont JAMAIS proposés à la création ; ils restent lisibles et
 * normalisés (statut LEGACY_SUPPORTED du résolveur). Ils remplacent la suite
 * de `if (code === …)` de l'ancien `resolveDocumentTypeCode()`.
 *
 * Deux natures, à ne pas confondre :
 *
 *   · ÉQUIVALENT : même nature documentaire que la cible. La cible vaut pour
 *     TOUT (colonne `document_type`, règles métier du DOCUMENT_CATALOG,
 *     correspondance V2). « FACTURE_ACHAT » est une facture.
 *
 *   · REPLI DE STOCKAGE : valeur la plus proche de l'ancien sélecteur V1, pour
 *     la seule colonne `document_type` — AUCUNE règle métier n'en découle.
 *     « TAXE_FONCIERE » rangé en « Acte / Transaction » ne fait pas d'un avis
 *     d'impôt un acte authentique (jamais autoritaire).
 */

/** Ancien code → code V1 de même nature (règles métier comprises). */
export const LEGACY_DOCUMENT_CODE_EQUIVALENTS: Readonly<Record<string, string>> = {
  PHOTO_BIEN: 'PHOTO',
  ASSURANCE: 'ATTESTATION_ASSURANCE',
  FACTURE_TRAVAUX: 'FACTURE',
  FACTURE_ACHAT: 'FACTURE',
  CONTRAT_ACHAT: 'ACTE_TRANSACTION',
  TITRE_PROPRIETE: 'ACTE_TRANSACTION',
  PEB: 'DPE',
  EXTRAIT_CADASTRAL: 'PLAN_CADASTRAL',
  CADASTRE: 'PLAN_CADASTRAL',
};

/** Ancien code → valeur V1 de rangement seulement (aucune règle métier). */
export const LEGACY_DOCUMENT_STORAGE_FALLBACKS: Readonly<Record<string, string>> = {
  REGLEMENT_COPROPRIETE: 'CONTRAT',
  CHARGES_COPROPRIETE: 'CONTRAT',
  TAXE_FONCIERE: 'ACTE_TRANSACTION',
  SURFACE_LHABITALLE: 'SURFACE_CARREZ',
};

/** Forme de comparaison d'un code documentaire (casse, espaces, tirets). */
export function normalizeDocumentCode(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const c = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
  return c || null;
}
