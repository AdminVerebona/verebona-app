/**
 * T6Formatter — exécution, cache, disjoncteur (CDC Mascotte §14, §19).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T6 N'EST JAMAIS NÉCESSAIRE (NFR-002)
 *
 * Chaque issue défavorable rend `null` et l'accueil affiche le texte
 * déterministe, sans nouvel essai (RUN-002) :
 *   · drapeau AI_HOME_MASCOT hors `enabled` (bascule de recette, MIG-007) ;
 *   · arrêt d'urgence, T6 désactivé ou suspendu dans le BO (BO-006) ;
 *   · disjoncteur ouvert après des échecs consécutifs (BO-007) ;
 *   · délai dépassé, erreur fournisseur, sortie invalide.
 *
 * ── LE CACHE EST CELUI DU COMPTE (RUN-003) ────────────────────────────────
 *
 * Clé = compte + empreinte canonique des sujets et faits + langue + version
 * du prompt + version du schéma (RUN-004). Ni prénom ni salutation, rendus
 * hors T6 (RUN-005) : les deux membres d'un Duo partagent donc la même
 * entrée (CACHE-01). Une nouvelle version active du prompt change la clé et
 * invalide de fait l'ancien cache (RUN-006, BO-010).
 *
 * Une génération lente n'est pas perdue : elle s'achève en arrière-plan et
 * écrit sous SA clé — jamais sous celle d'un contexte plus récent (RUN-010).
 * Le prochain affichage du même contexte en profite.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'crypto';
import { canonicalJson, sha256 } from './hash';
import { pgClient } from '@/db';
import { AiGateway } from '@/services/ai/gateway/ai-gateway';
import { resolveOperationConfig } from '@/services/ai/config/config-resolver';
import { resolvePrompt } from '@/services/ai/prompts/prompt-loader';
import { getUseCaseMode } from '@/services/ai/flags/use-case-flags';
import { canStart } from '@/services/ai/queue/job-queue.repository';
import {
  T6OutputSchema, T6_OUTPUT_SCHEMA_VERSION, validateT6Output,
  type T6Input, type T6Message,
} from './t6-contract';

export const T6_OPERATION = 'formulate_mascot';
/** Budget d'attente à l'affichage : au-delà, texte de secours (RUN-001, RUN-002). */
export const T6_DISPLAY_BUDGET_MS = 6_000;
/** Une pré-génération n'est attendue par personne. */
export const T6_PREGEN_BUDGET_MS = 30_000;

export type T6Mode = 'display' | 'pregen';

export type T6Status = 'generated' | 'cache_hit' | 'fallback' | 'validation_failed' | 'error' | 'disabled' | 'skipped';

export interface T6Outcome {
  status: T6Status;
  messages: T6Message[] | null;
  promptVersion: string | null;
  model?: string | null;
  usedFallbackModel?: boolean;
  latencyMs?: number;
  costMicros?: number;
  traceId?: string | null;
  error?: string | null;
  output?: unknown;
}

// ── Empreintes ───────────────────────────────────────────────────────────────

export { canonicalJson, sha256 };

export function t6CacheKey(p: { accountId: number; input: T6Input; promptVersion: string }): string {
  return sha256(canonicalJson({
    accountId: p.accountId,
    context: p.input.subjects,
    language: p.input.language,
    promptVersion: p.promptVersion,
    inputSchema: p.input.schemaVersion,
    outputSchema: T6_OUTPUT_SCHEMA_VERSION,
  }));
}

/**
 * Version effective du prompt maître T6 : prompt technique (fichier ou version
 * active en base) + préambule administrable (charte de voix) + version de
 * configuration. Tout changement de l'un d'eux change la clé de cache.
 */
export async function getT6PromptVersion(): Promise<string> {
  const [config, prompt] = await Promise.all([
    resolveOperationConfig(T6_OPERATION),
    resolvePrompt('mascot_t6_v1', {}, 'HOME_MASCOT'),
  ]);
  const preambule = sha256(config.promptPreamble ?? '').slice(0, 12);
  return `${prompt.version}|cfg:${config.configVersionId ?? 'code'}|voix:${preambule}`;
}

