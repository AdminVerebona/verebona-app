/**
 * Catalogue des modèles du fournisseur — CDC BO IA E-04, PROV-UI-06,
 * PROV-UI-07, PROV-UI-08, WF-29, WF-40, SCR-10 (migration 0177).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI MANQUAIT
 *
 * Le catalogue proposé à l'administrateur était un fichier du code
 * (`gemini-public-catalog.ts`), tous modèles marqués « disponibles ». Un modèle
 * retiré par le fournisseur restait sélectionnable — c'est ce qui est arrivé à
 * `gemini-2.5-flash-lite` le 18/09 —, et un modèle nouveau ne l'était pas sans
 * mise en production : une allowlist de fait.
 *
 * Désormais, « Actualiser le catalogue » interroge le fournisseur avec la clé
 * ACTIVE (`GET /v1beta/models`), enregistre ce qu'il liste, marque
 * indisponibles les modèles disparus, et date le rafraîchissement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ÉCHEC : LE CATALOGUE PRÉCÉDENT EST CONSERVÉ, SIGNALÉ OBSOLÈTE (WF-40)
 *
 * Un rafraîchissement en échec (clé refusée, réseau) n'efface rien : vider le
 * catalogue rendrait toute version invalide pour une panne passagère. L'échec
 * est daté et affiché.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * JAMAIS RAFRAÎCHI : LE CATALOGUE DU CODE FAIT FOI
 *
 * Tant que personne n'a actualisé, la disponibilité vient du fichier du code,
 * comme avant : le déploiement de cette fonction ne rend aucune version
 * invalide du jour au lendemain.
 */
import { pgClient } from '@/db';
import { providerLifecycle, type ProviderLifecycle } from '../registry/model-lifecycle';

type Row = Record<string, unknown>;

const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface ListedModel {
  model: string;
  displayName: string | null;
  supportsGeneration: boolean;
  supportsThinking: boolean | null;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
  /** Lot 35B — informations rendues par Google, conservées telles quelles. */
  version?: string | null;
  description?: string | null;
  supportedMethods?: string[];
  details?: Record<string, unknown>;
  /** Statut fournisseur (règle isolée `model-lifecycle.ts`) et sa base. */
  lifecycle?: ProviderLifecycle;
  lifecycleBasis?: 'structured' | 'name_rule';
}

/**
 * Lecture d'une page de `GET /v1beta/models` (pure, testée).
 *
 * Ne retient que les modèles Gemini capables de `generateContent` : les
 * modèles d'embedding ou d'image ne sont pas sélectionnables pour un
 * traitement, les proposer ferait échouer l'appel.
 */
