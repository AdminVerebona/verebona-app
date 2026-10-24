/**
 * Lot 86E — ticket P1 « Documents — rubrique Équipements et mobilier et types
 * documentaires associés ». Tests unitaires (identifiants L86E-U-…).
 *
 * Référentiel (rubrique, types réutilisés sans doublon), correspondance
 * « type identifié → type enregistré → type affiché », règles de classement
 * multi-rubriques, champs du tiroir (desktop et mobile : même composant),
 * diagnostic du contrôle COH-DOC-CLASSIFICATION.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));

const {
  DOCUMENT_TYPES, RUBRICS, REFERENTIAL_VERSION, buildPromptReferential, checkReferentialIntegrity, documentTypeDisplayLabel,
  getTypesForRubric, getVisibleRubrics, isTypeCompatibleWithRubric, rubricForType, rubricOfType, rubricsIntroducedAfter, rubricsOfType,
  compareReferentialVersions,
} = await import('@/lib/referential/v2');
const { v2TypeForRubric, resolveDocumentCode } = await import('@/lib/referential/document-codes');
const { validateProposal, deduceFromType, DOMAIN_NOT_PROVEN_CONFIDENCE } = await import('@/services/ai/source-analysis/master/rubric-rules');
const { applyClassificationChange } = await import('@/services/documents/rubric-classification');
const { diagnoseDocumentClassification } = await import('@/services/coherence/registry/checks/document-classification');
const { COHERENCE_REGISTRY } = await import('@/services/coherence/registry');
const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** Les huit types du ticket §3 → types EXISTANTS réutilisés (un seul nouveau : le devis d'achat). */
const TYPES_DU_TICKET: Record<string, string> = {
  Facture: 'ACQUISITION_INVOICE',
  'Bon de commande': 'ACQUISITION_ORDER',
  Devis: 'ACQUISITION_QUOTE',
  'Bon de livraison': 'ACQUISITION_DELIVERY',
  Garantie: 'WARRANTY_CERTIFICATE',
  'Notice / Manuel': 'USER_MANUAL',
  'Fiche technique': 'TECHNICAL_SHEET',
  'Justificatif de paiement': 'ACQUISITION_PAYMENT',
};
const FAMILLES = ['IMMOBILIER', 'VEHICULE', 'MATERIEL_PRO', 'OBJECT'] as const;

describe('L86E-U-01 — la rubrique « Équipements et mobilier » est disponible partout', () => {
  it('est déclarée dans le référentiel versionné, avec finalité et exclusions', () => {
    const r = RUBRICS.find((x) => x.code === 'EQUIPMENT_FURNITURE');
    expect(r?.label).toBe('Équipements et mobilier');
    expect(r?.purpose).toMatch(/meubles, appareils et\s+équipements/);
    expect(r?.exclusions).toMatch(/Entretien et travaux/);
    expect(r?.since).toBe('2.2.0');
    expect(REFERENTIAL_VERSION).toBe('2.2.0');
  });

  it('est visible pour toute famille de bien (pages documentaires, filtres)', () => {
    for (const f of FAMILLES) {
      const codes = getVisibleRubrics({ families: [f], hasRentedAsset: false, hasRentalDocuments: false }).map((x) => x.code);
      expect(codes, f).toContain('EQUIPMENT_FURNITURE');
      expect(codes[codes.length - 1]).toBe('OTHER_DOCUMENTS');
    }
  });

  it('est transmise à T1 en DONNÉES avec ses types (aucun prompt modifié)', () => {
    const r = buildPromptReferential().rubrics.find((x) => x.code === 'EQUIPMENT_FURNITURE')!;
    expect(r.exclusions.length).toBeGreaterThan(20);
    const codes = r.types.map((t) => t.code);
    for (const code of Object.values(TYPES_DU_TICKET)) expect(codes).toContain(code);
    expect(codes).not.toContain('OTHER_EQUIPMENT_FURNITURE');
    // Le master T1 ne fige aucune liste de rubriques : il lit {{DOCUMENT_CATALOG}}.
    const master = read('src/services/ai/prompts/source-analysis/t1_master_v1.txt');
    expect(master).toMatch(/\{\{DOCUMENT_CATALOG\}\}/);
    expect(master).not.toMatch(/PROPERTY_MANAGEMENT|OTHER_DOCUMENTS|Autres documents/);
  });

  it('les exclusions des rubriques voisines renvoient vers la nouvelle (§4)', () => {
    for (const code of ['PROPERTY_MANAGEMENT', 'MAINTENANCE_WORKS', 'CONTRACTS_WARRANTIES_DOCS']) {
      expect(RUBRICS.find((x) => x.code === code)!.exclusions, code).toMatch(/Équipements et mobilier/);
    }
  });
});

