/**
 * Carte #859 — provenance du TITRE au niveau du CHAMP (Opération et Agenda) : décision pure.
 *
 *   C859-U-01  Opération : matrice SYSTEM / USER / INCONNU — provenance par champ, repli sur l'historique, jamais une égalité de chaînes
 *   C859-U-02  Agenda : matrice SYSTEM / USER / INCONNU — élément saisi, intact, modifié (avec ou sans trace du champ), provenance par champ
 *   C859-U-03  T3 : `acquisitionLabelDecision` ne dépend plus que de l'autorité du champ (date, statut, lien, montant corrigés : sans effet)
 *   C859-U-04  T4 : matrice autorité × champs édités, chemins DOCUMENT (RETITLE) et OPERATION (SYNC / RETITLE) ; gardes indépendantes
 *   C859-U-05  indépendance Opération / Agenda ; aucune fausse provenance USER pour un titre renvoyé inchangé
 *   C859-U-06  garde SQL d'écriture et déclaration : même règle que la décision, déclaration bornée à une instruction
 *   C859-U-07  reprise : même extraction des titres, diagnostic à trois états
 */
import { describe, expect, it } from 'vitest';
import {
  AGENDA_TITLE_SYSTEM_SQL, agendaTitleAuthority, agendaTitleAuthorityOfRow, operationTitleAuthority, parseTitleProvenance,
  SYSTEM_TITLE_REASONS, titleDeclarationValue, type LabelHistoryTrace, type TitleAuthorityDecision,
} from '../title-provenance';
import { acquisitionLabelDecision } from '../consolidation/consolidator';
import { buildCandidateIdentity, type CandidateRecord, type SourceContribution } from '../consolidation/model';
import {
  decideProjection, itemTitleAuthority, planOperationProjection, projectionFunctionalKey, purchaseTitleRenamable,
  type AgendaItemSnapshot, type OperationSnapshot,
} from '../agenda-projection/model';
import { PURCHASE_RETITLE_SQL } from '../agenda-projection/consolidation';
import { nonTitleActions } from '../agenda-projection/purchase-title-reprise';

const AUJ = '2026-11-20';
const CUPRA = 7;
const FICHIER = 50;

const prov = (origin: 'SYSTEM' | 'USER' | 'UNKNOWN', value: string | null, over: Record<string, unknown> = {}) => ({ origin, value, at: '2026-11-20T10:00:00Z', reason: 'X', ...over });
const trace = (reasonCode: string, value: string | null, actorUserId: number | null = null, id = 9): LabelHistoryTrace => ({ id, eventType: 'UPDATED', reasonCode, actorUserId, value });
const etat = (d: TitleAuthorityDecision) => d.authority;

