/**
 * T6Formatter — exécution, cache, disjoncteur (CDC Mascotte §14, §19).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T6 N'EST JAMAIS NÉCESSAIRE (NFR-002)
 *
 * Chaque issue défavorable rend `null` et l'accueil affiche le texte
 * déterministe, sans nouvel essai (RUN-002) :
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
 *
 * ── UN SEUL MOTEUR : LE PROMPT MAÎTRE (CDC 15 §28, lot 16b) ──────────────
 *
 * T6 s'exécute par `t6_formulate` (`t6_master_v1`, sortie `t6-output-v2`).
 * L'opération d'étapes `formulate_mascot` (`mascot_t6_v1`) et le drapeau
 * AI_HOME_MASCOT sont retirés : la mascotte formule toujours par T6, et le
 * texte déterministe reste le secours de toute issue défavorable.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'crypto';
import { canonicalJson, sha256 } from './hash';
import { pgClient } from '@/db';
import { AiGateway } from '@/services/ai/gateway/ai-gateway';
import { isCostCapReached } from '@/services/ai/gateway/errors';
import { resolveOperationConfig } from '@/services/ai/config/config-resolver';
import { canStart } from '@/services/ai/queue/job-queue.repository';
import {
  T6_OUTPUT_SCHEMA_VERSION, validateT6Output,
  T6FormulateOutput, T6_MASTER_PROMPT_CODE, T6_OUTPUT_SCHEMA_VERSION_V2, validateT6MasterOutput,
  type T6Input, type T6Message, type T6SubjectKind,
} from './t6-contract';

/** Branche FORMULATE du prompt maître T6 (CDC 15 §28) — seule opération de T6. */
export const T6_MASTER_OPERATION = 't6_formulate';
/** Budget d'attente à l'affichage : au-delà, texte de secours (RUN-001, RUN-002). */
export const T6_DISPLAY_BUDGET_MS = 6_000;
/** Une pré-génération n'est attendue par personne. */
export const T6_PREGEN_BUDGET_MS = 30_000;

export type T6Mode = 'display' | 'pregen';

export type T6Status = 'generated' | 'cache_hit' | 'fallback' | 'validation_failed' | 'error' | 'disabled';

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
  /** Architecture du prompt (trace) : toujours le master depuis le lot 16b (§28). */
  architecture?: 'master';
  /** Ajustements serveur du master : R11 (repli par sujet), R8 (formulation stable). */
  adjustments?: string[];
}

// ── Empreintes ───────────────────────────────────────────────────────────────

export { canonicalJson, sha256 };

/**
 * `outputSchema` absent : `t6-output-v1` — clé des entrées antérieures au
 * master, qui ne sont donc plus jamais relues (les générations écrivent sous
 * `t6-output-v2`).
 */
export function t6CacheKey(p: { accountId: number; input: T6Input; promptVersion: string; outputSchema?: string }): string {
  return sha256(canonicalJson({
    accountId: p.accountId,
    context: p.input.subjects,
    language: p.input.language,
    promptVersion: p.promptVersion,
    inputSchema: p.input.schemaVersion,
    outputSchema: p.outputSchema ?? T6_OUTPUT_SCHEMA_VERSION,
  }));
}

/**
 * Version effective du prompt maître T6 (CDC 15 §28, D-03) : texte de la
 * version de configuration s'il y en a un, fichier `t6_master_v1` sinon, et
 * version de configuration. La charte de voix fait partie du master (T6-009) :
 * aucun préambule n'y est ajouté.
 */