describe('L86E-U-02 — les huit types, réutilisés, sans doublon', () => {
  it('les huit types du ticket sont proposés dans la rubrique', () => {
    const proposes = getTypesForRubric('EQUIPMENT_FURNITURE');
    for (const [usage, code] of Object.entries(TYPES_DU_TICKET)) {
      expect(proposes.map((t) => t.code), usage).toContain(code);
    }
    // « Autre » propre à la rubrique, en dernier (§2.2, §3.3).
    expect(proposes[proposes.length - 1].code).toBe('OTHER_EQUIPMENT_FURNITURE');
  });

  it('les types sont les types génériques existants, restés disponibles dans leur rubrique d’origine', () => {
    for (const code of Object.values(TYPES_DU_TICKET)) {
      const rubriques = rubricsOfType(code);
      expect(rubriques, code).toContain('EQUIPMENT_FURNITURE');
      expect(rubriques.length, code).toBeGreaterThanOrEqual(2);
      expect(rubricOfType(code), code).not.toBe('EQUIPMENT_FURNITURE');
    }
    // Un seul Type « métier » créé : aucun devis d'achat n'existait ; il reste générique.
    const propres = DOCUMENT_TYPES.filter((t) => t.rubric === 'EQUIPMENT_FURNITURE');
    expect(propres.map((t) => t.code)).toEqual(['OTHER_EQUIPMENT_FURNITURE']);
    expect(rubricsOfType('ACQUISITION_QUOTE')).toEqual(['PROPERTY_MANAGEMENT', 'EQUIPMENT_FURNITURE']);
  });

  it('aucun doublon : codes uniques, libellés uniques par rubrique, référentiel intègre', () => {
    expect(new Set(DOCUMENT_TYPES.map((t) => t.code)).size).toBe(DOCUMENT_TYPES.length);
    for (const r of RUBRICS) {
      const labels = getTypesForRubric(r.code).map((t) => t.label.toLowerCase());
      expect(new Set(labels).size, r.code).toBe(labels.length);
    }
    expect(checkReferentialIntegrity()).toEqual([]);
  });

  it('libellés : la nature, pas le domaine (« Bon de commande », pas « … d’acquisition »)', () => {
    expect(documentTypeDisplayLabel('ACQUISITION_ORDER')).toBe('Bon de commande');
    expect(documentTypeDisplayLabel('ACQUISITION_INVOICE')).toBe("Facture d'achat");
    expect(documentTypeDisplayLabel('ACQUISITION_PAYMENT')).toBe('Justificatif de paiement');
    expect(resolveDocumentCode('ACQUISITION_QUOTE').catalogCode).toBe('DEVIS');
  });

  it('comparaison de versions et rubriques introduites depuis une version', () => {
    expect(compareReferentialVersions('2.1.0', '2.2.0')).toBe(-1);
    expect(compareReferentialVersions('2.10.0', '2.2.0')).toBe(1);
    expect(compareReferentialVersions(null, '2.0.0')).toBe(-1);
    expect(rubricsIntroducedAfter('2.1.0').map((r) => r.code)).toEqual(['EQUIPMENT_FURNITURE']);
    expect(rubricsIntroducedAfter(null).map((r) => r.code)).toEqual(['EQUIPMENT_FURNITURE']);
    expect(rubricsIntroducedAfter('2.2.0')).toEqual([]);
  });
});

