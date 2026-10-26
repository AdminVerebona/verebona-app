/**
 * Capacités des modèles — lecture, synchronisation et événements — lot 85C
 * (CDC Pilotage IA V2, phase P4 : CAT-01, CAT-03, QUAL-06, R46 ; migrations
 * 0708 et 0709).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PAS DE SECOND CATALOGUE
 *
 * Les fiches sont alimentées par le catalogue EXISTANT (`ai_model_catalog`,
 * relevé de l'API Models par `ai-catalog-sync`) et par la qualification
 * existante (`ai_model_qualification` : modalités, paramètres refusés), plus
 * les références documentées du code. La fiche effective de chaque modèle
 * listé est figée dans `ai_model_catalog.capabilities` (+ empreinte, dates)
 * à chaque passage de la synchronisation quotidienne.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * REQUALIFICATION SUR ÉVÉNEMENT, JAMAIS PAR ÂGE (QUAL-06, R46)
 *
 * Une fiche qui CHANGE d'un passage à l'autre (API, référence du code) :
 *   · une ligne dans le journal `ai_model_capability_changes` (champs avant /
 *     après, source) ;
 *   · « requalification nécessaire » marquée sur la qualification du modèle
 *     (`requalification_required_at`, motif) — lue par `needsQualification`.
 * Un passage qui relit la même chose ne marque rien et ne lance rien. Une
 * fiche modifiée PAR la qualification elle-même (constat d'une sonde) est
 * enregistrée sans marquer de requalification (pas de boucle).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import {
  capabilitiesSha256, diffCapabilities, effectiveCapabilities, knownCapabilityModels, setStoredCapabilityInputs,
  type ModelCapabilities, type StoredCapabilityInputs,
} from './model-capabilities';

type Row = Record<string, unknown>;

const TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 1_500;

let chargeLe = 0;
let enCours: Promise<void> | null = null;
let loaderForTests: (() => Promise<Map<string, StoredCapabilityInputs>>) | null = null;

/** Réservé aux tests : chargeur injecté (`null` : base de données). */
export function __setModelCapabilityLoaderForTests(fn: (() => Promise<Map<string, StoredCapabilityInputs>>) | null): void {
  loaderForTests = fn;
  chargeLe = 0;
}

/** Force la relecture au prochain appel (après synchronisation, qualification). */
export function invalidateModelCapabilities(): void {
  chargeLe = 0;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());
const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v: unknown): boolean | null => (v == null ? null : Boolean(v));

/**
 * Données brutes de tous les modèles connus : catalogue (API Models) et
 * qualification (sondes). Tolère l'absence des colonnes 0708 (lecture
 * historique). Lève si la base est illisible (l'appelant décide).
 */