describe('C859-U-01 — Opération : provenance du champ intitulé', () => {
  it('provenance par champ qui décrit la valeur actuelle : elle décide (SYSTEM, USER, INCONNU)', () => {
    expect(operationTitleAuthority({ technicalLabel: 'Achat', provenance: prov('SYSTEM', 'Achat') })).toEqual({ authority: 'SYSTEM', reason: 'SYSTEM_TITLE_RECORDED', evidence: 'title_provenance' });
    expect(operationTitleAuthority({ technicalLabel: 'Achat', provenance: prov('USER', 'Achat') })).toMatchObject({ authority: 'USER', reason: 'USER_TITLE_RECORDED' });
    expect(operationTitleAuthority({ technicalLabel: 'Achat', provenance: prov('UNKNOWN', 'Achat') })).toMatchObject({ authority: 'UNKNOWN', reason: 'UNKNOWN_TITLE_RECORDED' });
    // Provenance texte (lecture brute) : acceptée ; illisible : ignorée.
    expect(etat(operationTitleAuthority({ technicalLabel: 'Achat', provenance: JSON.stringify(prov('USER', 'Achat')) }))).toBe('USER');
    expect(parseTitleProvenance('{oups')).toBeNull();
    expect(parseTitleProvenance({ origin: 'ADMIN', value: 'x' })).toBeNull();
  });
  it('provenance d’une AUTRE valeur (écriture postérieure non déclarée) : jamais crue — repli sur la dernière écriture historisée', () => {
    expect(operationTitleAuthority({ technicalLabel: 'Mon plein', provenance: prov('SYSTEM', 'Achat'), lastLabelWrite: trace('USER_PAGE_CORRECTION', 'Mon plein', 5) }))
      .toMatchObject({ authority: 'USER', reason: 'HISTORY_USER_TITLE_WRITE', evidence: 'history:9' });
    expect(operationTitleAuthority({ technicalLabel: 'Mon plein', provenance: prov('SYSTEM', 'Achat'), lastLabelWrite: null })).toMatchObject({ authority: 'UNKNOWN', reason: 'NO_TITLE_TRACE' });
  });
  it('stock (aucune provenance) : motif d’un moteur connu → SYSTEM ; geste d’un utilisateur → USER ; motif inconnu → INCONNU', () => {
    for (const r of SYSTEM_TITLE_REASONS) expect(etat(operationTitleAuthority({ technicalLabel: 'Achat', lastLabelWrite: trace(r, 'Achat') })), r).toBe('SYSTEM');
    // Motif T3 même dans une session portant un auteur : écrit par la règle du moteur, pas un choix.
    expect(etat(operationTitleAuthority({ technicalLabel: 'Achat', lastLabelWrite: trace('T3_ATTRIBUTES_CONSOLIDATED', 'Achat', 3) }))).toBe('SYSTEM');
    expect(etat(operationTitleAuthority({ technicalLabel: 'Achat', lastLabelWrite: trace('USER_DECLARATION_UPDATE', 'Achat') }))).toBe('USER');
    expect(etat(operationTitleAuthority({ technicalLabel: 'Achat', lastLabelWrite: trace('ASSISTANT_W22', 'Achat', 12) }))).toBe('USER');
    expect(operationTitleAuthority({ technicalLabel: 'Achat', lastLabelWrite: trace('LEGACY_IMPORT', 'Achat') })).toMatchObject({ authority: 'UNKNOWN', reason: 'HISTORY_TITLE_WRITE_UNCLASSIFIED' });
  });
  it('trace contradictoire (valeur historisée ≠ valeur actuelle) ou absente : INCONNU ; intitulé absent : rien à protéger', () => {
    expect(operationTitleAuthority({ technicalLabel: 'Achat', lastLabelWrite: trace('T3_CREATE_NEW', 'Autre') })).toMatchObject({ authority: 'UNKNOWN', reason: 'TITLE_DIFFERS_FROM_LAST_TRACE' });
    expect(operationTitleAuthority({ technicalLabel: 'Achat' })).toMatchObject({ authority: 'UNKNOWN', reason: 'NO_TITLE_TRACE' });
    expect(operationTitleAuthority({ technicalLabel: null })).toMatchObject({ authority: 'SYSTEM', reason: 'NO_TITLE' });
  });
  it('JAMAIS SYSTEM par égalité de chaînes : un intitulé égal au résumé, sans trace, reste INCONNU', () => {
    expect(etat(operationTitleAuthority({ technicalLabel: 'Achat', provenance: null, lastLabelWrite: null }))).toBe('UNKNOWN');
  });
});

