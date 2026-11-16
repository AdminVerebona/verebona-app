/**
 * Carte #744 (CDC Opérations / Agenda V2.0 §5, §7, §19, AC13, AC47) — mémoire
 * du refus « événement de référence créé à tort » face à T3 : règle PURE.
 * Le chemin complet (T1 persisté → T3 → base) est prouvé par le scénario
 * `l114o-traitements-a-traiter.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { USER_INVALIDATION_REASON } from '../../model';
import { creationRefusedByUserInvalidation, USER_INVALIDATED_SOURCE_REASON, userInvalidatedSourceSql } from '../user-invalidation';

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('L114O-T3 — un événement de référence supprimé par l’utilisateur n’est pas recréé par T3', () => {
  it('U-01 — sans refus mémorisé, la création reste permise', () => {
    expect(creationRefusedByUserInvalidation([], 'op1', ['op1'])).toBe(false);
  });

  it('U-02 — même clé de candidat : création refusée ; autre candidat du même document : permise', () => {
    expect(creationRefusedByUserInvalidation(['op1'], 'op1', ['op1', 'op2'])).toBe(true);
    expect(creationRefusedByUserInvalidation(['op1'], 'op2', ['op1', 'op2'])).toBe(false);
  });

  it('U-03 — clé refusée disparue après une réanalyse : aucun candidat du document ne crée (un renommage ne contourne pas le refus)', () => {
    expect(creationRefusedByUserInvalidation(['op1'], 'c1', ['c1', 'c2'])).toBe(true);
    expect(creationRefusedByUserInvalidation(['op1'], 'c2', ['c1', 'c2'])).toBe(true);
  });

  it('U-04 — condition SQL : motif de la façade, événement non regroupé, source active ou retirée depuis la suppression ; alias contrôlés', () => {
    const q = userInvalidatedSourceSql('s', 'o');
    expect(q).toContain(`o.invalidation_reason = '${USER_INVALIDATION_REASON}'`);
    expect(q).toContain('o.merged_into_operation_id IS NULL');
    expect(q).toContain('s.active OR s.superseded_at >= o.invalidated_at');
    expect(() => userInvalidatedSourceSql('s; DROP', 'o')).toThrow();
  });

  it('U-05 — la garde est posée sur les DEUX créateurs T3 par inférence (document, élément d’Agenda) et le motif est lisible au BO', () => {
    const doc = lire('src/services/business-operations/consolidation/consolidator.ts');
    expect(doc).toContain('creationRefusedByUserInvalidation(');
    expect(doc).toContain('reason: USER_INVALIDATED_SOURCE_REASON');
    // La source d'un événement supprimé par l'utilisateur n'est pas retirée par un simple nouveau passage.
    expect(doc).toContain('if (valid && s.active && s.userInvalidated && !claimed.has(s.id)) continue;');
    const agenda = lire('src/services/business-operations/consolidation/agenda-source-consolidator.ts');
    expect(agenda).toContain("isSourceOfUserInvalidatedOperation(tx, accountId, 'AGENDA', itemId)");
    expect(lire('src/services/business-operations/diagnostics/model.ts')).toContain(`${USER_INVALIDATED_SOURCE_REASON}:`);
  });
});
