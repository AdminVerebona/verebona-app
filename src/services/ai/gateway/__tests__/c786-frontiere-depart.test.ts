/**
 * Carte Trello #786, écarts B01 et D03 — FRONTIÈRE DE DÉPART de la passerelle.
 *
 * L'écart B01 ne porte pas sur la fraîcheur de la garde (le lot 115I l'a rendue fraîche) mais sur ce qui se
 * passe ENTRE la garde et l'écriture sur le réseau : la garde lisait le verdict, puis la passerelle construisait
 * la capture, puis la requête partait. Une publication concurrente dans cet intervalle laissait partir une
 * requête interdite.
 *
 * Ce fichier éprouve la correction avec la passerelle RÉELLE et un fournisseur simulé instrumenté (décompte
 * exact des requêtes parties) :
 *   C786-G01 (B01)  publication ENTRE la garde et le départ : aucune nouvelle requête ne part
 *   C786-G02 (B01)  la garde est la DERNIÈRE instruction avant le départ (capture construite avant)
 *   C786-G03 (D03)  « autorisé » ≠ « réellement parti » : les mesures et la capture les distinguent
 *   C786-G04 (B01)  tentatives internes, réparation et rangs suivants : même protection
 *
 * Les deux VRAIS processus demandés par la recette R03 sont dans
 * `provider/__tests__/c786-deux-processus.manual.test.ts` (PostgreSQL requis, neutralisé sans base).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>> }));
vi.mock('../diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async () => undefined),
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { h.traces.push(t); return h.traces.length; }),
}));
vi.mock('../../queue/circuit-breaker.repository', async (orig) => ({
  ...(await orig<typeof import('../../queue/circuit-breaker.repository')>()),
  noteGatewayOutcome: vi.fn(),
}));

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { __setFallbackContextForTests } = await import('../fallback-context');
const A = await import('../../provider/operational-admission');
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('./t1-master-request');

type Trace = Record<string, unknown> & {
  model: string; errorCode?: string; costMicros?: number | null; inputTokens?: number;
  capture?: { callKind: string; sent?: unknown[] };
};
const traces = () => h.traces as Trace[];
const sansAppel = () => traces().filter((t) => t.capture?.callKind === 'pre_call_refusal');

const Schema = t1Schema({ ok: z.boolean() });
const OK = { rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 };
let fake: InstanceType<typeof FakeProvider>;

/** État PARTAGÉ simulé : ce que la garde lit (jamais une sonde). */
const indisponibles = new Set<string>();
/** VERSION publiée de l'état opérationnel, incrémentée par toute publication de verdict (#786, B01). */
let versionPubliee = 1;
/** Nombre de lectures de la version (une par garde, une par confirmation de départ). */
let lecturesVersion = 0;

/**
 * Publie un verdict comme le ferait une AUTRE instance : le verdict change ET la version est incrémentée,
 * exactement comme `bumpOperationalVersion` le fait dans la transaction de publication.
 */
function publierRefus(model: string): void {
  indisponibles.add(model);
  versionPubliee++;
}

/**
 * Simule une publication par une AUTRE INSTANCE dans la fenêtre EXACTE de l'écart B01 : entre la lecture de
 * version faite par la garde et celle faite par la confirmation de départ.
 *
 * Pour une tentative, la passerelle lit dans cet ordre (séquence vérifiée) :
 *   1. verdict  — garde du RANG (`gateway_rank`)
 *   2. version  — garde du rang
 *   3. verdict  — garde du DÉPART (`gateway_send`)
 *   4. version  — garde du départ      ← la publication a lieu JUSTE APRÈS cette lecture
 *   5. version  — confirmation de départ ← elle voit donc la version CHANGÉE, relit le verdict et refuse
 *
 * La lecture n° 4 rend la version d'AVANT la publication : c'est précisément ce que voit un worker qui a
 * franchi la garde un instant avant qu'un autre ne publie le refus.
 */
function publierEntreGardeEtDepart(model: string): void {
  A.__setOperationalVersionReaderForTests(async () => {
    lecturesVersion++;
    const avant = versionPubliee;
    if (lecturesVersion === 2) publierRefus(model);
    return avant;
  });
}

