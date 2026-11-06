/**
 * Catalogue des données du CIL (lot 111U) — version CODE de la matrice
 * `docs/cil/matrice-cil.md` (même identifiants stables, même ordre).
 *
 * Une entrée = une donnée ou une pièce attendue d'un bloc B1-B9, avec :
 *   · sa catégorie produit (`OBLIGATOIRE`, `CONDITIONNEL`, `COMPLEMENT`) —
 *     classement PRODUIT fondé sur les références de la matrice, à valider
 *     par le PO ; jamais présenté comme une certification réglementaire ;
 *   · son applicabilité (toujours, selon une installation dont la présence
 *     doit être connue, selon le profil CIL) ;
 *   · la possibilité de la déclarer « Non applicable » (`naAllowed`) ;
 *   · son caractère BLOQUANT pour la génération (règle produit existante
 *     CIL-RULE-002 : B1, B3, B8 — `lib/exports/cil-blocking.ts`).
 *
 * Pure, sans accès base : lue par le service d'état (`services/cil/state`),
 * l'onglet Informations, la route des déclarations « Non applicable » et les
 * tests. Ne contient AUCUN texte juridique.
 */

export const CIL_BLOCK_IDS = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9'] as const;
export type CilBlockId = (typeof CIL_BLOCK_IDS)[number];

export const CIL_BLOCK_LABELS: Record<CilBlockId, string> = {
  B1: 'Identification du logement',
  B2: 'Contexte de constitution du carnet',
  B3: 'Plans et coupes',
  B4: 'Réseaux (eau, électricité, gaz, aération)',
  B5: 'Matériaux à incidence énergétique',
  B6: 'Équipements à incidence énergétique',
  B7: 'Travaux de rénovation énergétique',
  B8: 'Performance énergétique et justificatifs',
  B9: 'Documents annexes',
};

/** Catégorie produit d'une donnée (matrice, colonne « catégorie »). */
export type CilCategory = 'OBLIGATOIRE' | 'CONDITIONNEL' | 'COMPLEMENT';

/**
 * Applicabilité :
 *   ALWAYS          toujours attendue (sauf « Non applicable » autorisé) ;
 *   IF_PRESENT      attendue seulement si l'installation existe : sans donnée
 *                   ni déclaration, la présence reste « à confirmer » et la
 *                   ligne est EXCLUE du dénominateur (jamais inférée absente) ;
 *   IF_CONSTRUCTION attendue si le profil CIL est « construction neuve » ;
 *                   non applicable (règle) pour rénovation / démarche
 *                   volontaire ; à confirmer si le profil est inconnu ;
 *   IF_RENOVATION   attendue si le profil est « rénovation énergétique » ;
 *                   à confirmer sinon ;
 *   IF_DPE          attendue quand un DPE est disponible (contenu du DPE).
 */
export type CilApplicability = 'ALWAYS' | 'IF_PRESENT' | 'IF_CONSTRUCTION' | 'IF_RENOVATION' | 'IF_DPE';

/** Statut métier d'une donnée ou d'un bloc (ticket, annexe 3 §I). */
export type CilItemStatus = 'renseigne' | 'partiel' | 'manquant' | 'a_confirmer' | 'non_applicable';

export const CIL_STATUS_LABELS: Record<CilItemStatus, string> = {
  renseigne: 'Renseigné',
  partiel: 'Partiel',
  manquant: 'Manquant',
  a_confirmer: 'À confirmer',
  non_applicable: 'Non applicable',
};

/** Action proposée à l'utilisateur (onglet Informations). */
export type CilActionKind = 'complete_field' | 'add_document' | 'equipments' | 'materials' | 'agenda' | 'cil_profile' | 'confirm';

export interface CilCatalogItem {
  id: string;
  block: CilBlockId;
  label: string;
  category: CilCategory;
  applicability: CilApplicability;
  naAllowed: boolean;
  /** Bloque la génération quand la donnée manque (CIL-RULE-002). */
  blocking?: boolean;
  action: CilActionKind;
  /** Libellé de l'action. */
  actionLabel: string;
  /** Champ de la fiche à compléter (`highlight`) ou filtre documentaire. */
  target?: string;
}

const I = (x: CilCatalogItem): CilCatalogItem => x;

