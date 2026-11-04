/**
 * Lot 108C (ticket TCO-646 §E) — « Classer en dépense d'usage » : l'utilisateur
 * indique la catégorie d'usage d'une dépense RÉELLE retenue (carburant,
 * recharge, péage, autre — ou « pas une dépense d'usage »). Le classement
 * prime sur le vocabulaire du libellé (`./usage-complement`) ; il ne modifie
 * jamais la dépense, son justificatif ni son montant, et ne crée aucune
 * Opération : il sert seulement au rapprochement forfait / réel.
 *
 * Clé : clé STABLE de la ligne (`tcoLineKeys`, comme les décisions 80A) — le
 * classement survit aux reconsolidations. Un seul classement par fait (clés
 * secondaires remplacées). `category: null` annule (retour au classement
 * automatique). Rend le TCO recalculé.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import type { TcoResult, UsageBudget } from './model';
import { readAssetTco } from './service';
import { tcoLineKeys } from './user-decisions';
import { usageLineAssignable } from './usage-complement';

interface Runner { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Record<string, unknown>>(r: Runner, q: SQL): Promise<T[]> => (await r.execute(q)) as unknown as T[];

export class UsageAssignmentError extends Error {
  constructor(public readonly code: 'UNAVAILABLE' | 'LINE_NOT_FOUND' | 'NOT_ASSIGNABLE', message: string, public readonly status: number) {
    super(message);
    this.name = 'UsageAssignmentError';
  }
}

const CATEGORIES = ['FUEL', 'CHARGING', 'TOLLS', 'OTHER', 'NONE'] as const;
type AssignCategory = UsageBudget['category'] | 'NONE';

export interface UsageAssignmentInput { lineId: string; lineKey: string | null; category: AssignCategory | null; otherLabel: string | null }

/** Corps `{ lineId, lineKey?, category: FUEL|CHARGING|TOLLS|OTHER|NONE|null, otherLabel? }` → valeur validée (pure). */
export function parseUsageAssignmentBody(body: unknown): { ok: true; value: UsageAssignmentInput } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'Corps attendu : un objet.' };
  const b = body as Record<string, unknown>;
  if (typeof b.lineId !== 'string' || !b.lineId.trim() || b.lineId.length > 200) return { ok: false, message: 'Ligne invalide.' };
  if (b.lineKey != null && (typeof b.lineKey !== 'string' || b.lineKey.length > 200)) return { ok: false, message: 'Clé de ligne invalide.' };
  if (b.category !== null && !(CATEGORIES as readonly unknown[]).includes(b.category)) return { ok: false, message: 'Catégorie d’usage invalide.' };
  if (b.otherLabel != null && (typeof b.otherLabel !== 'string' || b.otherLabel.length > 120)) return { ok: false, message: 'Libellé trop long (120 caractères).' };
  return {
    ok: true,
    value: {
      lineId: b.lineId.trim(), lineKey: (b.lineKey as string | null | undefined) ?? null, category: (b.category as AssignCategory | null),
      otherLabel: b.category === 'OTHER' && typeof b.otherLabel === 'string' && b.otherLabel.trim() ? b.otherLabel.trim() : null,
    },
  };
}

/** Enregistre ou annule le classement d'une dépense et rend le TCO recalculé. */
export async function assignUsageLine(
  accountId: number, assetId: number, userId: number | null, input: UsageAssignmentInput, opts: { today?: string } = {},
): Promise<TcoResult> {
  const [t] = await rows<{ ok: boolean }>(db, sql`SELECT to_regclass('asset_usage_line_assignments') IS NOT NULL AS ok`);
  if (!t?.ok) throw new UsageAssignmentError('UNAVAILABLE', 'Cette fonction sera disponible après la mise à jour en cours. Réessayez dans quelques minutes.', 503);
  const avant = await readAssetTco(accountId, assetId, { today: opts.today });
  const line = avant.lines.find((l) => l.id === input.lineId) ?? (input.lineKey ? avant.lines.find((l) => l.decisionKey === input.lineKey) : undefined);
  if (!line) throw new UsageAssignmentError('LINE_NOT_FOUND', 'Cette dépense a changé depuis l’affichage : la liste a été rechargée.', 409);
  if (input.category !== null && !usageLineAssignable(line)) {
    throw new UsageAssignmentError('NOT_ASSIGNABLE', 'Seule une dépense comptée dans le coût réel (hors achat, financement et cession) peut être classée en dépense d’usage.', 422);
  }
  const keys = tcoLineKeys(line);
  const toutes = [keys.primary, ...keys.secondary];
  const keysParam = `{${toutes.map((k) => `"${k.replace(/["\\]/g, '')}"`).join(',')}}`;
  await db.transaction(async (tx) => {
    const r = tx as unknown as Runner;
    if (input.category === null) {
      await r.execute(sql`DELETE FROM asset_usage_line_assignments WHERE account_id = ${accountId} AND asset_id = ${assetId} AND line_key = ANY(${keysParam}::text[])`);
      return;
    }
    await r.execute(sql`DELETE FROM asset_usage_line_assignments WHERE account_id = ${accountId} AND asset_id = ${assetId}
                          AND line_key = ANY(${keysParam}::text[]) AND line_key <> ${keys.primary}`);
    const ok = await rows(r, sql`
      INSERT INTO asset_usage_line_assignments (account_id, asset_id, line_key, usage_category, other_label, line_id, amount_minor, currency, label, file_id, decided_by, decided_at, updated_at)
      SELECT a.account_id, a.id, ${keys.primary}, ${input.category}, ${input.otherLabel}, ${line.id}, ${line.amountMinor}, ${line.currency.slice(0, 3)},
             ${line.label.slice(0, 300)}, ${line.fileId}, ${userId}, now(), now()
        FROM assets a WHERE a.id = ${assetId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL
      ON CONFLICT (account_id, asset_id, line_key) DO UPDATE
        SET usage_category = EXCLUDED.usage_category, other_label = EXCLUDED.other_label, line_id = EXCLUDED.line_id, amount_minor = EXCLUDED.amount_minor,
            currency = EXCLUDED.currency, label = EXCLUDED.label, file_id = EXCLUDED.file_id, decided_by = EXCLUDED.decided_by, decided_at = now(), updated_at = now()
      RETURNING id`);
    if (!ok.length) throw new UsageAssignmentError('LINE_NOT_FOUND', 'Bien introuvable.', 404);
  });
  return readAssetTco(accountId, assetId, { today: opts.today });
}