async function loadStoredCapabilityInputs(sql: typeof pgClient = pgClient): Promise<Map<string, StoredCapabilityInputs>> {
  const out = new Map<string, StoredCapabilityInputs>();
  const cat = (await sql.unsafe(
    `SELECT model, input_token_limit, output_token_limit, supports_thinking, provider_details, last_checked_at, last_seen_at
       FROM ai_model_catalog WHERE provider = 'gemini'`,
    [] as never[],
  ).catch(() => sql.unsafe(
    `SELECT model, input_token_limit, output_token_limit, supports_thinking, NULL::jsonb AS provider_details, last_seen_at, last_seen_at AS last_checked_at
       FROM ai_model_catalog WHERE provider = 'gemini'`,
    [] as never[],
  ))) as unknown as Row[];
  for (const r of cat) {
    const d = (r.provider_details && typeof r.provider_details === 'object' ? r.provider_details : {}) as Record<string, unknown>;
    out.set(String(r.model), {
      model: String(r.model),
      api: {
        inputTokenLimit: num(r.input_token_limit), outputTokenLimit: num(r.output_token_limit),
        supportsThinking: bool(r.supports_thinking),
        temperature: num(d.temperature), maxTemperature: num(d.maxTemperature),
        baseModelId: typeof d.baseModelId === 'string' ? d.baseModelId : null,
        checkedAt: iso(r.last_checked_at ?? r.last_seen_at),
      },
    });
  }
  const q = (await sql.unsafe(
    `SELECT model, structured_ok, multimodal_ok, qualified_at, to_jsonb(q) -> 'rejected_parameters' AS rejected
       FROM ai_model_qualification q WHERE provider = 'gemini'`,
    [] as never[],
  ).catch(() => [])) as unknown as Row[];
  for (const r of q) {
    const model = String(r.model);
    const rejected = Array.isArray(r.rejected) ? (r.rejected as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const cur = out.get(model) ?? { model };
    out.set(model, {
      ...cur,
      probe: { imageInput: bool(r.multimodal_ok), structuredOutput: bool(r.structured_ok), rejected, checkedAt: iso(r.qualified_at) },
    });
  }
  return out;
}

/**
 * Registre en mémoire à jour (TTL 60 s, lecture bornée à 1,5 s). Une lecture
 * en échec conserve les dernières données : les références documentées du
 * code restent toujours disponibles. Ne lève jamais.
 */
export async function ensureModelCapabilitiesLoaded(): Promise<void> {
  if (Date.now() - chargeLe < TTL_MS) return;
  if (enCours) return enCours;
  enCours = (async () => {
    try {
      const lecture = loaderForTests ? loaderForTests() : loadStoredCapabilityInputs();
      const m = await Promise.race([
        lecture,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS).unref?.()),
      ]);
      if (m) setStoredCapabilityInputs(m);
    } catch {
      /* base indisponible : dernières données conservées */
    } finally {
      chargeLe = Date.now();
      enCours = null;
    }
  })();
  return enCours;
}

interface CapabilitySyncResult {
  checked: number;
  /** Modèles dont la fiche a changé à ce passage. */
  changed: string[];
  /** Modèles marqués « requalification nécessaire » (événement). */
  requalificationMarked: string[];
  /** Première fiche enregistrée (aucun événement). */
  baseline: string[];
}

/**
 * Fige les fiches effectives des modèles du catalogue et détecte leurs
 * changements (pure côté calcul, écritures idempotentes). `markRequalification`
 * faux : changement issu de la qualification elle-même (journalisé, sans
 * marquer). Best effort : une table absente rend un résultat vide.
 */
