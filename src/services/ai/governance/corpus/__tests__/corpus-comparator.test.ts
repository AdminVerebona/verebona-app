/**
 * Comparateur du corpus — CDC §11.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ON VÉRIFIE LE JUGE AVANT DE L'EMPLOYER
 *
 * Un harnais de non-régression dont la comparaison est fausse est pire
 * qu'aucun harnais : il valide des régressions, ou il crie au loup sur des
 * différences sans conséquence. Dans les deux cas, on cesse rapidement de le
 * lire — et c'est là qu'une vraie régression passe.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import {
  parseFrenchNumber,
  normalizeDate,
  normalizeText,
  compareField,
  compareCase,
  summarize,
  detectRegressions,
  type ObservedResult,
  type CaseComparison,
} from '@/services/ai/governance/corpus/corpus-comparator';
import type { CorpusCase } from '@/services/ai/governance/corpus/corpus-registry';

describe('lecture des nombres français', () => {
  it('lit une virgule décimale', () => {
    expect(parseFrenchNumber('78,40')).toBe(78.4);
  });

  it('lit un montant avec espace insécable et symbole', () => {
    // C'est la forme réelle d'un montant dans un document français, et la
    // cause d'échec la plus fréquente d'une comparaison naïve.
    expect(parseFrenchNumber('1 228,00 €')).toBe(1228);
    expect(parseFrenchNumber('10\u202F834,85 €')).toBe(10834.85);
  });

  it('lit une surface avec son unité', () => {
    expect(parseFrenchNumber('78,40 m²')).toBe(78.4);
    expect(parseFrenchNumber('218 kWh')).toBe(218);
  });

  it('accepte un nombre déjà typé', () => {
    expect(parseFrenchNumber(245000)).toBe(245000);
  });

  it('rend null sur l’illisible', () => {
    expect(parseFrenchNumber('illisible')).toBeNull();
    expect(parseFrenchNumber(null)).toBeNull();
    expect(parseFrenchNumber(NaN)).toBeNull();
  });
});

describe('normalisation des dates', () => {
  it('accepte le format ISO', () => {
    expect(normalizeDate('2025-03-14')).toBe('2025-03-14');
    expect(normalizeDate('2025-03-14T10:00:00Z')).toBe('2025-03-14');
  });

  it('accepte le format français', () => {
    expect(normalizeDate('14/03/2025')).toBe('2025-03-14');
  });

  it('accepte un objet Date', () => {
    expect(normalizeDate(new Date('2025-03-14T12:00:00Z'))).toBe('2025-03-14');
  });

  it('rend null sur une date non reconnue', () => {
    expect(normalizeDate('mars 2025')).toBeNull();
  });
});

describe('normalisation du texte', () => {
  it('ignore casse, accents et ponctuation', () => {
    expect(normalizeText('CITROËN')).toBe(normalizeText('citroen'));
    expect(normalizeText('GK-482-RT')).toBe(normalizeText('gk482rt'));
  });
});

describe('comparaison d’un champ', () => {
  it('accepte un montant à la tolérance près', () => {
    expect(compareField('montantTotal', 1228, '1 228,00 €')).toBe('match');
    expect(compareField('montantTotal', 1228, 1228.004)).toBe('match');
  });

  it('refuse une inversion de chiffres', () => {
    // 245 000 contre 254 000 : neuf mille euros d'écart, à ne jamais tolérer.
    expect(compareField('prixAchat', 245000, 254000)).toBe('mismatch');
  });

  it('tolère les petites valeurs sans les confondre', () => {
    expect(compareField('bonusMalus', 0.64, 0.64)).toBe('match');
    expect(compareField('bonusMalus', 0.64, 0.72)).toBe('mismatch');
  });

  it('exige une plaque exacte', () => {
    // Une plaque approximative ne désigne aucun véhicule.
    expect(compareField('immatriculation', 'GK-482-RT', 'GK 482 RT')).toBe('match');
    expect(compareField('immatriculation', 'GK-482-RT', 'GK-482-RJ')).toBe('mismatch');
  });

  it('exige un VIN exact', () => {
    expect(compareField('vin', 'VF7NC5FS8KY418823', 'VF7NC5FS8KY418824')).toBe('mismatch');
  });

  it('compare les dates au jour', () => {
    expect(compareField('dateActe', '2025-03-14', '14/03/2025')).toBe('match');
    expect(compareField('dateEcheance', '2026-03-01', '2026-03-02')).toBe('mismatch');
  });

  it('signale un champ attendu et absent', () => {
    expect(compareField('prixAchat', 245000, undefined)).toBe('missing');
    expect(compareField('prixAchat', 245000, '')).toBe('missing');
  });

  it('signale une valeur inventée là où rien n’est attendu', () => {
    // Le cas de la LLD : extraire une valeur de rachat est une hallucination,
    // pas une simple différence. Le verdict doit les distinguer.
    expect(compareField('valeurRachat', null, 12960)).toBe('unexpected');
    expect(compareField('valeurRachat', null, undefined)).toBe('match');
  });

  it('compare les booléens', () => {
    expect(compareField('conflitDetecte', true, true)).toBe('match');
    expect(compareField('conflitDetecte', true, false)).toBe('mismatch');
  });
});

const CASE: CorpusCase = {
  caseId: 'test-acte',
  category: 'acte_immobilier',
  fixturePath: 'x.html',
  expected: {
    documentType: 'ACTE_TRANSACTION',
    assetRefs: ['maison-fleury'],
    fields: { surfaceHabitable: 78.4, prixAchat: 245000 },
  },
};

const OK: ObservedResult = {
  documentType: 'ACTE_TRANSACTION',
  assetRefs: ['maison-fleury'],
  fields: { surfaceHabitable: '78,40 m²', prixAchat: '245 000,00 €' },
  schemaValid: true,
  costMicros: 1200,
  durationMs: 3400,
};

describe('comparaison d’un cas', () => {
  it('valide un résultat correct malgré les formats', () => {
    const r = compareCase(CASE, OK);
    expect(r.expectedMatch).toBe(true);
    expect(r.documentTypeCorrect).toBe(true);
    expect(r.crossAssetLeak).toBe(false);
  });

  it('invalide un type erroné', () => {
    const r = compareCase(CASE, { ...OK, documentType: 'FACTURE' });
    expect(r.documentTypeCorrect).toBe(false);
    expect(r.expectedMatch).toBe(false);
  });

  it('détecte une fuite vers un bien étranger', () => {
    // C'est la faute la plus grave : une information d'un bien atterrit sur
    // un autre, et l'utilisateur ne peut pas le deviner.
    const r = compareCase(CASE, { ...OK, assetRefs: ['maison-fleury', 'citroen-c4'] });
    expect(r.crossAssetLeak).toBe(true);
    expect(r.leakedAssets).toEqual(['citroen-c4']);
    expect(r.expectedMatch).toBe(false);
  });

  it('distingue un bien manquant d’une fuite', () => {
    // Un rattachement manquant est une extraction incomplète : gênant, mais
    // sans conséquence sur un autre bien.
    const r = compareCase(CASE, { ...OK, assetRefs: [] });
    expect(r.missedAssets).toEqual(['maison-fleury']);
    expect(r.crossAssetLeak).toBe(false);
  });

  it('attend l’absence de type sur un document vide', () => {
    const vide: CorpusCase = {
      caseId: 'vide', category: 'document_sans_information', fixturePath: 'v.html',
      expected: { documentType: undefined, assetRefs: [], fields: {} },
    };
    expect(compareCase(vide, { schemaValid: true }).expectedMatch).toBe(true);
    // Proposer un type sur une page blanche est une invention.
    expect(compareCase(vide, { schemaValid: true, documentType: 'FACTURE' }).documentTypeCorrect)
      .toBe(false);
  });

  it('reporte le schéma invalide sans masquer le reste', () => {
    const r = compareCase(CASE, { ...OK, schemaValid: false });
    expect(r.schemaValid).toBe(false);
    // Les champs restent comparés : savoir CE QUI a été extrait malgré un
    // schéma invalide aide à diagnostiquer.
    expect(r.fields).toHaveLength(2);
  });
});

describe('synthèse', () => {
  const results: CaseComparison[] = [
    compareCase(CASE, OK),
    compareCase(CASE, { ...OK, documentType: 'FACTURE' }),
    compareCase(CASE, { ...OK, assetRefs: ['maison-fleury', 'autre'] }),
  ];

  it('compte les cas conformes', () => {
    const s = summarize(results);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(1);
    expect(s.typeErrors).toBe(1);
    expect(s.leaks).toBe(1);
  });

  it('agrège par famille', () => {
    const s = summarize(results);
    expect(s.byCategory).toEqual([{ category: 'acte_immobilier', total: 3, passed: 1 }]);
  });

  it('cumule les coûts', () => {
    expect(summarize(results).totalCostMicros).toBe(3600);
  });
});

describe('détection de régression', () => {
  const conforme = compareCase(CASE, OK);
  const casse = compareCase(CASE, { ...OK, fields: { surfaceHabitable: 82, prixAchat: 245000 } });
  const fuite = compareCase(CASE, { ...OK, assetRefs: ['maison-fleury', 'autre'] });

  it('signale un cas devenu non conforme', () => {
    const r = detectRegressions([conforme], [casse]);
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('lost');
    expect(r[0].detail).toContain('surfaceHabitable');
  });

  it('signale une amélioration', () => {
    expect(detectRegressions([casse], [conforme])[0].kind).toBe('gained');
  });

  it('signale une fuite apparue', () => {
    const kinds = detectRegressions([conforme], [fuite]).map((r) => r.kind);
    expect(kinds).toContain('new_leak');
  });

  it('signale une fuite corrigée', () => {
    const kinds = detectRegressions([fuite], [conforme]).map((r) => r.kind);
    expect(kinds).toContain('leak_fixed');
  });

  it('ne signale rien quand rien ne bouge', () => {
    expect(detectRegressions([conforme], [conforme])).toEqual([]);
  });

  it('ignore un cas absent de la référence', () => {
    // Un cas ajouté depuis la mesure précédente n'est pas une régression.
    expect(detectRegressions([], [conforme])).toEqual([]);
  });
});
