/**
 * « Déplacer vers l'espace Duo » — lot 74B, point 4 (réponse PO à la
 * question Q1 de l'audit 72D).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE BESOIN
 *
 * Avant le lot 72D, un invité Premium Duo recevait un compte personnel
 * artificiel : il a pu y créer des biens en croyant être dans le Duo. Le
 * lot 72D ne déplace rien automatiquement (décision Q1). Ce module offre
 * l'action VOLONTAIRE, bien par bien : l'utilisateur, membre ACTIF des deux
 * espaces, déplace un bien de l'espace où il se trouve vers l'espace
 * Premium Duo.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLES
 *
 * · Accès : adhésion ACTIVE `owner` ou `member` (account_memberships, relue
 *   en base dans la transaction) au compte du bien ET au compte cible ; le
 *   compte cible est un Premium Duo non archivé, non suspendu. Aucun
 *   identifiant fourni par le client n'accorde de droit : un compte cible
 *   inaccessible et un compte inexistant reçoivent la même réponse.
 * · Transfert COMPLET, dans UNE transaction : Opérations (lot 39,
 *   `transferAssetOperationsInTx`), puis le bien, puis ses données (lot 40,
 *   `transferAssetDataInTx` : documents et dérivés — dont l'index plein
 *   texte, porté par les lignes déplacées —, liens, équipements, pièces,
 *   échéances, événements, agenda, « À traiter », preuves, fournisseurs
 *   sans IBAN, transmissions). Stockage S3 : AUCUN objet à déplacer — les
 *   clés ne dépendent pas du compte (`verebona/u_<déposant>/a_<bien>/…`,
 *   miniatures servies par leur ligne) et l'accès est contrôlé par
 *   `asset_files.account_id`, déplacé. Le quota de stockage est calculé à la
 *   lecture : il passe de fait d'un compte à l'autre.
 * · Ne sont PAS déplacés (propres à une personne ou au compte de départ) :
 *   conversations de l'assistant, préférences de notification, progression
 *   du guide, consommation IA, exports déjà générés.
 * · Quotas du compte CIBLE vérifiés sur l'état APRÈS déplacement, dans la
 *   même transaction, sous le verrou de stockage du compte cible (biens,
 *   documents, stockage, droits d'écriture) : refus explicite, rien n'est
 *   écrit.
 * · Confirmation explicite : l'aperçu (`preview`) exécute réellement le
 *   déplacement puis l'ANNULE — ce qu'il annonce est exactement ce que
 *   l'application fera ; son empreinte doit être renvoyée à l'application
 *   (`confirm` + `fingerprint`) : si la situation a changé entre-temps,
 *   refus `PREVIEW_STALE` avec le nouvel aperçu.
 * · Idempotent : le bien est verrouillé (`FOR UPDATE`) ; rejouée après
 *   succès (double clic, réseau), la demande rend le même déplacement sans
 *   rien écrire.
 * · Journal : une ligne `asset_space_moves` par déplacement (rapport
 *   complet), une entrée `account_audit_log` dans chacun des deux comptes
 *   (historique du BO). Le journal n'est PAS « restaurable » : le transfert
 *   du lot 40 retire des liens entre comptes (documents multi-biens, agenda
 *   multi-biens, sources d'Opération), annule les transmissions en attente
 *   et recopie des fiches fournisseur — un retour arrière automatique ne
 *   rendrait pas l'état d'avant. La traçabilité est complète à la place.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { documentTitleColumnsSql, documentTitleOf, type DocumentTitleColumns } from '@/lib/documents/document-title-source';
import crypto from 'crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import type { DbTx } from '@/services/business-operations/lock';
import { transferAssetOperationsInTx } from '@/services/business-operations/asset-lifecycle';
import { publishBusinessOperationEvents, type BusinessOperationEvent } from '@/services/business-operations/events';
import { afterAssetDataTransfer, transferAssetDataInTx, type AssetDataTransferResult } from './asset-account-transfer.service';
import { getEntitlements, restrictedRefusal } from '@/services/entitlements.service';
import { getAccountStorageUsedBytes, getStorageLimitBytes, storageLockKey, formatStorageSize } from '@/lib/storage-quota';
import { getCommercialPlanForAccount } from '@/services/commercial-model.service';
import { invalidateAccountReadCache } from '@/lib/server-cache';

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: DbTx | typeof db, q: SQL): Promise<T[]> => (await tx.execute(q)) as unknown as T[];
const ints = (l: readonly number[]) => sql`${`{${l.filter((x) => Number.isInteger(x)).join(',')}}`}::int[]`;

export type SpaceRole = 'owner' | 'member';

export interface MoveTarget {
  accountId: number;
  name: string;
  role: SpaceRole;
  /** « Titulaire » / « Membre ». */
  roleLabel: string;
}

