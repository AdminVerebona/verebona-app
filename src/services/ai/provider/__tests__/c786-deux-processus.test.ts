/**
 * Carte Trello #786 — HARNAIS « DEUX VRAIS PROCESSUS » avec faux fournisseur HTTP instrumenté (R03, R13).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE HARNAIS DÉMONTRE, ET QUE RIEN D'AUTRE NE PEUT DÉMONTRER
 *
 * L'audit du 22/11/2026 est explicite : « Tests actuels de concurrence dans un processus insuffisants ».
 * Deux `Promise` du même processus partagent le cache d'instance, la mémoire des verdicts fiables et
 * l'horloge : elles ne peuvent pas prouver qu'une publication faite par un AUTRE worker arrête un départ,
 * ni que deux instances arrivées ensemble sur une route neuve n'envoient qu'une sonde.
 *
 * Ce harnais lance donc de VRAIS processus (`node:child_process`, worker
 * `src/test/harness/c786-worker-depart.ts`), contre un PostgreSQL RÉEL, et compte les POST reçus par un FAUX
 * fournisseur HTTP instrumenté — jamais le fournisseur réel, jamais de donnée client.
 *
 *   C786-P01 (B01, R03)  garde franchie par le worker 1, refus publié par le worker 2, puis relâche :
 *                        ZÉRO POST interdit — seules les requêtes déjà parties finissent
 *   C786-P02 (B03, R13)  deux processus sondant simultanément une route JAMAIS sondée : exactement UN POST
 *   C786-P03 (B03, R13)  bail repris par un autre worker : le résultat tardif de l'ancien détenteur est rejeté
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POSTGRESQL REQUIS — NEUTRALISÉ PROPREMENT SANS BASE
 *
 * Ce fichier EXIGE une base PostgreSQL accessible et les migrations appliquées (1692, 1815, 1816, 1950).
 * Sans `DATABASE_URL`, ou si la connexion échoue, il se NEUTRALISE : les cas sont déclarés ignorés avec le
 * motif, et la CI sans base reste verte. Il ne provoque donc jamais d'échec faute d'environnement.
 *
 * COMMENT L'EXÉCUTER
 *
 *   # 1. Une base de recette (JAMAIS la production), migrations appliquées :
 *   export DATABASE_URL='postgres://user:mdp@localhost:5432/verebona_recette'
 *   npm run db:deploy-migrate
 *
 *   # 2. Le harnais seul, en série (il ouvre un port et écrit en base) :
 *   npx vitest --run src/services/ai/provider/__tests__/c786-deux-processus.test.ts
 *
 *   # 3. Pour voir le détail des échanges entre processus :
 *   C786_HARNESS_VERBOSE=1 npx vitest --run src/services/ai/provider/__tests__/c786-deux-processus.test.ts
 *
 * Il écrit et nettoie UNIQUEMENT les lignes de ses propres modèles de test (préfixe `c786-harness-`) dans
 * `ai_model_operational_status` et `ai_model_operational_history`. Aucune autre table n'est touchée.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';

const RACINE = resolve(__dirname, '../../../../..');
const WORKER = resolve(RACINE, 'src/test/harness/c786-worker-depart.ts');
const TSX = resolve(RACINE, 'node_modules/tsx/dist/cli.mjs');
const VERBEUX = process.env.C786_HARNESS_VERBOSE === '1';

/** Clé de test : jamais une clé réelle. Seule son empreinte circule. */
const CLE = 'c786-harness-cle-de-test-0123456789';
const PREFIXE = 'c786-harness-';

