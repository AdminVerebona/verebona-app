/**
 * Lot 113AG (Trello #734, P1 pré-MEP) — diagnostic BO : transactions
 * PostgreSQL (25P02) et faux statuts COMPLETE, sur PostgreSQL 16 RÉEL.
 *
 *   · E01 cause : le schéma du commit déployé (quatre `savepoint()` en
 *     `Promise.all`, échec de ROLLBACK TO ignoré) invalide la transaction SANS
 *     aucune requête fautive (RELEASE 1 détruit 2..4 → 3B001 → 25P02 en
 *     cascade, listes vides) ; la session corrigée exécute les mêmes appels
 *     l'un après l'autre (une instruction à la fois), aucune erreur ;
 *   · E02 échec d'UNE des quatre lectures parallèles T3 (code PostgreSQL
 *     réel) : point de reprise restauré, session saine, T3 PARTIAL (jamais
 *     COMPLETE), lecture « non lue » ≠ « aucune » ;
 *   · E03 erreur récupérable : rollback effectif, lectures suivantes
 *     complètes, code d'origine présent ;
 *   · E04 échec RÉEL de ROLLBACK TO SAVEPOINT : incident fatal, connexion
 *     libérée, plus aucune instruction envoyée, zéro 25P02, origine + échec de
 *     restauration conservés ;
 *   · E05 diagnostic du compte : sans panne, T3 / T1 / coûts COMPLETE et zéro
 *     erreur SQL (régression : l'ancien code invalidait la transaction dès un
 *     document sans bien) ; erreur T3 auparavant masquée → T3 .json/.txt
 *     PARTIAL, première erreur au manifeste, sections suivantes complètes ;
 *   · E06 erreur T1 : .json et .txt qualifiés (jamais COMPLETE), suite saine ;
 *     erreur interceptée par une lecture appelée (`.catch(() => [])` des
 *     coûts IA) : fichier PARTIAL, pas COMPLETE ;
 *   · E07 session interrompue pendant T3 : arrêt propre, fichiers suivants
 *     FAILED « non produit », export NON FIABLE, aucune lecture après ;
 *   · E08 travail durable (worker, ZIP 113Q) : avec panne T3, PARTIAL publié,
 *     « Première erreur SQL » dans l'erreur affichée au BO, archive conservée
 *     avec manifeste cohérent ; avec incident fatal, archive au statut exact ;
 *   · E09 global renforcé : zéro erreur SQL, T3 COMPLETE, lecture seule.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

type Json = Record<string, any>;

const s3 = vi.hoisted(() => {
  const objects = new Map<string, { body: Buffer }>();
  const uploads = new Map<string, { key: string; parts: Buffer[] }>();
  let n = 0;
  const client = {
    async send(c: { constructor: { name: string }; input: Record<string, any> }) {
      const i = c.input;
      switch (c.constructor.name) {
        case 'CreateMultipartUploadCommand': { const id = `u${++n}`; uploads.set(id, { key: i.Key, parts: [] }); return { UploadId: id }; }
        case 'UploadPartCommand': { uploads.get(i.UploadId)!.parts[i.PartNumber - 1] = Buffer.from(i.Body); return { ETag: `e${i.PartNumber}` }; }
        case 'CompleteMultipartUploadCommand': { const u = uploads.get(i.UploadId)!; objects.set(i.Key, { body: Buffer.concat(u.parts) }); uploads.delete(i.UploadId); return {}; }
        case 'AbortMultipartUploadCommand': uploads.delete(i.UploadId); return {};
        case 'ListMultipartUploadsCommand': return { Uploads: [...uploads.entries()].filter(([, u]) => u.key.startsWith(i.Prefix ?? '')).map(([UploadId, u]) => ({ Key: u.key, UploadId })), IsTruncated: false };
        case 'HeadObjectCommand': {
          const o = objects.get(i.Key);
          if (!o) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
          return { ContentLength: o.body.length };
        }
        case 'ListObjectsV2Command':
          return { Contents: [...objects.entries()].filter(([k]) => k.startsWith(i.Prefix ?? '')).sort(([a], [b]) => a.localeCompare(b)).map(([Key, o]) => ({ Key, Size: o.body.length })), IsTruncated: false };
        case 'GetObjectCommand': {
          const o = objects.get(i.Key);
          if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
          const m = /^bytes=-(\d+)$/.exec(String(i.Range ?? ''));
          const body = m ? o.body.subarray(Math.max(0, o.body.length - Number(m[1]))) : o.body;
          const { Readable } = await import('node:stream');
          const r = Readable.from([body], { objectMode: false }) as unknown as Record<string, unknown>;
          r.transformToByteArray = async () => new Uint8Array(body);
          return { Body: r };
        }
        case 'DeleteObjectsCommand': for (const x of i.Delete.Objects) objects.delete(x.Key); return {};
        default: throw new Error(`commande S3 non simulée : ${c.constructor.name}`);
      }
    },
  };
  return { objects, client };
});

vi.mock('@/lib/s3-config', async (orig) => ({
  ...(await orig<typeof import('@/lib/s3-config')>()),
  isS3Configured: () => true,
  getS3Bucket: () => 'bucket-e2e',
  getS3Client: () => s3.client,
}));

/** Requêtes T3 / T1 / coûts visées par les pannes (texte des lectures appelées). */
const T3_PREUVES = /FROM coherence_object_proofs\s+WHERE account_id = \$1 AND check_id = 'COH-DOC-PRIMARY-LINK'/;
const T3_GROUPES = /FROM document_identity_groups WHERE account_id = \$1 AND active/;
const T1_PROMPT = /FROM ai_master_prompt_versions WHERE treatment = 'T1'/;
const COUTS_STATUT = /FROM ai_model_price_status WHERE provider = 'gemini'/;
/** Panne RÉELLE PostgreSQL (22012 division_by_zero) à la place de la lecture visée. */
/** Aucun 25P02 : ni erreur SQL consignée, ni erreur de fichier (les notes explicatives du manifeste citent le code, à dessein). */
const sans25P02 = (m: Json) => {
  expect(m.sqlIncidents.consequences).toBe(0);
  expect((m.sqlIncidents.incidents as Json[]).filter((x) => x.sqlstate === '25P02')).toEqual([]);
  expect((m.files as Json[]).filter((f) => String(f.error ?? '').includes('25P02')).map((f) => f.path)).toEqual([]);
};
const failOn = (re: RegExp) => ({ q: (q: (t: string, p?: unknown[]) => Promise<Json[]>) => (t: string, p: unknown[] = []) => (re.test(t) ? q('SELECT 1/0 AS panne', []) : q(t, p)) }) as never;