export interface MoveDocument { id: number; title: string }

export interface MovePreview {
  assetId: number;
  assetName: string;
  from: { accountId: number; name: string };
  to: { accountId: number; name: string };
  /** Ce qui part avec le bien. */
  moves: {
    documents: MoveDocument[];
    equipments: number;
    rooms: number;
    agendaItems: number;
    events: number;
    deadlines: number;
    operations: number;
    toProcessActions: number;
    suppliersCopied: number;
    suppliersReused: number;
  };
  /** Ce qui reste dans l'espace de départ (lien vers le bien retiré). */
  stays: {
    sharedDocuments: MoveDocument[];
    sharedAgendaItems: number;
    sharedOperations: number;
    pendingTransmissionsCancelled: number;
  };
  /** Jamais déplacé : propre à la personne ou au compte de départ. */
  personal: string[];
  /** Quotas du compte cible APRÈS déplacement. */
  quotas: {
    assets: { used: number; limit: number };
    documents: { used: number; limit: number };
    storage: { usedBytes: number; limitBytes: number };
  };
  fingerprint: string;
}

export type MoveError =
  | 'ASSET_NOT_FOUND'
  | 'MOVE_NOT_ALLOWED'
  | 'SAME_ACCOUNT'
  | 'ASSET_LOCKED'
  | 'TARGET_RESTRICTED'
  | 'ASSET_QUOTA_REACHED'
  | 'DOCUMENT_QUOTA_REACHED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'PREVIEW_STALE';

export const MOVE_ERROR_HTTP_STATUS: Record<MoveError, number> = {
  ASSET_NOT_FOUND: 404,
  MOVE_NOT_ALLOWED: 403,
  SAME_ACCOUNT: 409,
  ASSET_LOCKED: 409,
  TARGET_RESTRICTED: 403,
  ASSET_QUOTA_REACHED: 403,
  DOCUMENT_QUOTA_REACHED: 403,
  STORAGE_QUOTA_EXCEEDED: 413,
  PREVIEW_STALE: 409,
};

export type MoveResult =
  | { ok: true; mode: 'preview'; preview: MovePreview }
  | { ok: true; mode: 'apply'; moveId: number; alreadyMoved: boolean; toAccountId: number; preview: MovePreview | null }
  | { ok: false; error: MoveError; message: string; preview?: MovePreview };

/** Libellés de ce qui ne part jamais (affichés à la confirmation). */
export const PERSONAL_DATA_NOT_MOVED: readonly string[] = [
  'vos conversations avec l’assistant',
  'vos préférences de notification',
  'les exports déjà générés et la consommation d’analyses de l’espace de départ',
];

