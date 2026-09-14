/**
 * Classement V2 par Rubrique — CDC V2.0 §2.2, §3.4, §11.4.
 *
 * Deux propriétés comptent plus que les autres, et sont testées en premier :
 * la déduction évite l'appel modèle (c'est tout l'intérêt de la scission des
 * Types V2), et le garde-fou de sortie ne laisse jamais passer un code hors
 * référentiel (DOC-06, DOC-08).
 */
import { describe, it, expect } from 'vitest';
import {
  deduceFromType,
  validateProposal,
} from '@/services/ai/source-analysis/steps/classify-rubric.step';
import { buildPromptReferential, DOCUMENT_TYPES } from '@/lib/referential/v2';

const ALL_RUBRICS = buildPromptReferential().rubrics.map((r) => r.code);

describe('déduction sans appel modèle (§2.2)', () => {
  it('déduit la Rubrique d’un Type V2', () => {
    const proposal = deduceFromType('REPAIR_INVOICE');
    expect(proposal?.rubricCode).toBe('MAINTENANCE_WORKS');
    expect(proposal?.documentTypeCode).toBe('REPAIR_INVOICE');
    // Une déduction du référentiel n'est pas une estimation.
    expect(proposal?.confidence).toBe(1);
  });

  it('déduit aussi depuis un Type V1 univoque', () => {
    const proposal = deduceFromType('DPE');
    expect(proposal?.rubricCode).toBe('COMPLIANCE_CONTROLS');
    expect(proposal?.documentTypeCode).toBe('DPE');
  });

  it('ne déduit rien d’un Type V1 générique — le modèle devra trancher', () => {
    // FACTURE admettait quatre catégories en V1 : sa cible V2 dépend de la
    // finalité du document, qu'aucune table ne peut deviner.
    expect(deduceFromType('FACTURE')).toBeNull();
    expect(deduceFromType('CONTRAT')).toBeNull();
  });

  it('DOC-08 — ne déduit jamais depuis un Type « Autre »', () => {
    for (const type of DOCUMENT_TYPES.filter((t) => t.userOnly)) {
      expect(deduceFromType(type.code)).toBeNull();
    }
  });

  it('ne déduit rien d’un pseudo-type de sujet', () => {
    expect(deduceFromType('ISOLATION_TOITURE')).toBeNull();
  });

  it('ne déduit rien sans Type', () => {
    expect(deduceFromType(null)).toBeNull();
    expect(deduceFromType(undefined)).toBeNull();
  });
});

describe('garde-fou de sortie modèle', () => {
  const families = ['IMMOBILIER'] as const;

  it('rejette une Rubrique hors périmètre', () => {
    const result = validateProposal(
      { rubricCode: 'INVENTED_RUBRIC', confidence: 0.99, excerpt: 'x' },
      ALL_RUBRICS,
      [...families],
    );
    expect(result).toBeNull();
  });

  it('conserve la Rubrique et écarte un Type incohérent', () => {
    // Ranger le document vaut mieux que le laisser « Sans rubrique » pour un
    // enrichissement raté : le Type manquant relève de DOC-TYP-03.
    const result = validateProposal(
      {
        rubricCode: 'MAINTENANCE_WORKS',
        documentTypeCode: 'DPE', // appartient à COMPLIANCE_CONTROLS
        confidence: 0.95,
        excerpt: 'x',
      },
      ALL_RUBRICS,
      [...families],
    );
    expect(result?.rubricCode).toBe('MAINTENANCE_WORKS');
    expect(result?.documentTypeCode).toBeNull();
  });

  it('DOC-08 — écarte un Type « Autre » proposé par le modèle', () => {
    const result = validateProposal(
      {
        rubricCode: 'MEDIA',
        documentTypeCode: 'OTHER_MEDIA',
        confidence: 0.99,
        excerpt: 'x',
      },
      ALL_RUBRICS,
      [...families],
    );
    expect(result?.rubricCode).toBe('MEDIA');
    expect(result?.documentTypeCode).toBeNull();
  });

  it('écarte un Type inapplicable aux biens rattachés (§4.4)', () => {
    const result = validateProposal(
      {
        rubricCode: 'COMPLIANCE_CONTROLS',
        documentTypeCode: 'VEHICLE_TECHNICAL_INSPECTION',
        confidence: 0.96,
        excerpt: 'x',
      },
      ALL_RUBRICS,
      ['IMMOBILIER'],
    );
    expect(result?.documentTypeCode).toBeNull();
  });

  it('accepte une proposition cohérente et conserve la confiance', () => {
    const result = validateProposal(
      {
        rubricCode: 'MAINTENANCE_WORKS',
        documentTypeCode: 'REPAIR_INVOICE',
        confidence: 0.94,
        excerpt: 'Remplacement du ballon',
      },
      ALL_RUBRICS,
      [...families],
    );
    expect(result).toEqual({
      rubricCode: 'MAINTENANCE_WORKS',
      documentTypeCode: 'REPAIR_INVOICE',
      confidence: 0.94,
      excerpt: 'Remplacement du ballon',
    });
  });

  it('une Rubrique sans Type reste un classement valide (§2.2)', () => {
    const result = validateProposal(
      { rubricCode: 'OTHER_DOCUMENTS', documentTypeCode: null, confidence: 0.4, excerpt: 'x' },
      ALL_RUBRICS,
      [...families],
    );
    expect(result?.rubricCode).toBe('OTHER_DOCUMENTS');
    expect(result?.documentTypeCode).toBeNull();
  });
});

describe('projection transmise au prompt (§11.4)', () => {
  it('porte finalité ET exclusions pour chaque Rubrique', () => {
    for (const rubric of buildPromptReferential().rubrics) {
      expect(rubric.purpose.length).toBeGreaterThan(20);
      expect(rubric.exclusions.length).toBeGreaterThan(20);
    }
  });

  it('ne contient aucun Type « Autre »', () => {
    const codes = buildPromptReferential().rubrics.flatMap((r) => r.types.map((t) => t.code));
    for (const type of DOCUMENT_TYPES.filter((t) => t.userOnly)) {
      expect(codes).not.toContain(type.code);
    }
  });
});
