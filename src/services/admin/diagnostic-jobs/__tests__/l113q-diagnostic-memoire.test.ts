/**
 * Lot 113Q (Trello #714) — tests unitaires : ZIP définitif (copie des flux
 * DEFLATE, ZIP64, vérification intégrale), relance automatique explicite,
 * lots bornés en octets, profil mémoire, sérialisation progressive identique,
 * lectures mémorisées, ordre des clés, processus dédié, une génération par
 * processus.
 */
import { createHash } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { archiveOrder, createZipWriter, gzipHeaderLength, verifyStoredArchive, writeArchive } from '../archive';
import { archiveObjectName, memoryLogLine } from '../runner';
import { diagJobSettings, retryPolicy, DIAG_JOB_PHASES, DIAG_JOB_PHASE_LABELS, DIAG_JOB_ERROR_LABELS, isTransientError } from '../state';
import { createMemoryRecorder, createPhaseProfiler, memPoint } from '../metrics';
import { exportBatchBytes, nextFetchRows, rowBytes } from '@/services/admin/account-data/session';
import { memoQuery, writeMaskedJson } from '@/services/admin/diagnostics-export/stream-json';
import { maskForExport } from '@/services/admin/diagnostics-export/model';
import { compareKeys, expandPropertyChain, indexPropertyDetails, propertyAssetsPerPart } from '@/services/admin/diagnostics-export/properties';
import { diagnosticsPlacement, processRoleSummary, processType, runsBackgroundJobs, runsDiagnosticJobs } from '@/lib/runtime/process-role';
import { planLaunch } from '../../../../../scripts/start-server.mjs';

type Row = Record<string, unknown>;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Stockage simulé : objets en mémoire, lecture partielle `Range: bytes=-n`. */
function fakeStorage(objects = new Map<string, Buffer>()) {
  const log: string[] = [];
  return {
    objects, log,
    storage: {
      bucket: 'b',
      client: {
        async send(c: { constructor: { name: string }; input: Record<string, any> }) {
          const i = c.input;
          log.push(`${c.constructor.name}:${i.Key}`);
          const o = objects.get(i.Key);
          if (c.constructor.name === 'HeadObjectCommand') { if (!o) throw Object.assign(new Error('NotFound'), { name: 'NotFound' }); return { ContentLength: o.length }; }
          if (c.constructor.name === 'GetObjectCommand') {
            if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
            const m = /^bytes=-(\d+)$/.exec(String(i.Range ?? ''));
            const body = m ? o.subarray(o.length - Number(m[1])) : o;
            return { Body: (async function* () { for (let k = 0; k < body.length; k += 7_000) yield body.subarray(k, k + 7_000); })() };
          }
          throw new Error(c.constructor.name);
        },
      } as never,
    },
  };
}

function storedAttempt(files: Record<string, string>, prefix = 'p/a1/') {
  const objects = new Map<string, Buffer>();
  const index = { files: [] as Array<{ path: string; bytes: number; compressedBytes: number; sha256: string }> };
  for (const [path, content] of Object.entries(files)) {
    const gz = gzipSync(Buffer.from(content, 'utf8'));
    objects.set(`${prefix}${path}.gz`, gz);
    if (path !== 'integrite.json') index.files.push({ path, bytes: Buffer.byteLength(content), compressedBytes: gz.length, sha256: sha(content) });
  }
  return { objects, index, prefix };
}

async function collect(storage: ReturnType<typeof fakeStorage>['storage'], entries: ReturnType<typeof archiveOrder>, date = new Date('2026-11-06T18:57:36Z')) {
  const chunks: Buffer[] = [];
  const r = await writeArchive(storage as never, entries, date, async (c) => { chunks.push(Buffer.from(c)); });
  return { zip: Buffer.concat(chunks), r };
}

