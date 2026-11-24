/**
 * Carte 831 — écart E04 : « dates du même fait ». La première écriture était
 * validée, puis le report vers l'autre affichage pouvait échouer SANS TRACE
 * ET SANS REPRISE (`console.error`, ligne `outcome: 'FAILED'` que personne ne
 * lisait) : les deux dates restaient durablement divergentes.
 *
 * Ce que ces tests tiennent :
 *   C831-U-01  la règle de reprise est PURE et ne tranche jamais à la place de
 *              l'utilisateur ;
 *   C831-U-02  le report est rejoué seulement quand l'autre affichage montre
 *              ENCORE la valeur d'avant (même garde que le report initial) ;
 *   C831-U-03  deux côtés qui ont bougé, ou aucune preuve journalisée :
 *              aucune écriture ;
 *   C831-U-04  branchements : l'échec est tracé durablement, chaque route est
 *              indépendante, et la reprise passe par le contrôle de cohérence
 *              déclaré (jamais par une écriture propre au contrôle).
 *
 * Les règles de report elles-mêmes (quelle date suit quel fait, divergence,
 * absence de boucle) restent couvertes par `l116c-dates-meme-fait.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideFactDateRepair, FACT_DATE_SYNC_FAILED_REASON } from '../fact-date-sync';
import { operationsFactDateSyncCheck } from '@/services/coherence/registry/checks/operations-fact-date-sync';
import { COHERENCE_REGISTRY, activeChecks } from '@/services/coherence/registry';
import { COVERAGE_INVENTORY } from '@/services/coherence/registry/coverage';

const ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const lire = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** Changement journalisé d'un côté : valeur d'avant, valeur d'après, horodatage. */
const ch = (before: string | null, after: string | null, at: string) => ({ before, after, at });

describe('C831-U-01 — la reprise ne tranche jamais à la place de l’utilisateur', () => {
  it('deux affichages égaux : rien à faire, quelle que soit l’histoire', () => {
    expect(decideFactDateRepair({
      agendaDate: '2026-03-12', operationDate: '2026-03-12',
      operationChange: ch('2026-03-01', '2026-03-12', '2026-03-05T10:00:00Z'), agendaChange: null,
    })).toEqual({ kind: 'CONSISTENT' });
    expect(decideFactDateRepair({ agendaDate: null, operationDate: null, operationChange: null, agendaChange: null })).toEqual({ kind: 'CONSISTENT' });
  });

  it('un changement journalisé qui ne correspond plus à ce que le côté montre n’est pas la source', () => {
    // L'opération montre 2026-04-02, mais le dernier changement journalisé dit 2026-03-12 : il a été dépassé.
    expect(decideFactDateRepair({
      agendaDate: '2026-03-01', operationDate: '2026-04-02',
      operationChange: ch('2026-03-01', '2026-03-12', '2026-03-05T10:00:00Z'), agendaChange: null,
    })).toEqual({ kind: 'UNKNOWN' });
  });
});

describe('C831-U-02 — report rejoué seulement si l’autre affichage montre encore la valeur d’avant', () => {
  it('opération corrigée, événement resté sur la valeur d’avant : report rejoué vers l’Agenda', () => {
    expect(decideFactDateRepair({
      agendaDate: '2026-03-01', operationDate: '2026-03-12',
      operationChange: ch('2026-03-01', '2026-03-12', '2026-03-05T10:00:00Z'), agendaChange: null,
    })).toEqual({ kind: 'REPLAY', direction: 'OPERATION_TO_AGENDA', before: '2026-03-01', after: '2026-03-12' });
  });

  it('événement corrigé, opération restée sur la valeur d’avant : report rejoué vers l’opération', () => {
    expect(decideFactDateRepair({
      agendaDate: '2026-03-12', operationDate: '2026-03-01',
      operationChange: null, agendaChange: ch('2026-03-01', '2026-03-12', '2026-03-05T10:00:00Z'),
    })).toEqual({ kind: 'REPLAY', direction: 'AGENDA_TO_OPERATION', before: '2026-03-01', after: '2026-03-12' });
  });

  it('les deux côtés ont un changement : le plus récent est la source', () => {
    const r = decideFactDateRepair({
      agendaDate: '2026-03-01', operationDate: '2026-03-12',
      operationChange: ch('2026-03-01', '2026-03-12', '2026-03-06T09:00:00Z'),
      agendaChange: ch('2026-02-01', '2026-03-01', '2026-03-05T09:00:00Z'),
    });
    expect(r).toEqual({ kind: 'REPLAY', direction: 'OPERATION_TO_AGENDA', before: '2026-03-01', after: '2026-03-12' });
  });

  it('opération sans date : elle peut être complétée depuis l’événement', () => {
    expect(decideFactDateRepair({
      agendaDate: '2026-03-12', operationDate: null,
      operationChange: null, agendaChange: ch(null, '2026-03-12', '2026-03-05T10:00:00Z'),
    })).toEqual({ kind: 'REPLAY', direction: 'AGENDA_TO_OPERATION', before: null, after: '2026-03-12' });
  });

  it('événement « Sans échéance » : il ne reçoit JAMAIS une date d’office', () => {
    expect(decideFactDateRepair({
      agendaDate: null, operationDate: '2026-03-12',
      operationChange: ch('2026-03-01', '2026-03-12', '2026-03-05T10:00:00Z'), agendaChange: null,
    })).toEqual({ kind: 'DIVERGENT' });
  });

  it('une date incomplète ou irréelle n’est jamais reportée', () => {
    expect(decideFactDateRepair({
      agendaDate: '2026-03-01', operationDate: '2026-02',
      operationChange: ch('2026-03-01', '2026-02', '2026-03-05T10:00:00Z'), agendaChange: null,
    })).toEqual({ kind: 'UNKNOWN' });
    expect(decideFactDateRepair({
      agendaDate: '2026-03-01', operationDate: '2026-02-30',
      operationChange: ch('2026-03-01', '2026-02-30', '2026-03-05T10:00:00Z'), agendaChange: null,
    })).toEqual({ kind: 'UNKNOWN' });
  });
});