export const CIL_CATALOG: readonly CilCatalogItem[] = [
  // B1 — Identification
  I({ id: 'B1.address', block: 'B1', label: 'Adresse', category: 'OBLIGATOIRE', applicability: 'ALWAYS', naAllowed: false, blocking: true, action: 'complete_field', actionLabel: 'Compléter', target: 'address' }),
  I({ id: 'B1.postalCode', block: 'B1', label: 'Code postal', category: 'OBLIGATOIRE', applicability: 'ALWAYS', naAllowed: false, blocking: true, action: 'complete_field', actionLabel: 'Compléter', target: 'address' }),
  I({ id: 'B1.city', block: 'B1', label: 'Commune', category: 'OBLIGATOIRE', applicability: 'ALWAYS', naAllowed: false, blocking: true, action: 'complete_field', actionLabel: 'Compléter', target: 'address' }),
  I({ id: 'B1.nature', block: 'B1', label: 'Nature du logement', category: 'COMPLEMENT', applicability: 'ALWAYS', naAllowed: false, action: 'complete_field', actionLabel: 'Compléter', target: 'subCategory' }),
  I({ id: 'B1.livingArea', block: 'B1', label: 'Surface habitable', category: 'COMPLEMENT', applicability: 'ALWAYS', naAllowed: false, action: 'complete_field', actionLabel: 'Compléter', target: 'livingArea' }),
  I({ id: 'B1.constructionYear', block: 'B1', label: 'Année de construction', category: 'COMPLEMENT', applicability: 'ALWAYS', naAllowed: false, action: 'complete_field', actionLabel: 'Compléter', target: 'constructionYear' }),
  // B2 — Contexte
  I({ id: 'B2.trigger', block: 'B2', label: 'Motif de constitution du carnet', category: 'COMPLEMENT', applicability: 'ALWAYS', naAllowed: false, action: 'cil_profile', actionLabel: 'Préciser le contexte' }),
  // B3 — Plans
  I({ id: 'B3.plans', block: 'B3', label: 'Plans de surface et coupes', category: 'CONDITIONNEL', applicability: 'ALWAYS', naAllowed: true, blocking: true, action: 'add_document', actionLabel: 'Ajouter un plan', target: 'PLAN_CONSTRUCTION' }),
  I({ id: 'B3.planState', block: 'B3', label: 'État des plans (conception ou exécution)', category: 'COMPLEMENT', applicability: 'ALWAYS', naAllowed: false, action: 'add_document', actionLabel: 'Préciser sur le document', target: 'PLAN_CONSTRUCTION' }),
  // B4 — Réseaux
  I({ id: 'B4.eau', block: 'B4', label: 'Réseau d’eau : plan ou schéma', category: 'CONDITIONNEL', applicability: 'ALWAYS', naAllowed: true, action: 'add_document', actionLabel: 'Ajouter le plan', target: 'RESEAU_EAU' }),
  I({ id: 'B4.electricite', block: 'B4', label: 'Réseau électrique : plan ou schéma', category: 'CONDITIONNEL', applicability: 'ALWAYS', naAllowed: true, action: 'add_document', actionLabel: 'Ajouter le plan', target: 'RESEAU_ELECTRICITE' }),
  I({ id: 'B4.gaz', block: 'B4', label: 'Réseau de gaz : plan ou schéma', category: 'CONDITIONNEL', applicability: 'IF_PRESENT', naAllowed: true, action: 'add_document', actionLabel: 'Ajouter le plan', target: 'RESEAU_GAZ' }),
  I({ id: 'B4.aeration', block: 'B4', label: 'Aération : plan ou schéma', category: 'CONDITIONNEL', applicability: 'ALWAYS', naAllowed: true, action: 'add_document', actionLabel: 'Ajouter le plan', target: 'RESEAU_AERATION' }),
  // B5 — Matériaux (postes de `energy_materials.category`)
  I({ id: 'B5.toiture', block: 'B5', label: 'Toiture / combles', category: 'CONDITIONNEL', applicability: 'ALWAYS', naAllowed: true, action: 'materials', actionLabel: 'Compléter les matériaux' }),
  I({ id: 'B5.murs_exterieurs', block: 'B5', label: 'Murs extérieurs', category: 'CONDITIONNEL', applicability: 'ALWAYS', naAllowed: true, action: 'materials', actionLabel: 'Compléter les matériaux' }),
  I({ id: 'B5.parois_vitrees', block: 'B5', label: 'Parois vitrées et portes extérieures', category: 'CONDITIONNEL', applicability: 'ALWAYS', naAllowed: true, action: 'materials', actionLabel: 'Compléter les matériaux' }),
  I({ id: 'B5.planchers_bas', block: 'B5', label: 'Planchers bas', category: 'CONDITIONNEL', applicability: 'ALWAYS', naAllowed: true, action: 'materials', actionLabel: 'Compléter les matériaux' }),
  // B6 — Équipements (usages de `lib/cil/energy-equipment.ts`)
  I({ id: 'B6.chauffage', block: 'B6', label: 'Chauffage', category: 'CONDITIONNEL', applicability: 'ALWAYS', naAllowed: true, action: 'equipments', actionLabel: 'Compléter les équipements' }),
  I({ id: 'B6.ecs', block: 'B6', label: 'Eau chaude sanitaire', category: 'CONDITIONNEL', applicability: 'ALWAYS', naAllowed: true, action: 'equipments', actionLabel: 'Compléter les équipements' }),
  I({ id: 'B6.ventilation', block: 'B6', label: 'Ventilation', category: 'CONDITIONNEL', applicability: 'ALWAYS', naAllowed: true, action: 'equipments', actionLabel: 'Compléter les équipements' }),
  I({ id: 'B6.refroidissement', block: 'B6', label: 'Refroidissement / climatisation', category: 'CONDITIONNEL', applicability: 'IF_PRESENT', naAllowed: true, action: 'equipments', actionLabel: 'Compléter les équipements' }),
  I({ id: 'B6.enr', block: 'B6', label: 'Production d’énergie renouvelable', category: 'CONDITIONNEL', applicability: 'IF_PRESENT', naAllowed: true, action: 'equipments', actionLabel: 'Compléter les équipements' }),
  // B7 — Travaux réalisés
  I({ id: 'B7.works', block: 'B7', label: 'Travaux de rénovation énergétique réalisés', category: 'CONDITIONNEL', applicability: 'IF_RENOVATION', naAllowed: true, action: 'agenda', actionLabel: 'Ajouter des travaux' }),
  // B8 — Performance
  I({ id: 'B8.dpeDocument', block: 'B8', label: 'Diagnostic de performance énergétique (DPE)', category: 'OBLIGATOIRE', applicability: 'ALWAYS', naAllowed: false, blocking: true, action: 'add_document', actionLabel: 'Ajouter un DPE', target: 'DPE' }),
  I({ id: 'B8.dpeClass', block: 'B8', label: 'Classe énergie', category: 'CONDITIONNEL', applicability: 'IF_DPE', naAllowed: false, action: 'complete_field', actionLabel: 'Compléter', target: 'dpeClass' }),
  I({ id: 'B8.gesClass', block: 'B8', label: 'Classe climat (GES)', category: 'CONDITIONNEL', applicability: 'IF_DPE', naAllowed: false, action: 'complete_field', actionLabel: 'Compléter', target: 'gesClass' }),
  I({ id: 'B8.dpeDate', block: 'B8', label: 'Date d’établissement du DPE', category: 'CONDITIONNEL', applicability: 'IF_DPE', naAllowed: false, action: 'complete_field', actionLabel: 'Compléter', target: 'dpeDate' }),
  I({ id: 'B8.energyConsumption', block: 'B8', label: 'Consommation d’énergie', category: 'COMPLEMENT', applicability: 'IF_DPE', naAllowed: false, action: 'complete_field', actionLabel: 'Compléter', target: 'energyConsumption' }),
  I({ id: 'B8.gesEmissions', block: 'B8', label: 'Émissions de gaz à effet de serre', category: 'COMPLEMENT', applicability: 'IF_DPE', naAllowed: false, action: 'complete_field', actionLabel: 'Compléter', target: 'gesEmissions' }),
  I({ id: 'B8.dpeAdemeNumber', block: 'B8', label: 'Numéro ADEME du DPE', category: 'COMPLEMENT', applicability: 'IF_DPE', naAllowed: false, action: 'complete_field', actionLabel: 'Compléter', target: 'dpeAdemeNumber' }),
  I({ id: 'B8.dpeExpiryDate', block: 'B8', label: 'Fin de validité indiquée', category: 'COMPLEMENT', applicability: 'IF_DPE', naAllowed: false, action: 'complete_field', actionLabel: 'Compléter', target: 'dpeExpiryDate' }),
  I({ id: 'B8.re2020', block: 'B8', label: 'Attestation de prise en compte de la réglementation environnementale', category: 'CONDITIONNEL', applicability: 'IF_CONSTRUCTION', naAllowed: true, action: 'add_document', actionLabel: 'Ajouter l’attestation', target: 'RE2020' }),
  I({ id: 'B8.audit', block: 'B8', label: 'Audit énergétique', category: 'COMPLEMENT', applicability: 'ALWAYS', naAllowed: false, action: 'add_document', actionLabel: 'Ajouter un audit', target: 'AUDIT_ENERGETIQUE' }),
  I({ id: 'B8.label', block: 'B8', label: 'Label ou certification obtenu', category: 'COMPLEMENT', applicability: 'ALWAYS', naAllowed: false, action: 'add_document', actionLabel: 'Ajouter le justificatif', target: 'LABEL_CERTIFICATION' }),
  // B9 — Annexes
  I({ id: 'B9.annexes', block: 'B9', label: 'Notices et documents complémentaires', category: 'COMPLEMENT', applicability: 'ALWAYS', naAllowed: false, action: 'add_document', actionLabel: 'Ajouter un document' }),
];

