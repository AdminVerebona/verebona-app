/**
 * RÉSOLVEUR DOCUMENTAIRE UNIQUE — lot 30 (ticket « Référentiels », §C à §F, §L).
 *
 * Un code documentaire peut arriver sous cinq formes : code V2
 * (`ACQUISITION_INVOICE`), code V1 de la colonne historique `document_type`
 * (`FACTURE`), code ou alias du catalogue métier (`CONTRAT_ASSURANCE`,
 * `CARTE_GRISE`), ancien code de base ou d'IA (`FACTURE_ACHAT`, `PEB`,
 * `TAXE_FONCIERE`). T1, T2, T4, les API et les exports en obtiennent ici UNE
 * représentation déterministe :
 *
 *   · type V2 et sa Rubrique (si la correspondance est certaine) ;
 *   · type métier canonique (`DOCUMENT_CATALOG`) — autorité, agenda, preuves ;
 *   · code V1 de rangement (colonne `document_type`) ;
 *   · statut ACTIVE / LEGACY_SUPPORTED / UNKNOWN.
 *
 * ORDRE DE RÉSOLUTION (documenté dans `docs/exploitation/referentiels.md`) :
 *   0. normalisation (casse, espaces, tirets → `_`) ;
 *   1. code V2 (`DOCUMENT_TYPES`) ............................ ACTIVE
 *   2. code V1 (`DOCUMENT_TYPE_LIST`) ......... ACTIVE (sélecteur) ou LEGACY
 *   3. code ou alias du `DOCUMENT_CATALOG` .................... LEGACY
 *   4. ancien code équivalent / repli de stockage / correspondance V1 → V2
 *      certaine (`legacy-mapping`) ............................ LEGACY
 *   5. sinon .................................................. UNKNOWN
 * La facette « règles métier » est TOUJOURS `resolveDocumentType()` du
 * catalogue (même chaîne, voir `catalogs.ts`) : un code inconnu n'est jamais
 * autoritaire. `document_taxonomy_mappings` (libellés bruts IA administrés en
 * BO) n'intervient pas dans cette résolution : il est affiché seulement.
 *
 * Module PUR (aucun accès base) : importable côté client.
 */
import { DOCUMENT_TYPES } from './v2/document-types';
import { RUBRICS } from './v2/rubrics';
import { resolveLegacyType, type LegacyVerdict } from './v2/legacy-mapping';
import type { DocumentTypeDefinition, RubricCode } from './v2/types';
import {
  LEGACY_DOCUMENT_CODE_EQUIVALENTS, LEGACY_DOCUMENT_STORAGE_FALLBACKS, normalizeDocumentCode,
} from './legacy-document-codes';
import { DOCUMENT_TYPE_LIST, type DocumentTypeOption } from '@/lib/document-type-constants';
import { DOCUMENT_CATALOG, resolveDocumentType } from '@/services/canonical/registry/catalogs';
import type { DocumentCatalogEntry } from '@/services/canonical/registry/types';

export { normalizeDocumentCode } from './legacy-document-codes';

/** Statut d'un code (ticket §L) : proposé à la création, ancien mais lisible, inconnu. */
export type DocumentCodeStatus = 'ACTIVE' | 'LEGACY_SUPPORTED' | 'UNKNOWN';

/** Source qui a reconnu le code (étape de l'ordre de résolution). */
export type DocumentCodeOrigin = 'V2_TYPE' | 'V1_TYPE' | 'CATALOG' | 'LEGACY_CODE' | 'NONE';

export interface DocumentCodeResolution {
  /** Code normalisé (`null` si vide). */
  code: string | null;
  status: DocumentCodeStatus;
  origin: DocumentCodeOrigin;
  /** Type V2, si le code en est un ou s'il y correspond de façon certaine. */
  v2Type: string | null;
  /** Rubrique du type V2 (déduite, §2.2). */
  rubric: RubricCode | null;
  /** Correspondance V1 → V2 (`legacy-mapping`) pour un ancien code ; `null` pour un code V2. */
  v2Verdict: LegacyVerdict | null;
  /** Type métier canonique (`DOCUMENT_CATALOG`) — `null` : aucune règle métier. */
  catalogCode: string | null;
  /** Le type peut-il créer un fait ou un événement sans validation ? Jamais pour un inconnu. */
  authoritative: boolean;
  /** Code V1 de la colonne `document_type` (`null` : aucun). */
  storageCode: string | null;
  /** Libellé affichable (V2, V1, puis catalogue) ; `null` pour un inconnu. */
  label: string | null;
  /** Type V2 que l'IA peut proposer (jamais un type « Autre », DOC-08). */
  aiSelectable: boolean;
}

