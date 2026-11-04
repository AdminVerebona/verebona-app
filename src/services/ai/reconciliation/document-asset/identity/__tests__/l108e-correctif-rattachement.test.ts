/**
 * Lot 108E — ticket « T3 DOCUMENT_ASSET — correctif #626 bis » : tests PURS,
 * assertions OBLIGATOIRES (aucune vérification sous condition, aucune borne
 * permissive).
 *   A1 sources T1 (unités, tableaux, faits non résolus, événements de
 *      référence), preuve / indice, aucune fenêtre de texte ;
 *   A2 groupes d'appareils (série / IMEI), facture multilignes, cohérence de
 *      toutes les appartenances ;
 *   A4 sortie croisée obligatoire et vérifiée face au serveur ;
 *   A5 / A6 / A7 issues de phase, pannes, acteur de projection ;
 *   C  contrôles et journal du diagnostic.
 */
import { describe, expect, it } from 'vitest';
import { equipmentIdentifiersIn, extractIdentityProfile, isValidImei, type IdentityProfileInput } from '../signals';
import { buildIdentityGraph, documentIdentityFingerprint, membershipsOf, type GraphDocument } from '../graph';
import { consistentIdentityTarget, crossDocumentContext, crossTargetAllowed, decideFromIdentity, identityContextOf, validateCrossDocumentOutput } from '../decision';
import { payloadCells, strongOperationRelation } from '../sources';
import { decideFromAiOutput, type DocumentAssetCandidate } from '../../decision';
import type { IndexedAsset, IndexedEntity } from '../../matching-index';
import { identityPhaseFailure, identityPhaseReport, runOutcome, type RunPhases } from '../../../account-reconciliation.service';
import { projectionActorOf } from '../../projection-actor';
import { aiNotConfigured, technicalCategoryOf, wasTechnicalOutcome } from '../../technical-failure';
import { accountCounters, evaluationSummary, t3DiagnosticChecks, t3DiagnosticText } from '../../diagnostic';

const ADR = '12 rue des Érables Fictifs, 69000 Lyon';
const asset = (id: number, name: string, family: 'IMMOBILIER' | 'VEHICULE' | 'OBJET', values: Record<string, string> = {}): IndexedAsset => ({
  assetId: id, name, normalizedName: name.toLowerCase(), aliases: [], family, category: family, subtype: null,
  record: { assetId: id, family, values }, brandModel: null, city: null, postalCode: null,
} as IndexedAsset);
const equipement = (id: number, assetId: number, serial: string): IndexedEntity => ({
  type: 'EQUIPMENT', id, assetId, name: `Appareil ${id}`, normalizedName: `appareil ${id}`, serial: serial.replace(/[^A-Z0-9]/gi, '').toUpperCase(), brandModel: null,
});
const input = (fileId: number, texts: IdentityProfileInput['texts'], facts: IdentityProfileInput['facts'] = [], o: Partial<IdentityProfileInput> = {}): IdentityProfileInput => ({
  fileId, title: `Document ${fileId}`, documentType: 'OTHER', supplier: null, multiAsset: false, texts, facts, ...o,
});
const corps = (t: string) => ({ origin: 'TRANSCRIPTION', zone: 'BODY', text: t });
const fait = (k: string | null, v: string, o: Partial<IdentityProfileInput['facts'][number]> = {}) => ({ canonicalKey: k, label: null, subject: null, value: v, excerpt: null, ...o });
const orphan = (i: IdentityProfileInput): GraphDocument => ({ profile: extractIdentityProfile(i), orphan: true, primaryAssetIds: [] });
const anchor = (i: IdentityProfileInput, ids: number[]): GraphDocument => ({ profile: extractIdentityProfile(i), orphan: false, primaryAssetIds: ids });
const MAISON = asset(32, 'Maison', 'IMMOBILIER');
const APPART = asset(33, 'Appartement', 'IMMOBILIER');
const cand = (assetId: number, o: Partial<DocumentAssetCandidate> = {}): DocumentAssetCandidate => ({
  assetId, name: `Bien ${assetId}`, family: 'IMMOBILIER', subtype: null, identifiers: {}, serverSignals: ['adresse du bien identique'], t1: null, currentRole: null, ...o,
});