describe('C859-U-02 — Agenda : provenance du champ titre', () => {
  const auto = { title: 'Achat', isAutomatic: true, isAutomaticModified: false };
  it('élément saisi par l’utilisateur : USER, jamais éligible — quelle que soit la provenance', () => {
    expect(agendaTitleAuthority({ ...auto, isAutomatic: false })).toMatchObject({ authority: 'USER', reason: 'MANUAL_ITEM' });
    expect(agendaTitleAuthority({ ...auto, isAutomatic: false, provenance: prov('SYSTEM', 'Achat') }).authority).toBe('USER');
  });
  it('provenance par champ de la valeur actuelle : elle décide, même après une correction de date (indicateur global levé)', () => {
    expect(agendaTitleAuthority({ ...auto, isAutomaticModified: true, provenance: prov('SYSTEM', 'Achat') })).toMatchObject({ authority: 'SYSTEM', reason: 'SYSTEM_TITLE_RECORDED' });
    expect(agendaTitleAuthority({ ...auto, isAutomaticModified: true, provenance: prov('USER', 'Achat') }).authority).toBe('USER');
    expect(agendaTitleAuthority({ ...auto, isAutomaticModified: true, provenance: prov('UNKNOWN', 'Achat') }).authority).toBe('UNKNOWN');
  });
  it('stock sans provenance : intact → SYSTEM ; modifié avec trace USER du titre → USER ; modifié sans trace du champ → INCONNU (jamais USER par le seul indicateur)', () => {
    expect(agendaTitleAuthority(auto)).toMatchObject({ authority: 'SYSTEM', reason: 'AUTOMATIC_UNTOUCHED' });
    expect(agendaTitleAuthority({ ...auto, isAutomaticModified: true, stockUserTitleTrace: true })).toMatchObject({ authority: 'USER', reason: 'STOCK_USER_TITLE_EDIT_TRACED' });
    expect(agendaTitleAuthority({ ...auto, isAutomaticModified: true })).toMatchObject({ authority: 'UNKNOWN', reason: 'MODIFIED_WITHOUT_TITLE_TRACE' });
    // Provenance d'une autre valeur : ignorée, repli.
    expect(agendaTitleAuthority({ ...auto, isAutomaticModified: true, provenance: prov('SYSTEM', 'Ancien') }).authority).toBe('UNKNOWN');
  });
  it('ligne brute (colonnes de preuve) : même décision', () => {
    expect(agendaTitleAuthorityOfRow({ title: 'Achat', is_automatic: true, is_automatic_modified: true, title_provenance: prov('SYSTEM', 'Achat'), stock_user_title_trace: false }).authority).toBe('SYSTEM');
    expect(agendaTitleAuthorityOfRow({ title: 'Achat', is_automatic: true, modified: true, title_provenance: null, stock_user_title_trace: true }).authority).toBe('USER');
  });
});

// ── T3 ──────────────────────────────────────────────────────────────────────
const persiste = (over: Partial<CandidateRecord> = {}): CandidateRecord => ({
  id: 1, accountId: 1, fileId: FICHIER, candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'ACQUISITION', statusHint: 'REALIZED',
  summary: 'Achat',
  payload: {
    sourceRoleHint: 'INVOICE', provider: 'TotalEnergies', temporalHints: { realizedDate: AUJ },
    financialHints: [{ role: 'REALIZED_COST', amountMinor: 6230, currency: 'EUR', amountScope: 'TOTAL', economicDate: AUJ }] as never,
  },
  ...over,
});
const identite = buildCandidateIdentity(persiste(), {
  fileAssetId: CUPRA, fileDocumentTypeCode: 'ACQUISITION_INVOICE', liveAssetIds: new Set([CUPRA]), equipmentAssets: new Map<number, number>(),
  assetNames: new Map([[CUPRA, 'Cupra']]), fileDesignation: { subject: 'de carburant TotalEnergies', otherArticles: false },
});
const source: SourceContribution = { sourceId: 1, identity: identite };

describe('C859-U-03 — T3 : seule l’autorité du champ décide de l’intitulé d’un achat', () => {
  const decide = (technicalLabel: string | null, authority: TitleAuthorityDecision['authority']) =>
    acquisitionLabelDecision({ typeCode: 'ACQUISITION', technicalLabel, contributions: [source], authority: { authority } });
  it('AC01 / AC02 : intitulé SYSTEM « Achat » — amélioré, que l’opération porte ou non une correction de date, de statut, de lien ou de montant', () => {
    // La correction d'un autre champ n'entre plus dans la décision (plus de paramètre `fullyManaged`) : la même réponse.
    expect(decide('Achat', 'SYSTEM')).toBe('Achat de carburant');
    expect(decide(null, 'SYSTEM')).toBe('Achat de carburant');
  });
  it('AC03 : intitulé USER — jamais remplacé, y compris égal au résumé (« Achat ») ou à une ancienne valeur générée', () => {
    for (const v of ['Achat', 'Achat de carburant TotalEnergies', 'Plein des vacances']) expect(decide(v, 'USER'), v).toBeUndefined();
  });
  it('AC04 : provenance INCONNUE — aucune écriture ; SYSTEM déjà à jour — pas de réécriture', () => {
    expect(decide('Achat', 'UNKNOWN')).toBeUndefined();
    expect(decide('Achat de carburant', 'SYSTEM')).toBeUndefined();
  });
});

