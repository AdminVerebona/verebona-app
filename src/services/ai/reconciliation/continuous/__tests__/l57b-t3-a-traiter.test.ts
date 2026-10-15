/**
 * Lot 57B — ticket P0 « T3 — Corriger les À traiter non résolus et fiabiliser
 * les logs » : fonctions PURES (issue et phases du passage, motifs, recherche
 * sémantique progressive, reprise de champ depuis T1, journal) et exécutant
 * de file. Les parcours réels sont dans `l57b-t3-a-traiter.e2e.ts` (PG16).
 */
import { describe, expect, it, vi } from 'vitest';
import { initialPhases, runOutcome, type RunPhases } from '../../account-reconciliation.service';
import { entreeRapport, journalValues, reasonOf, resolverOf, type OpenActionEntry } from '../open-actions.service';
import { documentTokens, semanticPages, semanticShortlist, type SemanticHint } from '../../document-asset/semantic-search';
import { buildMatchingIndex, type IndexedAsset } from '../../document-asset/matching-index';
import { rawValueOf, t1KeyDesignates, t1LabelDesignates } from '@/services/to-process/document-rule-bridge';
import type { DocumentKnowledgeSources } from '../../document-asset/document-sources';
import { runT3Job } from '../../t3-queue';
import { NO_GUARD } from '../../../queue/execution-control';
import type { QueuedJob } from '../../../queue/job-queue.repository';

const phases = (over: Partial<RunPhases> = {}): RunPhases => ({
  ASSETS: { status: 'DONE', error: null }, OPEN_KNOWLEDGE: { status: 'DONE', error: null },
  OPEN_ACTIONS: { status: 'DONE', error: null }, JOURNAL: { status: 'DONE', error: null }, ...over,
});

describe('T3-P0-TC06 — statut global : phases obligatoires reflétées (défaut A)', () => {
  it('phase obligatoire en échec ou NON exécutée → TECHNICAL_FAILURE (jamais « zéro résultat »)', () => {
    expect(runOutcome(phases({ OPEN_ACTIONS: { status: 'FAILED', error: 'boom' } }), { changes: 3, keptOpen: 0 })).toBe('TECHNICAL_FAILURE');
    expect(runOutcome(phases({ OPEN_KNOWLEDGE: { status: 'NOT_RUN', error: null } }), { changes: 0, keptOpen: 0 })).toBe('TECHNICAL_FAILURE');
    expect(runOutcome(phases({ ASSETS: { status: 'FAILED', error: 'x' } }), { changes: 0, keptOpen: 0 })).toBe('TECHNICAL_FAILURE');
  });
  it('carte en erreur → PARTIAL_SUCCESS ; cartes à arbitrer sans changement → BUSINESS_ABSTENTION ; sinon SUCCESS', () => {
    expect(runOutcome(phases({ OPEN_ACTIONS: { status: 'PARTIAL', error: '1 carte(s) en erreur' } }), { changes: 1, keptOpen: 0 })).toBe('PARTIAL_SUCCESS');
    expect(runOutcome(phases(), { changes: 0, keptOpen: 4 })).toBe('BUSINESS_ABSTENTION');
    expect(runOutcome(phases(), { changes: 2, keptOpen: 4 })).toBe('SUCCESS');
  });
  it('phase non configurée (orchestrateur de test) : jamais obligatoire', () => {
    const p = initialPhases({});
    expect(p.OPEN_ACTIONS.status).toBe('NOT_CONFIGURED');
    expect(runOutcome({ ...p, ASSETS: { status: 'DONE', error: null } }, { changes: 0, keptOpen: 0 })).toBe('SUCCESS');
    expect(initialPhases({ reconcileOpenActions: vi.fn() as never }).OPEN_ACTIONS.status).toBe('NOT_RUN');
  });
});

describe('T3-P0-TC07 — journal en échec : dégradation visible, pas un échec technique', () => {
  it('JOURNAL FAILED → PARTIAL_SUCCESS', () => {
    expect(runOutcome(phases({ JOURNAL: { status: 'FAILED', error: 'relation absente' } }), { changes: 1, keptOpen: 0 })).toBe('PARTIAL_SUCCESS');
  });
  it('valeurs du journal : codes et compteurs seulement, bornés', () => {
    const e = {
      actionId: 1, ruleCode: 'LINK-ASSET', targetType: 'DOCUMENT', targetId: 2, previousResolution: null, resolver: 'T3_DOCUMENT_ASSET',
      candidateCount: 0, deterministicAttempted: true, aiCalled: true, newResolution: 'NO_CANDIDATE', actionEffect: 'STILL_OPEN',
      reasonCode: 'NO_CANDIDATE', aiError: 'x'.repeat(900), confidence: 1.7, knowledgeSources: { FACTS: 2 },
    } as OpenActionEntry;
    const v = journalValues(9, { accountRunId: 3, queueJobId: 1751 }, e, true);
    expect(v).toHaveLength(39);
    expect(v.slice(0, 4)).toEqual([9, 3, 1751, 1]);
    expect(v).toContain('{"FACTS":2}');
    expect(v.find((x) => typeof x === 'string' && x.startsWith('xxx'))).toHaveLength(300);
    expect(v).toContain(1);
    expect(journalValues(9, {}, e, false)).toHaveLength(19);
  });
  it('résumé du job allégé (détail complet dans le journal)', () => {
    const r = entreeRapport({ actionId: 1, knowledgeSources: { FACTS: 1 }, aiTraceId: 't', reasonCode: 'RESOLVED' } as unknown as OpenActionEntry);
    expect(r).toMatchObject({ actionId: 1, reasonCode: 'RESOLVED' });
    expect(r).not.toHaveProperty('knowledgeSources');
    expect(r).not.toHaveProperty('aiTraceId');
  });
});

