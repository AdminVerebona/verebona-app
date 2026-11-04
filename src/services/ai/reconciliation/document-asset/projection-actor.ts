/**
 * T3 DOCUMENT_ASSET — ACTEUR de la projection après un rattachement (lot
 * 108E, ticket « T3 DOCUMENT_ASSET — correctif #626 bis », A7).
 *
 * LE DÉFAUT CORRIGÉ : quand la cohérence relance T3 sans utilisateur
 * initiateur (`COH-DOC-PRIMARY-LINK.repair()` → `userId: null`), la projection
 * des faits sur le bien (preuves, T3 du bien, équipements, Opérations, Agenda
 * T4) et le recalcul étaient conditionnés à un `userId` : le lien réparé ne
 * propageait rien, ou se faisait au nom du déposant du document.
 *
 * LA RÈGLE :
 *   · utilisateur initiateur (choix, relance manuelle) → acteur USER ;
 *   · aucun initiateur → CONTEXTE TECHNIQUE autorisé et JOURNALISÉ : attribué
 *     au TITULAIRE du compte (propriétaire des données, même convention que
 *     les reprises 91C et la cohérence C-Q7) — jamais au déposant d'un
 *     document (membre Duo) ni à un administrateur, jamais présenté comme un
 *     choix de l'utilisateur. Les valeurs USER restent protégées par la
 *     matrice d'autorité de T3 (aucun écrasement), la projection est
 *     idempotente (preuves par document × champ) : aucun double comptage.
 *   · aucun titulaire (compte incohérent) → projection NON faite, motif tracé.
 */
import { pgClient } from '@/db';

export type ProjectionActor =
  | { kind: 'USER'; userId: number; reason: 'INITIATOR' }
  | { kind: 'TECHNICAL'; userId: number; reason: 'ACCOUNT_OWNER'; trigger: string | null }
  | { kind: 'NONE'; userId: null; reason: 'NO_ACCOUNT_OWNER'; trigger: string | null };

/** Acteur de la projection (pure) : initiateur, sinon titulaire du compte. */
export function projectionActorOf(p: { initiatorUserId: number | null | undefined; accountOwnerUserId: number | null; trigger: string | null }): ProjectionActor {
  if (p.initiatorUserId) return { kind: 'USER', userId: p.initiatorUserId, reason: 'INITIATOR' };
  if (p.accountOwnerUserId) return { kind: 'TECHNICAL', userId: p.accountOwnerUserId, reason: 'ACCOUNT_OWNER', trigger: p.trigger };
  return { kind: 'NONE', userId: null, reason: 'NO_ACCOUNT_OWNER', trigger: p.trigger };
}

/** Titulaire du compte (base). */
export async function accountOwnerUserId(accountId: number): Promise<number | null> {
  const [r] = (await pgClient.unsafe(`SELECT owner_user_id FROM accounts WHERE id = $1`, [accountId] as never[])) as unknown as Array<{ owner_user_id: number | null }>;
  return r?.owner_user_id == null ? null : Number(r.owner_user_id);
}

export async function resolveProjectionActor(accountId: number, initiatorUserId: number | null | undefined, trigger: string | null): Promise<ProjectionActor> {
  if (initiatorUserId) return projectionActorOf({ initiatorUserId, accountOwnerUserId: null, trigger });
  return projectionActorOf({ initiatorUserId: null, accountOwnerUserId: await accountOwnerUserId(accountId), trigger });
}

/** Effet de la projection d'un rattachement (journal T3, diagnostic). */
export interface ProjectionEffect {
  actor: ProjectionActor['kind'];
  reason: ProjectionActor['reason'];
  trigger: string | null;
  /** Lot 108E (A2) : document d'appareil — faits sans cible jamais réattribués au bien porteur. */
  equipmentDocument: boolean;
  assets: Array<{ assetId: number; status: 'PROJECTED' | 'T3_ENQUEUED' | 'SKIPPED' | 'ERROR'; evidence: number | null; error?: string }>;
}