describe('L108E-U-A1 — toutes les sources T1 persistées, preuve / indice, aucune fenêtre', () => {
  it('une identité lue SEULEMENT dans une ligne de tableau (unité source) reconstitue le groupe ; page et unité conservées', () => {
    const tableau = input(10, [{ origin: 'SOURCE_UNITS', zone: 'BODY', text: `Désignation du bien : ${ADR}`, unitIds: ['u-17'], page: 3 }]);
    const p = extractIdentityProfile(tableau);
    const s = p.signals.find((x) => x.kind === 'ADDRESS')!;
    expect(s).toMatchObject({ family: 'PROPERTY', origin: 'SOURCE_UNIT', page: 3, unitIds: ['u-17'], evidence: 'PROOF', exclusion: null });
    const g = buildIdentityGraph({ accountId: 1, documents: [orphan(tableau), orphan(input(11, [corps(`Adresse du bien : ${ADR}`)]))], assets: [MAISON] });
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0].members.map((m) => m.fileId)).toEqual([10, 11]);
  });
  it('fait NON RÉSOLU : clé brute « N° de série » → identité d’appareil ; motif non fiable → indice seulement', () => {
    const fiable = extractIdentityProfile(input(1, [], [fait(null, 'FD9811-0456', { origin: 'UNRESOLVED_FACT', rawKey: 'N° de série', unitIds: ['unresolved:4'] })]));
    expect(fiable.signals).toEqual([expect.objectContaining({ family: 'EQUIPMENT', kind: 'SERIAL', origin: 'UNRESOLVED_FACT', reliability: 'MEDIUM', evidence: 'PROOF', unitIds: ['unresolved:4'] })]);
    const douteux = extractIdentityProfile(input(1, [], [fait(null, 'FD9811-0456', { origin: 'UNRESOLVED_FACT', rawKey: 'serial', uncertain: true })]));
    expect(douteux.signals).toEqual([expect.objectContaining({ kind: 'SERIAL', reliability: 'LOW', evidence: 'HINT', exclusion: 'UNCERTAIN_READING' })]);
  });
  it('aucune fenêtre de texte : une adresse au-delà de 60 000 caractères est lue', () => {
    const p = extractIdentityProfile(input(1, [corps(`${'x '.repeat(40_000)} Adresse du bien : ${ADR}`)]));
    expect(p.signals.filter((s) => s.kind === 'ADDRESS' && s.family === 'PROPERTY')).toHaveLength(1);
  });
  it('marque, fournisseur, adresse de facturation : INDICES (motif stable), jamais une arête', () => {
    const p = extractIdentityProfile(input(1, [corps(`Adresse de facturation : ${ADR}`)], [fait('brand', 'Bosch')], { supplier: 'Electro DEMO' }));
    expect(p.signals.map((s) => [s.kind, s.evidence, s.exclusion]).sort()).toEqual([
      ['ADDRESS', 'HINT', 'ADDRESS_ROLE_BILLING'], ['BRAND', 'HINT', 'NOT_DISCRIMINANT'], ['SUPPLIER', 'HINT', 'NOT_DISCRIMINANT'],
    ]);
  });
  it('cellules d’un tableau (charge utile) lues sans clés techniques ; relation d’événement de référence forte seulement si autorité et certitude', () => {
    expect(payloadCells({ cells: [{ label: 'N° de série', value: 'AB12345' }], confidence: 0.9 })).toEqual(['label : N° de série', 'value : AB12345']);
    expect(strongOperationRelation({ authority: 'DOCUMENT', confidence: 'certain' })).toBe(true);
    expect(strongOperationRelation({ authority: 'USER', confidence: null })).toBe(true);
    expect(strongOperationRelation({ authority: 'INFERENCE', confidence: 'certain' })).toBe(false);
    expect(strongOperationRelation({ authority: 'DOCUMENT', confidence: 'probable' })).toBe(false);
  });
  it('même événement de référence (autorité forte) : membre à UN saut ; relation faible : jamais', () => {
    const porteur = input(1, [corps(`Lieu des travaux : ${ADR}`)], [], { operations: [{ operationId: 7, role: 'QUOTE', strong: true }] });
    const fort = input(2, [corps('Facture travaux toiture')], [], { operations: [{ operationId: 7, role: 'INVOICE', strong: true }] });
    const faible = input(3, [corps('Relance')], [], { operations: [{ operationId: 7, role: 'OTHER_EVIDENCE', strong: false }] });
    const g = buildIdentityGraph({ accountId: 1, documents: [orphan(porteur), orphan(fort), orphan(faible), orphan(input(4, [corps(`Adresse du bien : ${ADR}`)]))], assets: [MAISON] });
    expect(g.groups[0].members.map((m) => [m.fileId, m.via])).toEqual([[1, 'OWN_IDENTITY'], [2, 'OPERATION'], [4, 'OWN_IDENTITY']]);
    expect(g.groups[0].edges.some((e) => e.via === 'SAME_OPERATION' && e.toFileId === 2)).toBe(true);
  });
});