// ── T4 ──────────────────────────────────────────────────────────────────────
function op(over: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return {
    id: 10, accountId: 1, typeCode: 'ACQUISITION', status: 'REALIZED', technicalLabel: 'Achat de carburant', provider: 'TotalEnergies',
    plannedDate: null, realizedDate: AUJ, endDate: null, active: true, assetIds: [CUPRA], equipmentIds: [], documentFileIds: [FICHIER],
    contractEffectiveTo: null, claimHistoryEventId: null, disposalKind: 'SALE', assetNames: ['Cupra'],
    documentTitles: ['Ticket de carburant TotalEnergies — 20 novembre 2026', 'Ticket de carburant'], ...over,
  };
}
function item(over: Partial<AgendaItemSnapshot> = {}): AgendaItemSnapshot {
  return {
    id: 100, title: 'Achat', date: AUJ, isAutomatic: true, isAutomaticModified: false, projected: false,
    businessOperationId: 10, linkedOperationActive: true, nature: 'HISTORICAL', businessType: 'purchase', homeCategory: 'information', functionalKey: null,
    originRefType: 'asset_file', originRefId: FICHIER, assetIds: [CUPRA], equipmentIds: [], fileIds: [FICHIER], carriedFact: 'ACQUISITION', carrierOrigin: 'SYSTEM', ...over,
  };
}
const plan = (o: OperationSnapshot, linked: AgendaItemSnapshot[]) =>
  planOperationProjection({ op: o, decision: decideProjection(o, AUJ), linked, suppressedKeys: new Set<string>(), candidates: [] });
const autorite = (authority: TitleAuthorityDecision['authority']): TitleAuthorityDecision => ({ authority, reason: authority === 'SYSTEM' ? 'SYSTEM_TITLE_RECORDED' : authority === 'USER' ? 'USER_TITLE_RECORDED' : 'MODIFIED_WITHOUT_TITLE_TRACE', evidence: null });
const fk = projectionFunctionalKey(10, 'ACQUISITION');
const projete = (over: Partial<AgendaItemSnapshot> = {}) => item({ id: 201, projected: true, functionalKey: fk, originRefType: 'business_operation', originRefId: 10, fileIds: [], carriedFact: undefined, carrierOrigin: undefined, ...over });

