/**
 * Package de mise en production — CDC BO IA WF-04, VER-010 à VER-013.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN PACKAGE PORTE UNE COPIE, JAMAIS UNE RÉFÉRENCE
 *
 * Le VER-010 : « le package est immuable et reste valable même si l'Active
 * Préproduction évolue ensuite ». Une référence à la version source suivrait
 * ces évolutions, et le package cesserait d'être ce qu'on a validé.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QU'IL NE CONTIENT PAS
 *
 * Le VER-011 exclut secrets, credentials, états opérationnels, queue,
 * exécutions et Emergency Stop. Ici, cette exclusion n'est pas un filtre à
 * maintenir : le package est construit à partir des seules lignes de
 * configuration, qui ne contiennent rien de tout cela. Un test vérifie que les
 * clés du contenu sont exactement celles de la configuration — c'est ce qui
 * empêche qu'un ajout futur à la table y fasse entrer un état runtime.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'IMPORT EST IDEMPOTENT, LA COLLISION BLOQUE
 *
 * Le WF-04 demande un import idempotent : réimporter le même package reconnaît
 * la version existante au lieu d'en créer une seconde. C'est l'identifiant
 * technique qui le permet — il naît en préproduction et voyage avec le package.
 *
 * Le VER-013 demande l'inverse sur une vraie collision : même numéro visible,
 * identifiant différent. Blocage, « aucune renumérotation automatique ». Le
 * renumérotage silencieux ferait diverger le numéro affiché en production de
 * celui que l'équipe a validé en préproduction, et plus personne ne saurait de
 * quelle v4 on parle.
 */
import { randomUUID } from 'crypto';
import { pgClient } from '@/db';
import { getAiEnvironment, type AiEnvironment } from './environment';
import { ConfigOperationRefused } from './config-version.service';
import { diffVersions, type ConfigDiff } from './config-diff.service';
import { getVersion, getActiveVersion } from './config-version.repository';
import { normalizeTreatmentConfig, type TreatmentConfig } from './config-types';

type Row = Record<string, unknown>;

/** Contenu transporté. Configuration seule — rien d'opérationnel (VER-011). */
export interface PackagePayload {
  schemaVersion: 'ai-config-package-v1';
  sourceEnvironment: AiEnvironment;
  visibleNumber: number;
  label: string | null;
  entries: TreatmentConfig[];
}

export interface ConfigPackage {
  id: number;
  uid: string;
  sourceEnvironment: AiEnvironment;
  visibleNumber: number;
  label: string | null;
  createdAt: Date;
  importedAt: Date | null;
  importedVersionId: number | null;
}

function toPackage(r: Row): ConfigPackage {
  return {
    id: Number(r.id),
    uid: String(r.uid),
    sourceEnvironment: String(r.source_environment) as AiEnvironment,
    visibleNumber: Number(r.visible_number),
    label: r.label == null ? null : String(r.label),
    createdAt: new Date(String(r.created_at)),
    importedAt: r.imported_at ? new Date(String(r.imported_at)) : null,
    importedVersionId: r.imported_version_id == null ? null : Number(r.imported_version_id),
  };
}

const PKG_COLS = `id, uid, source_environment, visible_number, label,
                  created_at, imported_at, imported_version_id`;

/**
 * Construit le contenu transporté à partir des lignes de configuration.
 *
 * Extrait explicitement chaque champ plutôt que de recopier la ligne : une
 * colonne ajoutée à la table demain n'entrerait pas dans le package sans
 * décision, ce qui est précisément la garantie du VER-011.
 */