describe('T3-P0-TC14 — motifs exploitables et routage', () => {
  it('reasonCode par défaut selon l’effet', () => {
    expect(reasonOf({ actionEffect: 'CLOSED' })).toBe('RESOLVED');
    expect(reasonOf({ actionEffect: 'SKIPPED_NOT_T3' })).toBe('NOT_T3');
    expect(reasonOf({ actionEffect: 'ERROR' })).toBe('RESOLVER_FAILED');
    expect(reasonOf({ actionEffect: 'STILL_OPEN', note: 'job_pending' })).toBe('JOB_PENDING');
    expect(reasonOf({ actionEffect: 'STILL_OPEN', note: 'user_decision_protected' })).toBe('USER_DECISION_PROTECTED');
    expect(reasonOf({ actionEffect: 'STILL_OPEN', reasonCode: 'AMBIGUOUS' })).toBe('AMBIGUOUS');
  });
  it('T3-P0-TC08 — DATA-CONTRACT-END / DATA-WARRANTY-END / DATA-SUPPLIER routées vers T3_DOCUMENT_FIELD ; T4 jamais T3', () => {
    for (const c of ['DATA-CONTRACT-END', 'DATA-WARRANTY-END', 'DATA-SUPPLIER']) expect(resolverOf(c)).toEqual({ resolver: 'T3_DOCUMENT_FIELD', t3: true });
    expect(resolverOf('LINK-ASSET').resolver).toBe('T3_DOCUMENT_ASSET');
    expect(resolverOf('AGENDA-DUPLICATE').t3).toBe(false);
  });
});

describe('T3-P0-TC08/TC09 — désignation d’un champ par une clé ou un libellé lus par T1', () => {
  it('clé canonique ou alias du registre', () => {
    expect(t1KeyDesignates('contractEndDate', 'contractEndDate')).toBe(true);
    expect(t1KeyDesignates('date_fin_contrat', 'contractEndDate')).toBe(true);
    expect(t1KeyDesignates('leaseEndDate', 'contractEndDate')).toBe(false);
  });
  it('libellé lu contenant le libellé du registre (« Date de fin de contrat » ⊃ « Fin de contrat »)', () => {
    expect(t1LabelDesignates('Date de fin de contrat', 'contractEndDate', 'Fin de contrat')).toBe(true);
    expect(t1LabelDesignates('Fin de contrats signés', 'contractEndDate', 'Fin de contrat')).toBe(false);
    expect(t1LabelDesignates('Début de contrat', 'contractEndDate', 'Fin de contrat')).toBe(false);
  });
  it('valeur brute : date française convertie, le reste inchangé (jamais le nom du fichier)', () => {
    expect(rawValueOf('30/06/2027')).toBe('2027-06-30');
    expect(rawValueOf('1.2.2028')).toBe('2028-02-01');
    expect(rawValueOf(' Orange ')).toBe('Orange');
  });
});

const bien = (assetId: number, name: string, over: Partial<IndexedAsset> = {}): IndexedAsset => ({
  assetId, name, normalizedName: name.toLowerCase(), aliases: [], family: 'IMMOBILIER', category: 'IMMOBILIER', subtype: null,
  record: { assetId, family: 'IMMOBILIER', values: {} }, brandModel: null, city: null, postalCode: null, ...over,
});
const sources = (p: { title: string; supplier?: string; facts?: Array<[string, string]> }): DocumentKnowledgeSources => ({
  accountId: 1, fileId: 1, origins: ['EXTRACTION'], digest: 'd',
  extraction: { extractedAt: null, title: p.title, description: null, documentType: 'INVOICE', documentDate: null, supplier: p.supplier ?? null, multiAsset: false },
  texts: [{ origin: 'TRANSCRIPTION', zone: 'BODY', text: 'Nom du fichier : Maison de Lyon.pdf' }],
  facts: (p.facts ?? []).map(([label, value]) => ({ origin: 'FACTS', canonicalKey: null, label, subject: null, value, excerpt: null, targetType: null, targetEntityId: null, periodStart: null, periodEnd: null })),
});

