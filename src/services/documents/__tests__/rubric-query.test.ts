/**
 * Regroupement documentaire par Rubrique — CDC V2.0 §3.3, §4.4, §6.2.
 *
 * Les critères DOC-04 et DOC-05 se jouent entièrement dans l'ordre des
 * groupes. C'est une règle qu'une refonte de l'écran casserait sans s'en
 * apercevoir : rien ne plante, « Autres documents » remonte simplement au
 * milieu de la liste.
 */
import { describe, it, expect } from 'vitest';
import {
  UNFILED_GROUP,
  orderGroups,
  type RubricGroupView,
} from '@/services/documents/rubric-query.service';
import { getVisibleRubrics } from '@/lib/referential/v2';

const group = (code: string, count: number, label = code): RubricGroupView => ({
  code,
  label,
  count,
  documents: [],
  hasMore: false,
});

const visible = getVisibleRubrics({
  families: ['IMMOBILIER'],
  hasRentedAsset: true,
  hasRentalDocuments: false,
});

describe('ordre des groupes (§3.3, §4.4)', () => {
  const groups = visible.map((r) => group(r.code, r.code === 'MEDIA' ? 0 : 3));

  it('DOC-05 — « Autres documents » est toujours en dernier', () => {
    const ordered = orderGroups(groups, visible, null);
    expect(ordered[ordered.length - 1].code).toBe('OTHER_DOCUMENTS');
  });

  it('« Sans rubrique » passe avant toutes les Rubriques', () => {
    const ordered = orderGroups(groups, visible, group(UNFILED_GROUP, 2, 'Sans rubrique'));
    expect(ordered[0].code).toBe(UNFILED_GROUP);
    expect(ordered[ordered.length - 1].code).toBe('OTHER_DOCUMENTS');
  });

  it('DOC-04 — « Sans rubrique » disparaît à 0, les Rubriques métier restent', () => {
    const ordered = orderGroups(groups, visible, group(UNFILED_GROUP, 0, 'Sans rubrique'));
    expect(ordered.some((g) => g.code === UNFILED_GROUP)).toBe(false);
    // MEDIA est à 0 et reste pourtant listée : une Rubrique vide dit « rien
    // ici pour l'instant », une zone « Sans rubrique » vide ne dirait rien.
    expect(ordered.some((g) => g.code === 'MEDIA')).toBe(true);
  });

  it('respecte l’ordre d’affichage du référentiel', () => {
    const codes = orderGroups(groups, visible, null).map((g) => g.code);
    expect(codes.indexOf('PROPERTY_MANAGEMENT')).toBeLessThan(codes.indexOf('MAINTENANCE_WORKS'));
    expect(codes.indexOf('MAINTENANCE_WORKS')).toBeLessThan(codes.indexOf('MEDIA'));
  });

  it('un groupe hors référentiel ne remonte jamais avant les Rubriques connues', () => {
    const ordered = orderGroups([...groups, group('CODE_INCONNU', 1)], visible, null);
    expect(ordered[0].code).not.toBe('CODE_INCONNU');
  });
});

describe('Gestion locative contextuelle dans les groupes (§6.2)', () => {
  it('RENT-02 — listée à 0 dès qu’un bien est marqué loué', () => {
    const rubrics = getVisibleRubrics({
      families: ['IMMOBILIER'],
      hasRentedAsset: true,
      hasRentalDocuments: false,
    });
    const ordered = orderGroups(
      rubrics.map((r) => group(r.code, 0)),
      rubrics,
      null,
    );
    expect(ordered.some((g) => g.code === 'RENTAL_MANAGEMENT')).toBe(true);
  });

  it('RENT-03 — reste listée pour les documents historiques', () => {
    const rubrics = getVisibleRubrics({
      families: ['IMMOBILIER'],
      hasRentedAsset: false,
      hasRentalDocuments: true,
    });
    expect(rubrics.some((r) => r.code === 'RENTAL_MANAGEMENT')).toBe(true);
  });

  it('absente sans bien loué ni document locatif', () => {
    const rubrics = getVisibleRubrics({
      families: ['IMMOBILIER'],
      hasRentedAsset: false,
      hasRentalDocuments: false,
    });
    expect(rubrics.some((r) => r.code === 'RENTAL_MANAGEMENT')).toBe(false);
  });
});