describe('C859-U-04 — T4 : matrice autorité du titre × champs édités, chemins DOCUMENT et OPERATION', () => {
  // « Champs édités » : la date, la description, la confirmation d'une prévision — tous lèvent l'indicateur GLOBAL
  // `is_automatic_modified` ; seule l'autorité du CHAMP titre décide.
  const edites = [{ isAutomaticModified: false }, { isAutomaticModified: true }];
  it('DOCUMENT (RETITLE) : titre SYSTEM renommé que la date ait été corrigée ou non ; USER et INCONNU jamais', () => {
    for (const e of edites) {
      expect(plan(op(), [item({ ...e, titleAuthority: autorite('SYSTEM') })]), JSON.stringify(e)).toEqual([{ kind: 'RETITLE', itemId: 100, title: 'Achat de carburant', from: 'Achat' }]);
      expect(plan(op(), [item({ ...e, titleAuthority: autorite('USER') })])).toEqual([]);
      expect(plan(op(), [item({ ...e, titleAuthority: autorite('UNKNOWN') })])).toEqual([]);
    }
  });
  it('OPERATION : projection intacte → SYNC du titre (inchangé) ; projection dont seule la DATE a été corrigée → RETITLE du TITRE SEUL', () => {
    expect(plan(op(), [projete({ titleAuthority: autorite('SYSTEM') })])).toEqual([{ kind: 'SYNC', itemId: 201, changes: { title: 'Achat de carburant' } }]);
    // Date de l'utilisateur (2026-11-19) : jamais réécrite — aucune action DATE, aucune SYNC.
    const corrigee = projete({ isAutomaticModified: true, date: '2026-11-19', titleAuthority: autorite('SYSTEM') });
    expect(plan(op(), [corrigee])).toEqual([{ kind: 'RETITLE', itemId: 201, title: 'Achat de carburant', from: 'Achat' }]);
    expect(plan(op(), [{ ...corrigee, titleAuthority: autorite('USER') }])).toEqual([]);
    expect(plan(op(), [{ ...corrigee, titleAuthority: autorite('UNKNOWN') }])).toEqual([]);
    // Projection intacte mais titre non SYSTEM (provenance contradictoire) : la SYNC n'emporte pas le titre.
    expect(plan(op(), [projete({ titleAuthority: autorite('UNKNOWN') })])).toEqual([]);
  });
  it('sans meilleur nom (« Achat » seul) : rien ; second passage après renommage : plan vide (idempotence)', () => {
    expect(plan(op({ technicalLabel: 'Achat' }), [item({ isAutomaticModified: true, titleAuthority: autorite('SYSTEM') })])).toEqual([]);
    expect(plan(op(), [item({ title: 'Achat de carburant', isAutomaticModified: true, titleAuthority: autorite('SYSTEM') })])).toEqual([]);
    expect(plan(op(), [projete({ title: 'Achat de carburant', isAutomaticModified: true, titleAuthority: autorite('SYSTEM') })])).toEqual([]);
  });
  it('gardes INDÉPENDANTES conservées : « à qualifier » / prévision / consolidation restaurée (pendingHold), type incompatible, élément saisi, titre explicite', () => {
    const sys = { isAutomaticModified: true, titleAuthority: autorite('SYSTEM') };
    expect(plan(op(), [item({ ...sys, pendingHold: true })])).toEqual([]);
    expect(plan(op(), [item({ ...sys, pendingStatus: true })])).toEqual([]); // ancien instantané : pendingStatus seul
    // Confirmation d'une prévision par l'utilisateur (décision sur la DATE) : ne protège pas le titre.
    expect(plan(op(), [item({ ...sys, pendingStatus: true, pendingHold: false })])).toEqual([{ kind: 'RETITLE', itemId: 100, title: 'Achat de carburant', from: 'Achat' }]);
    expect(plan(op(), [item({ ...sys, businessType: 'maintenance' })]).some((a) => a.kind === 'RETITLE')).toBe(false);
    expect(plan(op(), [item({ ...sys, isAutomatic: false })])).toEqual([]);
    expect(plan(op(), [item({ ...sys, title: 'Achat — Pneus hiver' })])).toEqual([]);
    // Projection d'une AUTRE opération : jamais renommée par celle-ci.
    expect(plan(op(), [projete({ ...sys, businessOperationId: 99 })]).some((a) => a.kind === 'RETITLE')).toBe(false);
  });
  it('sans autorité lue (instantané sans provenance) : déduite des indicateurs — modifié = INCONNU, jamais renommé', () => {
    expect(itemTitleAuthority(item({ isAutomaticModified: true })).authority).toBe('UNKNOWN');
    expect(purchaseTitleRenamable(item())).toBe(true);
    expect(plan(op(), [item({ isAutomaticModified: true })])).toEqual([]);
  });
  it('autres types : règles et gardes globales inchangées (intervention : élément modifié jamais renommé)', () => {
    const interv = op({ typeCode: 'INTERVENTION', technicalLabel: 'Remplacement de la chaudière' });
    const generique = item({ title: 'Intervention', businessType: 'maintenance', isAutomaticModified: true, titleAuthority: autorite('SYSTEM') });
    expect(plan(interv, [generique]).some((a) => a.kind === 'RETITLE')).toBe(false);
  });
});

