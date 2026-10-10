/**
 * Bandeau « Nouveau modèle Gemini disponible » — lot 35B, ticket « Catalogue
 * IA dynamique Google » (migration 0303).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ACQUITTEMENT PERSISTANT, EN BASE
 *
 * Un modèle est ANNONCÉ quand il a été découvert après la mise en service
 * (pas de baseline), n'a pas été acquitté, est servi par la clé active et est
 * utilisable pour au moins un traitement (« a été ajouté aux modèles
 * utilisables » — un modèle expérimental ou non qualifié n'est pas annoncé).
 *
 * Fermer le bandeau acquitte, en une action, TOUS les modèles qu'il
 * affichait (liste transmise par l'écran : un modèle découvert entre
 * l'affichage et le clic reste annoncé). L'acquittement est en base
 * (`ai_model_catalog.acknowledged_at`, `acknowledged_by`) : il survit à une
 * reconnexion et vaut pour tous les administrateurs. Un modèle découvert
 * ultérieurement ouvre un nouveau bandeau.
 *
 * Tant que la baseline n'a pas eu lieu (première synchronisation réussie
 * après déploiement), rien n'est annoncé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import type { UsableModelsContext } from '../registry/usable-models';

type Row = Record<string, unknown>;

export interface AnnouncedModel {
  model: string;
  displayName: string | null;
  status: string;
  firstSeenAt: string;
}

/** Libellé « Gemini XXX » : nom affiché par Google, sinon identifiant. */
export function announcedLabel(m: Pick<AnnouncedModel, 'model' | 'displayName'>): string {
  return m.displayName?.trim() || m.model;
}

/** Texte du bandeau (pur). */
export function bannerText(models: readonly Pick<AnnouncedModel, 'model' | 'displayName'>[]): { title: string; body: string } | null {
  if (models.length === 0) return null;
  if (models.length === 1) {
    return {
      title: 'Nouveau modèle Gemini disponible',
      body: `${announcedLabel(models[0])} est désormais disponible et a été ajouté aux modèles utilisables.`,
    };
  }
  return {
    title: `${models.length} nouveaux modèles Gemini sont disponibles`,
    body: `${models.map(announcedLabel).join(', ')} ont été ajoutés aux modèles utilisables.`,
  };
}

/** Modèles à annoncer (lecture seule). Table ou colonnes absentes : aucun. */
export async function listAnnouncedModels(ctx?: UsableModelsContext): Promise<AnnouncedModel[]> {
  let rows: Row[];
  try {
    const [ref] = (await pgClient.unsafe(
      `SELECT baseline_done_at FROM ai_model_catalog_refresh WHERE provider = 'gemini'`,
    )) as unknown as Row[];
    if (!ref?.baseline_done_at) return [];
    rows = (await pgClient.unsafe(
      `SELECT model, display_name, lifecycle, first_seen_at
         FROM ai_model_catalog
        WHERE provider = 'gemini' AND available AND acknowledged_at IS NULL AND NOT baseline
        ORDER BY first_seen_at, model`,
    )) as unknown as Row[];
  } catch {
    return [];
  }
  if (rows.length === 0) return [];
  const { loadUsableModelsContext, usableForAnyTreatment } = await import('../registry/usable-models');
  const c = ctx ?? await loadUsableModelsContext();
  return rows
    .filter((r) => usableForAnyTreatment(String(r.model), c))
    .map((r) => ({
      model: String(r.model),
      displayName: r.display_name == null ? null : String(r.display_name),
      status: r.lifecycle == null ? 'stable' : String(r.lifecycle),
      firstSeenAt: new Date(String(r.first_seen_at)).toISOString(),
    }));
}

/** Acquitte les modèles affichés par le bandeau (une action). Rend ceux acquittés. */
export async function acknowledgeAnnouncedModels(models: readonly string[], userId: number | null): Promise<string[]> {
  const liste = [...new Set(models.filter((m) => typeof m === 'string' && m.trim() !== ''))].slice(0, 200);
  if (liste.length === 0) return [];
  const rows = (await pgClient.unsafe(
    `UPDATE ai_model_catalog SET acknowledged_at = NOW(), acknowledged_by = $2
      WHERE provider = 'gemini' AND model = ANY($1::text[]) AND acknowledged_at IS NULL
      RETURNING model`,
    [liste, userId] as never[],
  )) as unknown as Row[];
  return rows.map((r) => String(r.model));
}

/**
 * Baseline (première synchronisation réussie après mise en service) : tous
 * les modèles connus à cet instant sont acquittés sans bandeau. Idempotente :
 * sans effet une fois faite. Rend `true` si elle vient d'avoir lieu.
 */
export async function ensureBaseline(): Promise<boolean> {
  try {
    const [ref] = (await pgClient.unsafe(
      `SELECT baseline_done_at FROM ai_model_catalog_refresh WHERE provider = 'gemini'`,
    )) as unknown as Row[];
    if (!ref || ref.baseline_done_at) return false;
    await pgClient.unsafe(
      `UPDATE ai_model_catalog SET acknowledged_at = COALESCE(acknowledged_at, NOW()), baseline = TRUE
        WHERE provider = 'gemini' AND acknowledged_at IS NULL`,
    );
    await pgClient.unsafe(
      `UPDATE ai_model_catalog_refresh SET baseline_done_at = NOW() WHERE provider = 'gemini' AND baseline_done_at IS NULL`,
    );
    return true;
  } catch (e) {
    console.warn('[new-models] baseline impossible :', (e as Error).message);
    return false;
  }
}
