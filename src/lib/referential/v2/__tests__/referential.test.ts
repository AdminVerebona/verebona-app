/**
 * Référentiel V2 — CDC V2.0 §2.2, §3, §6.2, §11.4, §13.2.
 *
 * Les critères de recette DOC-05, DOC-06, DOC-08, RENT-02 et RENT-03 se
 * jouent entièrement ici : ce sont des propriétés du référentiel, pas des
 * comportements d'écran.
 */
import { describe, it, expect } from 'vitest';
import {
  AI_CONFIDENCE_THRESHOLD,
  DOCUMENT_TYPES,
  REFERENTIAL_VERSION,
  RUBRICS,
  assertReferentialIntegrity,
  buildPromptReferential,
  checkReferentialIntegrity,
  getTypesForRubric,
  getVisibleRubrics,
  isAiSelectable,
  isTypeCompatibleWithRubric,
  rubricOfType,
} from '@/lib/referential/v2';
import {
  LEGACY_ACTION_FAMILY_MAP,
  LEGACY_PRIORITY_MAP,
  resolveLegacyType,
} from '@/lib/referential/v2/legacy-mapping';

describe('intégrité du référentiel (§13.2)', () => {
  it('ne présente aucune violation', () => {
    expect(checkReferentialIntegrity()).toEqual([]);
    expect(() => assertReferentialIntegrity()).not.toThrow();
  });

  it('DOC-06 — un Type n’appartient qu’à une seule Rubrique', () => {
    const byCode = new Map<string, string>();
    for (const type of DOCUMENT_TYPES) {
      expect(byCode.has(type.code)).toBe(false);
      byCode.set(type.code, type.rubric);
    }
    // L'invariant est structurel : un Type n'a qu'un champ `rubric`.
    expect(byCode.size).toBe(DOCUMENT_TYPES.length);
  });

  it('chaque Rubrique porte son propre Type « Autre » (§2.2)', () => {
    for (const rubric of RUBRICS) {
      const others = getTypesForRubric(rubric.code).filter((t) => t.userOnly);
      expect(others.length).toBeGreaterThanOrEqual(1);
      expect(others[0].label).toBe('Autre');
      // Codes distincts : un « AUTRE » unique recréerait le type multi-rubriques.
      expect(others[0].code).not.toBe('AUTRE');
    }
  });

  it('expose la version et le seuil du §11.2', () => {
    expect(REFERENTIAL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(AI_CONFIDENCE_THRESHOLD).toBe(0.9);
  });
});

describe('ordre et visibilité (§3.3)', () => {
  it('DOC-05 — « Autres documents » est toujours en dernier', () => {
    const visible = getVisibleRubrics({
      families: ['IMMOBILIER'],
      hasRentedAsset: true,
      hasRentalDocuments: false,
    });
    expect(visible[visible.length - 1].code).toBe('OTHER_DOCUMENTS');
  });

  it('« Autre » est le dernier Type de sa Rubrique', () => {
    const types = getTypesForRubric('MAINTENANCE_WORKS');
    expect(types[types.length - 1].userOnly).toBe(true);
  });

  it('écarte les Rubriques hors du périmètre des familles présentes', () => {
    const codes = getVisibleRubrics({
      families: ['VEHICULE'],
      hasRentedAsset: false,
      hasRentalDocuments: false,
    }).map((r) => r.code);
    expect(codes).not.toContain('RENTAL_MANAGEMENT');
    expect(codes).toContain('MAINTENANCE_WORKS');
  });
});

describe('Gestion locative contextuelle (§6.2)', () => {
  const immo = { families: ['IMMOBILIER'] as const };

  it('RENT-02 — visible à 0 lorsqu’un bien est marqué Oui', () => {
    const codes = getVisibleRubrics({
      ...immo,
      hasRentedAsset: true,
      hasRentalDocuments: false,
    }).map((r) => r.code);
    expect(codes).toContain('RENTAL_MANAGEMENT');
  });

  it('RENT-03 — reste visible pour les documents historiques', () => {
    const codes = getVisibleRubrics({
      ...immo,
      hasRentedAsset: false,
      hasRentalDocuments: true,
    }).map((r) => r.code);
    expect(codes).toContain('RENTAL_MANAGEMENT');
  });

  it('masquée sans bien loué ni document locatif', () => {
    const codes = getVisibleRubrics({
      ...immo,
      hasRentedAsset: false,
      hasRentalDocuments: false,
    }).map((r) => r.code);
    expect(codes).not.toContain('RENTAL_MANAGEMENT');
  });
});

describe('Type « Autre » réservé à l’utilisateur (§5.2, DOC-08)', () => {
  it('n’est jamais sélectionnable par l’IA', () => {
    const userOnly = DOCUMENT_TYPES.filter((t) => t.userOnly);
    expect(userOnly.length).toBe(RUBRICS.length);
    for (const type of userOnly) {
      expect(isAiSelectable(type.code)).toBe(false);
    }
  });

  it('n’apparaît pas dans la projection transmise au prompt (§11.4)', () => {
    const projection = buildPromptReferential();
    const codes = projection.rubrics.flatMap((r) => r.types.map((t) => t.code));
    for (const type of DOCUMENT_TYPES.filter((t) => t.userOnly)) {
      expect(codes).not.toContain(type.code);
    }
    // La projection porte la version : c'est elle qui datera les décisions.
    expect(projection.version).toBe(REFERENTIAL_VERSION);
  });

  it('transmet les exclusions, pas seulement les finalités (§3.4)', () => {
    for (const rubric of buildPromptReferential().rubrics) {
      expect(rubric.exclusions.length).toBeGreaterThan(20);
    }
  });
});

describe('déduction de la Rubrique (§2.2)', () => {
  it('une facture de réparation relève de l’entretien, pas de l’acquisition', () => {
    expect(rubricOfType('REPAIR_INVOICE')).toBe('MAINTENANCE_WORKS');
    expect(rubricOfType('ACQUISITION_INVOICE')).toBe('PROPERTY_MANAGEMENT');
  });

  it('un Type inconnu ne déduit rien', () => {
    expect(rubricOfType('FACTURE')).toBeNull();
    expect(rubricOfType(null)).toBeNull();
  });

  it('la compatibilité est exacte, jamais multiple', () => {
    expect(isTypeCompatibleWithRubric('DPE', 'COMPLIANCE_CONTROLS')).toBe(true);
    expect(isTypeCompatibleWithRubric('DPE', 'PROPERTY_MANAGEMENT')).toBe(false);
  });
});

describe('correspondance V1 → V2 (§15, Annexe B)', () => {
  it('mappe les Types univoques', () => {
    const resolution = resolveLegacyType({ typeCode: 'DPE', userSelected: true });
    expect(resolution.verdict).toBe('MAPPED');
    expect(resolution.typeCode).toBe('DPE');
    expect(resolution.rubricCode).toBe('COMPLIANCE_CONTROLS');
  });

  it('refuse de deviner la cible des Types multi-rubriques', () => {
    for (const code of ['FACTURE', 'DEVIS', 'CONTRAT', 'EXPERTISE']) {
      expect(resolveLegacyType({ typeCode: code, userSelected: true }).verdict).toBe(
        'NEEDS_REPROCESSING',
      );
    }
  });

  it('abandonne les pseudo-types de sujet', () => {
    expect(
      resolveLegacyType({ typeCode: 'ISOLATION_TOITURE', userSelected: false }).verdict,
    ).toBe('DROPPED');
    expect(
      resolveLegacyType({ typeCode: 'EQUIPEMENT_CHAUFFAGE', userSelected: true }).verdict,
    ).toBe('DROPPED');
  });

  it('ne prend pas un AUTRE technique pour un choix utilisateur (§15.1)', () => {
    const technical = resolveLegacyType({ typeCode: 'AUTRE', userSelected: false });
    expect(technical.verdict).toBe('NEEDS_REPROCESSING');
    expect(technical.reason).toContain('non renseigné');
  });

  it('mappe les natures d’action et les priorités (§15.3)', () => {
    expect(LEGACY_ACTION_FAMILY_MAP['a_confirmer']).toBe('ARBITRATE');
    expect(LEGACY_ACTION_FAMILY_MAP['a_rattacher']).toBe('ARBITRATE');
    expect(LEGACY_ACTION_FAMILY_MAP['a_completer']).toBe('COMPLETE');
    expect(LEGACY_PRIORITY_MAP['HIGH']).toBe('DO_FIRST');
    expect(LEGACY_PRIORITY_MAP['LOW']).toBe('CAN_WAIT');
  });
});