describe('L86E-U-03 — type identifié → type enregistré (correspondance unique)', () => {
  it('BON_COMMANDE identifié : « Bon de commande » dans la rubrique retenue', () => {
    expect(v2TypeForRubric({ canonicalType: 'BON_COMMANDE' }, 'EQUIPMENT_FURNITURE')).toBe('ACQUISITION_ORDER');
    expect(v2TypeForRubric({ canonicalType: 'BON_COMMANDE' }, 'PROPERTY_MANAGEMENT')).toBe('ACQUISITION_ORDER');
    expect(v2TypeForRubric({ canonicalType: 'BON_COMMANDE' }, 'MAINTENANCE_WORKS')).toBe('WORKS_PURCHASE_ORDER');
    // « Autres documents » n'a que « Autre » (choix utilisateur) : rien n'est deviné.
    expect(v2TypeForRubric({ canonicalType: 'BON_COMMANDE' }, 'OTHER_DOCUMENTS')).toBeNull();
  });

  it('plusieurs types de la même nature dans la rubrique : aucun choix arbitraire', () => {
    expect(v2TypeForRubric({ canonicalType: 'FACTURE' }, 'MAINTENANCE_WORKS')).toBeNull();
    expect(v2TypeForRubric({ canonicalType: 'FACTURE' }, 'EQUIPMENT_FURNITURE')).toBe('ACQUISITION_INVOICE');
    expect(v2TypeForRubric({ canonicalType: 'DEVIS' }, 'EQUIPMENT_FURNITURE')).toBe('ACQUISITION_QUOTE');
  });

  it('un type V2 proposé est retenu tel quel s’il est proposé dans la rubrique', () => {
    expect(v2TypeForRubric({ documentTypeCode: 'USER_MANUAL', canonicalType: null }, 'EQUIPMENT_FURNITURE')).toBe('USER_MANUAL');
    expect(v2TypeForRubric({ documentTypeCode: 'WORKS_INVOICE', canonicalType: 'FACTURE' }, 'MAINTENANCE_WORKS')).toBe('WORKS_INVOICE');
  });

  it('un type V2 d’une autre rubrique est une contradiction : jamais remplacé par une autre nature', () => {
    expect(v2TypeForRubric({ documentTypeCode: 'REPAIR_INVOICE', canonicalType: 'FACTURE' }, 'EQUIPMENT_FURNITURE')).toBeNull();
    expect(v2TypeForRubric({ documentTypeCode: 'OTHER_DOCUMENT', canonicalType: 'BON_COMMANDE' }, 'EQUIPMENT_FURNITURE')).toBeNull();
    expect(v2TypeForRubric({ canonicalType: 'BON_COMMANDE' }, null)).toBeNull();
    expect(v2TypeForRubric({ canonicalType: 'BON_COMMANDE' }, 'INCONNUE')).toBeNull();
  });
});

describe('L86E-U-04 — classement T1 (garde-fou de sortie)', () => {
  const tout = RUBRICS.map((r) => r.code);
  const familles = ['IMMOBILIER'] as const;

  it('Tikamoon : rubrique Équipements et mobilier, type « Bon de commande » enregistré même sans type V2 proposé', () => {
    const p = validateProposal({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: null, canonicalType: 'BON_COMMANDE', confidence: 0.95, excerpt: 'Bon de commande' }, tout, [...familles]);
    expect(p).toEqual(expect.objectContaining({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: 'ACQUISITION_ORDER', confidence: 0.95 }));
    const q = validateProposal({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: 'ACQUISITION_ORDER', confidence: 0.95, excerpt: '' }, tout, [...familles]);
    expect(q?.documentTypeCode).toBe('ACQUISITION_ORDER');
  });

  it('les factures d’autres domaines restent dans leur rubrique', () => {
    const travaux = validateProposal({ rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: 'WORKS_INVOICE', canonicalType: 'FACTURE', confidence: 0.95, excerpt: '' }, tout, [...familles]);
    expect(travaux).toEqual(expect.objectContaining({ rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: 'WORKS_INVOICE' }));
    const assurance = validateProposal({ rubricCode: 'INSURANCE_CLAIMS', documentTypeCode: 'INSURANCE_DUE_NOTICE', canonicalType: 'AVIS_ECHEANCE', confidence: 0.95, excerpt: '' }, tout, [...familles]);
    expect(assurance).toEqual(expect.objectContaining({ rubricCode: 'INSURANCE_CLAIMS', documentTypeCode: 'INSURANCE_DUE_NOTICE' }));
  });

  it('un « Autre » ou un type incohérent n’est jamais enregistré par l’analyse (DOC-08)', () => {
    expect(validateProposal({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: 'OTHER_EQUIPMENT_FURNITURE', confidence: 1, excerpt: '' }, tout, [...familles])?.documentTypeCode).toBeNull();
    expect(validateProposal({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: 'REPAIR_INVOICE', canonicalType: 'FACTURE', confidence: 1, excerpt: '' }, tout, [...familles])?.documentTypeCode).toBeNull();
  });

  it('sans rubrique proposée, un type réutilisable ne range pas d’office (domaine non prouvé)', () => {
    expect(deduceFromType('ACQUISITION_ORDER')).toEqual(expect.objectContaining({ rubricCode: 'PROPERTY_MANAGEMENT', confidence: DOMAIN_NOT_PROVEN_CONFIDENCE }));
    expect(DOMAIN_NOT_PROVEN_CONFIDENCE).toBeLessThan(0.9);
    expect(deduceFromType('REPAIR_INVOICE')?.confidence).toBe(1);
  });
});

