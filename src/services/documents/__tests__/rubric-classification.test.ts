/**
 * Classement V2 — CDC V2.0 §2.2, §4.4, §5.1, §5.2, §11.6.
 *
 * Critères couverts : DOC-02, DOC-03, DOC-07, DOC-08, AI-02, AI-05.
 * Le point de bascule avec la V1 — « le Type absent n'empêche plus le
 * rangement » — est vérifié en premier : c'est celui qu'une régression
 * ramènerait sans bruit.
 */
import { describe, it, expect } from 'vitest';
import {
  applyClassificationChange,
  isFiled,
  isSettledOtherType,
  isUnfiled,
  needsReprocessing,
  type DocumentClassification,
} from '@/services/documents/rubric-classification';
import { REFERENTIAL_VERSION } from '@/lib/referential/v2';
import {
  ACTION_KIND_LABELS,
  FORBIDDEN_UX_TERMS,
  MICROCOPY,
  myDocumentsHeadline,
  toProcessHeadline,
} from '@/lib/referential/v2/microcopy';

const empty: DocumentClassification = {
  rubricCode: null,
  documentTypeCode: null,
  rubricOrigin: null,
  typeOrigin: null,
  rubricUserValidated: false,
  typeUserValidated: false,
};

describe('rangement par Rubrique seule (§2.2)', () => {
  it('DOC-02 — une Rubrique sans Type suffit à ranger le document', () => {
    const { result } = applyClassificationChange({
      current: empty,
      nextRubric: 'MAINTENANCE_WORKS',
      origin: 'USER',
    });
    expect(result.rubricCode).toBe('MAINTENANCE_WORKS');
    expect(result.documentTypeCode).toBeNull();
    expect(isFiled(result)).toBe(true);
  });

  it('sans Rubrique, le document est « Sans rubrique »', () => {
    expect(isUnfiled(empty)).toBe(true);
  });

  it('la Rubrique est déduite du Type (§2.2)', () => {
    const { result, changes } = applyClassificationChange({
      current: empty,
      nextType: 'REPAIR_INVOICE',
      origin: 'RECONCILIATION',
    });
    expect(result.rubricCode).toBe('MAINTENANCE_WORKS');
    expect(changes.some((c) => c.includes('déduite'))).toBe(true);
  });
});

describe('cohérence Rubrique / Type (§5.1)', () => {
  it('DOC-07 — changer de Rubrique vide un Type incompatible', () => {
    const current: DocumentClassification = {
      ...empty,
      rubricCode: 'MAINTENANCE_WORKS',
      documentTypeCode: 'REPAIR_INVOICE',
      typeOrigin: 'RECONCILIATION',
    };
    const { result } = applyClassificationChange({
      current,
      nextRubric: 'COMPLIANCE_CONTROLS',
      origin: 'USER',
    });
    expect(result.rubricCode).toBe('COMPLIANCE_CONTROLS');
    expect(result.documentTypeCode).toBeNull();
  });

  it('conserve le Type lorsqu’il appartient à la nouvelle Rubrique', () => {
    const current: DocumentClassification = {
      ...empty,
      rubricCode: 'MAINTENANCE_WORKS',
      documentTypeCode: 'REPAIR_INVOICE',
    };
    const { result } = applyClassificationChange({
      current,
      nextRubric: 'MAINTENANCE_WORKS',
      origin: 'USER',
    });
    expect(result.documentTypeCode).toBe('REPAIR_INVOICE');
  });
});

describe('protection des valeurs utilisateur (§12.2, AI-02)', () => {
  const userFiled: DocumentClassification = {
    ...empty,
    rubricCode: 'PROPERTY_MANAGEMENT',
    rubricOrigin: 'USER',
    rubricUserValidated: true,
  };

  it('l’IA ne réécrit pas une Rubrique validée', () => {
    const { result, rejected } = applyClassificationChange({
      current: userFiled,
      nextRubric: 'MAINTENANCE_WORKS',
      origin: 'RECONCILIATION',
    });
    expect(result.rubricCode).toBe('PROPERTY_MANAGEMENT');
    expect(rejected.length).toBe(1);
  });

  it('ni par la bande, via un Type d’une autre Rubrique', () => {
    const { result, rejected } = applyClassificationChange({
      current: userFiled,
      nextType: 'REPAIR_INVOICE',
      origin: 'RECONCILIATION',
    });
    expect(result.rubricCode).toBe('PROPERTY_MANAGEMENT');
    expect(result.documentTypeCode).toBeNull();
    expect(rejected.some((r) => r.includes('contredit'))).toBe(true);
  });

  it('l’utilisateur, lui, peut tout changer', () => {
    const { result } = applyClassificationChange({
      current: userFiled,
      nextRubric: 'MAINTENANCE_WORKS',
      origin: 'USER',
    });
    expect(result.rubricCode).toBe('MAINTENANCE_WORKS');
    expect(result.rubricUserValidated).toBe(true);
  });
});

