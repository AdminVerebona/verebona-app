/**
 * Carte Trello #744 — LE PASSAGE QUI POSE LES TROIS QUESTIONS du CDC §8, et
 * l'ABSTENTION TRACÉE quand l'IA n'a pas tranché (CDC §6, §7, §8, §16, §20 ;
 * AC04, AC09 à AC12, AC16, AC17, AC20). Règles PURES et GARDES DE CODE (aucune
 * base, aucun appel IA, aucune dépendance à la date du jour).
 *
 *   A  abstention : quel motif pour quelle trace M3, et une seule fois par situation ;
 *   D  détecteurs : la règle de preuve du PO, le constat de contradiction, le verdict M3 déjà rendu ;
 *   B  branchement : sixième famille du balayage, bornée au compte, sans écriture ;
 *   J  journal : l'abstention est une ligne de plus, pas un vocabulaire de plus.
 * Le parcours sur PostgreSQL réel est couvert par
 * `src/test/e2e/scenarios/l114u-balayage-evenements-reference.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const balayage = await import('../reference-event-sweep');
const { FACT_COLUMNS, FACT_FIELDS } = await import('../operation-merge-cards');

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n?/g, '\n');
/** Le CODE seul : les commentaires expliquent les règles écartées, ils ne doivent pas déclencher les contrôles. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SWEEP = 'src/services/to-process/reference-event-sweep.ts';
const sweep = lire(SWEEP);
const cartesRattachement = lire('src/services/to-process/operation-agenda-link-cards.ts');
const cartesFusion = lire('src/services/to-process/operation-merge-cards.ts');
const magasin = lire('src/services/business-operations/graph/store.ts');
const producteurs = lire('src/services/to-process/producers.service.ts');

const m3 = (over: Record<string, unknown> = {}) => ({ status: 'DONE', fingerprint: 'abc', ...over }) as never;

describe('L114U-B-A — abstention (AC20) : l’IA n’a pas tranché, rien n’est inventé', () => {
  it('L114U-B-A1 — indisponible, en échec, contexte tronqué : un motif par statut de la trace M3', () => {
    expect(balayage.abstentionReasonOf(m3({ status: 'PROMPT_UNAVAILABLE' }), false)).toBe('ABSTAIN_AI_PROMPT_UNAVAILABLE');
    expect(balayage.abstentionReasonOf(m3({ status: 'ERROR' }), false)).toBe('ABSTAIN_AI_FAILED');
    expect(balayage.abstentionReasonOf(m3({ status: 'TOO_MANY_CANDIDATES' }), false)).toBe('ABSTAIN_AI_CONTEXT_TRUNCATED');
    // Tous les motifs se reconnaissent à leur préfixe (lecture du journal au BO).
    for (const v of [...Object.values(balayage.ABSTENTION_REASONS), balayage.ABSTENTION_DECLINED, balayage.ABSTENTION_UNAVAILABLE]) {
      expect(v).toMatch(/^ABSTAIN_/);
    }
  });

  it('L114U-B-A2 — report : indisponibilité réelle seulement (plafond de coût, traitement arrêté)', () => {
    expect(balayage.abstentionReasonOf(m3({ status: 'DEFERRED', detail: 'COST_CAP_REACHED' }), false)).toBe('ABSTAIN_AI_UNAVAILABLE');
    expect(balayage.abstentionReasonOf(m3({ status: 'DEFERRED', detail: 'AI_BLOCKED' }), false)).toBe('ABSTAIN_AI_UNAVAILABLE');
    // Un simple plafond d'appels n'est pas une abstention : aucune décision n'était encore attendue.
    expect(balayage.abstentionReasonOf(m3({ status: 'DEFERRED', detail: 'PASS_CAP' }), false)).toBeNull();
    expect(balayage.abstentionReasonOf(m3({ status: 'DEFERRED', detail: 'DAILY_CAP' }), false)).toBeNull();
    expect(balayage.abstentionReasonOf(m3({ status: 'DEFERRED' }), false)).toBeNull();
  });

  it('L114U-B-A3 — verdict rendu : abstention SEULEMENT si l’IA refuse de trancher', () => {
    expect(balayage.abstentionReasonOf(m3(), false)).toBeNull();
    expect(balayage.abstentionReasonOf(m3(), true)).toBe('ABSTAIN_AI_DECLINED');
    expect(balayage.abstentionReasonOf(null, true)).toBeNull();
    // Un statut inconnu (trace d'une version antérieure) ne produit rien : jamais de motif inventé.
    expect(balayage.abstentionReasonOf(m3({ status: 'AUTRE_CHOSE' }), false)).toBeNull();
  });

  it('L114U-B-A4 — une abstention par situation : empreinte stable, bornée, qui change avec le contexte', () => {
    const a = balayage.abstentionSituation(m3({ status: 'ERROR', detail: 'TIMEOUT' }), 'ABSTAIN_AI_FAILED');
    expect(a).toBe(balayage.abstentionSituation(m3({ status: 'ERROR', detail: 'TIMEOUT' }), 'ABSTAIN_AI_FAILED'));
    expect(a).not.toBe(balayage.abstentionSituation(m3({ status: 'ERROR', detail: 'TIMEOUT', fingerprint: 'autre' }), 'ABSTAIN_AI_FAILED'));
    expect(a).not.toBe(balayage.abstentionSituation(m3({ status: 'ERROR', detail: 'TIMEOUT' }), 'ABSTAIN_AI_DECLINED'));
    expect(balayage.abstentionSituation(m3({ status: 'ERROR', fingerprint: 'f'.repeat(500), detail: 'd'.repeat(500) }), 'ABSTAIN_AI_FAILED').length)
      .toBeLessThanOrEqual(180);
  });
});

describe('L114U-B-D — détecteurs : les règles qui existent déjà, jamais une de plus', () => {
  it('L114U-B-D1 — rattachement : la détection EST la règle de preuve du PO (justificatif commun)', () => {
    const requete = cartesRattachement.slice(cartesRattachement.indexOf('export async function agendaLinkCandidates'),
      cartesRattachement.indexOf('// ── Proposition'));
    expect(requete).toContain('business_operation_documents');
    expect(requete).toContain('afl.provenances && $2::text[]');
    expect(requete).toContain('bd.active');
    expect(requete).toContain('f.deleted_at IS NULL');
    // Rattachement SUPPLÉMENTAIRE : déjà rattaché à un AUTRE événement de référence actif, pas encore à celui-ci.
    expect(requete).toContain("l.state = 'ACTIVE' AND l.operation_id <> bd.operation_id");
    expect(requete).toContain('NOT EXISTS');
    // Isolation : le compte filtre le document, les deux événements de référence ET l'événement d'Agenda.
    for (const f of ['bd.account_id = $1', 'f.account_id = bd.account_id', 'i.account_id = bd.account_id',
      'o.account_id = bd.account_id', 'c.account_id = bd.account_id']) expect(requete).toContain(f);
    // Bornée : un nombre de couples par passage, dans un ordre stable (aucune famine, aucune limite silencieuse).
    expect(requete).toContain('ORDER BY bd.operation_id, i.id');
    expect(requete).toContain('LIMIT $3');
  });

  it('L114U-B-D2 — rattachement : aucune heuristique dans le détecteur non plus (ni bien, ni date, ni fournisseur, ni montant, ni score)', () => {
    expect(code(cartesRattachement)).not.toMatch(/score|similarit|proximit|jours?\s*d.[ée]cart|same_asset|asset_id|provider|amount/i);
    expect(code(sweep)).not.toMatch(/score|similarit|proximit|jours?\s*d.[ée]cart|same_asset|asset_id|provider|amount/i);
  });

  it('L114U-B-D3 — fait contradictoire : un CONSTAT entre deux événements ASSOCIÉS, sur le référentiel des faits', () => {
    const requete = cartesFusion.slice(cartesFusion.indexOf('export async function factContradictionCandidates'),
      cartesFusion.indexOf('export interface MergeCardOutcome'));
    // Les colonnes viennent du référentiel (aucune énumération locale) ; une valeur absente n'est pas une contradiction.
    expect(requete).toContain('FACT_FIELDS.map(diff)');
    expect(requete).toContain('IS NOT NULL AND y.');
    expect(requete).toContain("r.state = 'ACTIVE'");
    expect(requete).toContain('r.account_id = $1');
    expect(requete).toContain('x.account_id = r.account_id');
    expect(requete).toContain('y.account_id = r.account_id');
    expect(requete).toContain('invalidated_at IS NULL');
    expect(requete).toContain('LIMIT $2');
    // Le référentiel des faits reste celui de la carte d'arbitrage d'attribut (#750), avec sa colonne.
    expect(FACT_FIELDS).toEqual(['plannedDate', 'startDate', 'realizedDate', 'endDate']);
    expect(Object.keys(FACT_COLUMNS).sort()).toEqual([...FACT_FIELDS].sort());
  });

  it('L114U-B-D4 — doublon : le verdict M3 DÉJÀ rendu par T3, lu avec la règle existante (aucun appel d’IA ajouté)', () => {
    expect(sweep).toContain("c.t3_detail->'m3'");
    expect(sweep).toContain("c.status = 'ACTIVE'");
    expect(sweep).toContain('c.account_id = $1');
    expect(sweep).toContain('m3Resolution');
    // La décision reste celle de T3 : aucun seuil, aucun verdict recalculé ici.
    expect(code(sweep)).not.toMatch(/callOperationMatchModel|runOperationMatchPhase|callModel|SAME_OPERATION|confidence/);
    expect(sweep).toContain('LIMIT $2');
  });
});

describe('L114U-B-B — branchement : sixième famille du balayage, qui n’écrit rien', () => {
  it('L114U-B-B1 — le balayage horaire appelle le passage, et le compte des familles le dit', () => {
    expect(producteurs).toContain("import('./reference-event-sweep')");
    expect(producteurs).toContain('produceReferenceEventActions');
    expect(producteurs).toContain('const FAMILIES = 6;');
    // Une famille en échec n'emporte pas les autres (même filet que les cinq existantes).
    expect(producteurs).toContain("reportError('événements de référence', accountId, errors, familles)");
  });

  it('L114U-B-B2 — le passage ne décide rien : il appelle les trois passerelles, jamais la façade', () => {
    for (const p of ['proposeExtraAgendaLink', 'proposeReferenceEventMerge', 'proposeReferenceEventFact']) {
      expect(sweep, p).toContain(p);
    }
    expect(code(sweep)).not.toMatch(/linkAgendaItem|associateOperations|mergeOperations|updateOperation|setOperationFact/);
    // La façade n'est connue que par le TYPE de son contexte : aucun appel, aucune commande.
    expect(sweep).toContain("import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade'");
    expect(code(sweep)).not.toMatch(/import\(['"]@\/services\/business-operations\/operation-write\.facade/);
  });

  it('L114U-B-B3 — le passage n’écrit AUCUNE donnée métier : aucun ordre d’écriture hors le journal d’abstention', () => {
    expect(code(sweep)).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/);
    // Aucun objet créé pour porter une carte (AC16), aucun rappel, aucun rôle, aucune colonne historique.
    expect(code(sweep)).not.toMatch(/agenda_items|asset_files .*VALUES|notification|operation_role|'PRINCIPAL'|business_operation_id/);
  });

  it('L114U-B-B4 — acteur : une REPRISE déterministe (ni l’utilisateur, ni un appel d’IA)', () => {
    expect(sweep).toContain("actor: { kind: 'SYSTEM', reason: 'TO_PROCESS_SCAN' }");
    expect(code(sweep)).not.toMatch(/kind: 'USER'/);
  });

  it('L114U-B-B5 — carte PÉRIMÉE : fermée « sans objet » par le service unique de fermeture (aucune prémisse dupliquée)', () => {
    expect(sweep).toContain('closeCardsNoLongerUseful');
    expect(balayage.SWEEP_RULES).toEqual(['AGENDA-LINK', 'REFERENCE-EVENT-MERGE', 'REFERENCE-EVENT-FACT']);
    expect(sweep).toContain('resolved_at IS NULL AND rule_code = ANY($2::text[])');
    expect(sweep).toContain('account_id = $1');
  });

  it('L114U-B-B6 — bornes de passage : un nombre de situations par compte, jamais tout le compte', () => {
    for (const n of [balayage.MERGE_CANDIDATES_PER_PASS]) {
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(50);
    }
  });

  it('L114U-B-B7 — aucun texte nouveau à l’écran : le passage ne formule rien (et jamais le mot interdit)', () => {
    expect(code(sweep)).not.toMatch(/op[ée]ration\s/i);
    expect(code(sweep)).not.toMatch(/question:|label:/);
  });
});

describe('L114U-B-J — journal : une ligne de plus, pas un vocabulaire de plus', () => {
  it('L114U-B-J1 — l’abstention s’écrit avec l’action existante NO_CHANGE (aucune valeur ajoutée aux migrations 1715-1717)', async () => {
    const { GRAPH_HISTORY_ACTIONS } = await import('@/services/business-operations/graph/model');
    expect(GRAPH_HISTORY_ACTIONS).toContain('NO_CHANGE');
    expect(GRAPH_HISTORY_ACTIONS).not.toContain('ABSTAINED');
    const bloc = magasin.slice(magasin.indexOf('export async function recordAiAbstention'), magasin.indexOf('* Résultat déjà rendu'));
    expect(bloc).toContain("action: 'NO_CHANGE'");
    expect(bloc).toContain("origin: a.origin ?? 'AI'");
    // Jamais une commande, jamais une clé d'idempotence, jamais un résultat : une abstention n'est pas une écriture.
    expect(bloc).not.toMatch(/command:|idempotencyKey:|result:/);
  });

  it('L114U-B-J2 — une seule ligne par situation (rejeu du balayage), bornée au compte', () => {
    const bloc = magasin.slice(magasin.indexOf('export async function recordAiAbstention'), magasin.indexOf('* Résultat déjà rendu'));
    expect(bloc).toContain('WHERE account_id = $1 AND operation_id = $2 AND reason_code = $3 AND input_hash = $4');
    expect(bloc).toContain('if (deja) return false;');
  });

  it('L114U-B-J3 — seul le magasin du graphe écrit le journal : le passage lui demande', () => {
    expect(sweep).toContain("import('@/services/business-operations/graph/store')");
    expect(sweep).toContain('recordAiAbstention');
    expect(code(sweep)).not.toContain('business_operation_graph_history');
  });
});
