/**
 * POST /api/to-process/conflicts/[id]/resolve
 *
 * Arbitrage d'un conflit de réconciliation — CDC §4.2.9 et §7.1.
 * Même convention que `/api/to-process/suppliers/[id]/resolve` :
 *
 *   keep_current  l'utilisateur garde la valeur en place
 *   use_detected  il retient la valeur concurrente
 *   ignored       il écarte la question sans trancher
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE POINT QUI COMPTE : L'ORIGINE `USER`
 *
 * Quel que soit le choix, le champ est marqué d'une origine utilisateur. Une
 * valeur tranchée par un humain ne doit plus JAMAIS être écrasée
 * automatiquement, même par un document d'autorité supérieure arrivant plus
 * tard (§4.2.6).
 *
 * Sans cela, l'utilisateur arbitrerait le même conflit à chaque dépôt, et
 * perdrait très vite confiance dans l'ensemble — c'est le comportement que la
 * refonte doit supprimer, pas reproduire.
 *
 * `keep_current` est donc une décision à part entière, pas une absence de
 * décision : elle protège la valeur en place. `ignored` en revanche ne marque
 * rien — l'utilisateur repousse la question, il ne la tranche pas.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { pgClient } from '@/db';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';

const RESOLUTIONS = ['keep_current', 'use_detected', 'ignored'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

function isResolution(v: unknown): v is Resolution {
  return typeof v === 'string' && (RESOLUTIONS as readonly string[]).includes(v);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const { id } = await params;
    const conflictId = parseInt(id, 10);
    if (isNaN(conflictId)) return apiError(400, 'INVALID_INPUT', 'Identifiant de conflit invalide');

    const body = await request.json().catch(() => ({}));
    const { resolution } = body as { resolution?: unknown };

    if (!isResolution(resolution)) {
      return apiError(400, 'INVALID_INPUT', `resolution doit valoir ${RESOLUTIONS.join(', ')}`);
    }

    // Le compte est filtré ici, pas seulement dans la mise à jour : un conflit
    // d'un autre compte doit renvoyer 404, jamais 200 sans effet.
    const rows = (await pgClient.unsafe(
      `SELECT id, asset_id, field_key, current_value, proposed_value
         FROM inconsistency_registry
        WHERE id = $1 AND account_id = $2 AND status = 'open'
        LIMIT 1`,
      [conflictId, accountId] as never[],
    )) as unknown as Array<{
      id: number; asset_id: number; field_key: string;
      current_value: string | null; proposed_value: string | null;
    }>;

    const conflict = rows[0];
    if (!conflict) return apiError(404, 'NOT_FOUND', 'Conflit introuvable ou déjà tranché');

    const retained = resolution === 'use_detected' ? conflict.proposed_value : conflict.current_value;

    if (resolution !== 'ignored') {
      await applyUserDecision(accountId, conflict.asset_id, conflict.field_key, retained, session.userId);
    }

    await pgClient.unsafe(
      `UPDATE inconsistency_registry
          SET status = $1, resolution = $2, resolved_by_user_id = $3,
              resolved_value = $4, resolved_at = NOW()
        WHERE id = $5`,
      [
        resolution === 'ignored' ? 'dismissed' : 'resolved',
        resolution,
        session.userId,
        resolution === 'ignored' ? null : retained,
        conflictId,
      ] as never[],
    );

    // CDC Assistant §25.7, §31.7 : élément « À traiter » résolu.
    await emitBusinessEvent({ type: 'TO_PROCESS_ITEM_UPDATED', accountId, entityId: conflictId });
    return NextResponse.json({ success: true, resolution, retainedValue: retained });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}

/**
 * Écrit la valeur retenue et marque l'origine `USER` sur le champ.
 *
 * L'origine est portée par `assets.key_characteristics`, au format
 * `<champ>__origin` établi par la migration 0107. C'est ce marqueur que la
 * réconciliation consulte avant toute écriture automatique.
 *
 * CDC 15 T3-02 (lot 13) :
 *   · `<champ>__updatedAt` est posé (la matrice compare des dates), et
 *     l'autorité de la preuve précédente retirée ;
 *   · `CANONICAL_WRITE_MODE=enabled` et clé du registre : écriture par
 *     `writeCanonicalAssetField` (origine USER, colonnes miroirs, journal) ;
 *   · correction d'un défaut : `key_characteristics` est une colonne TEXT —
 *     l'ancienne requête combinait TEXT et JSONB (`COALESCE(text, jsonb)`) et
 *     échouait ; la conversion est désormais explicite.
 */
async function applyUserDecision(
  accountId: number,
  assetId: number,
  fieldKey: string,
  value: string | null,
  userId: number,
): Promise<void> {
  const { canonicalWriteMode } = await import('@/services/canonical/rollout');
  const { isRegistryKey } = await import('@/services/ai/reconciliation/apply-decision');
  if (canonicalWriteMode() === 'enabled' && isRegistryKey(fieldKey)) {
    const { writeCanonicalAssetField } = await import('@/services/canonical/asset-state');
    await writeCanonicalAssetField({
      assetId, accountId, key: fieldKey, value, origin: 'USER', actorUserId: userId,
      source: { type: 'to_process_conflict', id: null }, mode: 'enabled',
    });
    return;
  }
  await pgClient.unsafe(
    `UPDATE assets
        SET key_characteristics = ((COALESCE(NULLIF(key_characteristics, ''), '{}')::jsonb
              || jsonb_build_object(
                   $2::text, to_jsonb($3::text),
                   $2::text || '__origin', to_jsonb('USER'::text),
                   $2::text || '__origin_user_id', to_jsonb($4::int),
                   $2::text || '__origin_at', to_jsonb(NOW()::text),
                   $2::text || '__updatedAt', to_jsonb(to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                 ))
              - ($2::text || '__authority') - ($2::text || '__sourceDate') - ($2::text || '_origin'))::text,
            updated_at = NOW()
      WHERE id = $1 AND account_id = $5 AND deleted_at IS NULL`,
    [assetId, fieldKey, value, userId, accountId] as never[],
  );
}