describe('L86E-U-05 — règles de classement (§2.2, §5.1) avec types réutilisables', () => {
  const vide = { rubricCode: null, documentTypeCode: null, rubricOrigin: null, typeOrigin: null, rubricUserValidated: false, typeUserValidated: false } as const;

  it('un type réutilisable garde la rubrique courante', () => {
    const r = applyClassificationChange({ current: { ...vide, rubricCode: 'EQUIPMENT_FURNITURE', rubricOrigin: 'DOCUMENT_EXTRACTION' }, nextType: 'ACQUISITION_ORDER', origin: 'DOCUMENT_EXTRACTION' });
    expect(r.result).toEqual(expect.objectContaining({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: 'ACQUISITION_ORDER' }));
  });

  it('déplacé par l’utilisateur : type conservé s’il est proposé dans la nouvelle rubrique, vidé sinon', () => {
    const courant = { ...vide, rubricCode: 'PROPERTY_MANAGEMENT' as const, documentTypeCode: 'ACQUISITION_ORDER', rubricOrigin: 'DOCUMENT_EXTRACTION' as const, typeOrigin: 'DOCUMENT_EXTRACTION' as const };
    expect(applyClassificationChange({ current: courant, nextRubric: 'EQUIPMENT_FURNITURE', origin: 'USER' }).result)
      .toEqual(expect.objectContaining({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: 'ACQUISITION_ORDER', rubricUserValidated: true }));
    expect(applyClassificationChange({ current: courant, nextRubric: 'MAINTENANCE_WORKS', origin: 'USER' }).result)
      .toEqual(expect.objectContaining({ rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: null }));
  });

  it('la rubrique choisie par l’utilisateur n’est jamais déplacée par un type de l’analyse', () => {
    const courant = { ...vide, rubricCode: 'CONTRACTS_WARRANTIES_DOCS' as const, rubricOrigin: 'USER' as const, rubricUserValidated: true };
    const r = applyClassificationChange({ current: courant, nextType: 'ACQUISITION_ORDER', origin: 'DOCUMENT_EXTRACTION' });
    expect(r.result.rubricCode).toBe('CONTRACTS_WARRANTIES_DOCS');
    expect(r.result.documentTypeCode).toBeNull();
    expect(rubricForType('ACQUISITION_ORDER', 'CONTRACTS_WARRANTIES_DOCS')).toBe('PROPERTY_MANAGEMENT');
    expect(rubricForType('USER_MANUAL', 'EQUIPMENT_FURNITURE')).toBe('EQUIPMENT_FURNITURE');
  });
});