describe('L108E-U-A2 — équipements / objets dans les groupes d’identité', () => {
  const facture = input(20, [corps(`Facture Electro DEMO. Lave-vaisselle Bosch. N° de série : FD9811-0456. Adresse de facturation : ${ADR}`)], [], { supplier: 'Electro DEMO' });
  const garantie = input(21, [corps('Certificat de garantie Bosch')], [fait('serialNumber', 'FD9811-0456')], { supplier: 'Bosch' });
  const multi = input(22, [corps('Facture Electro DEMO : lave-vaisselle N° de série : FD9811-0456 ; four N° de série : BX77001234')], [], { supplier: 'Electro DEMO' });
  it('séries et IMEI lus avec leur libellé ; IMEI contrôlé (Luhn) ; code isolé jamais une série', () => {
    expect(equipmentIdentifiersIn('N° de série : FD9811-0456 — IMEI : 490154203237518')).toEqual({ serials: ['FD98110456'], imeis: ['490154203237518'] });
    expect(isValidImei('490154203237518')).toBe(true);
    expect(isValidImei('490154203237519')).toBe(false);
    expect(equipmentIdentifiersIn('Référence FD9811-0456')).toEqual({ serials: [], imeis: [] });
  });
  it('facture + garantie d’un même appareil (série) → groupe EQUIPMENT ; fiche d’équipement du bien → DÉMONTRABLE (document → équipement → bien)', () => {
    const g = buildIdentityGraph({ accountId: 1, documents: [orphan(facture), orphan(garantie)], assets: [MAISON, APPART], entities: [equipement(501, 32, 'FD9811-0456')] });
    const eq = g.groups.find((x) => x.family === 'EQUIPMENT')!;
    expect(eq).toMatchObject({ status: 'DEMONSTRABLE', targetAssetId: 32, equipmentIds: [501], cardEligible: false });
    expect(eq.members.map((m) => m.fileId)).toEqual([20, 21]);
    // L'adresse de FACTURATION ne crée aucun groupe de logement.
    expect(g.groups.filter((x) => x.family === 'PROPERTY')).toHaveLength(0);
    const d = decideFromIdentity(identityContextOf(g, 20, documentIdentityFingerprint(g, 20)), [], { multiAssetDeclared: false, identifiedAssetIds: [] });
    expect(d).toEqual({ kind: 'APPLY', assetId: 32, score: 1, method: 'DETERMINISTIC', reason: 'GROUP_IDENTITY_DEMONSTRABLE:OWN_IDENTITY:EQUIPMENT' });
    expect(g.equipmentDocuments?.has(20)).toBe(true);
  });
  it('sans fiche d’équipement ni document rattaché : NO_CANDIDATE, jamais de carte groupée ni d’attribution (marque / fournisseur insuffisants)', () => {
    const g = buildIdentityGraph({ accountId: 1, documents: [orphan(facture), orphan(garantie)], assets: [MAISON] });
    const eq = g.groups.find((x) => x.family === 'EQUIPMENT')!;
    expect(eq).toMatchObject({ status: 'NO_CANDIDATE', targetAssetId: null, cardEligible: false, candidateAssetIds: [] });
    expect(decideFromIdentity(identityContextOf(g, 20, null), [], { multiAssetDeclared: false, identifiedAssetIds: [] })).toBeNull();
    // Marque / modèle seuls : aucun groupe.
    const marques = buildIdentityGraph({ accountId: 1, documents: [orphan(input(30, [], [fait('brand', 'Brandt'), fait('modelName', 'BXP6332X')])), orphan(input(31, [], [fait('brand', 'Brandt'), fait('modelName', 'BXP6332X')]))], assets: [MAISON] });
    expect(marques.groups).toHaveLength(0);
  });
  it('ATTESTÉ : garantie déjà rattachée au bien → la facture du même appareil est rattachable à ce seul bien', () => {
    const g = buildIdentityGraph({ accountId: 1, documents: [orphan(facture), anchor(garantie, [32])], assets: [MAISON, APPART] });
    expect(g.groups.find((x) => x.family === 'EQUIPMENT')).toMatchObject({ status: 'ATTESTED', targetAssetId: 32 });
  });
  it('facture MULTILIGNES (deux appareils) : membre d’AUCUN groupe d’appareil (MULTI_ARTICLE_DOCUMENT), jamais affectée entière', () => {
    const g = buildIdentityGraph({ accountId: 1, documents: [orphan(multi), orphan(garantie)], assets: [MAISON, APPART], entities: [equipement(501, 32, 'FD9811-0456'), equipement(502, 33, 'BX77001234')] });
    expect(membershipsOf(g, 22)).toEqual([]);
    for (const grp of g.groups.filter((x) => x.family === 'EQUIPMENT' && x.excluded.some((e) => e.fileId === 22))) {
      expect(grp.excluded.find((e) => e.fileId === 22)!.reason).toBe('MULTI_ARTICLE_DOCUMENT');
    }
    // Le groupe de l'appareil porté aussi par la garantie l'exclut ; la seconde série (lue par la seule facture) ne forme aucun groupe.
    expect(g.groups.filter((x) => x.excluded.some((e) => e.fileId === 22)).map((x) => x.members.map((m) => m.fileId))).toEqual([[21]]);
    expect(decideFromIdentity(identityContextOf(g, 22, null), [], { multiAssetDeclared: false, identifiedAssetIds: [] })).toBeNull();
    expect(extractIdentityProfile(multi)).toMatchObject({ contradictions: [], equipmentContradictions: ['MULTIPLE_EQUIPMENT_IDENTITIES'] });
  });
  it('appartenances CONTRADICTOIRES (logement → Maison, appareil → Appartement) : aucune décision déterministe', () => {
    const doc = input(40, [corps(`Adresse du chantier : ${ADR}. N° de série : FD9811-0456`)]);
    const g = buildIdentityGraph({
      accountId: 1, documents: [orphan(doc)], assets: [asset(32, 'Maison', 'IMMOBILIER', { address1: '12 rue des Érables Fictifs', postalCode: '69000' }), APPART],
      entities: [equipement(502, 33, 'FD9811-0456')],
    });
    const ctx = identityContextOf(g, 40, null);
    expect(ctx.memberships!.map((m) => [m.group.family, m.group.status, m.group.targetAssetId]).sort()).toEqual([['EQUIPMENT', 'DEMONSTRABLE', 33], ['PROPERTY', 'DEMONSTRABLE', 32]]);
    expect(consistentIdentityTarget(ctx)).toBeNull();
    expect(decideFromIdentity(ctx, [], { multiAssetDeclared: false, identifiedAssetIds: [] })).toBeNull();
    // Le contexte croisé du modèle (contrat v1) ne porte que la famille « bien ».
    expect(crossDocumentContext(ctx, 40)!.context.documentIdentity.family).toBe('PROPERTY');
  });
});

