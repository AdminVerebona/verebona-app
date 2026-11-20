/**
 * Carte Trello #744 (CDC « Opérations / Agenda V2.0 » §4, §5, §8, §20 ; AC13,
 * AC14, AC16 à AC18) — carte « À traiter » d'ARBITRAGE D'UNE ASSOCIATION entre
 * deux événements de référence : règles PURES et DÉCLARATIONS (aucune base,
 * aucun appel IA, aucune dépendance à la date du jour).
 *
 *   Q  question et propositions : neutres, jamais le mot interdit, bornées ;
 *   C  contexte de la carte : relu strictement (une requête forgée ne passe pas) ;
 *   M  mémoire des preuves : un nouveau passage sur les mêmes preuves ne
 *      redemande rien ; une source jamais présentée rouvre un arbitrage ;
 *   D  déclarations : catalogue, producteur, publiabilité, mascotte, passerelle.
 * Le parcours sur PostgreSQL réel est couvert par
 * `src/test/e2e/scenarios/l114o-traitements-a-traiter.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const cartes = await import('../operation-relation-cards');
const { PROCESSING_RULES, RULE_PRODUCERS } = await import('../rules-catalog');
const { PUBLISHABILITY_CONTRACTS, PUBLISHABILITY_CHECK_ID } = await import('../publishability');
const { todoTitle } = await import('@/services/home/mascot/todo-items');
const { pairKey } = await import('@/services/business-operations/graph/model');

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n?/g, '\n');

const ctx = (over: Partial<import('../operation-relation-cards').OperationRelationContext> = {}) => ({
  kind: 'operation_relation' as const, pairKey: '3:8', relationId: 12, relationVersion: 1,
  fromOperationId: 3, toOperationId: 8, nature: 'FINANCING' as const,
  evidence: [{ kind: 'DOCUMENT' as const, ref: '10' }], evidenceKeys: ['DOCUMENT|10'],
  events: [{ operationId: 3, title: 'Prêt — Maison' }, { operationId: 8, title: 'Achat — Maison' }],
  documents: [{ fileId: 10, title: 'Offre de prêt' }], ...over,
});

describe('L114O-A-Q — question et propositions : neutres, et jamais le mot interdit', () => {
  it('L114O-A-Q1 — la question nomme les deux événements, rappelle le refus et ne suggère aucune réponse', () => {
    const q = cartes.operationRelationQuestion('Prêt immobilier — Maison', 'Achat — Maison');
    expect(q).toBe('Vous aviez choisi de ne pas associer « Prêt immobilier — Maison » et « Achat — Maison ». '
      + 'Un nouveau justificatif les rapproche : faut-il les associer ?');
    // Règle permanente : jamais « Opération » affiché ; et aucune des deux réponses n'est recommandée.
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(q).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    expect(q).not.toMatch(/recommand|conseill|probable|sans doute/i);
  });

  it('L114O-A-Q2 — un intitulé très long est borné, l’espacement normalisé ; aucun saut de ligne', () => {
    const q = cartes.operationRelationQuestion(`Contrat\n   d'entretien ${'x'.repeat(200)}`, 'B');
    expect(q).not.toContain('\n');
    expect(q).toContain('…');
    const [cite] = q.match(/« [^»]+ »/g)!;
    expect(cite.length).toBeLessThanOrEqual(54);
  });

  it('L114O-A-Q3 — deux propositions seulement : associer (jamais mise en avant) et garder l’état actuel', () => {
    const p = cartes.operationRelationProposals([10, 11, 10]);
    expect(p.map((x) => x.value)).toEqual(['ASSOCIATE', 'KEEP_SEPARATE']);
    expect(p[0]).toMatchObject({ label: 'Oui, les associer', emphasis: 'neutral', evidenceIds: ['file:10', 'file:11', 'file:10'] });
    expect(p[1]).toMatchObject({ label: 'Non, ne pas les associer', isCurrentValue: true });
    // L'état actuel est celui de l'utilisateur : il n'est pas présenté comme une proposition de l'IA.
    expect(p[1].evidenceIds).toBeUndefined();
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    for (const x of p) expect(x.label).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    expect(cartes.operationRelationProposals([])[0].evidenceIds).toEqual([]);
  });

  it('L114O-A-Q4 — seules les deux réponses de la carte sont acceptées : une valeur forgée ne désigne rien', () => {
    expect(cartes.parseOperationRelationChoice('ASSOCIATE')).toBe('ASSOCIATE');
    expect(cartes.parseOperationRelationChoice('KEEP_SEPARATE')).toBe('KEEP_SEPARATE');
    for (const v of ['associate', 'MERGE', '', null, undefined, 1, true, {}, ['ASSOCIATE']]) {
      expect(cartes.parseOperationRelationChoice(v)).toBeNull();
    }
  });

  it('L114O-A-Q5 — une carte ouverte par PAIRE, dans les deux sens d’appel', () => {
    expect(cartes.operationRelationKey(8, 3)).toBe('operationRelation:3:8');
    expect(cartes.operationRelationKey(3, 8)).toBe(cartes.operationRelationKey(8, 3));
    expect(cartes.operationRelationKey(3, 8)).toBe(`operationRelation:${pairKey(3, 8)}`);
  });
});

describe('L114O-A-C — contexte de la carte : relu strictement', () => {
  it('L114O-A-C1 — un contexte complet est reconnu', () => {
    expect(cartes.isOperationRelationContext(ctx())).toBe(true);
  });

  it('L114O-A-C2 — tout contexte incomplet, réflexif, d’une autre famille ou d’une nature inconnue est refusé', () => {
    const refuses: unknown[] = [
      null, undefined, 'operation_relation', 42, [],
      ctx({ kind: 'period_conflict' as never }),
      ctx({ relationId: 0 }), ctx({ relationVersion: 0 }),
      ctx({ fromOperationId: 5, toOperationId: 5 }),
      ctx({ nature: 'FUSION' as never }),
      ctx({ evidence: 'DOCUMENT|10' as never }), ctx({ evidenceKeys: null as never }),
      ctx({ pairKey: 3 as never }),
    ];
    for (const c of refuses) expect(cartes.isOperationRelationContext(c), JSON.stringify(c)).toBe(false);
  });
});

describe('L114O-A-M — mémoire des preuves : jamais la même question deux fois', () => {
  it('L114O-A-M1 — les sources d’un jeu de preuves sont dédoublonnées et triées (l’extrait cité ne change pas la source)', () => {
    expect(cartes.evidenceSourceKeys([
      { kind: 'DOCUMENT', ref: '11' }, { kind: 'DOCUMENT', ref: '10', locator: 'page 2' },
      { kind: 'DOCUMENT', ref: '10', locator: 'page 7' }, { kind: 'AGENDA', ref: '4' },
    ])).toEqual(['AGENDA|4', 'DOCUMENT|10', 'DOCUMENT|11']);
    expect(cartes.evidenceSourceKeys([])).toEqual([]);
  });

  it('L114O-A-M2 — toutes les sources déjà présentées : rien n’est redemandé (AC14, « simple nouveau passage, non »)', () => {
    const repondues = new Set(['DOCUMENT|10', 'DOCUMENT|11']);
    expect(cartes.alreadyAnswered(['DOCUMENT|10'], repondues)).toBe(true);
    expect(cartes.alreadyAnswered(['DOCUMENT|10', 'DOCUMENT|11'], repondues)).toBe(true);
    // Aucune preuve : il n'y a rien de nouveau à opposer au refus de l'utilisateur.
    expect(cartes.alreadyAnswered([], repondues)).toBe(true);
    expect(cartes.alreadyAnswered([], new Set())).toBe(true);
  });

  it('L114O-A-M3 — une seule source jamais présentée rouvre un arbitrage', () => {
    expect(cartes.alreadyAnswered(['DOCUMENT|10', 'DOCUMENT|99'], new Set(['DOCUMENT|10']))).toBe(false);
    expect(cartes.alreadyAnswered(['AGENDA|4'], new Set(['DOCUMENT|4']))).toBe(false);
    expect(cartes.alreadyAnswered(['DOCUMENT|10'], new Set())).toBe(false);
  });
});

describe('L114O-A-D — déclarations : catalogue, producteur, publiabilité, mascotte, passerelle', () => {
  const regle = PROCESSING_RULES.find((r) => r.code === 'OPERATION-RELATION')!;

  it('L114O-A-D1 — la règle est au catalogue, sans décision de l’IA, et sa question est celle du module', () => {
    expect(regle).toMatchObject({
      targetType: 'DOCUMENT', relationKey: 'operationRelation', completePriority: null, allowNotApplicable: false,
      producer: 'REFERENCE_EVENT_GRAPH',
    });
    // L'utilisateur tranche : aucune formulation « l'IA propose », aucune réponse automatique possible.
    expect(regle.formulation.kind).toBe('DETERMINISTIC');
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(regle.question).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
  });

  it('L114O-A-D2 — le producteur désigne un module réel et ses deux points d’entrée existent', () => {
    const p = RULE_PRODUCERS.REFERENCE_EVENT_GRAPH;
    expect(p.module).toBe('src/services/to-process/operation-relation-cards.ts');
    const source = lire(p.module);
    for (const e of p.entries) expect(source).toContain(`export async function ${e}`);
    expect(cartes.requestOperationRelationArbitration).toBeTypeOf('function');
    expect(cartes.resolveOperationRelationCard).toBeTypeOf('function');
  });

  it('L114O-A-D3 — publiabilité : famille « opérations », prémisse contrôlée dès la création et fermeture déclarée', () => {
    const c = PUBLISHABILITY_CONTRACTS['OPERATION-RELATION'];
    expect(c).toMatchObject({ family: 'EVENEMENTS_DE_REFERENCE', decisions: 'PRODUCTION', atCreation: true });
    expect(c.cleanup).toEqual({ by: PUBLISHABILITY_CHECK_ID, service: 'closeCardsNoLongerUseful' });
    // La carte ne vaut plus dès qu'un des deux événements est retiré, ou que la relation n'est plus refusée.
    const sql = c.noLongerUseful!('a');
    expect(sql).toContain("a.trigger_context->>'fromOperationId'");
    expect(sql).toContain("a.trigger_context->>'toOperationId'");
    expect(sql).toContain("r.state = 'REJECTED'");
    // Isolation : toute lecture de la prémisse est filtrée par le compte de la carte.
    expect(sql).toContain('r.account_id = a.account_id');
    expect(sql.match(/o\.account_id = a\.account_id/g)).toHaveLength(2);
  });

  it('L114O-A-D4 — mascotte : un sujet dit en français, sans le mot interdit', () => {
    const titre = todoTitle('OPERATION-RELATION', 'ARBITRATE');
    expect(titre).toBe('Association à confirmer');
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(titre).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
  });

  it('L114O-A-D5 — passerelle : la demande part de la façade, qui n’est jamais contournée (aucune écriture ici)', () => {
    const pont = lire('src/services/business-operations/graph/arbitration.ts');
    expect(pont).toContain("if (r.status !== 'ARBITRATION_REQUIRED' || r.code !== 'NEW_EVIDENCE_AFTER_REFUSAL') return r;");
    expect(pont).toContain('requestOperationRelationArbitration');
    // Ni SQL, ni écriture, ni appel IA dans la passerelle : elle n'ajoute aucune règle.
    expect(pont).not.toMatch(/INSERT|UPDATE |pgClient|\bdb\b|callAi|openai/i);
    // La résolution repasse par la façade (jamais une écriture directe de la relation par la file).
    const file = lire('src/services/to-process/operation-relation-cards.ts');
    expect(file).toContain('facade.associateOperations(');
    expect(file).toContain('facade.dissociateOperations(');
    expect(file).not.toMatch(/INSERT INTO business_operation_relations|UPDATE business_operation_relations/i);
    expect(file).toContain("channel: 'TO_PROCESS' as const");
  });

  it('L114O-A-D6 — AC16 : la carte se porte sur un objet RÉEL, jamais créé — justificatif, sinon événement de l’Agenda du graphe N↔N', () => {
    const file = lire('src/services/to-process/operation-relation-cards.ts');
    // Lectures partagées par les trois cartes d'événements de référence (une seule règle) : `reference-event-card-anchor.ts`.
    const lectures = lire('src/services/to-process/reference-event-card-anchor.ts');
    // Aucun objet n'est créé pour porter la carte : ni document, ni événement de l'Agenda.
    for (const src of [file, lectures]) expect(src).not.toMatch(/INSERT INTO asset_files|INSERT INTO agenda_items/i);
    // Le repli lit le graphe N↔N (jamais la colonne historique, jamais le rôle « principal »).
    expect(lectures).toContain('business_operation_agenda_links');
    for (const src of [file, lectures]) expect(src).not.toMatch(/operation_role|business_operation_id/);
    expect(file).toContain("return { status: 'NO_ANCHOR', reason: 'NO_REAL_OBJECT' };");
  });
});