describe('C859-U-05 — indépendance Opération / Agenda ; titre renvoyé inchangé', () => {
  it('intitulé de l’opération USER, titre de l’événement SYSTEM : la propagation existante s’applique au seul titre SYSTEM', () => {
    // L'intitulé choisi par l'utilisateur est la source du titre précis — l'événement SYSTEM le reçoit (règle existante).
    expect(plan(op({ technicalLabel: 'Achat de pneus hiver' }), [item({ isAutomaticModified: true, titleAuthority: autorite('SYSTEM') })]))
      .toEqual([{ kind: 'RETITLE', itemId: 100, title: 'Achat de pneus hiver', from: 'Achat' }]);
  });
  it('intitulé de l’opération SYSTEM, titre de l’événement USER : l’événement n’est jamais écrasé ; l’intitulé reste améliorable (T3)', () => {
    expect(plan(op(), [item({ titleAuthority: autorite('USER') })])).toEqual([]);
    expect(acquisitionLabelDecision({ typeCode: 'ACQUISITION', technicalLabel: 'Achat', contributions: [source], authority: { authority: 'SYSTEM' } })).toBe('Achat de carburant');
  });
  it('le geste explicite seul est déclaré USER ; une déclaration ne vaut que pour l’instruction (valeur vide = retrait)', () => {
    expect(JSON.parse(titleDeclarationValue({ origin: 'USER', reason: 'USER_AGENDA_TITLE_EDIT', actorUserId: 4, channel: 'AGENDA' })))
      .toEqual({ origin: 'USER', reason: 'USER_AGENDA_TITLE_EDIT', actorUserId: 4, channel: 'AGENDA', evidence: null });
    expect(JSON.parse(titleDeclarationValue({ origin: 'USER', reason: 'R', explicit: true })).explicit).toBe(true);
    // « explicite » n'a de sens que pour un choix de l'utilisateur.
    expect(JSON.parse(titleDeclarationValue({ origin: 'SYSTEM', reason: 'R', explicit: true })).explicit).toBeUndefined();
    expect(titleDeclarationValue(null)).toBe('');
  });
});

describe('C859-U-06 — garde SQL d’écriture : même règle que la décision', () => {
  it('« titre SYSTEM » écrite pour le WHERE de l’écriture : élément automatique ; provenance de la valeur actuelle ; sinon élément intact', () => {
    const g = AGENDA_TITLE_SYSTEM_SQL('i');
    expect(g).toContain('i.is_automatic AND');
    expect(g).toContain(`(to_jsonb(i) -> 'title_provenance' ->> 'value') IS NOT DISTINCT FROM i.title`);
    expect(g).toContain(`THEN (to_jsonb(i) -> 'title_provenance' ->> 'origin') = 'SYSTEM'`);
    expect(g).toContain('ELSE NOT COALESCE(i.is_automatic_modified, false)');
  });
  it('renommage d’un achat : garde du titre + gardes indépendantes ; ni l’indicateur global ni l’origine de projection', () => {
    expect(PURCHASE_RETITLE_SQL).toContain(AGENDA_TITLE_SYSTEM_SQL('i'));
    expect(PURCHASE_RETITLE_SQL).toContain('requires_qualification');
    expect(PURCHASE_RETITLE_SQL).toContain(`occurrence_nature IS DISTINCT FROM 'FORECAST'`);
    expect(PURCHASE_RETITLE_SQL).toContain('restored_at IS NOT NULL');
    expect(PURCHASE_RETITLE_SQL).not.toContain('projection_origin IS NULL');
    expect(PURCHASE_RETITLE_SQL).not.toContain("confirmation_mode IS DISTINCT FROM 'USER'");
  });
});

describe('C859-U-07 — reprise : même extraction des titres', () => {
  it('RETITLE (DOCUMENT ou OPERATION) et SYNC du seul titre sont des changements de titre ; le reste reste signalé', () => {
    expect(nonTitleActions([{ kind: 'RETITLE', itemId: 1, title: 'a', from: 'b' }, { kind: 'SYNC', itemId: 2, changes: { title: 'a' } }])).toEqual([]);
    expect(nonTitleActions([{ kind: 'SYNC', itemId: 2, changes: { title: 'a', date: AUJ } }])).toEqual(['SYNC']);
  });
});
