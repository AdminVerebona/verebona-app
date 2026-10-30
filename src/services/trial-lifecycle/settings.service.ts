/**
 * Lot 100G — réglages de la séquence de fin d'essai (BO › Communications ›
 * Fin d'essai). Une ligne `trial_lifecycle_settings` ; sans ligne (ou table
 * absente) : réglages par défaut du code — notifications de service actives,
 * campagne commerciale DÉSACTIVÉE (choix prudent).
 */
import { pgClient } from '@/db';
import { DEFAULT_SETTINGS, mergeSettings, validateSettings, type SettingsIssue, type TrialLifecycleSettings } from './milestones';

export interface StoredSettings {
  settings: TrialLifecycleSettings;
  /** Ligne présente en base (sinon : défauts). */
  stored: boolean;
  updatedAt: string | null;
  updatedByEmail: string | null;
}

export async function loadTrialLifecycleSettings(): Promise<StoredSettings> {
  try {
    const [row] = await pgClient<{ settings: unknown; updated_at: Date; updated_by_email: string | null }[]>`
      SELECT settings, updated_at, updated_by_email FROM trial_lifecycle_settings WHERE id = 1`;
    if (!row) return { settings: DEFAULT_SETTINGS, stored: false, updatedAt: null, updatedByEmail: null };
    return { settings: mergeSettings(row.settings), stored: true, updatedAt: new Date(row.updated_at).toISOString(), updatedByEmail: row.updated_by_email };
  } catch (e) {
    // Migration 0886 absente : défauts prudents (aucune relance commerciale).
    console.warn('[trial-lifecycle] réglages illisibles, défauts appliqués :', (e as Error).message);
    return { settings: DEFAULT_SETTINGS, stored: false, updatedAt: null, updatedByEmail: null };
  }
}

/** Champs modifiables depuis le BO (le reste est refusé). */
const EDITABLE_KEYS = new Set(['serviceEnabled', 'commercialEnabled', 'legalBasis', 'softOptInDeclared', 'commercialOffsets', 'catchUpHours', 'sendHours', 'offers']);

export type SaveSettingsResult =
  | { ok: true; settings: TrialLifecycleSettings; before: TrialLifecycleSettings; changed: boolean }
  | { ok: false; issues: SettingsIssue[] };

/**
 * Applique un changement de réglages (BO). `softOptInDeclared: true` pose la
 * déclaration « client existant » au nom de l'administrateur (date, adresse) ;
 * `false` la retire. Changement tracé dans le journal de la séquence.
 */
export async function saveTrialLifecycleSettings(input: { patch: unknown; admin: { id: number; email: string }; now?: Date }): Promise<SaveSettingsResult> {
  const now = input.now ?? new Date();
  const patch = (input.patch && typeof input.patch === 'object' ? input.patch : null) as Record<string, unknown> | null;
  if (!patch) return { ok: false, issues: [{ field: 'body', message: 'Réglages attendus.' }] };
  const unknown = Object.keys(patch).filter((k) => !EDITABLE_KEYS.has(k));
  if (unknown.length) return { ok: false, issues: [{ field: unknown.join(', '), message: 'Réglage inconnu ou non modifiable.' }] };

  const { settings: before } = await loadTrialLifecycleSettings();
  const next: TrialLifecycleSettings = structuredClone(before);
  if (typeof patch.serviceEnabled === 'boolean') next.serviceEnabled = patch.serviceEnabled;
  if (typeof patch.commercialEnabled === 'boolean') next.commercialEnabled = patch.commercialEnabled;
  if (patch.legalBasis === 'consent' || patch.legalBasis === 'soft_opt_in') next.legalBasis = patch.legalBasis;
  else if (patch.legalBasis !== undefined) return { ok: false, issues: [{ field: 'legalBasis', message: 'Base légale inconnue.' }] };
  if (patch.softOptInDeclared === true) next.softOptInDeclaration = { declaredAt: now.toISOString(), declaredBy: input.admin.email };
  else if (patch.softOptInDeclared === false) next.softOptInDeclaration = null;
  if (patch.commercialOffsets && typeof patch.commercialOffsets === 'object') next.commercialOffsets = { ...next.commercialOffsets, ...(patch.commercialOffsets as object) };
  if (patch.catchUpHours && typeof patch.catchUpHours === 'object') next.catchUpHours = { ...next.catchUpHours, ...(patch.catchUpHours as object) };
  if (patch.sendHours && typeof patch.sendHours === 'object') next.sendHours = { ...next.sendHours, ...(patch.sendHours as object) };
  if (patch.offers && typeof patch.offers === 'object') next.offers = { ...next.offers, ...(patch.offers as object) };

  const issues = validateSettings(next);
  if (issues.length) return { ok: false, issues };
  const changed = JSON.stringify(next) !== JSON.stringify(before);
  if (!changed) return { ok: true, settings: next, before, changed: false };

  await pgClient.begin(async (tx) => {
    await tx`
      INSERT INTO trial_lifecycle_settings (id, settings, updated_at, updated_by, updated_by_email)
      VALUES (1, ${JSON.stringify(next)}::jsonb, ${now.toISOString()}, ${input.admin.id}, ${input.admin.email})
      ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by, updated_by_email = EXCLUDED.updated_by_email`;
    await tx`
      INSERT INTO trial_lifecycle_events (event_type, actor, detail, created_at)
      VALUES ('settings_changed', 'admin', ${JSON.stringify({ adminId: input.admin.id, adminEmail: input.admin.email, before, after: next })}::jsonb, ${now.toISOString()})`;
  });
  return { ok: true, settings: next, before, changed: true };
}