export async function recordCapabilitySnapshot(opts: {
  trigger: string;
  markRequalification: boolean;
  now?: Date;
  sql?: typeof pgClient;
}): Promise<CapabilitySyncResult> {
  const sql = opts.sql ?? pgClient;
  const now = (opts.now ?? new Date()).toISOString();
  const res: CapabilitySyncResult = { checked: 0, changed: [], requalificationMarked: [], baseline: [] };
  let inputs: Map<string, StoredCapabilityInputs>;
  let rows: Row[];
  try {
    inputs = await loadStoredCapabilityInputs(sql);
    rows = (await sql.unsafe(
      `SELECT model, capabilities, capabilities_sha256 FROM ai_model_catalog WHERE provider = 'gemini'`,
      [] as never[],
    )) as unknown as Row[];
  } catch (e) {
    console.warn('[model-capabilities] fiches non enregistrées (migration 0708 ?) :', (e as Error).message);
    return res;
  }
  setStoredCapabilityInputs(inputs);
  invalidateModelCapabilities();
  for (const r of rows) {
    const model = String(r.model);
    const fiche = effectiveCapabilities(model, inputs.get(model) ?? null);
    const sha = capabilitiesSha256(fiche);
    res.checked++;
    const avant = typeof r.capabilities_sha256 === 'string' ? r.capabilities_sha256 : null;
    if (avant === sha) continue;
    const changes = avant ? diffCapabilities((r.capabilities ?? null) as Record<string, unknown> | null, fiche) : [];
    let marque = false;
    const ok = await sql.begin(async (tx) => {
      await tx.unsafe(
        `UPDATE ai_model_catalog SET capabilities = $2::jsonb, capabilities_sha256 = $3, capabilities_checked_at = $4,
                capabilities_changed_at = CASE WHEN capabilities_sha256 IS NULL THEN capabilities_changed_at ELSE $4 END
          WHERE provider = 'gemini' AND model = $1`,
        [model, JSON.stringify(fiche), sha, now] as never[],
      );
      if (!avant) return;
      if (opts.markRequalification) {
        const champs = changes.map((c) => c.field).join(', ');
        const m = (await tx.unsafe(
          `UPDATE ai_model_qualification SET requalification_required_at = COALESCE(requalification_required_at, $2),
                  requalification_reason = $3
            WHERE provider = 'gemini' AND model = $1 RETURNING model`,
          [model, now, `capacités modifiées : ${champs}`.slice(0, 500)] as never[],
        )) as unknown as Row[];
        marque = m.length > 0;
      }
      await tx.unsafe(
        `INSERT INTO ai_model_capability_changes (provider, model, detected_at, trigger, previous_sha256, new_sha256, changes, requalification_marked)
         VALUES ('gemini', $1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [model, now, opts.trigger.slice(0, 40), avant, sha, JSON.stringify(changes), marque] as never[],
      );
    }).then(() => true, (e: unknown) => { console.warn(`[model-capabilities] ${model} : fiche non enregistrée :`, (e as Error).message); return false; });
    if (ok) {
      (avant ? res.changed : res.baseline).push(model);
      if (marque) res.requalificationMarked.push(model);
    }
  }
  return res;
}

interface CapabilityRow {
  model: string;
  listed: boolean;
  available: boolean | null;
  lifecycle: string | null;
  capabilities: ModelCapabilities;
  capabilitiesSha256: string;
  /** Dernier enregistrement par la synchronisation. */
  checkedAt: string | null;
  changedAt: string | null;
  requalificationRequiredAt: string | null;
  requalificationReason: string | null;
  qualifiedAt: string | null;
}

/** Vue BO : fiches de tous les modèles connus (catalogue + références), avec événements. */
export async function listModelCapabilities(): Promise<{ rows: CapabilityRow[]; changes: Array<{ model: string; detectedAt: string; changes: unknown; requalificationMarked: boolean; trigger: string }> }> {
  const inputs = await loadStoredCapabilityInputs().catch(() => new Map<string, StoredCapabilityInputs>());
  const cat = (await pgClient.unsafe(
    `SELECT model, available, lifecycle, capabilities_checked_at, capabilities_changed_at FROM ai_model_catalog WHERE provider = 'gemini'`,
    [] as never[],
  ).catch(() => [])) as unknown as Row[];
  const qual = (await pgClient.unsafe(
    `SELECT model, qualified_at, requalification_required_at, requalification_reason FROM ai_model_qualification WHERE provider = 'gemini'`,
    [] as never[],
  ).catch(() => [])) as unknown as Row[];
  const parCat = new Map(cat.map((r) => [String(r.model), r]));
  const parQual = new Map(qual.map((r) => [String(r.model), r]));
  const models = [...new Set([...knownCapabilityModels(), ...inputs.keys(), ...parCat.keys()])].sort();
  const rows: CapabilityRow[] = models.map((model) => {
    const c = parCat.get(model);
    const q = parQual.get(model);
    const fiche = effectiveCapabilities(model, inputs.get(model) ?? null);
    return {
      model, listed: Boolean(c), available: c ? Boolean(c.available) : null, lifecycle: c?.lifecycle == null ? null : String(c.lifecycle),
      capabilities: fiche, capabilitiesSha256: capabilitiesSha256(fiche),
      checkedAt: iso(c?.capabilities_checked_at), changedAt: iso(c?.capabilities_changed_at),
      requalificationRequiredAt: iso(q?.requalification_required_at), requalificationReason: q?.requalification_reason == null ? null : String(q.requalification_reason),
      qualifiedAt: iso(q?.qualified_at),
    };
  });
  const ch = (await pgClient.unsafe(
    `SELECT model, detected_at, changes, requalification_marked, trigger FROM ai_model_capability_changes
      WHERE provider = 'gemini' ORDER BY detected_at DESC, id DESC LIMIT 50`,
    [] as never[],
  ).catch(() => [])) as unknown as Row[];
  return {
    rows,
    changes: ch.map((r) => ({ model: String(r.model), detectedAt: iso(r.detected_at)!, changes: r.changes, requalificationMarked: Boolean(r.requalification_marked), trigger: String(r.trigger ?? '') })),
  };
}
