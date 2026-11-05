/**
 * Lot 76B — ticket « [P1] T3 — Corriger les défauts résiduels de reprise, de
 * réévaluation et de finalisation du lot 72B » (C1 à C6) : parties PURES
 * (états, revalidation à la reprise, empreinte, preuve du recalage, indices
 * textuels, fenêtres de contexte et garde-fous). La persistance, les
 * reprises, le balayage et le reporting sont prouvés sur PostgreSQL 16 réel
 * (`src/test/e2e/scenarios/l76b-t3-nommage-residuels.e2e.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  buildGroups, CONTEXT_BUDGET, docSnapshotHash, documentFingerprint, examinedContextHash, factValueForContext, groupFingerprint,
  laterThan, linkKeysOf, NAMING_TEXT_WINDOW, passageCandidates, selectFacts, selectPassages, technicalUpgradeTrace, textHintRefs, textWindows, upgradeEvidence,
  v2GroupFingerprint, type NamingDoc,
} from '../context';
import { dependencySnapshot } from '../dependencies';
import { judgeProposal, type NamingSnapshotDoc } from '../guards';
import { dueRank, groupDue, groupSettled, namingPhaseStatus, remainingReason, retryAtOf, revalidateExamined } from '../phase';
import type { NameTrace } from '../repository';

const doc = (id: number, o: Partial<NamingDoc> = {}): NamingDoc => ({
  id, name: `Document ${id}`, originalName: null, filename: null, s3Key: null, publicId: null, titleSource: 'SYSTEM', legacyUserEdit: false,
  typeCode: 'INVOICE', supplier: 'Orange', documentDate: '2024-03-12', assetId: 1, assetName: 'Maison', extractionId: id,
  extractedAt: '2024-03-15T00:00:00.000Z', extractionTitle: null, amountCents: null, ...o,
});
const NOW = new Date('2026-10-21T10:00:00Z');
const PROMPT = { available: true, version: 'v1' };
const st = (o: Record<string, unknown> = {}) => ({
  key: 's:orange', status: 'DONE' as const, fingerprint: 'fp', progress: null, snapshot: null, conventions: [], promptVersion: 'v1',
  lastReviewedAt: null, retryAfter: null, attempts: 0, ...o,
}) as never;

describe('L76B-C1 — écritures en attente entre les passages : jamais DONE avec une écriture restante', () => {
  it('L76B-C1-U1 — lot DONE à empreinte à jour mais décision applicable PENDING en base : non terminé, motif WRITE_RETRY', () => {
    expect(groupSettled(st(), 'fp', 0)).toBe(true);
    expect(groupSettled(st(), 'fp', 1)).toBe(false);
    expect(remainingReason(st(), undefined, 1)).toBe('WRITE_RETRY');
    expect(remainingReason(st(), undefined, 0)).toBe('CHANGED_NOT_EXAMINED');
  });
  it('L76B-C1-U2 — compte : DONE impossible tant qu’une écriture reste en base, même sans lot restant', () => {
    expect(namingPhaseStatus({ remainingGroups: 0, scanComplete: true, progress: true, errors: 0, pendingWrites: 1 })).toBe('PARTIAL');
    expect(namingPhaseStatus({ remainingGroups: 0, scanComplete: true, progress: false, errors: 0, pendingWrites: 2 })).toBe('DEFERRED');
    expect(namingPhaseStatus({ remainingGroups: 0, scanComplete: true, progress: true, errors: 0, pendingWrites: 0 })).toBe('DONE');
  });
  it('L76B-C2-U1 — décision non sauvegardée : motif explicite DECISION_NOT_PERSISTED (jamais « reprise sans appel »)', () => {
    expect(remainingReason(st({ status: 'ERROR', lastError: 'DECISION_NOT_PERSISTED : panne' }), undefined)).toBe('DECISION_NOT_PERSISTED');
  });
});

describe('L76B-C3 — revalidation des documents déjà examinés à la reprise', () => {
  const a = doc(1, { name: 'orange janvier 2024' });
  const b = doc(2, { name: 'orange février 2024' });
  const c = doc(3, { name: 'orange mars 2024' });
  const ctx = Object.fromEntries([a, b, c].map((d) => [String(d.id), examinedContextHash(d)]));
  const traces = new Map<number, NameTrace>();
  it('L76B-C3-U1 — contexte inchangé : progression conservée, rien à réexaminer', () => {
    const r = revalidateExamined({ examined: [1, 2, 3], ctx, docs: [a, b, c], traces, conventions: [] });
    expect(r.keep).toEqual([1, 2, 3]);
    expect(r.reexamine).toEqual([]);
  });
  it('L76B-C3-U2 — nouvelle donnée sur un document examiné : réinscrit avec les autres membres de SA famille (familles décrites par l’IA), les autres conservés', () => {
    const b2 = { ...b, factsDigest: 'nouveau-fait' };
    const conventions = [{ label: 'Factures', convention: 'x', documentIds: [1, 2] }, { label: 'Autre', convention: 'y', documentIds: [3] }];
    const r = revalidateExamined({ examined: [1, 2, 3], ctx, docs: [a, b2, c], traces, conventions });
    expect(r.reexamine).toEqual([1, 2]);
    expect(r.dataChanged).toEqual([2]);
    expect(r.keep).toEqual([3]);
  });
  it('L76B-C3-U3 — nom changé par l’examen lui-même (journal : ancien = nom examiné) : justifié, conservé ; changé par un tiers : réinscrit seul', () => {
    const a2 = { ...a, name: 'Facture Orange — janvier 2024' };
    const nous = new Map<number, NameTrace>([[1, { titleEvent: null, harmonization: { name: a2.name, at: NOW.toISOString(), fingerprint: null, oldName: a.name } }]]);
    const r1 = revalidateExamined({ examined: [1, 2, 3], ctx, docs: [a2, b, c], traces: nous, conventions: [{ label: 'F', convention: 'x', documentIds: [1, 2, 3] }] });
    expect(r1.reexamine).toEqual([]);
    expect(r1.ctx['1']).toBe(examinedContextHash(a2));
    const r2 = revalidateExamined({ examined: [1, 2, 3], ctx, docs: [a2, b, c], traces, conventions: [{ label: 'F', convention: 'x', documentIds: [1, 2, 3] }] });
    expect(r2.reexamine).toEqual([1]);
  });
  it('L76B-C3-U4 — composition : document sorti du lot retiré ; progression antérieure au lot 76B (sans empreinte) : aucune preuve, réexaminé', () => {
    const r = revalidateExamined({ examined: [1, 2, 9], ctx: { '1': ctx['1'] }, docs: [a, b, c], traces, conventions: [] });
    expect(r.removed).toEqual([9]);
    expect(r.reexamine).toEqual([2]);
    expect(r.keep).toEqual([1]);
  });
});

describe('L76B-C4 — empreinte complète et déterministe', () => {
  const base = doc(1, { assetName: 'Maison des Lilas', extractionTitle: 'Facture Orange', originalName: 'scan.pdf', operationsDigest: 'op1', factsDigest: 'f1' });
  it('L76B-C4-U1 — sensible au nom du bien, au titre d’extraction, au nom déposé, aux Opérations (nature, statut, contrat, documents reliés) et aux faits', () => {
    const fp = documentFingerprint(base);
    for (const o of [{ assetName: 'Appartement' }, { extractionTitle: 'Avoir Orange' }, { originalName: 'autre.pdf' }, { operationsDigest: 'op2' }, { factsDigest: 'f2' }]) {
      expect(documentFingerprint({ ...base, ...o })).not.toBe(fp);
    }
  });
  it('L76B-C4-U2 — changement sans effet métier (espaces, casse des titres de contexte, espaces du nom) : empreintes stables', () => {
    expect(documentFingerprint({ ...base, assetName: '  maison   des LILAS ', extractionTitle: 'FACTURE  orange' })).toBe(documentFingerprint(base));
    expect(docSnapshotHash({ ...base, name: '  Document   1 ' })).toBe(docSnapshotHash({ ...base, name: 'Document 1' }));
    expect(groupFingerprint([base, doc(2)])).toBe(groupFingerprint([doc(2), base]));
  });
});

describe('L76B-C5 — recalage v1 / v2 → v3 : jamais déduit de la seule égalité de l’ancienne empreinte', () => {
  const avant = '2026-10-01T00:00:00.000Z';
  const apres = '2026-10-10T00:00:00.000Z';
  it('L76B-C5-U1 — v1 : rien au-delà des limites du contexte v1 et données antérieures à l’examen → migration technique ; sinon réexamen attendu, motifs explicites', () => {
    // Lot 111A (E2) : la date de dernière modification du bien fait partie de la preuve (inconnue → réexamen attendu).
    const court = doc(1, { textChars: 120, factsCount: 3, factMaxLength: 40, contextChangedAt: avant, assetChangedAt: avant });
    expect(upgradeEvidence([court, { ...court, id: 2 }], null, apres)).toEqual({ safe: true, reasons: [] });
    expect(upgradeEvidence([{ ...court, factsCount: 11 }], 'naming-v1', apres).reasons).toEqual(['FACTS_BEYOND_PREVIOUS_CONTEXT']);
    expect(upgradeEvidence([{ ...court, textChars: 5000 }], 'naming-v1', apres).reasons).toEqual(['TEXT_BEYOND_PREVIOUS_CONTEXT']);
    expect(upgradeEvidence([{ ...court, operationIds: [4] }], 'naming-v1', apres).reasons).toContain('OPERATIONS_ENRICHED');
    expect(upgradeEvidence([{ ...court, contractRefs: ['CT123456'] }], 'naming-v1', apres).reasons).toContain('CONTRACT_REFERENCES');
    expect(upgradeEvidence([{ ...court, contextChangedAt: '2026-10-15T00:00:00.000Z' }], 'naming-v1', apres).reasons).toEqual(['DATA_CHANGED_SINCE_REVIEW']);
    expect(upgradeEvidence([court], 'naming-v1', null).reasons).toEqual(['REVIEW_DATE_UNKNOWN']);
  });
  it('L76B-C5-U2 — v2 : texte au-delà de 100 000 caractères, valeur de fait au-delà de 240, indices textuels partagés → réexamen attendu ; sinon technique', () => {
    const d = doc(1, { textChars: 50_000, factsCount: 40, factMaxLength: 200, contextChangedAt: avant, operationIds: [3], assetChangedAt: avant });
    expect(upgradeEvidence([d], 'naming-v2', apres).safe).toBe(true);
    expect(upgradeEvidence([{ ...d, textChars: 150_000 }], 'naming-v2', apres).reasons).toEqual(['TEXT_BEYOND_PREVIOUS_CONTEXT']);
    expect(upgradeEvidence([{ ...d, factMaxLength: 400 }], 'naming-v2', apres).reasons).toEqual(['FACT_VALUE_BEYOND_PREVIOUS_CONTEXT']);
    const t1 = doc(5, { textRefs: ['DOS202455667'], contextChangedAt: avant, assetChangedAt: avant });
    const t2 = doc(6, { textRefs: ['DOS202455667'], contextChangedAt: avant, assetChangedAt: avant });
    expect(upgradeEvidence([t1, t2], 'naming-v2', apres).reasons).toEqual(['TEXT_HINTS']);
    // v2 : empreinte d'origine reproductible (recalage seulement si inchangée).
    expect(v2GroupFingerprint([d])).not.toBe(groupFingerprint([d]));
  });
  it('L76B-C5-U3 — réexamen programmé (UPGRADE_REVIEW) : dû à échéance, servi APRÈS tout autre travail, motif distinct, reprise au passage suivant si borné', () => {
    expect(groupDue(st({ status: 'UPGRADE_REVIEW' }), 'autre', PROMPT, NOW)).toBe(true);
    expect(groupDue(st({ status: 'UPGRADE_REVIEW', retryAfter: '2026-10-22T00:00:00Z' }), 'autre', PROMPT, NOW)).toBe(false);
    expect(dueRank(st({ status: 'UPGRADE_REVIEW' }))).toBeGreaterThan(dueRank(undefined));
    expect(dueRank(st({ status: 'UPGRADE_REVIEW' }))).toBeGreaterThan(dueRank(st({ status: 'ERROR' })));
    expect(remainingReason(st({ status: 'UPGRADE_REVIEW' }), undefined)).toBe('CONTEXT_UPGRADE_REVIEW');
    expect(remainingReason(st({ status: 'UPGRADE_REVIEW' }), 'UPGRADE_PASS_CAP')).toBe('UPGRADE_PASS_CAP');
    expect(retryAtOf(st({ status: 'UPGRADE_REVIEW' }), 'UPGRADE_PASS_CAP', null, NOW)).toBeNull();
    expect(groupSettled(st({ status: 'UPGRADE_REVIEW' }), 'fp')).toBe(false);
  });
});

describe('L76B-C6 — indices textuels et fenêtres harmonisées', () => {
  it('L76B-C6-U1 — références du texte : formes génériques retenues, dates, montants, téléphones et IBAN écartés', () => {
    const t = 'Dossier n° DOS-2024-55667 du 12/03/2024, montant 1 234,56 €. Tél. 0612345678. IBAN FR7630006000011234567890189. Contrat 778899001.';
    expect(textHintRefs(t)).toEqual(['778899001', 'DOS202455667']);
    expect(textHintRefs(null)).toEqual([]);
  });
  it('L76B-C6-U2 — référence commune seulement dans le texte : documents comparés ensemble, même sans fournisseur ni contrat structurés', () => {
    const { groups } = buildGroups([
      doc(1, { supplier: 'Cabinet Martin', typeCode: 'LETTER', textRefs: ['DOS202455667'] }),
      doc(2, { supplier: null, typeCode: 'NOTICE', assetId: null, textRefs: ['DOS202455667'] }),
      doc(3, { supplier: 'Cabinet Martin', typeCode: 'LETTER' }),
    ]);
    expect(groups.map((g) => g.docs.map((d) => d.id).sort())).toContainEqual([1, 2, 3]);
    // Référence structurée d'un document retrouvée dans le texte d'un autre.
    const s = buildGroups([doc(10, { supplier: 'EDF', contractRefs: ['CT778899'] }), doc(11, { supplier: null, typeCode: 'SCHEDULE', textRefs: ['CT778899'] })]);
    expect(s.groups.map((g) => g.docs.map((d) => d.id))).toContainEqual([10, 11]);
  });
  it('L76B-C6-U3 — sans regroupement excessif : référence générique (plus de deux émetteurs, ou plus de 50 documents) ignorée ; clé faible jamais un pont', () => {
    const generique = buildGroups([
      doc(1, { supplier: 'A', textRefs: ['REF777888'] }), doc(2, { supplier: 'B', textRefs: ['REF777888'] }), doc(3, { supplier: 'C', textRefs: ['REF777888'] }),
    ]);
    expect(generique.groups.every((g) => g.docs.length === 1)).toBe(true);
    const massif = buildGroups(Array.from({ length: 60 }, (_x, i) => doc(100 + i, { supplier: null, typeCode: `T${i}`, textRefs: ['ABC123456'] })));
    expect(massif.groups.every((g) => g.docs.length === 1)).toBe(true);
    // d1, d2 : nature + bien seulement ; d3 : même nature + bien mais relié par indice à EDF → d1/d2 jamais tirés dans le lot EDF.
    const pont = buildGroups([
      doc(1, { supplier: null, typeCode: 'INVOICE', assetId: 7 }), doc(2, { supplier: null, typeCode: 'INVOICE', assetId: 7 }),
      doc(3, { supplier: null, typeCode: 'INVOICE', assetId: 7, textRefs: ['CT778899'] }), doc(4, { supplier: 'EDF', contractRefs: ['CT778899'] }),
    ]);
    const lots = pont.groups.map((g) => g.docs.map((d) => d.id).sort());
    expect(lots).toContainEqual([1, 2]);
    expect(lots).toContainEqual([3, 4]);
    expect(new Set(pont.groups.map((g) => g.key)).size).toBe(pont.groups.length);
  });
  it('L76B-C6-U4 — indices `x:` : texte exploité seulement sans contrat ni Opération structurés ; provenance préservée par le préfixe', () => {
    expect(linkKeysOf(doc(1, { contractRefs: ['CT1234567'], textRefs: ['AUTRE12345'] }))).toEqual(['c:CT1234567', 's:orange', 'x:CT1234567']);
    expect(linkKeysOf(doc(2, { supplier: null, textRefs: ['AUTRE12345'] }))).toEqual(['t:INVOICE|a:1', 'x:AUTRE12345']);
  });
  it('L76B-C6-U5 — valeur de fait au-delà de 240 caractères : l’élément discriminant de la fin est transmis, signalé comme abrégé', () => {
    const long = `${'Description détaillée de la prestation de maintenance annuelle. '.repeat(8)}Référence site SITE-998877.`;
    const v = factValueForContext(long);
    expect(long.length).toBeGreaterThan(CONTEXT_BUDGET.factValue);
    expect(v.value).toContain('SITE-998877');
    expect(v.truncated).toEqual({ length: long.trim().length });
    const { selected } = selectFacts([{ id: 1, key: 'description', value: long, period: null, provenance: 'T1_EXTRACTION' }]);
    expect(selected[0]).toMatchObject({ factId: 1, truncated: { length: long.trim().length } });
    expect(selected[0].value).toContain('SITE-998877');
  });
  it('L76B-C6-U6 — information après 60 000 et après 100 000 caractères : sélectionnée (fenêtre unique) et acceptée par les garde-fous', () => {
    const remplissage = (n: number) => 'Conditions générales de vente. '.repeat(Math.ceil(n / 31)).slice(0, n);
    const texte = `${remplissage(70_000)} Contrat n° CT-7070-7070. ${remplissage(60_000)} Police PL-130130. ${remplissage(10_000)}`;
    const { passages, textChars } = selectPassages(texte);
    expect(textChars).toBe(texte.length);
    expect(passages.some((p) => p.text.includes('CT-7070-7070') && p.offset > 60_000)).toBe(true);
    expect(passages.some((p) => p.text.includes('PL-130130') && p.offset > 100_000)).toBe(true);
    expect(NAMING_TEXT_WINDOW).toBeGreaterThan(texte.length);
    const s: NamingSnapshotDoc = { id: 1, name: 'Contrat assurance', origin: 'T1', fingerprint: 'fp', role: 'TO_EXAMINE' };
    const v = judgeProposal(
      { document_id: 1, expected_current_name: s.name, proposed_name: 'Contrat assurance CT-7070-7070 — police PL-130130', reason: 'r', confidence: 'certain' },
      { docs: new Map([[1, s]]), seen: new Set(), known: { dates: [], periods: [], amountsCents: [], texts: [texte] }, now: NOW, cooldownDays: 30 },
    );
    expect(v).toMatchObject({ accept: true });
  });
});

describe('L111A-E2 — recalage v1 / v2 : mutations des objets visibles absentes des anciennes empreintes', () => {
  const examen = '2026-10-10T00:00:00.000Z';
  const avant = '2026-10-01T00:00:00.000Z';
  const apres = '2026-10-15T00:00:00.000Z';
  const d = doc(1, { textChars: 50, factsCount: 1, factMaxLength: 20, contextChangedAt: avant, assetChangedAt: avant });
  it('L111A-E2-U1 — bien renommé après l’examen (empreintes v1/v2 sans nom du bien, faits inchangés) : jamais TECHNICAL — réexamen attendu, motif explicite', () => {
    expect(v2GroupFingerprint([{ ...d, assetName: 'Villa des Pins' }])).toBe(v2GroupFingerprint([d]));
    expect(upgradeEvidence([d], 'naming-v2', examen)).toMatchObject({ safe: true });
    expect(upgradeEvidence([{ ...d, assetChangedAt: apres }], 'naming-v2', examen)).toMatchObject({ safe: false, reasons: ['ASSET_CHANGED_SINCE_REVIEW'] });
    expect(upgradeEvidence([{ ...d, assetChangedAt: apres }], 'naming-v1', examen).reasons).toContain('ASSET_CHANGED_SINCE_REVIEW');
    // Preuve par le journal de connaissance du compte (renommage sans mise à jour de l'horodatage du bien).
    expect(upgradeEvidence([d], 'naming-v2', examen, null, { assetsChangedAt: apres }).reasons).toEqual(['ASSET_CHANGED_SINCE_REVIEW']);
    expect(upgradeEvidence([d], 'naming-v2', examen, null, { assetsChangedAt: avant })).toMatchObject({ safe: true });
  });
  it('L111A-E2-U2 — impossibilité de prouver (date de modification du bien inconnue, ni horodatage ni journal) : réexamen attendu ; document sans bien : non concerné', () => {
    expect(upgradeEvidence([{ ...d, assetChangedAt: null }], 'naming-v2', examen).reasons).toEqual(['ASSET_CHANGE_DATE_UNKNOWN']);
    expect(upgradeEvidence([{ ...d, assetChangedAt: null }], 'naming-v2', examen, null, { assetsChangedAt: avant })).toMatchObject({ safe: true });
    expect(upgradeEvidence([{ ...d, assetId: null, assetName: null, assetChangedAt: null }], 'naming-v2', examen)).toMatchObject({ safe: true });
  });
});

describe('L111A-E4 — contenu discriminant au-delà de 400 000 caractères', () => {
  const remplissage = (n: number) => 'Conditions générales de vente. '.repeat(Math.ceil(n / 31)).slice(0, n);
  const texte = `Contrat assurance habitation. ${remplissage(450_000)} Contrat n° CT-4500-4500. ${remplissage(2_000)}`;
  it('L111A-E4-U1 — référence uniquement après 400 000 caractères : passage sélectionné, position absolue exacte (provenance), sous le même budget', () => {
    const { passages, textChars } = selectPassages(texte);
    expect(textChars).toBe(texte.length);
    const p = passages.find((x) => x.text.includes('CT-4500-4500'));
    expect(p).toBeDefined();
    expect(p!.offset).toBeGreaterThan(NAMING_TEXT_WINDOW);
    expect(texte.slice(p!.offset, p!.offset + p!.text.length)).toBe(p!.text);
    expect(passages.reduce((n, x) => n + x.text.length, 0)).toBeLessThanOrEqual(CONTEXT_BUDGET.passages);
  });
  it('L111A-E4-U2 — indices de rapprochement : référence du texte au-delà de la fenêtre retrouvée', () => {
    expect(textHintRefs(`${remplissage(410_000)} Dossier DOS-2025-44556.`)).toEqual(['DOS202544556']);
  });
});

describe('L111A-E1 — revalidation à la reprise : dépendances de contexte COLLECTIF', () => {
  const x = [1, 2, 3].map((i) => doc(i, { typeCode: 'INVOICE', name: `orange facture ${i}` }));
  const y = [4, 5, 6].map((i) => doc(i, { typeCode: 'CONTRACT', name: `orange contrat ${i}` }));
  const tous = [...x, ...y];
  const ctxDe = (l: NamingDoc[]) => Object.fromEntries(l.map((d) => [String(d.id), examinedContextHash(d)]));
  const traces = new Map<number, NameTrace>();
  it('L111A-E1-U1 — NOUVEAU document d’une famille examinée (aucune convention) : membres examinés de cette famille réinscrits, famille indépendante conservée', () => {
    const neuf = doc(7, { typeCode: 'INVOICE', name: 'orange facture 7' });
    const r = revalidateExamined({ examined: [1, 2, 3, 4, 5, 6], ctx: ctxDe(tous), docs: [...tous, neuf], traces, conventions: [], deps: dependencySnapshot(tous), maxFamily: 40 });
    expect(r.reexamine).toEqual([1, 2, 3]);
    expect(r.keep).toEqual([4, 5, 6]);
    expect(r.impact).toMatchObject({ added: [7], removed: [], changed: [] });
  });
  it('L111A-E1-U2 — modification d’un document vu seulement en RÉFÉRENCE (non examiné) : décisions de sa famille réexaminées ; document retiré / déplacé : idem', () => {
    const ref = doc(8, { typeCode: 'CONTRACT', name: 'orange contrat 8' });
    const deps = dependencySnapshot([...tous, ref]);
    const r = revalidateExamined({ examined: [1, 2, 3, 4, 5, 6], ctx: ctxDe(tous), docs: [...tous, { ...ref, factsDigest: 'avenant' }], traces, conventions: [], deps, maxFamily: 40 });
    expect(r.reexamine).toEqual([4, 5, 6]);
    expect(r.impact.changed).toEqual([8]);
    const sorti = revalidateExamined({ examined: [1, 2, 3, 4, 5, 6], ctx: ctxDe(tous), docs: tous, traces, conventions: [], deps, maxFamily: 40 });
    expect(sorti.reexamine).toEqual([4, 5, 6]);
    expect(sorti.impact.removed).toEqual([8]);
  });
  it('L111A-E1-U3 — conventions PARTIELLES : document couvert → famille de l’IA (décision du modèle) ; non couvert → famille de code ; jamais les documents indépendants', () => {
    const conventions = [{ label: 'Factures', convention: 'c', documentIds: [1, 2] }];
    const r1 = revalidateExamined({ examined: [1, 2, 3, 4, 5, 6], ctx: ctxDe(tous), docs: tous.map((d) => (d.id === 5 ? { ...d, factsDigest: 'n' } : d)), traces, conventions, deps: dependencySnapshot(tous), maxFamily: 40 });
    expect(r1.reexamine).toEqual([4, 5, 6]);
    const r2 = revalidateExamined({ examined: [1, 2, 3, 4, 5, 6], ctx: ctxDe(tous), docs: tous.map((d) => (d.id === 1 ? { ...d, factsDigest: 'n' } : d)), traces, conventions, deps: dependencySnapshot(tous), maxFamily: 40 });
    // Le modèle a placé 3 hors de la famille de 1 : seule la famille de l'IA est réexaminée.
    expect(r2.reexamine).toEqual([1, 2]);
    expect(r2.keep).toEqual([3, 4, 5, 6]);
  });
  it('L111A-E1-U4 — borne : famille impactée plus grande qu’un appel → non réinscrite mais SIGNALÉE (document nouveau examiné avec elle en référence) ; contexte inchangé → rien', () => {
    const neuf = doc(7, { typeCode: 'INVOICE', name: 'orange facture 7' });
    const r = revalidateExamined({ examined: [1, 2, 3, 4, 5, 6], ctx: ctxDe(tous), docs: [...tous, neuf], traces, conventions: [], deps: dependencySnapshot(tous), maxFamily: 2 });
    expect(r.reexamine).toEqual([]);
    expect(r.impact.familiesTooLarge).toBe(1);
    const stable = revalidateExamined({ examined: [1, 2, 3], ctx: ctxDe(x), docs: tous, traces, conventions: [], deps: dependencySnapshot(tous), maxFamily: 40 });
    expect(stable).toMatchObject({ reexamine: [], keep: [1, 2, 3] });
  });
  it('L111A-E1-U5 — progression antérieure (sans dépendances mémorisées) : comportement du lot 76B, plus la famille de code d’un document examiné dont la donnée a changé', () => {
    const r = revalidateExamined({ examined: [1, 2, 3, 4, 5, 6], ctx: ctxDe(tous), docs: tous.map((d) => (d.id === 2 ? { ...d, factsDigest: 'n' } : d)), traces, conventions: [] });
    expect(r.reexamine).toEqual([1, 2, 3]);
    expect(r.keep).toEqual([4, 5, 6]);
  });
});

describe('L111A-E2 — compléments : dates comparées comme instants, trace de la preuve', () => {
  it('L111A-E2-U3 — formats PostgreSQL (« 2026-11-05 10:15:39+00 ») et ISO mêlés : comparaison exacte (jamais lexicographique)', () => {
    expect(laterThan('2026-11-04 10:15:39.65+00', '2026-11-04T09:00:00.000Z')).toBe(true);
    expect('2026-11-04 10:15:39.65+00' > '2026-11-04T09:00:00.000Z').toBe(false);
    expect(laterThan('2026-11-04 08:15:39+00', '2026-11-04T09:00:00.000Z')).toBe(false);
    expect(laterThan(null, '2026-11-04T09:00:00.000Z')).toBe(false);
    const d = doc(1, { textChars: 10, contextChangedAt: '2026-11-04 10:15:39.654461+00', assetChangedAt: '2026-01-01T00:00:00Z' });
    expect(upgradeEvidence([d], 'naming-v2', '2026-11-04T09:00:00.000Z').reasons).toEqual(['DATA_CHANGED_SINCE_REVIEW']);
  });
  it('L111A-E2-U4 — migration TECHNIQUE tracée : provenance de la preuve, date d’examen, noms manuels conservés', () => {
    const t = technicalUpgradeTrace([doc(1), doc(2, { titleSource: 'USER' })], 'naming-v2', '2026-10-10T00:00:00.000Z');
    expect(t).toMatch(/^NO_NEWLY_EXPLOITABLE_INFORMATION naming-v2→naming-v3/);
    expect(t).toContain('bien');
    expect(t).toContain('noms manuels conservés : 1');
    expect(t.length).toBeLessThanOrEqual(300);
  });
});

describe('L111A-E4 — compléments : balayage borné, omission, abstention, coût', () => {
  const remplissage = (n: number) => 'Conditions générales de vente. '.repeat(Math.ceil(n / 31)).slice(0, n);
  it('L111A-E4-U3 — au-delà du balayage borné : référence NON transmise, omission chiffrée (abstention possible) et refusée par les garde-fous', () => {
    const texte = `Contrat. ${remplissage(450_000)} Contrat n° CT-4500-4500. ${remplissage(100)}`;
    const r = selectPassages(texte, undefined, { scanMax: NAMING_TEXT_WINDOW });
    expect(r.passages.some((p) => p.text.includes('CT-4500-4500'))).toBe(false);
    expect(r.textNotScanned).toBeGreaterThan(0);
    const s: NamingSnapshotDoc = { id: 1, name: 'Contrat', origin: 'T1', fingerprint: 'fp', role: 'TO_EXAMINE' };
    const v = judgeProposal(
      { document_id: 1, expected_current_name: 'Contrat', proposed_name: 'Contrat CT-4500-4500', reason: 'r', confidence: 'certain' },
      { docs: new Map([[1, s]]), seen: new Set(), known: { dates: [], periods: [], amountsCents: [], texts: [texte.slice(0, NAMING_TEXT_WINDOW)] }, now: NOW, cooldownDays: 30 },
    );
    expect(v).toMatchObject({ accept: false, code: 'INFORMATION_INVENTED' });
    // Passage transmis (au-delà de la fenêtre) = preuve admise : même ensemble que celui présenté au modèle.
    const p = selectPassages(texte).passages.find((x) => x.text.includes('CT-4500-4500'))!;
    const v2 = judgeProposal(
      { document_id: 1, expected_current_name: 'Contrat', proposed_name: 'Contrat CT-4500-4500', reason: 'r', confidence: 'certain' },
      { docs: new Map([[1, s]]), seen: new Set(), known: { dates: [], periods: [], amountsCents: [], texts: [texte.slice(0, NAMING_TEXT_WINDOW), p.text] }, now: NOW, cooldownDays: 30 },
    );
    expect(v2).toMatchObject({ accept: true });
  });
  it('L111A-E4-U4 — candidats d’une fenêtre lue séparément (base) : position absolue conservée ; fusion avec la première fenêtre sous le même budget', () => {
    const fenetre = `${remplissage(1_000)} Police PL-880088. ${remplissage(500)}`;
    const extra = passageCandidates(fenetre, 1_200_000, { keep: 40 });
    expect(extra.find((c) => c.text.includes('PL-880088'))!.offset).toBeGreaterThan(1_200_000);
    const r = selectPassages('Contrat assurance habitation. Montant 120 €.', undefined, { extra, totalChars: 1_201_600, scannedChars: 1_201_600 });
    expect(r.passages.some((x) => x.text.includes('PL-880088') && x.offset > 1_200_000)).toBe(true);
    expect(r.textNotScanned).toBe(0);
  });
  it('L111A-E4-U5 — valeur de fait très longue (500 000 caractères) : élément discriminant de la fin transmis, valeur signalée comme abrégée', () => {
    const long = `${'Garanties et exclusions détaillées. '.repeat(14_000)}Référence sinistre SIN-445566.`;
    const v = factValueForContext(long);
    expect(v.value).toContain('SIN-445566');
    expect(v.truncated?.length).toBe(long.trim().length);
  });
  it('L111A-E4-U6 — coût mesuré : texte de 2 000 000 de caractères balayé (5 fenêtres) en temps borné ; passages limités au budget', () => {
    const texte = `${remplissage(1_950_000)} Contrat n° CT-1950-1950. ${remplissage(40_000)}`;
    const t0 = performance.now();
    const r = selectPassages(texte, undefined, { scanMax: 2_000_000 });
    const ms = performance.now() - t0;
    console.info(`[L111A-E4-U6] balayage 2 000 000 caractères : ${Math.round(ms)} ms`);
    expect(r.passages.some((p) => p.text.includes('CT-1950-1950'))).toBe(true);
    expect(r.passages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(CONTEXT_BUDGET.passages);
    expect(ms).toBeLessThan(20_000);
    expect(textWindows(texte, 2_000_000).length).toBe(5);
  });
});