describe('L108E-U-A4 — sortie croisée OBLIGATOIRE et vérifiée quand les preuves ont été transmises', () => {
  const server = { documentStatus: 'MEMBER' as const, groupStatus: 'TO_CONFIRM', targetAssetId: null, candidateAssetIds: [32], refusedAssetIds: [] };
  const check = { allowedEvidenceIds: new Set([1, 2]), member: true, required: true, server };
  const certain = { task: 'LINK_AMBIGUITY' as const, matches: [{ candidateId: 32, score: 0.95, confidence: 'certain' as const, reason: 'adresse' }], documentScope: 'SINGLE' as const };
  const bonne = { documentIdentity: 'ESTABLISHED' as const, groupToAsset: 'ESTABLISHED' as const, documentApplicability: 'APPLIES' as const, citedEvidenceIds: [1] };
  it('section ABSENTE alors que les preuves ont été transmises → abstention CROSS_DOCUMENT_OUTPUT_MISSING (jamais un rattachement silencieux)', () => {
    const rapport: { cross?: { required: boolean; present: boolean; reasons: string[]; blocked: boolean } } = {};
    const d = decideFromAiOutput(certain, [cand(32)], check, rapport);
    expect(d).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'CROSS_DOCUMENT_OUTPUT_MISSING' });
    expect(rapport.cross).toEqual({ required: true, present: false, reasons: ['CROSS_DOCUMENT_OUTPUT_MISSING'], blocked: true });
  });
  it('appel NON enrichi (prompt sans le bloc) : comportement d’avant, rattachement possible', () => {
    expect(decideFromAiOutput(certain, [cand(32)], null)).toMatchObject({ kind: 'APPLY', assetId: 32, method: 'AI' });
  });
  it('relation groupe → bien « établie » par le modèle alors que le serveur la tient À CONFIRMER → bloquée', () => {
    const v = validateCrossDocumentOutput(bonne, check);
    expect(v.blockApply).toBe(true);
    expect(v.reasons).toContain('GROUP_TO_ASSET_INCONSISTENT_WITH_SERVER:TO_CONFIRM');
    expect(decideFromAiOutput({ ...certain, crossDocument: bonne }, [cand(32)], check)).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'INSUFFICIENT_EVIDENCE' });
  });
  it('sortie cohérente avec un groupe DÉMONTRÉ vers ce bien → rattachement ; autre bien que la cible → bloqué', () => {
    const ok = { ...check, server: { ...server, groupStatus: 'DEMONSTRABLE', targetAssetId: 32 } };
    expect(decideFromAiOutput({ ...certain, crossDocument: bonne }, [cand(32)], ok)).toMatchObject({ kind: 'APPLY', assetId: 32 });
    const autre = { ...certain, matches: [{ ...certain.matches[0], candidateId: 33 }], crossDocument: bonne };
    expect(decideFromAiOutput(autre, [cand(32), cand(33)], ok)).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'INSUFFICIENT_EVIDENCE' });
    expect(crossTargetAllowed(33, ok.server)).toBe('TARGET_DIFFERS_FROM_GROUP');
  });
  it('preuve inventée → monde fermé violé ; aucune preuve citée → bloqué ; document EXCLU déclaré « établi » → bloqué', () => {
    const ok = { ...check, server: { ...server, groupStatus: 'DEMONSTRABLE', targetAssetId: 32 } };
    expect(decideFromAiOutput({ ...certain, crossDocument: { ...bonne, citedEvidenceIds: [9] } }, [cand(32)], ok)).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'CLOSED_WORLD_VIOLATION' });
    expect(validateCrossDocumentOutput({ ...bonne, citedEvidenceIds: [] }, ok).reasons).toContain('CITED_EVIDENCE_MISSING');
    const exclu = { ...ok, member: false, server: { ...ok.server, documentStatus: 'EXCLUDED' as const } };
    expect(validateCrossDocumentOutput({ ...bonne, groupToAsset: 'NOT_APPLICABLE' }, exclu).reasons).toContain('DOCUMENT_IDENTITY_INCONSISTENT_WITH_SERVER:EXCLUDED');
  });
  it('A ET B (multi-biens) soumis au MÊME contrôle (plus de contournement)', () => {
    const multi = { task: 'LINK_AMBIGUITY' as const, documentScope: 'MULTIPLE' as const, matches: [
      { candidateId: 32, score: 0.95, confidence: 'certain' as const, reason: 'a' }, { candidateId: 33, score: 0.93, confidence: 'certain' as const, reason: 'b' }] };
    expect(decideFromAiOutput(multi, [cand(32), cand(33)], check)).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'CROSS_DOCUMENT_OUTPUT_MISSING' });
    expect(decideFromAiOutput(multi, [cand(32), cand(33)], null)).toMatchObject({ kind: 'MULTI_ASSET', assetIds: [32, 33] });
  });
  it('bien refusé par l’utilisateur : jamais retenu, même si le modèle le désigne', () => {
    expect(crossTargetAllowed(32, { ...server, groupStatus: 'NO_CANDIDATE', refusedAssetIds: [32] })).toBe('TARGET_REFUSED_BY_USER');
  });
});

