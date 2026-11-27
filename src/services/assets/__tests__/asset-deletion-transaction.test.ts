/**
 * deleteAssetCompletely : les objets de stockage (fichiers, versions, exports,
 * vignette) sont mis en file de purge DANS la transaction et AVANT la
 * suppression du bien, dont la cascade efface les références.
 *
 * Carte #849 — test réécrit sur la nouvelle implémentation (plan unique
 * `asset-deletion-plan`, SQL dans la transaction) : l'ancien test simulait la
 * chaîne Drizzle `select().from().where()` de l'implémentation remplacée. Les
 * invariants sont CONSERVÉS (purge programmée avant la suppression du bien,
 * clés dédoublonnées, `temp` et clés encore référencées exclues, clé
 * étrangère `asset_transmissions` libérée, bien supprimé en dernier) ; sont
 * ajoutés : verrou de la ligne, empreinte d'inventaire exigée, bien déjà
 * supprimé, éléments partagés détachés et non purgés.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();
const ops: string[] = [];
let lignes: Record<string, unknown[]> = {};
let plan: Record<string, unknown> | null = null;

vi.mock('@/db', () => {
  const tx = {
    execute: async (q: never) => {
      const { sql: texte, params } = dialect.sqlToQuery(q);
      const t = texte.replace(/\s+/g, ' ').trim();
      ops.push(t);
      for (const [motif, res] of Object.entries(lignes)) if (t.includes(motif)) return typeof res === 'function' ? (res as (p: unknown[]) => unknown)(params) : res;
      return [];
    },
    delete: () => ({ where: async () => { ops.push('DELETE FROM assets'); } }),
  };
  return { db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx), execute: tx.execute } };
});
vi.mock('@/lib/s3-config', () => ({ isS3Configured: () => false, getS3Bucket: () => null }));
vi.mock('../asset-deletion-plan', async (o) => ({
  ...(await o<object>()),
  planAssetDeletion: async () => plan,
}));
vi.mock('@/services/business-operations/asset-lifecycle', () => ({
  retireDeletedAssetFromOperationsInTx: async () => { ops.push('retire-operations'); return { events: [] }; },
  supersedeDeletedAssetComponentsInTx: async () => { ops.push('supersede-components'); return []; },
  deleteExclusiveOperationsInTx: async () => { ops.push('delete-operations'); return 0; },
}));
vi.mock('@/services/business-operations/events', () => ({ publishBusinessOperationEvents: async () => undefined }));

const { deleteAssetCompletely, AssetDeletionInventoryChangedError } = await import('../asset-deletion.service');
const { deletionPlanFingerprint } = await import('../asset-deletion-plan');

const planVide = (over: Record<string, unknown> = {}) => ({
  assetId: 5, accountId: 1,
  exclusiveFileIds: [], sharedFiles: [], documentFileIds: [], versionIds: [], photoIds: [], substructureIds: [], equipmentIds: [],
  exclusiveDeadlineIds: [], sharedDeadlineIds: [], exclusiveEventIds: [], sharedEventIds: [],
  exclusiveAgendaItemIds: [], sharedAgendaItemIds: [], exclusiveOperationIds: [], sharedOperationIds: [],
  expenseComponentIds: [], sharedOperationExpenseIds: [], exportIds: [],
  ...over,
});
const insertions = () => ops.filter((o) => o.startsWith('INSERT INTO pending_blob_deletions'));
const indexDe = (debut: string) => ops.findIndex((o) => o.startsWith(debut));

beforeEach(() => {
  ops.length = 0;
  lignes = { 'FOR UPDATE': [{ id: 5, account_id: 1, thumbnail_url: null }] };
  plan = planVide();
});

describe('deleteAssetCompletely', () => {
  it('programme la purge des objets EXCLUSIFS puis supprime le bien en dernier', async () => {
    plan = planVide({ exclusiveFileIds: [1, 2, 3, 4], versionIds: [9], sharedFiles: [{ id: 6, newAssetId: 8 }] });
    lignes = {
      'FOR UPDATE': [{ id: 5, account_id: 1, thumbnail_url: null }],
      'SELECT s3_key FROM asset_files WHERE id = ANY': [{ s3_key: 'f/1.pdf' }, { s3_key: 'temp' }, { s3_key: 'f/shared.pdf' }, { s3_key: null }],
      'SELECT s3_key FROM document_versions WHERE id = ANY': [{ s3_key: 'f/1.v1.pdf' }],
      'SELECT output_payload FROM export_generation': [{ output_payload: JSON.stringify({ pdfS3Key: 'exports/1/5/9/x.pdf' }) }],
      // Garde-fou : f/shared.pdf encore référencé par un fichier qui SURVIT ; la version déjà en file.
      'SELECT s3_key AS k FROM asset_files': [{ k: 'f/shared.pdf' }],
      'SELECT storage_path AS k FROM pending_blob_deletions': [{ k: 'f/1.v1.pdf' }],
    };
    const result = await deleteAssetCompletely({ id: 5, thumbnailUrl: 'verebona/u_1/a_5/thumbnail/t.webp' });

    expect(result.blobsScheduled).toBe(3);
    expect(insertions()).toHaveLength(3);
    expect(result.fileIds).toEqual([1, 2, 3, 4]);
    expect(result.rehomedToAssetIds).toEqual([8]);
    expect(ops[0]).toMatch(/FOR UPDATE$/);
    const supprBien = indexDe('DELETE FROM assets');
    expect(supprBien).toBe(ops.length - 1);
    for (const i of insertions().map((x) => ops.indexOf(x))) expect(i).toBeLessThan(supprBien);
    expect(indexDe('UPDATE asset_transmissions SET duplicated_asset_id = NULL')).toBeGreaterThan(-1);
    // Partagé : détaché (confié à l'autre bien) AVANT toute suppression ; exclusifs supprimés explicitement.
    expect(indexDe('UPDATE asset_files f SET')).toBeGreaterThan(-1);
    expect(indexDe('UPDATE asset_files f SET')).toBeLessThan(indexDe('DELETE FROM asset_files'));
    expect(indexDe('DELETE FROM asset_files')).toBeLessThan(supprBien);
    expect(ops.indexOf('supersede-components')).toBeLessThan(ops.indexOf('retire-operations'));
    expect(ops.indexOf('retire-operations')).toBeLessThan(ops.indexOf('delete-operations'));
    expect(ops.indexOf('delete-operations')).toBeLessThan(supprBien);
  });

  it('bien sans fichier : aucune programmation, le bien est supprimé', async () => {
    const result = await deleteAssetCompletely({ id: 6, thumbnailUrl: null });
    expect(result.blobsScheduled).toBe(0);
    expect(insertions()).toEqual([]);
    expect(indexDe('DELETE FROM assets')).toBe(ops.length - 1);
  });

  it('#849 : empreinte de l’inventaire différente → rien n’est écrit, erreur dédiée', async () => {
    plan = planVide({ exclusiveFileIds: [1] });
    await expect(deleteAssetCompletely({ id: 5 }, { expectedFingerprint: 'perimee' })).rejects.toBeInstanceOf(AssetDeletionInventoryChangedError);
    expect(ops.filter((o) => /^(INSERT|UPDATE|DELETE)/.test(o))).toEqual([]);
  });

  it('#849 : empreinte identique → suppression ; bien déjà supprimé (double clic) → rien', async () => {
    plan = planVide({ exclusiveFileIds: [1] });
    const fp = deletionPlanFingerprint(plan as never);
    const ok = await deleteAssetCompletely({ id: 5 }, { expectedFingerprint: fp });
    expect(ok.alreadyDeleted).toBeUndefined();
    ops.length = 0;
    lignes = {};
    const deja = await deleteAssetCompletely({ id: 5 }, { expectedFingerprint: fp });
    expect(deja).toMatchObject({ alreadyDeleted: true, blobsScheduled: 0 });
    expect(ops.filter((o) => /^(INSERT|UPDATE|DELETE)/.test(o))).toEqual([]);
  });
});
