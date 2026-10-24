/**
 * Référentiel documentaire V2 — point d'accès unique.
 *
 * CDC V2.0 §3 (référentiel), §6.2 (visibilité contextuelle), §13.2 (code-based),
 * §11.4 (contrat du prompt), §11.6 (réévaluation sur évolution).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA VERSION N'EST PAS DÉCORATIVE
 *
 * Le §11.6 impose de retraiter TOUS les documents lorsque le référentiel
 * évolue — pas seulement ceux sans Type. Encore faut-il savoir qu'il a
 * évolué. `REFERENTIAL_VERSION` est ce marqueur : il est stocké avec chaque
 * décision de classement, et une valeur différente de la version courante
 * suffit à identifier les documents à repasser.
 *
 * Toute modification de `RUBRICS` ou `DOCUMENT_TYPES` doit incrémenter cette
 * version. Une modification silencieuse laisserait le parc documentaire
 * classé selon un référentiel qui n'existe plus, sans aucun moyen de le
 * détecter après coup.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { RUBRICS } from './rubrics';
import { DOCUMENT_TYPES } from './document-types';
import { MICROCOPY } from './microcopy';
import type {
  Applicability,
  AssetFamily,
  DocumentTypeDefinition,
  RubricCode,
  RubricDefinition,
} from './types';

export * from './types';
export { RUBRICS, RUBRIC_COLORS, UNFILED_COLORS, rubricColors } from './rubrics';
export { DOCUMENT_TYPES } from './document-types';

/**
 * Version du référentiel. À incrémenter à CHAQUE modification de la
 * taxonomie ou des règles d'applicabilité (§11.6, §13.2).
 */
export const REFERENTIAL_VERSION = '2.2.0';

/**
 * ── HISTORIQUE ────────────────────────────────────────────────────────────
 *
 * 2.2.0 — Lot 86E : Rubrique « Équipements et mobilier » (EQUIPMENT_FURNITURE).
 *   Relevé en préproduction : « Bon de commande Tikamoon — Chaises de jardin en
 *   teck » rangé en « Autres documents », faute de domaine pour un meuble ou un
 *   appareil acheté. La Rubrique porte le DOMAINE ; ses Types sont les Types
 *   génériques existants déclarés réutilisables (`alsoIn`) — facture, bon de
 *   commande, bon de livraison, justificatif de paiement, garantie, extension de
 *   garantie, notice / manuel, fiche technique — plus un Type générique « Devis
 *   d'achat » (ACQUISITION_QUOTE, aucun devis d'achat n'existait), et le
 *   « Autre » propre à la Rubrique (§2.2). Libellés des Types d'achat rendus
 *   neutres (« Bon de commande », « Facture d'achat »…), finalités élargies.
 *   Version de règles du contrôle COH-DOC-CLASSIFICATION : `NOMENCLATURE_SINCE`.
 *
 * 2.1.0 — Ajout de `SUBSCRIPTION_INVOICE` dans « Contrats, garanties et
 *   notices ». Relevé en préproduction : deux factures d'énergie recevaient le
 *   Type « Contrat d'abonnement », faute de mieux. La Rubrique était juste — la
 *   finalité est bien le service — mais aucun Type ne couvrait la FACTURE qui
 *   découle d'un abonnement, seulement le contrat lui-même. Le modèle prenait
 *   donc le moins éloigné, ce que le §3.4 lui interdit précisément de faire.
 *
 *   Le trou venait du référentiel, pas du prompt.
 *
 * 2.0.0 — Référentiel initial du CDC V2.
 */