const MESSAGES: Record<Exclude<MoveError, 'TARGET_RESTRICTED'>, string> = {
  ASSET_NOT_FOUND: 'Ce bien n’existe pas dans votre espace actuel.',
  MOVE_NOT_ALLOWED: 'Ce déplacement est réservé à un membre actif des deux espaces.',
  SAME_ACCOUNT: 'Ce bien est déjà dans cet espace.',
  ASSET_LOCKED: 'Ce bien est verrouillé : il ne peut pas être déplacé pour le moment.',
  ASSET_QUOTA_REACHED: '',
  DOCUMENT_QUOTA_REACHED: '',
  STORAGE_QUOTA_EXCEEDED: '',
  PREVIEW_STALE: 'Le contenu du bien a changé depuis l’aperçu : vérifiez la nouvelle liste avant de confirmer.',
};

// ── Lecture ─────────────────────────────────────────────────────────────────

async function activeRole(runner: DbTx | typeof db, userId: number, accountId: number): Promise<SpaceRole | null> {
  if (!Number.isInteger(accountId) || accountId <= 0) return null;
  const [r] = await rows<{ role: string }>(runner, sql`
    SELECT role FROM account_memberships
     WHERE user_id = ${userId} AND account_id = ${accountId}
       AND status IN ('active', 'ACTIVE') AND role IN ('owner', 'member')
     LIMIT 1`);
  return r ? (r.role as SpaceRole) : null;
}

/** Compte cible admissible : Premium Duo, non archivé, non suspendu. */
const TARGET_SQL = sql`upper(coalesce(a.plan_type, '')) = 'PREMIUM_DUO' AND a.archived_at IS NULL AND a.is_active IS NOT FALSE`;

/**
 * Espaces Duo vers lesquels `userId` peut déplacer un bien de
 * `sourceAccountId` (vide si l'utilisateur n'est pas membre actif de
 * l'espace de départ). Sert à n'afficher l'action qu'aux personnes admises.
 */
export async function listMoveTargets(userId: number, sourceAccountId: number | null | undefined): Promise<MoveTarget[]> {
  if (!sourceAccountId || !(await activeRole(db, userId, sourceAccountId))) return [];
  const r = await rows<{ id: number; name: string; role: string }>(db, sql`
    SELECT a.id, a.name, m.role
      FROM account_memberships m JOIN accounts a ON a.id = m.account_id
     WHERE m.user_id = ${userId} AND m.status IN ('active', 'ACTIVE') AND m.role IN ('owner', 'member')
       AND a.id <> ${sourceAccountId} AND ${TARGET_SQL}
     ORDER BY a.id`);
  return r.map((x) => ({
    accountId: Number(x.id),
    name: String(x.name ?? ''),
    role: x.role as SpaceRole,
    roleLabel: x.role === 'owner' ? 'Titulaire' : 'Membre',
  }));
}

// ── Déplacement ─────────────────────────────────────────────────────────────

class Annulation extends Error {
  constructor(readonly result: MoveResult) { super('rollback'); }
}

/** Lot 87D : titre par la règle unique des vues (liste, fiche, recherche). */
async function titles(tx: DbTx, ids: number[]): Promise<MoveDocument[]> {
  if (!ids.length) return [];
  const r = await rows<{ id: number } & DocumentTitleColumns>(tx, sql`
    SELECT f.id, ${sql.raw(documentTitleColumnsSql('f'))} FROM asset_files f
     WHERE f.id = ANY(${ints(ids)}) AND f.deleted_at IS NULL ORDER BY f.id`);
  return r.map((x) => ({ id: Number(x.id), title: documentTitleOf(x) }));
}

function empreinte(p: {
  to: number; data: AssetDataTransferResult; opsMoved: number[]; opsDetached: number[];
}): string {
  const base = JSON.stringify({
    to: p.to,
    m: p.data.movedFileIds, k: p.data.keptFileIds,
    ag: p.data.movedAgendaItemIds, ad: p.data.detachedAgendaItemIds,
    om: p.opsMoved, od: p.opsDetached,
  });
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 32);
}

export interface MoveRequest {
  userId: number;
  userEmail: string;
  assetId: number;
  /** Compte de la session (le bien doit s'y trouver). */
  sourceAccountId: number;
  targetAccountId: number;
}