scenario('L113AG', 'Diagnostic BO : accès sérialisés à la session, première erreur SQL, statuts exacts', ({ sql, make }) => {
  afterAll(() => { vi.restoreAllMocks(); });
  const storage = { client: s3.client as never, bucket: 'bucket-e2e' };
  let A: AccountRow;
  let admin: { id: number };
  const orphans: number[] = [];

  beforeAll(async () => {
    admin = await make.user({ role: 'ADMIN' });
    A = await make.account();
    const bien = await make.asset(A, { category: 'IMMOBILIER', name: 'Bien 113AG' });
    // Documents SANS bien (orphelins) avec extraction : ce que lit le journal T3 (le cas du compte #10).
    for (let k = 0; k < 3; k++) {
      const f = await make.assetFile(A, { assetId: null });
      await sql`INSERT INTO document_extractions (account_id, file_id, provider, model, prompt_version, operation_trace_id, fact_count, title)
                VALUES (${A.id}, ${f.id}, 'gemini', 'gemini-2.5-pro', 't1@v7', ${`tr-l113ag-${f.id}`}, 1, ${`Facture orpheline ${k}`})`;
      orphans.push(f.id);
    }
    const f = await make.assetFile(A, { assetId: bien.id });
    await sql`INSERT INTO document_extractions (account_id, file_id, provider, model, prompt_version, operation_trace_id, fact_count, title)
              VALUES (${A.id}, ${f.id}, 'gemini', 'gemini-2.5-pro', 't1@v7', ${`tr-l113ag-${f.id}`}, 1, 'Facture rattachée')`;
  }, 120_000);

  const session = async (wrap: Json = {}, opts: Json = {}) => (await import('@/services/admin/account-data/session')).openReadSession(wrap, opts);
  const diagnostic = async (s: Awaited<ReturnType<typeof session>>, scope: 'account' | 'global' = 'account', reinforced = false) => {
    const { generateDiagnostic } = await import('@/services/admin/diagnostics-export/collect');
    return generateDiagnostic({ scope, id: scope === 'account' ? A.id : undefined, reinforced } as never, { adminUserId: admin.id, session: s });
  };
  const file = (b: { manifest: Json }, path: string) => (b.manifest.files as Json[]).find((f) => f.path === path)!;
  const content = (b: { files: Array<{ path: string; content: string }> }, path: string) => b.files.find((f) => f.path === path)!.content;

  it('L113AG-E01 cause : quatre savepoint() en Promise.all invalidaient la transaction sans requête fautive ; la session corrigée les sérialise', async () => {
    // AVANT — reproduction fidèle du code déployé (session.ts l.212-222 + diagnostic.ts l.193-207) sur une connexion réservée.
    const { pgClient } = await import('@/db');
    const conn = await (pgClient as unknown as { reserve: () => Promise<{ unsafe: (t: string) => Promise<Json[]>; release: () => void }> }).reserve();
    const log: string[] = [];
    const raw = async (t: string) => { try { return await conn.unsafe(t); } catch (e) { log.push(`${(e as { code?: string }).code} ${t}`); throw e; } };
    await raw('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let n = 0;
    const oldSavepoint = async <T>(fn: () => Promise<T>) => {
      const name = `vb_sp_${++n}`;
      await raw(`SAVEPOINT ${name}`);
      try { const out = await fn(); await raw(`RELEASE SAVEPOINT ${name}`); return out; } catch (e) { await raw(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined); throw e; }
    };
    const avant = await Promise.all([1, 2, 3, 4].map((i) => oldSavepoint(() => raw(`SELECT ${i} AS x`)).catch(() => [] as Json[])));
    const suite = await oldSavepoint(() => raw('SELECT 1')).then(() => 'OK', (e) => (e as { code: string }).code);
    await conn.unsafe('ROLLBACK').catch(() => undefined);
    conn.release();
    expect(avant.map((r) => r.length)).toEqual([1, 0, 0, 0]);                      // 3 listes VIDES sans aucune requête fautive
    expect(log[0]).toBe('3B001 RELEASE SAVEPOINT vb_sp_2');                       // première erreur, masquée par .catch(() => [])
    expect(suite).toBe('25P02');                                                    // toutes les lectures suivantes : 25P02

    // APRÈS — mêmes appels parallèles sur la session corrigée : exécutés l'un après l'autre.
    const sent: string[] = [];
    const s = await session({}, { onStatement: (t: string) => sent.push(t.replace(/\s+/g, ' ').trim()) });
    try {
      const apres = await Promise.all([1, 2, 3, 4].map((i) => s.savepoint(() => s.q(`SELECT ${i} AS x`, []))));
      expect(apres.map((r) => Number(r[0].x))).toEqual([1, 2, 3, 4]);
      const seq = sent.filter((t) => /SAVEPOINT|SELECT \d AS x/.test(t));
      expect(seq).toEqual([1, 2, 3, 4].flatMap((i) => [`SAVEPOINT vb_sp_${i}`, `SELECT ${i} AS x`, `RELEASE SAVEPOINT vb_sp_${i}`]));
      expect(s.stats!.maxInFlight).toBe(1);
      expect(s.stats!.serializedWaits).toBeGreaterThanOrEqual(3);
      // Imbrication et Promise.all DANS un point de reprise : sérialisés aussi, sans interblocage.
      const imbr = await s.savepoint(() => Promise.all([s.savepoint(() => s.q('SELECT 10 AS x', [])), s.q('SELECT 11 AS x', []), s.savepoint(() => s.q('SELECT 12 AS x', []))]));
      expect(imbr.map((r) => Number(r[0].x))).toEqual([10, 11, 12]);
      expect(s.trace!.health()).toMatchObject({ state: 'HEALTHY', total: 0 });
      expect(Number((await s.q('SELECT 1 AS ok', []))[0].ok)).toBe(1);
    } finally { await s.close(); }
  }, 60_000);

  it('L113AG-E02 une des quatre lectures parallèles T3 échoue (22012) : session saine, T3 PARTIAL, « non lu » ≠ « aucun »', async () => {
    const s = await session(failOn(T3_PREUVES));
    try {
      const t3q = (t: string, p: unknown[]) => s.savepoint(() => s.q(t, p));
      const { t3DocumentAssetDiagnostic, t3DiagnosticText } = await import('@/services/ai/reconciliation/document-asset/diagnostic');
      const d = await t3DocumentAssetDiagnostic(t3q, [A.id], { prompt: null });
      expect(d.status).toBe('PARTIAL');
      expect(d.errors).toEqual([expect.objectContaining({ read: expect.stringContaining('COH-DOC-PRIMARY-LINK'), accountId: A.id, sqlstate: '22012' })]);
      const docs = d.accounts[0].documents!;
      expect(docs.map((x) => x.fileId).sort()).toEqual([...orphans].sort());
      expect(docs.every((x) => (x.unread ?? []).includes('coherence') && !(x.unread ?? []).includes('job'))).toBe(true);
      expect(t3DiagnosticText(d)).toMatch(/STATUT DES LECTURES : PARTIEL — 1 lecture\(s\) en échec/);
      const h = s.trace!.health();
      expect(h).toMatchObject({ state: 'HEALTHY', origins: 1, consequences: 0 });
      expect(h.firstError).toMatchObject({ sqlstate: '22012', recovered: true, kind: 'ORIGIN' });
      expect(Number((await s.q('SELECT 2 AS ok', []))[0].ok)).toBe(2);           // session toujours utilisable
    } finally { await s.close(); }
  }, 60_000);

  it('L113AG-E03 erreur récupérable : rollback effectif, lectures suivantes complètes, code d’origine présent', async () => {
    const s = await session();
    try {
      s.trace!.setContext({ phase: 'EXTRACTION', file: 'test/a.json', generationId: 'gen-e03' });
      await expect(s.savepoint(() => s.q('SELECT 1/0', []))).rejects.toMatchObject({ code: '22012' });
      // Erreur interceptée DANS le point de reprise par l'appelant : jamais un résultat présenté comme lu.
      await expect(s.savepoint(async () => { await s.q('SELECT 1/0', []).catch(() => []); return s.q('SELECT 3 AS x', []); }))
        .rejects.toMatchObject({ code: '22012', message: expect.stringContaining('interceptée par l’appelant') });
      expect(Number((await s.savepoint(() => s.q('SELECT 4 AS x', [])))[0].x)).toBe(4);
      const h = s.trace!.health();
      expect(h.state).toBe('HEALTHY');
      expect(h.firstError).toMatchObject({ seq: 1, sqlstate: '22012', phase: 'EXTRACTION', file: 'test/a.json', generationId: 'gen-e03', recovered: true });
      expect(h.firstError!.caller).toBeTruthy();
      // La lecture suivie d'une erreur dans le même point de reprise : 25P02 rattaché à SA cause, jamais à sa place.
      expect(h.incidents.filter((x) => x.kind === 'CONSEQUENCE').every((x) => x.consequenceOf === 2)).toBe(true);
      expect(h.origins).toBe(2);
    } finally { await s.close(); }
  }, 60_000);

  it('L113AG-E04 échec réel de ROLLBACK TO SAVEPOINT : incident fatal, connexion libérée, aucune lecture ensuite, zéro 25P02', async () => {
    const sent: string[] = [];
    const fatals: Json[] = [];
    const s = await session({}, { testFailRollbackTo: () => true, onStatement: (t: string) => sent.push(t), onFatal: (f: Json) => fatals.push(f) });
    const [{ pid }] = await s.q('SELECT pg_backend_pid() AS pid', []);
    let err: Json | null = null;
    try { await s.savepoint(() => s.q('SELECT 1/0', [])); } catch (e) { err = e as Json; }
    expect(err).toMatchObject({ code: 'VB_SESSION_BROKEN', name: 'ReadSessionBrokenError' });
    expect(err!.fatal.origin).toMatchObject({ sqlstate: '22012', kind: 'ORIGIN', recovered: false });
    expect(err!.fatal.rollback).toMatchObject({ sqlstate: '3B001', kind: 'ROLLBACK_FAILED' });
    expect(err!.message).toMatch(/22012.*3B001/);
    expect(fatals).toHaveLength(1);
    // Connexion libérée : la transaction de l'instantané n'existe plus côté serveur.
    // (la connexion rendue au pool peut servir cette requête-ci : elle est alors exclue ; sinon elle est « idle », sans transaction).
    const [act] = await sql<{ state: string | null; xact: string | null }[]>`SELECT state, xact_start::text AS xact FROM pg_stat_activity WHERE pid = ${Number(pid)} AND pid <> pg_backend_pid()`;
    expect(act ? { state: act.state, xact: act.xact } : null).toSatisfy((x: Json | null) => x === null || (x.state === 'idle' && x.xact === null));
    // Plus aucune instruction envoyée : erreur immédiate, sans cascade 25P02.
    const n = sent.length;
    await expect(s.q('SELECT 1', [])).rejects.toMatchObject({ code: 'VB_SESSION_BROKEN' });
    await expect(s.savepoint(() => s.q('SELECT 1', []))).rejects.toMatchObject({ code: 'VB_SESSION_BROKEN' });
    expect(sent.length).toBe(n);
    expect(s.trace!.health()).toMatchObject({ state: 'BROKEN', consequences: 0 });
    await s.close();
  }, 60_000);

  it('L113AG-E05 diagnostic du compte : sans panne zéro erreur SQL et T3/T1 COMPLETE ; erreur T3 masquée → PARTIAL, première erreur au manifeste', async () => {
    // Sans panne : la régression du #734 (documents sans bien → transaction invalidée) ne se reproduit plus.
    const s0 = await session();
    let b0: Awaited<ReturnType<typeof diagnostic>>;
    try { b0 = await diagnostic(s0); } finally { await s0.close(); }
    expect(b0.manifest.sqlIncidents).toMatchObject({ session: 'SAINE', fiabilite: 'FIABLE', total: 0, consequences: 0, firstError: null });
    for (const p of ['ia/t3-rattachement-documents.json', 'ia/t3-rattachement-documents.txt', 'ia/t1-decisions-valeurs.json', 'ia/t1-decisions-valeurs.txt', 'ia/couts-ia-non-chiffres.json', 'ia/couts-ia-non-chiffres.txt']) {
      expect(file(b0, p), p).toMatchObject({ status: 'COMPLETE' });
    }
    expect(file(b0, 'ia/t3-rattachement-documents.json')).toMatchObject({ count: 3, expected: 3 });
    sans25P02(b0.manifest);

    // Erreur dans une lecture T3 auparavant masquée (groupes d'identité).
    const s = await session(failOn(T3_GROUPES));
    let b: Awaited<ReturnType<typeof diagnostic>>;
    try { b = await diagnostic(s); } finally { await s.close(); }
    const t3 = file(b, 'ia/t3-rattachement-documents.json');
    expect(t3).toMatchObject({ status: 'PARTIAL', error: expect.stringContaining('22012') });
    expect(t3.sqlError).toMatchObject({ sqlstate: '22012', file: 'ia/t3-rattachement-documents.json', recovered: true });
    expect(file(b, 'ia/t3-rattachement-documents.txt')).toMatchObject({ status: 'PARTIAL', error: expect.stringContaining('dérivé d’une source PARTIAL') });
    expect(content(b, 'ia/t3-rattachement-documents.txt')).toMatch(/^ATTENTION — FICHIER SOURCE ia\/t3-rattachement-documents\.json : PARTIAL/);
    expect(JSON.parse(content(b, 'ia/t3-rattachement-documents.json')).errors[0]).toMatchObject({ sqlstate: '22012' });
    // Session saine : sections suivantes complètes, aucune cascade.
    for (const p of ['ia/t1-decisions-valeurs.json', 'ia/t1-decisions-valeurs.txt', 'ia/couts-ia-non-chiffres.json']) expect(file(b, p), p).toMatchObject({ status: 'COMPLETE' });
    expect(b.manifest.sqlIncidents).toMatchObject({ session: 'SAINE', origins: 1, consequences: 0, firstError: { sqlstate: '22012', file: 'ia/t3-rattachement-documents.json', generationId: b.manifest.generationId } });
    expect(b.manifest.status).not.toBe('COMPLETE');
    expect(b.manifest.warnings[0]).toMatch(/^Première erreur SQL : n°1 22012/);
    expect(b.report).toMatch(/Première erreur SQL : n°1 22012/);
    // Section → manifeste : la section Extractions IA n'est pas COMPLETE.
    expect((b.manifest.sections as Json[]).find((x) => x.code === 'extractions-ia')!.status).not.toBe('COMPLETE');
  }, 300_000);

  it('L113AG-E06 erreur T1 : .json et .txt qualifiés, suite saine ; erreur interceptée par une lecture appelée (coûts) → PARTIAL', async () => {
    const s = await session({ q: (q: (t: string, p?: unknown[]) => Promise<Json[]>) => (t: string, p: unknown[] = []) => (T1_PROMPT.test(t) || COUTS_STATUT.test(t) ? q('SELECT 1/0 AS panne', []) : q(t, p)) });
    let b: Awaited<ReturnType<typeof diagnostic>>;
    try { b = await diagnostic(s); } finally { await s.close(); }
    const t1 = file(b, 'ia/t1-decisions-valeurs.json');
    expect(t1.status).not.toBe('COMPLETE');
    expect(t1.error).toMatch(/prompt T1 actif \(BO\) : 22012/);
    const t1txt = file(b, 'ia/t1-decisions-valeurs.txt');
    expect(t1txt.status).toBe(t1.status);
    expect(content(b, 'ia/t1-decisions-valeurs.txt')).toMatch(/^ATTENTION — FICHIER SOURCE ia\/t1-decisions-valeurs\.json/);
    // `.catch(() => [])` du diagnostic des coûts : l'erreur n'est plus perdue — fichier PARTIAL, première erreur rattachée.
    const couts = file(b, 'ia/couts-ia-non-chiffres.json');
    expect(couts).toMatchObject({ status: 'PARTIAL', sqlError: { sqlstate: '22012', file: 'ia/couts-ia-non-chiffres.json' } });
    expect(file(b, 'ia/couts-ia-non-chiffres.txt').status).toBe('PARTIAL');
    // T3 (avant T1) et fichiers indépendants : complets ; aucune conséquence 25P02.
    expect(file(b, 'ia/t3-rattachement-documents.json').status).toBe('COMPLETE');
    expect(b.manifest.sqlIncidents).toMatchObject({ session: 'SAINE', consequences: 0, firstError: { sqlstate: '22012', file: 'ia/t1-decisions-valeurs.json' } });
  }, 300_000);

  it('L113AG-E07 session interrompue pendant T3 : arrêt propre, fichiers suivants non produits, export NON FIABLE, zéro 25P02', async () => {
    const sent: string[] = [];
    let armed = false;
    const s = await session({ q: (q: (t: string, p?: unknown[]) => Promise<Json[]>) => (t: string, p: unknown[] = []) => {
      if (T3_PREUVES.test(t)) { armed = true; return q('SELECT 1/0 AS panne', []); }
      return q(t, p);
    } }, { testFailRollbackTo: () => armed, onStatement: (t: string) => sent.push(t) });
    let b: Awaited<ReturnType<typeof diagnostic>>;
    let nAtBreak = 0;
    try { b = await diagnostic(s); nAtBreak = sent.length; } finally { await s.close(); }
    const m = b.manifest;
    expect(m.sqlIncidents).toMatchObject({ session: 'INTERROMPUE', fiabilite: 'NON_FIABLE', consequences: 0, fatal: { origin: { sqlstate: '22012', file: 'ia/t3-rattachement-documents.json' }, rollback: { sqlstate: '3B001' } } });
    expect(file(b, 'ia/t3-rattachement-documents.json')).toMatchObject({ status: 'FAILED', error: expect.stringContaining('VB_SESSION_BROKEN') });
    for (const p of ['ia/t3-rattachement-documents.txt', 'ia/t1-decisions-valeurs.json', 'ia/t1-decisions-valeurs.txt', 'ia/couts-ia-non-chiffres.json', 'ia/couts-ia-non-chiffres.txt']) {
      expect(file(b, p), p).toMatchObject({ status: 'FAILED' });
    }
    expect(file(b, 'ia/t1-decisions-valeurs.json').error).toMatch(/^non produit : session de lecture interrompue/);
    expect(content(b, 'ia/t1-decisions-valeurs.json')).toBe('null\n');
    // Fichiers lus AVANT l'incident (même instantané) conservés ; aucune lecture après (dernière instruction = ROLLBACK TO en échec).
    expect((m.files as Json[]).some((f) => f.path.startsWith('donnees/') && f.status === 'COMPLETE')).toBe(true);
    expect(sent[nAtBreak - 1]).toMatch(/^ROLLBACK TO SAVEPOINT vb_sp_\d+_absent$/);
    expect(m.status).toBe('PARTIAL');
    expect(m.warnings[0]).toMatch(/^EXPORT NON FIABLE : session de lecture interrompue/);
    expect(m.snapshot!.exceptions.join(' ')).toMatch(/Session de lecture interrompue/);
    expect(b.report).toMatch(/Fiabilité \(session de lecture\) : NON FIABLE/);
    sans25P02(m);
    // Références absentes de l'auto-contrôle : qualifiées À PART (controle/references.json), jamais mêlées aux erreurs SQL.
    expect(file(b, 'controle/references.json')).toBeTruthy();
    expect((m.sqlIncidents!.incidents as Json[]).every((x) => !/references/.test(String(x.file)))).toBe(true);
  }, 300_000);

  it('L113AG-E08 travail durable (ZIP 113Q) : PARTIAL avec première erreur au BO ; incident fatal → archive au statut exact', async () => {
    const repo = await import('@/services/admin/diagnostic-jobs/repository');
    const { drainDiagnosticJobs } = await import('@/services/admin/diagnostic-jobs/worker');
    const sessionMod = await import('@/services/admin/account-data/session');
    const real = sessionMod.openReadSession;
    const logs: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    const run = async (key: string, faults: { wrap: Json; opts?: (o: Json) => Json }) => {
      const spy = vi.spyOn(sessionMod, 'openReadSession').mockImplementation((_w, o) => real(faults.wrap as never, faults.opts ? faults.opts(o ?? {}) as never : o));
      try {
        const { job } = await repo.enqueueDiagnosticJob({ adminUserId: admin.id, request: { scope: 'account', id: A.id, reinforced: true }, idempotencyKey: `l113ag-${key}-${Date.now()}` });
        const [st] = await drainDiagnosticJobs({ onlyId: job.id, storage, workerId: `e2e-l113ag:${process.pid}:${key}`, heartbeatMs: 500 });
        const row = (await repo.readDiagnosticJob(job.id))!;
        const archive = await repo.readDiagnosticArchive(job.id);
        const z = archive ? await JSZip.loadAsync(s3.objects.get(archive.key)!.body) : null;
        const manifest = z ? JSON.parse(await z.files['manifeste.json'].async('string')) as Json : null;
        return { st, row, manifest, z, jobId: job.id };
      } finally { spy.mockRestore(); }
    };
    try {
      // 1. Erreur T3 récupérable : PARTIAL publié, archive conservée, « Première erreur SQL » dans l'erreur affichée au BO.
      const a = await run('t3', { wrap: failOn(T3_GROUPES) });
      expect(a.st).toBe('PARTIAL');
      expect(a.row.raw.error).toMatch(/Première erreur SQL : n°1 22012/);
      expect(a.manifest!.sqlIncidents).toMatchObject({ session: 'SAINE', firstError: { sqlstate: '22012', generationId: a.jobId, phase: expect.any(String) } });
      expect((a.manifest!.files as Json[]).find((f) => f.path === 'ia/t3-rattachement-documents.json')).toMatchObject({ status: 'PARTIAL' });
      expect((a.manifest!.files as Json[]).find((f) => f.path === 'ia/t1-decisions-valeurs.json')).toMatchObject({ status: 'COMPLETE' });
      const premiere = logs.find((l) => l.includes('"event":"sql-first-error"'))!;
      expect(JSON.parse(premiere.replace(/^\[diagnostic-job\] /, ''))).toMatchObject({ jobId: a.jobId, sqlstate: '22012', file: 'ia/t3-rattachement-documents.json', seq: 1 });
      // Fichier → section → manifeste → BO : sections persistées cohérentes avec le manifeste de l'archive.
      const secBo = (a.row.raw.sections as Json[]).find((x) => x.code === 'extractions-ia')!;
      expect(secBo.status).toBe((a.manifest!.sections as Json[]).find((x) => x.code === 'extractions-ia')!.status);

      // 2. Incident fatal pendant T3 : arrêt propre, archive au statut exact (PARTIAL, NON FIABLE), journal des deux causes.
      logs.length = 0;
      let armed = false;
      const b = await run('fatal', {
        wrap: { q: (q: (t: string, p?: unknown[]) => Promise<Json[]>) => (t: string, p: unknown[] = []) => (T3_PREUVES.test(t) ? (armed = true, q('SELECT 1/0 AS panne', [])) : q(t, p)) },
        opts: (o) => ({ ...o, testFailRollbackTo: () => armed }),
      });
      expect(b.st).toBe('PARTIAL');
      expect(b.row.raw.error).toMatch(/EXPORT NON FIABLE/);
      expect(b.manifest!.sqlIncidents).toMatchObject({ session: 'INTERROMPUE', fiabilite: 'NON_FIABLE', consequences: 0 });
      expect((b.manifest!.files as Json[]).find((f) => f.path === 'ia/sorties-modele.json')).toMatchObject({ status: 'FAILED' });
      const brk = logs.find((l) => l.includes('"event":"sql-session-broken"'))!;
      expect(JSON.parse(brk.replace(/^\[diagnostic-job\] /, ''))).toMatchObject({ origin: { sqlstate: '22012' }, rollback: { sqlstate: '3B001' }, connection: 'libérée' });
      expect(logs.join('\n')).not.toContain('25P02');
    } finally { err.mockRestore(); }
  }, 600_000);

  it('L113AG-E09 global renforcé : zéro erreur SQL, T3 COMPLETE, lecture seule et instantané REPEATABLE READ', async () => {
    const s = await session();
    let b: Awaited<ReturnType<typeof diagnostic>>;
    try {
      b = await diagnostic(s, 'global', true);
      await expect(s.q(`UPDATE assets SET name = 'x' WHERE id = -1`, [])).rejects.toMatchObject({ code: '25006' });
    } finally { await s.close(); }
    expect(b.manifest.snapshot!.isolation).toBe('REPEATABLE READ, READ ONLY');
    expect(b.manifest.sqlIncidents).toMatchObject({ session: 'SAINE', total: 0 });
    expect(file(b, 'ia/t3-rattachement-documents.json').status).toBe('COMPLETE');
    expect(file(b, 'ia/t1-decisions-valeurs.json').status).toBe('COMPLETE');
    sans25P02(b.manifest);
  }, 600_000);
});