export function buildPayload(
  sourceEnvironment: AiEnvironment,
  visibleNumber: number,
  label: string | null,
  entries: TreatmentConfig[],
): PackagePayload {
  return {
    schemaVersion: 'ai-config-package-v1',
    sourceEnvironment,
    visibleNumber,
    label,
    entries: entries.map((e) => ({
      treatment: e.treatment,
      // Vide pour T5 : un prompt T5 hérité d'une version antérieure ne voyage
      // pas vers la production (T5-003, E-02).
      prompt: normalizeTreatmentConfig(e).prompt,
      primaryModel: e.primaryModel,
      fallback1: e.fallback1,
      fallback2: e.fallback2,
      reasoningPrimary: e.reasoningPrimary,
      reasoningFallback1: e.reasoningFallback1,
      reasoningFallback2: e.reasoningFallback2,
      maxOutputTokens: e.maxOutputTokens,
      guardrails: e.guardrails,
      triggers: e.triggers,
      // Ajoutée au contrat le 18/09/2026 : la cascade est de la configuration,
      // elle doit donc voyager avec le reste. Le test qui fige les clés du
      // package a signalé cet ajout — c'est précisément son rôle.
      cascade: e.cascade,
    })),
  };
}

// ── WF-04, première moitié : préparer ───────────────────────────────────────

/**
 * Prépare un package depuis une version validée.
 *
 * La version source doit porter un numéro visible : c'est le VER-006 qui
 * l'attribue à la validation, et un package sans numéro ne pourrait ni être
 * annoncé ni détecter une collision.
 */
export async function preparePackage(
  versionId: number,
  userId: number,
): Promise<ConfigPackage> {
  const version = await getVersion(versionId);
  if (!version) {
    throw new ConfigOperationRefused('VERSION_NOT_FOUND', `Version ${versionId} introuvable.`);
  }
  if (version.visibleNumber === null) {
    throw new ConfigOperationRefused(
      'VERSION_NOT_NUMBERED',
      "Cette version n'a pas de numéro : seule une version validée peut partir en production (VER-006).",
    );
  }
  if (version.status === 'ARCHIVED') {
    throw new ConfigOperationRefused(
      'VERSION_ARCHIVED',
      'Une version archivée ne peut plus être déployée (VER-008).',
    );
  }

  const payload = buildPayload(
    version.environment, version.visibleNumber, version.label, version.entries,
  );

  const rows = await pgClient.unsafe(
    `INSERT INTO ai_config_packages
       (uid, source_environment, visible_number, label, payload, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING ${PKG_COLS}`,
    [
      // L'identifiant du package est celui de la VERSION : c'est lui qui rend
      // l'import idempotent et qui identifie la même configuration des deux
      // côtés. En générer un nouveau ferait de chaque préparation un package
      // différent pour une même version.
      version.uid,
      version.environment, version.visibleNumber, version.label,
      JSON.stringify(payload), userId,
    ] as never[],
  );

  return toPackage((rows as unknown as Row[])[0]);
}

export async function listPackages(limit = 50): Promise<ConfigPackage[]> {
  const rows = await pgClient.unsafe(
    `SELECT ${PKG_COLS} FROM ai_config_packages ORDER BY created_at DESC LIMIT $1`,
    [limit] as never[],
  );
  return (rows as unknown as Row[]).map(toPackage);
}

// ── WF-04, seconde moitié : importer ────────────────────────────────────────

export interface ImportResult {
  /** `created` : version née de cet import. `recognized` : déjà importée. */
  outcome: 'created' | 'recognized';
  versionId: number;
  visibleNumber: number;
  /**
   * Écart avec l'Active de production, quand il y en a une.
   *
   * Le WF-04 : « divergence Production : avertissement + diff, mais pas blocage
   * sauf conflit réel ». On le rend donc, sans en faire un refus.
   */
  divergence: ConfigDiff | null;
}

/**
 * Importe un package. Idempotent (WF-04), bloquant sur collision (VER-013).
 *
 * La version créée arrive au statut Validé, jamais Active : le VER-012 réserve
 * l'activation à un geste explicite. Importer et activer d'un seul mouvement
 * ferait de la mise en production un effet de bord du déploiement.
 */