export function parseModelsListing(body: unknown): ListedModel[] {
  const models = (body as { models?: unknown[] } | null)?.models;
  if (!Array.isArray(models)) return [];
  const out: ListedModel[] = [];
  for (const raw of models) {
    const m = raw as Record<string, unknown>;
    const name = typeof m.name === 'string' ? m.name.replace(/^models\//, '') : null;
    if (!name || !name.startsWith('gemini-')) continue;
    const methods = Array.isArray(m.supportedGenerationMethods) ? (m.supportedGenerationMethods as string[]) : [];
    if (!methods.includes('generateContent')) continue;
    const displayName = typeof m.displayName === 'string' ? m.displayName : null;
    const description = typeof m.description === 'string' ? m.description.slice(0, 1000) : null;
    const stage = [m.launchStage, m.stage, m.lifecycle].find((v) => typeof v === 'string') as string | undefined;
    const cycle = providerLifecycle({ model: name, displayName, description, launchStage: stage ?? null });
    const details: Record<string, unknown> = {};
    for (const k of ['baseModelId', 'temperature', 'maxTemperature', 'topP', 'topK', 'thinking', 'launchStage', 'stage', 'lifecycle']) {
      if (m[k] !== undefined) details[k] = m[k];
    }
    out.push({
      model: name,
      displayName,
      supportsGeneration: true,
      supportsThinking: typeof m.thinking === 'boolean' ? m.thinking : null,
      inputTokenLimit: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : null,
      outputTokenLimit: typeof m.outputTokenLimit === 'number' ? m.outputTokenLimit : null,
      version: typeof m.version === 'string' ? m.version : null,
      description,
      supportedMethods: methods.filter((x) => typeof x === 'string'),
      details,
      lifecycle: cycle.status,
      lifecycleBasis: cycle.basis,
    });
  }
  return out;
}

export interface RefreshResult {
  ok: boolean;
  modelsSeen: number;
  disappeared: string[];
  /** Lot 35B : modèles vus pour la première fois à ce passage. */
  discovered?: string[];
  /** Lot 35B : modèles listés (avec leurs informations fournisseur). */
  listed?: ListedModel[];
  error?: string;
  /**
   * Lot 32B (§1.H) : génération minimale sur les modèles DÉCLARÉS que le
   * fournisseur liste — leur état opérationnel avec la clé active est
   * conservé (`ai_model_operational_status`). Absent : pas de sonde demandée.
   */
  probed?: Array<{ model: string; ok: boolean; error: string | null }>;
}

/**
 * Rafraîchit le catalogue depuis le fournisseur, avec la clé active.
 *
 * `probe` (geste « Actualiser le catalogue » du BO) : sonde ensuite, par une
 * génération minimale, chaque modèle déclaré au registre et listé — c'est le
 * mécanisme qui établit l'état opérationnel lu par
 * `usableModelsForTreatment`, jamais l'affichage du BO.
 */
export async function refreshModelCatalog(
  userId: number | null,
  fetcher: typeof fetch = fetch,
  options: { probe?: boolean; probeCall?: (model: string) => Promise<{ rawText: string; inputTokens?: number; outputTokens?: number }> } = {},
): Promise<RefreshResult> {
  const { getProviderSecret } = await import('./provider-secret');
  const key = await getProviderSecret('gemini');
  const fail = async (error: string): Promise<RefreshResult> => {
    await pgClient.unsafe(
      `INSERT INTO ai_model_catalog_refresh (provider, attempted_at, ok, error, refreshed_by)
       VALUES ('gemini', NOW(), FALSE, $1, $2)
       ON CONFLICT (provider) DO UPDATE SET attempted_at = NOW(), ok = FALSE, error = EXCLUDED.error,
         refreshed_by = EXCLUDED.refreshed_by`,
      [error, userId] as never[],
    );
    console.error(`[model-catalog] rafraîchissement en échec : ${error}`);
    return { ok: false, modelsSeen: 0, disappeared: [], error };
  };
  if (!key) return fail('Aucune clé fournisseur active.');

  const listed: ListedModel[] = [];
  let pageToken: string | null = null;
  try {
    for (let page = 0; page < 10; page++) {
      const url: string = `${MODELS_ENDPOINT}?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      // Clé en en-tête, jamais dans l'URL : une URL finit dans les journaux.
      const res: Response = await fetcher(url, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return fail(`Catalogue refusé par le fournisseur (${res.status}).`);
      const body = (await res.json()) as { nextPageToken?: unknown; models?: unknown[] };
      listed.push(...parseModelsListing(body));
      pageToken = typeof body?.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null;
      if (!pageToken) break;
    }
  } catch (e) {
    return fail(`Fournisseur injoignable : ${(e as Error).message.slice(0, 200)}`);
  }
  if (listed.length === 0) return fail('Le fournisseur n\'a listé aucun modèle de génération.');

  // Lot 35B (0303) : statut fournisseur, version, description, méthodes,
  // détails, dernier contrôle ; un modèle réapparu perd sa date de
  // disparition. Colonnes absentes (migration non appliquée) : écriture
  // historique, rien n'est perdu de ce qui existait.
  const nouveaux: string[] = [];
  for (const m of listed) {
    try {
      const [r] = (await pgClient.unsafe(
        `INSERT INTO ai_model_catalog
           (provider, model, display_name, available, supports_generation, supports_thinking,
            input_token_limit, output_token_limit, first_seen_at, last_seen_at,
            lifecycle, lifecycle_basis, version, description, supported_methods, provider_details,
            last_checked_at, disappeared_at)
         VALUES ('gemini', $1, $2, TRUE, TRUE, $3, $4, $5, NOW(), NOW(), $6, $7, $8, $9, $10::jsonb, $11::jsonb, NOW(), NULL)
         ON CONFLICT (provider, model) DO UPDATE SET
           display_name = EXCLUDED.display_name, available = TRUE,
           supports_thinking = EXCLUDED.supports_thinking,
           input_token_limit = EXCLUDED.input_token_limit,
           output_token_limit = EXCLUDED.output_token_limit, last_seen_at = NOW(),
           lifecycle = EXCLUDED.lifecycle, lifecycle_basis = EXCLUDED.lifecycle_basis,
           version = EXCLUDED.version, description = EXCLUDED.description,
           supported_methods = EXCLUDED.supported_methods, provider_details = EXCLUDED.provider_details,
           last_checked_at = NOW(), disappeared_at = NULL
         RETURNING (xmax = 0) AS inserted`,
        [m.model, m.displayName, m.supportsThinking, m.inputTokenLimit, m.outputTokenLimit,
          m.lifecycle ?? null, m.lifecycleBasis ?? null, m.version ?? null, m.description ?? null,
          JSON.stringify(m.supportedMethods ?? []), JSON.stringify(m.details ?? {})] as never[],
      )) as unknown as Row[];
      if (r?.inserted) nouveaux.push(m.model);
    } catch (e) {
      if ((e as { code?: string }).code !== '42703') throw e;
      await pgClient.unsafe(
        `INSERT INTO ai_model_catalog
           (provider, model, display_name, available, supports_generation, supports_thinking,
            input_token_limit, output_token_limit, first_seen_at, last_seen_at)
         VALUES ('gemini', $1, $2, TRUE, TRUE, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (provider, model) DO UPDATE SET
           display_name = EXCLUDED.display_name, available = TRUE,
           supports_thinking = EXCLUDED.supports_thinking,
           input_token_limit = EXCLUDED.input_token_limit,
           output_token_limit = EXCLUDED.output_token_limit, last_seen_at = NOW()`,
        [m.model, m.displayName, m.supportsThinking, m.inputTokenLimit, m.outputTokenLimit] as never[],
      );
    }
  }
  const gone = (await pgClient.unsafe(
    `UPDATE ai_model_catalog SET available = FALSE
      WHERE provider = 'gemini' AND available AND NOT (model = ANY($1::text[]))
      RETURNING model`,
    [listed.map((m) => m.model)] as never[],
  )) as unknown as Row[];
  if (gone.length > 0) {
    await pgClient.unsafe(
      `UPDATE ai_model_catalog SET disappeared_at = COALESCE(disappeared_at, NOW())
        WHERE provider = 'gemini' AND model = ANY($1::text[])`,
      [gone.map((r) => String(r.model))] as never[],
    ).catch(() => undefined);
  }
  await pgClient.unsafe(
    `INSERT INTO ai_model_catalog_refresh (provider, refreshed_at, attempted_at, ok, error, models_seen, refreshed_by)
     VALUES ('gemini', NOW(), NOW(), TRUE, NULL, $1, $2)
     ON CONFLICT (provider) DO UPDATE SET refreshed_at = NOW(), attempted_at = NOW(), ok = TRUE,
       error = NULL, models_seen = EXCLUDED.models_seen, refreshed_by = EXCLUDED.refreshed_by`,
    [listed.length, userId] as never[],
  );
  const disappeared = gone.map((r) => String(r.model));
  console.info(`[model-catalog] ${listed.length} modèle(s) listé(s)${nouveaux.length ? `, nouveaux : ${nouveaux.join(', ')}` : ''}${disappeared.length ? `, disparus : ${disappeared.join(', ')}` : ''}.`);
  if (!options.probe) return { ok: true, modelsSeen: listed.length, disappeared, discovered: nouveaux, listed };
  const [{ DECLARED_MODELS }, { probeModels }] = await Promise.all([
    import('../registry/models'), import('./model-operational.service'),
  ]);
  const listes = new Set(listed.map((m) => m.model));
  const aSonder = DECLARED_MODELS.map((m) => m.model).filter((m) => listes.has(m));
  const probed = await probeModels(aSonder, key, options.probeCall ? { call: options.probeCall } : {});
  return { ok: true, modelsSeen: listed.length, disappeared, discovered: nouveaux, listed, probed };
}

export interface CatalogState {
  /** `null` : jamais rafraîchi — le catalogue du code fait foi. */
  refreshedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** Dernière tentative en échec : le catalogue affiché est celui d'avant. */
  stale: boolean;
  models: Array<ListedModel & {
    available: boolean; lastSeenAt: string;
    /** Lot 35B (0303). */
    firstSeenAt?: string | null; lastCheckedAt?: string | null; disappearedAt?: string | null;
    acknowledgedAt?: string | null; baseline?: boolean;
  }>;
  /** Lot 35B : baseline du bandeau faite (première synchronisation après mise en service). */
  baselineDoneAt?: string | null;
  lastSyncAt?: string | null;
  lastSyncSummary?: Record<string, unknown> | null;
}

export async function getCatalogState(): Promise<CatalogState> {
  // Lot 35B : colonnes de la 0303 lues si présentes, lecture historique sinon.
  const [ref] = (await pgClient.unsafe(
    `SELECT refreshed_at, attempted_at, ok, error, baseline_done_at, last_sync_at, last_sync_summary
       FROM ai_model_catalog_refresh WHERE provider = 'gemini'`,
    [] as never[],
  ).catch(() => pgClient.unsafe(
    `SELECT refreshed_at, attempted_at, ok, error FROM ai_model_catalog_refresh WHERE provider = 'gemini'`,
    [] as never[],
  )).catch(() => [])) as unknown as Row[];
  const models = (await pgClient.unsafe(
    `SELECT model, display_name, available, supports_generation, supports_thinking,
            input_token_limit, output_token_limit, last_seen_at,
            first_seen_at, lifecycle, lifecycle_basis, version, description, last_checked_at,
            disappeared_at, acknowledged_at, baseline
       FROM ai_model_catalog WHERE provider = 'gemini' ORDER BY available DESC, model`,
    [] as never[],
  ).catch(() => pgClient.unsafe(
    `SELECT model, display_name, available, supports_generation, supports_thinking,
            input_token_limit, output_token_limit, last_seen_at
       FROM ai_model_catalog WHERE provider = 'gemini' ORDER BY available DESC, model`,
    [] as never[],
  )).catch(() => [])) as unknown as Row[];
  const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());
  const LIFECYCLES = new Set(['stable', 'preview', 'experimental', 'deprecated']);
  return {
    baselineDoneAt: iso(ref?.baseline_done_at),
    lastSyncAt: iso(ref?.last_sync_at),
    lastSyncSummary: (ref?.last_sync_summary && typeof ref.last_sync_summary === 'object' ? ref.last_sync_summary : null) as Record<string, unknown> | null,
    refreshedAt: ref?.refreshed_at ? new Date(String(ref.refreshed_at)).toISOString() : null,
    lastAttemptAt: ref?.attempted_at ? new Date(String(ref.attempted_at)).toISOString() : null,
    lastError: ref?.error == null ? null : String(ref.error),
    stale: Boolean(ref) && !ref.ok,
    models: models.map((m) => ({
      model: String(m.model),
      displayName: m.display_name == null ? null : String(m.display_name),
      available: Boolean(m.available),
      supportsGeneration: Boolean(m.supports_generation),
      supportsThinking: m.supports_thinking == null ? null : Boolean(m.supports_thinking),
      inputTokenLimit: m.input_token_limit == null ? null : Number(m.input_token_limit),
      outputTokenLimit: m.output_token_limit == null ? null : Number(m.output_token_limit),
      lastSeenAt: new Date(String(m.last_seen_at)).toISOString(),
      // Statut fournisseur : enregistré à la synchronisation, sinon règle
      // isolée appliquée à la lecture (ligne antérieure à la 0303).
      lifecycle: LIFECYCLES.has(String(m.lifecycle))
        ? m.lifecycle as ProviderLifecycle
        : providerLifecycle({ model: String(m.model), displayName: m.display_name == null ? null : String(m.display_name) }).status,
      lifecycleBasis: m.lifecycle_basis === 'structured' ? 'structured' : 'name_rule',
      version: m.version == null ? null : String(m.version),
      description: m.description == null ? null : String(m.description),
      firstSeenAt: iso(m.first_seen_at),
      lastCheckedAt: iso(m.last_checked_at),
      disappearedAt: iso(m.disappeared_at),
      acknowledgedAt: iso(m.acknowledged_at),
      baseline: Boolean(m.baseline),
    })),
  };
}

/**
 * Modèles servis (pur) : catalogue du fournisseur s'il a été rafraîchi au
 * moins une fois, sinon catalogue du code. Disponibilité FOURNISSEUR seule —
 * ce qui est SÉLECTIONNABLE pour un traitement est décidé par
 * `usableModelsForTreatment` (registry/usable-models.ts, lot 32B).
 */
export function selectableModels(
  codeCatalog: readonly string[],
  state: Pick<CatalogState, 'refreshedAt' | 'models'>,
): Set<string> {
  if (!state.refreshedAt) return new Set(codeCatalog);
  return new Set(state.models.filter((m) => m.available).map((m) => m.model));
}