describe('C831-U-03 — aucune écriture quand la preuve manque ou que les deux côtés ont bougé', () => {
  it('les deux côtés ont été corrigés séparément : divergence, rien n’est écrasé', () => {
    expect(decideFactDateRepair({
      agendaDate: '2026-05-04', operationDate: '2026-03-12',
      operationChange: ch('2026-03-01', '2026-03-12', '2026-03-06T09:00:00Z'),
      agendaChange: ch('2026-04-01', '2026-05-04', '2026-03-07T09:00:00Z'),
    })).toEqual({ kind: 'DIVERGENT' });
  });

  it('aucun changement journalisé exploitable : constat, jamais un choix', () => {
    expect(decideFactDateRepair({ agendaDate: '2026-03-01', operationDate: '2026-03-12', operationChange: null, agendaChange: null }))
      .toEqual({ kind: 'UNKNOWN' });
  });
});

describe('C831-U-04 — branchements : échec tracé durablement, routes indépendantes, reprise déclarée', () => {
  const src = lire('src/services/business-operations/graph/fact-date-sync.ts');

  it('l’échec d’un report est écrit durablement, et plus seulement affiché', () => {
    expect(src).toContain('FACT_DATE_SYNC_FAILED');
    expect(FACT_DATE_SYNC_FAILED_REASON).toBe('FACT_DATE_SYNC_FAILED');
    // Trace posée dans les deux sens, et sur une connexion propre (la transaction du report est annulée).
    expect(src.match(/await traceReportImpossible\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/action: 'NO_CHANGE'/);
    // La trace ne doit jamais faire échouer l'écriture déjà enregistrée.
    expect(src).toMatch(/async function traceReportImpossible[\s\S]*?\} catch \{/);
  });

  it('une route en échec n’emporte plus les suivantes', () => {
    const corps = src.slice(src.indexOf('export async function syncOperationDatesToAgenda'));
    expect(corps).toMatch(/for \(const x of porteurs\) \{[\s\S]*?try \{/);
    expect(corps).toMatch(/outcome: 'FAILED'/);
  });

  it('aucune donnée client ni secret dans la trace : motif borné', () => {
    expect(src).toMatch(/const motifBorne = /);
    expect(src).toMatch(/\.slice\(0, 160\)/);
  });

  it('le contrôle de reprise est déclaré, actif, inventorié, et ne répare que par les services de report', () => {
    expect(operationsFactDateSyncCheck.id).toBe('COH-OPS-FACT-DATE-SYNC');
    expect(operationsFactDateSyncCheck.status).toBe('ACTIVE');
    expect(operationsFactDateSyncCheck.anomalies).toEqual(['FACT_DATE_SYNC_PENDING', 'FACT_DATE_DIVERGENT', 'FACT_DATE_SYNC_UNEXPLAINED']);
    expect(operationsFactDateSyncCheck.services).toEqual([
      'business-operations/graph/fact-date-sync#syncOperationDatesToAgenda',
      'business-operations/graph/fact-date-sync#syncAgendaDateToOperations',
    ]);
    for (const interdit of ['inventer une date', 'effacer une date']) {
      expect(operationsFactDateSyncCheck.forbiddenRepairs.some((f) => f.includes(interdit)), interdit).toBe(true);
    }
    // Exécuté par l'orchestrateur (énumération + inspection) et inventorié dans la couverture.
    expect(COHERENCE_REGISTRY.map((c) => c.id)).toContain('COH-OPS-FACT-DATE-SYNC');
    expect(activeChecks().map((c) => c.id)).toContain('COH-OPS-FACT-DATE-SYNC');
    expect(COVERAGE_INVENTORY.filter((e) => e.checks.includes('COH-OPS-FACT-DATE-SYNC')).map((e) => e.domain)).toEqual(['operations', 'agenda']);
  });

  it('le contrôle n’écrit ni date ni événement lui-même', () => {
    const controle = lire('src/services/coherence/registry/checks/operations-fact-date-sync.ts');
    expect(controle).not.toMatch(/UPDATE |INSERT INTO |DELETE FROM /);
    expect(controle).not.toMatch(/writeAgendaItem|updateAttributes|gateway|prompt/i);
  });
});