export async function importPackage(
  payload: PackagePayload,
  uid: string,
  userId: number,
): Promise<ImportResult> {
  const environment = getAiEnvironment();

  if (payload.schemaVersion !== 'ai-config-package-v1') {
    throw new ConfigOperationRefused(
      'UNKNOWN_SCHEMA',
      `Format de package inconnu : « ${payload.schemaVersion} ».`,
    );
  }

  // 1. Déjà importé ? On reconnaît, on ne duplique pas.
  const dejaRows = await pgClient.unsafe(
    `SELECT id, visible_number FROM ai_config_versions WHERE uid = $1 LIMIT 1`,
    [uid] as never[],
  );
  const deja = (dejaRows as unknown as Row[])[0];
  if (deja) {
    return {
      outcome: 'recognized',
      versionId: Number(deja.id),
      visibleNumber: Number(deja.visible_number),
      divergence: await divergenceAgainstActive(payload, environment),
    };
  }

  // 2. Collision : même numéro, autre identifiant. Blocage, sans renumérotation.
  const collisionRows = await pgClient.unsafe(
    `SELECT id, uid FROM ai_config_versions
      WHERE environment = $1 AND visible_number = $2 LIMIT 1`,
    [environment, payload.visibleNumber] as never[],
  );
  const collision = (collisionRows as unknown as Row[])[0];
  if (collision) {
    throw new ConfigOperationRefused(
      'VERSION_NUMBER_COLLISION',
      `La version v${payload.visibleNumber} existe déjà dans cet environnement sous un autre `
      + "identifiant. Aucune renumérotation automatique n'est effectuée (VER-013).",
      { existingVersionId: Number(collision.id), existingUid: String(collision.uid) },
    );
  }

  // 3. Création au statut Validé (VER-012).
  const rows = await pgClient.unsafe(
    `INSERT INTO ai_config_versions
       (uid, environment, status, visible_number, label, created_by, validated_at)
     VALUES ($1, $2, 'VALIDATED', $3, $4, $5, NOW())
     RETURNING id`,
    [uid, environment, payload.visibleNumber, payload.label, userId] as never[],
  );
  const versionId = Number((rows as unknown as Row[])[0].id);

  for (const e of payload.entries) {
    await pgClient.unsafe(
      `INSERT INTO ai_config_entries (
         version_id, treatment, prompt, primary_model, fallback_1, fallback_2,
         reasoning_primary, reasoning_fallback_1, reasoning_fallback_2,
         max_output_tokens, guardrails, triggers, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)`,
      [
        versionId, e.treatment, normalizeTreatmentConfig(e).prompt, e.primaryModel, e.fallback1, e.fallback2,
        e.reasoningPrimary, e.reasoningFallback1, e.reasoningFallback2,
        e.maxOutputTokens, JSON.stringify(e.guardrails), JSON.stringify(e.triggers), userId,
      ] as never[],
    );
  }

  // Trace d'import sur le package, s'il est présent dans cet environnement.
  await pgClient.unsafe(
    `UPDATE ai_config_packages
        SET imported_at = NOW(), imported_version_id = $2
      WHERE uid = $1 AND imported_at IS NULL`,
    [uid, versionId] as never[],
  );

  return {
    outcome: 'created',
    versionId,
    visibleNumber: payload.visibleNumber,
    divergence: await divergenceAgainstActive(payload, environment),
  };
}

async function divergenceAgainstActive(
  payload: PackagePayload,
  environment: AiEnvironment,
): Promise<ConfigDiff | null> {
  const active = await getActiveVersion(environment);
  if (!active) return null;
  const d = diffVersions(active.entries, payload.entries);
  return d.identical ? null : d;
}

/**
 * Exporte un package sous forme transportable.
 *
 * Le WF-04 parle d'« exporter/intégrer l'artefact au processus GitHub →
 * Scalingo ». Le §1.4 exclut tout push Git depuis le BO : on rend donc le
 * contenu, et c'est la chaîne de déploiement qui le transporte.
 */
export async function exportPackage(uid: string): Promise<{ uid: string; payload: PackagePayload } | null> {
  const rows = await pgClient.unsafe(
    `SELECT uid, payload FROM ai_config_packages WHERE uid = $1 LIMIT 1`,
    [uid] as never[],
  );
  const r = (rows as unknown as Row[])[0];
  if (!r) return null;
  return { uid: String(r.uid), payload: r.payload as PackagePayload };
}

/** Identifiant technique d'un package créé hors version — usage de test. */
export function newPackageUid(): string {
  return randomUUID();
}