const BY_ID = new Map(CIL_CATALOG.map((i) => [i.id, i]));

export function cilCatalogItem(id: string): CilCatalogItem | undefined {
  return BY_ID.get(id);
}

/** Catégories comptées dans l'avancement RÉGLEMENTAIRE (le reste = couverture complémentaire). */
export const REGULATORY_CATEGORIES: ReadonlySet<CilCategory> = new Set(['OBLIGATOIRE', 'CONDITIONNEL']);

/**
 * Une donnée peut-elle être déclarée « Non applicable » par l'utilisateur ?
 * Identifiant de donnée du catalogue (`B4.gaz`) ; les blocs gardent la règle
 * existante (`CIL_NOT_APPLICABLE_ALLOWED`, route des résolutions).
 */
export function cilItemNotApplicableAllowed(id: string): boolean {
  return BY_ID.get(id)?.naAllowed === true;
}

/**
 * Formule d'avancement (transparente, stable, testée — L111U-U-PROGRESS) :
 *   dénominateur = données applicables (hors « Non applicable » et hors
 *                  présence « à confirmer » d'une installation IF_PRESENT /
 *                  d'un profil inconnu) ;
 *   numérateur   = renseignées × 1 + partielles × ½ (une donnée « à
 *                  confirmer » parce que contradictoire compte 0) ;
 *   pourcentage  = arrondi(numérateur / dénominateur × 100), 100 si aucun
 *                  dénominateur. Une déclaration « Non applicable » retire la
 *                  ligne du dénominateur SANS l'ajouter au numérateur.
 */
