/**
 * Lot 116C (carte Trello #806 §4 ; AC46, AC73) — tests unitaires : mémoire
 * durable d'une scission (migration 1830, porte unique des fusions, garde du
 * dépôt) et diagnostic lisible du graphe (`graph/audit-model.ts`, contrôle
 * `COH-OPERATION-GRAPH`). Aucune base, aucune IA.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GRAPH_CONTROL_STATE_LABELS, GRAPH_FAMILY_LABELS, GRAPH_FINDING_DESCRIPTIONS, GRAPH_IMMEDIATE_FINDINGS, OPERATION_GRAPH_CHECK_ID,
  OPERATION_GRAPH_CHECK_VERSION, describeGraphFindings, graphControlState, type GraphControlProof,
} from '../audit-model';
import { AUTOMATIC_MERGE_REFUSED_AFTER_SPLIT, GRAPH_FINDING_OBJECT, type GraphFindingCode } from '../store';
import { splitApartSql } from '../read';
import { COHERENCE_REGISTRY, activeChecks, getCheck } from '@/services/coherence/registry';
import { operationsMergeable, type ExistingOperation } from '../../consolidation/matching';

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

describe('L116C-S-U — mémoire durable d’une scission (AC46)', () => {
  const M1830 = lire('src/db/migrations/1830_l116c_memoire_scission.sql');
  it('migration 1830 : additive, idempotente, rejouable ; reprise depuis le motif ET depuis le journal ; rien de retiré', () => {
    const sql = sansCommentaires(M1830);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS split_apart_at TIMESTAMPTZ/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS split_apart_by_user_id INTEGER/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS business_operation_relations_split_apart_idx/);
    expect(sql).not.toMatch(/\b(DROP|DELETE FROM|TRUNCATE)\b/);
    // Les deux reprises ne touchent QUE les relations sans mémoire (rejouables sans effet) et jamais leur état.
    const reprises = sql.match(/UPDATE business_operation_relations[\s\S]*?;/g) ?? [];
    expect(reprises).toHaveLength(2);
    for (const r of reprises) {
      expect(r).toMatch(/split_apart_at IS NULL/);
      // Seules les deux colonnes de mémoire sont écrites (jamais l'état, la nature, l'origine ni le motif).
      const ecrites = [...r.slice(r.indexOf('SET'), r.search(/\b(FROM|WHERE)\b/)).matchAll(/(\w+)\s*=/g)].map((m) => m[1]);
      expect(ecrites).toEqual(['split_apart_at', 'split_apart_by_user_id']);
    }
    expect(reprises[0]).toMatch(/reason_code = 'USER_SPLIT'/);
    expect(reprises[1]).toMatch(/business_operation_graph_history/);
  });

  it('la mémoire est lue par la colonne durable ET par le motif historique, partout de la même façon', () => {
    expect(splitApartSql('rel')).toBe("(rel.split_apart_at IS NOT NULL OR rel.reason_code = 'USER_SPLIT')");
    const porte = lire('src/services/business-operations/consolidation/consolidator.ts');
    expect(porte).toMatch(/export async function loadNonMergeable\(/);
    expect(porte).toMatch(/rel\.split_apart_at IS NOT NULL OR rel\.reason_code = 'USER_SPLIT'/);
    // Aucune écriture du graphe ne retire la mémoire.
    const store = sansCommentaires(lire('src/services/business-operations/graph/store.ts'));
    expect(store).not.toMatch(/split_apart_at\s*=\s*NULL/);
    expect(store).toMatch(/split_apart_at = COALESCE\(split_apart_at, now\(\)\)/);
    expect(store).toMatch(/split_apart_at = COALESCE\(c\.split_apart_at, a\.split_apart_at\)/);
  });

  it('TOUTES les voies de fusion de T3 passent par la porte unique, et le dépôt garde la dernière', () => {
    const consolidator = sansCommentaires(lire('src/services/business-operations/consolidation/consolidator.ts'));
    const biens = sansCommentaires(lire('src/services/business-operations/consolidation/asset-data-consolidator.ts'));
    // Chaque appel de `decideCandidate` d'un fichier qui fusionne reçoit la porte.
    for (const [nom, src] of [['consolidator', consolidator], ['asset-data-consolidator', biens]] as const) {
      const decisions = src.match(/decideCandidate\(identity, \{[\s\S]*?\}\);/g) ?? [];
      expect(decisions.length, nom).toBeGreaterThan(0);
      for (const d of decisions) expect(d, nom).toMatch(/nonMergeable/);
    }
    // Les seuls appels de la fusion du dépôt : trois voies T3, le service de regroupement (décision de l'utilisateur).
    const appels = (src: string) => (src.match(/repo\.mergeOperations\(/g) ?? []).length;
    expect(appels(consolidator)).toBe(2);
    expect(appels(biens)).toBe(1);
    const repo = sansCommentaires(lire('src/services/business-operations/repository.ts'));
    expect(repo).toMatch(/if \(opts\.userDecision !== true\) \{[\s\S]*?wasSplitApart\(this\.accountId, absorbedId, canonicalId, runner\)[\s\S]*?return false;/);
    expect(AUTOMATIC_MERGE_REFUSED_AFTER_SPLIT).toBe('ABSTAIN_USER_SPLIT_APART');
    // Seule la commande de la façade (utilisateur seulement) déclare la décision explicite.
    const facade = sansCommentaires(lire('src/services/business-operations/operation-write.facade.ts'));
    expect(facade.match(/userDecision: true/g)).toHaveLength(1);
    expect(facade).toMatch(/'mergeOperations', input, async \(g, journal\) => \{\s*if \(ctx\.actor\.kind !== 'USER'\) return stop\(refused\('FORBIDDEN', 'USER_ONLY'\)\);/);
    for (const f of ['consolidation/consolidator.ts', 'consolidation/asset-data-consolidator.ts', 'grouping/merge.ts', 'rebuild/reconstruct.ts']) {
      expect(sansCommentaires(lire(`src/services/business-operations/${f}`)), f).not.toMatch(/\buserDecision\b/);
    }
  });

  it('une paire scindée n’est jamais « fusionnable », même quand tout le reste concorde', () => {
    const op = (id: number): ExistingOperation => ({
      id, typeCode: 'INTERVENTION', status: 'REALIZED', invalidated: false, assetIds: [1], equipmentIds: [], providerKey: 'garage martin', providerKeyRaw: 'garage martin',
      refs: [], label: 'Freins', plannedDate: null, startDate: null, realizedDate: '2026-01-20', endDate: null,
    } as unknown as ExistingOperation);
    expect(operationsMergeable(op(1), op(2))).toBe(true);
    expect(operationsMergeable(op(1), op(2), new Set(['1:2']))).toBe(false);
    expect(operationsMergeable(op(2), op(1), new Set(['1:2']), { semantic: true })).toBe(false);
  });

  it('la scission pose la mémoire et fait avancer la version de l’opération scindée', () => {
    const facade = sansCommentaires(lire('src/services/business-operations/operation-write.facade.ts'));
    expect(facade).toMatch(/await markRelationSplitApart\(g\.runner, g\.accountId, rel\.id, userIdOf\(ctx\.actor\)\);/);
    expect(facade).toMatch(/if \(apres\.version <= avant\.version\) \{\s*await bumpOperationVersion\(g\.runner, g\.accountId, faits\.id\);/);
  });
});

describe('L116C-G-U — diagnostic lisible du graphe (AC73)', () => {
  const CODES = Object.keys(GRAPH_FINDING_DESCRIPTIONS) as GraphFindingCode[];
  it('chaque écart a une famille, un libellé, une gravité, une conduite à tenir sans réparation automatique, et un objet', () => {
    expect(CODES.sort()).toEqual((Object.keys(GRAPH_FINDING_OBJECT) as GraphFindingCode[]).sort());
    for (const c of CODES) {
      const d = GRAPH_FINDING_DESCRIPTIONS[c];
      expect(GRAPH_FAMILY_LABELS[d.family], c).toBeTruthy();
      expect(d.label.length, c).toBeGreaterThan(20);
      expect(d.action, c).toMatch(/Aucune réparation automatique\.$/);
      // Vocabulaire du 17/11 : « opération », jamais l'ancien terme.
      expect(`${d.label} ${d.action}`, c).not.toMatch(/événement de référence|élément de référence/i);
    }
    // Les cinq familles de la carte #806 sont couvertes.
    expect(new Set(CODES.map((c) => GRAPH_FINDING_DESCRIPTIONS[c].family))).toEqual(new Set(['CROSS_ACCOUNT', 'ORPHAN', 'REFUSAL_REACTIVATED', 'PROVENANCE', 'DOUBLE_COUNTING', 'LEGACY_COLUMN']));
    // Intercomptes et décision de l'utilisateur contournée : toujours bloquants, signalés immédiatement.
    for (const c of CODES) {
      const d = GRAPH_FINDING_DESCRIPTIONS[c];
      if (d.family === 'CROSS_ACCOUNT' || d.family === 'REFUSAL_REACTIVATED') expect(d.severity, c).toBe('BLOCKING');
      expect(GRAPH_IMMEDIATE_FINDINGS.includes(c), c).toBe(d.severity === 'BLOCKING');
    }
  });

  it('état d’un compte : fondé sur la preuve — sans preuve, jamais « contrôlé »', () => {
    const preuve = (over: Partial<GraphControlProof> = {}): GraphControlProof =>
      ({ completedAt: '2026-11-17T05:00:00.000Z', result: 'CONSISTENT', rulesVersion: OPERATION_GRAPH_CHECK_VERSION, trigger: 'DAILY', mode: 'CORRECTIVE', error: null, ...over });
    expect(graphControlState(null)).toBe('NEVER_CONTROLLED');
    expect(graphControlState(preuve({ completedAt: null }))).toBe('NEVER_CONTROLLED');
    expect(graphControlState(preuve({ result: null }))).toBe('NEVER_CONTROLLED');
    expect(graphControlState(preuve())).toBe('CONSISTENT');
    expect(graphControlState(preuve({ result: 'FINDING' }))).toBe('FINDINGS');
    expect(graphControlState(preuve({ result: 'ERROR' }))).toBe('CONTROL_FAILED');
    // Preuve d'une version de règles antérieure : à refaire avant de conclure, même si elle disait « cohérent ».
    expect(graphControlState(preuve({ rulesVersion: OPERATION_GRAPH_CHECK_VERSION + 1 }))).toBe('OUTDATED_RULES');
    expect(GRAPH_CONTROL_STATE_LABELS.NEVER_CONTROLLED).toBe('Jamais contrôlé');
    expect(Object.values(GRAPH_CONTROL_STATE_LABELS).filter((l) => /^Contrôlé/.test(l))).toHaveLength(2);
  });

  it('lignes du diagnostic : bloquants d’abord, ordre stable, objet nommé', () => {
    const lignes = describeGraphFindings([
      { code: 'LEGACY_LINK_STALE', count: 2, sample: [4, 5] },
      { code: 'RELATION_CROSS_ACCOUNT', count: 1, sample: [9] },
      { code: 'DOCUMENT_CANDIDATE_ON_TWO_OPERATIONS', count: 1, sample: [77] },
      { code: 'AGENDA_LINK_REFUSAL_REACTIVATED', count: 3, sample: [1, 2, 3] },
    ], GRAPH_FINDING_OBJECT);
    expect(lignes.map((l) => [l.code, l.severity])).toEqual([
      ['AGENDA_LINK_REFUSAL_REACTIVATED', 'BLOCKING'], ['RELATION_CROSS_ACCOUNT', 'BLOCKING'],
      ['DOCUMENT_CANDIDATE_ON_TWO_OPERATIONS', 'WARNING'], ['LEGACY_LINK_STALE', 'WARNING'],
    ]);
    expect(lignes[2]).toMatchObject({ objectLabel: 'justificatif', familyLabel: 'Risque de double comptage', count: 1, sample: [77] });
  });

  it('contrôle du registre : actif, en fin de registre, objet = compte, constat seul (aucune réparation), tous les écarts déclarés', () => {
    const c = getCheck(OPERATION_GRAPH_CHECK_ID)!;
    expect(c).toMatchObject({ status: 'ACTIVE', version: OPERATION_GRAPH_CHECK_VERSION, objectType: 'account', domain: 'operations', criticality: 'HIGH' });
    expect(COHERENCE_REGISTRY.at(-1)!.id).toBe(OPERATION_GRAPH_CHECK_ID);
    expect(activeChecks().map((x) => x.id)).toContain(OPERATION_GRAPH_CHECK_ID);
    expect(c.repair).toBeUndefined();
    expect(c.autoRepairWhen).toMatch(/^jamais/);
    expect([...c.anomalies].sort()).toEqual([...CODES].sort());
    expect(c.immediateSupervision).toEqual(GRAPH_IMMEDIATE_FINDINGS);
    expect(c.services).toEqual(['business-operations/graph/store#auditOperationGraph']);
    // Le contrôle ne contient aucune écriture.
    expect(sansCommentaires(lire('src/services/coherence/registry/checks/operation-graph.ts'))).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    const audit = sansCommentaires(lire('src/services/business-operations/graph/store.ts'));
    const corps = audit.slice(audit.indexOf('export async function auditOperationGraph'));
    expect(corps).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
  });

  it('route du BO : lecture seule, garde administrateur, aucune écriture importée', () => {
    const route = sansCommentaires(lire('src/app/api/admin/operations/graph/route.ts'));
    expect([...route.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1])).toEqual(['GET']);
    expect(route).toMatch(/requireAdmin\(request\)/);
    expect(route).not.toMatch(/business-operations\/(write|repository)|pgClient|@\/db/);
    expect(sansCommentaires(lire('src/services/business-operations/graph/audit-read.ts'))).toMatch(/readOnlyExecutor/);
  });
});