describe('L86E-U-06 — type affiché = type enregistré (une seule correspondance)', () => {
  it('libellé du type V2 enregistré, sinon « Type à compléter » — jamais « Autre » ni un code brut', () => {
    expect(documentTypeDisplayLabel(null)).toBe('Type à compléter');
    expect(documentTypeDisplayLabel('BON_COMMANDE')).toBe('Type à compléter');
    expect(documentTypeDisplayLabel('AUTRE')).toBe('Type à compléter');
    expect(documentTypeDisplayLabel('OTHER_EQUIPMENT_FURNITURE')).toBe('Autre');
  });

  it('tiroir document (desktop et mobile) : en-tête et informations lisent le type enregistré', () => {
    const tiroir = read('src/components/assets/DocumentDrawer.tsx');
    expect(tiroir).toMatch(/documentTypeDisplayLabel\(fullData\.documentTypeCode\)/);
    expect(tiroir).toMatch(/\{rubricTypeLabels\(fullData\)\.type\}/);
    // Plus de « normalisation » V1 → AUTRE à l'enregistrement, ni de libellé V1.
    expect(tiroir).not.toMatch(/resolveDocumentTypeCode/);
    expect(tiroir).not.toMatch(/FALLBACK_TYPE_LABELS|getTypeLabel/);
    expect(tiroir).not.toMatch(/documentType: (?:f|rf)\.documentType \?\? (?:f|rf)\.document_type \?\? 'AUTRE'/);
    expect(tiroir).not.toMatch(/userEdited\.retainedFunctionCode = true/);
  });

  it('Mes documents, équipement : même libellé ; route PUT : code V1 facultatif et jamais réécrit', () => {
    expect(read('src/components/documents/v2/DocumentsByRubric.tsx')).toMatch(/documentTypeCode: doc\.documentTypeCode \?\? null/);
    expect(read('src/app/api/equipments/[id]/documents/route.ts')).toMatch(/documentTypeLabel: documentTypeDisplayLabel\(doc\.documentTypeCode\)/);
    const route = read('src/app/api/documents/[id]/route.ts');
    expect(route).toMatch(/const typeModifie = documentType !== undefined && documentType !== null && documentType !== oldDoc\.documentType/);
    expect(route).toMatch(/\.\.\.\(typeModifie \? \{ documentType \} : \{\}\)/);
  });

  it('champs Rubrique / Type du tiroir : règles multi-rubriques', async () => {
    const { onRubricChange, onTypeChange, rubricTypeLabels } = await import('@/components/documents/v2/RubricTypeFields');
    expect(onRubricChange({ rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'ACQUISITION_ORDER' }, 'EQUIPMENT_FURNITURE'))
      .toEqual({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: 'ACQUISITION_ORDER' });
    expect(onRubricChange({ rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'ACQUISITION_ORDER' }, 'MAINTENANCE_WORKS'))
      .toEqual({ rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: null });
    expect(onTypeChange({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: null }, 'TECHNICAL_SHEET'))
      .toEqual({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: 'TECHNICAL_SHEET' });
    expect(onTypeChange({ rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: null }, 'TECHNICAL_SHEET'))
      .toEqual({ rubricCode: 'CONTRACTS_WARRANTIES_DOCS', documentTypeCode: 'TECHNICAL_SHEET' });
    expect(onTypeChange({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: 'USER_MANUAL' }, null))
      .toEqual({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: null });
    expect(rubricTypeLabels({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: null }))
      .toEqual({ rubric: 'Équipements et mobilier', type: 'Type à compléter' });
  });
});