// ── Disjoncteur (BO-007) ─────────────────────────────────────────────────────

const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 60_000;
const breaker = { failures: 0, openUntil: 0 };

export function breakerAllows(now = Date.now()): boolean {
  return now >= breaker.openUntil;
}
function breakerRecord(ok: boolean, now = Date.now()): void {
  if (ok) { breaker.failures = 0; breaker.openUntil = 0; return; }
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_THRESHOLD) {
    breaker.openUntil = now + BREAKER_OPEN_MS;
    breaker.failures = 0;
  }
}
/** Réservé aux tests. */
export function resetT6Breaker(): void { breaker.failures = 0; breaker.openUntil = 0; }

// ── Cache ────────────────────────────────────────────────────────────────────

export async function readT6Cache(accountId: number, cacheKey: string, input: T6Input): Promise<T6Message[] | null> {
  try {
    const r = (await pgClient.unsafe(
      `SELECT messages FROM home_mascot_cache WHERE account_id = $1 AND cache_key = $2 LIMIT 1`,
      [accountId, cacheKey] as never[],
    )) as unknown as Array<{ messages: unknown }>;
    if (!r[0]) return null;
    // Cache illisible ou désaccordé : ignoré, jamais servi (§20).
    const v = validateT6Output(input, { messages: r[0].messages });
    return v.ok ? v.messages : null;
  } catch {
    return null;
  }
}

async function writeT6Cache(p: {
  accountId: number; cacheKey: string; contextHash: string; promptVersion: string;
  messages: T6Message[]; model: string | null;
}): Promise<void> {
  try {
    await pgClient.unsafe(
      `INSERT INTO home_mascot_cache (account_id, cache_key, context_hash, prompt_version, schema_version, messages, model)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (account_id, cache_key) DO NOTHING`,
      [p.accountId, p.cacheKey, p.contextHash, p.promptVersion, T6_OUTPUT_SCHEMA_VERSION,
        JSON.stringify(p.messages), p.model] as never[],
    );
    // Purge légère : les contextes d'il y a plus de 30 jours ne reviendront pas.
    if (Math.random() < 0.02) {
      await pgClient.unsafe(`DELETE FROM home_mascot_cache WHERE created_at < NOW() - INTERVAL '30 days'`, [] as never[]);
    }
  } catch (e) {
    console.error('[mascotte] cache T6 non écrit :', (e as Error).message);
  }
}

export async function logT6(p: {
  accountId: number; contextHash: string; mode: T6Mode; outcome: T6Outcome; input: T6Input | null;
}): Promise<void> {
  const o = p.outcome;
  try {
    await pgClient.unsafe(
      `INSERT INTO home_mascot_generations
         (account_id, context_hash, mode, status, prompt_version, model, used_fallback_model,
          latency_ms, cost_micros, trace_id, input_json, output_json, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)`,
      [p.accountId, p.contextHash, p.mode, o.status, o.promptVersion, o.model ?? null,
        Boolean(o.usedFallbackModel), o.latencyMs ?? null, o.costMicros ?? null, o.traceId ?? null,
        // LOG-005 : rien de plus que ce qui a été transmis à T6.
        p.input ? JSON.stringify(p.input) : null,
        o.output !== undefined ? JSON.stringify(o.output) : (o.messages ? JSON.stringify({ messages: o.messages }) : null),
        o.error ?? null] as never[],
    );
  } catch (e) {
    console.error('[mascotte] journal T6 non écrit :', (e as Error).message);
  }
}

// ── Exécution ────────────────────────────────────────────────────────────────

/** Générations en cours, par clé : l'affichage et la pré-génération ne paient pas deux fois. */
const inflight = new Map<string, Promise<T6Outcome>>();