function brancherEtat() {
  A.__setPublishedVerdictReaderForTests(async (model, capability) => {
    const refuse = indisponibles.has(model);
    return {
      ...A.unknownVerdict(model, true, capability),
      state: refuse ? 'unavailable' : 'healthy',
      checkStatus: refuse ? 'failed_confirmed' : 'ok',
      error: refuse ? 'HTTP 404 NOT_FOUND — This model is no longer available to new users' : null,
      checkedAt: '2026-11-16T06:15:44.000Z',
    };
  });
  A.__setOperationalVersionReaderForTests(async () => { lecturesVersion++; return versionPubliee; });
}

function chaine(models: [string, string | null, string | null]) {
  __setConfigForTests({
    versionId: 1,
    entries: [{ ...emptyTreatmentConfig('T1'), primaryModel: models[0], fallback1: models[1], fallback2: models[2], maxOutputTokens: 2000 }],
  });
}
const req = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 7,
  sourceIds: [42], promptVariables: t1TestVariables('facture'), outputSchema: Schema, idempotencyKey: `c786-${Math.random()}`,
  ...over,
});
const requetes = (model?: string) => fake.calls.filter((c) => !model || c.model === model).length;

beforeEach(() => {
  h.traces.length = 0;
  indisponibles.clear();
  versionPubliee = 1;
  lecturesVersion = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
  chaine(['m-a', 'm-b', 'm-c']);
  brancherEtat();
  A.__resetAdmissionMetrics();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  __setConfigForTests(null);
  __setFallbackContextForTests(null);
  A.__setPublishedVerdictReaderForTests(null);
  A.__setOperationalVersionReaderForTests(null);
  vi.restoreAllMocks();
});

