/**
 * Lot 85B — familles « À traiter » restantes (producteur de la famille en
 * réparation), réévaluation historique (CDC §6.4 : version changée,
 * nouvelle version déployée en cours de campagne), retrait de la campagne
 * automatique 81A (C-Q9), matrice de recette CA-01 à CA-19. Sans base (voir
 * `l85b-coherence-recette.e2e.ts` pour l'exécution réelle).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COHERENCE_REGISTRY, activeChecks, getCheck } from '../registry';
import { COVERAGE_INVENTORY } from '../registry/coverage';
import { BUSINESS_OPERATION_CHANGED, COHERENCE_BUSINESS_EVENTS } from '../events';
import { repairAllowed, type ProofState } from '../engine';
import {
  adoptDeployedRegistry, diffRegistryChecks, realignCheckIndex, CURSOR_END_OF_CHECKS, type CampaignRow,
} from '../orchestrator';
import {
  assetFieldCardVerdict, entityFieldCardVerdict, operationCardAnomaly, sameFieldValue, t3FieldCardRuleCodes, OPERATION_CARD_CLOCK_MARGIN_MS,
} from '../registry/checks/to-process-families';
import { operationMatchPropagation, PROPAGATED_RESOLUTION_RULES } from '../registry/checks/to-process-relevance';

const ROOT = join(__dirname, '../../../..');
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const NOUVEAUX = ['COH-TODO-T3-FIELD-CARDS', 'COH-TODO-OPERATION-CARDS', 'COH-TODO-MIGRATION-REVIEW-CARDS', 'COH-TODO-AGENDA-PROPOSAL-CARDS'];

describe('L85B-U-FAMILIES — familles « À traiter » : une famille = son producteur en réparation', () => {
  it('L85B-U-FAMILIES-01 — ajoutés en fin de registre, actifs, sans réordonner l’existant ; déclencheurs relayés par les bus existants', () => {
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    // Intégration lot 85 : 85E et 85F ajoutent aussi en fin de registre — les familles 85B restent contiguës, dans leur ordre.
    const debut = ids.indexOf(NOUVEAUX[0]);
    expect(ids.slice(debut, debut + NOUVEAUX.length)).toEqual(NOUVEAUX);
    expect(ids.slice(0, 6)).toEqual(['COH-TODO-DOCUMENT-FIELDS', 'COH-DOC-LINKS', 'COH-AGENDA-OCCURRENCES', 'COH-AGENDA-ORPHANS', 'COH-TCO-EXTRACTED-EXPENSES', 'COH-DOC-EXTRACT-CHAIN']);
    const actifs = activeChecks().map((c) => c.id);
    const relayes = new Set([...COHERENCE_BUSINESS_EVENTS, 'SOURCE_ANALYZED', BUSINESS_OPERATION_CHANGED]);
    for (const id of NOUVEAUX) {
      expect(actifs, id).toContain(id);
      const c = getCheck(id)!;
      expect(c.repair, id).toBeTypeOf('function');
      expect(c.objectsForEvent, id).toBeTypeOf('function');
      for (const t of c.triggers) expect(relayes.has(t), `${id} → ${t}`).toBe(true);
      expect(c.forbiddenRepairs.join(' ')).toMatch(/supprimer une carte|fermer une carte directement/);
    }
  });

  it('L85B-U-FAMILIES-02 — aucune écriture SQL directe, aucun appel IA ni relance T1, aucune règle par type de document dans les nouveaux contrôles', () => {
    const code = sansCommentaires(lire('src/services/coherence/registry/checks/to-process-families.ts') + lire('src/services/coherence/registry/checks/to-process-relevance.ts'));
    expect(code).not.toMatch(/\b(UPDATE\s+\w+\s+SET|DELETE\s+FROM|INSERT\s+INTO)\b/i);
    expect(code).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
    expect(code).not.toMatch(/runAiGateway|callModel|requeueDocumentForReread|repairDocumentSourceUnits|resolveProgressiveM3|aiReview:\s*true|allowAi:\s*true/);
    expect(code).not.toMatch(/PROPERTY_TAX|TAXE_FONCIERE|taxe fonci|Impôts et taxes/i);
    const tco = sansCommentaires(lire('src/services/coherence/registry/checks/tco.ts'));
    expect(tco).not.toMatch(/PROPERTY_TAX|TAXE_FONCIERE|taxe fonci|Impôts et taxes/i);
  });

  it('L85B-U-FAMILIES-03 — règles des cartes de champ T3 lues du catalogue (pont de réconciliation + champs d’entité)', async () => {
    const regles = await t3FieldCardRuleCodes();
    expect(regles).toEqual(expect.arrayContaining(['DATA-REGISTRATION', 'DATA-ACQUISITION-PRICE', 'DATA-ACQUISITION-DATE', 'ENTITY-FIELD', 'ENTITY-FIELD-ROOM']));
    expect(regles).not.toContain('DATA-CONTRACT-END');
  });

  it('L85B-U-FAMILIES-04 — carte de champ : verdict = table du producteur (maintien, fermeture, changement de nature, pas de décision)', () => {
    expect(assetFieldCardVerdict('ARBITRATE', [{ kind: 'UPSERT', actionKind: 'ARBITRATE' }, { kind: 'RESOLVE' }])).toBe('JUSTIFIED');
    expect(assetFieldCardVerdict('ARBITRATE', [{ kind: 'RESOLVE' }, null])).toBe('STALE');
    expect(assetFieldCardVerdict('ARBITRATE', [{ kind: 'UPSERT', actionKind: 'COMPLETE' }])).toBe('KIND_CHANGED');
    expect(assetFieldCardVerdict('COMPLETE', [null])).toBe('NO_DECISION');
    // Entité : un conflit sans véritable alternative ne ferme rien (comme syncEntityFieldCards).
    expect(entityFieldCardVerdict([{ action: 'create_conflict', proposals: 2 }, { action: 'keep', proposals: 0 }])).toBe('JUSTIFIED');
    expect(entityFieldCardVerdict([{ action: 'create_conflict', proposals: 0 }, { action: 'keep', proposals: 0 }])).toBe('NO_DECISION');
    expect(entityFieldCardVerdict([{ action: 'apply', proposals: 0 }])).toBe('STALE');
    expect(entityFieldCardVerdict([{ action: 'request_ai_review', proposals: 0 }])).toBe('NO_DECISION');
  });

  it('L85B-U-FAMILIES-05 — question de consolidation : candidat disparu, plus d’arbitrage, réalité proposée disparue, Opération fusionnée / invalidée / recalculée sans reconduction', () => {
    const base = { documentAlive: true, lastSeenAt: new Date('2026-10-01T10:00:00Z') };
    const match = (candidate: { status: string; pending: boolean; outcome: string | null } | null, offeredGone: number[] = []) =>
      operationCardAnomaly({ ...base, rule: 'OPERATION-MATCH', candidate, offeredGone });
    expect(match(null)).toEqual({ anomaly: 'MATCH_CANDIDATE_GONE', verdict: 'REPAIRABLE' });
    expect(match({ status: 'SUPERSEDED', pending: false, outcome: null })).toMatchObject({ anomaly: 'MATCH_CANDIDATE_GONE' });
    expect(match({ status: 'ACTIVE', pending: true, outcome: 'MATCH_AND_ENRICH' })).toBeNull();
    expect(match({ status: 'ACTIVE', pending: false, outcome: 'MATCH_AND_ENRICH' })).toMatchObject({ anomaly: 'CARD_NOT_RECONDUCTED' });
    expect(match({ status: 'ACTIVE', pending: false, outcome: 'ARBITRATION_REQUIRED' })).toBeNull();
    expect(match({ status: 'ACTIVE', pending: false, outcome: 'ARBITRATION_REQUIRED' }, [42])).toMatchObject({ anomaly: 'OFFERED_OPERATION_GONE' });
    expect(operationCardAnomaly({ ...base, documentAlive: false, rule: 'OPERATION-MATCH', candidate: null })).toBe('DELEGATED');
    const op = (o: Partial<{ exists: boolean; merged: boolean; invalidated: boolean; lastReconciledAt: Date | null; documentIsSource: boolean }>, rule = 'OPERATION-AMOUNT') =>
      operationCardAnomaly({ ...base, rule, operation: { exists: true, merged: false, invalidated: false, lastReconciledAt: null, documentIsSource: true, ...o } });
    expect(op({ exists: false })).toEqual({ anomaly: 'OPERATION_MISSING', verdict: 'FINDING' });
    expect(op({ merged: true })).toMatchObject({ anomaly: 'OPERATION_MERGED', verdict: 'REPAIRABLE' });
    expect(op({ invalidated: true })).toMatchObject({ anomaly: 'OPERATION_INVALIDATED' });
    expect(op({ documentIsSource: false })).toMatchObject({ anomaly: 'DOCUMENT_NOT_IN_OPERATION' });
    expect(op({ documentIsSource: false }, 'OPERATION-CLAIM-ASSET')).toBeNull();
    // Recalcul de l'Opération APRÈS la dernière reconduction (au-delà de la marge d'horloge) : fermeture perdue.
    expect(op({ lastReconciledAt: new Date(base.lastSeenAt.getTime() + OPERATION_CARD_CLOCK_MARGIN_MS + 1000) })).toMatchObject({ anomaly: 'CARD_NOT_RECONDUCTED' });
    expect(op({ lastReconciledAt: new Date(base.lastSeenAt.getTime() + 5_000) })).toBeNull();
  });

  it('L85B-U-FAMILIES-06 — revue de migration : égalité métier de la valeur en place (vide, nombres, dates au jour)', () => {
    expect(sameFieldValue(null, '')).toBe(true);
    expect(sameFieldValue(150000, '150000')).toBe(true);
    expect(sameFieldValue('2021-05-06T00:00:00.000Z', '2021-05-06')).toBe(true);
    expect(sameFieldValue(15000000, 150000)).toBe(false);
    expect(sameFieldValue('Maison', 'maison')).toBe(false);
  });

  it('L85B-U-FAMILIES-07 — propagation (version 2) : « même réalité » non appliquée, réalité écartée encore rattachée ; décision annulée ou consolidation en attente : rien', () => {
    expect([...PROPAGATED_RESOLUTION_RULES]).toEqual(['LINK-ELT', 'OPERATION-MATCH', 'LINK-ASSET-CONFLICT']);
    expect(getCheck('COH-TODO-RESOLUTION-PROPAGATION')!.version).toBe(2);
    const s = { fileAlive: true, candidateActive: true, candidatePending: false, decisionsActive: true, choice: 'SAME' as const, chosenCanonical: 7, attachedTo: [] as number[], rejectedCanonical: [8] };
    expect(operationMatchPropagation(s)).toBe('NOT_ATTACHED');
    expect(operationMatchPropagation({ ...s, attachedTo: [7] })).toBe('CONSISTENT');
    expect(operationMatchPropagation({ ...s, attachedTo: [7, 8] })).toBe('STILL_ATTACHED_TO_REJECTED');
    expect(operationMatchPropagation({ ...s, choice: 'DISTINCT', chosenCanonical: null, attachedTo: [8] })).toBe('STILL_ATTACHED_TO_REJECTED');
    expect(operationMatchPropagation({ ...s, decisionsActive: false })).toBe('CONSISTENT');
    expect(operationMatchPropagation({ ...s, candidatePending: true })).toBe('CONSISTENT');
    expect(operationMatchPropagation({ ...s, candidateActive: false })).toBe('GONE');
  });

  it('L85B-U-FAMILIES-08 (C-Q9) — campagne automatique 81A RETIRÉE (code et tâche) ; rattrapage BO conservé (même réexamen) ; couverture « À traiter » à jour', async () => {
    const reprise = await import('@/services/to-process/arbitration-equivalence-reprise');
    expect('runArbitrationRepriseCampaign' in reprise).toBe(false);
    expect('readArbitrationRepriseState' in reprise).toBe(false);
    expect(reprise.runArbitrationReprise).toBeTypeOf('function');
    expect(reprise.reexamineCard).toBeTypeOf('function');
    const catalogue = sansCommentaires(lire('src/services/scheduling/scheduled-tasks.catalog.ts'));
    expect(catalogue).not.toMatch(/runArbitrationRepriseCampaign/);
    const toutesSources = sourcesTs(join(ROOT, 'src')).filter((f) => !/__tests__|\.test\.ts$/.test(f));
    for (const f of toutesSources) expect(sansCommentaires(readFileSync(f, 'utf8')), relative(ROOT, f)).not.toMatch(/runArbitrationRepriseCampaign/);
    const aTraiter = COVERAGE_INVENTORY.find((e) => e.domain === 'a-traiter')!;
    expect(aTraiter.checks).toEqual(expect.arrayContaining(NOUVEAUX));
    expect(aTraiter.gap!.what).not.toMatch(/arbitrages T3|revues de migration|propositions d’agenda/);
  });
});

describe('L85B-U-VERSION — réévaluation historique (§6.4) et version déployée en cours de campagne', () => {
  const campagne = (o: Partial<CampaignRow> = {}): CampaignRow => ({
    id: 1, kind: 'DAILY', mode: 'DRY_RUN', status: 'RUNNING', phase: 'TRAVERSE', campaignDate: '2026-10-24', scope: null, trigger: 'schedule',
    startedAt: new Date('2026-10-24T03:00:00Z'), deadlineAt: null, cursorAccountId: 12, cursorCheckIndex: 1, cursorObjectId: 40,
    accounts: { visited: 0, skipped: {} }, counters: { A: { controlled: 3, results: {}, durationMs: 1, expected: 3, missingAtVerify: 1, remaining: 0 } },
    metrics: { runs: 1, durationMs: 1, cpuUserMs: 0, cpuSystemMs: 0, rssPeakMb: 0, aiCalls: 0, repairsAttempted: 0, objectsControlled: 3 },
    registryVersion: 'r1-ancien', checks: [{ id: 'A', version: 1 }, { id: 'B', version: 1 }, { id: 'C', version: 1 }], cursorCheckId: 'B', rulesChanges: [], ...o,
  });
  const nouveau = [{ id: 'A', version: 1 }, { id: 'N', version: 1 }, { id: 'B', version: 2 }] as never[];

  it('L85B-U-VERSION-01 — diff du registre : versions changées, contrôles ajoutés, retirés', () => {
    expect(diffRegistryChecks([{ id: 'A', version: 1 }, { id: 'B', version: 1 }, { id: 'C', version: 1 }], [{ id: 'A', version: 1 }, { id: 'N', version: 1 }, { id: 'B', version: 2 }]))
      .toEqual({ changed: [{ id: 'B', from: 1, to: 2 }], added: ['N'], removed: ['C'] });
  });

  it('L85B-U-VERSION-02 — curseur repositionné par identifiant ; fin des contrôles ; contrôle retiré ou campagne antérieure à 0704 : même position bornée', () => {
    const regs = [{ id: 'A' }, { id: 'N' }, { id: 'B' }];
    expect(realignCheckIndex(regs, 'B', 1)).toBe(2);
    expect(realignCheckIndex(regs, CURSOR_END_OF_CHECKS, 1)).toBe(3);
    expect(realignCheckIndex(regs, 'C', 2)).toBe(2);
    expect(realignCheckIndex(regs, null, 1)).toBe(1);
    expect(realignCheckIndex(regs, null, 9)).toBe(3);
  });

  it('L85B-U-VERSION-03 — en PARCOURS : changement journalisé, curseur repositionné, version adoptée, compteurs conservés', () => {
    const c = campagne();
    expect(adoptDeployedRegistry(c, nouveau, 'r1-nouveau', new Date('2026-10-24T08:00:00Z'))).toBe(true);
    expect(c.cursorCheckIndex).toBe(2);
    expect(c.cursorAccountId).toBe(12);
    expect(c.registryVersion).toBe('r1-nouveau');
    expect(c.checks).toEqual([{ id: 'A', version: 1 }, { id: 'N', version: 1 }, { id: 'B', version: 2 }]);
    expect(c.rulesChanges).toEqual([{ at: '2026-10-24T08:00:00.000Z', phase: 'TRAVERSE', from: 'r1-ancien', to: 'r1-nouveau', changed: [{ id: 'B', from: 1, to: 2 }], added: ['N'], removed: ['C'], verifyRestarted: false }]);
    expect(c.counters.A.expected).toBe(3);
    // Même version : rien.
    expect(adoptDeployedRegistry(c, nouveau, 'r1-nouveau', new Date())).toBe(false);
    expect(c.rulesChanges).toHaveLength(1);
  });

  it('L85B-U-VERSION-04 — en VÉRIFICATION : la vérification repart du début (compteurs de vérification remis à zéro)', () => {
    const c = campagne({ phase: 'VERIFY' });
    expect(adoptDeployedRegistry(c, nouveau, 'r1-nouveau', new Date())).toBe(true);
    expect([c.cursorAccountId, c.cursorCheckIndex, c.cursorObjectId]).toEqual([0, 0, 0]);
    expect(c.counters.A).toEqual({ controlled: 3, results: {}, durationMs: 1 });
    expect(c.rulesChanges[0]).toMatchObject({ phase: 'VERIFY', verifyRestarted: true });
  });

  it('L85B-U-VERSION-05 — anti-boucle levée UNE fois par une nouvelle version des règles ; jamais une seconde relance asynchrone', () => {
    const prev = (o: Partial<ProofState>): ProofState => ({
      rules_version: 1, last_result: 'REPAIR_INEFFECTIVE', last_repair_hash: 'h', repair_attempts: 1, finding_streak: 2, consecutive_errors: 0, first_detected_at: null, ...o,
    });
    expect(repairAllowed(prev({}), 'h', 1)).toBe(false);
    expect(repairAllowed(prev({}), 'h', 2)).toBe(true);
    expect(repairAllowed(prev({ last_result: 'REPAIR_SUPPRESSED' }), 'h', 2)).toBe(true);
    expect(repairAllowed(prev({ last_result: 'REPAIR_PENDING' }), 'h', 2)).toBe(false);
    expect(repairAllowed(prev({ rules_version: null }), 'h', 2)).toBe(false);
    expect(repairAllowed(prev({}), 'h')).toBe(false);
  });

  it('L85B-U-VERSION-06 — évolutions du lot : versions incrémentées (stock réexaminé), vérification exigeant la version EN VIGUEUR, erreur sans effet sur la version', () => {
    expect(getCheck('COH-TCO-EXTRACTED-EXPENSES')!.version).toBe(2);
    expect(getCheck('COH-TCO-EXTRACTED-EXPENSES')!.anomalies).toContain('SOURCE_AMOUNT_NOT_EXPLOITED');
    const orch = sansCommentaires(lire('src/services/coherence/orchestrator.ts'));
    expect(orch).toMatch(/last_success_at >= \$4\s+AND rules_version = \$5/);
    const engine = sansCommentaires(lire('src/services/coherence/engine.ts'));
    expect(engine).toMatch(/rules_version = CASE WHEN \$7::boolean THEN p\.rules_version ELSE \$4::int END/);
    expect(existsSync(join(ROOT, 'src/db/migrations/0704_l85b_coherence_reevaluation_versions.sql'))).toBe(true);
  });
});

describe('L85B-U-MATRIX — matrice de recette CA-01 à CA-19 et scénarios (docs/exploitation/coherence-recette.md)', () => {
  const doc = lire('docs/exploitation/coherence-recette.md');

  it('chaque critère CA-01 à CA-19 et chaque scénario 1 à 25 a une ligne (test ou motif d’absence)', () => {
    for (let i = 1; i <= 19; i++) expect(doc, `CA-${String(i).padStart(2, '0')}`).toMatch(new RegExp(`\\n\\| CA-${String(i).padStart(2, '0')} \\|`));
    const scenarios = doc.slice(doc.indexOf('## 8.'));
    for (let i = 1; i <= 25; i++) expect(scenarios, `scénario ${i}`).toMatch(new RegExp(`\\n\\| ${i} \\|`));
  });

  it('chaque identifiant de test cité existe dans les tests du dépôt', () => {
    const tests = sourcesTs(join(ROOT, 'src')).filter((f) => /__tests__|\.test\.ts$|\.e2e\.ts$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
    const cites = [...new Set(doc.match(/\b(?:L\d{2}[A-Z]-(?:E2E-\d{2}|E\d{2}|U-[A-Z0-9-]+|C\d)|T3-COH-\d{2})\b/g) ?? [])];
    expect(cites.length).toBeGreaterThan(30);
    for (const id of cites) expect(tests.includes(id), id).toBe(true);
  });
});

function sourcesTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sourcesTs(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}