async function generate(p: {
  accountId: number; input: T6Input; cacheKey: string; contextHash: string; promptVersion: string;
}): Promise<T6Outcome> {
  const startedAt = Date.now();
  try {
    const res = await AiGateway.execute({
      useCaseCode: 'HOME_MASCOT',
      operationCode: T6_OPERATION,
      accountId: p.accountId,
      promptVariables: { INPUT_JSON: JSON.stringify(p.input) },
      outputSchema: T6OutputSchema,
      // Clé propre à la tentative : l'idempotence de la gateway rejouerait
      // pendant une heure une sortie que la validation sémantique rejette.
      // La déduplication est assurée ici (en cours) et par le cache du compte.
      idempotencyKey: `mascot:${p.cacheKey}:${randomUUID()}`,
    });
    const base = {
      promptVersion: p.promptVersion, model: res.model, usedFallbackModel: res.usedFallback,
      latencyMs: Date.now() - startedAt, costMicros: res.fromCache ? 0 : res.costMicros, traceId: res.traceId,
      output: res.data,
    };
    const v = validateT6Output(p.input, res.data);
    if (!v.ok) {
      if (!res.fromCache) breakerRecord(false);
      return { ...base, status: 'validation_failed', messages: null, error: v.reason };
    }
    breakerRecord(true);
    await writeT6Cache({
      accountId: p.accountId, cacheKey: p.cacheKey, contextHash: p.contextHash,
      promptVersion: p.promptVersion, messages: v.messages, model: res.model,
    });
    return { ...base, status: 'generated', messages: v.messages };
  } catch (e) {
    breakerRecord(false);
    return {
      status: 'error', messages: null, promptVersion: p.promptVersion,
      latencyMs: Date.now() - startedAt, error: (e as Error).message?.slice(0, 500) ?? 'erreur',
    };
  }
}

export interface T6Dependencies {
  flagEnabled: () => boolean;
  treatmentAvailable: () => Promise<boolean>;
  promptVersion: () => Promise<string>;
}

const defaultDeps: T6Dependencies = {
  flagEnabled: () => getUseCaseMode('HOME_MASCOT') === 'enabled',
  treatmentAvailable: () => canStart('T6'),
  promptVersion: getT6PromptVersion,
};

/**
 * Formule les sujets avec T6, ou rend `messages: null` (texte de secours).
 * Ne lève jamais.
 */
export async function formulateWithT6(
  p: { accountId: number; input: T6Input; contextHash: string; mode: T6Mode },
  deps: T6Dependencies = defaultDeps,
): Promise<T6Outcome> {
  if (!deps.flagEnabled()) return { status: 'skipped', messages: null, promptVersion: null };

  let promptVersion: string;
  try {
    if (!(await deps.treatmentAvailable())) {
      return { status: 'disabled', messages: null, promptVersion: null, error: 'T6 désactivé, suspendu ou arrêt d’urgence' };
    }
    promptVersion = await deps.promptVersion();
  } catch (e) {
    return { status: 'error', messages: null, promptVersion: null, error: (e as Error).message };
  }

  const cacheKey = t6CacheKey({ accountId: p.accountId, input: p.input, promptVersion });
  const cached = await readT6Cache(p.accountId, cacheKey, p.input);
  if (cached) return { status: 'cache_hit', messages: cached, promptVersion };

  if (!breakerAllows()) {
    return { status: 'disabled', messages: null, promptVersion, error: 'disjoncteur T6 ouvert' };
  }

  let run = inflight.get(cacheKey);
  if (!run) {
    run = generate({ accountId: p.accountId, input: p.input, cacheKey, contextHash: p.contextHash, promptVersion })
      .finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, run);
    // La génération qui s'achève après le délai d'affichage est journalisée
    // en pré-génération : elle n'a pas été vue (RUN-011).
    if (p.mode === 'display') {
      void run.then((o) => { if (tardive.has(run!)) void logT6({ accountId: p.accountId, contextHash: p.contextHash, mode: 'pregen', outcome: o, input: p.input }); });
    }
  }

  const budget = p.mode === 'display' ? T6_DISPLAY_BUDGET_MS : T6_PREGEN_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delai = new Promise<T6Outcome>((resolve) => {
    timer = setTimeout(() => {
      tardive.add(run!);
      resolve({ status: 'error', messages: null, promptVersion, error: `délai de ${budget} ms dépassé`, latencyMs: budget });
    }, budget);
  });
  const outcome = await Promise.race([run, delai]);
  if (timer) clearTimeout(timer);
  return outcome;
}

/** Générations dont l'affichage n'a pas attendu la fin. */
const tardive = new WeakSet<Promise<T6Outcome>>();
