/**
 * Lot 72B — ticket « [P1] T3 — Fiabiliser l’harmonisation documentaire et
 * corriger les écarts du lot 61 » : parties PURES (lots, empreinte, sélection
 * du contexte, garde-fous, états et reporting). La persistance, la
 * pagination, les reprises et le balayage sont prouvés sur PostgreSQL 16
 * réel (`src/test/e2e/scenarios/l72b-t3-nommage-ecarts.e2e.ts`).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildGroups, docSnapshotHash, documentFingerprint, groupFingerprint, groupMembers, legacyGroupFingerprint, linkKeysOf,
  membersFingerprint, namingVariables, planChunks, selectFacts, selectPassages, supplierKey, type NamingDoc, type RawFact,
} from '../context';
import { judgeProposal, type NamingSnapshotDoc } from '../guards';
import { groupDue, groupSettled, namingPhaseStatus, remainingReason, retryAtOf, type DocumentNamingPhaseResult } from '../phase';
import { namingOutputComplete } from '../../master/t3-contract';
import { documentNamingPhaseReport, runOutcome } from '../../account-reconciliation.service';
import { summarizeT3Naming } from '../../t3-queue';

const doc = (id: number, o: Partial<NamingDoc> = {}): NamingDoc => ({
  id, name: `Document ${id}`, originalName: null, filename: null, s3Key: null, publicId: null, titleSource: 'SYSTEM', legacyUserEdit: false,
  typeCode: 'INVOICE', supplier: 'Orange', documentDate: '2024-03-12', assetId: 1, assetName: 'Maison', extractionId: id,
  extractedAt: '2024-03-15T00:00:00.000Z', extractionTitle: null, amountCents: null, ...o,
});
const NOW = new Date('2026-10-19T10:00:00Z');
const PROMPT = { available: true, version: 'v1' };
const st = (o: Record<string, unknown> = {}) => ({
  key: 's:orange', status: 'DONE' as const, fingerprint: 'fp', progress: null, snapshot: null, conventions: [], promptVersion: 'v1',
  lastReviewedAt: null, retryAfter: null, attempts: 0, ...o,
}) as never;

describe('L72B-E1 — exhaustivité : lots calculés sur l’index complet, quelle que soit la page de lecture', () => {
  it('L72B-E1-U1 — une famille lue sur des pages différentes forme UN lot ; empreinte de l’index = empreinte des documents', () => {
    const page1 = [doc(1), doc(2, { supplier: 'EDF' })];
    const page2 = [doc(20_001), doc(20_002, { supplier: 'ORANGE SA' })];
    const membres = [...page1, ...page2].map((d) => ({ id: d.id, keys: linkKeysOf(d), hash: docSnapshotHash(d) }));
    const { groups } = groupMembers(membres);
    expect(groups.find((g) => g.key === 's:orange')?.ids).toEqual([1, 20_001, 20_002]);
    const famille = [page1[0], ...page2];
    expect(membersFingerprint(membres.filter((m) => [1, 20_001, 20_002].includes(m.id)))).toBe(groupFingerprint(famille));
  });
  it('L72B-E1-U2 — aucun plafond de lecture dans le module (NAMING_SCAN_LIMIT supprimé)', async () => {
    const phase = await import('../phase');
    expect('NAMING_SCAN_LIMIT' in phase).toBe(false);
  });
});

describe('L72B-E3 — empreinte complète : toute donnée lue par l’IA, protection et nom ; déterministe', () => {
  it('L72B-E3-U1 — sensible aux faits, à l’extraction, aux contrats, aux Opérations, aux liens, au classement et à l’émetteur', () => {
    const base = doc(1, { factsDigest: 'a', extractionVersion: 'e1', contractRefs: ['CT778899'], operationIds: [5], linksDigest: 'l', rubricCode: 'R1', supplierSiret: '552081317' });
    const fp = documentFingerprint(base);
    for (const o of [{ factsDigest: 'b' }, { extractionVersion: 'e2' }, { contractRefs: ['CT778899', 'GZ445566'] }, { operationIds: [5, 6] },
      { linksDigest: 'm' }, { rubricCode: 'R2' }, { supplierSiret: '552081318' }, { documentDate: '2024-03-13' }, { amountCents: 100 }]) {
      expect(documentFingerprint({ ...base, ...o })).not.toBe(fp);
    }
    // Ordre indifférent (déterministe), nom et protection hors empreinte des données mais dans celle du lot.
    expect(documentFingerprint({ ...base, operationIds: [5], contractRefs: ['CT778899'] })).toBe(fp);
    expect(groupFingerprint([{ ...base, name: 'Autre' }])).not.toBe(groupFingerprint([base]));
    expect(groupFingerprint([{ ...base, titleSource: 'USER' }])).not.toBe(groupFingerprint([base]));
  });
  it('L72B-E3-U2 — passage lot 61 → 72B : l’empreinte v1 est reproduite à l’identique (recalage SANS appel IA d’un lot inchangé)', () => {
    // Formule du lot 61, recopiée : la v1 doit rester calculable pour reconnaître un lot inchangé.
    const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
    const v1Doc = (d: NamingDoc) => sha([d.typeCode, supplierKey(d.supplier), d.documentDate, d.assetId, d.extractionId, d.extractedAt, d.amountCents]);
    const v1Lot = (docs: NamingDoc[]) => sha(['naming-v1', [...docs].sort((a, b) => a.id - b.id).map((d) => [d.id, sha([d.name, d.titleSource === 'USER' || d.legacyUserEdit, v1Doc(d)]).slice(0, 16)])]);
    const docs = [doc(2), doc(1, { factsDigest: 'x', operationIds: [3] })];
    expect(legacyGroupFingerprint(docs)).toBe(v1Lot(docs));
    expect(groupFingerprint(docs)).not.toBe(legacyGroupFingerprint(docs));
  });
});

describe('L72B-E4 — familles : rapprochements génériques, sans nomenclature, sans regroupement excessif', () => {
  it('L72B-E4-U1 — même contrat, émetteurs formulés différemment ou absent : un seul lot', () => {
    const { groups } = buildGroups([
      doc(1, { supplier: 'EDF', contractRefs: ['CT778899'] }),
      doc(2, { supplier: 'Électricité de France', contractRefs: ['CT778899'] }),
      doc(3, { supplier: null, typeCode: 'SCHEDULE', contractRefs: ['CT778899'] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].docs.map((d) => d.id).sort()).toEqual([1, 2, 3]);
    expect(groups[0].key.startsWith('s:')).toBe(true);
  });
  it('L72B-E4-U2 — deux contrats distincts d’émetteurs distincts : lots séparés ; même SIREN : rapprochés ; Opération partagée : rapprochés', () => {
    const { groups } = buildGroups([
      doc(1, { supplier: 'EDF', contractRefs: ['CT111111'] }), doc(2, { supplier: 'EDF', contractRefs: ['CT111111'] }),
      doc(3, { supplier: 'GRDF', contractRefs: ['GZ222222'] }), doc(4, { supplier: 'GRDF', contractRefs: ['GZ222222'] }),
      doc(5, { supplier: 'Eau du Grand Lyon', supplierSiret: '12345678900011' }), doc(6, { supplier: 'EGL', supplierSiret: '123456789' }),
      doc(7, { supplier: 'Artisan A', operationIds: [9] }), doc(8, { supplier: null, typeCode: 'QUOTE', operationIds: [9] }),
    ]);
    const lots = groups.map((g) => g.docs.map((d) => d.id).sort());
    expect(lots).toEqual(expect.arrayContaining([[1, 2], [3, 4], [5, 6], [7, 8]]));
    expect(lots).toHaveLength(4);
  });
  it('L72B-E4-U3 — clé faible (nature + bien) jamais un pont ; clé reliant trop d’émetteurs ignorée ; aucun document sans clé rapproché', () => {
    const { groups, withoutContext } = buildGroups([
      doc(1, { supplier: null, typeCode: 'INVOICE', assetId: 1 }), doc(2, { supplier: null, typeCode: 'INVOICE', assetId: 1 }),
      doc(3, { supplier: 'Orange', typeCode: 'INVOICE', assetId: 1 }),
      // Une même Opération rattachée à 4 émetteurs différents : trop large, ignorée.
      doc(10, { supplier: 'A', operationIds: [77] }), doc(11, { supplier: 'B', operationIds: [77] }),
      doc(12, { supplier: 'C', operationIds: [77] }), doc(13, { supplier: 'D', operationIds: [77] }),
      doc(20, { supplier: null, typeCode: null }),
    ]);
    const lots = groups.map((g) => g.docs.map((d) => d.id).sort((a, b) => a - b));
    expect(lots).toContainEqual([1, 2]);
    expect(lots).toContainEqual([3]);
    expect(lots.some((l) => l.length > 1 && l.includes(10))).toBe(false);
    expect(withoutContext).toEqual([20]);
  });
});

describe('L72B-E5 — contexte IA : sélection pertinente, provenance, au-delà des anciennes limites', () => {
  it('L72B-E5-U1 — plus de 10 faits : les références de contrat, périodes et valeurs discriminantes passent d’abord, avec leur provenance', () => {
    const faits: RawFact[] = [
      ...Array.from({ length: 14 }, (_x, i) => ({ id: i + 1, key: `ligne_${i}`, value: `valeur ${i}`, period: null, provenance: 'T1_EXTRACTION' })),
      { id: 50, key: 'contractNumber', value: 'CT-55443322', period: null, provenance: 'T1_EXTRACTION', contractReference: true, canonical: true },
      { id: 51, key: 'billingPeriod', value: 'mars', period: '2024-03-01 → 2024-03-31', provenance: 'REVALIDATION_T2', canonical: true },
    ];
    const { selected, omitted } = selectFacts(faits);
    expect(selected.length).toBe(16);
    expect(omitted).toBe(0);
    expect(selected[0]).toEqual({ key: 'contractNumber', value: 'CT-55443322', source: 'T1_EXTRACTION', factId: 50 });
    expect(selected[1]).toMatchObject({ key: 'billingPeriod', period: '2024-03-01 → 2024-03-31', source: 'REVALIDATION_T2', factId: 51 });
    // Budget : jamais de liste arbitraire, mais un volume borné ; le plus pertinent reste en tête.
    const gros = Array.from({ length: 400 }, (_x, i) => ({ id: i + 1, key: `k${i}`, value: `valeur assez longue numéro ${i} `.repeat(3), period: null, provenance: 'T1_EXTRACTION' }));
    const r = selectFacts([...gros, faits[14]]);
    expect(r.selected[0].factId).toBe(50);
    expect(r.omitted).toBeGreaterThan(0);
  });
  it('L72B-E5-U2 — texte intégral : passages discriminants au-delà de 300 caractères, avec leur position ; aucun passage sans information', () => {
    const texte = `${'Conditions générales de vente. '.repeat(40)}Référence client : RC-99887766. ${'Texte sans intérêt. '.repeat(10)}Adresse : 12 rue des Lilas.`;
    const { head, passages, textChars } = selectPassages(texte);
    expect(head?.length).toBeLessThanOrEqual(240);
    expect(textChars).toBe(texte.length);
    const ref = passages.find((p) => p.text.includes('RC-99887766'))!;
    expect(ref.offset).toBeGreaterThan(300);
    expect(texte.slice(ref.offset, ref.offset + ref.text.length)).toBe(ref.text);
    expect(passages.some((p) => p.text.includes('rue des Lilas'))).toBe(true);
    expect(passages.every((p) => p.source === 'EXTRACTION_FULL_TEXT' && !p.text.startsWith('Conditions'))).toBe(true);
    expect(selectPassages(null)).toEqual({ head: null, passages: [], textChars: 0, omittedPassages: 0 });
  });
  it('L72B-E5-U3 — variables : provenance, passages, contrats, suffisance du contexte transmis ; REFERENCE jamais renommable', () => {
    const g = { key: 's:orange', docs: [doc(1), doc(2)] };
    const v = namingVariables({
      group: g, chunk: planChunks(g.docs, [g.docs[0]], 40)[0], conventions: [], states: new Map(),
      details: new Map([[1, { facts: [{ key: 'contractNumber', value: 'CT1', source: 'T1_EXTRACTION', factId: 9 }], excerpt: 'x', operations: [], history: [],
        passages: [{ text: 'Réf RC-1', offset: 900, source: 'EXTRACTION_FULL_TEXT' as const }], contracts: [{ reference: 'CT1', source: 'T1_FACT#9' }],
        context: { factsTotal: 1, factsProvided: 1, textChars: 1000, passagesProvided: 1, sufficient: true } }]]),
      maxLength: 120,
    });
    const c = v.CANDIDATES as Array<Record<string, unknown>>;
    expect(c[0]).toMatchObject({ role: 'TO_EXAMINE', renameAllowed: true, passages: [{ offset: 900 }], contracts: [{ reference: 'CT1' }], context: { sufficient: true } });
    expect(c[1]).toMatchObject({ role: 'REFERENCE', renameAllowed: false });
    expect(JSON.parse(String(v.SUBJECT_CONTEXT)).constraints).toMatchObject({ renameOnlyRoleToExamine: true });
  });
});

describe('L72B-E7 — documents de RÉFÉRENCE protégés', () => {
  const snap = (o: Partial<NamingSnapshotDoc>): NamingSnapshotDoc => ({ id: 1, name: 'orange mars 2024', origin: 'T1', fingerprint: 'fp', ...o });
  const juger = (s: NamingSnapshotDoc) => judgeProposal(
    { document_id: 1, expected_current_name: s.name, proposed_name: 'Facture — mars 2024 orange', reason: 'r', confidence: 'certain' },
    { docs: new Map([[1, s]]), seen: new Set(), known: null, now: NOW, cooldownDays: 30 },
  );
  it('L72B-E7-U1 — proposition visant un document REFERENCE : refusée avec motif explicite ; TO_EXAMINE : admise ; nom utilisateur : toujours protégé', () => {
    expect(juger(snap({ role: 'REFERENCE' }))).toEqual({ accept: false, code: 'REFERENCE_NOT_RENAMABLE' });
    expect(juger(snap({ role: 'TO_EXAMINE' }))).toMatchObject({ accept: true });
    expect(juger(snap({ role: 'REFERENCE', origin: 'USER' }))).toEqual({ accept: false, code: 'USER_NAME_PROTECTED' });
    expect(juger(snap({ role: 'TO_EXAMINE', origin: 'USER' }))).toEqual({ accept: false, code: 'USER_NAME_PROTECTED' });
  });
});

describe('L72B-E9 — sortie sans document_renames : incomplète, jamais « rien à renommer »', () => {
  it('L72B-E9-U1 — section absente ≠ section vide', () => {
    expect(namingOutputComplete({ document_renames: [] })).toBe(true);
    expect(namingOutputComplete({})).toBe(false);
    expect(namingOutputComplete(null)).toBe(false);
  });
});

describe('L72B-E2 / L72B-E6 / L72B-E8 — états : reprise datée, jamais DONE avec du travail restant', () => {
  it('L72B-E2-U1 — lot dû : délais de reprise respectés pour IN_PROGRESS, ERROR, DEFERRED, WRITE_PENDING ; PROMPT_UNAVAILABLE seulement à nouvelle version', () => {
    const futur = '2026-10-20T00:00:00Z';
    const passe = '2026-10-19T09:00:00Z';
    for (const status of ['IN_PROGRESS', 'ERROR', 'DEFERRED', 'WRITE_PENDING']) {
      expect(groupDue(st({ status, retryAfter: futur }), 'fp', PROMPT, NOW)).toBe(false);
      expect(groupDue(st({ status, retryAfter: passe }), 'fp', PROMPT, NOW)).toBe(true);
      expect(groupDue(st({ status, retryAfter: null }), 'fp', PROMPT, NOW)).toBe(true);
    }
    expect(groupDue(st({ status: 'PROMPT_UNAVAILABLE', promptVersion: 'v1' }), 'fp', PROMPT, NOW)).toBe(false);
    expect(groupDue(st({ status: 'PROMPT_UNAVAILABLE', promptVersion: 'v0' }), 'fp', PROMPT, NOW)).toBe(true);
    expect(groupDue(st(), 'fp', PROMPT, NOW)).toBe(false);
    expect(groupDue(st(), 'autre', PROMPT, NOW)).toBe(true);
  });
  it('L72B-E6-U1 — un lot n’est terminé que DONE avec l’empreinte courante (WRITE_PENDING, IN_PROGRESS… jamais terminés)', () => {
    expect(groupSettled(st(), 'fp')).toBe(true);
    expect(groupSettled(st({ status: 'WRITE_PENDING' }), 'fp')).toBe(false);
    expect(groupSettled(st(), 'autre')).toBe(false);
    expect(groupSettled(undefined, 'fp')).toBe(false);
  });
  it('L72B-E8-U1 — état de phase : DONE seulement sans travail restant et stock couvert ; PARTIAL / DEFERRED / FAILED distincts', () => {
    expect(namingPhaseStatus({ remainingGroups: 0, scanComplete: true, progress: true, errors: 0 })).toBe('DONE');
    expect(namingPhaseStatus({ remainingGroups: 0, scanComplete: false, progress: true, errors: 0 })).toBe('PARTIAL');
    expect(namingPhaseStatus({ remainingGroups: 2, scanComplete: true, progress: true, errors: 0 })).toBe('PARTIAL');
    expect(namingPhaseStatus({ remainingGroups: 2, scanComplete: true, progress: false, errors: 0 })).toBe('DEFERRED');
    expect(namingPhaseStatus({ remainingGroups: 1, scanComplete: true, progress: false, errors: 1 })).toBe('FAILED');
  });
  it('L72B-E8-U2 — motifs et dates de reprise du travail restant', () => {
    expect(remainingReason(undefined, undefined)).toBe('NEVER_EXAMINED');
    expect(remainingReason(undefined, 'DAILY_CAP')).toBe('DAILY_CAP');
    expect(remainingReason(st({ status: 'PROMPT_UNAVAILABLE' }), undefined)).toBe('PROMPT_WITHOUT_DOCUMENT_NAMING');
    expect(remainingReason(st({ status: 'WRITE_PENDING' }), undefined)).toBe('WRITE_RETRY');
    expect(remainingReason(st({ status: 'ERROR', lastError: 'RENAMES_SECTION_MISSING (1/3, prompt v1)' }), undefined)).toBe('RENAMES_SECTION_MISSING');
    expect(remainingReason(st({ status: 'DEFERRED', lastError: 'COST_CAP_REACHED : plafond' }), undefined)).toBe('COST_CAP_REACHED');
    expect(retryAtOf(undefined, 'DAILY_CAP', '2026-10-20T09:00:00Z', NOW)).toBe('2026-10-20T09:00:00Z');
    expect(retryAtOf(undefined, 'PASS_CAP', null, NOW)).toBeNull();
    expect(retryAtOf(st({ status: 'PROMPT_UNAVAILABLE' }), undefined, null, NOW)).toBe('2026-10-20T10:00:00.000Z');
    expect(retryAtOf(st({ status: 'ERROR', retryAfter: '2026-10-19T16:00:00Z' }), undefined, null, NOW)).toBe('2026-10-19T16:00:00Z');
  });
  it('L72B-E8-U3 — phase du passage, synthèse du job et rapport : même état ; DEFERRED jamais DONE ni échec du passage', () => {
    const dn = {
      status: 'DEFERRED', promptAvailable: false, promptVersion: 'v0', documents: 3, withoutContext: 0, groups: 1, groupsDue: 1, groupsExamined: 0,
      groupsCompleted: 0, documentsExamined: 0, families: 0, inconsistentFamilies: 0, proposals: 0, applied: 0, refused: 0, conflicts: 0, unchanged: 0,
      failed: 0, aiCalls: 0, deferred: 1, errors: 0, renamesSectionMissing: 0, pendingWrites: 0, writesRetried: 0, rebaselined: 0,
      scan: { complete: true, coveredOnce: true, cycle: 1, scanned: 3, pages: 1, changed: 3, purged: 0 },
      remaining: { groups: 1, documents: 3, byReason: { PROMPT_WITHOUT_DOCUMENT_NAMING: 1 }, nextRetryAt: '2026-10-20T10:00:00Z' },
      appliedFileIds: [], reportId: null,
    } satisfies DocumentNamingPhaseResult;
    const ph = documentNamingPhaseReport(dn);
    expect(ph).toMatchObject({ status: 'DEFERRED', state: 'DEFERRED', counts: { remainingGroups: 1, remainingDocuments: 3, promptUnavailable: 1 } });
    expect(ph.error).toContain('PROMPT_WITHOUT_DOCUMENT_NAMING 1');
    expect(summarizeT3Naming(dn)).toMatchObject({ status: 'DEFERRED', remainingGroups: 1, remainingByReason: { PROMPT_WITHOUT_DOCUMENT_NAMING: 1 } });
    const phases = { ASSETS: { status: 'DONE', error: null }, OPEN_KNOWLEDGE: { status: 'DONE', error: null }, OPEN_ACTIONS: { status: 'DONE', error: null }, JOURNAL: { status: 'DONE', error: null } } as const;
    expect(runOutcome({ ...phases, DOCUMENT_NAMING: ph }, { changes: 0, keptOpen: 0 })).toBe('SUCCESS');
    expect(runOutcome({ ...phases, DOCUMENT_NAMING: documentNamingPhaseReport({ ...dn, status: 'FAILED', errors: 1 }) }, { changes: 0, keptOpen: 0 })).toBe('PARTIAL_SUCCESS');
    expect(documentNamingPhaseReport({ ...dn, status: 'DONE', remaining: { groups: 0, documents: 0, byReason: {}, nextRetryAt: null } })).toMatchObject({ status: 'DONE', error: null });
  });
});

describe('L76B — compléments au lot 72B (défauts résiduels)', () => {
  it('L76B-C1-U3 — L72B-E6 complété : WRITE_PENDING n’est jamais terminé, et un lot DONE avec une décision en attente non plus', () => {
    expect(groupSettled(st({ status: 'WRITE_PENDING' }), 'fp', 0)).toBe(false);
    expect(groupSettled(st(), 'fp', 3)).toBe(false);
    expect(namingPhaseStatus({ remainingGroups: 0, scanComplete: true, progress: true, errors: 0, pendingWrites: 3 })).not.toBe('DONE');
  });
  it('L76B-C4-U3 — L72B-E3 complété : opération (statut, nature, documents reliés), nom du bien et titre d’extraction dans l’empreinte ; espaces sans effet', () => {
    const base = doc(1, { operationIds: [5], operationsDigest: 'REALIZED' });
    expect(documentFingerprint({ ...base, operationsDigest: 'CANCELLED' })).not.toBe(documentFingerprint(base));
    expect(documentFingerprint({ ...base, assetName: 'Autre bien' })).not.toBe(documentFingerprint(base));
    expect(documentFingerprint({ ...base, extractionTitle: 'Titre' })).not.toBe(documentFingerprint(base));
    expect(documentFingerprint({ ...base, assetName: ' Maison ' })).toBe(documentFingerprint(base));
  });
  it('L76B-C5-U4 — L72B-E3-U2 complété : l’empreinte v1 reste reproductible, mais son égalité seule ne vaut plus recalage (preuve exigée)', async () => {
    const { upgradeEvidence } = await import('../context');
    const docs = [doc(1, { textChars: 5_000, contextChangedAt: '2026-01-01T00:00:00.000Z' })];
    expect(legacyGroupFingerprint(docs)).toBe(legacyGroupFingerprint([...docs]));
    expect(upgradeEvidence(docs, null, '2026-02-01T00:00:00.000Z')).toMatchObject({ safe: false, reasons: ['TEXT_BEYOND_PREVIOUS_CONTEXT'] });
  });
});

describe('L72B-ISO — aucune nomenclature, isolation', () => {
  it('L72B-ISO-U1 — clés de rapprochement purement techniques (préfixes s:, e:, c:, o:, t: ; lot 76B : x: indice de référence), jamais un nom de convention', () => {
    const k = linkKeysOf(doc(1, { supplier: 'Orange SA', supplierSiret: '380 129 866 00014', contractRefs: ['CT1234'], operationIds: [3] }));
    expect(k).toEqual(['c:CT1234', 'e:380129866', 'o:3', 's:orange', 'x:CT1234']);
    expect(linkKeysOf(doc(2, { supplier: null }))).toEqual(['t:INVOICE|a:1']);
  });
});