export async function getT6MasterPromptVersion(): Promise<string> {
  const [config, { masterPromptVersionOf }] = await Promise.all([
    resolveOperationConfig(T6_MASTER_OPERATION),
    import('@/services/ai/prompts/prompt-loader'),
  ]);
  const version = masterPromptVersionOf({
    masterPromptCode: T6_MASTER_PROMPT_CODE, configuredText: config.masterPromptText, configVersionId: config.configVersionId,
  });
  return `${version}|cfg:${config.configVersionId ?? 'code'}`;
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
  messages: T6Message[]; model: string | null; schemaVersion?: string;
}): Promise<void> {
  try {
    await pgClient.unsafe(
      `INSERT INTO home_mascot_cache (account_id, cache_key, context_hash, prompt_version, schema_version, messages, model)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (account_id, cache_key) DO NOTHING`,
      [p.accountId, p.cacheKey, p.contextHash, p.promptVersion, p.schemaVersion ?? T6_OUTPUT_SCHEMA_VERSION,
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
  // LOG-005 : une lecture du cache n'est pas un appel T6 — ni l'entrée ni la
  // sortie (déjà conservées par la génération d'origine et par le cache) ne
  // sont dupliquées ; la ligne ne sert qu'aux agrégats BO-009.
  const leger = o.status === 'cache_hit';
  try {
    await pgClient.unsafe(
      `INSERT INTO home_mascot_generations
         (account_id, context_hash, mode, status, prompt_version, model, used_fallback_model,
          latency_ms, cost_micros, trace_id, input_json, output_json, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)`,
      [p.accountId, p.contextHash, p.mode, o.status, o.promptVersion, o.model ?? null,
        Boolean(o.usedFallbackModel), o.latencyMs ?? null, o.costMicros ?? null, o.traceId ?? null,
        // LOG-005 : rien de plus que ce qui a été transmis à T6.
        !leger && p.input ? JSON.stringify(p.input) : null,
        leger ? null
          : o.output !== undefined ? JSON.stringify(o.output) : (o.messages ? JSON.stringify({ messages: o.messages }) : null),
        o.error ?? null] as never[],
    );
  } catch (e) {
    console.error('[mascotte] journal T6 non écrit :', (e as Error).message);
  }
}

// ── Exécution ────────────────────────────────────────────────────────────────

/** Mode mascotte → mode d'appel déclaré à la gateway (BO-009). */
export function gatewayCallerMode(mode: T6Mode): 'displayed' | 'pregeneration' {
  return mode === 'display' ? 'displayed' : 'pregeneration';
}

/** Générations en cours, par clé : l'affichage et la pré-génération ne paient pas deux fois. */
const inflight = new Map<string, Promise<T6Outcome>>();

// ── Master T6 (CDC 15 §28) ───────────────────────────────────────────────────

/** Bulle précédente du compte, sous le même master : entrée transmise et sortie validée. */
export interface T6PreviousBubble { input: T6Input; output: unknown }

/**
 * Mémoire BORNÉE de la bulle précédente (R8, sans migration) : les dernières
 * générations validées du compte sous la même version du master, lues dans
 * le journal existant (`home_mascot_generations`, entrée et sortie déjà
 * conservées — LOG-004). Au plus 5 lignes, 30 jours.
 */
export async function readPreviousBubbles(accountId: number, promptVersion: string): Promise<T6PreviousBubble[]> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT input_json AS input, output_json AS output FROM home_mascot_generations
        WHERE account_id = $1 AND status = 'generated' AND prompt_version = $2
          AND input_json IS NOT NULL AND output_json IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC LIMIT 5`,
      [accountId, promptVersion] as never[],
    )) as unknown as Array<{ input: T6Input; output: unknown }>;
    return rows.filter((r) => r.input && Array.isArray(r.input.subjects));
  } catch {
    return [];
  }
}

const memeSujet = (a: T6Input['subjects'][number], b: T6Input['subjects'][number]) =>
  canonicalJson({ ...a }) === canonicalJson({ ...b });

/**
 * R8 — non-répétition DANS LE TEMPS (pure, testée) : pour le même état, la
 * bulle ne se reformule pas.
 *   · même liste de sujets (mêmes faits) qu'une bulle précédente validée →
 *     `reuse` : ses textes, revalidés contre l'entrée courante, sans appel ;
 *   · sinon, chaque sujet inchangé garde son texte précédent (`pin`), pourvu
 *     que la bulle recomposée reste valable (pas de répétition entre sujets).
 */
export function previousWording(
  input: T6Input,
  previous: T6PreviousBubble[],
  kinds?: Array<T6SubjectKind | undefined>,
): { reuse: T6Message[] | null; pinned: Map<number, T6Message> } {
  const pinned = new Map<number, T6Message>();
  for (const p of previous) {
    const prev = p.input.subjects;
    if (prev.length === input.subjects.length && prev.every((s, i) => memeSujet(s, input.subjects[i]))) {
      const v = validateT6MasterOutput(input, p.output, { kinds });
      if (v.ok) return { reuse: v.messages, pinned };
    }
    const v = validateT6MasterOutput(p.input, p.output);
    if (!v.ok) continue;
    input.subjects.forEach((s, i) => {
      if (pinned.has(i)) return;
      const j = prev.findIndex((x) => memeSujet(x, s));
      if (j >= 0) pinned.set(i, v.messages[j]);
    });
  }
  return { reuse: null, pinned };
}

async function generateMaster(p: {
  accountId: number; input: T6Input; cacheKey: string; contextHash: string; promptVersion: string; mode: T6Mode;
  kinds?: Array<T6SubjectKind | undefined>; pinned: Map<number, T6Message>;
}, execute: T6Dependencies['execute']): Promise<T6Outcome> {
  const startedAt = Date.now();
  try {
    const res = await execute({
      useCaseCode: 'HOME_MASCOT',
      operationCode: T6_MASTER_OPERATION,
      accountId: p.accountId,
      // MODE=FORMULATE est imposé par la passerelle (branche de l'opération).
      promptVariables: { INPUT_JSON: JSON.stringify(p.input) },
      outputSchema: T6FormulateOutput,
      idempotencyKey: `mascot:${p.cacheKey}:${randomUUID()}`,
      callerMode: gatewayCallerMode(p.mode),
    });
    const base = {
      promptVersion: p.promptVersion, model: res.model, usedFallbackModel: res.usedFallback,
      latencyMs: Date.now() - startedAt, costMicros: res.fromCache ? 0 : res.costMicros, traceId: res.traceId,
      output: res.data, architecture: 'master' as const,
    };
    // Sujets figés (R8 dans le temps) recollés AVANT la validation ; repli
    // sujet par sujet (R8, R9, R11) ; rejet complet seulement si la sortie
    // est structurellement invalide ou si tous les sujets sont fautifs.
    const v = validateT6MasterOutput(p.input, res.data, { kinds: p.kinds, pinned: p.pinned });
    if (!v.ok) {
      if (!res.fromCache) breakerRecord(false);
      return { ...base, status: 'validation_failed', messages: null, error: v.reason };
    }
    breakerRecord(true);
    const messages = v.messages;
    const adjustments = v.adjustments;
    await writeT6Cache({
      accountId: p.accountId, cacheKey: p.cacheKey, contextHash: p.contextHash,
      promptVersion: p.promptVersion, messages, model: res.model, schemaVersion: T6_OUTPUT_SCHEMA_VERSION_V2,
    });
    return { ...base, status: 'generated', messages, adjustments };
  } catch (e) {
    // Lot 22 : plafond IA du mois du compte atteint — texte de secours
    // déterministe, sans compter d'échec au disjoncteur T6 (partagé par tous
    // les comptes : un compte au plafond ne doit pas couper la mascotte des autres).
    if (isCostCapReached(e)) {
      return {
        status: 'fallback', messages: null, promptVersion: p.promptVersion, architecture: 'master',
        latencyMs: Date.now() - startedAt, error: 'plafond IA du mois du compte atteint',
      };
    }
    breakerRecord(false);
    return {
      status: 'error', messages: null, promptVersion: p.promptVersion, architecture: 'master',
      latencyMs: Date.now() - startedAt, error: (e as Error).message?.slice(0, 500) ?? 'erreur',
    };
  }
}

export interface T6Dependencies {
  treatmentAvailable: () => Promise<boolean>;
  /** Version effective du prompt maître (`getT6MasterPromptVersion`). */
  promptVersion: () => Promise<string>;
  previousBubbles?: (accountId: number, promptVersion: string) => Promise<T6PreviousBubble[]>;
  /** Appel passerelle du master (injectable pour les tests). */
  execute: (req: Parameters<typeof AiGateway.execute>[0]) => ReturnType<typeof AiGateway.execute>;
}

const defaultDeps: T6Dependencies = {
  treatmentAvailable: () => canStart('T6'),
  promptVersion: getT6MasterPromptVersion,
  previousBubbles: readPreviousBubbles,
  execute: (req) => AiGateway.execute(req),
};

/**
 * Formule les sujets avec T6, ou rend `messages: null` (texte de secours).
 * Ne lève jamais.
 */
export async function formulateWithT6(
  p: { accountId: number; input: T6Input; contextHash: string; mode: T6Mode; kinds?: Array<T6SubjectKind | undefined> },
  deps: T6Dependencies = defaultDeps,
): Promise<T6Outcome> {
  let promptVersion: string;
  try {
    if (!(await deps.treatmentAvailable())) {
      return { status: 'disabled', messages: null, promptVersion: null, error: 'T6 désactivé, suspendu ou arrêt d’urgence' };
    }
    promptVersion = await deps.promptVersion();
  } catch (e) {
    return { status: 'error', messages: null, promptVersion: null, error: (e as Error).message };
  }

  const cacheKey = t6CacheKey({ accountId: p.accountId, input: p.input, promptVersion, outputSchema: T6_OUTPUT_SCHEMA_VERSION_V2 });
  const cached = await readT6Cache(p.accountId, cacheKey, p.input);
  if (cached) return { status: 'cache_hit', messages: cached, promptVersion, architecture: 'master' };

  // R8 dans le temps : même état qu'une bulle précédente → mêmes textes,
  // sans appel ; sujets inchangés → formulation conservée.
  let pinned = new Map<number, T6Message>();
  if (deps.previousBubbles) {
    const prev = await deps.previousBubbles(p.accountId, promptVersion).catch(() => [] as T6PreviousBubble[]);
    const w = previousWording(p.input, prev, p.kinds);
    if (w.reuse) {
      await writeT6Cache({
        accountId: p.accountId, cacheKey, contextHash: p.contextHash, promptVersion,
        messages: w.reuse, model: null, schemaVersion: T6_OUTPUT_SCHEMA_VERSION_V2,
      });
      return { status: 'cache_hit', messages: w.reuse, promptVersion, architecture: 'master', adjustments: ['r8_reused'] };
    }
    pinned = w.pinned;
  }

  if (!breakerAllows()) {
    return { status: 'disabled', messages: null, promptVersion, error: 'disjoncteur T6 ouvert' };
  }

  let run = inflight.get(cacheKey);
  if (!run) {
    run = generateMaster({ accountId: p.accountId, input: p.input, cacheKey, contextHash: p.contextHash, promptVersion, mode: p.mode, kinds: p.kinds, pinned }, deps.execute)
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