describe('C786-G01 — publication ENTRE la garde et le départ réseau (B01, R03)', () => {
  /**
   * Preuve de l'écart B01 : la garde avait lu « sain » ; la publication du refus survient ENSUITE, avant que
   * la requête ne parte. La confirmation de départ relève le changement de VERSION, relit le verdict, et
   * refuse — aucune requête interdite ne part, et le repli préconfiguré prend le relais.
   */
  it('verdict publié après la garde : zéro requête vers la route, le repli configuré répond', async () => {
    fake.on('m-a', () => OK).on('m-b', () => OK);
    // La publication intervient APRÈS la lecture du verdict par la garde : elle est déclenchée par la
    // première lecture de VERSION, c'est-à-dire exactement dans la fenêtre garde → départ.
    publierEntreGardeEtDepart('m-a');
    const r = await AiGateway.execute(req());
    expect(requetes('m-a')).toBe(0); // AUCUNE requête n'est partie vers la route refusée
    expect(r.model).toBe('m-b');
    // Le refus est tracé comme un envoi NON EFFECTUÉ : aucun coût, aucun jeton, aucun appel fictif.
    const refus = traces().filter((t) => t.model === 'm-a');
    expect(refus).toHaveLength(1);
    expect(refus[0]!.errorCode).toBe('MODEL_KNOWN_UNAVAILABLE');
    // Aucune requête transmise, aucun jeton, aucun coût : le départ a été annulé AVANT le réseau.
    expect(refus[0]!.capture?.sent ?? []).toHaveLength(0);
    expect(refus[0]!.inputTokens).toBe(0);
    expect(refus[0]!.costMicros ?? 0).toBe(0);
  });

  it('la VERSION publiée est relue juste avant chaque départ (aucun délai de tolérance)', async () => {
    fake.onAny(() => OK);
    await AiGateway.execute(req());
    expect(lecturesVersion).toBeGreaterThanOrEqual(2); // une à la garde, une à la confirmation
    const apres = lecturesVersion;
    await AiGateway.execute(req());
    expect(lecturesVersion).toBeGreaterThan(apres);
  });

  it('version INCHANGÉE : le départ a lieu sans relecture inutile du verdict', async () => {
    fake.onAny(() => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-a');
    expect(requetes('m-a')).toBe(1);
    expect(A.admissionMetrics().departed).toBeGreaterThanOrEqual(1);
  });

  it('une route redevenue saine repart (la fenêtre ne se transforme pas en exclusion permanente)', async () => {
    publierRefus('m-a');
    fake.onAny(() => OK);
    expect((await AiGateway.execute(req())).model).toBe('m-b');
    indisponibles.delete('m-a');
    versionPubliee++;
    expect((await AiGateway.execute(req())).model).toBe('m-a');
    expect(requetes('m-a')).toBe(1);
  });
});

describe('C786-G02 — la garde est la DERNIÈRE instruction avant le départ', () => {
  /**
   * La capture (`capturedRequestOf`, `sent.push`) était construite ENTRE la garde et `provider.call`. Elle est
   * désormais construite AVANT la garde : plus aucun travail, plus aucun `await`, ne s'intercale. Le test
   * l'observe par ce qui est OBSERVABLE : une requête refusée à la confirmation n'apparaît JAMAIS dans
   * `sent` (la capture n'est relevée qu'après le feu vert du départ).
   */
  it('une requête refusée à la confirmation n’est pas relevée comme transmise', async () => {
    fake.on('m-b', () => OK);
    publierEntreGardeEtDepart('m-a');
    await AiGateway.execute(req());
    // La trace du refus ne porte AUCUNE requête transmise : la capture n'est relevée dans `sent` qu'APRÈS
    // le feu vert du départ, alors qu'elle est CONSTRUITE avant la garde (plus rien entre garde et réseau).
    const refus = traces().find((t) => t.model === 'm-a');
    expect(refus).toBeDefined();
    expect(refus?.errorCode).toBe('MODEL_KNOWN_UNAVAILABLE');
    expect(refus?.capture?.sent ?? []).toHaveLength(0);
    // Et la trace du modèle qui a répondu, elle, en porte une.
    const succes = traces().find((t) => t.model === 'm-b' && t.errorCode === undefined);
    expect((succes?.capture?.sent ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

describe('C786-G03 — « autorisé » n’est pas « réellement parti » (D03)', () => {
  it('les mesures distinguent autorisé, réellement parti et refusé après publication', async () => {
    fake.on('m-b', () => OK);
    publierEntreGardeEtDepart('m-a');
    await AiGateway.execute(req());
    const m = A.admissionMetrics();
    // La route m-a a été AUTORISÉE par la garde, puis son départ a été annulé : jamais partie.
    expect(m.refusedAfterPublication).toBeGreaterThanOrEqual(1);
    expect(m.allowed).toBeGreaterThan(m.departed);
    // Le décompte par point d'envoi dit la même chose, point par point.
    expect(m.byPoint.gateway_send).toBeDefined();
    expect(m.byPoint.gateway_send!.departed).toBeLessThan(m.byPoint.gateway_send!.allowed);
    // Et le nombre de requêtes réellement vues par le fournisseur correspond aux départs comptés.
    expect(requetes()).toBe(m.byPoint.gateway_send!.departed);
  });

  it('aucun coût ni appel fictif n’est compté pour un saut de rang', async () => {
    publierRefus('m-a');
    fake.on('m-b', () => OK);
    await AiGateway.execute(req());
    expect(requetes('m-a')).toBe(0);
    expect(sansAppel().every((t) => t.costMicros === 0 && t.inputTokens === 0)).toBe(true);
  });
});

describe('C786-G04 — tentatives internes et rangs suivants : même protection (B01, R04)', () => {
  it('publication entre l’appel initial et la passe de réparation : la réparation ne part pas', async () => {
    let n = 0;
    fake.on('m-a', () => {
      n++;
      // Première réponse : JSON invalide — la passerelle tenterait une réparation sur le MÊME modèle.
      if (n === 1) { publierRefus('m-a'); return { rawText: '{ ceci n', inputTokens: 1, outputTokens: 1 }; }
      return OK;
    }).on('m-b', () => OK);
    const r = await AiGateway.execute(req());
    expect(requetes('m-a')).toBe(1); // seule la requête déjà partie a eu lieu
    expect(r.model).toBe('m-b');
  });

  it('tous les rangs refusés : erreur contrôlée, zéro requête, zéro coût', async () => {
    publierRefus('m-a'); publierRefus('m-b'); publierRefus('m-c');
    fake.onAny(() => OK);
    await expect(AiGateway.execute(req())).rejects.toBeTruthy();
    expect(requetes()).toBe(0);
    expect(A.admissionMetrics().departed).toBe(0);
    expect(sansAppel().every((t) => t.costMicros === 0)).toBe(true);
  });
});