describe('L113Q — ZIP définitif : copie des flux compressés, sans recompression', () => {
  const content = {
    'manifeste.json': JSON.stringify({ status: 'COMPLETE', files: ['a'] }, null, 2),
    'rapport.txt': 'Rapport synthétique — accents éèà\n'.repeat(50),
    'donnees/x/table.json': JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: i, texte: `ligne ${i} ${'z'.repeat(i % 50)}` }))),
    'tracabilite/vide.json': '',
    'SHA256SUMS.txt': 'abc  manifeste.json\n',
    'integrite.json': '{"schema":"verebona.bo.diagnostic-integrite/1"}\n',
  };

  it('en-tête gzip : 10 octets (zlib de Node), champs facultatifs (nom de fichier) lus', () => {
    expect(gzipHeaderLength(gzipSync(Buffer.from('x')))).toBe(10);
    const named = Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 3]), Buffer.from('nom.json\0'), Buffer.from([1, 2, 3])]);
    expect(gzipHeaderLength(named)).toBe(19);
    expect(gzipHeaderLength(Buffer.from([0x1f, 0x8b, 8]))).toBeNull();
    expect(() => gzipHeaderLength(Buffer.from('pas un gzip'))).toThrow(/gzip invalide/);
  });

  it('archive lisible (JSZip), contenu identique, manifeste et rapport en tête, index d’intégrité ajouté ; aucune recompression (octets DEFLATE copiés)', async () => {
    const at = storedAttempt(content);
    const fs = fakeStorage(at.objects);
    const integ = { bytes: Buffer.byteLength(content['integrite.json']), compressedBytes: at.objects.get('p/a1/integrite.json.gz')!.length, sha256: sha(content['integrite.json']) };
    const entries = archiveOrder(at.index, at.prefix, integ);
    expect(entries.map((e) => e.path)).toEqual(['manifeste.json', 'rapport.txt', 'integrite.json', 'SHA256SUMS.txt', 'donnees/x/table.json', 'tracabilite/vide.json']);
    const { zip, r } = await collect(fs.storage, entries);
    expect(r).toMatchObject({ entries: 6, zip64: false, bytes: zip.length });
    const z = await JSZip.loadAsync(zip);
    for (const [p, c] of Object.entries(content)) expect(await z.file(p)!.async('string'), p).toBe(c);
    // Les octets compressés de l'archive SONT ceux du gzip stocké (en-tête et fin retirés).
    const gz = at.objects.get('p/a1/donnees/x/table.json.gz')!;
    expect(zip.includes(gz.subarray(10, gz.length - 8))).toBe(true);
    // Vérification intégrale : OK.
    fs.objects.set('arch.zip', zip);
    const ok = await verifyStoredArchive(fs.storage as never, 'arch.zip', entries, zip.length);
    expect(ok).toMatchObject({ ok: true, entries: 6 });
  });

  it('vérification : archive altérée, tronquée ou mal dimensionnée → problèmes explicites (jamais COMPLETE)', async () => {
    const at = storedAttempt(content);
    const fs = fakeStorage(at.objects);
    const integ = { bytes: Buffer.byteLength(content['integrite.json']), compressedBytes: at.objects.get('p/a1/integrite.json.gz')!.length, sha256: sha(content['integrite.json']) };
    const entries = archiveOrder(at.index, at.prefix, integ);
    const { zip } = await collect(fs.storage, entries);
    const bad = Buffer.from(zip);
    const pos = bad.indexOf(at.objects.get('p/a1/donnees/x/table.json.gz')!.subarray(30, 40));
    bad[pos] ^= 0xff;
    fs.objects.set('bad.zip', bad);
    expect((await verifyStoredArchive(fs.storage as never, 'bad.zip', entries, bad.length).catch((e) => ({ ok: false, problems: [String(e)] }))).ok).toBe(false);
    fs.objects.set('short.zip', zip.subarray(0, zip.length - 30));
    expect((await verifyStoredArchive(fs.storage as never, 'short.zip', entries, zip.length).catch((e) => ({ ok: false, problems: [String(e)] }))).ok).toBe(false);
    fs.objects.set('ok.zip', zip);
    const wrongIndex = entries.map((e) => (e.path === 'rapport.txt' ? { ...e, sha256: 'f'.repeat(64) } : e));
    const r = await verifyStoredArchive(fs.storage as never, 'ok.zip', wrongIndex, zip.length);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/rapport\.txt : SHA-256 différent/);
  });

  it('taille de l’index différente du gzip stocké → refus d’assembler', async () => {
    const at = storedAttempt({ 'a.json': '[1,2,3]', 'integrite.json': '{}' });
    at.index.files[0].bytes = 999;
    await expect(collect(fakeStorage(at.objects).storage, archiveOrder(at.index, at.prefix, null))).rejects.toThrow(/taille de l'index/);
  });

  it('ZIP64 quand nécessaire (plus de 65 535 entrées) : lisible, nombre d’entrées exact', async () => {
    const chunks: Buffer[] = [];
    const w = createZipWriter(async (c) => { chunks.push(Buffer.from(c)); }, new Date('2026-11-06T00:00:00Z'));
    const empty = deflateRawSync(Buffer.alloc(0));
    for (let i = 0; i < 65_540; i++) await w.add(`f/${i}.json`, { crc: 0, comp: empty.length, size: 0 }, [empty]);
    const r = await w.finish();
    expect(r).toMatchObject({ entries: 65_540, zip64: true });
    const z = await JSZip.loadAsync(Buffer.concat(chunks));
    expect(Object.values(z.files).filter((f) => !f.dir)).toHaveLength(65_540);
  }, 120_000);

  it('nom d’objet de l’archive sûr', () => {
    expect(archiveObjectName('verebona-diagnostic compte #13.zip')).toBe('verebona-diagnostic_compte_13.zip');
    expect(archiveObjectName('x')).toBe('x.zip');
  });
});

