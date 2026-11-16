/**
 * Carte Trello #744 — DÉCISION DU PO DU 16/11/2026 : un rattachement d'Agenda
 * SUPPLÉMENTAIRE proposé par une inférence exige un JUSTIFICATIF COMMUN, et
 * n'est jamais écrit directement. Règles PURES et DÉCLARATIONS (aucune base,
 * aucun appel IA, aucune dépendance à la date du jour).
 *
 *   Q  question et propositions : neutres, jamais le mot interdit, bornées ;
 *   C  contexte de la carte : relu strictement (une requête forgée ne passe pas) ;
 *   M  mémoire des justificatifs : un nouveau passage sur les mêmes pièces ne
 *      redemande rien ; une pièce jamais présentée rouvre la question ;
 *   P  PREUVE : la règle de la décision du PO, lisible dans le code ;
 *   D  déclarations : catalogue, producteur, publiabilité, mascotte, passerelle.
 * Le parcours sur PostgreSQL réel est couvert par
 * `src/test/e2e/scenarios/l114u-rattachement-fusion.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const cartes = await import('../operation-agenda-link-cards');
const { PROCESSING_RULES, RULE_PRODUCERS } = await import('../rules-catalog');
const { PUBLISHABILITY_CONTRACTS, PUBLISHABILITY_CHECK_ID } = await import('../publishability');
const { todoTitle } = await import('@/services/home/mascot/todo-items');

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n?/g, '\n');
/** Le CODE seul : les commentaires expliquent les règles écartées, ils ne doivent pas déclencher les contrôles. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ctx = (over: Partial<import('../operation-agenda-link-cards').OperationAgendaLinkContext> = {}) => ({
  kind: 'operation_agenda_link' as const, operationId: 3, agendaItemId: 9, currentOperationId: 8,
  operationTitle: 'Dégât des eaux — Maison', currentOperationTitle: 'Réparation de la toiture — Maison',
  itemTitle: 'Passage du couvreur',
  evidence: [{ kind: 'DOCUMENT' as const, ref: '10' }], evidenceKeys: ['DOCUMENT|10'],
  documents: [{ fileId: 10, title: 'Devis toiture' }], ...over,
});

describe('L114U-Q — question et propositions : neutres, et jamais le mot interdit', () => {
  it('L114U-Q1 — la question nomme l’événement, son rattachement actuel, la PIÈCE et la cible ; elle ne suggère rien', () => {
    const q = cartes.agendaLinkQuestion('Passage du couvreur', 'Réparation de la toiture', 'Dégât des eaux', 'Devis toiture');
    expect(q).toBe('« Passage du couvreur » est déjà rattaché à « Réparation de la toiture ». Le justificatif « Devis toiture » '
      + 'le relie aussi à « Dégât des eaux » : faut-il le rattacher à « Dégât des eaux » ?');
    // Règle permanente : jamais « Opération » affiché ; et aucune des deux réponses n'est recommandée.
    expect(q).not.toMatch(/op[ée]ration/i);
    expect(q).not.toMatch(/recommand|conseill|probable|sans doute|certainement/i);
  });

  it('L114U-Q2 — un intitulé très long est borné, l’espacement normalisé ; aucun saut de ligne', () => {
    const q = cartes.agendaLinkQuestion(`Passage\n   du couvreur ${'x'.repeat(200)}`, 'A', 'B', 'D');
    expect(q).not.toContain('\n');
    expect(q).toContain('…');
    const [cite] = q.match(/« [^»]+ »/g)!;
    expect(cite.length).toBeLessThanOrEqual(54);
  });

  it('L114U-Q3 — deux propositions seulement : rattacher aussi (jamais mise en avant) et garder l’état actuel', () => {
    const p = cartes.agendaLinkProposals([10, 11, 10]);
    expect(p.map((x) => x.value)).toEqual(['ATTACH', 'KEEP']);
    expect(p[0]).toMatchObject({ label: 'Oui, le rattacher aussi', emphasis: 'neutral', evidenceIds: ['file:10', 'file:11', 'file:10'] });
    expect(p[1]).toMatchObject({ label: 'Non, ne pas le rattacher', isCurrentValue: true });
    // L'état actuel est celui de l'utilisateur : il n'est pas présenté comme une proposition de l'IA.
    expect(p[1].evidenceIds).toBeUndefined();
    for (const x of p) expect(x.label).not.toMatch(/op[ée]ration/i);
    expect(cartes.agendaLinkProposals([])[0].evidenceIds).toEqual([]);
  });

  it('L114U-Q4 — seules les deux réponses de la carte sont acceptées : une valeur forgée ne désigne rien', () => {
    expect(cartes.parseAgendaLinkChoice('ATTACH')).toBe('ATTACH');
    expect(cartes.parseAgendaLinkChoice('KEEP')).toBe('KEEP');
    for (const v of ['attach', 'MERGE', 'ASSOCIATE', '', null, undefined, 1, true, {}, ['ATTACH']]) {
      expect(cartes.parseAgendaLinkChoice(v)).toBeNull();
    }
  });

  it('L114U-Q5 — une carte ouverte par COUPLE (événement de référence, événement d’Agenda)', () => {
    expect(cartes.agendaLinkKey(3, 9)).toBe('operationAgendaLink:3:9');
    // L'ordre n'est pas interchangeable : ce ne sont pas deux objets de même nature.
    expect(cartes.agendaLinkKey(9, 3)).not.toBe(cartes.agendaLinkKey(3, 9));
  });
});

describe('L114U-C — contexte de la carte : relu strictement', () => {
  it('L114U-C1 — un contexte complet est reconnu', () => {
    expect(cartes.isOperationAgendaLinkContext(ctx())).toBe(true);
  });

  it('L114U-C2 — tout contexte incomplet, réflexif, d’une autre famille ou SANS pièce est refusé', () => {
    const refuses: unknown[] = [
      null, undefined, 'operation_agenda_link', 42, [],
      ctx({ kind: 'operation_relation' as never }),
      ctx({ operationId: 0 }), ctx({ agendaItemId: 0 }), ctx({ currentOperationId: 0 }),
      // Le même événement de référence des deux côtés n'est pas un rattachement supplémentaire.
      ctx({ operationId: 8, currentOperationId: 8 }),
      ctx({ itemTitle: 12 as never }), ctx({ operationTitle: null as never }),
      ctx({ evidence: 'DOCUMENT|10' as never }), ctx({ evidenceKeys: null as never }),
      // Décision du PO : jamais de carte sans pièce — un contexte sans justificatif n'est pas résoluble.
      ctx({ evidenceKeys: [] }),
    ];
    for (const c of refuses) expect(cartes.isOperationAgendaLinkContext(c), JSON.stringify(c)).toBe(false);
  });
});

describe('L114U-M — mémoire des justificatifs : jamais la même question deux fois', () => {
  it('L114U-M1 — les sources sont dédoublonnées et triées (l’extrait cité ne change pas la pièce)', () => {
    expect(cartes.agendaLinkSourceKeys([
      { kind: 'DOCUMENT', ref: '11' }, { kind: 'DOCUMENT', ref: '10', locator: 'page 2' },
      { kind: 'DOCUMENT', ref: '10', locator: 'page 7' },
    ])).toEqual(['DOCUMENT|10', 'DOCUMENT|11']);
    expect(cartes.agendaLinkSourceKeys([])).toEqual([]);
  });

  it('L114U-M2 — toutes les pièces déjà présentées : rien n’est redemandé (AC14, « simple nouveau passage, non »)', () => {
    const repondues = new Set(['DOCUMENT|10', 'DOCUMENT|11']);
    expect(cartes.agendaLinkAlreadyAnswered(['DOCUMENT|10'], repondues)).toBe(true);
    expect(cartes.agendaLinkAlreadyAnswered(['DOCUMENT|10', 'DOCUMENT|11'], repondues)).toBe(true);
    // Aucune pièce : il n'y a rien à proposer (décision du PO du 16/11/2026).
    expect(cartes.agendaLinkAlreadyAnswered([], repondues)).toBe(true);
    expect(cartes.agendaLinkAlreadyAnswered([], new Set())).toBe(true);
  });

  it('L114U-M3 — un seul justificatif jamais présenté rouvre la question', () => {
    expect(cartes.agendaLinkAlreadyAnswered(['DOCUMENT|10', 'DOCUMENT|99'], new Set(['DOCUMENT|10']))).toBe(false);
    expect(cartes.agendaLinkAlreadyAnswered(['DOCUMENT|10'], new Set())).toBe(false);
  });
});

describe('L114U-P — la PREUVE exigée par le PO, lisible dans le code', () => {
  const carte = lire('src/services/to-process/operation-agenda-link-cards.ts');

  it('L114U-P1 — seules les provenances PROPRES du lien document ↔ événement valent preuve', () => {
    // La provenance OPERATION_PRINCIPAL est DÉRIVÉE du rattachement : s'en servir serait circulaire.
    expect(cartes.SHARED_EVIDENCE_PROVENANCES).toEqual(['MANUAL_DIRECT', 'AI_DIRECT']);
    expect([...cartes.SHARED_EVIDENCE_PROVENANCES]).not.toContain('OPERATION_PRINCIPAL');
  });

  it('L114U-P2 — la preuve est UN document, rattaché à l’événement de référence ET lié à l’événement d’Agenda', () => {
    const requete = carte.slice(carte.indexOf('export async function sharedJustifications'), carte.indexOf('// ── Proposition'));
    expect(requete).toContain('business_operation_documents');
    expect(requete).toContain('agenda_file_links');
    expect(requete).toContain('bd.active');
    expect(requete).toContain('f.deleted_at IS NULL');
    expect(requete).toContain('afl.provenances && $4::text[]');
    // Isolation : le compte filtre le document, l'événement de référence ET l'événement d'Agenda.
    expect(requete).toContain('bd.account_id = $1');
    expect(requete).toContain('f.account_id = bd.account_id');
    expect(requete).toContain('i.account_id = bd.account_id');
  });

  it('L114U-P3 — aucune heuristique : ni bien, ni date proche, ni fournisseur, ni montant, ni score', () => {
    expect(code(carte)).not.toMatch(/score|similarit|proximit|jours?\s*d.[ée]cart|same_asset|asset_id|provider|amount/i);
    // Sans pièce : un rendu explicite, jamais un faux succès.
    expect(carte).toContain("return { status: 'NO_SHARED_EVIDENCE', reason: 'NO_SHARED_DOCUMENT' };");
  });

  it('L114U-P4 — la file n’écrit JAMAIS le lien : « oui » passe par la façade, « non » n’écrit rien', () => {
    expect(carte).toContain('facade.linkAgendaItem(');
    expect(carte).toContain("channel: 'TO_PROCESS'");
    expect(carte).not.toMatch(/INSERT INTO business_operation_agenda_links|UPDATE business_operation_agenda_links|UPDATE agenda_items/i);
    // Aucun objet n'est créé pour porter la carte : elle se porte sur l'événement d'Agenda lui-même.
    expect(carte).not.toMatch(/INSERT INTO asset_files|INSERT INTO agenda_items/i);
    expect(carte).toContain("targetType: 'AGENDA_ITEM', targetId: req.agendaItemId");
    // Jamais le rôle « principal » posé ni lu, jamais la colonne historique.
    expect(code(carte)).not.toMatch(/operation_role|'PRINCIPAL'|business_operation_id/);
  });

  it('L114U-P5 — un refus de l’utilisateur n’est jamais contourné par une inférence', () => {
    expect(carte).toContain("decision = 'REJECTED' AND active");
    expect(carte).toContain("return { status: 'NOT_APPLICABLE', reason: 'USER_REJECTED' };");
  });
});

describe('L114U-D — déclarations : catalogue, producteur, publiabilité, mascotte, passerelle', () => {
  const regle = PROCESSING_RULES.find((r) => r.code === 'AGENDA-LINK')!;

  it('L114U-D1 — la règle est au catalogue, sur l’événement d’Agenda, sans décision de l’IA', () => {
    expect(regle).toMatchObject({
      targetType: 'AGENDA_ITEM', relationKey: 'operationAgendaLink', completePriority: null, allowNotApplicable: false,
      producer: 'REFERENCE_EVENT_AGENDA_LINK', arbitratePriority: 'DO_NEXT',
    });
    // L'utilisateur tranche : aucune formulation « l'IA propose », aucune réponse automatique possible.
    expect(regle.formulation.kind).toBe('DETERMINISTIC');
    expect(regle.question).not.toMatch(/op[ée]ration/i);
  });

  it('L114U-D2 — le producteur désigne un module réel et ses deux points d’entrée existent', () => {
    const p = RULE_PRODUCERS.REFERENCE_EVENT_AGENDA_LINK;
    expect(p.module).toBe('src/services/to-process/operation-agenda-link-cards.ts');
    const source = lire(p.module);
    for (const e of p.entries) expect(source).toContain(`export async function ${e}`);
    expect(cartes.requestAgendaLinkProposal).toBeTypeOf('function');
    expect(cartes.resolveOperationAgendaLinkCard).toBeTypeOf('function');
  });

  it('L114U-D3 — publiabilité : famille « événements de référence », prémisse contrôlée dès la création, fermeture déclarée', () => {
    const c = PUBLISHABILITY_CONTRACTS['AGENDA-LINK'];
    expect(c).toMatchObject({ family: 'EVENEMENTS_DE_REFERENCE', decisions: 'PRODUCTION', atCreation: true });
    expect(c.cleanup).toEqual({ by: PUBLISHABILITY_CHECK_ID, service: 'closeCardsNoLongerUseful' });
    // La carte ne vaut plus dès que l'événement de référence visé est retiré, ou que le rattachement existe déjà.
    const sql = c.noLongerUseful!('a');
    expect(sql).toContain("a.trigger_context->>'operationId'");
    expect(sql).toContain('business_operation_agenda_links');
    expect(sql).toContain("l.state = 'ACTIVE'");
    // Isolation : toute lecture de la prémisse est filtrée par le compte de la carte.
    expect(sql).toContain('l.account_id = a.account_id');
    expect(sql).toContain('o.account_id = a.account_id');
  });

  it('L114U-D4 — mascotte : un sujet dit en français, sans le mot interdit', () => {
    const titre = todoTitle('AGENDA-LINK', 'ARBITRATE');
    expect(titre).toBe('Rattachement à confirmer');
    expect(titre).not.toMatch(/op[ée]ration/i);
  });

  it('L114U-D5 — passerelle : l’inférence PROPOSE, l’utilisateur écrit (aucune écriture, aucune règle dans la passerelle)', () => {
    const pont = lire('src/services/business-operations/graph/agenda-link-proposal.ts');
    expect(pont).toContain('requestAgendaLinkProposal');
    // Le geste de l'utilisateur ne passe pas par ce détour : il écrit par la façade.
    expect(pont).toContain("if (ctx.actor.kind === 'USER') return { status: 'USER_ONLY' };");
    // Ni SQL, ni écriture, ni appel IA, ni règle de preuve dupliquée dans la passerelle.
    expect(code(pont)).not.toMatch(/INSERT|UPDATE |pgClient|callAi|openai|gemini/i);
    expect(code(pont)).not.toMatch(/linkAgendaItem|agenda_file_links|provenances/);
  });

  it('L114U-D6 — la file de « À traiter » sait résoudre la règle (aucune carte sans résolution câblée)', () => {
    const file = lire('src/services/to-process/resolve-action.service.ts');
    expect(file).toContain("if (action.ruleCode === 'AGENDA-LINK') {");
    expect(file).toContain('resolveOperationAgendaLinkCard');
  });
});