/**
 * Aperçu exact (déplacement exécuté puis annulé) : ce qui part, ce qui
 * reste, quotas du compte cible après déplacement, empreinte à confirmer.
 */
export function previewMoveToSpace(p: MoveRequest): Promise<MoveResult> {
  return run(p, { mode: 'preview' });
}

/** Déplacement confirmé (`fingerprint` = empreinte de l'aperçu affiché). */
export function moveAssetToSpace(p: MoveRequest & { fingerprint: string }): Promise<MoveResult> {
  return run(p, { mode: 'apply', fingerprint: p.fingerprint });
}

async function run(p: MoveRequest, o: { mode: 'preview' } | { mode: 'apply'; fingerprint: string }): Promise<MoveResult> {
  if (p.sourceAccountId === p.targetAccountId) return { ok: false, error: 'SAME_ACCOUNT', message: MESSAGES.SAME_ACCOUNT };
  const events: BusinessOperationEvent[] = [];
  let data: AssetDataTransferResult | null = null;
  let result: MoveResult;
  try {
    result = await db.transaction(async (tx) => {
      // 1. Le bien, verrouillé : sérialise deux demandes concurrentes (rejeu).
      const [asset] = await rows<{ id: number; account_id: number | null; name: string; lock_state: string | null; deleted_at: Date | null }>(tx, sql`
        SELECT id, account_id, name, lock_state, deleted_at FROM assets WHERE id = ${p.assetId} FOR UPDATE`);

      // Rejeu après succès : le bien est déjà dans le compte cible, déplacé
      // par cette même personne depuis ce même espace.
      if (asset && Number(asset.account_id) === p.targetAccountId && o.mode === 'apply') {
        const [deja] = await rows<{ id: number }>(tx, sql`
          SELECT id FROM asset_space_moves
           WHERE asset_id = ${p.assetId} AND from_account_id = ${p.sourceAccountId} AND to_account_id = ${p.targetAccountId}
             AND user_id = ${p.userId}
           ORDER BY id DESC LIMIT 1`);
        if (deja && (await activeRole(tx, p.userId, p.targetAccountId))) {
          return { ok: true, mode: 'apply', moveId: Number(deja.id), alreadyMoved: true, toAccountId: p.targetAccountId, preview: null } as MoveResult;
        }
      }
      if (!asset || asset.deleted_at || Number(asset.account_id) !== p.sourceAccountId) {
        return { ok: false, error: 'ASSET_NOT_FOUND', message: MESSAGES.ASSET_NOT_FOUND } as MoveResult;
      }

      // 2. Membre ACTIF des deux espaces ; cible = Premium Duo admissible.
      const roleSource = await activeRole(tx, p.userId, p.sourceAccountId);
      const roleCible = await activeRole(tx, p.userId, p.targetAccountId);
      const [cible] = await rows<{ id: number; name: string }>(tx, sql`
        SELECT a.id, a.name FROM accounts a WHERE a.id = ${p.targetAccountId} AND ${TARGET_SQL} FOR UPDATE`);
      if (!roleSource || !roleCible || !cible) {
        return { ok: false, error: 'MOVE_NOT_ALLOWED', message: MESSAGES.MOVE_NOT_ALLOWED } as MoveResult;
      }
      if (asset.lock_state && asset.lock_state !== 'NONE') {
        return { ok: false, error: 'ASSET_LOCKED', message: MESSAGES.ASSET_LOCKED } as MoveResult;
      }
      const [source] = await rows<{ name: string }>(tx, sql`SELECT name FROM accounts WHERE id = ${p.sourceAccountId}`);

      // 3. Droits d'écriture du compte cible (impayé, résilié… : refus).
      const ent = await getEntitlements(p.targetAccountId);
      if (!ent.canWrite) {
        const r = await restrictedRefusal(p.targetAccountId, ent.status);
        return { ok: false, error: 'TARGET_RESTRICTED', message: `L’espace « ${cible.name} » ne permet pas d’ajouter de bien : ${r.message}` } as MoveResult;
      }
      // Dépôts du compte cible sérialisés avec ce contrôle (même verrou que
      // la confirmation d'un téléversement, `lib/storage-quota.ts`).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${storageLockKey(p.targetAccountId)}))`);

      // 4. Transfert complet (ordre de `duo.service.ts › transferAsset`).
      const ops = await transferAssetOperationsInTx(
        tx,
        { assetId: p.assetId, fromAccountId: p.sourceAccountId, toAccountId: p.targetAccountId, reasonCode: 'ASSET_MOVED_TO_SPACE' },
        { actorUserId: p.userId },
      );
      events.push(...ops.events);
      await tx.execute(sql`UPDATE assets SET account_id = ${p.targetAccountId}, updated_at = now() WHERE id = ${p.assetId}`);
      data = await transferAssetDataInTx(tx, {
        assetId: p.assetId, fromAccountId: p.sourceAccountId, toAccountId: p.targetAccountId,
        reasonCode: 'ASSET_MOVED_TO_SPACE', actorUserId: p.userId,
      });
      events.push(...data.events);

      // 5. Quotas du compte cible APRÈS déplacement (mêmes règles de
      //    décompte que l'affichage et les gardes de création).
      const [{ n: biens }] = await rows<{ n: number }>(tx, sql`
        SELECT count(*)::int AS n FROM assets WHERE account_id = ${p.targetAccountId} AND deleted_at IS NULL`);
      const [{ n: docs }] = await rows<{ n: number }>(tx, sql`
        SELECT count(*)::int AS n FROM asset_files
         WHERE account_id = ${p.targetAccountId} AND deleted_at IS NULL AND (upload_status = 'COMPLETED' OR upload_status IS NULL)`);
      const octets = await getAccountStorageUsedBytes(p.targetAccountId, tx);
      const plafond = await getStorageLimitBytes(await getCommercialPlanForAccount(p.targetAccountId));

      const [{ n: equipements }] = await rows<{ n: number }>(tx, sql`
        SELECT count(*)::int AS n FROM equipments WHERE asset_id = ${p.assetId} AND archived_at IS NULL`);
      const [{ n: pieces }] = await rows<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM substructures WHERE asset_id = ${p.assetId}`);
      const preview: MovePreview = {
        assetId: p.assetId,
        assetName: String(asset.name),
        from: { accountId: p.sourceAccountId, name: String(source?.name ?? '') },
        to: { accountId: p.targetAccountId, name: String(cible.name) },
        moves: {
          documents: await titles(tx, data.movedFileIds),
          equipments: Number(equipements),
          rooms: Number(pieces),
          agendaItems: data.movedAgendaItemIds.length,
          events: data.rowsMoved.events ?? 0,
          deadlines: data.rowsMoved.deadlines ?? 0,
          operations: ops.moved.length,
          toProcessActions: data.toProcessActionsMoved,
          suppliersCopied: data.suppliersCopied,
          suppliersReused: data.suppliersReused,
        },
        stays: {
          sharedDocuments: await titles(tx, data.keptFileIds),
          sharedAgendaItems: data.detachedAgendaItemIds.length,
          sharedOperations: ops.detached.length,
          pendingTransmissionsCancelled: data.transmissionsCancelled,
        },
        personal: [...PERSONAL_DATA_NOT_MOVED],
        quotas: {
          assets: { used: Number(biens), limit: ent.quotas.maxAssets },
          documents: { used: Number(docs), limit: ent.quotas.maxDocuments },
          storage: { usedBytes: octets, limitBytes: plafond },
        },
        fingerprint: empreinte({ to: p.targetAccountId, data, opsMoved: ops.moved, opsDetached: ops.detached }),
      };

      const espace = `L’espace « ${cible.name} »`;
      if (Number(biens) > ent.quotas.maxAssets) {
        throw new Annulation({ ok: false, error: 'ASSET_QUOTA_REACHED', preview,
          message: `${espace} compte déjà ${Number(biens) - 1} bien(s) sur ${ent.quotas.maxAssets} autorisés : ce bien ne peut pas y être ajouté. Rien n’a été déplacé.` });
      }
      if (Number(docs) > ent.quotas.maxDocuments) {
        throw new Annulation({ ok: false, error: 'DOCUMENT_QUOTA_REACHED', preview,
          message: `${espace} dépasserait sa limite de ${ent.quotas.maxDocuments} documents (${Number(docs)} après déplacement). Rien n’a été déplacé.` });
      }
      if (octets > plafond) {
        throw new Annulation({ ok: false, error: 'STORAGE_QUOTA_EXCEEDED', preview,
          message: `${espace} dépasserait son espace de stockage (${formatStorageSize(octets)} sur ${formatStorageSize(plafond)}). Rien n’a été déplacé.` });
      }
      if (o.mode === 'preview') throw new Annulation({ ok: true, mode: 'preview', preview });
      if (o.fingerprint !== preview.fingerprint) {
        throw new Annulation({ ok: false, error: 'PREVIEW_STALE', message: MESSAGES.PREVIEW_STALE, preview });
      }

      // 6. Journal (traçabilité complète) : déplacement + historique des deux comptes.
      const { events: _e, t3: _t, ...rapport } = data;
      void _e; void _t;
      const [journal] = await rows<{ id: number }>(tx, sql`
        INSERT INTO asset_space_moves (asset_id, asset_name, from_account_id, to_account_id, user_id, fingerprint, report)
        VALUES (${p.assetId}, ${String(asset.name)}, ${p.sourceAccountId}, ${p.targetAccountId}, ${p.userId}, ${preview.fingerprint},
                ${JSON.stringify({ transfer: rapport, operations: { moved: ops.moved, detached: ops.detached }, preview })}::jsonb)
        RETURNING id`);
      const details = JSON.stringify({ moveId: Number(journal.id), assetId: p.assetId, assetName: String(asset.name), from: p.sourceAccountId, to: p.targetAccountId });
      await tx.execute(sql`
        INSERT INTO account_audit_log (account_id, user_id, user_email, action_type, details, timestamp)
        VALUES (${p.sourceAccountId}, ${p.userId}, ${p.userEmail}, 'ASSET_MOVED_OUT', ${details}, now()),
               (${p.targetAccountId}, ${p.userId}, ${p.userEmail}, 'ASSET_MOVED_IN', ${details}, now())`);
      return { ok: true, mode: 'apply', moveId: Number(journal.id), alreadyMoved: false, toAccountId: p.targetAccountId, preview } as MoveResult;
    });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    return e.result;
  }

  if (result.ok && result.mode === 'apply' && !result.alreadyMoved) {
    await apresDeplacement(p, events, data);
  }
  return result;
}

/** Après commit : Opérations, réconciliation T3, caches et index de l'assistant. Ne lève jamais. */
async function apresDeplacement(p: MoveRequest, events: BusinessOperationEvent[], data: AssetDataTransferResult | null): Promise<void> {
  try {
    await publishBusinessOperationEvents(events);
    if (data) await afterAssetDataTransfer([data], p.userId);
  } catch (e) {
    console.error('[asset-space-move] suites du déplacement :', (e as Error).message);
  }
  invalidateAccountReadCache(p.sourceAccountId);
  invalidateAccountReadCache(p.targetAccountId);
  try {
    const { emitBusinessEvents } = await import('@/services/verebona-assistant/events/business-events');
    await emitBusinessEvents([
      { type: 'ASSET_DELETED', accountId: p.sourceAccountId, entityId: p.assetId },
      { type: 'ASSET_CREATED', accountId: p.targetAccountId, entityId: p.assetId },
    ]);
  } catch { /* non bloquant */ }
}