/** La base est-elle utilisable ? (motif précis, pour que l'ignorance soit explicite) */
async function baseUtilisable(): Promise<{ ok: true } | { ok: false; motif: string }> {
  if (!process.env.DATABASE_URL) return { ok: false, motif: 'DATABASE_URL absente' };
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'ai_model_operational_status'
          AND column_name IN ('key_fingerprint', 'capability', 'check_id', 'probe_lease_generation')`,
    )) as unknown as Array<{ n: number }>;
    if ((rows[0]?.n ?? 0) < 4) {
      return { ok: false, motif: 'migrations 1692 / 1815 / 1816 / 1950 non appliquées sur cette base' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, motif: `connexion impossible (${String((e as Error)?.message ?? e).slice(0, 120)})` };
  }
}

const etatBase = await baseUtilisable();
if (!etatBase.ok) {
  // Neutralisation PROPRE : le motif est dit, et la suite reste verte sans base.
  console.info(`[c786-deux-processus] cas ignorés — PostgreSQL requis : ${etatBase.motif}.`);
}

/** Issue d'un worker : les lignes `#C786 …` qu'il a écrites, et son code de sortie. */
interface Issue {
  code: number | null;
  lignes: Array<Record<string, unknown>>;
  brut: string;
}

function lancerWorker(cfg: Record<string, unknown>): { fin: Promise<Issue> } {
  const enfant = spawn(process.execPath, [TSX, WORKER, JSON.stringify(cfg)], {
    cwd: RACINE,
    env: { ...process.env, NODE_ENV: 'test', TS_NODE_PROJECT: resolve(RACINE, 'tsconfig.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let sortie = '';
  let erreurs = '';
  enfant.stdout.on('data', (d: Buffer) => { sortie += d.toString(); });
  enfant.stderr.on('data', (d: Buffer) => { erreurs += d.toString(); });
  const fin = (async (): Promise<Issue> => {
    const [code] = (await once(enfant, 'close')) as [number | null];
    if (VERBEUX) console.info(`[worker ${enfant.pid}] code ${code}\n${sortie}${erreurs ? `\n[stderr] ${erreurs}` : ''}`);
    const lignes = sortie.split('\n').filter((l) => l.startsWith('#C786 '))
      .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
    return { code, lignes, brut: `${sortie}${erreurs}` };
  })();
  return { fin };
}


// ── Faux fournisseur HTTP instrumenté ───────────────────────────────────────

interface PostRecu { model: string; worker: string; at: number }
let serveur: Server | null = null;
let baseUrl = '';
let posts: PostRecu[] = [];

beforeAll(async () => {
  if (!etatBase.ok) return;
  serveur = createServer((req, res) => {
    if (req.method === 'POST') {
      const m = /\/v1beta\/models\/([^:]+):generateContent/.exec(req.url ?? '');
      posts.push({ model: decodeURIComponent(m?.[1] ?? '?'), worker: String(req.headers['x-c786-worker'] ?? '?'), at: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }));
      return;
    }
    res.writeHead(404).end();
  });
  serveur.listen(0, '127.0.0.1');
  await once(serveur, 'listening');
  const adresse = serveur.address();
  baseUrl = typeof adresse === 'object' && adresse !== null ? `http://127.0.0.1:${adresse.port}` : '';
}, 30_000);

afterAll(async () => {
  if (serveur) { serveur.close(); await once(serveur, 'close').catch(() => undefined); }
  if (!etatBase.ok) return;
  const { pgClient } = await import('@/db');
  await pgClient.unsafe(`DELETE FROM ai_model_operational_history WHERE model LIKE $1`, [`${PREFIXE}%`] as never[]).catch(() => undefined);
  await pgClient.unsafe(`DELETE FROM ai_model_operational_status WHERE model LIKE $1`, [`${PREFIXE}%`] as never[]).catch(() => undefined);
}, 30_000);

afterEach(async () => {
  posts = [];
  if (!etatBase.ok) return;
  const { pgClient } = await import('@/db');
  await pgClient.unsafe(`DELETE FROM ai_model_operational_history WHERE model LIKE $1`, [`${PREFIXE}%`] as never[]).catch(() => undefined);
  await pgClient.unsafe(`DELETE FROM ai_model_operational_status WHERE model LIKE $1`, [`${PREFIXE}%`] as never[]).catch(() => undefined);
});

const cas = etatBase.ok ? it : it.skip;
const motifIgnore = etatBase.ok ? '' : ` [ignoré : ${etatBase.motif}]`;

describe('C786-P01 — publication par un AUTRE processus entre la garde et le réseau (B01, R03)', () => {
  cas(`refus publié par le worker 2 pendant l’arrêt du worker 1 : ZÉRO POST interdit${motifIgnore}`, async () => {
    const model = `${PREFIXE}b01`;
    // Worker 1 : franchit la garde (route encore saine), puis s'ARRÊTE 3 s avant de confirmer son départ.
    const w1 = lancerWorker({ mode: 'guard-hold-send', model, secret: CLE, providerUrl: baseUrl, holdMs: 3_000 });
    // Laisse au worker 1 le temps de franchir la garde…
    await new Promise((r) => setTimeout(r, 1_200));
    // …puis le worker 2 PUBLIE le refus confirmé, dans un processus distinct.
    const w2 = await lancerWorker({ mode: 'publish-refusal', model, secret: CLE, providerUrl: baseUrl }).fin;
    expect(w2.code, w2.brut).toBe(0);
    expect(w2.lignes.at(-1)).toMatchObject({ step: 'done', persistence: 'published', ok: false });

    const issue1 = await w1.fin;
    expect(issue1.code, issue1.brut).toBe(0);
    // La garde avait AUTORISÉ, et la confirmation de départ a REFUSÉ : le départ n'a pas eu lieu.
    expect(issue1.lignes.find((l) => l.step === 'guarded')).toMatchObject({ admitted: true });
    expect(issue1.lignes.find((l) => l.step === 'departed')).toMatchObject({ departed: false });
    // Preuve côté fournisseur : AUCUN POST n'est parti vers la route refusée.
    expect(posts.filter((p) => p.model === model)).toHaveLength(0);
  }, 60_000);

  cas(`route déjà refusée : la garde d’un nouveau processus refuse d’emblée${motifIgnore}`, async () => {
    const model = `${PREFIXE}b01-deja`;
    const publication = await lancerWorker({ mode: 'publish-refusal', model, secret: CLE, providerUrl: baseUrl }).fin;
    expect(publication.code, publication.brut).toBe(0);
    const w = await lancerWorker({ mode: 'guard-hold-send', model, secret: CLE, providerUrl: baseUrl, holdMs: 0 }).fin;
    expect(w.code, w.brut).toBe(0);
    expect(w.lignes.find((l) => l.step === 'guarded')).toMatchObject({ admitted: false });
    expect(posts.filter((p) => p.model === model)).toHaveLength(0);
  }, 60_000);
});

describe('C786-P02 — deux processus sondant une route JAMAIS sondée (B03, R13)', () => {
  cas(`exactement UN POST, et un seul détenteur de bail${motifIgnore}`, async () => {
    const model = `${PREFIXE}b03-neuve`;
    const [a, b] = await Promise.all([
      lancerWorker({ mode: 'probe-once', model, secret: CLE, providerUrl: baseUrl }).fin,
      lancerWorker({ mode: 'probe-once', model, secret: CLE, providerUrl: baseUrl }).fin,
    ]);
    expect(a.code, a.brut).toBe(0);
    expect(b.code, b.brut).toBe(0);
    const baux = [a, b].map((x) => x.lignes.find((l) => l.step === 'lease') as { acquired?: boolean } | undefined);
    // Exactement un détenteur — et surtout : plus jamais `acquired: true, reason: 'no_state'` sans réservation.
    expect(baux.filter((l) => l?.acquired === true)).toHaveLength(1);
    expect(baux.every((l) => (l as { reason?: string } | undefined)?.reason !== 'no_state' || l?.acquired === false)).toBe(true);
    // Preuve côté fournisseur : UN SEUL POST, quel que soit le worker qui l'a envoyé.
    expect(posts.filter((p) => p.model === model)).toHaveLength(1);
  }, 60_000);

  cas(`quatre processus simultanés (cron + BO + deux workers) : toujours UN seul POST${motifIgnore}`, async () => {
    const model = `${PREFIXE}b03-quatre`;
    const issues = await Promise.all(Array.from({ length: 4 }, () =>
      lancerWorker({ mode: 'probe-once', model, secret: CLE, providerUrl: baseUrl }).fin));
    for (const i of issues) expect(i.code, i.brut).toBe(0);
    expect(posts.filter((p) => p.model === model)).toHaveLength(1);
  }, 90_000);
});

describe('C786-P03 — bail repris : le résultat tardif de l’ancien détenteur est rejeté (B03, R13)', () => {
  cas(`jeton de clôture dépassé ⇒ résultat écarté et historisé${motifIgnore}`, async () => {
    const model = `${PREFIXE}b03-fencing`;
    const { pgClient } = await import('@/db');
    const O = await import('../model-operational.service');
    const { keyFingerprint } = await import('../access-identity');
    const fp = keyFingerprint(CLE);
    // Un premier détenteur obtient le bail (génération N) depuis CE processus.
    const premier = await (async () => {
      const { setProviderSecretResolver } = await import('../provider-secret');
      setProviderSecretResolver(async () => CLE);
      return O.acquireProbeLease({ model, secret: CLE, owner: 'c786-ancien', immediate: true });
    })();
    expect(premier.acquired).toBe(true);
    // Son bail expire (arrêt brutal), et un AUTRE processus le reprend (génération N+1).
    await pgClient.unsafe(
      `UPDATE ai_model_operational_status SET probe_lease_until = now() - interval '1 second'
        WHERE provider = 'gemini' AND model = $1 AND key_fingerprint = $2`, [model, fp] as never[],
    );
    const repris = await lancerWorker({ mode: 'probe-once', model, secret: CLE, providerUrl: baseUrl }).fin;
    expect(repris.code, repris.brut).toBe(0);
    const bail = repris.lignes.find((l) => l.step === 'lease') as { acquired?: boolean; generation?: number };
    expect(bail.acquired).toBe(true);
    expect(Number(bail.generation)).toBeGreaterThan(Number(premier.generation));
    // Le résultat TARDIF de l'ancien détenteur est rejeté, et historisé comme écarté.
    const tardif = await O.recordOperationalCheck({
      model, secret: CLE, source: 'catalog_refresh', outcome: { status: 'ok' },
      checkId: 'c786-2p-tardif', ...(premier.generation === null ? {} : { leaseGeneration: premier.generation }),
    });
    expect(tardif.stale).toBe(true);
    const histo = (await pgClient.unsafe(
      `SELECT discarded_reason FROM ai_model_operational_history
        WHERE model = $1 AND check_id = $2`, [model, 'c786-2p-tardif'] as never[],
    )) as unknown as Array<{ discarded_reason: string | null }>;
    expect(histo[0]?.discarded_reason).toBe('lease_fenced');
  }, 90_000);
});
