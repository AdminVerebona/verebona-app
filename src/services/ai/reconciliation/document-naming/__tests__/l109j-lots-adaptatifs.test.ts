/**
 * Lot 109J — DOCUMENT_NAMING : familles réelles, lots adaptatifs, budget,
 * préfiltre déterministe, reprise bornée (fonctions PURES de `adaptive.ts`)
 * et contexte réduit des documents de référence (`namingVariables`).
 * Scénario base réelle : src/test/e2e/scenarios/l109j-t3-nommage-6033.e2e.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  conformantFamilies, estimatePromptTokens, familyKeyOf, maxTargetsForOutput, namingBudget, namingRetryDelayMs, planFamilyChunks,
  reducedChunkSize, titleShape, NAMING_MIN_CHUNK_DOCS,
} from '../adaptive';
import { docSnapshotHash, namingVariables, type NamingDoc } from '../context';
import { freshSinceReview } from '../dependencies';

const doc = (id: number, o: Partial<NamingDoc> = {}): NamingDoc => ({
  id, name: `Document ${id}`, originalName: null, filename: null, s3Key: null, publicId: null, titleSource: 'SYSTEM', legacyUserEdit: false,
  typeCode: 'INSURANCE_NOTICE', supplier: 'Assurances des Alpes', documentDate: `2026-01-${String((id % 28) + 1).padStart(2, '0')}`,
  assetId: null, assetName: null, extractionId: id, extractedAt: null, extractionTitle: null, amountCents: null, ...o,
});

describe('L109J-NOM-FAM — vraies familles sous un même émetteur', () => {
  it('L109J-NOM-FAM-01 — même assureur, contrats distincts : familles distinctes ; même contrat : même famille', () => {
    const a = doc(1, { contractRefs: ['AUTO31'] });
    const b = doc(2, { contractRefs: ['AUTO41'] });
    const c = doc(3, { contractRefs: ['AUTO31'] });
    expect(familyKeyOf(a)).not.toBe(familyKeyOf(b));
    expect(familyKeyOf(a)).toBe(familyKeyOf(c));
    // Sans contrat : le bien distingue.
    expect(familyKeyOf(doc(4, { assetId: 7 }))).not.toBe(familyKeyOf(doc(5, { assetId: 8 })));
  });

  it('L109J-NOM-FAM-02 — découpage : une famille n’est jamais coupée si elle tient dans un appel ; références de la même famille d’abord', () => {
    const fam = (n: number, ref: string, base: number) => Array.from({ length: n }, (_x, i) => doc(base + i, { contractRefs: [ref] }));
    const docs = [...fam(6, 'PNO21', 100), ...fam(7, 'AUTO31', 200), ...fam(5, 'AUTO41', 300), ...fam(7, 'SONY54', 400)];
    const chunks = planFamilyChunks(docs, docs, 12);
    // Toute famille ≤ t (12 - 3 = 9) est entière dans un seul appel.
    for (const ref of ['PNO21', 'AUTO31', 'AUTO41', 'SONY54']) {
      const parts = chunks.filter((ch) => ch.targets.some((d) => d.contractRefs?.[0] === ref));
      expect(parts.length, ref).toBe(1);
    }
    // Chaque document examiné une fois et une seule.
    const vus = chunks.flatMap((ch) => ch.targets.map((d) => d.id));
    expect(new Set(vus).size).toBe(docs.length);
    expect(vus.length).toBe(docs.length);
    for (const ch of chunks) expect(ch.targets.length + ch.references.length).toBeLessThanOrEqual(12);
  });

  it('L109J-NOM-FAM-03 — lot tenant en un appel : comportement historique (un appel, autres documents en référence)', () => {
    const docs = [doc(1), doc(2), doc(3)];
    expect(planFamilyChunks(docs, [docs[0]], 40)).toEqual([{ index: 0, count: 1, targets: [docs[0]], references: [docs[1], docs[2]] }]);
  });
});

describe('L109J-NOM-BUD — budget et réduction', () => {
  it('L109J-NOM-BUD-01 — budget de sortie : nombre de documents à examiner par appel borné ; estimation d’entrée croissante', () => {
    const b = namingBudget({});
    expect(maxTargetsForOutput(b)).toBe(Math.floor(b.outputTokens / b.outputTokensPerDoc));
    const petit = estimatePromptTokens({ CANDIDATES: [{ a: 'x'.repeat(100) }] }, b);
    const gros = estimatePromptTokens({ CANDIDATES: Array.from({ length: 25 }, () => ({ a: 'x'.repeat(4000) })) }, b);
    expect(gros).toBeGreaterThan(b.inputTokens);
    expect(petit).toBeLessThan(b.inputTokens);
  });

  it('L109J-NOM-BUD-02 — sortie tronquée : taille divisée par deux, jamais en dessous du minimum, puis plus réductible', () => {
    expect(reducedChunkSize(25)).toBe(12);
    expect(reducedChunkSize(3)).toBe(NAMING_MIN_CHUNK_DOCS);
    expect(reducedChunkSize(NAMING_MIN_CHUNK_DOCS)).toBeNull();
  });

  it('L109J-NOM-BUD-03 — reprise bornée et croissante : 30 min, 1 h, 2 h… jamais plus de 24 h', () => {
    expect(namingRetryDelayMs(1)).toBe(30 * 60_000);
    expect(namingRetryDelayMs(2)).toBe(60 * 60_000);
    expect(namingRetryDelayMs(3)).toBe(2 * 3_600_000);
    expect(namingRetryDelayMs(50)).toBe(24 * 3_600_000);
  });
});

describe('L109J-NOM-PRE — préfiltre déterministe', () => {
  const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  const conformes = Array.from({ length: 25 }, (_x, i) => doc(i + 1, {
    typeCode: 'INVOICE', supplier: 'Homiris', name: `Facture Homiris — ${MOIS[i % 12]} ${2024 + Math.floor(i / 12)}`,
  }));

  it('L109J-NOM-PRE-01 — 25 titres déjà conformes (même forme, distincts, origine T1) : tous préfiltrés, aucun appel nécessaire', () => {
    const r = conformantFamilies(conformes, () => 'T1');
    expect(r.conformant.size).toBe(25);
    expect(r.families).toHaveLength(1);
    expect(r.families[0].shape).toBe('Facture Homiris — ‹M› #');
  });

  it('L109J-NOM-PRE-02 — un titre divergent (séparateur, casse) : famille entière à examiner (jamais un préfiltre partiel)', () => {
    const l = [...conformes.slice(0, 5), doc(99, { typeCode: 'INVOICE', supplier: 'Homiris', name: 'Facture Homiris _ mars 2026' })];
    expect(conformantFamilies(l, () => 'T1').conformant.size).toBe(0);
  });

  it('L109J-NOM-PRE-03 — noms de fichier déposés ou d’origine inconnue : jamais préfiltrés (l’IA juge)', () => {
    expect(conformantFamilies(conformes, () => 'UPLOAD').conformant.size).toBe(0);
    expect(conformantFamilies(conformes, () => 'UNKNOWN').conformant.size).toBe(0);
    const fichiers = conformes.slice(0, 3).map((d) => ({ ...d, name: `${d.name}.pdf` }));
    expect(conformantFamilies(fichiers, () => 'T1').conformant.size).toBe(0);
  });

  it('L109J-NOM-PRE-04 — doublons de titre dans une famille : jamais déclarée conforme', () => {
    const l = [conformes[0], { ...conformes[1], name: conformes[0].name }];
    expect(conformantFamilies(l, () => 'T1').conformant.size).toBe(0);
  });

  it('L109J-NOM-PRE-05 — forme : mois et nombres masqués, casse et séparateurs conservés', () => {
    expect(titleShape('Facture Orange — Mars 2026')).toBe('Facture Orange — ‹M› #');
    expect(titleShape('Facture Orange — mars 2026')).toBe('Facture Orange — ‹m› #');
    expect(titleShape('Facture Orange _ Mars 2026')).not.toBe(titleShape('Facture Orange — Mars 2026'));
  });
});

describe('L109J-NOM-CTX — contexte réduit des références', () => {
  it('L109J-NOM-CTX-01 — document REFERENCE : nom, origine, nature, date, émetteur, contrats ; ni faits, ni extraits, ni historique', () => {
    const g = { key: 's:alpes', docs: [doc(1), doc(2)] };
    const v = namingVariables({
      group: g, chunk: { index: 0, count: 1, targets: [g.docs[0]], references: [g.docs[1]] }, conventions: [], states: new Map(),
      details: new Map([[2, { facts: [{ key: 'k', value: 'v'.repeat(200) }], excerpt: 'extrait', operations: [{ id: 1, type: 'CONTRACT', status: 'REALIZED' }],
        history: [{ at: '2026-01-01', from: 'a', to: 'b', origin: 'T1' }], contracts: [{ reference: 'AUTO31', source: 'T1_FACT#1' }] }]]),
      maxLength: 120,
    });
    const ref = (v.CANDIDATES as Array<Record<string, unknown>>).find((c) => c.documentId === 2)!;
    expect(ref).toMatchObject({ role: 'REFERENCE', renameAllowed: false, contracts: [{ reference: 'AUTO31' }] });
    expect(ref).not.toHaveProperty('facts');
    expect(ref).not.toHaveProperty('excerpt');
    expect(ref).not.toHaveProperty('nameHistory');
    expect(ref).not.toHaveProperty('operations');
  });
});

describe('L111A-E1 — préfiltre « titres conformes » : jamais une justification pour ignorer une donnée nouvelle', () => {
  const MOIS = ['Janvier', 'Février', 'Mars', 'Avril'];
  const fam = MOIS.map((m, i) => doc(i + 1, { typeCode: 'INVOICE', supplier: 'Homiris', name: `Facture Homiris — ${m} 2024` }));
  const snapshot = Object.fromEntries(fam.map((d) => [String(d.id), docSnapshotHash(d)]));
  it('L111A-E1-U6 — famille conforme, nouvelle donnée sur UN document : seul ce document est « frais » (examiné), les autres restent préfiltrés (références)', () => {
    const modifie = fam.map((d) => (d.id === 3 ? { ...d, factsDigest: 'avenant' } : d));
    const pre = conformantFamilies(modifie, () => 'T1');
    expect(pre.conformant.size).toBe(4);
    const frais = freshSinceReview(modifie, snapshot);
    expect([...frais]).toEqual([3]);
    expect([...pre.conformant].filter((id) => !frais.has(id)).sort()).toEqual([1, 2, 4]);
  });
  it('L111A-E1-U7 — premier examen (aucun instantané) : préfiltre du lot 109J inchangé ; nouveau membre conforme : frais ; réexamen « contexte enrichi » : tout le lot', () => {
    expect(freshSinceReview(fam, null).size).toBe(0);
    const neuf = doc(9, { typeCode: 'INVOICE', supplier: 'Homiris', name: 'Facture Homiris — Mai 2024' });
    expect([...freshSinceReview([...fam, neuf], snapshot)]).toEqual([9]);
    expect(freshSinceReview(fam, snapshot, { all: true }).size).toBe(4);
    expect([...freshSinceReview(fam, snapshot, { extra: [2] })]).toEqual([2]);
  });
});