/* ── Index (paresseux : pas de travail à l'import, pas de cycle) ─────────── */

interface Index {
  v2: Map<string, DocumentTypeDefinition>;
  v1: Map<string, DocumentTypeOption>;
  rubrics: Set<string>;
}
let index: Index | null = null;
function idx(): Index {
  index ??= {
    v2: new Map(DOCUMENT_TYPES.map((t) => [t.code, t])),
    v1: new Map(DOCUMENT_TYPE_LIST.map((t) => [t.code, t])),
    rubrics: new Set(RUBRICS.map((r) => r.code)),
  };
  return index;
}

const CATALOG_KEYS = (): Set<string> => new Set(DOCUMENT_CATALOG.flatMap((d) => [d.code, ...(d.aliases ?? [])]));
let catalogKeys: Set<string> | null = null;

/** Code V1 de rangement d'un code (V1 lui-même, ancien équivalent, repli). */
function storageCodeOf(code: string): string | null {
  const { v1 } = idx();
  if (v1.has(code)) return code;
  const cible = LEGACY_DOCUMENT_CODE_EQUIVALENTS[code] ?? LEGACY_DOCUMENT_STORAGE_FALLBACKS[code];
  return cible && v1.has(cible) ? cible : null;
}

/**
 * Résolution unique d'un code documentaire (pure, déterministe, testée).
 * Voir l'ordre en tête de module.
 */
export function resolveDocumentCode(raw: string | null | undefined): DocumentCodeResolution {
  const code = normalizeDocumentCode(raw);
  const vide: DocumentCodeResolution = {
    code, status: 'UNKNOWN', origin: 'NONE', v2Type: null, rubric: null, v2Verdict: null,
    catalogCode: null, authoritative: false, storageCode: null, label: null, aiSelectable: false,
  };
  if (!code) return vide;
  const { v2, v1 } = idx();
  const entry: DocumentCatalogEntry | undefined = resolveDocumentType(code);
  const metier = {
    catalogCode: entry?.code ?? null,
    authoritative: entry?.authority === 'AUTHORITATIVE',
    storageCode: storageCodeOf(code),
  };

  // 1. Type V2 : actif par construction (le référentiel V2 est la taxonomie produit).
  const t2 = v2.get(code);
  if (t2) {
    return {
      ...vide, ...metier, status: 'ACTIVE', origin: 'V2_TYPE', v2Type: t2.code, rubric: t2.rubric,
      label: t2.label, aiSelectable: !t2.userOnly,
    };
  }

  // Correspondance V2 d'un ancien code (V1, catalogue, ancien code).
  const legacy = resolveLegacyType({ typeCode: LEGACY_DOCUMENT_CODE_EQUIVALENTS[code] ?? code, userSelected: false });
  const mapped = legacy.verdict === 'MAPPED' && legacy.typeCode ? v2.get(legacy.typeCode) : undefined;
  const versV2 = {
    v2Verdict: legacy.verdict,
    v2Type: mapped?.code ?? null,
    rubric: mapped?.rubric ?? null,
  };

  // 2. Code V1 : actif s'il est proposé par le sélecteur V1, sinon ancien.
  const t1 = v1.get(code);
  if (t1) {
    return {
      ...vide, ...metier, ...versV2, status: t1.hideFromPicker ? 'LEGACY_SUPPORTED' : 'ACTIVE', origin: 'V1_TYPE',
      label: t1.label,
    };
  }

  // 3. Code ou alias du catalogue métier (anciens codes de l'IA).
  catalogKeys ??= CATALOG_KEYS();
  if (catalogKeys.has(code) && entry) {
    return { ...vide, ...metier, ...versV2, status: 'LEGACY_SUPPORTED', origin: 'CATALOG', label: entry.label };
  }

  // 4. Ancien code : équivalent, repli de stockage ou correspondance V2 certaine.
  if (metier.storageCode || mapped || entry) {
    const label = (metier.storageCode ? v1.get(metier.storageCode)?.label : undefined) ?? mapped?.label ?? entry?.label ?? null;
    return { ...vide, ...metier, ...versV2, status: 'LEGACY_SUPPORTED', origin: 'LEGACY_CODE', label };
  }

  // 5. Inconnu : explicitement inconnu, jamais autoritaire.
  return vide;
}