describe('L108E-U-A5 — panne du graphe : PARTIAL / FAILED, jamais DONE', () => {
  const base = { skipped: true, orphansExamined: 0, anchorsExamined: 0, groups: 0, byStatus: {}, changed: 0, cards: { opened: 0, updated: 0, closed: 0, individualClosed: 0 }, recoverableMembers: 0, durationMs: 1 };
  it('coupure volontaire ≠ compte sans groupe ≠ panne', () => {
    expect(identityPhaseFailure({ ...base, reason: 'DISABLED', state: 'DISABLED' })).toBeNull();
    expect(identityPhaseFailure({ ...base, skipped: false, reason: null, state: 'NO_RELEVANT_GROUP' })).toBeNull();
    expect(identityPhaseFailure({ ...base, reason: 'GRAPH_UNAVAILABLE', state: 'PARTIAL' })).toBe('PARTIAL');
    expect(identityPhaseFailure({ ...base, reason: 'MIGRATION_MISSING', state: 'FAILED' })).toBe('FAILED');
    // Résultat sans état (avant le lot 108E) : GRAPH_UNAVAILABLE n'est jamais un succès.
    expect(identityPhaseFailure({ ...base, reason: 'GRAPH_UNAVAILABLE' })).toBe('PARTIAL');
    expect(identityPhaseReport({ ...base, reason: 'GRAPH_UNAVAILABLE', state: 'PARTIAL', error: 'boom', untreatedDocuments: 12 }, null))
      .toMatchObject({ status: 'PARTIAL', state: 'PARTIAL', counts: expect.objectContaining({ untreatedDocuments: 12 }) });
    expect(identityPhaseReport({ ...base, reason: 'DISABLED', state: 'DISABLED' }, null).status).toBe('NOT_CONFIGURED');
  });
  it('issue du passage : phase obligatoire partielle → PARTIAL_SUCCESS ; en échec → TECHNICAL_FAILURE', () => {
    const ok = { status: 'DONE' as const, error: null };
    const phases = (o: RunPhases['OPEN_KNOWLEDGE']): RunPhases => ({ ASSETS: ok, OPEN_KNOWLEDGE: o, OPEN_ACTIONS: ok, JOURNAL: ok });
    expect(runOutcome(phases({ status: 'PARTIAL', error: 'IDENTITY_GROUPS' }), { changes: 1, keptOpen: 0 })).toBe('PARTIAL_SUCCESS');
    expect(runOutcome(phases({ status: 'FAILED', error: 'IDENTITY_GROUPS' }), { changes: 1, keptOpen: 0 })).toBe('TECHNICAL_FAILURE');
  });
});

