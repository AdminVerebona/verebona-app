/**
 * Carte Trello #744 (CDC « Opérations / Agenda V2.0 » §7, §8, §11, §20 ; AC11,
 * AC12, AC16, AC17, AC18) — les deux cartes « À traiter » de FUSION entre deux
 * événements de référence : règles PURES et DÉCLARATIONS (aucune base, aucun
 * appel IA, aucune dépendance à la date du jour).
 *
 *   Q  questions et propositions : neutres, jamais le mot interdit, bornées ;
 *   C  contextes : relus strictement (une requête forgée ne passe pas) ;
 *   M  mémoire des preuves et de la séparation décidée ;
 *   D  déclarations : catalogue, producteur, publiabilité, mascotte, passerelle,
 *      garde de la fusion automatique T3.
 * Le parcours sur PostgreSQL réel est couvert par
 * `src/test/e2e/scenarios/l114u-rattachement-fusion.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const fusions = await import('../operation-merge-cards');
const { PROCESSING_RULES, RULE_PRODUCERS } = await import('../rules-catalog');
const { PUBLISHABILITY_CONTRACTS, PUBLISHABILITY_CHECK_ID } = await import('../publishability');
const { todoTitle } = await import('@/services/home/mascot/todo-items');
const { pairKey } = await import('@/services/business-operations/graph/model');

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n?/g, '\n');
/** Le CODE seul : les commentaires expliquent les règles écartées, ils ne doivent pas déclencher les contrôles. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const mergeCtx = (over: Partial<import('../operation-merge-cards').ReferenceEventMergeContext> = {}) => ({
  kind: 'reference_event_merge' as const, pairKey: '3:8', canonicalOperationId: 3, absorbedOperationId: 8, absorbedVersion: 2,
  events: [{ operationId: 3, title: 'Réparation de fuite' }, { operationId: 8, title: 'Intervention plomberie' }],
  evidence: [{ kind: 'DOCUMENT' as const, ref: '10' }], evidenceKeys: ['DOCUMENT|10'],
  documents: [{ fileId: 10, title: 'Facture de plomberie' }], ...over,
});

const factCtx = (over: Partial<import('../operation-merge-cards').ReferenceEventFactContext> = {}) => ({
  kind: 'reference_event_fact' as const, pairKey: '3:8', field: 'realizedDate' as const,
  sides: [
    { operationId: 3, title: 'Sinistre tempête', value: '2025-03-10', version: 1 },
    { operationId: 8, title: 'Réparation de la toiture', value: '2025-03-12', version: 4 },
  ],
  evidence: [], evidenceKeys: ['FACT|3:2025-03-10', 'FACT|8:2025-03-12'],
  documents: [], ...over,
});

describe('L114U-F-Q — questions et propositions : neutres, et jamais le mot interdit', () => {
  it('L114U-F-Q1 — « même événement de référence, ou deux ? » nomme les deux et ne suggère rien', () => {
    const q = fusions.referenceEventMergeQuestion('Réparation de fuite — Maison', 'Intervention plomberie — Maison');
    expect(q).toBe('« Réparation de fuite — Maison » et « Intervention plomberie — Maison » : est-ce le même '
      + 'événement de référence, ou deux ?');
    expect(q).not.toMatch(/\bop[ée]ration/i);
    expect(q).not.toMatch(/recommand|conseill|probable|sans doute|doublon [ée]vident/i);
  });

  it('L114U-F-Q2 — deux propositions : fusionner (jamais mise en avant) et garder deux événements (état actuel)', () => {
    const p = fusions.referenceEventMergeProposals([10, 11]);
    expect(p.map((x) => x.value)).toEqual(['MERGE', 'KEEP_DISTINCT']);
    expect(p[0]).toMatchObject({ label: 'Oui, c’est le même', emphasis: 'neutral', evidenceIds: ['file:10', 'file:11'] });
    expect(p[1]).toMatchObject({ label: 'Non, ce sont deux événements différents', isCurrentValue: true });
    expect(p[1].evidenceIds).toBeUndefined();
    for (const x of p) expect(x.label).not.toMatch(/\bop[ée]ration/i);
    expect(fusions.parseMergeChoice('MERGE')).toBe('MERGE');
    expect(fusions.parseMergeChoice('KEEP_DISTINCT')).toBe('KEEP_DISTINCT');
    for (const v of ['merge', 'ASSOCIATE', '', null, 1, {}]) expect(fusions.parseMergeChoice(v)).toBeNull();
  });

  it('L114U-F-Q3 — « quel fait est correct ? » reprend les libellés déjà posés, une proposition par valeur', () => {
    const q = fusions.referenceEventFactQuestion('realizedDate', 'Sinistre tempête', 'Réparation de la toiture');
    expect(q).toBe('« Sinistre tempête » et « Réparation de la toiture » indiquent des dates de réalisation '
      + 'différentes : laquelle est la bonne ?');
    expect(q).not.toMatch(/\bop[ée]ration/i);
    const p = fusions.referenceEventFactProposals('realizedDate', factCtx().sides);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ value: 'FACT:2025-03-10', label: '10/03/2025 — « Sinistre tempête »', emphasis: 'neutral' });
    expect(p[1]!.value).toBe('FACT:2025-03-12');
    // Deux valeurs en place sur deux objets distincts : aucune n'est « la » valeur actuelle.
    for (const x of p) expect(x.isCurrentValue).toBeUndefined();
    // Deux fois la même valeur ne fait qu'une proposition (jamais un choix factice).
    expect(fusions.referenceEventFactProposals('realizedDate', [
      { operationId: 3, title: 'A', value: '2025-03-10' }, { operationId: 8, title: 'B', value: '2025-03-10' },
    ])).toHaveLength(1);
  });

  it('L114U-F-Q4 — seule une valeur PRÉSENTÉE par la carte est acceptée (une requête forgée ne désigne rien)', () => {
    const sides = factCtx().sides;
    expect(fusions.parseFactChoice('FACT:2025-03-12', sides)).toBe('2025-03-12');
    for (const v of ['FACT:2030-01-01', 'FACT:', '2025-03-12', 'MERGE', '', null, 7, {}]) {
      expect(fusions.parseFactChoice(v, sides), String(v)).toBeNull();
    }
  });

  it('L114U-F-Q5 — une carte par PAIRE (fusion), une carte par paire ET par fait (contradiction)', () => {
    expect(fusions.referenceEventMergeKey(8, 3)).toBe('referenceEventMerge:3:8');
    expect(fusions.referenceEventMergeKey(3, 8)).toBe(`referenceEventMerge:${pairKey(3, 8)}`);
    expect(fusions.referenceEventFactKey(8, 3, 'realizedDate')).toBe('referenceEventFact:3:8:realizedDate');
    expect(fusions.referenceEventFactKey(3, 8, 'startDate')).not.toBe(fusions.referenceEventFactKey(3, 8, 'realizedDate'));
  });

  // Règle remplacée (carte #791, décision du PO du 16/11/2026) : le PRESTATAIRE est désormais un fait
  // comparable entre deux événements de référence associés. Le test n'est pas supprimé, il est réécrit.
  it('L114U-F-Q6 — les faits comparables sont ceux du référentiel, prestataire COMPRIS (règle remplacée, carte #791)', () => {
    expect(fusions.FACT_DATE_FIELDS).toEqual(['plannedDate', 'startDate', 'realizedDate', 'endDate']);
    expect(fusions.FACT_FIELDS).toEqual(['plannedDate', 'startDate', 'realizedDate', 'endDate', 'provider']);
    for (const f of fusions.FACT_FIELDS) expect(fusions.isFactField(f)).toBe(true);
    for (const f of fusions.FACT_DATE_FIELDS) expect(fusions.isFactDateField(f)).toBe(true);
    expect(fusions.isFactDateField('provider')).toBe(false);
    for (const v of ['amount', 'realized_date', 'PROVIDER', '', null, 1]) expect(fusions.isFactField(v)).toBe(false);
  });

  it('L115F-F-Q7 — « lequel est le bon ? » pour le prestataire : mêmes libellés que la carte #750, jamais le mot interdit', () => {
    const q = fusions.referenceEventFactQuestion('provider', 'Sinistre tempête', 'Réparation de la toiture');
    expect(q).toBe('« Sinistre tempête » et « Réparation de la toiture » indiquent des prestataires '
      + 'différents : lequel est le bon ?');
    expect(q).not.toMatch(/\bop[ée]ration/i);
    expect(q).not.toMatch(/recommand|conseill|probable|sans doute/i);
    const sides = [
      { operationId: 3, title: 'Sinistre tempête', value: 'Assurance Alpha', version: 1 },
      { operationId: 8, title: 'Réparation de la toiture', value: 'Toitures Bêta', version: 2 },
    ];
    const p = fusions.referenceEventFactProposals('provider', sides);
    expect(p.map((x) => x.value)).toEqual(['FACT:Assurance Alpha', 'FACT:Toitures Bêta']);
    expect(p[0]!.label).toBe('Assurance Alpha — « Sinistre tempête »');
    for (const x of p) expect(x.isCurrentValue).toBeUndefined();
    expect(fusions.parseFactChoice('FACT:Toitures Bêta', sides)).toBe('Toitures Bêta');
    expect(fusions.parseFactChoice('FACT:Autre tiers', sides)).toBeNull();
    // Contexte relu strictement : une date n'est pas une désignation, et une désignation vide est refusée.
    expect(fusions.isReferenceEventFactContext({ ...factCtx(), field: 'provider', sides })).toBe(true);
    expect(fusions.isReferenceEventFactContext({
      ...factCtx(), field: 'provider',
      sides: [{ operationId: 3, title: 'A', value: '   ', version: 1 }, { operationId: 8, title: 'B', value: 'X', version: 1 }],
    })).toBe(false);
    expect(fusions.isReferenceEventFactContext({
      ...factCtx(), field: 'realizedDate',
      sides: [{ operationId: 3, title: 'A', value: 'Assurance Alpha', version: 1 }, { operationId: 8, title: 'B', value: 'X', version: 1 }],
    })).toBe(false);
  });

  it('L115F-F-Q8 — désignations équivalentes et rôles de partie : aucune fausse question (pur)', () => {
    const eq = { canonical: new Map([['assurancealpha', 'alpha'], ['alpha', 'alpha']]), classes: new Map() };
    expect(fusions.providerComparisonKey('Assurance Alpha', eq)).toBe(fusions.providerComparisonKey('Alpha', eq));
    // « Ets Bêta & Fils » et « Société Beta et Fils » : même forme normalisée, sans aucune table d'enseignes.
    expect(fusions.providerComparisonKey('Ets Bêta & Fils', null)).toBe(fusions.providerComparisonKey('Societe Beta et Fils', null));
    expect(fusions.providerComparisonKey('Toitures Bêta', eq)).not.toBe(fusions.providerComparisonKey('Assurance Alpha', eq));
    // « Même fait » = même rôle sémantique de la partie ; jamais une banque face à un fournisseur.
    expect(fusions.comparableProviderRoles('SUPPLIER', 'SUPPLIER')).toBe(true);
    expect(fusions.comparableProviderRoles('SUPPLIER', 'PAYMENT_INTERMEDIARY')).toBe(false);
    expect(fusions.comparableProviderRoles('UNKNOWN', 'UNKNOWN')).toBe(false);
    expect(fusions.comparableProviderRoles('USER_ENTRY', 'USER_ENTRY')).toBe(false);
    expect(fusions.comparableProviderRoles(undefined, undefined)).toBe(false);
  });
});

describe('L114U-F-C — contextes : relus strictement', () => {
  it('L114U-F-C1 — contextes complets reconnus', () => {
    expect(fusions.isReferenceEventMergeContext(mergeCtx())).toBe(true);
    expect(fusions.isReferenceEventFactContext(factCtx())).toBe(true);
  });

  it('L114U-F-C2 — fusion : tout contexte incomplet, réflexif, d’une autre famille ou SANS preuve est refusé', () => {
    const refuses: unknown[] = [
      null, undefined, 'reference_event_merge', 42, [],
      mergeCtx({ kind: 'operation_relation' as never }),
      mergeCtx({ canonicalOperationId: 0 }), mergeCtx({ absorbedOperationId: 0 }), mergeCtx({ absorbedVersion: 0 }),
      mergeCtx({ canonicalOperationId: 8, absorbedOperationId: 8 }),
      mergeCtx({ evidenceKeys: [] }), mergeCtx({ evidence: 'DOCUMENT|10' as never }),
      mergeCtx({ events: [{ operationId: 3, title: 'A' }] }),
    ];
    for (const c of refuses) expect(fusions.isReferenceEventMergeContext(c), JSON.stringify(c)).toBe(false);
  });

  it('L114U-F-C3 — fait : deux côtés distincts, deux valeurs DIFFÉRENTES au format du jour, versions connues', () => {
    const refuses: unknown[] = [
      null, undefined, 'reference_event_fact', 42, [],
      factCtx({ kind: 'reference_event_merge' as never }),
      // Règle remplacée (carte #791) : `provider` EST un fait comparable — mais avec des valeurs de DATE,
      // le contexte reste refusé (une date n'est pas une désignation de prestataire). Cas positif : L115F-F-Q7.
      factCtx({ field: 'provider' as never, sides: [
        { operationId: 3, title: 'A', value: '2025-03-10', version: 1 }, { operationId: 8, title: 'B', value: '', version: 1 }] }),
      factCtx({ field: 'realized_date' as never }),
      // Un seul côté, ou deux fois le même événement.
      factCtx({ sides: [{ operationId: 3, title: 'A', value: '2025-03-10', version: 1 }] }),
      factCtx({ sides: [{ operationId: 3, title: 'A', value: '2025-03-10', version: 1 }, { operationId: 3, title: 'A', value: '2025-03-12', version: 1 }] }),
      // Pas de contradiction : rien à arbitrer.
      factCtx({ sides: [{ operationId: 3, title: 'A', value: '2025-03-10', version: 1 }, { operationId: 8, title: 'B', value: '2025-03-10', version: 1 }] }),
      // Une valeur qui n'est pas une date du jour, ou une version inconnue.
      factCtx({ sides: [{ operationId: 3, title: 'A', value: 'hier', version: 1 }, { operationId: 8, title: 'B', value: '2025-03-10', version: 1 }] }),
      factCtx({ sides: [{ operationId: 3, title: 'A', value: '2025-03-10', version: 0 }, { operationId: 8, title: 'B', value: '2025-03-12', version: 1 }] }),
    ];
    for (const c of refuses) expect(fusions.isReferenceEventFactContext(c), JSON.stringify(c)).toBe(false);
  });
});

describe('L114U-F-M — mémoire : ni question répétée, ni séparation défaite', () => {
  it('L114U-F-M1 — sources dédoublonnées et triées ; toutes déjà présentées → rien n’est redemandé', () => {
    expect(fusions.mergeSourceKeys([
      { kind: 'DOCUMENT', ref: '11' }, { kind: 'DOCUMENT', ref: '10', locator: 'page 2' }, { kind: 'DOCUMENT', ref: '10' },
    ])).toEqual(['DOCUMENT|10', 'DOCUMENT|11']);
    expect(fusions.mergeAlreadyAnswered(['DOCUMENT|10'], new Set(['DOCUMENT|10']))).toBe(true);
    expect(fusions.mergeAlreadyAnswered([], new Set())).toBe(true);
    expect(fusions.mergeAlreadyAnswered(['DOCUMENT|10', 'DOCUMENT|99'], new Set(['DOCUMENT|10']))).toBe(false);
  });

  it('L114U-F-M2 — « deux événements différents » n’écrit RIEN et se relit dans la mémoire des cartes', () => {
    const src = lire('src/services/to-process/operation-merge-cards.ts');
    const bloc = src.slice(src.indexOf("if (choix === 'KEEP_DISTINCT')"), src.indexOf('const facade = await import'));
    expect(bloc).toContain('changed: false');
    expect(bloc).not.toMatch(/facade\./);
    // La mémoire est lue par une fonction nommée, bornée au compte, prudente en cas de panne.
    expect(src).toContain('export async function mergeRefusedByUser');
    expect(src).toContain("e.new_value->>'kind' = 'KEEP_DISTINCT'");
    expect(src).toContain('a.account_id = $1');
  });

  it('L114U-F-M3 — AC12 : la fusion AUTOMATIQUE de T3 lit cette séparation (une seule porte, `loadNonMergeable`)', () => {
    const conso = lire('src/services/business-operations/consolidation/consolidator.ts');
    const bloc = conso.slice(conso.indexOf('async function loadNonMergeable'), conso.indexOf('async function loadNonMergeable') + 3500);
    expect(bloc).toContain("ta.rule_code = 'REFERENCE-EVENT-MERGE'");
    expect(bloc).toContain("te.new_value->>'kind' = 'KEEP_DISTINCT'");
    expect(bloc).toContain("ta.resolution_reason = 'USER_ARBITRATED'");
    // Isolation : la lecture est bornée au compte et aux événements du passage.
    expect(bloc).toContain('ta.account_id = ${accountId}');
  });
});

describe('L114U-F-D — déclarations : catalogue, producteur, publiabilité, mascotte, passerelle', () => {
  it('L114U-F-D1 — les deux règles sont au catalogue, sans décision de l’IA', () => {
    for (const [codeRegle, relation] of [['REFERENCE-EVENT-MERGE', 'referenceEventMerge'], ['REFERENCE-EVENT-FACT', 'referenceEventFact']] as const) {
      const r = PROCESSING_RULES.find((x) => x.code === codeRegle)!;
      expect(r, codeRegle).toMatchObject({
        targetType: 'DOCUMENT', relationKey: relation, completePriority: null, allowNotApplicable: false,
        producer: 'REFERENCE_EVENT_MERGE', arbitratePriority: 'DO_NEXT',
      });
      expect(r.formulation.kind, codeRegle).toBe('DETERMINISTIC');
      expect(r.question, codeRegle).not.toMatch(/\bop[ée]ration/i);
    }
  });

  it('L114U-F-D2 — le producteur désigne un module réel et ses trois points d’entrée existent', () => {
    const p = RULE_PRODUCERS.REFERENCE_EVENT_MERGE;
    expect(p.module).toBe('src/services/to-process/operation-merge-cards.ts');
    const source = lire(p.module);
    for (const e of p.entries) expect(source, e).toContain(`export async function ${e}`);
  });

  it('L114U-F-D3 — publiabilité : famille « événements de référence », prémisses contrôlées, fermeture déclarée', () => {
    const m = PUBLISHABILITY_CONTRACTS['REFERENCE-EVENT-MERGE'];
    expect(m).toMatchObject({ family: 'EVENEMENTS_DE_REFERENCE', decisions: 'PRODUCTION', atCreation: true });
    expect(m.cleanup).toEqual({ by: PUBLISHABILITY_CHECK_ID, service: 'closeCardsNoLongerUseful' });
    expect(m.noLongerUseful!('a')).toContain("a.trigger_context->>'canonicalOperationId'");
    expect(m.noLongerUseful!('a')).toContain("a.trigger_context->>'absorbedOperationId'");
    const f = PUBLISHABILITY_CONTRACTS['REFERENCE-EVENT-FACT'];
    expect(f).toMatchObject({ family: 'EVENEMENTS_DE_REFERENCE', decisions: 'PRODUCTION', atCreation: true });
    const sql = f.noLongerUseful!('a');
    expect(sql).toContain("a.trigger_context#>>'{sides,0,operationId}'");
    expect(sql).toContain("r.state = 'ACTIVE'");
    // Isolation : toute lecture de la prémisse est filtrée par le compte de la carte.
    expect(sql).toContain('r.account_id = a.account_id');
  });

  it('L114U-F-D4 — mascotte : des sujets dits en français, sans le mot interdit', () => {
    expect(todoTitle('REFERENCE-EVENT-MERGE', 'ARBITRATE')).toBe('Doublon à confirmer');
    expect(todoTitle('REFERENCE-EVENT-FACT', 'ARBITRATE')).toBe('Date à confirmer');
    for (const c of ['REFERENCE-EVENT-MERGE', 'REFERENCE-EVENT-FACT']) expect(todoTitle(c, 'ARBITRATE')).not.toMatch(/\bop[ée]ration/i);
  });

  it('L114U-F-D5 — passerelle : le traitement DEMANDE, il ne fusionne pas (aucune écriture, aucune règle ici)', () => {
    const pont = lire('src/services/business-operations/graph/merge-proposal.ts');
    expect(pont).toContain('requestReferenceEventMergeArbitration');
    expect(pont).toContain('requestReferenceEventFactArbitration');
    expect(code(pont)).not.toMatch(/INSERT|UPDATE |pgClient|callAi|openai|gemini|mergeOperations/i);
  });

  it('L114U-F-D6 — la file n’écrit jamais elle-même : fusion et correction passent par la façade', () => {
    const src = lire('src/services/to-process/operation-merge-cards.ts');
    expect(src).toContain('facade.mergeOperations(');
    expect(src).toContain('facade.correctOperation(');
    expect(src).toContain("channel: 'TO_PROCESS' as const");
    expect(src).not.toMatch(/UPDATE business_operations|INSERT INTO business_operation|DELETE FROM/i);
    // Aucun objet n'est créé pour porter la carte (AC16 : « sans documents fictifs »).
    expect(src).not.toMatch(/INSERT INTO asset_files|INSERT INTO agenda_items/i);
    expect(src).toContain("return { status: 'NO_ANCHOR', reason: 'NO_REAL_OBJECT' };");
    // Jamais le rôle « principal », jamais la colonne historique.
    expect(code(src)).not.toMatch(/operation_role|'PRINCIPAL'|business_operation_id/);
  });

  it('L114U-F-D7 — la file de « À traiter » sait résoudre les deux règles', () => {
    const file = lire('src/services/to-process/resolve-action.service.ts');
    expect(file).toContain('isMergeCardRule');
    expect(file).toContain('resolveReferenceEventMergeCard');
    expect(fusions.isMergeCardRule('REFERENCE-EVENT-MERGE')).toBe(true);
    expect(fusions.isMergeCardRule('REFERENCE-EVENT-FACT')).toBe(true);
    expect(fusions.isMergeCardRule('OPERATION-RELATION')).toBe(false);
  });

  it('L114U-F-D8 — la commande de fusion de la façade est réservée à l’utilisateur et refuse deux types différents', () => {
    const facade = lire('src/services/business-operations/operation-write.facade.ts');
    const bloc = facade.slice(facade.indexOf("runCommand<MergeOperationsData>(ctx, 'mergeOperations'"));
    expect(bloc).toContain("if (ctx.actor.kind !== 'USER') return stop(refused('FORBIDDEN', 'USER_ONLY'));");
    expect(bloc).toContain("return stop(refused('FORBIDDEN', 'REFLEXIVE'));");
    expect(bloc).toContain("return stop(refused('FORBIDDEN', 'OPERATION_INACTIVE'));");
    expect(bloc).toContain("return stop(refused('CONFLICT', 'VERSION_MISMATCH'");
    expect(bloc).toContain("return stop(refused('FORBIDDEN', 'TYPE_MISMATCH'));");
    // Aucun moteur parallèle : la fusion elle-même reste celle du dépôt, par le service unique de regroupement.
    expect(bloc).toContain("await import('./grouping/service')");
    expect(bloc).not.toMatch(/UPDATE business_operations|merged_into_operation_id/);
  });
});