describe('L113Q — relance automatique explicite (MEMORY_GUARD) et étapes réelles', () => {
  it('MEMORY_GUARD n’est pas transitoire : FAILED sans relance automatique, dit au BO', () => {
    expect(isTransientError('MEMORY_GUARD')).toBe(false);
    const r = retryPolicy({ status: 'FAILED', errorCode: 'MEMORY_GUARD', attempt: 1, maxAttempts: 3 });
    expect(r.state).toBe('NOT_TRANSIENT');
    expect(r.label).toMatch(/^Aucune relance automatique : la cause MEMORY_GUARD n’est pas transitoire/);
  });
  it('cause transitoire : relance prévue (tentative suivante) puis épuisée', () => {
    expect(retryPolicy({ status: 'QUEUED', errorCode: 'STORAGE_UPLOAD_FAILED', attempt: 1, maxAttempts: 3, nextAttemptAt: '2026-11-06T19:00:00Z' })).toMatchObject({ state: 'SCHEDULED', label: expect.stringMatching(/tentative 2 sur 3/) });
    expect(retryPolicy({ status: 'FAILED', errorCode: 'STORAGE_UPLOAD_FAILED', attempt: 3, maxAttempts: 3 }).state).toBe('EXHAUSTED');
    expect(retryPolicy({ status: 'FAILED', errorCode: 'WORKER_LOST_MAX_ATTEMPTS', attempt: 3, maxAttempts: 3 }).state).toBe('EXHAUSTED');
    expect(retryPolicy({ status: 'COMPLETE', errorCode: null, attempt: 1, maxAttempts: 3 }).state).toBe('NOT_APPLICABLE');
  });
  it('étapes : assemblage et vérification du ZIP avant publication ; code ARCHIVE_FAILED non transitoire', () => {
    expect(DIAG_JOB_PHASES.indexOf('ASSEMBLAGE_ZIP')).toBeGreaterThan(DIAG_JOB_PHASES.indexOf('VALIDATION'));
    expect(DIAG_JOB_PHASES.indexOf('VERIFICATION_ZIP')).toBeLessThan(DIAG_JOB_PHASES.indexOf('PUBLICATION'));
    expect(DIAG_JOB_PHASE_LABELS.ASSEMBLAGE_ZIP).toMatch(/sans recompression/);
    expect(DIAG_JOB_ERROR_LABELS.ARCHIVE_FAILED).toMatch(/NON publié/);
    expect(isTransientError('ARCHIVE_FAILED')).toBe(false);
  });
  it('profilage d’une tentative arrêtée : durées figées, plus aucune étape « en cours »', () => {
    let t = 0;
    const p = createPhaseProfiler({ attempt: 1, lane: 'main', now: () => t });
    p.enter('TRACABILITE'); t = 5000;
    expect(p.snapshot().current).toMatchObject({ phase: 'TRACABILITE' });
    const closed = p.snapshot(undefined, { ended: { status: 'FAILED', code: 'MEMORY_GUARD', phase: 'TRACABILITE', at: 'x' } });
    expect(closed.current).toBeNull();
    expect(closed.ended).toMatchObject({ code: 'MEMORY_GUARD' });
    expect(closed.phases.TRACABILITE).toBe(5000);
  });
  it('une génération à la fois par processus (DIAG_JOB_PROCESS_CONCURRENCY, défaut 1, au plus 2)', () => {
    expect(diagJobSettings({}).processConcurrency).toBe(1);
    expect(diagJobSettings({ DIAG_JOB_PROCESS_CONCURRENCY: '2' }).processConcurrency).toBe(2);
    expect(diagJobSettings({ DIAG_JOB_PROCESS_CONCURRENCY: '9' }).processConcurrency).toBe(2);
    expect(diagJobSettings({ DIAG_JOB_PROCESS_CONCURRENCY: '0' }).processConcurrency).toBe(1);
  });
});

