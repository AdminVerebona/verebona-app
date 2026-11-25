/**
 * Carte #843 (E04) — VALEURS BANCAIRES TRANSITOIRES d'une proposition de l'Assistant : minimisation, chiffrement,
 * purge idempotente, traçable et supervisable.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AVANT #843 : la nouvelle valeur d'IBAN d'une proposition « modifier un fournisseur » restait EN CLAIR dans
 * `verebona_command_plans.actions_payload` jusqu'à la clôture de la proposition, puis un balayage la remplaçait
 * par sa forme masquée — en absorbant ses erreurs (`console.error`, rien d'autre) : une purge en échec passait
 * inaperçue.
 *
 * DÉSORMAIS :
 *   · la proposition figée ne porte JAMAIS l'IBAN en clair : seulement sa forme masquée et `ibanSealed` ;
 *   · la valeur est conservée CHIFFRÉE (AES-256-GCM ; clé dérivée du trousseau hors base `MFA_ENCRYPTION_KEYS`,
 *     étiquette propre ; données associées = proposition + action + champ : un chiffré recopié ailleurs est
 *     indéchiffrable) dans `verebona_command_plan_secrets`, le temps de la confirmation ;
 *   · à la clôture (exécutée, partielle, en échec, annulée, expirée, refusée, intégrité) elle est PURGÉE (valeur
 *     NULL, date, motif) — rejouée, la purge ne trouve rien à faire ; chaque purge et chaque ÉCHEC de purge est
 *     JOURNALISÉ (`verebona_sensitive_purge_log`, aucune valeur) ;
 *   · le balayage quotidien (`sweepSensitiveData`) purge toute valeur ÉCHUE (même d'une proposition restée « en
 *     cours » après un arrêt), masque les IBAN encore en clair dans les messages des fils, et COMPTE le reste à
 *     purger : un reste non nul est journalisé `BACKLOG` et signalé en erreur (supervision) ;
 *   · sans trousseau en production, ou sans la migration 1990 : un changement d'IBAN n'est PAS préparé
 *     (refus explicite) — jamais de repli sur une valeur en clair.
 * Aucune valeur bancaire, aucun chiffré n'est jamais journalisé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { pgClient } from '@/db';
import { maskIban } from '@/lib/suppliers/supplier-fiche-config';
import type { PlannedAction } from './catalog';

/** Préparation refusée : la valeur bancaire ne peut pas être protégée (trousseau ou table absents). */
export const BANKING_SECRET_UNAVAILABLE = 'Je ne peux pas préparer ce changement de coordonnées bancaires pour le moment : rien n’a été enregistré. Réessayez plus tard ou modifiez-les depuis la fiche du fournisseur.';
/** Exécution refusée : la valeur bancaire de la proposition n'est plus disponible (purgée ou échue). */
export const BANKING_SECRET_GONE = 'La nouvelle coordonnée bancaire de cette proposition n’est plus disponible : rien n’a été modifié. Refaites votre demande.';

type Env = Record<string, string | undefined>;

/** Clé de chiffrement des valeurs transitoires, dérivée d'une clé du trousseau hors base (jamais journalisée). */
async function cle(keyId?: string, env: Env = process.env): Promise<{ id: string; key: Buffer }> {
  const { readKeyRing } = await import('@/lib/auth/mfa/secret-box');
  const ring = readKeyRing(env);
  const id = keyId ?? ring.active;
  const base = ring.keys.get(id);
  if (!base) throw new Error('PLAN_SECRET_KEY_UNKNOWN');
  return { id, key: createHmac('sha256', base).update('verebona/assistant/plan-secret/v1').digest() };
}

const b64 = (b: Buffer) => b.toString('base64url');
const aad = (planId: string, actionId: string, field: string) => Buffer.from(`${planId}|${actionId}|${field}`);

/** Chiffre une valeur pour UNE proposition, UNE action, UN champ. Format : `v1.<id>.<iv>.<tag>.<chiffré>`. */
export async function sealValue(value: string, ctx: { planId: string; actionId: string; field: string }, env?: Env): Promise<string> {
  const { id, key } = await cle(undefined, env);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(ctx.planId, ctx.actionId, ctx.field));
  const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return ['v1', id, b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
}

