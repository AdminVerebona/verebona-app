/**
 * Actions de la mascotte côté serveur — CDC Mascotte §11 (« C'est fait »),
 * §15 (REF-004 : revalidation au clic), §17 (télémétrie), SEC-006.
 *
 * Aucune donnée métier n'est écrite ici (GEN-002) : l'acquittement et la
 * télémétrie sont les seules écritures propres à la mascotte.
 */
import { pgClient } from '@/db';
import type { MascotActionTarget } from './types';

type Row = Record<string, unknown>;
const rows = async (sql: string, params: unknown[]): Promise<Row[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];

/** Délai pendant lequel « Annuler » reste proposé (DONE-003). */
export const UNDO_WINDOW_MS = 60_000;

// ── « C'est fait » ───────────────────────────────────────────────────────────

type DoneResult =
  | { ok: true; acknowledgedAt: string }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_ACKNOWLEDGEABLE' | 'UNDO_EXPIRED'; message: string };

/**
 * Acquitte une occurrence externe pour le compte (DONE-002, DONE-004).
 * La cible est revalidée : échéance du compte, active, et cycle identique à
 * celui qui a été présenté — une date modifiée entre-temps est un autre cycle.
 */
export async function acknowledgeOccurrence(p: {
  accountId: number; userId: number; occurrenceKey: string; cycleKey: string;
}): Promise<DoneResult> {
  // Lot 113P (#715) : plus de « C'est fait » sur une échéance — un événement daté
  // n'est jamais une action à confirmer (aucune carte MASC-EXT-ACTION n'est plus
  // produite ; une carte ancienne restée affichée est refusée, rien n'est écrit).
  void p;
  return { ok: false, code: 'NOT_ACKNOWLEDGEABLE', message: 'Cette action ne peut pas être marquée comme faite ici.' };
}

/**
 * « Annuler » : réactive la MÊME occurrence, sans en créer une nouvelle
 * (DONE-003). Proposé quelques secondes seulement ; au-delà, refusé.
 */
export async function undoAcknowledgment(p: {
  accountId: number; occurrenceKey: string; cycleKey: string; now?: Date;
}): Promise<DoneResult> {
  const now = p.now ?? new Date();
  const r = await rows(
    `UPDATE home_mascot_acknowledgments
        SET undone_at = $4, updated_at = $4
      WHERE account_id = $1 AND occurrence_key = $2 AND cycle_key = $3 AND undone_at IS NULL
        AND acknowledged_at > $4::timestamptz - ($5 || ' milliseconds')::interval
      RETURNING acknowledged_at`,
    [p.accountId, p.occurrenceKey, p.cycleKey, now.toISOString(), String(UNDO_WINDOW_MS)],
  );
  if (!r[0]) return { ok: false, code: 'UNDO_EXPIRED', message: 'Il n’est plus possible d’annuler cette action.' };
  return { ok: true, acknowledgedAt: new Date(String(r[0].acknowledged_at)).toISOString() };
}

// ── Revalidation au clic (REF-004, §20) ──────────────────────────────────────

type TargetCheck = 'ok' | 'gone' | 'resolved';

/**
 * La cible existe-t-elle encore, dans ce compte ? Aucun identifiant n'est
 * utilisé sans cette revalidation (SEC-006).
 */
export async function checkTarget(accountId: number, target: MascotActionTarget): Promise<TargetCheck> {
  switch (target.kind) {
    case 'drawer': {
      // Lot 113P (#715) : une échéance n'a plus de statut — elle existe (ok) ou
      // a été supprimée (gone) ; jamais « déjà traitée » par un statut.
      if (target.drawer === 'echeance') {
        return (await rows(`SELECT 1 FROM agenda_items WHERE id = $1 AND account_id = $2`, [target.id, accountId])).length ? 'ok' : 'gone';
      }
      const sql = {
        document: `SELECT 1 FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
        equipement: `SELECT 1 FROM equipments e JOIN assets a ON a.id = e.asset_id
                      WHERE e.id = $1 AND a.account_id = $2 AND a.deleted_at IS NULL AND e.archived_at IS NULL`,
        piece: `SELECT 1 FROM substructures s JOIN assets a ON a.id = s.asset_id
                 WHERE s.id = $1 AND a.account_id = $2 AND a.deleted_at IS NULL`,
      }[target.drawer];
      return (await rows(sql, [target.id, accountId])).length ? 'ok' : 'gone';
    }
    case 'to_process': {
      const [a] = await rows(
        `SELECT resolved_at FROM to_process_actions WHERE public_id::text = $1 AND account_id = $2`,
        [target.publicId, accountId],
      );
      if (!a) return 'gone';
      if (a.resolved_at) return 'resolved';
      // ATP-005 : la fiche fournisseur n'est ouverte que si le fournisseur
      // résolu appartient toujours au compte (SEC-006).
      if (target.targetType === 'SUPPLIER' && target.supplierId != null) {
        const f = await rows(
          `SELECT 1 FROM suppliers WHERE id = $1 AND account_id = $2 AND status <> 'deleted'`,
          [target.supplierId, accountId],
        );
        if (!f.length) return 'gone';
      }
      return 'ok';
    }
    case 'done':
      // Lot 113P : plus de « C'est fait » sur une échéance (voir `acknowledgeOccurrence`).
      return 'gone';
    case 'route': {
      const m = /^\/assets\/(\d+)/.exec(target.href);
      if (!m) return 'ok';
      const r = await rows(`SELECT 1 FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [Number(m[1]), accountId]);
      return r.length ? 'ok' : 'gone';
    }
    default:
      return 'ok';
  }
}

// ── Télémétrie (§17) ─────────────────────────────────────────────────────────

interface MascotEventInput {
  visitId: string;
  occurrenceKey: string;
  sourceCode: string;
  placement: 'subject' | 'secondary';
  eventType: 'displayed' | 'clicked' | 'disappeared';
  actionId?: string | null;
}

/**
 * LOG-001, LOG-002 : un « affiché » au plus par occurrence et par visite —
 * l'index unique le garantit même si le recalcul des 10 minutes réaffiche le
 * même sujet. La télémétrie n'influence jamais le classement (LOG-003).
 */
export async function recordMascotEvents(accountId: number, userId: number, events: MascotEventInput[]): Promise<number> {
  let n = 0;
  for (const e of events.slice(0, 20)) {
    const r = await rows(
      `INSERT INTO home_mascot_events (account_id, user_id, visit_id, occurrence_key, source_code, placement, event_type, action_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (visit_id, occurrence_key) WHERE event_type = 'displayed' DO NOTHING
       RETURNING id`,
      [accountId, userId, e.visitId, e.occurrenceKey, e.sourceCode, e.placement, e.eventType, e.actionId ?? null],
    );
    n += r.length;
  }
  return n;
}