export function cilProgress(items: ReadonlyArray<{ status: CilItemStatus; counted: boolean }>): {
  done: number; applicable: number; percentage: number; renseigne: number; partiel: number; manquant: number; aConfirmer: number; nonApplicable: number;
} {
  let num = 0; let den = 0;
  const n = { renseigne: 0, partiel: 0, manquant: 0, aConfirmer: 0, nonApplicable: 0 };
  for (const i of items) {
    if (i.status === 'renseigne') n.renseigne++;
    else if (i.status === 'partiel') n.partiel++;
    else if (i.status === 'manquant') n.manquant++;
    else if (i.status === 'a_confirmer') n.aConfirmer++;
    else n.nonApplicable++;
    if (!i.counted) continue;
    den++;
    if (i.status === 'renseigne') num += 1;
    else if (i.status === 'partiel') num += 0.5;
  }
  return { done: num, applicable: den, percentage: den === 0 ? 100 : Math.round((num / den) * 100), ...n };
}

/**
 * Statut agrégé d'un ensemble de données (bloc) : toutes N/A → N/A ;
 * toutes renseignées (hors N/A) → renseigné ; aucune donnée renseignée ni
 * partielle et au moins une manquante → manquant ; seulement « à confirmer »
 * (hors N/A) → à confirmer ; sinon partiel.
 */
export function aggregateCilStatus(statuses: readonly CilItemStatus[]): CilItemStatus {
  const s = statuses.filter((x) => x !== 'non_applicable');
  if (statuses.length > 0 && s.length === 0) return 'non_applicable';
  if (s.length === 0) return 'manquant';
  if (s.every((x) => x === 'renseigne')) return 'renseigne';
  if (s.every((x) => x === 'a_confirmer')) return 'a_confirmer';
  if (!s.some((x) => x === 'renseigne' || x === 'partiel')) return s.includes('manquant') ? 'manquant' : 'a_confirmer';
  return 'partiel';
}