describe('L113Q — mesures mémoire par étape et par fichier', () => {
  it('pic par étape, fichiers au pic le plus haut et à la plus forte croissance, fichier en cours à l’arrêt', () => {
    const m = createMemoryRecorder();
    const pt = (rss: number, heap = 10) => ({ rssMb: rss, heapUsedMb: heap, externalMb: 1, arrayBuffersMb: 0 });
    m.sample('PLANIFICATION', pt(200));
    m.fileStart('donnees/a.json', 'EXTRACTION', pt(210), 0);
    m.sample('EXTRACTION', pt(260, 90));
    m.fileEnd(pt(215), 1000, 50);
    m.fileStart('tracabilite/proprietes.json', 'TRACABILITE', pt(220), 60);
    m.sample('TRACABILITE', pt(870, 600));
    expect(m.current()).toMatchObject({ path: 'tracabilite/proprietes.json', startRssMb: 220, peakRssMb: 870, peakHeapMb: 600 });
    const s = m.snapshot();
    expect(s.initial?.rssMb).toBe(200);
    expect(s.peak).toMatchObject({ rssMb: 870, heapUsedMb: 600 });
    expect(s.byPhase.EXTRACTION.rssMb).toBe(260);
    expect(s.files[0]).toMatchObject({ path: 'donnees/a.json', peakRssMb: 260, endRssMb: 215, ms: 50 });
    const line = memoryLogLine(s, { initialRssMb: 200, peakRssMb: 870 } as never);
    expect(line.byPhase).toMatchObject({ TRACABILITE: '870/600/1/0' });
    expect(memPoint({ rss: 3 * 1024 * 1024, heapUsed: 1024 * 1024, external: 0, arrayBuffers: 0 })).toMatchObject({ rssMb: 3, heapUsedMb: 1 });
  });
});

describe('L113Q — lots bornés en octets (session de lecture)', () => {
  it('premier aller-retour court (sonde), puis lignes adaptées à la taille mesurée, jamais 0, jamais plus que le lot', () => {
    expect(nextFetchRows(500, 8 * 1024 * 1024, 0, 0)).toBe(32);
    expect(nextFetchRows(500, 8 * 1024 * 1024, 32, 32 * 100)).toBe(500);
    expect(nextFetchRows(500, 8 * 1024 * 1024, 32, 32 * 1024 * 1024)).toBe(8);
    expect(nextFetchRows(500, 8 * 1024 * 1024, 1, 20 * 1024 * 1024)).toBe(1);
  });
  it('taille d’une ligne : texte exact, JSON décodé estimé ; borne réglable DIAG_EXPORT_BATCH_BYTES (bornée)', () => {
    expect(rowBytes({ r: 'x'.repeat(1000) })).toBe(1000);
    expect(rowBytes({ a: 1, b: { c: 1 } })).toBe(8 + 256);
    expect(exportBatchBytes({})).toBe(8 * 1024 * 1024);
    expect(exportBatchBytes({ DIAG_EXPORT_BATCH_BYTES: String(2 * 1024 * 1024) })).toBe(2 * 1024 * 1024);
    expect(exportBatchBytes({ DIAG_EXPORT_BATCH_BYTES: '10' })).toBe(8 * 1024 * 1024);
  });
});

