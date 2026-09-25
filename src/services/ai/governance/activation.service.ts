/**
 * Activation et retour arrière — CDC §4.5.3, critère d'acceptation n°19.
 *
 * « Une version antérieure doit pouvoir être restaurée. »
 *
 * L'activation est TRANSACTIONNELLE : une seule version d'un prompt peut être
 * active à un instant donné. Sans cette garantie, deux instances du conteneur
 * pourraient servir deux versions différentes — le défaut exact que présentait
 * l'écriture directe dans les fichiers sur un hébergement multi-instances.
 */
import { pgClient } from '@/db';
import { invalidatePromptCache } from '../prompts/prompt-loader';
import type { PromptVersion } from './types';

export interface ActivationResult {
  activatedVersionId: number;
  supersededVersionId: number | null;
}

/**
 * Active une version candidate et retire la précédente. L'opération est
 * atomique : à aucun instant deux versions ne sont actives, ni aucune.
 */
export async function activateVersion(
  promptCode: string,
  versionId: number,
  userId: number,
): Promise<ActivationResult> {
  // Transaction ORDONNÉE (même correctif que WF-03, config-version.repository) :
  // l'ancienne CTE lisait `activated` avant `previous`, si bien que PostgreSQL
  // promouvait avant de retirer et l'index `ai_prompt_versions_single_active_idx`
  // rejetait l'activation dès qu'une version était active. Pire : si la
  // candidate n'existait pas, l'ancienne était retirée quand même et le prompt
  // restait sans version active. Ici, rien n'est écrit si la candidate manque.
  const row = await pgClient.begin(async (tx) => {
    const t = tx as unknown as { unsafe: (q: string, p?: never[]) => Promise<unknown> };
    const cand = (await t.unsafe(
      `SELECT id FROM ai_prompt_versions
        WHERE id = $2 AND prompt_code = $1 AND status = 'CANDIDATE' FOR UPDATE`,
      [promptCode, versionId] as never[],
    )) as Array<{ id: number }>;
    if (!cand[0]) return null;
    const previous = (await t.unsafe(
      `UPDATE ai_prompt_versions SET status = 'SUPERSEDED'
        WHERE prompt_code = $1 AND status = 'ACTIVE'
        RETURNING id`,
      [promptCode] as never[],
    )) as Array<{ id: number }>;
    const activated = (await t.unsafe(
      `UPDATE ai_prompt_versions
          SET status = 'ACTIVE', activated_at = NOW(), activated_by = $2
        WHERE id = $1
        RETURNING id`,
      [versionId, userId] as never[],
    )) as Array<{ id: number }>;
    return {
      activated_id: activated[0]?.id ?? null,
      superseded_id: previous[0]?.id ?? null,
    };
  });

  if (!row?.activated_id) {
    throw new Error(
      `[gouvernance] Activation impossible : la version ${versionId} de « ${promptCode} » ` +
      "n'existe pas ou n'est pas à l'état CANDIDATE.",
    );
  }

  // Le cache mémoire de chaque instance doit relire la nouvelle version.
  invalidatePromptCache(promptCode);

  return { activatedVersionId: Number(row.activated_id), supersededVersionId: row.superseded_id == null ? null : Number(row.superseded_id) };
}

/**
 * Restaure la version précédemment active. Opération d'urgence : elle doit
 * rester possible en un geste, sans redéploiement ni migration.
 *
 * Transaction ordonnée : retrait de l'active PUIS restauration (la CTE unique
 * restaurait avant de retirer, et heurtait l'index « une seule active »).
 */
export async function rollbackToPrevious(
  promptCode: string,
  userId: number,
): Promise<ActivationResult> {
  const row = await pgClient.begin(async (tx) => {
    const t = tx as unknown as { unsafe: (q: string, p?: never[]) => Promise<unknown> };
    const previous = (await t.unsafe(
      `SELECT id FROM ai_prompt_versions
        WHERE prompt_code = $1 AND status = 'SUPERSEDED'
        ORDER BY activated_at DESC NULLS LAST
        LIMIT 1 FOR UPDATE`,
      [promptCode] as never[],
    )) as Array<{ id: number }>;
    if (!previous[0]) return null;
    const current = (await t.unsafe(
      `UPDATE ai_prompt_versions SET status = 'ROLLED_BACK'
        WHERE prompt_code = $1 AND status = 'ACTIVE'
        RETURNING id`,
      [promptCode] as never[],
    )) as Array<{ id: number }>;
    const restored = (await t.unsafe(
      `UPDATE ai_prompt_versions
          SET status = 'ACTIVE', activated_at = NOW(), activated_by = $2
        WHERE id = $1
        RETURNING id`,
      [previous[0].id, userId] as never[],
    )) as Array<{ id: number }>;
    return {
      activated_id: restored[0]?.id ?? null,
      superseded_id: current[0]?.id ?? null,
    };
  });

  if (!row?.activated_id) {
    throw new Error(
      `[gouvernance] Aucun retour arrière possible sur « ${promptCode} » : ` +
      'aucune version antérieure conservée.',
    );
  }

  invalidatePromptCache(promptCode);
  return { activatedVersionId: Number(row.activated_id), supersededVersionId: row.superseded_id == null ? null : Number(row.superseded_id) };
}

export async function getActiveVersion(promptCode: string): Promise<PromptVersion | null> {
  const rows = await pgClient.unsafe(
    `SELECT id, prompt_code, version, content, content_hash, status,
            created_by, created_at, activated_at
       FROM ai_prompt_versions
      WHERE prompt_code = $1 AND status = 'ACTIVE'
      LIMIT 1`,
    [promptCode] as never[],
  );
  const r = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!r) return null;

  return {
    id: Number(r.id), promptCode: String(r.prompt_code), version: String(r.version),
    content: String(r.content), contentHash: String(r.content_hash),
    status: 'ACTIVE', createdBy: r.created_by ? Number(r.created_by) : null,
    createdAt: new Date(String(r.created_at)),
    activatedAt: r.activated_at ? new Date(String(r.activated_at)) : null,
  };
}

export async function listVersions(promptCode: string): Promise<PromptVersion[]> {
  const rows = await pgClient.unsafe(
    `SELECT id, prompt_code, version, content, content_hash, status,
            created_by, created_at, activated_at
       FROM ai_prompt_versions
      WHERE prompt_code = $1
      ORDER BY created_at DESC`,
    [promptCode] as never[],
  );
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id), promptCode: String(r.prompt_code), version: String(r.version),
    content: String(r.content), contentHash: String(r.content_hash),
    status: String(r.status) as PromptVersion['status'],
    createdBy: r.created_by ? Number(r.created_by) : null,
    createdAt: new Date(String(r.created_at)),
    activatedAt: r.activated_at ? new Date(String(r.activated_at)) : null,
  }));
}