/** Compare deux versions « a.b.c » du référentiel (une version absente précède tout). */
export function compareReferentialVersions(a: string | null | undefined, b: string | null | undefined): number {
  const parts = (v: string | null | undefined) => (v ?? '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Lot 86E : Rubriques introduites APRÈS la version donnée (`since`), donc
 * inconnues d'un classement produit sous cette version.
 */
export function rubricsIntroducedAfter(version: string | null | undefined): RubricDefinition[] {
  return RUBRICS.filter((r) => !!r.since && compareReferentialVersions(r.since, version) > 0);
}

/** Seuil de confiance unique, non configurable dans l'application (§11.2). */
export const AI_CONFIDENCE_THRESHOLD = 0.9;

/** Rubrique de dernier recours (§3.3). */
export const FALLBACK_RUBRIC_CODE: RubricCode = 'OTHER_DOCUMENTS';

// ── Index ───────────────────────────────────────────────────────────────────

const RUBRIC_BY_CODE = new Map<string, RubricDefinition>(
  RUBRICS.map((r) => [r.code, r]),
);
const TYPE_BY_CODE = new Map<string, DocumentTypeDefinition>(
  DOCUMENT_TYPES.map((t) => [t.code, t]),
);
/** Rubriques où un Type est proposé : sa Rubrique d'attache, puis `alsoIn` (lot 86E). */
function rubricsOf(type: DocumentTypeDefinition): RubricCode[] {
  return [type.rubric, ...(type.alsoIn ?? []).filter((r) => r !== type.rubric)];
}

const TYPES_BY_RUBRIC = new Map<RubricCode, DocumentTypeDefinition[]>();
for (const type of DOCUMENT_TYPES) {
  for (const rubric of new Set(rubricsOf(type))) {
    const bucket = TYPES_BY_RUBRIC.get(rubric) ?? [];
    bucket.push(type);
    TYPES_BY_RUBRIC.set(rubric, bucket);
  }
}

// ── Intégrité (§13.2) ───────────────────────────────────────────────────────

export interface ReferentialViolation {
  code: string;
  message: string;
}

/**
 * Contrôles d'intégrité du référentiel.
 *
 * Le §13.2 est explicite : « Le code doit refuser au build/test une
 * configuration où un Type appartient à plusieurs Rubriques. » L'invariant
 * est déjà porté par le type `DocumentTypeDefinition` — un Type n'a qu'un
 * champ `rubric`. Ce qui reste vérifiable, et qu'un copier-coller casse
 * facilement, c'est l'unicité des codes et la cohérence des applicabilités.
 *
 * Un Type immobilier rattaché à une Rubrique qui n'est pas applicable à
 * l'immobilier serait invisible partout : ni erreur, ni document mal classé,
 * juste un Type que personne ne peut choisir. C'est le genre de défaut qu'on
 * ne découvre qu'en production, par une absence.
 */
export function checkReferentialIntegrity(): ReferentialViolation[] {
  const violations: ReferentialViolation[] = [];

  const seenRubrics = new Set<string>();
  for (const rubric of RUBRICS) {
    if (seenRubrics.has(rubric.code)) {
      violations.push({
        code: 'DUPLICATE_RUBRIC',
        message: `Rubrique déclarée deux fois : ${rubric.code}.`,
      });
    }
    seenRubrics.add(rubric.code);
  }

  const seenTypes = new Set<string>();
  for (const type of DOCUMENT_TYPES) {
    if (seenTypes.has(type.code)) {
      violations.push({
        code: 'DUPLICATE_TYPE',
        message:
          `Type déclaré deux fois : ${type.code}. Un code partagé entre deux ` +
          'Rubriques recréerait le Type multi-rubriques interdit par le §2.2.',
      });
    }
    seenTypes.add(type.code);

    const rubric = RUBRIC_BY_CODE.get(type.rubric);
    if (!rubric) {
      violations.push({
        code: 'UNKNOWN_RUBRIC',
        message: `Type ${type.code} rattaché à une Rubrique inconnue : ${type.rubric}.`,
      });
      continue;
    }

    // Applicabilité du Type ⊆ applicabilité de sa Rubrique.
    const families = resolveApplicability(type.applicability);
    const rubricFamilies = resolveApplicability(rubric.applicability);
    const orphans = families.filter((f) => !rubricFamilies.includes(f));
    if (orphans.length > 0) {
      violations.push({
        code: 'APPLICABILITY_MISMATCH',
        message:
          `Type ${type.code} applicable à ${orphans.join(', ')}, hors du périmètre ` +
          `de la Rubrique ${rubric.code}. Il ne serait proposé nulle part.`,
      });
    }

    // Lot 86E — réutilisation dans d'autres Rubriques (`alsoIn`).
    const others = type.alsoIn ?? [];
    if (others.length > 0 && type.userOnly) {
      violations.push({
        code: 'SHARED_OTHER_TYPE',
        message:
          `Type « Autre » ${type.code} déclaré dans plusieurs Rubriques. Chaque ` +
          'Rubrique garde son propre « Autre » (§2.2).',
      });
    }
    if (new Set(others).size !== others.length || others.includes(type.rubric)) {
      violations.push({
        code: 'DUPLICATE_RUBRIC_OF_TYPE',
        message: `Type ${type.code} : Rubrique répétée dans alsoIn (ou égale à sa Rubrique d'attache).`,
      });
    }
    for (const code of others) {
      const extra = RUBRIC_BY_CODE.get(code);
      if (!extra) {
        violations.push({
          code: 'UNKNOWN_RUBRIC',
          message: `Type ${type.code} déclaré réutilisable dans une Rubrique inconnue : ${code}.`,
        });
        continue;
      }
      const extraFamilies = resolveApplicability(extra.applicability);
      const hors = families.filter((f) => !extraFamilies.includes(f));
      if (hors.length > 0) {
        violations.push({
          code: 'APPLICABILITY_MISMATCH',
          message: `Type ${type.code} applicable à ${hors.join(', ')}, hors du périmètre de la Rubrique ${code}.`,
        });
      }
    }
  }

  // Lot 86E — aucun doublon : dans une Rubrique, deux Types proposés ne
  // portent jamais le même libellé (un doublon de nature se verrait d'abord
  // là, dans la liste de choix de l'utilisateur).
  for (const rubric of RUBRICS) {
    const seen = new Map<string, string>();
    for (const type of TYPES_BY_RUBRIC.get(rubric.code) ?? []) {
      const key = type.label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      const previous = seen.get(key);
      if (previous) {
        violations.push({
          code: 'DUPLICATE_TYPE_LABEL',
          message: `Rubrique ${rubric.code} : « ${type.label} » proposé deux fois (${previous}, ${type.code}).`,
        });
      }
      seen.set(key, type.code);
    }
  }

  // Chaque Rubrique doit offrir son propre « Autre » (§2.2).
  for (const rubric of RUBRICS) {
    const types = TYPES_BY_RUBRIC.get(rubric.code) ?? [];
    if (!types.some((t) => t.userOnly && t.rubric === rubric.code)) {
      violations.push({
        code: 'MISSING_OTHER_TYPE',
        message:
          `Rubrique ${rubric.code} sans Type « Autre » dédié. Le §2.2 en exige un ` +
          'par Rubrique, avec son propre code technique.',
      });
    }
  }

  return violations;
}

/**
 * Variante qui lève. Appelée par la suite de tests et par
 * `npm run referential:check`, exécuté en CI avant le build.
 */
export function assertReferentialIntegrity(): void {
  const violations = checkReferentialIntegrity();
  if (violations.length > 0) {
    throw new Error(
      `Référentiel V2 invalide (${violations.length}) :\n` +
        violations.map((v) => `  · [${v.code}] ${v.message}`).join('\n'),
    );
  }
}

// ── Lectures ────────────────────────────────────────────────────────────────

function resolveApplicability(applicability: Applicability): AssetFamily[] {
  return applicability === 'ALL'
    ? ['IMMOBILIER', 'VEHICULE', 'MATERIEL_PRO', 'OBJECT']
    : [...applicability];
}

export function getRubric(code: string | null | undefined): RubricDefinition | undefined {
  return code ? RUBRIC_BY_CODE.get(code) : undefined;
}

export function getDocumentType(
  code: string | null | undefined,
): DocumentTypeDefinition | undefined {
  return code ? TYPE_BY_CODE.get(code) : undefined;
}

/** Types d'une Rubrique, « Autre » toujours en dernier (§3.3). */
export function getTypesForRubric(rubric: RubricCode): DocumentTypeDefinition[] {
  const types = [...(TYPES_BY_RUBRIC.get(rubric) ?? [])];
  return types.sort((a, b) => {
    if (a.userOnly !== b.userOnly) return a.userOnly ? 1 : -1;
    return a.label.localeCompare(b.label, 'fr');
  });
}

/**
 * Rubrique d'ATTACHE d'un Type. Le §2.2 la rend déductible : « Un document ne
 * peut pas avoir un Type sans Rubrique : lorsqu'un Type est déterminé, sa
 * Rubrique est déduite. »
 *
 * Lot 86E : un Type réutilisable (`alsoIn`) est valide dans plusieurs
 * Rubriques ; la déduction ne vaut alors QUE faute de Rubrique connue —
 * utiliser `rubricForType(type, rubriqueCourante)`, jamais une comparaison
 * `rubricOfType(t) === r`, qui refuserait un « Bon de commande » rangé en
 * « Équipements et mobilier ».
 */
export function rubricOfType(typeCode: string | null | undefined): RubricCode | null {
  return getDocumentType(typeCode)?.rubric ?? null;
}

/** Rubriques où le Type est proposé (attache d'abord) ; vide pour un code inconnu. */
export function rubricsOfType(typeCode: string | null | undefined): RubricCode[] {
  const type = getDocumentType(typeCode);
  return type ? rubricsOf(type) : [];
}

export function isTypeCompatibleWithRubric(typeCode: string, rubricCode: string): boolean {
  return rubricsOfType(typeCode).includes(rubricCode as RubricCode);
}

/**
 * Rubrique d'un document qui reçoit ce Type : la Rubrique courante si le Type
 * y est proposé, sinon la Rubrique d'attache du Type (§2.2). `null` pour un
 * code inconnu.
 */
export function rubricForType(
  typeCode: string | null | undefined,
  currentRubric: string | null | undefined,
): RubricCode | null {
  if (!getDocumentType(typeCode)) return null;
  if (currentRubric && isTypeCompatibleWithRubric(typeCode as string, currentRubric)) {
    return currentRubric as RubricCode;
  }
  return rubricOfType(typeCode);
}

/**
 * Libellé AFFICHÉ du Type d'un document (lot 86E, ticket §5) — une seule
 * correspondance code persisté → libellé, pour tous les écrans : le libellé
 * du Type V2 enregistré, sinon « Type à compléter ». Jamais « Autre » pour un
 * Type absent (« Autre » est un CHOIX de l'utilisateur, §15.1), jamais un code
 * technique brut (« BON_COMMANDE »).
 */
export function documentTypeDisplayLabel(typeCode: string | null | undefined): string {
  return getDocumentType(typeCode)?.label ?? MISSING_TYPE_LABEL;
}

/** Microcopie du Type manquant (§17.4), la même que les listes documentaires. */
export const MISSING_TYPE_LABEL: string = MICROCOPY.missingType;

/**
 * Le Type peut-il être choisi ou proposé par l'IA ?
 *
 * §5.2 et critère DOC-08 : « L'IA ne sélectionne ni ne propose jamais un Type
 * "Autre". » Filtrer ici plutôt que dans le prompt : une consigne rédigée
 * dépend du modèle, un filtre non.
 */
export function isAiSelectable(typeCode: string): boolean {
  const type = getDocumentType(typeCode);
  return !!type && !type.userOnly;
}

export function isApplicableToFamily(
  applicability: Applicability,
  family: AssetFamily,
): boolean {
  return applicability === 'ALL' || applicability.includes(family);
}

export interface RubricVisibilityContext {
  /** Familles des biens du périmètre courant (compte ou bien affiché). */
  families: readonly AssetFamily[];
  /**
   * Au moins un bien immobilier du périmètre a l'usage « Mis en location »
   * (occupancyUsage = LOCATIF — l'ancien attribut is_rented est retiré).
   */
  hasRentedAsset: boolean;
  /**
   * Au moins un document est déjà classé en « Gestion locative » dans le
   * périmètre — un historique locatif reste consultable même si plus aucun
   * bien n'est loué (§6.2).
   */
  hasRentalDocuments: boolean;
}

/**
 * Rubriques à afficher, dans l'ordre (§3.3, §6.2).
 *
 * ── LA SEULE RUBRIQUE QUI PEUT DISPARAÎTRE ────────────────────────────────
 *
 * Le §3.3 pose que « les autres Rubriques pertinentes restent visibles même
 * avec un compteur à 0 ». « Gestion locative » fait exception : elle
 * n'apparaît que si un bien est loué OU si des documents locatifs existent
 * déjà. Ce second cas est ce qui évite qu'un bail signé l'an dernier devienne
 * introuvable le jour où le bien repasse à « non loué » (§6.2, ligne 3).
 */
export function getVisibleRubrics(context: RubricVisibilityContext): RubricDefinition[] {
  const families = context.families.length > 0
    ? context.families
    : (['IMMOBILIER', 'VEHICULE', 'MATERIEL_PRO', 'OBJECT'] as const);

  return RUBRICS.filter((rubric) => {
    const relevant = families.some((f) => isApplicableToFamily(rubric.applicability, f));
    if (!relevant) return false;
    if (rubric.code === 'RENTAL_MANAGEMENT') {
      return context.hasRentedAsset || context.hasRentalDocuments;
    }
    return true;
  }).sort((a, b) => a.displayOrder - b.displayOrder);
}

/**
 * Projection du référentiel destinée au prompt d'optimisation (§11.4).
 *
 * Les Types « Autre » sont retirés de la projection, pas seulement signalés :
 * le §11.4 demande de « ne jamais sélectionner ou proposer un Type Autre »,
 * et le plus sûr moyen d'y parvenir est que le modèle ne les voie pas.
 */
export function buildPromptReferential(): {
  version: string;
  rubrics: Array<{
    code: RubricCode;
    label: string;
    purpose: string;
    exclusions: string;
    types: Array<{ code: string; label: string; purpose: string; applicability: AssetFamily[] }>;
  }>;
} {
  return {
    version: REFERENTIAL_VERSION,
    rubrics: RUBRICS.map((rubric) => ({
      code: rubric.code,
      label: rubric.label,
      purpose: rubric.purpose,
      exclusions: rubric.exclusions,
      types: getTypesForRubric(rubric.code)
        .filter((t) => !t.userOnly)
        .map((t) => ({
          code: t.code,
          label: t.label,
          purpose: t.purpose,
          applicability: resolveApplicability(t.applicability),
        })),
    })),
  };
}