describe('L113Q — sérialisation progressive identique et lectures mémorisées', () => {
  it('writeMaskedJson = JSON.stringify(masque(v), null, 2), octet pour octet (clés sensibles, lignes sensibles, dates, tableaux vides)', async () => {
    const { isSensitiveCanonicalKey } = await import('@/services/admin/account-data/dossier');
    const M = (v: unknown) => maskForExport(v, { isSensitiveKey: isSensitiveCanonicalKey });
    const value = {
      version: 'v1', vide: [], objetVide: {}, date: new Date('2026-11-06T18:58:53Z'), indefini: undefined,
      comptes: [
        { compte: 13, documents: [{ id: 1, field_key: 'insuranceContractNumber', value_json: 'AB-123', excerpt: 'contrat AB-123', meta: { a: [1, 2, { b: null }] } }, { id: 2, field_key: 'brand', value_json: 'Atlantic', password: 'secret-pw' }] },
        { compte: 14, documents: [], notes: 'écrire à jean.dupont@example.com', insuranceContractNumber: 'XYZ' },
      ],
    };
    let out = '';
    await writeMaskedJson(async (c) => { out += c; }, value, M, { chunkChars: 16 });
    expect(out).toBe(JSON.stringify(M(value), null, 2));
    let padded = '';
    await writeMaskedJson(async (c) => { padded += c; }, [{ a: 1 }], M, { pad: '  ' });
    expect(padded).toBe(JSON.stringify(M([{ a: 1 }]), null, 2).replace(/\n/g, '\n  '));
  });
  it('memoQuery : même requête relue une fois, copie neuve à chaque lecture, oubli au-delà de la borne', async () => {
    let calls = 0;
    const q = memoQuery(async (_sql, p = []) => { calls++; return [{ id: p[0], v: 'x'.repeat(100) }]; }, { maxBytes: 1000 });
    const a = await q('SELECT 1', [1]);
    (a[0] as Row).v = 'modifié';
    const b = await q('SELECT 1', [1]);
    expect((b[0] as Row).v).toBe('x'.repeat(100));
    expect(calls).toBe(1);
    for (let i = 2; i < 20; i++) await q('SELECT 1', [i]);
    expect(q.stats.evicted).toBeGreaterThan(0);
    expect(q.stats.bytes).toBeLessThanOrEqual(1000);
    expect(q.stats.hits).toBe(1);
  });
});