describe('L108E-U-A6 / A7 — panne ≠ question ; projection en contexte technique', () => {
  it('catégories techniques stables ; issue précédente technique reconnue (carte née d’une panne)', () => {
    expect(technicalCategoryOf(Object.assign(new Error('quota exceeded'), { code: 'RATE_LIMIT' }))).toBe('QUOTA');
    expect(technicalCategoryOf(Object.assign(new Error('connect ECONNREFUSED'), { code: '08006' }))).toBe('DATABASE');
    expect(technicalCategoryOf(new Error('sortie invalide (schema)'))).toBe('SCHEMA');
    expect(technicalCategoryOf(new Error('provider timeout'))).toBe('MODEL');
    // IA NON CONFIGURÉE (opération inactive, compte inéligible) ≠ panne ; tous modèles en échec = panne.
    expect(aiNotConfigured(Object.assign(new Error('x'), { code: 'OPERATION_INACTIVE' }))).toBe(true);
    expect(aiNotConfigured(Object.assign(new Error('x'), { code: 'ACCOUNT_INELIGIBLE' }))).toBe(true);
    expect(aiNotConfigured(Object.assign(new Error('x'), { code: 'ALL_MODELS_FAILED' }))).toBe(false);
    expect(aiNotConfigured(new Error('provider timeout'))).toBe(false);
    expect(wasTechnicalOutcome({ reasonCode: 'AI_UNAVAILABLE', lastEvaluation: { ai: { status: 'ERROR' } } })).toBe(true);
    // Issue technique : l'origine de la carte est RECONDUITE (une vraie question reste une vraie question).
    expect(wasTechnicalOutcome({ reasonCode: 'TECHNICAL_FAILURE', lastEvaluation: { technicalFailure: { cardOrigin: 'TECHNICAL' } } })).toBe(true);
    expect(wasTechnicalOutcome({ reasonCode: 'TECHNICAL_FAILURE', lastEvaluation: { technicalFailure: { cardOrigin: 'BUSINESS' } } })).toBe(false);
    expect(wasTechnicalOutcome({ reasonCode: 'TECHNICAL_FAILURE', lastEvaluation: null })).toBe(false);
    // T3 inactif par configuration (aucun appel en erreur) : pas une panne — la carte est légitime.
    expect(wasTechnicalOutcome({ reasonCode: 'AI_UNAVAILABLE', lastEvaluation: { ai: { status: 'NOT_CALLED' } } })).toBe(false);
    expect(wasTechnicalOutcome({ reasonCode: 'INSUFFICIENT_EVIDENCE', lastEvaluation: { ai: { status: 'OK' } } })).toBe(false);
  });
  it('acteur : initiateur → USER ; sans initiateur → titulaire du compte (TECHNICAL), jamais le déposant ; sans titulaire → aucune projection', () => {
    expect(projectionActorOf({ initiatorUserId: 7, accountOwnerUserId: 3, trigger: 'manual' })).toEqual({ kind: 'USER', userId: 7, reason: 'INITIATOR' });
    expect(projectionActorOf({ initiatorUserId: null, accountOwnerUserId: 3, trigger: 'coherence' })).toEqual({ kind: 'TECHNICAL', userId: 3, reason: 'ACCOUNT_OWNER', trigger: 'coherence' });
    expect(projectionActorOf({ initiatorUserId: null, accountOwnerUserId: null, trigger: 'coherence' })).toMatchObject({ kind: 'NONE', userId: null });
  });
});

