/**
 * Lot 61 — ticket « [P2] T3 — Harmonisation intelligente du nommage
 * documentaire » : parties PURES (garde-fous, contexte, contrat, prompt).
 * La persistance, la concurrence, l'isolation et le reporting sont couverts
 * sur PostgreSQL 16 réel (`src/test/e2e/scenarios/l61f-t3-nommage.e2e.ts`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collidingProposals, equivalentNames, extractDiscriminants, inventedDiscriminants, judgeProposal, lostDiscriminants,
  type KnownDocumentData, type NamingSnapshotDoc,
} from '../guards';
import {
  buildGroups, docSnapshotHash, groupFingerprint, groupKeyOf, namingVariables, planChunks, reviewTargets, supplierKey,
  type NamingDoc,
} from '../context';
import { deriveNameOrigin } from '../repository';
import { dueRank, groupDue } from '../phase';
import { T3DocumentNamingOutput, T3MasterOutput, T3_TASKS } from '../../master/t3-contract';
import { OPTIONAL_MASTER_TASKS, isMasterTaskTextPending } from '@/services/ai/prompts/prompt-loader';
import { getOperation } from '@/services/ai/registry/operations';
import { masterOutputSchemaFor } from '@/services/ai/gateway/master-output-schemas';

const RIEN: KnownDocumentData = { dates: [], periods: [], amountsCents: [], texts: [] };
const doc = (id: number, o: Partial<NamingDoc> = {}): NamingDoc => ({
  id, name: `Document ${id}`, originalName: null, filename: null, s3Key: null, publicId: null, titleSource: 'SYSTEM', legacyUserEdit: false,
  typeCode: 'INVOICE', supplier: 'Orange', documentDate: '2024-03-12', assetId: 1, assetName: 'Maison', extractionId: id,
  extractedAt: '2024-03-15T00:00:00.000Z', extractionTitle: null, amountCents: null, ...o,
});
const snap = (id: number, name: string, o: Partial<NamingSnapshotDoc> = {}): NamingSnapshotDoc => ({ id, name, origin: 'T1', fingerprint: 'fp', ...o });
const juger = (p: Record<string, unknown>, docs: NamingSnapshotDoc[], known: KnownDocumentData = RIEN, extra: Partial<Parameters<typeof judgeProposal>[1]> = {}) =>
  judgeProposal({ document_id: 1, expected_current_name: docs[0]?.name ?? 'x', proposed_name: 'x', reason: 'convention de la famille', confidence: 'certain', ...p } as never,
    { docs: new Map(docs.map((d) => [d.id, d])), seen: new Set(), known, now: new Date('2026-10-15T10:00:00Z'), cooldownDays: 30, ...extra });

describe('T3-NOM-07 — Fiabilité : aucune information discriminante supprimée ni inventée', () => {
  it('reconnaît dates, mois, trimestres, montants, références et adresses (formes génériques)', () => {
    const d = extractDiscriminants('Facture Orange 12/03/2024 n°FA-2024-0012 — 45,90 € — 12 rue des Lilas');
    expect(d.dates).toEqual([{ y: 2024, m: 3, d: 12, q: null }]);
    expect(d.amounts).toEqual([4590]);
    expect(d.references).toContain('fa20240012');
    expect(d.address).toEqual(['lilas']);
    expect(extractDiscriminants('Facture mars 2024').dates).toEqual([{ y: 2024, m: 3, d: null, q: null }]);
    expect(extractDiscriminants('Relevé T2 2025').dates).toEqual([{ y: 2025, m: null, d: null, q: 2 }]);
    expect(extractDiscriminants('Facture 2024-03').dates).toEqual([{ y: 2024, m: 3, d: null, q: null }]);
  });
  it('suppression d’une date, d’une référence, d’une adresse ou d’un montant : refusée', () => {
    expect(lostDiscriminants('Facture Orange mars 2024', 'Facture Orange', RIEN)).toEqual(['date 2024-03']);
    expect(lostDiscriminants('Facture Orange FA-2024-0012', 'Facture Orange Internet', RIEN)).toEqual(['référence fa20240012']);
    expect(lostDiscriminants('Facture Orange 12 rue des Lilas', 'Facture Orange', RIEN)).toEqual(expect.arrayContaining(['adresse « lilas »']));
    expect(lostDiscriminants('Facture Orange 45,90 €', 'Facture Orange', RIEN)).toEqual(['montant 45.90']);
  });
  it('reformulation sans perte (03/2024 → mars 2024, jour conservé par la date du document) : admise', () => {
    expect(lostDiscriminants('Facture_Orange_03-2024.pdf', 'Facture Orange — mars 2024', RIEN)).toEqual([]);
    expect(lostDiscriminants('Facture Orange du 12/03/2024', 'Facture Orange — mars 2024', { ...RIEN, dates: ['2024-03-12'] })).toEqual([]);
    expect(lostDiscriminants('Facture Orange du 12/03/2024', 'Facture Orange — mars 2024', RIEN)).toEqual(['date 2024-03-12']);
  });
  it('nom actuel technique (UUID, IMG_…) : aucune information métier à préserver', () => {
    expect(lostDiscriminants('5be5a3ca-38cf-47fc-942c-3386ea8e846b.pdf', 'Facture Orange — mars 2024', RIEN)).toEqual([]);
    expect(lostDiscriminants('IMG_20240312_123456.jpg', 'Facture Orange — mars 2024', RIEN)).toEqual([]);
  });
  it('information inventée (absente du nom et des données du document) : refusée ; justifiée par les données : admise', () => {
    expect(inventedDiscriminants('Facture Orange', 'Facture Orange — mars 2024', RIEN)).toEqual(['date 2024-03']);
    expect(inventedDiscriminants('Facture Orange', 'Facture Orange — mars 2024', { ...RIEN, dates: ['2024-03-12'] })).toEqual([]);
    expect(inventedDiscriminants('Facture Orange', 'Facture Orange — avril 2024', { ...RIEN, periods: [{ start: '2024-04-01', end: '2024-04-30' }] })).toEqual([]);
    expect(inventedDiscriminants('Facture Orange', 'Facture Orange — contrat 778899', RIEN)).toEqual(['référence 778899']);
    expect(inventedDiscriminants('Facture Orange', 'Facture Orange — contrat 778899', { ...RIEN, texts: ['Numéro de contrat : 778 899'] })).toEqual([]);
  });
  it('le verdict refuse avec le motif et le détail', () => {
    const v = juger({ proposed_name: 'Facture Orange' }, [snap(1, 'Facture Orange mars 2024')]);
    expect(v).toEqual({ accept: false, code: 'DISCRIMINANT_REMOVED', detail: 'date 2024-03' });
    const w = juger({ proposed_name: 'Facture Orange — mars 2024' }, [snap(1, 'Facture Orange')]);
    expect(w).toMatchObject({ accept: false, code: 'INFORMATION_INVENTED' });
  });
});

describe('T3-NOM-05 / T3-NOM-14 — Protection, monde fermé, compare-and-swap côté modèle', () => {
  it('nom utilisateur : jamais renommé', () => {
    expect(juger({ proposed_name: 'Facture Orange — mars 2024' }, [snap(1, 'Ma facture box', { origin: 'USER' })]))
      .toEqual({ accept: false, code: 'USER_NAME_PROTECTED' });
  });
  it('document ou référence hors du lot fourni (autre compte, hallucination) : refusé', () => {
    expect(juger({ document_id: 999 }, [snap(1, 'Facture Orange')])).toEqual({ accept: false, code: 'UNKNOWN_DOCUMENT' });
    expect(juger({ proposed_name: 'Facture Orange 2', reference_document_ids: [999] }, [snap(1, 'Facture Orange')]))
      .toMatchObject({ accept: false, code: 'UNKNOWN_REFERENCE' });
  });
  it('nom attendu différent du nom envoyé : refusé ; forme masquée par la passerelle : admise', () => {
    expect(juger({ expected_current_name: 'Autre nom', proposed_name: 'Facture Orange mars' }, [snap(1, 'Facture Orange')]))
      .toMatchObject({ accept: false, code: 'EXPECTED_NAME_MISMATCH' });
    expect(juger({ expected_current_name: 'Facture  Orange ', proposed_name: 'Orange — facture' }, [snap(1, 'Facture Orange')]))
      .toEqual({ accept: true, name: 'Orange — facture' });
    expect(juger({ expected_current_name: 'RIB [IBAN_MASQUE]', proposed_name: 'RIB Orange' }, [snap(1, 'RIB FR7630006000011234567890189', { redactedName: 'RIB [IBAN_MASQUE]' })]))
      .toMatchObject({ accept: false, code: 'DISCRIMINANT_REMOVED' });
  });
  it('proposition en double, nom masqué, technique, trop long : refusés', () => {
    const docs = new Map([[1, snap(1, 'Facture Orange')]]);
    const seen = new Set<number>();
    const base = { expected_current_name: 'Facture Orange', reason: 'r', confidence: 'certain' as const };
    const c = { docs, seen, known: RIEN, now: new Date(), cooldownDays: 30 };
    expect(judgeProposal({ ...base, document_id: 1, proposed_name: 'Orange facture' }, c)).toMatchObject({ accept: true });
    expect(judgeProposal({ ...base, document_id: 1, proposed_name: 'Orange facture 2' }, c)).toMatchObject({ code: 'DUPLICATE_PROPOSAL' });
    expect(juger({ proposed_name: 'Facture [IBAN_MASQUE]' }, [snap(1, 'Facture Orange')])).toMatchObject({ code: 'INVALID_NAME' });
    expect(juger({ proposed_name: '5be5a3ca-38cf-47fc-942c-3386ea8e846b.pdf' }, [snap(1, 'Facture Orange')])).toMatchObject({ code: 'INVALID_NAME' });
    expect(juger({ proposed_name: `Facture Orange ${'x'.repeat(130)}` }, [snap(1, 'Facture Orange')])).toMatchObject({ code: 'TOO_LONG' });
  });
  it('nom d’origine INCONNUE (historique) : confiance « certain » exigée ; conflictuel toujours refusé', () => {
    expect(juger({ proposed_name: 'Orange — Facture', confidence: 'probable' }, [snap(1, 'Facture Orange', { origin: 'UNKNOWN' })]))
      .toEqual({ accept: false, code: 'UNKNOWN_ORIGIN_LOW_CONFIDENCE' });
    expect(juger({ proposed_name: 'Orange — Facture', confidence: 'certain' }, [snap(1, 'Facture Orange', { origin: 'UNKNOWN' })])).toMatchObject({ accept: true });
    expect(juger({ proposed_name: 'Orange — Facture', confidence: 'probable' }, [snap(1, 'Facture Orange', { origin: 'T1' })])).toMatchObject({ accept: true });
    expect(juger({ proposed_name: 'Orange — Facture', confidence: 'conflictual' }, [snap(1, 'Facture Orange')])).toMatchObject({ code: 'LOW_CONFIDENCE' });
  });
  it('origine du nom dérivée et auto-validante (USER, harmonisation, T1, nom déposé, inconnue)', () => {
    const d = { name: 'Facture Orange', titleSource: 'SYSTEM', legacyUserEdit: false, originalName: 'scan.pdf', filename: null, s3Key: null, publicId: null };
    expect(deriveNameOrigin({ ...d, titleSource: 'USER' }, undefined)).toBe('USER');
    expect(deriveNameOrigin({ ...d, legacyUserEdit: true }, undefined)).toBe('USER');
    expect(deriveNameOrigin(d, { harmonization: { name: 'Facture Orange', at: '2026-01-02', fingerprint: null }, titleEvent: { name: 'Facture Orange', at: '2026-01-01', origin: 'T1' } })).toBe('T3_HARMONIZATION');
    // Écriture journalisée dont le nom n'est plus en place : ne vaut pas origine.
    expect(deriveNameOrigin(d, { harmonization: { name: 'Autre', at: '2026-01-02', fingerprint: null }, titleEvent: { name: 'Facture Orange', at: '2026-01-01', origin: 'T1' } })).toBe('T1');
    expect(deriveNameOrigin({ ...d, name: 'scan.pdf' }, undefined)).toBe('UPLOAD');
    expect(deriveNameOrigin(d, undefined)).toBe('UNKNOWN');
  });
});

describe('T3-NOM-04 — Stabilité : à contexte inchangé, aucun appel ni renommage', () => {
  it('nom équivalent (casse, accents, ponctuation) : aucune écriture', () => {
    expect(equivalentNames('Facture Orange — Mars 2024', 'facture orange mars 2024')).toBe(true);
    expect(juger({ proposed_name: 'facture orange - mars 2024' }, [snap(1, 'Facture Orange — Mars 2024')])).toEqual({ accept: false, code: 'EQUIVALENT_NAME' });
  });
  it('document harmonisé récemment, sans nouvelle information : non renommé ; avec nouvelle information ou après le délai : admis', () => {
    const recent = snap(1, 'Facture Orange — mars 2024', { origin: 'T3_HARMONIZATION', lastHarmonizedAt: '2026-10-10T00:00:00Z', harmonizedFingerprint: 'fp', fingerprint: 'fp' });
    expect(juger({ proposed_name: 'Orange — facture mars 2024' }, [recent])).toMatchObject({ code: 'RECENTLY_HARMONIZED' });
    expect(juger({ proposed_name: 'Orange — facture mars 2024' }, [{ ...recent, fingerprint: 'nouveau' }])).toMatchObject({ accept: true });
    expect(juger({ proposed_name: 'Orange — facture mars 2024' }, [{ ...recent, lastHarmonizedAt: '2026-08-01T00:00:00Z' }])).toMatchObject({ accept: true });
  });
  it('empreinte de lot : indépendante de l’ordre, sensible au nom, à la protection et aux données ; lot dû seulement s’il a changé', () => {
    const a = [doc(1), doc(2)];
    const fp = groupFingerprint(a);
    expect(groupFingerprint([doc(2), doc(1)])).toBe(fp);
    expect(groupFingerprint([doc(1, { name: 'X' }), doc(2)])).not.toBe(fp);
    expect(groupFingerprint([doc(1, { titleSource: 'USER' }), doc(2)])).not.toBe(fp);
    expect(groupFingerprint([doc(1, { extractionId: 99 }), doc(2)])).not.toBe(fp);
    const prompt = { available: true, version: 'v1' };
    const now = new Date('2026-10-15T00:00:00Z');
    const st = { key: 's:orange', status: 'DONE' as const, fingerprint: fp, progress: null, snapshot: null, conventions: [], promptVersion: 'v0', lastReviewedAt: null, retryAfter: null, attempts: 0 };
    expect(groupDue(st, fp, prompt, now)).toBe(false);
    // Nouvelle version du prompt : pas de réexamen d'un lot inchangé (aucun renommage permanent).
    expect(groupDue(st, fp, { available: true, version: 'v2' }, now)).toBe(false);
    expect(groupDue(st, 'autre', prompt, now)).toBe(true);
    expect(groupDue(undefined, fp, prompt, now)).toBe(true);
    expect(groupDue({ ...st, status: 'PROMPT_UNAVAILABLE', promptVersion: 'v1' }, fp, prompt, now)).toBe(false);
    expect(groupDue({ ...st, status: 'PROMPT_UNAVAILABLE', promptVersion: 'v0' }, fp, prompt, now)).toBe(true);
    expect(groupDue({ ...st, status: 'ERROR', retryAfter: '2026-10-16T00:00:00Z' }, fp, prompt, now)).toBe(false);
    expect(dueRank({ ...st, status: 'IN_PROGRESS' })).toBeLessThan(dueRank(st));
    expect(dueRank(st)).toBeLessThan(dueRank(undefined));
  });
  it('collision : deux documents distincts ne prennent pas le même nom', () => {
    const docs = new Map([[1, snap(1, 'Facture Orange 03/2024')], [2, snap(2, 'Facture Orange 04/2024')]]);
    expect([...collidingProposals([{ documentId: 1, name: 'Facture Orange' }, { documentId: 2, name: 'Facture Orange' }], docs)].sort()).toEqual([1, 2]);
    expect([...collidingProposals([{ documentId: 1, name: 'Facture Orange — mars 2024' }], docs)]).toEqual([]);
  });
});

describe('T3-NOM-03 / T3-NOM-06 — Aucune nomenclature fixe ; familles décidées par l’IA', () => {
  it('lot de comparaison générique : émetteur normalisé (formes juridiques), sinon nature + bien ; jamais une liste de fournisseurs', () => {
    expect(supplierKey('ORANGE SA')).toBe('orange');
    expect(supplierKey('Orange')).toBe('orange');
    expect(supplierKey('Électricité de France S.A.')).toBe('electricite de france');
    expect(groupKeyOf({ supplier: 'Orange SA', typeCode: 'INVOICE', assetId: 3 })).toBe('s:orange');
    expect(groupKeyOf({ supplier: null, typeCode: 'INSURANCE', assetId: 3 })).toBe('t:INSURANCE|a:3');
    expect(groupKeyOf({ supplier: null, typeCode: null, assetId: 3 })).toBeNull();
    const { groups, withoutContext } = buildGroups([doc(1), doc(2, { supplier: 'ORANGE' }), doc(3, { supplier: 'EDF' }), doc(4, { supplier: null, typeCode: null })]);
    expect(groups.map((g) => [g.key, g.docs.map((d) => d.id)])).toEqual([['s:edf', [3]], ['s:orange', [1, 2]]]);
    expect(withoutContext).toEqual([4]);
  });
  it('le module de nommage ne contient aucun nom de fournisseur ni gabarit de nom', () => {
    const dir = join(process.cwd(), 'src/services/ai/reconciliation/document-naming');
    const code = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\b(orange|edf|engie|free|sfr|bouygues|veolia|axa|maif|macif|totalenergies)\b/i);
    expect(code).not.toMatch(/Facture\s+\$\{|`Facture|'Facture/);
  });
  it('contexte : noms actuel et original, origine, historique, données T1, références du lot ; six emplacements, aucun nouveau', () => {
    const g = { key: 's:orange', docs: [doc(1, { name: 'Facture Orange 03/2024', originalName: 'fact.pdf' }), doc(2, { name: 'Orange avril 2024' })] };
    const v = namingVariables({
      group: g, chunk: planChunks(g.docs, [g.docs[1]], 40)[0], conventions: [{ label: 'Factures box', convention: '« Facture Orange — <mois> <année> »' }],
      states: new Map([[1, { origin: 'T3_HARMONIZATION' as const, lastRenamedAt: '2026-01-01' }], [2, { origin: 'T1' as const, lastRenamedAt: null }]]),
      details: new Map([[2, { facts: [{ key: 'contractNumber', value: '778899' }], excerpt: 'Votre facture', operations: [], history: [] }]]),
      maxLength: 120,
    });
    expect(Object.keys(v).sort()).toEqual(['CANDIDATES', 'CURRENT_STATE', 'EVIDENCES', 'FIELD', 'RELATION_TYPE', 'SUBJECT_CONTEXT']);
    const c = v.CANDIDATES as Array<Record<string, unknown>>;
    expect(c.map((x) => [x.documentId, x.role, x.nameOrigin])).toEqual([[1, 'REFERENCE', 'T3_HARMONIZATION'], [2, 'TO_EXAMINE', 'T1']]);
    expect(c[0]).toMatchObject({ currentName: 'Facture Orange 03/2024', originalName: 'fact.pdf', renameAllowed: true });
    expect(c[1]).toMatchObject({ facts: [{ key: 'contractNumber', value: '778899' }], excerpt: 'Votre facture' });
    expect(JSON.parse(String(v.SUBJECT_CONTEXT)).previousConventions).toHaveLength(1);
  });
});

describe('T3-NOM-11 — Historique : lots volumineux examinés en plusieurs appels, sans perte', () => {
  const docs = Array.from({ length: 95 }, (_x, i) => doc(i + 1, { documentDate: `2020-01-${String((i % 28) + 1).padStart(2, '0')}` }));
  it('tous les documents examinés, chaque appel borné, avec des documents de référence', () => {
    const chunks = planChunks(docs, docs, 40);
    expect(chunks.every((c) => c.targets.length + c.references.length <= 40)).toBe(true);
    expect(chunks.every((c) => c.references.length > 0)).toBe(true);
    const vus = chunks.flatMap((c) => c.targets.map((d) => d.id)).sort((a, b) => a - b);
    expect(vus).toEqual(docs.map((d) => d.id).sort((a, b) => a - b));
  });
  it('reprise : documents déjà examinés exclus ; réexamen d’un gros lot : seulement les nouveaux / modifiés', () => {
    const snapshot = Object.fromEntries(docs.map((d) => [String(d.id), docSnapshotHash(d)]));
    const nouveau = doc(500, { documentDate: '2024-05-01' });
    const cibles = reviewTargets([...docs, nouveau], snapshot, 40);
    expect(cibles.map((d) => d.id)).toEqual([500]);
    const plan = planChunks([...docs, nouveau], cibles, 40);
    expect(plan).toHaveLength(1);
    expect(plan[0].references.length).toBeGreaterThan(0);
    // Petit lot : toujours la vue complète de la famille.
    expect(reviewTargets(docs.slice(0, 5), snapshot, 40)).toHaveLength(5);
  });
});

describe('T3-NOM-18 — Contrat de sortie T3 : section document_renames facultative, rétrocompatible', () => {
  it('plusieurs renommages possibles ; section absente = aucune proposition (jamais une erreur)', () => {
    const ok = T3DocumentNamingOutput.parse({
      task: 'DOCUMENT_NAMING',
      families: [{ label: 'Factures box', document_ids: [1, 2], convention: 'Facture Orange — mois année', inconsistent: true }],
      document_renames: [
        { document_id: 1, expected_current_name: 'a', proposed_name: 'b', reference_document_ids: [2], reason: 'r', confidence: 'certain' },
        { document_id: 2, expected_current_name: 'c', proposed_name: 'd', reason: 'r', confidence: 'probable' },
      ],
    });
    expect(ok.document_renames).toHaveLength(2);
    expect(T3DocumentNamingOutput.parse({ task: 'DOCUMENT_NAMING' }).document_renames).toBeUndefined();
    expect(() => T3DocumentNamingOutput.parse({ task: 'DOCUMENT_NAMING', document_renames: [{ document_id: 1, proposed_name: 'b', reason: 'r', confidence: 'certain' }] })).toThrow();
    expect(T3MasterOutput.parse({ task: 'DOCUMENT_NAMING' })).toEqual({ task: 'DOCUMENT_NAMING' });
  });
  it('branche FACULTATIVE du master T3, opération déclarée, schéma relié ; texte livré au lot 63', () => {
    expect(T3_TASKS).toContain('DOCUMENT_NAMING');
    expect(OPTIONAL_MASTER_TASKS.t3_master_v1).toEqual(['OPERATION_MATCH', 'DOCUMENT_NAMING']);
    expect(isMasterTaskTextPending('t3_master_v1', 'DOCUMENT_NAMING')).toBe(false);
    expect(isMasterTaskTextPending('t3_master_v1', 'OPERATION_MATCH')).toBe(false);
    const op = getOperation('t3_document_naming');
    expect(op).toMatchObject({ task: 'DOCUMENT_NAMING', masterPromptCode: 't3_master_v1', outputSchema: 'T3DocumentNamingOutput', billable: false, active: true });
    expect(op.promptVariables).toEqual(getOperation('t3_operation_match').promptVariables);
    expect(masterOutputSchemaFor('T3DocumentNamingOutput')).toBe(T3DocumentNamingOutput);
  });
});

describe('T3-NOM-19 — corpus du prompt maître : cas DOCUMENT_NAMING rejoué dès qu’une version porte la branche', () => {
  it('P-T3-15 : garde-fous serveur réels (2 renommages retenus, suppression de période et nom utilisateur refusés)', async () => {
    const { runMasterCorpus } = await import('@/services/ai/governance/master-corpus/runner');
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const livre = readMasterFileFromRepo('t3_master_v1');
    const avec = `${livre}\n\nBRANCHE TASK = DOCUMENT_NAMING\n\nLot : {{SUBJECT_CONTEXT}}\nDocuments : {{CANDIDATES}}\nTâche : {{RELATION_TYPE}}\n`;
    const [r] = await runMasterCorpus({ readMasterFile: readMasterFileFromRepo, treatments: ['T3'], texts: { t3_master_v1: { text: avec, source: 'config' } } });
    expect(r.branchesPassed).toContain('DOCUMENT_NAMING');
    expect(r.cases.find((c) => c.id === 'P-T3-15')).toMatchObject({ passed: true, errors: [] });
    // Lot 63 : le fichier du dépôt porte la branche — P-T3-15 rejoué sur le texte livré.
    const [f] = await runMasterCorpus({ readMasterFile: readMasterFileFromRepo, treatments: ['T3'] });
    expect(f.status).toBe('PASSED');
    expect(f.skipped).not.toContain('P-T3-15');
    expect(f.cases.find((c) => c.id === 'P-T3-15')).toMatchObject({ passed: true });
  });
});