describe('L113Q — traçabilité des propriétés par références', () => {
  it('ordre des clés = PostgreSQL COLLATE "C" (octets UTF-8)', () => {
    expect(['ASSET#2|b', 'ASSET#10|a', 'ASSET#2|B', 'EQUIPMENT#1|x'].sort(compareKeys)).toEqual(['ASSET#10|a', 'ASSET#2|B', 'ASSET#2|b', 'EQUIPMENT#1|x']);
    expect(compareKeys('a', 'a\u{1F600}')).toBeLessThan(0);
  });
  it('parties de biens : DIAG_PROPERTY_ASSETS_PER_PART (1 à 5 000, défaut 200)', () => {
    expect(propertyAssetsPerPart({})).toBe(200);
    expect(propertyAssetsPerPart({ DIAG_PROPERTY_ASSETS_PER_PART: '50' })).toBe(50);
    expect(propertyAssetsPerPart({ DIAG_PROPERTY_ASSETS_PER_PART: '0' })).toBe(200);
  });
  it('chaîne développée : références remplacées par les lignes détaillées, rapports T3 et travaux du bien rattachés une fois', () => {
    const idx = indexPropertyDetails({
      preuves: [{ compte: 1, bien: 7, id: 11, field_key: 'x', document: 5, page: 2 }],
      decisions: [{ compte: 1, bien: 7, id: 21, field_key: 'x', run_id: 3 }],
      lignesRapports: [{ compte: 1, report_id: 31, seq: 1, write_result: 'WRITTEN', reason_code: 'OK', reason: 'écrit' }],
      documents: [{ compte: 1, id: 5, retained_title: 'Facture' }],
      rapports: [{ compte: 1, bien: 7, id: 30, traitement: 'T1' }, { compte: 1, bien: 7, id: 31, traitement: 'T3' }],
      biens: [{ bien: 7, compte: 1, rapportsT3: [31], jobs: [9] }],
    });
    const e = expandPropertyChain({
      bien: 7, cible: 'ASSET#7', champ: 'x', verdict: 'COHERENT',
      refs: { ecritures: [], ecrituresRapport: [{ rapport: 31, seq: 1 }], misesAJourIA: [], decisions: [{ id: 21, ecrituresCorrelees: [], resultatRapport: [{ rapport: 31, seq: 1 }] }],
        conflits: [], reprisesProprieteManquante: [], preuves: [11], faits: [], extractions: [], documents: [5, 6], documentsIntrouvables: [6], rapports: [30] },
    }, idx);
    expect(e.preuves).toEqual([{ id: 11, field_key: 'x', document: 5, page: 2 }]);
    expect((e.decisions as Row[])[0]).toMatchObject({ id: 21, resultatRapport: [{ rapport: 31, seq: 1, ecriture: 'WRITTEN', motif: 'OK', detail: 'écrit' }] });
    expect(e.documents).toEqual([{ id: 5, retained_title: 'Facture' }, { id: 6, motif: 'document absent du compte (supprimé définitivement ?)' }]);
    expect(e.traitements).toEqual({ rapports: [{ id: 30, traitement: 'T1' }, { id: 31, traitement: 'T3' }], jobs: [9] });
    expect(e).not.toHaveProperty('refs');
  });
});

describe('L113Q — processus dédié aux diagnostics (Procfile diagworker)', () => {
  it('défaut : les diagnostics suivent les traitements de fond (comportement d’avant)', () => {
    expect(runsDiagnosticJobs({})).toBe(true);
    expect(runsDiagnosticJobs({ APP_PROCESS_TYPE: 'web', BACKGROUND_JOBS_PROCESS: 'worker' })).toBe(false);
    expect(runsDiagnosticJobs({ APP_PROCESS_TYPE: 'worker', BACKGROUND_JOBS_PROCESS: 'worker' })).toBe(true);
    expect(diagnosticsPlacement({})).toBe('web');
  });
  it('DIAG_JOB_PROCESS=diagworker : seul le processus dédié prend les diagnostics, et rien d’autre', () => {
    const env = { DIAG_JOB_PROCESS: 'diagworker' };
    expect(runsDiagnosticJobs({ ...env, APP_PROCESS_TYPE: 'web' })).toBe(false);
    expect(runsDiagnosticJobs({ ...env, APP_PROCESS_TYPE: 'worker', BACKGROUND_JOBS_PROCESS: 'worker' })).toBe(false);
    expect(runsDiagnosticJobs({ ...env, APP_PROCESS_TYPE: 'diagworker' })).toBe(true);
    expect(runsBackgroundJobs({ ...env, APP_PROCESS_TYPE: 'diagworker' })).toBe(false);
    expect(processType({ CONTAINER: 'diagworker-1' })).toBe('diagworker');
    expect(processRoleSummary({ ...env, CONTAINER: 'diagworker-1' })).toMatchObject({ process: 'diagworker', diagnostics: true, backgroundJobs: false, diagnosticsPlacement: 'diagworker' });
  });
  it('lanceur : diagworker en veille sans la variable, serveur local avec', () => {
    expect(planLaunch({ processType: 'diagworker', env: {} })).toMatchObject({ mode: 'idle' });
    const p = planLaunch({ processType: 'diagworker', env: { DIAG_JOB_PROCESS: 'diagworker', CONTAINER_MEMORY: String(1024 ** 3) } });
    expect(p).toMatchObject({ mode: 'next', nextArgs: ['start', '-H', '127.0.0.1', '-p', '3000'] });
    expect(p.env.APP_PROCESS_TYPE).toBe('diagworker');
  });
});