describe('L108E-U-C — diagnostic BO : contrôles visibles et journal par document', () => {
  const env = { T3_IDENTITY_GROUPS_ENABLED: { effective: true, raw: null }, T3_CROSS_DOCUMENT_CONTEXT_ENABLED: { effective: false, raw: '0' }, T3_DOCUMENT_ASSET_AI_MEMORY_ENABLED: { effective: true, raw: '1' } };
  it('contrôles attendu / constaté : version 4, migrations, variables, marqueur, transmission, qualification', () => {
    const c = t3DiagnosticChecks({
      engineVersion: 4, migrations: { m0995: true, m1060: false }, env,
      prompt: { carriesCrossContract: true, crossContextSent: false, promptArchitecture: 'master', effectiveVersion: 't3_master_v1@pv12', qualification: [{ rank: 0, model: 'm', state: 'OBSOLETE', verdictAt: null, changed: ['prompt'] }] },
    });
    const par = Object.fromEntries(c.map((x) => [x.code, x.ok]));
    expect(par).toEqual({
      ENGINE_VERSION: true, MIGRATION_0995: true, MIGRATION_1060: false, T3_IDENTITY_GROUPS_ENABLED: true, T3_CROSS_DOCUMENT_CONTEXT_ENABLED: false,
      T3_DOCUMENT_ASSET_AI_MEMORY_ENABLED: true, PROMPT_ARCHITECTURE: true, PROMPT_CROSS_MARKER: true, CROSS_CONTEXT_SENT: false, QUALIFICATION: false,
    });
    expect(c.find((x) => x.code === 'QUALIFICATION')!.actual).toContain('modifié : prompt');
    // Illisible ≠ conforme.
    expect(t3DiagnosticChecks({ engineVersion: 4, migrations: null, env, prompt: null }).find((x) => x.code === 'PROMPT_CROSS_MARKER')!.ok).toBeNull();
  });
  it('journal par document : branche, preuves croisées, panne, carte avant → après, projection ; compteurs exhaustifs', () => {
    const e = evaluationSummary({
      branch: 'STRUCTURED', crossDocumentSent: true, crossDocument: { required: true, present: false, reasons: ['CROSS_DOCUMENT_OUTPUT_MISSING'], blocked: true },
      cardBefore: 91, toProcessAction: 'UPDATED', aiMemory: { key: 'k', path: 'STRUCTURED', reasonCode: 'X', at: 'a', ranked: [{ assetId: 1 }] }, currentFingerprint: 'secret-fp',
    })!;
    expect(e).toMatchObject({ branch: 'STRUCTURED', cardBefore: 91, aiMemory: { path: 'STRUCTURED', reasonCode: 'X', at: 'a' } });
    expect(e.currentFingerprint).toBeUndefined();
    const lignes = [
      { fileId: 1, title: 'Facture', documentType: null, supplier: null, primaryAssetIds: [], userDecided: false, resolution: { status: 'ABSTAINED', reasonCode: 'TECHNICAL_FAILURE' }, evaluation: { branch: 'TECHNICAL', ai: { status: 'ERROR' } }, job: null, coherence: null, cards: [{ rule: 'LINK-ASSET', id: 5, resolvedAt: null }], groups: [] },
      { fileId: 2, title: 'Taxe', documentType: null, supplier: null, primaryAssetIds: [32], userDecided: false, resolution: { status: 'RESOLVED', reasonCode: 'GROUP_IDENTITY_CONFIRMED:OWN_IDENTITY' }, evaluation: { branch: 'IDENTITY', projection: { actor: 'TECHNICAL' } }, job: null, coherence: null, cards: [], groups: [] },
    ];
    expect(accountCounters(lignes as never)).toMatchObject({ documents: 2, withoutPrimaryAsset: 1, technicalFailures: 1, openCardsBornFromTechnicalFailure: 1, technicalProjections: 1, byBranch: { TECHNICAL: 1, IDENTITY: 1 } });
    const txt = t3DiagnosticText({ schema: 'verebona.t3.document-asset-diagnostic/1', generatedAt: 'g', scope: 'ACCOUNTS', configuration: {}, checks: [], notes: [], accounts: [{ accountId: 10, counters: accountCounters(lignes as never), lastRun: null, supervision: [], documents: lignes as never }] });
    expect(txt).toContain('COMPTE 10');
    expect(txt).toContain('carte avant → après');
    expect(txt).toMatch(/1 \| Facture \| oui \| ABSTAINED \/ TECHNICAL_FAILURE \| TECHNICAL/);
  });
});