describe('Type « Autre » (§5.2, DOC-04, DOC-08)', () => {
  it('DOC-08 — l’IA ne peut pas le sélectionner', () => {
    const { result, rejected } = applyClassificationChange({
      current: { ...empty, rubricCode: 'MEDIA' },
      nextType: 'OTHER_MEDIA',
      origin: 'RECONCILIATION',
    });
    expect(result.documentTypeCode).toBeNull();
    expect(rejected.some((r) => r.includes('DOC-08'))).toBe(true);
  });

  it('l’utilisateur peut le choisir, et le choix est définitif', () => {
    const { result } = applyClassificationChange({
      current: { ...empty, rubricCode: 'MEDIA' },
      nextType: 'OTHER_MEDIA',
      origin: 'USER',
    });
    expect(result.documentTypeCode).toBe('OTHER_MEDIA');
    expect(isSettledOtherType(result)).toBe(true);
  });
});

describe('applicabilité aux biens rattachés (§4.4)', () => {
  it('retire une Rubrique inapplicable posée automatiquement', () => {
    const { result, changes } = applyClassificationChange({
      current: {
        ...empty,
        rubricCode: 'RENTAL_MANAGEMENT',
        rubricOrigin: 'RECONCILIATION',
      },
      origin: 'RECONCILIATION',
      assetFamilies: ['VEHICULE'],
    });
    expect(result.rubricCode).toBeNull();
    expect(changes.some((c) => c.includes('inapplicable'))).toBe(true);
  });

  it('conserve une Rubrique inapplicable validée par l’utilisateur', () => {
    const { result, rejected } = applyClassificationChange({
      current: {
        ...empty,
        rubricCode: 'RENTAL_MANAGEMENT',
        rubricOrigin: 'USER',
        rubricUserValidated: true,
      },
      origin: 'RECONCILIATION',
      assetFamilies: ['VEHICULE'],
    });
    expect(result.rubricCode).toBe('RENTAL_MANAGEMENT');
    expect(rejected.length).toBe(1);
  });
});

describe('évolution du référentiel (§11.6, AI-05)', () => {
  it('marque chaque décision avec la version courante', () => {
    const { referentialVersion } = applyClassificationChange({
      current: empty,
      nextRubric: 'MEDIA',
      origin: 'USER',
    });
    expect(referentialVersion).toBe(REFERENTIAL_VERSION);
  });

  it('AI-05 — tout document d’une version antérieure est à retraiter', () => {
    expect(needsReprocessing('1.9.0')).toBe(true);
    expect(needsReprocessing(null)).toBe(true);
    expect(needsReprocessing(REFERENTIAL_VERSION)).toBe(false);
  });
});

describe('microcopies (§17)', () => {
  it('§17.2 — le texte s’adapte au nombre et au mode', () => {
    expect(toProcessHeadline(0, 'BY_PRIORITY')).toBe('Rien à traiter pour le moment.');
    expect(toProcessHeadline(1, 'BY_ACTION')).toBe('1 action nécessite votre attention.');
    expect(toProcessHeadline(4, 'BY_PRIORITY')).toContain('affichées en premier');
    expect(toProcessHeadline(4, 'BY_ACTION')).toContain('classées par type');
  });

  it('§17.3 — « Sans rubrique » n’est annoncé que s’il contient quelque chose', () => {
    expect(myDocumentsHeadline(0)).toBe('Vos documents sont classés par rubrique.');
    expect(myDocumentsHeadline(3)).toContain('3 documents');
  });

  it('§17.1 — aucun terme technique dans les textes utilisateur', () => {
    const texts = [
      ...[0, 1, 5].flatMap((n) => [
        toProcessHeadline(n, 'BY_PRIORITY'),
        toProcessHeadline(n, 'BY_ACTION'),
      ]),
      myDocumentsHeadline(0),
      myDocumentsHeadline(2),
      ...Object.values(MICROCOPY),
      ...Object.values(ACTION_KIND_LABELS),
    ];

    for (const text of texts) {
      for (const term of FORBIDDEN_UX_TERMS) {
        expect(text.toLowerCase()).not.toContain(term.toLowerCase());
      }
    }
  });
});
