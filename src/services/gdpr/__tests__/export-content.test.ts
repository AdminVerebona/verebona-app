/**
 * Contenu de l'export « Mes données » (CDC BO GDP-020) — filtre pur testé
 * sur des données simulées : ce qui sort, ce qui ne sort jamais.
 */
import { describe, it, expect } from 'vitest';
import {
  buildGdprExportContent,
  isColumnExported,
  planDocumentFiles,
  toJsonValue,
  type DocumentCandidate,
} from '../export-content';

const GENERATED = new Date('2026-09-26T08:00:00Z');

const tables = [
  {
    table: 'users',
    rows: [{
      id: 7, email: 'alice@example.fr', first_name: 'Alice', password_hash: '$2b$10$secret',
      role: 'USER', created_at: new Date('2025-01-02T03:04:05Z'),
    }],
  },
  { table: 'accounts', rows: [{ id: 3, name: 'Maison Alice', owner_user_id: 7, stripe_customer_id: 'cus_1', feature_flags: '{}' }] },
  {
    table: 'assets',
    rows: [
      { id: 11, account_id: 3, name: 'Appartement', estimated_value_cents: BigInt(25_000_000) },
      { id: 12, account_id: 3, name: 'Voiture' },
    ],
  },
  // Même ligne atteinte par deux chemins (user_id puis clé étrangère).
  { table: 'assets', rows: [{ id: 11, account_id: 3, name: 'Appartement', estimated_value_cents: BigInt(25_000_000) }] },
  {
    table: 'asset_files',
    rows: [{ id: 40, account_id: 3, original_filename: 'bail.pdf', s3_key: 'u/7/bail.pdf', s3_bucket: 'b', sha256_hash: 'abc', category_confidence: '0.9' }],
  },
  {
    table: 'gdpr_requests',
    rows: [{ id: 1, right_type: 'access', status: 'in_progress', internal_comment: 'Client insistant', created_by: 99, last_error: 'boom', result: null }],
  },
  { table: 'revoked_tokens', rows: [{ id: 1, user_id: 7, token_hash: 'x' }] },
  { table: 'admin_audit_log', rows: [{ id: 5, target_id: 7, admin_email: 'admin@verebona.fr' }] },
  { table: 'push_subscriptions', rows: [{ id: 2, user_id: 7, endpoint: 'https://push/x', p256dh: 'k', auth: 'a', user_agent: 'Firefox' }] },
  { table: 'notifications', rows: [] },
  { table: 'deadlines', rows: [{ id: 9, account_id: 3, label: 'Assurance', due_date: new Date('2026-10-01T00:00:00Z') }], truncated: true },
];

function build(docs = planDocumentFiles([], 1000)) {
  return buildGdprExportContent({ generatedAt: GENERATED, userId: 7, accountIds: [3], tables, documents: docs });
}