/**
 * Code V1 valide pour la colonne `document_type` (ancien `resolveDocumentTypeCode`
 * de `document-type-constants`) : le code V1 de rangement, sinon `AUTRE`.
 */
export function resolveDocumentTypeCode(code: string | null | undefined): string {
  return resolveDocumentCode(code).storageCode ?? 'AUTRE';
}

/** Libellé affichable d'un code documentaire, repli sur le code brut (jamais vide si un code est fourni). */
export function documentCodeLabel(code: string | null | undefined): string {
  const r = resolveDocumentCode(code);
  return r.label ?? (code ? String(code) : '');
}

/** Code V1 EXACT acceptable pour la colonne `document_type` (écritures API ; aucune normalisation). */
export function isKnownStorageDocumentCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && idx().v1.has(code);
}

/** Types V1 proposés par le sélecteur (dérivés de la liste V1 : ni formats ni codes CIL fins). */
export function pickerDocumentTypes(): DocumentTypeOption[] {
  return DOCUMENT_TYPE_LIST.filter((t) => !t.hideFromPicker);
}

/* ── Vocabulaire des types documentaires (assistant, recherche) ─────────── */

const plainT = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Codes documentaires désignés par un mot (« facture », « devis ») — pure :
 * catalogue métier (code, libellé, alias), référentiel V2 (code, libellé) et
 * types V1 (code, libellé). Tous en MAJUSCULES, triés. Source unique du
 * filtre « type demandé » de l'assistant (ancien `documentTypeCodesFor`).
 */
export function documentCodesMatchingWord(word: string): string[] {
  const s = plainT(word);
  if (!s) return [];
  const sing = (w: string) => w.replace(/s$/, '');
  const contient = (texte: string) => plainT(texte).split(' ').some((w) => w === s || sing(w) === sing(s));
  const codes = new Set<string>();
  for (const d of DOCUMENT_CATALOG) {
    const alias = d.aliases ?? [];
    if (contient(d.label) || contient(d.code.replace(/_/g, ' ')) || alias.some((a) => contient(a.replace(/_/g, ' ')))) {
      codes.add(d.code.toUpperCase());
      for (const a of alias) codes.add(a.toUpperCase());
    }
  }
  for (const t of DOCUMENT_TYPES) if (contient(t.label) || contient(t.code.replace(/_/g, ' '))) codes.add(t.code.toUpperCase());
  for (const t of DOCUMENT_TYPE_LIST) if (contient(t.label) || contient(t.code.replace(/_/g, ' '))) codes.add(t.code.toUpperCase());
  return [...codes].sort();
}

/**
 * Mots par lesquels un utilisateur désigne un TYPE de document dans une
 * question (« retrouve une facture »), sans accent, au singulier. Déclarés
 * UNE fois, ici, à côté des types (lot 30 — ancien `DOCUMENT_TYPE_STEMS` de
 * l'assistant). Un test vérifie que chaque mot désigne au moins un code du
 * référentiel (REF-AC12) : un mot sans type correspondant ferait échouer.
 */
export const DOCUMENT_TYPE_QUERY_WORDS: readonly string[] = [
  'facture', 'devis', 'contrat', 'garantie', 'dpe', 'notice', 'manuel', 'certificat', 'attestation',
  'assurance', 'acte', 'bail', 'quittance', 'releve', 'diagnostic', 'rapport', 'ticket', 'constat', 'avenant',
];