/** Déchiffre ; `null` si le chiffré est illisible, d'une autre proposition / action / champ, ou d'une clé retirée. */
export async function unsealValue(sealed: string, ctx: { planId: string; actionId: string; field: string }, env?: Env): Promise<string | null> {
  try {
    const [v, id, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !id || !iv || !tag || !ct) return null;
    const { key } = await cle(id, env);
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAAD(aad(ctx.planId, ctx.actionId, ctx.field));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Paramètres d'une action « modifier un fournisseur » qui porte un IBAN. */
type SupplierParams = { kind?: string; banking?: boolean; patch?: Record<string, unknown>; ibanSealed?: true; ibanScrubbed?: true };

/** L'action porte-t-elle un IBAN EN CLAIR (à sceller avant d'enregistrer la proposition) ? Pure. */
export function carriesClearIban(a: PlannedAction): boolean {
  const p = a.params as SupplierParams;
  return p.kind === 'supplier_update' && !p.ibanSealed && !p.ibanScrubbed && typeof p.patch?.iban === 'string' && p.patch.iban.length > 0;
}

/**
 * Sépare les valeurs bancaires d'une proposition AVANT son enregistrement : les actions rendues ne portent que la
 * forme masquée (`ibanSealed: true`) ; `secrets` : les valeurs chiffrées à enregistrer dans la même transaction.
 */
export async function sealPlanActions(planId: string, actions: PlannedAction[]): Promise<{ actions: PlannedAction[]; secrets: Array<{ actionId: string; field: 'iban'; sealed: string }> }> {
  const secrets: Array<{ actionId: string; field: 'iban'; sealed: string }> = [];
  const out: PlannedAction[] = [];
  for (const a of actions) {
    if (!carriesClearIban(a)) { out.push(a); continue; }
    const p = a.params as SupplierParams;
    const valeur = String(p.patch!.iban);
    secrets.push({ actionId: a.actionId, field: 'iban', sealed: await sealValue(valeur, { planId, actionId: a.actionId, field: 'iban' }) });
    out.push({ ...a, params: { ...a.params, patch: { ...p.patch, iban: maskIban(valeur) }, ibanSealed: true } as PlannedAction['params'] });
  }
  return { actions: out, secrets };
}

/** Valeur bancaire d'une action d'une proposition, déchiffrée ; `null` : purgée, échue, absente ou illisible. */
export async function unsealPlanSecret(p: { planId: string; accountId: number; actionId: string; field?: 'iban' }): Promise<string | null> {
  const field = p.field ?? 'iban';
  try {
    const [r] = (await pgClient.unsafe(
      `SELECT sealed_value FROM verebona_command_plan_secrets
        WHERE plan_id = $1 AND account_id = $2 AND action_id = $3 AND field = $4 AND sealed_value IS NOT NULL AND expires_at > now()`,
      [p.planId, p.accountId, p.actionId, field] as never[],
    )) as unknown as Array<{ sealed_value: string }>;
    return r ? unsealValue(r.sealed_value, { planId: p.planId, actionId: p.actionId, field }) : null;
  } catch (e) {
    console.error('[verebona] valeur bancaire transitoire illisible :', (e as { code?: string }).code ?? 'ERREUR');
    return null;
  }
}

/** Journal des purges (aucune valeur). Ne lève jamais ; un journal impossible est signalé en erreur. */
export async function logPurge(e: { accountId: number | null; scope: 'PLAN_SECRET' | 'MESSAGE' | 'PLAN_PAYLOAD' | 'SWEEP'; targetId?: string | null; outcome: 'PURGED' | 'MASKED' | 'NOTHING_TO_DO' | 'FAILED' | 'BACKLOG'; detail?: Record<string, unknown> }): Promise<void> {
  try {
    await pgClient.unsafe(
      `INSERT INTO verebona_sensitive_purge_log (account_id, scope, target_id, outcome, detail_json) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [e.accountId, e.scope, e.targetId ?? null, e.outcome, JSON.stringify(e.detail ?? {})] as never[],
    );
  } catch (err) {
    console.error(`[verebona] PURGE_SENSIBLE_JOURNAL_IMPOSSIBLE (${e.scope}/${e.outcome}) :`, (err as { code?: string }).code ?? (err as Error).message);
  }
}

export interface PurgeOutcome { ok: boolean; purged: number; error?: string }

/**
 * PURGE des valeurs bancaires transitoires : celles des propositions CLOSES (périmètre : une proposition, un
 * compte, ou tout), et toutes celles ÉCHUES. Idempotente. Tracée. Ne lève jamais : un échec rend `ok: false`, est
 * compté sur les lignes concernées (tentatives, code d'erreur), journalisé `FAILED` et signalé en erreur.
 */
export async function purgePlanSecrets(scope: { planId?: string; accountId?: number; reason: string }): Promise<PurgeOutcome> {
  const params = [scope.planId ?? null, scope.accountId ?? null, scope.reason] as never[];
  const cible = `sealed_value IS NOT NULL AND ($1::text IS NULL OR plan_id = $1::text) AND ($2::int IS NULL OR account_id = $2::int)
     AND (expires_at <= now() OR NOT EXISTS (SELECT 1 FROM verebona_command_plans p WHERE p.plan_id = s.plan_id AND p.status IN ('PENDING_CONFIRMATION', 'EXECUTING')))`;
  try {
    const rows = (await pgClient.unsafe(
      `UPDATE verebona_command_plan_secrets s
          SET sealed_value = NULL, purged_at = now(), purge_reason = $3, purge_attempts = purge_attempts + 1,
              last_purge_attempt_at = now(), last_purge_error = NULL
        WHERE ${cible}
        RETURNING account_id, plan_id`,
      params,
    )) as unknown as Array<{ account_id: number; plan_id: string }>;
    for (const r of rows) await logPurge({ accountId: Number(r.account_id), scope: 'PLAN_SECRET', targetId: r.plan_id, outcome: 'PURGED', detail: { reason: scope.reason } });
    return { ok: true, purged: rows.length };
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'ERREUR';
    // Échec : JAMAIS silencieux — tentative comptée sur les lignes (si la base répond), journal, erreur signalée.
    console.error(`[verebona] PURGE_BANCAIRE_ECHEC (${scope.reason}) — valeur transitoire non purgée, reprise au balayage :`, code);
    await pgClient.unsafe(
      `UPDATE verebona_command_plan_secrets s SET purge_attempts = purge_attempts + 1, last_purge_attempt_at = now(), last_purge_error = $3
        WHERE ${cible}`,
      [scope.planId ?? null, scope.accountId ?? null, code] as never[],
    ).catch((err: { code?: string }) => console.error('[verebona] PURGE_BANCAIRE_TENTATIVE_NON_COMPTEE :', err.code ?? 'ERREUR'));
    await logPurge({ accountId: scope.accountId ?? null, scope: 'PLAN_SECRET', targetId: scope.planId ?? null, outcome: 'FAILED', detail: { reason: scope.reason, code } });
    return { ok: false, purged: 0, error: code };
  }
}

/** Reste à purger (supervision) : valeurs transitoires de propositions closes ou échues encore présentes. */
export async function bankingSecretsBacklog(): Promise<number> {
  const [r] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM verebona_command_plan_secrets s
      WHERE s.sealed_value IS NOT NULL
        AND (s.expires_at <= now() OR NOT EXISTS (SELECT 1 FROM verebona_command_plans p WHERE p.plan_id = s.plan_id AND p.status IN ('PENDING_CONFIRMATION', 'EXECUTING')))`,
  )) as unknown as Array<{ n: number }>;
  return Number(r?.n ?? 0);
}

/**
 * Historique des fils (E04) : les IBAN encore EN CLAIR dans les messages de l'utilisateur (écrits avant #843) sont
 * remplacés par leur forme masquée lisible. Le message garde son identifiant, sa place et le reste de son texte :
 * l'historique reste intègre et lisible. Par lots bornés ; idempotent ; chaque message masqué est journalisé.
 */
export async function maskIbansInStoredMessages(opts: { accountId?: number; limit?: number } = {}): Promise<number> {
  const { maskIbansInText } = await import('@/lib/security/iban-mask');
  const rows = (await pgClient.unsafe(
    `SELECT id, account_id, content FROM verebona_messages
      WHERE role = 'user' AND ($1::int IS NULL OR account_id = $1::int)
        AND content ~* '[a-z]{2}[0-9]{2}[ ]?[a-z0-9]{4}[ ]?[a-z0-9]{4}'
      ORDER BY id LIMIT $2`,
    [opts.accountId ?? null, opts.limit ?? 500] as never[],
  )) as unknown as Array<{ id: number; account_id: number; content: string }>;
  let n = 0;
  for (const r of rows) {
    const m = maskIbansInText(r.content);
    if (m.count === 0) continue;
    await pgClient.unsafe(`UPDATE verebona_messages SET content = $2 WHERE id = $1 AND content = $3`, [r.id, m.text, r.content] as never[]);
    await logPurge({ accountId: Number(r.account_id), scope: 'MESSAGE', targetId: String(r.id), outcome: 'MASKED', detail: { ibans: m.count } });
    n += 1;
  }
  return n;
}

export interface SensitiveSweepReport { purged: number; purgeOk: boolean; messagesMasked: number; backlog: number }

/**
 * Balayage quotidien (avec l'expiration des propositions) : purge des valeurs échues ou closes, masquage des IBAN de
 * l'historique, puis décompte du RESTE. Un reste non nul ou une purge en échec est journalisé (`BACKLOG` / `FAILED`)
 * et signalé en erreur : la supervision le voit. Ne lève jamais.
 */
export async function sweepSensitiveData(): Promise<SensitiveSweepReport> {
  const purge = await purgePlanSecrets({ reason: 'SWEEP' });
  let messagesMasked = 0;
  let backlog = 0;
  try { messagesMasked = await maskIbansInStoredMessages(); } catch (e) {
    console.error('[verebona] PURGE_SENSIBLE_MESSAGES_ECHEC :', (e as { code?: string }).code ?? (e as Error).message);
    await logPurge({ accountId: null, scope: 'MESSAGE', outcome: 'FAILED', detail: { code: (e as { code?: string }).code ?? 'ERREUR' } });
  }
  try { backlog = await bankingSecretsBacklog(); } catch (e) {
    backlog = -1;
    console.error('[verebona] PURGE_BANCAIRE_RESTE_ILLISIBLE :', (e as { code?: string }).code ?? (e as Error).message);
  }
  if (backlog !== 0 || !purge.ok) {
    console.error(`[verebona] PURGE_BANCAIRE_RESTE — ${backlog} valeur(s) transitoire(s) à purger (purge ${purge.ok ? 'faite' : `en échec : ${purge.error}`}).`);
    await logPurge({ accountId: null, scope: 'SWEEP', outcome: 'BACKLOG', detail: { backlog, purgeOk: purge.ok, error: purge.error ?? null } });
  }
  return { purged: purge.purged, purgeOk: purge.ok, messagesMasked, backlog };
}