describe('export RGPD — filtre du contenu', () => {
  const { manifest, textFiles } = build();
  const read = (t: string) => JSON.parse(textFiles[`donnees/${t}.json`]);

  it('exporte les données de l’utilisateur et du compte', () => {
    expect(read('users')[0]).toMatchObject({ id: 7, email: 'alice@example.fr', first_name: 'Alice' });
    expect(read('accounts')[0]).toMatchObject({ id: 3, name: 'Maison Alice', stripe_customer_id: 'cus_1' });
    expect(read('assets').map((a: { id: number }) => a.id)).toEqual([11, 12]);
    expect(read('deadlines')).toHaveLength(1);
  });

  it('ne sort jamais les secrets d’authentification', () => {
    expect(read('users')[0]).not.toHaveProperty('password_hash');
    expect(read('push_subscriptions')[0]).toEqual({ id: 2, user_id: 7, user_agent: 'Firefox' });
    expect(textFiles['donnees/revoked_tokens.json']).toBeUndefined();
  });

  it('ne sort ni les journaux internes ni le commentaire interne RGPD (GDP-013)', () => {
    expect(textFiles['donnees/admin_audit_log.json']).toBeUndefined();
    expect(read('gdpr_requests')[0]).toEqual({ id: 1, right_type: 'access', status: 'in_progress', result: null });
    expect(JSON.stringify(textFiles)).not.toContain('Client insistant');
    expect(manifest.excludedTables).toEqual(['admin_audit_log', 'revoked_tokens']);
  });

  it('retire les emplacements de stockage et scores internes, garde les métadonnées', () => {
    expect(read('asset_files')[0]).toEqual({ id: 40, account_id: 3, original_filename: 'bail.pdf' });
    expect(manifest.tables.find((t) => t.table === 'asset_files')?.omittedColumns)
      .toEqual(['category_confidence', 's3_bucket', 's3_key', 'sha256_hash']);
  });

  it('dédoublonne, normalise dates et grands entiers, omet les tables vides', () => {
    expect(read('assets')[0].estimated_value_cents).toBe('25000000');
    expect(read('users')[0].created_at).toBe('2025-01-02T03:04:05.000Z');
    expect(textFiles['donnees/notifications.json']).toBeUndefined();
  });

  it('manifeste et lisez-moi', () => {
    expect(manifest).toMatchObject({ format: 'verebona-gdpr-export', version: 1, subject: { userId: 7, accountIds: [3] } });
    expect(manifest.tables.find((t) => t.table === 'deadlines')?.truncated).toBe(true);
    expect(JSON.parse(textFiles['manifest.json']).generatedAt).toBe('2026-09-26T08:00:00.000Z');
    expect(textFiles['LISEZ-MOI.txt']).toContain('tronquées');
  });
});

describe('export RGPD — documents joints', () => {
  const doc = (id: number, size: number, extra: Partial<DocumentCandidate> = {}): DocumentCandidate => ({
    id, size, originalFilename: `f${id}.pdf`, filename: null, mimeType: 'application/pdf',
    s3Key: `k/${id}`, s3Bucket: null, ...extra,
  });

  it('inclut jusqu’au plafond de taille, liste le reste', () => {
    const plan = planDocumentFiles([doc(3, 400), doc(1, 500), doc(2, 200)], 1000);
    // Ordre des identifiants : 1 (500) + 2 (200) = 700 ; 3 (400) dépasserait 1000.
    expect(plan.include.map((d) => d.id)).toEqual([1, 2]);
    expect(plan.includedBytes).toBe(700);
    expect(plan.skipped).toEqual([{ id: 3, name: 'f3.pdf', reason: 'TOTAL_SIZE_LIMIT' }]);
  });

  it('noms sûrs et uniques ; fichier absent du stockage signalé', () => {
    const plan = planDocumentFiles([doc(5, 1, { originalFilename: '../../etc/passwd' }), doc(6, 1, { s3Key: null })], 1000);
    expect(plan.include[0].path).toBe('documents/5_.._.._etc_passwd');
    expect(plan.skipped).toEqual([{ id: 6, name: 'f6.pdf', reason: 'NO_STORED_FILE' }]);
    const { textFiles, manifest } = build(planDocumentFiles([doc(1, 900), doc(2, 900)], 1000));
    expect(manifest.documents).toMatchObject({ included: 1, includedBytes: 900 });
    expect(textFiles['LISEZ-MOI.txt']).toContain('1 document(s) n’ont pas été joints');
  });
});

describe('règles de colonnes', () => {
  it.each([
    ['users', 'password_hash', false],
    ['users', 'email', true],
    ['withdrawal_requests', 'verification_token', false],
    ['anything', 'api_key', false],
    ['gdpr_requests', 'internal_comment', false],
    ['notes', 'internal_comment', true],
    ['asset_files', 'mime_type', true],
  ])('%s.%s exportée : %s', (t, c, expected) => {
    expect(isColumnExported(t, c)).toBe(expected);
  });

  it('valeurs binaires jamais sérialisées', () => {
    expect(toJsonValue(new Uint8Array([1, 2]))).toBe('[binaire omis]');
    expect(toJsonValue({ a: new Date('invalid') })).toEqual({ a: null });
  });
});