describe('L86E-U-07 — exports, TCO, assistant : la nouvelle nature est connue', () => {
  it('le devis d’achat reste un devis (jamais un coût réalisé, jamais une dépense)', () => {
    expect(read('src/services/business-operations/finance/economic-lines.ts')).toMatch(/QUOTE_REASONS = new Set\(\[[^\]]*'ACQUISITION_QUOTE'/);
    expect(read('src/services/verebona-assistant/canonical/expense-classes.ts')).toMatch(/EXCLUDED_V2 = new Set\(\[[^\]]*'ACQUISITION_QUOTE'/);
    expect(read('src/services/exports/v12/data/documents.ts')).toMatch(/ACQUISITION_QUOTE: 'DEVIS'/);
    expect(isTypeCompatibleWithRubric('ACQUISITION_QUOTE', 'EQUIPMENT_FURNITURE')).toBe(true);
  });
});

describe('L86E-U-08 — un achat de meuble ou d’appareil n’est jamais l’acquisition du bien', async () => {
  const { classifyPurpose } = await import('@/services/ai/source-analysis/projection/rules');
  const { resolveDocumentType } = await import('@/services/canonical/registry');
  const facture = resolveDocumentType('FACTURE');
  const base = { entry: facture, documentTypeCode: 'ACQUISITION_INVOICE', purchaseTargets: [], acquisitionClaims: ['ASSET'], serviceEvents: 0 };

  it('« Facture d’achat » rangée en Équipements et mobilier : achat d’un équipement (PART_PURCHASE)', () => {
    expect(classifyPurpose({ ...base, rubricCode: 'EQUIPMENT_FURNITURE' })).toBe('PART_PURCHASE');
  });

  it('dans sa rubrique d’attache, ou sans rubrique : comportement inchangé (acquisition du bien)', () => {
    expect(classifyPurpose({ ...base, rubricCode: 'PROPERTY_MANAGEMENT' })).toBe('ASSET_PURCHASE');
    expect(classifyPurpose({ ...base })).toBe('ASSET_PURCHASE');
  });
});

describe('L86E-U-COH — contrôle COH-DOC-CLASSIFICATION (diagnostic pur, sans IA)', () => {
  const base = {
    fileId: 1, rubricCode: 'OTHER_DOCUMENTS', documentTypeCode: null, rubricUserValidated: false, typeUserValidated: false,
    referentialVersion: '2.1.0', identifiedType: 'BON_COMMANDE', t1DocumentTypeCode: null, rubricConfidence: 0.95, analysisInProgress: false,
  };

  it('classement automatique antérieur à la rubrique, nature qui en relève : réévaluation par T1', () => {
    expect(diagnoseDocumentClassification(base)).toEqual(expect.objectContaining({
      verdict: 'REPAIRABLE', anomaly: 'CLASSIFIED_BEFORE_RUBRIC', repair: 'REEVALUATE_T1', newRubrics: ['EQUIPMENT_FURNITURE'],
    }));
    // Une facture de travaux classée avant 2.2.0 ne relève pas de la nouvelle rubrique.
    expect(diagnoseDocumentClassification({ ...base, rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: 'WORKS_INVOICE', identifiedType: 'FACTURE' }).verdict).toBe('CONSISTENT');
  });

  it('choix de l’utilisateur conservé : aucune réévaluation de sa rubrique', () => {
    expect(diagnoseDocumentClassification({ ...base, rubricUserValidated: true }).verdict).toBe('CONSISTENT');
    expect(diagnoseDocumentClassification({ ...base, rubricCode: 'EQUIPMENT_FURNITURE', referentialVersion: '2.2.0', typeUserValidated: true }).verdict).toBe('CONSISTENT');
  });

  it('nature identifiée mais type non enregistré : type enregistré par la correspondance unique', () => {
    expect(diagnoseDocumentClassification({ ...base, rubricCode: 'EQUIPMENT_FURNITURE', referentialVersion: '2.2.0' })).toEqual(expect.objectContaining({
      verdict: 'REPAIRABLE', anomaly: 'IDENTIFIED_TYPE_NOT_RECORDED', repair: 'RECORD_TYPE', expectedType: 'ACQUISITION_ORDER',
    }));
    expect(diagnoseDocumentClassification({ ...base, rubricCode: 'MAINTENANCE_WORKS', identifiedType: 'FACTURE', referentialVersion: '2.2.0' }).verdict).toBe('CONSISTENT');
  });

  it('type hors de sa rubrique : réparé s’il existe un type de même nature, constat sinon', () => {
    expect(diagnoseDocumentClassification({ ...base, rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: 'ACQUISITION_ORDER', referentialVersion: '2.2.0' }))
      .toEqual(expect.objectContaining({ anomaly: 'TYPE_NOT_IN_RUBRIC', repair: 'RECORD_TYPE', expectedType: 'WORKS_PURCHASE_ORDER' }));
    expect(diagnoseDocumentClassification({ ...base, rubricCode: 'MEDIA', documentTypeCode: 'ACQUISITION_ORDER', referentialVersion: '2.2.0', identifiedType: null }))
      .toEqual(expect.objectContaining({ verdict: 'FINDING', anomaly: 'TYPE_NOT_IN_RUBRIC' }));
  });

  it('registré en fin de registre (position relative), domaine de couverture déclaré', () => {
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    expect(ids.indexOf('COH-DOC-CLASSIFICATION')).toBeGreaterThan(ids.indexOf('COH-T1-KNOWLEDGE-CONSUMPTION'));
    expect(COVERAGE_INVENTORY.find((d) => d.domain === 'documents-classement')?.checks).toContain('COH-DOC-CLASSIFICATION');
    const c = COHERENCE_REGISTRY.find((x) => x.id === 'COH-DOC-CLASSIFICATION')!;
    expect(c.forbiddenRepairs.join(' ')).toMatch(/règle lexicale/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/Agenda ou à une Opération/);
  });
});
