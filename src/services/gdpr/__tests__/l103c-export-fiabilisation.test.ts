/**
 * Lot 103C — fiabilisation de l'export RGPD « Mes données » (ticket P1,
 * recette iOS du 31/10/2026) : règles pures et gardes statiques.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GDPR_EXPORT_ERROR_CODES, gdprExportView, maxAttempts, parseClientRequestKey, requestErrorMessage,
  retryDelaySeconds, shortReference, supportAfterFailures,
} from '../export-state';
import {
  CHILD_SCOPED_TABLES, PERSONAL_TABLES, buildFinalManifest, completenessOf, filterRow, finalReadme, partManifestFromFiles,
  type MissingItem,
} from '../export-content';
import { gdprSupervisionCondition, type GdprIssueRow } from '../gdpr-export-supervision';

const read = (p: string) => readFileSync(resolve(__dirname, '../../../..', p), 'utf8');
const NOW = new Date('2033-03-04T10:00:00Z');

describe('L103C-F — état unique présenté à l’utilisateur', () => {
  it('aucune demande → bouton « Exporter mes données »', () => {
    expect(gdprExportView(null)).toMatchObject({ kind: 'none', canRequest: true, requestLabel: 'Exporter mes données' });
  });
  it('en file / en cours / nouvelle tentative programmée → en cours, pas de bouton', () => {
    for (const status of ['pending', 'generating']) {
      expect(gdprExportView({ status }, { now: NOW })).toMatchObject({ kind: 'in_progress', canRequest: false });
    }
    const v = gdprExportView({ status: 'pending', nextAttemptAt: '2033-03-04T10:05:00Z' }, { now: NOW });
    expect(v.message).toMatch(/nouvelle tentative automatique/);
  });
  it('prête complète / partielle / expirée', () => {
    expect(gdprExportView({ status: 'ready', completeness: 'complete', expiresAt: '2033-03-05T00:00:00Z' }, { now: NOW }).kind).toBe('ready');
    const p = gdprExportView({ status: 'ready', completeness: 'partial', missingCount: 2, expiresAt: '2033-03-05T00:00:00Z' }, { now: NOW });
    expect(p).toMatchObject({ kind: 'partial', canRequest: true, requestLabel: 'Relancer pour compléter' });
    expect(p.message).toMatch(/2 élément\(s\)/);
    expect(gdprExportView({ status: 'ready', expiresAt: '2033-03-04T09:00:00Z' }, { now: NOW }).kind).toBe('expired');
    expect(gdprExportView({ status: 'expired' }, { now: NOW }).kind).toBe('expired');
  });
  it('échec : relance possible avec référence ; échecs répétés → assistance, sans bouton', () => {
    const corr = 'ab93f228-75d8-4031-9916-9a1c68aab905';
    const v = gdprExportView({ status: 'error', errorCode: 'STORAGE_UNAVAILABLE', correlationId: corr }, { consecutiveFailures: 1 });
    expect(v).toMatchObject({ kind: 'interrupted', canRequest: true, reference: 'AB93F228', errorCode: 'STORAGE_UNAVAILABLE' });
    expect(v.message).not.toMatch(/STORAGE|S3|stockage/);
    const s = gdprExportView({ status: 'error', correlationId: corr }, { consecutiveFailures: supportAfterFailures({}) });
    expect(s).toMatchObject({ kind: 'needs_support', canRequest: false, requestLabel: null });
    expect(s.message).toMatch(/AB93F228/);
  });
  it('codes d’erreur stables', () => {
    expect([...GDPR_EXPORT_ERROR_CODES]).toEqual([
      'GENERATION_INTERRUPTED', 'GENERATION_TIMEOUT', 'COLLECTION_FAILED', 'STORAGE_UNAVAILABLE', 'ARCHIVE_FAILED', 'GENERATION_FAILED',
    ]);
    expect(shortReference(null)).toBeNull();
  });
});

describe('L103C-C — message d’une demande en échec (cause réelle, jamais le repli trompeur)', () => {
  it('réponse illisible (page d’erreur non JSON) : « nous vérifions », pas « non enregistrée »', () => {
    for (const code of ['INVALID_RESPONSE', 'UNKNOWN_ERROR']) {
      const m = requestErrorMessage({ status: 502, code });
      expect(m).toMatch(/vérifions si votre demande a bien été reçue/);
      expect(m).not.toMatch(/n’a pas pu être enregistrée/);
    }
  });
  it('refus CSRF, session, mise à jour mobile, réseau : messages distincts', () => {
    expect(requestErrorMessage({ status: 403, code: 'CSRF_ORIGIN_REJECTED', requestId: 'c0ffee00-1111' })).toMatch(/sécurité.*C0FFEE00/);
    expect(requestErrorMessage({ status: 401, code: 'UNAUTHORIZED' })).toMatch(/session a expiré/);
    expect(requestErrorMessage({ status: 426, code: 'APP_UPDATE_REQUIRED' })).toMatch(/mise à jour/);
    expect(requestErrorMessage({ status: 0, code: 'NETWORK_ERROR' })).toMatch(/Connexion interrompue/);
    expect(requestErrorMessage({ status: 500, code: 'GDPR_EXPORT_REQUEST_FAILED', requestId: 'abcdef12-0' })).toMatch(/ABCDEF12/);
  });
  it('clé d’idempotence : absente, valide, invalide', () => {
    expect(parseClientRequestKey(null)).toBeNull();
    expect(parseClientRequestKey('mes-donnees-1234abcd')).toBe('mes-donnees-1234abcd');
    expect(parseClientRequestKey('x')).toBe('invalid');
    expect(parseClientRequestKey('a b c d e f g h')).toBe('invalid');
  });
});

describe('L103C-A — tentatives et délais bornés', () => {
  it('délais croissants plafonnés ; nombre de tentatives borné', () => {
    expect([1, 2, 3, 4, 9].map(retryDelaySeconds)).toEqual([60, 300, 900, 900, 900]);
    expect(maxAttempts({})).toBe(4);
    expect(maxAttempts({ GDPR_EXPORT_MAX_ATTEMPTS: '2' })).toBe(2);
    expect(maxAttempts({ GDPR_EXPORT_MAX_ATTEMPTS: '1000' })).toBe(4);
  });
});

describe('L103C-E — manifeste construit depuis les fichiers réels, COMPLET / PARTIEL', () => {
  const doc = (id: number, part: number) => ({ id, path: `documents/f${id}.pdf`, part, bytes: 40, sha256: 'a'.repeat(64) });
  const base = {
    generatedAt: new Date('2033-01-02T10:00:00Z'), userId: 7, accountIds: [3],
    tables: [{ table: 'assets', rows: 2, omittedColumns: [], file: { path: 'donnees/assets.json', bytes: 10, sha256: 'b'.repeat(64) }, complete: true }],
    excludedTables: ['revoked_tokens'], expectedDocuments: 3, withoutStoredFile: [],
  };
  it('tout présent → COMPLET', () => {
    const m = buildFinalManifest({ ...base, documents: [doc(1, 1), doc(2, 2), doc(3, 2)], missing: [], parts: [{ part: 1, fileName: 'p1.zip', files: [doc(1, 1)] }, { part: 2, fileName: 'p2.zip', files: [doc(2, 2), doc(3, 2)] }] });
    expect(m.status).toBe('COMPLET');
    expect(m.version).toBe(3);
    expect(m.documents.files[0]).toMatchObject({ id: 1, part: 1, bytes: 40 });
    expect(m.parts.map((p) => p.documents)).toEqual([1, 2]);
    expect(m.tables[0]).toMatchObject({ file: 'donnees/assets.json', truncated: false });
  });
  it('un manque (document absent, table tronquée) → PARTIEL, inventaire précis, jamais annoncé comme inclus', () => {
    const missing: MissingItem[] = [
      { kind: 'document', id: 2, name: 'f2.pdf', reason: 'OBJECT_MISSING' },
      { kind: 'table', table: 'notifications', reason: 'ROW_LIMIT' },
    ];
    expect(completenessOf(missing)).toBe('partial');
    const m = buildFinalManifest({ ...base, documents: [doc(1, 1), doc(3, 1)], missing, parts: [{ part: 1, fileName: 'p1.zip', files: [doc(1, 1), doc(3, 1)] }] });
    expect(m.status).toBe('PARTIEL');
    expect(m.documents.files.map((f) => f.id)).toEqual([1, 3]);
    expect(m.documents.skipped).toEqual([{ id: 2, name: 'f2.pdf', reason: 'OBJECT_MISSING' }]);
    const readme = finalReadme(m);
    expect(readme).toMatch(/Statut : PARTIEL/);
    expect(readme).toMatch(/document 2 « f2\.pdf » : fichier introuvable/);
    expect(readme).toMatch(/catégorie « notifications »/);
    const pm = JSON.parse(partManifestFromFiles({ generatedAt: base.generatedAt, part: 1, totalParts: 1, files: [doc(1, 1)], missing: [missing[0]] }));
    expect(pm.documents).toEqual([{ id: 1, path: 'documents/f1.pdf', size: 40, sha256: 'a'.repeat(64) }]);
    expect(pm.manquants).toHaveLength(1);
  });
  it('fiche sans fichier déposé : listée, ne rend pas l’archive partielle', () => {
    const m = buildFinalManifest({ ...base, documents: [], withoutStoredFile: [{ id: 9, name: 'x.pdf' }], missing: [], parts: [{ part: 1, fileName: 'p1.zip', files: [] }] });
    expect(m.status).toBe('COMPLET');
    expect(m.documents.skipped).toEqual([{ id: 9, name: 'x.pdf', reason: 'NO_STORED_FILE' }]);
  });
  it('filtre des colonnes conservé (secrets, stockage)', () => {
    const { out, omitted } = filterRow('users', { id: 1, email: 'a@b.fr', password_hash: 'x', reset_token: 'y', role: 'USER' });
    expect(out).toEqual({ id: 1, email: 'a@b.fr' });
    expect(omitted.sort()).toEqual(['password_hash', 'reset_token', 'role']);
  });
  it('isolation Duo : tables personnelles et filles sans clé déclarée', () => {
    for (const t of ['verebona_conversations', 'mobile_push_installations', 'invoices', 'calendar_additions']) expect(PERSONAL_TABLES.has(t)).toBe(true);
    for (const t of ['assets', 'asset_files', 'deadlines', 'agenda_items']) expect(PERSONAL_TABLES.has(t)).toBe(false);
    expect(CHILD_SCOPED_TABLES.verebona_messages).toEqual({ column: 'conversation_id', parent: 'verebona_conversations', parentColumn: 'id' });
  });
});

describe('L103C-F — Supervision : une anomalie compacte, détail par export', () => {
  const row = (over: Partial<GdprIssueRow>): GdprIssueRow => ({
    kind: 'echec', id: 1, userId: 5, correlationId: 'ab93f228-75d8-4031-9916-9a1c68aab905', status: 'error', errorCode: 'GENERATION_INTERRUPTED',
    step: 'collect', attempts: 4, errorMessage: 'exécution interrompue', createdAt: new Date('2033-01-01T10:00:00Z'),
    startedAt: new Date('2033-01-01T10:00:00Z'), completedAt: new Date('2033-01-01T10:02:00Z'), progressAt: null, nextAttemptAt: null,
    sizeBytes: null, parts: null, missingCount: 0, notified: false, registryPending: false, peakRssMb: 900, ...over,
  });
  it('rien en défaut → aucune anomalie', () => { expect(gdprSupervisionCondition([])).toBeNull(); });
  it('titre compact, détail exploitable sans donnée privée', () => {
    const c = gdprSupervisionCondition([row({}), row({ id: 2, kind: 'partiel', status: 'ready', missingCount: 3 }), row({ id: 3, kind: 'registre', registryPending: true })])!;
    expect(c.title).toBe('Export RGPD « Mes données » : 1 en échec, 1 partielle(s), 1 registre non à jour');
    const e = (c.detail.exports as Array<Record<string, unknown>>)[0];
    expect(e).toMatchObject({ export: 1, reference: 'AB93F228', code: 'GENERATION_INTERRUPTED', etape: 'collect', tentatives: 4, dureeSecondes: 120, picMemoireMo: 900 });
    expect(String(e.reprise)).toMatch(/l’utilisateur peut relancer/);
  });
});

describe('L103C — gardes statiques (architecture)', () => {
  it('le POST enregistre et rend la main : plus de génération dans la requête ni d’`after`', () => {
    const src = read('src/app/api/users/me/gdpr-export/route.ts');
    expect(src).not.toMatch(/runGdprExport|GDPR_EXPORT_IMMEDIATE_MS|\bafter\(/);
    expect(src).toMatch(/requestGdprExport\(userId, \{ clientKey \}\)/);
    expect(src).toMatch(/x-request-id/);
    expect(src).toMatch(/GDPR_EXPORT_API_CODES\.requestFailed/);
  });
  it('la demande est atomique (verrou par utilisateur dans la transaction d’insertion) ; registre hors transaction', () => {
    const src = read('src/services/gdpr/gdpr-export.service.ts');
    expect(src).toMatch(/pgClient\.begin\(async \(tx\) => \{\s*await tx`SELECT pg_advisory_xact_lock/);
    expect(src).toMatch(/registry_pending\)\s*\n\s*VALUES/);
  });
  it('le worker des exports consomme la file RGPD (pas de seconde infrastructure)', () => {
    const w = read('src/services/exports/v12/generation/worker.ts');
    expect(w).toMatch(/drainGdprExportQueue\(EXPORT_WORKER_ID/);
    const job = read('src/services/gdpr/gdpr-export.job.ts');
    expect(job).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(job).toMatch(/locked_by = \$\{workerId\}/);
    expect(read('src/instrumentation-node.ts')).toMatch(/startExportWorker\(\)/);
  });
  it('mémoire bornée : profil S3 worker, flux disque, plus de Buffer d’archive ni de plafond de 20 000 lignes', () => {
    const storage = read('src/services/gdpr/gdpr-storage.ts');
    expect(storage).toMatch(/getS3Client\('worker'\)/);
    expect(storage).not.toMatch(/Buffer\.concat/);
    const job = read('src/services/gdpr/gdpr-export.job.ts');
    expect(job).toMatch(/generateNodeStream/);
    expect(job).not.toMatch(/type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: \{ level: 6 \} \}\)\s*;/);
    expect(job).toMatch(/fs\.promises\.rm\(tmp, \{ recursive: true, force: true \}\)/);
    const collector = read('src/services/gdpr/export-collector.ts');
    expect(collector).not.toMatch(/20_000/);
    expect(collector).not.toMatch(/MAX_DEPTH = 3/);
  });
  it('« Mes données » utilise le client commun (renouvellement de session), jamais fetch direct ; clé d’idempotence', () => {
    const card = read('src/app/(dashboard)/mon-compte/mes-donnees/MyDataCard.tsx');
    expect(card).toMatch(/from '@\/lib\/api-client'/);
    expect(card).not.toMatch(/\bfetch\(ENDPOINT/);
    expect(card).not.toMatch(/credentials: 'include'/);
    expect(card).toMatch(/'Idempotency-Key'/);
    // Un seul message d'alerte : plus la combinaison « dernière archive a échoué » + « demande non enregistrée ».
    expect(card).not.toMatch(/Votre demande n’a pas pu être enregistrée\. Réessayez\./);
  });
  it('gardes de sécurité inchangées : CSRF non assoupli, export hors gardes de lecture seule', () => {
    const csrf = read('src/lib/csrf.ts');
    expect(csrf).not.toMatch(/gdpr-export/);
    for (const p of ['src/app/api/users/me/gdpr-export/route.ts', 'src/app/api/users/me/gdpr-export/download/route.ts']) {
      expect(read(p)).toMatch(/SessionService\.getSession/);
    }
  });
  it('une panne technique ne crée aucune carte « À traiter » ; la Supervision reçoit l’anomalie compacte', () => {
    for (const p of ['src/services/gdpr/gdpr-export.job.ts', 'src/services/gdpr/gdpr-export.service.ts', 'src/services/gdpr/gdpr-export-supervision.ts']) {
      expect(read(p)).not.toMatch(/to-process|to_process/);
    }
    expect(read('src/services/admin/supervision-sweep.service.ts')).toMatch(/gdpr-export-supervision/);
  });
  it('migration 0940 additive et idempotente', () => {
    const m = read('src/db/migrations/0940_l103c_export_rgpd_file_durable.sql');
    expect(m).not.toMatch(/DROP |DELETE |TRUNCATE /i);
    for (const line of m.split('\n').filter((l) => /^ALTER TABLE/.test(l))) expect(line).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(read('src/db/migrations/0940_l103c_export_rgpd_file_durable_idx_1.sql')).toMatch(/CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS/);
  });
});