describe('T3-P0-TC02 / TC12 — recherche sémantique : présélection et sélection progressive (défaut B)', () => {
  it('historique fournisseur = preuve serveur ; équipement / vocabulaire = indices ; corps du document ignoré', () => {
    const index = buildMatchingIndex(1, [bien(1, 'Maison de Lyon'), bien(2, 'Peugeot 308', { family: 'VEHICULE', category: 'VEHICULE' }), bien(3, 'Appartement')],
      [{ type: 'EQUIPMENT', id: 9, assetId: 2, name: 'Pneus hiver', normalizedName: 'pneus hiver', serial: null, brandModel: null }]);
    const s = sources({ title: 'Contrat de gardiennage de pneus', supplier: 'Euromaster' });
    expect(documentTokens(s).has('lyon')).toBe(false); // jamais le corps (ni le nom de fichier)
    const h = semanticShortlist(index, s, new Map([[3, 2]]));
    expect(h[0]).toMatchObject({ assetId: 3, origins: ['SUPPLIER_HISTORY'] });
    expect(h[0].serverSignals[0]).toMatch(/historique fournisseur : 2 document/);
    expect(h[1]).toMatchObject({ assetId: 2, origins: ['EQUIPMENT'] });
    expect(h[1].serverSignals).toEqual([]);
  });
  it('comptes volumineux : page 1 complète, pages suivantes = biens indiqués seulement, appels bornés', () => {
    const list: SemanticHint[] = Array.from({ length: 500 }, (_, i) => ({ assetId: i + 1, score: i < 30 ? 1 : 0, serverSignals: [], contextSignals: [], origins: [] }));
    const pages = semanticPages(list, 20, 3);
    expect(pages.map((p) => p.length)).toEqual([20, 10]);
    expect(semanticPages(list.map((x) => ({ ...x, score: 1 })), 20, 3)).toHaveLength(3);
    expect(semanticPages([], 20, 3)).toEqual([]);
  });
});

const job = (over: Partial<QueuedJob>): QueuedJob => ({
  id: 1751, treatment: 'T3', accountId: 13, targetType: null, targetId: null, status: 'RUNNING', origin: 'automatic',
  triggerCode: 'schedule_hourly', attempts: 1, lastError: null, availableAt: new Date(), coalesceRequested: false, headPriority: false,
  createdAt: new Date(), startedAt: new Date(), finishedAt: null, payload: null, executionId: null, workerId: null,
  leaseExpiresAt: null, recoveredCount: 0, configVersionId: null, ...over,
});

describe('T3-P0-TC06 / TC13 — exécutant de file : jamais DONE avec une phase obligatoire en échec', () => {
  const run = (over: Record<string, unknown>) => ({
    reconcileAsset: vi.fn(), listSweepAccounts: vi.fn(async () => []), enqueue: vi.fn() as never,
    reconcileAccount: vi.fn(async () => ({
      runId: 7, status: 'partial', objectsExamined: 1, objectsModified: 0, decisionsApplied: 0, conflictsCreated: 0, errors: 0, aiCalls: 0, ...over,
    })) as never,
  });
  it('phase « À traiter » en échec → erreur technique (reprise par la file), phases dans le message', async () => {
    const d = run({ outcome: 'TECHNICAL_FAILURE', phases: phases({ OPEN_ACTIONS: { status: 'FAILED', error: 'relation inconnue' } }) });
    await expect(runT3Job(job({}), NO_GUARD, d)).rejects.toThrow(/passage #7.*OPEN_ACTIONS FAILED \(relation inconnue\)/);
    await expect(runT3Job(job({ origin: 'manual', payload: { scope: 'full' } }), NO_GUARD, d)).rejects.toThrow(/phase\(s\) obligatoire\(s\)/);
  });
  it('réussite partielle → DONE avec issue et phases dans le détail (compteurs distincts)', async () => {
    const d = run({
      outcome: 'PARTIAL_SUCCESS', phases: phases({ OPEN_ACTIONS: { status: 'PARTIAL', error: '1 carte(s) en erreur' } }),
      openActions: {
        examined: 3, resolutionAttempted: 2, resolved: 1, openAtStart: 3, keptAmbiguous: 1, delegated: 0, errors: 1, aiCalls: 1,
        aiCallsByOperation: { t3_link_ambiguity: 1 }, journalStatus: 'OK', byEffect: { CLOSED: 1, UPDATED: 0, SUPERSEDED: 0, STILL_OPEN: 1, ERROR: 1 },
      },
    });
    const r = await runT3Job(job({}), NO_GUARD, d) as { result: string; detail: Record<string, unknown> };
    expect(r.result).toBe('APPLIED');
    expect(r.detail).toMatchObject({
      outcome: 'PARTIAL_SUCCESS', openActionsExamined: 3, openActionsResolutionAttempted: 2, openActionsResolved: 1,
      openActionsOpenAtStart: 3, openActionsErrors: 1, aiCallsByOperation: { t3_link_ambiguity: 1 }, journal: 'OK',
    });
  });
});
