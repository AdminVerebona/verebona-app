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
 * Lot 61 : deux modes du MÊME prompt maître, deux opérations :
 *   · `t6_evaluate` (MODE=EVALUATE, `t6-evaluation-v1`) — pertinence des
 *     interpellations, hors du chemin d'affichage : lancé en arrière-plan à
 *     l'affichage, attendu en pré-génération ; les décisions valides sont
 *     conservées (`t6_interpellation_assessments`) et réutilisées tant que
 *     l'échéance ne change pas — jamais deux appels IA synchrones à chaque
 *     affichage ;
 *   · `t6_formulate` (MODE=FORMULATE, `t6-output-v2` inchangé) — rédaction
 *     des seuls sujets retenus.
 *
 * T6 formule par `t6_formulate` (`t6_master_v1`, sortie `t6-output-v2`).
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
  T6_OUTPUT_SCHEMA_VERSION, validateT6Output, mechanicalWording, T6_INFORMATIVE_REMINDER_CODE,
  T6FormulateOutput, T6_MASTER_PROMPT_CODE, T6_OUTPUT_SCHEMA_VERSION_V2, validateT6MasterOutput,
  type T6Input, type T6Message, type T6SubjectKind,
} from './t6-contract';
import {
  promptSupportsSuggestionRefs, promptSupportsSuggestions, validateT6Suggestions,
  type T6Suggestion, type T6SuggestionBundle,
} from './t6-suggestions';
import {
  T6_ASSESSMENT_REVISION_REMINDER, type T6EvaluationConfig, type T6InterpellationBundle, type T6PersistResult,
} from './t6-interpellation';
import {
  T6EvaluateOutput, T6_EVALUATION_INPUT_SCHEMA_VERSION, T6_EVALUATION_OUTPUT_SCHEMA_VERSION, validateT6Evaluation,
  type T6EvaluationRejection, type T6ValidatedDecision,
} from './t6-contract';

/** Branche FORMULATE du prompt maître T6 (CDC 15 §28). */
export const T6_MASTER_OPERATION = 't6_formulate';
/** Lot 61 : branche EVALUATE du prompt maître T6 (pertinence des interpellations). */
export const T6_EVALUATE_OPERATION = 't6_evaluate';
/**
 * Plafond de l'attente à l'affichage (RUN-001, RUN-002) — borne de
 * `MASCOT_T6_DISPLAY_WAIT_MS`.
 */
export const T6_DISPLAY_BUDGET_MS = 6_000;

/**
 * Attente d'une génération T6 à l'AFFICHAGE (lot 26, point 17). Par défaut
 * AUCUNE : la prise de parole part tout de suite avec la formulation en cache
 * (T6 du même contexte) ou, à défaut, le texte déterministe ; la génération
 * s'achève en arrière-plan, écrit sous sa clé (RUN-010) et sert au prochain
 * affichage du même contexte. Le texte affiché n'est jamais remplacé sous les
 * yeux de l'utilisateur (RUN-001, `useMascotPresentation`).
 *
 * `MASCOT_T6_DISPLAY_WAIT_MS` (facultative, 0 à 6000) rétablit une attente
 * bornée — l'ancien comportement attendait jusqu'à 6 s (≈ 1,5 à 3 s par appel
 * modèle, repli compris) avant d'afficher quoi que ce soit.
 */
export function t6DisplayWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.MASCOT_T6_DISPLAY_WAIT_MS ?? '').trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), T6_DISPLAY_BUDGET_MS) : 0;
}

/** Issue d'un affichage qui n'attend pas la génération lancée en arrière-plan. */
export const T6_BACKGROUND_NOTE = 'formulation en arrière-plan';
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
  /**
   * Lot 55A : questions suggérées validées, issues de la MÊME sortie T6 que
   * `messages`. `null`/absent : indisponibles (aucune question affichée).
   */
  suggestions?: T6Suggestion[] | null;
}

// ── Empreintes ───────────────────────────────────────────────────────────────

export { canonicalJson, sha256 };

/**
 * `outputSchema` absent : `t6-output-v1` — clé des entrées antérieures au
 * master, qui ne sont donc plus jamais relues (les générations écrivent sous
 * `t6-output-v2`).
 */
export function t6CacheKey(p: {
  accountId: number; input: T6Input; promptVersion: string; outputSchema?: string;
  /**
   * Lot 55A : contexte des questions suggérées (message affiché, état du
   * compte, biens, échéances). Présent, il fait partie de la clé : un
   * changement pertinent du compte invalide les questions avec la bulle —
   * jamais de questions anciennes sous un message nouveau. Absent : clé
   * historique inchangée.
   */
  suggestionContext?: unknown;
  /**
   * Lot 60 (R13) — lot 61 : plus transmis par FORMULATE (l'évaluation est le
   * mode EVALUATE). Conservé pour la compatibilité des appelants : absent,
   * clé historique inchangée.
   */
  interpellationContext?: unknown;
}): string {
  return sha256(canonicalJson({
    accountId: p.accountId,
    context: p.input.subjects,
    language: p.input.language,
    promptVersion: p.promptVersion,
    inputSchema: p.input.schemaVersion,
    outputSchema: p.outputSchema ?? T6_OUTPUT_SCHEMA_VERSION,
    ...(p.suggestionContext != null ? { suggestionContext: p.suggestionContext } : {}),
    ...(p.interpellationContext != null ? { interpellationContext: p.interpellationContext } : {}),
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
    promptVersionId: config.masterPromptVersionId ?? null,
  });
  return `${version}|cfg:${config.configVersionId ?? 'code'}`;
}

/**
 * Lot 72A (AC02) — version effective du prompt maître pour l'opération
 * EVALUATE (même forme que `getT6MasterPromptVersion`, configuration de
 * `t6_evaluate`) : conservée avec les décisions et dans la clé de
 * dédoublonnage des évaluations.
 */
export async function getT6EvaluatePromptVersion(): Promise<string> {
  const [config, { masterPromptVersionOf }] = await Promise.all([
    resolveOperationConfig(T6_EVALUATE_OPERATION),
    import('@/services/ai/prompts/prompt-loader'),
  ]);
  const version = masterPromptVersionOf({
    masterPromptCode: T6_MASTER_PROMPT_CODE, configuredText: config.masterPromptText, configVersionId: config.configVersionId,
    promptVersionId: config.masterPromptVersionId ?? null,
  });
  return `${version}|cfg:${config.configVersionId ?? 'code'}`;
}

/**
 * Lot 72A (AC02) — empreinte de la partie du prompt maître qui DÉTERMINE une
 * décision EVALUATE (pure) : tout ce qui précède la branche FORMULATE (en-tête
 * commun et branche EVALUATE). Une révision de FORMULATE (R1 à R12) ne change
 * rien ; fins de ligne et espaces de fin de ligne non plus.
 */
export function t6EvaluateSectionDigest(text: string): string {
  const norm = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
  const coupe = /BRANCHE\s+MODE\s*=\s*FORMULATE/.exec(norm);
  return sha256(coupe ? norm.slice(0, coupe.index) : norm).slice(0, 24);
}

/**
 * Lot 72A (AC02) — configuration EVALUATE COURANTE : signature déterministe de
 * ce qui détermine une décision (section EVALUATE du prompt effectif — version
 * BO, sinon texte livré —, contrats d'entrée et de sortie, modèle principal,
 * seuil indicatif) et version du master (comparaison des décisions
 * antérieures, sans signature). Ne lève jamais : `null` si illisible (aucune
 * invalidation sur une panne).
 */
export async function t6EvaluationConfig(thresholdDays: number): Promise<T6EvaluationConfig | null> {
  try {
    const [config, loader] = await Promise.all([
      resolveOperationConfig(T6_EVALUATE_OPERATION),
      import('@/services/ai/prompts/prompt-loader'),
    ]);
    const bo = config.promptArchitecture === 'master' && config.masterPromptText?.trim() ? config.masterPromptText : null;
    const texte = bo ?? await loader.loadMasterTemplate(T6_MASTER_PROMPT_CODE).catch(() => null);
    if (texte == null) return null;
    const masterVersion = loader.masterPromptVersionOf({
      masterPromptCode: T6_MASTER_PROMPT_CODE, configuredText: bo, configVersionId: config.configVersionId,
      promptVersionId: config.masterPromptVersionId ?? null,
    });
    const signature = `e1:${sha256(canonicalJson({
      prompt: t6EvaluateSectionDigest(texte), input: T6_EVALUATION_INPUT_SCHEMA_VERSION, output: T6_EVALUATION_OUTPUT_SCHEMA_VERSION,
      model: config.primaryModel ?? null, thresholdDays,
    })).slice(0, 24)}`;
    return { signature, masterVersion };
  } catch {
    return null;
  }
}

/**
 * Lot 55A — le prompt maître T6 EFFECTIF (version BO active, sinon fichier du
 * dépôt) porte-t-il `{{SUGGESTION_CONTEXT}}` (R12) ? Non : une version BO
 * antérieure est en service — aucune question suggérée (comportement
 * prudent) tant qu'une nouvelle version n'est pas activée. Ne lève jamais.
 */
export async function t6SuggestionsAvailable(): Promise<boolean> {
  try {
    const config = await resolveOperationConfig(T6_MASTER_OPERATION);
    // Même résolution que la passerelle (`configuredMasterText`) : texte
    // administré en architecture master, sinon fichier du dépôt.
    return promptSupportsSuggestions(config.promptArchitecture === 'master' ? config.masterPromptText : null);
  } catch {
    return false;
  }
}

/**
 * Lot 72A (AC06) — le prompt maître EFFECTIF porte-t-il R12 v2 (références
 * d'échéance `deadlineRef` / `purpose`) ? Non : contexte des questions v1,
 * inchangé (aucune activation silencieuse) — l'exclusion des échéances
 * écartées reste appliquée par le serveur. Ne lève jamais.
 */
export async function t6SuggestionRefsAvailable(): Promise<boolean> {
  try {
    const config = await resolveOperationConfig(T6_MASTER_OPERATION);
    return promptSupportsSuggestionRefs(config.promptArchitecture === 'master' ? config.masterPromptText : null);
  } catch {
    return false;
  }
}

/**
 * Lot 61 — le texte master EFFECTIF porte-t-il la branche EVALUATE ? `null` :
 * fichier du dépôt (qui la porte). Une version BO antérieure (lot 60 : R13
 * dans FORMULATE, sans branche EVALUATE) ne la porte pas.
 */
export async function promptSupportsEvaluation(effectiveText: string | null | undefined): Promise<boolean> {
  if (effectiveText == null) return true;
  const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
  return inspectMasterTemplate(effectiveText).branches.includes('EVALUATE');
}

/**
 * Lot 60, revu au lot 61 — T6 peut-il JUGER l'interpellation ? Il faut T6
 * disponible (ni coupé, ni suspendu, ni arrêt d'urgence) ET un prompt maître
 * effectif porteur de la branche EVALUATE. Non : version BO antérieure en
 * service ou T6 indisponible — dégradation prudente (aucune échéance non
 * évaluée présentée d'office ; l'accueil dit que l'examen est indisponible).
 * Ne lève jamais.
 */
export async function t6InterpellationAvailable(): Promise<boolean> {
  try {
    const [config, ok] = await Promise.all([resolveOperationConfig(T6_EVALUATE_OPERATION), canStart('T6')]);
    return ok && await promptSupportsEvaluation(config.promptArchitecture === 'master' ? config.masterPromptText : null);
  } catch {
    return false;
  }
}

/**
 * Lot 68 — le texte master EFFECTIF connaît-il le rappel informatif (motif
 * `INFORMATIVE_REMINDER`) ? `null` : fichier du dépôt (qui le porte). Une
 * version BO antérieure ne le porte pas : aucun rappel informatif ne peut
 * être proposé (contrat inchangé pour elle) et les évaluations ne sont pas
 * renouvelées inutilement.
 */
export function promptSupportsInformativeReminder(effectiveText: string | null | undefined): boolean {
  if (effectiveText == null) return true;
  return effectiveText.includes(`"${T6_INFORMATIVE_REMINDER_CODE}"`);
}

/** Lot 68 : règle du rappel informatif dans le prompt effectif. Ne lève jamais. */
export async function t6ReminderAvailable(): Promise<boolean> {
  try {
    const config = await resolveOperationConfig(T6_EVALUATE_OPERATION);
    return promptSupportsInformativeReminder(config.promptArchitecture === 'master' ? config.masterPromptText : null);
  } catch {
    return false;
  }
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
  return (await readT6CacheEntry(accountId, cacheKey, input))?.messages ?? null;
}

/**
 * Entrée du cache : textes et — lot 55A — questions suggérées de la même
 * génération (`suggestions` : null si la génération n'en portait pas).
 */
export async function readT6CacheEntry(
  accountId: number, cacheKey: string, input: T6Input, bundle?: T6SuggestionBundle | null,
): Promise<{ messages: T6Message[]; suggestions: T6Suggestion[] | null } | null> {
  try {
    const r = (await pgClient.unsafe(
      bundle
        ? `SELECT messages, suggestions FROM home_mascot_cache WHERE account_id = $1 AND cache_key = $2 LIMIT 1`
        : `SELECT messages FROM home_mascot_cache WHERE account_id = $1 AND cache_key = $2 LIMIT 1`,
      [accountId, cacheKey] as never[],
    )) as unknown as Array<{ messages: unknown; suggestions?: unknown }>;
    if (!r[0]) return null;
    // Lot 68 : formulation antérieure portant une formule mécanique
    // (« À prévoir : », introduction de comptage) — ignorée, donc renouvelée.
    // Lot 71F : et SUPPRIMÉE, avant toute autre validation (une ancienne
    // introduction « … aujourd'hui » est aussi une date relative) —
    // l'écriture du cache ne remplace jamais une ligne existante (ON
    // CONFLICT DO NOTHING) : sans cela, l'entrée fautive survivait et chaque
    // affichage relançait une génération.
    const textes = Array.isArray(r[0].messages) ? (r[0].messages as Array<{ text?: unknown }>).map((m) => m?.text) : [];
    if (textes.some((t) => typeof t === 'string' && mechanicalWording(t))) {
      await pgClient.unsafe(`DELETE FROM home_mascot_cache WHERE account_id = $1 AND cache_key = $2`, [accountId, cacheKey] as never[]);
      return null;
    }
    // Cache illisible ou désaccordé : ignoré, jamais servi (§20).
    const v = validateT6Output(input, { messages: r[0].messages });
    if (!v.ok) return null;
    // Questions revalidées contre le contexte COURANT (références de biens ;
    // lot 72A : références d'échéance, échéances écartées).
    const suggestions = bundle && Array.isArray(r[0].suggestions) ? validateT6Suggestions(r[0].suggestions, bundle.assetIds, bundle) : null;
    return { messages: v.messages, suggestions };
  } catch {
    return null;
  }
}

async function writeT6Cache(p: {
  accountId: number; cacheKey: string; contextHash: string; promptVersion: string;
  messages: T6Message[]; model: string | null; schemaVersion?: string;
  /** Lot 55A : questions de la même génération (migration 0395). */
  suggestions?: T6Suggestion[] | null;
}): Promise<void> {
  try {
    if (p.suggestions) {
      await pgClient.unsafe(
        `INSERT INTO home_mascot_cache (account_id, cache_key, context_hash, prompt_version, schema_version, messages, model, suggestions)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
         ON CONFLICT (account_id, cache_key) DO NOTHING`,
        [p.accountId, p.cacheKey, p.contextHash, p.promptVersion, p.schemaVersion ?? T6_OUTPUT_SCHEMA_VERSION,
          JSON.stringify(p.messages), p.model,
          // Les références de biens (lot 72A : et d'échéance) d'origine, revalidées à la relecture.
          JSON.stringify(p.suggestions.map((x) => ({ question: x.question, assetRef: x.assetRef ?? null, deadlineRef: x.deadlineRef ?? null, purpose: x.purpose ?? null })))] as never[],
      );
    } else {
      await pgClient.unsafe(
        `INSERT INTO home_mascot_cache (account_id, cache_key, context_hash, prompt_version, schema_version, messages, model)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (account_id, cache_key) DO NOTHING`,
        [p.accountId, p.cacheKey, p.contextHash, p.promptVersion, p.schemaVersion ?? T6_OUTPUT_SCHEMA_VERSION,
          JSON.stringify(p.messages), p.model] as never[],
      );
    }
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
  /** Lot 55A : contexte des questions, transmis à T6 (LOG-005 : ni plus, ni moins). */
  suggestionContext?: unknown;
  /** Lot 60 (R13) — lot 61 : jamais transmis par FORMULATE ; conservé pour compatibilité. */
  interpellationContext?: unknown;
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
        !leger && p.input ? JSON.stringify({
          ...p.input,
          ...(p.suggestionContext != null ? { suggestionContext: p.suggestionContext } : {}),
          ...(p.interpellationContext != null ? { interpellationContext: p.interpellationContext } : {}),
        }) : null,
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
  suggestions?: T6SuggestionBundle | null;
}, execute: T6Dependencies['execute']): Promise<T6Outcome> {
  const startedAt = Date.now();
  try {
    const res = await execute({
      useCaseCode: 'HOME_MASCOT',
      operationCode: T6_MASTER_OPERATION,
      accountId: p.accountId,
      // MODE=FORMULATE est imposé par la passerelle (branche de l'opération).
      // Lot 55A : contexte des questions suggérées (R12), `null` sans questions
      // — toujours fourni (un emplacement présent sans valeur est refusé).
      promptVariables: {
        INPUT_JSON: JSON.stringify(p.input),
        SUGGESTION_CONTEXT: p.suggestions ? JSON.stringify(p.suggestions.context) : null,
        // Lot 61 : toujours null en FORMULATE (l'évaluation est le mode
        // EVALUATE) — fourni pour qu'une version BO du lot 60 se rende.
        INTERPELLATION_CONTEXT: null,
      },
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
    // Lot 55A : questions de la MÊME sortie, validées à part (structure).
    const suggestions = p.suggestions
      ? validateT6Suggestions((res.data as { suggestions?: unknown } | null)?.suggestions, p.suggestions.assetIds, p.suggestions)
      : null;
    await writeT6Cache({
      accountId: p.accountId, cacheKey: p.cacheKey, contextHash: p.contextHash,
      promptVersion: p.promptVersion, messages, model: res.model, schemaVersion: T6_OUTPUT_SCHEMA_VERSION_V2,
      suggestions,
    });
    return { ...base, status: 'generated', messages, adjustments, suggestions };
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
  /** Attente à l'affichage (défaut : `t6DisplayWaitMs()`). */
  displayWaitMs?: () => number;
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
  p: {
    accountId: number; input: T6Input; contextHash: string; mode: T6Mode; kinds?: Array<T6SubjectKind | undefined>;
    /**
     * Lot 55A : contexte des questions suggérées (`loadT6SuggestionContext`).
     * Présent : T6 rédige aussi les questions, dans le même appel ; il entre
     * dans la clé du cache. Absent : comportement historique.
     */
    suggestions?: T6SuggestionBundle | null;
  },
  deps: T6Dependencies = defaultDeps,
): Promise<T6Outcome> {
  let promptVersion: string;
  try {
    // Lectures indépendantes, en parallèle (lot 26, point 17).
    const [available, version] = await Promise.all([deps.treatmentAvailable(), deps.promptVersion()]);
    if (!available) {
      return { status: 'disabled', messages: null, promptVersion: null, error: 'T6 désactivé, suspendu ou arrêt d’urgence' };
    }
    promptVersion = version;
  } catch (e) {
    return { status: 'error', messages: null, promptVersion: null, error: (e as Error).message };
  }

  const bundle = p.suggestions ?? null;
  const cacheKey = t6CacheKey({
    accountId: p.accountId, input: p.input, promptVersion, outputSchema: T6_OUTPUT_SCHEMA_VERSION_V2,
    suggestionContext: bundle?.context,
  });
  // Cache du compte et bulles précédentes (R8) lus ensemble : un aller-retour
  // en base de moins sur le chemin de l'affichage.
  const [cached, prev] = await Promise.all([
    readT6CacheEntry(p.accountId, cacheKey, p.input, bundle),
    deps.previousBubbles
      ? deps.previousBubbles(p.accountId, promptVersion).catch(() => [] as T6PreviousBubble[])
      : Promise.resolve(null),
  ]);
  if (cached) {
    return {
      status: 'cache_hit', messages: cached.messages, promptVersion, architecture: 'master',
      ...(bundle ? { suggestions: cached.suggestions } : {}),
    };
  }

  // R8 dans le temps : même état qu'une bulle précédente → mêmes textes,
  // sans appel ; sujets inchangés → formulation conservée.
  // Lot 55A : avec des questions à rédiger (contexte du compte changé, clé
  // nouvelle), les textes précédents sont FIGÉS et T6 est appelé pour les
  // questions seulement — la bulle ne se reformule pas.
  let pinned = new Map<number, T6Message>();
  if (prev) {
    const w = previousWording(p.input, prev, p.kinds);
    if (w.reuse && bundle) {
      w.reuse.forEach((m, i) => pinned.set(i, m));
    } else if (w.reuse) {
      await writeT6Cache({
        accountId: p.accountId, cacheKey, contextHash: p.contextHash, promptVersion,
        messages: w.reuse, model: null, schemaVersion: T6_OUTPUT_SCHEMA_VERSION_V2,
      });
      return { status: 'cache_hit', messages: w.reuse, promptVersion, architecture: 'master', adjustments: ['r8_reused'] };
    }
    if (!w.reuse) pinned = w.pinned;
  }

  if (!breakerAllows()) {
    return { status: 'disabled', messages: null, promptVersion, error: 'disjoncteur T6 ouvert' };
  }

  let run = inflight.get(cacheKey);
  if (!run) {
    run = generateMaster({ accountId: p.accountId, input: p.input, cacheKey, contextHash: p.contextHash, promptVersion, mode: p.mode, kinds: p.kinds, pinned, suggestions: bundle }, deps.execute)
      .finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, run);
    // La génération qui s'achève après le délai d'affichage est journalisée
    // en pré-génération : elle n'a pas été vue (RUN-011).
    if (p.mode === 'display') {
      void run.then((o) => { if (tardive.has(run!)) void logT6({ accountId: p.accountId, contextHash: p.contextHash, mode: 'pregen', outcome: o, input: p.input, suggestionContext: bundle?.context }); });
    }
  }

  const budget = p.mode === 'display' ? (deps.displayWaitMs ?? t6DisplayWaitMs)() : T6_PREGEN_BUDGET_MS;
  if (budget <= 0) {
    // Affichage immédiat : texte de secours maintenant, la génération se
    // poursuit et sera journalisée en pré-génération (RUN-011).
    tardive.add(run);
    return { status: 'fallback', messages: null, promptVersion, architecture: 'master', error: T6_BACKGROUND_NOTE, latencyMs: 0 };
  }
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

// ══════════════════════════════════════════════════════════════════════════
// MODE EVALUATE (lot 61) — pertinence des interpellations
// ══════════════════════════════════════════════════════════════════════════

/**
 * Lot 72A (AC05) : `persist_failed` — décisions validées mais AUCUNE
 * enregistrée (écriture en échec, ou échéances disparues) ;
 * `partially_persisted` — une partie seulement. Jamais `generated` sans
 * écriture complète du lot accepté.
 */
export type T6EvaluationStatus = 'generated' | 'partially_persisted' | 'persist_failed' | 'validation_failed' | 'error' | 'disabled' | 'skipped';

export interface T6EvaluationOutcome {
  status: T6EvaluationStatus;
  promptVersion: string | null;
  accepted: T6ValidatedDecision[];
  rejected: T6EvaluationRejection[];
  /** Décisions conservées (cache des évaluations). */
  persisted: number;
  /** Lot 72A : `subjectId` réellement enregistrés (null : inconnu, persistance qui ne rend qu'un nombre). */
  persistedSubjectIds?: string[] | null;
  /** Lot 72A : décisions validées NON enregistrées et motif (`write_failed`, `not_written`). */
  notPersisted?: Array<{ subjectId: string; reason: 'write_failed' | 'not_written' }>;
  /** Lot 72A (AC08) : mode d'appel déclaré à la passerelle. */
  callerMode?: 'displayed' | 'pregeneration';
  error?: string | null;
  traceId?: string | null;
  model?: string | null;
  latencyMs?: number;
}

/** Disjoncteur PROPRE à EVALUATE : ses échecs ne coupent jamais la formulation. */
const evalBreaker = { failures: 0, openUntil: 0 };
/** Échecs récents par compte et par entrée : pas de nouvel appel avant ce délai. */
export const T6_EVALUATION_RETRY_MS = 10 * 60_000;
const evalFailures = new Map<string, number>();
const evalFailuresByAccount = new Map<number, number>();
const evalInflight = new Map<string, Promise<T6EvaluationOutcome>>();

/** Réservé aux tests. */
export function resetT6EvaluationState(): void {
  evalBreaker.failures = 0; evalBreaker.openUntil = 0;
  evalFailures.clear(); evalFailuresByAccount.clear(); evalInflight.clear();
}

/** Une évaluation de ce compte a échoué récemment (mode dégradé explicite à l'accueil). */
export function t6EvaluationRecentlyFailed(accountId: number, now = Date.now()): boolean {
  const t = evalFailuresByAccount.get(accountId);
  return t != null && now - t < T6_EVALUATION_RETRY_MS;
}

function evalRecord(ok: boolean, key: string, accountId: number, now = Date.now()): void {
  if (ok) {
    evalBreaker.failures = 0; evalBreaker.openUntil = 0;
    evalFailures.delete(key); evalFailuresByAccount.delete(accountId);
    return;
  }
  evalFailures.set(key, now);
  evalFailuresByAccount.set(accountId, now);
  evalBreaker.failures += 1;
  if (evalBreaker.failures >= BREAKER_THRESHOLD) { evalBreaker.openUntil = now + BREAKER_OPEN_MS; evalBreaker.failures = 0; }
}

export interface T6EvaluationDependencies {
  /** T6 disponible et prompt effectif porteur de la branche EVALUATE. */
  available: () => Promise<boolean>;
  /** Lot 68 : prompt effectif porteur du rappel informatif (révision conservée avec les décisions). */
  reminderCapable?: () => Promise<boolean>;
  promptVersion: () => Promise<string>;
  execute: (req: Parameters<typeof AiGateway.execute>[0]) => ReturnType<typeof AiGateway.execute>;
  /** Trace du passage (reporting T6, BO › Exécutions IA › Rapports). */
  report?: (o: T6EvaluationOutcome) => Promise<unknown> | void;
}

export const t6EvaluationDefaultDeps: T6EvaluationDependencies = {
  available: t6InterpellationAvailable,
  reminderCapable: t6ReminderAvailable,
  // Lot 72A : version effective pour l'opération EVALUATE (et non FORMULATE).
  promptVersion: getT6EvaluatePromptVersion,
  execute: (req) => AiGateway.execute(req),
};

/**
 * Lot 72A (AC07) — étape de la passerelle qui a MODIFIÉ la sortie EVALUATE
 * avant de la rendre (pure) : élément ou champ retiré (`field_pruning`),
 * sortie réparée par une passe IA (`ai_repair`), champ non déclaré ignoré.
 * La sortie d'origine n'était donc pas conforme au contrat strict : elle est
 * rejetée EN ENTIER, jamais acceptée amputée. Une normalisation sans perte
 * (casse d'une énumération…) reste admise.
 */
export function evaluationRepairViolation(repairs: ReadonlyArray<{ stage?: string; rule?: string; path?: string }> | null | undefined): string | null {
  const r = (repairs ?? []).find((x) => x.stage === 'field_pruning' || x.stage === 'ai_repair' || (x.rule ?? '').startsWith('unknown_field'));
  return r ? `schema:${r.rule ?? r.stage}:${r.path ?? '$'}` : null;
}

/**
 * Évalue les candidats (MODE=EVALUATE, contrat `t6-evaluation-input-v1` →
 * `t6-evaluation-v1`), valide la sortie (Zod strict + contrôles métier) et
 * CONSERVE les seules décisions valides. Une sortie invalide n'est jamais
 * acceptée silencieusement : statut, motif et rejets sont rendus et tracés.
 * Ne lève jamais. Une même entrée n'est évaluée qu'une fois à la fois ; après
 * un échec, pas de nouvel appel avant `T6_EVALUATION_RETRY_MS` (plafond de
 * coût, mode dégradé explicite).
 *
 * Lot 72A (AC05) — cycle : valider → persister (transaction du lot accepté)
 * → contrôler le nombre réellement enregistré → statut final et disjoncteur
 * → reporting conforme au résultat réel. Une écriture en échec n'est jamais
 * une évaluation exploitable : `persist_failed`, échec mémorisé (reprise
 * différée et bornée), rien n'est présenté comme disponible dans le cache.
 */
export async function evaluateWithT6(
  p: { accountId: number; bundle: T6InterpellationBundle; mode: T6Mode },
  deps: T6EvaluationDependencies = t6EvaluationDefaultDeps,
): Promise<T6EvaluationOutcome> {
  // Lot 72A (AC08) : mode d'appel tracé (affichage / pré-génération).
  const callerMode = gatewayCallerMode(p.mode);
  const vide = (status: T6EvaluationStatus, error: string | null, promptVersion: string | null = null): T6EvaluationOutcome =>
    ({ status, promptVersion, accepted: [], rejected: [], persisted: 0, error, callerMode });
  let promptVersion: string;
  let reminder = false;
  try {
    const [ok, v, r] = await Promise.all([
      deps.available(), deps.promptVersion(), deps.reminderCapable ? deps.reminderCapable().catch(() => false) : Promise.resolve(false),
    ]);
    if (!ok) return vide('disabled', 'T6 indisponible ou version du prompt sans branche EVALUATE');
    promptVersion = v;
    reminder = r;
  } catch (e) {
    return vide('error', (e as Error).message);
  }
  const key = sha256(canonicalJson({ accountId: p.accountId, input: p.bundle.context, promptVersion, out: T6_EVALUATION_OUTPUT_SCHEMA_VERSION }));
  const echec = evalFailures.get(key);
  if (echec != null && Date.now() - echec < T6_EVALUATION_RETRY_MS) return vide('skipped', 'échec récent : nouvel essai différé', promptVersion);
  if (Date.now() < evalBreaker.openUntil) return vide('skipped', 'disjoncteur EVALUATE ouvert', promptVersion);

  const existing = evalInflight.get(key);
  if (existing) return existing;
  const run = (async (): Promise<T6EvaluationOutcome> => {
    const startedAt = Date.now();
    let outcome: T6EvaluationOutcome;
    try {
      const res = await deps.execute({
        useCaseCode: 'HOME_MASCOT',
        operationCode: T6_EVALUATE_OPERATION,
        accountId: p.accountId,
        // MODE=EVALUATE est imposé par la passerelle (branche de l'opération).
        promptVariables: { INPUT_JSON: null, SUGGESTION_CONTEXT: null, INTERPELLATION_CONTEXT: JSON.stringify(p.bundle.context) },
        outputSchema: T6EvaluateOutput,
        idempotencyKey: `mascot-eval:${key}:${randomUUID()}`,
        callerMode,
      });
      const base = { promptVersion, traceId: res.traceId ?? null, model: res.model, latencyMs: Date.now() - startedAt, callerMode };
      // 1. Valider : sortie amputée ou réparée par la passerelle, puis contrat strict.
      const amputee = evaluationRepairViolation((res as { outputRepairs?: Array<{ stage?: string; rule?: string; path?: string }> }).outputRepairs);
      const v = amputee ? { ok: false as const, reason: amputee } : validateT6Evaluation(p.bundle.context, res.data);
      if (!v.ok) {
        evalRecord(false, key, p.accountId);
        outcome = { ...base, status: 'validation_failed', accepted: [], rejected: [], persisted: 0, error: v.reason };
      } else if (v.accepted.length === 0) {
        evalRecord(v.rejected.length === 0, key, p.accountId);
        outcome = {
          ...base, status: 'generated', accepted: [], rejected: v.rejected, persisted: 0, persistedSubjectIds: [], notPersisted: [],
          error: v.rejected.length ? `${v.rejected.length} décision(s) rejetée(s)` : null,
        };
      } else {
        // 2. Persister le lot accepté (transaction), 3. contrôler le nombre enregistré.
        let ecrit: { persisted: number; ids: string[] | null } | null = null;
        let erreur: string | null = null;
        try {
          const r: number | T6PersistResult = await p.bundle.persist(v.accepted, {
            promptVersion, traceId: res.traceId ?? null, contractRevision: reminder ? T6_ASSESSMENT_REVISION_REMINDER : 1,
          });
          ecrit = typeof r === 'number' ? { persisted: r, ids: null } : { persisted: r.persisted, ids: r.persistedSubjectIds ?? null };
        } catch (e) {
          erreur = (e as Error).message?.slice(0, 300) ?? 'écriture en échec';
          console.error('[mascotte] décisions EVALUATE non enregistrées :', erreur);
        }
        const persisted = Math.min(ecrit?.persisted ?? 0, v.accepted.length);
        const ids = ecrit ? (ecrit.ids ?? (persisted >= v.accepted.length ? v.accepted.map((d) => d.subjectId) : null)) : [];
        const notPersisted = !ecrit
          ? v.accepted.map((d) => ({ subjectId: d.subjectId, reason: 'write_failed' as const }))
          : ids ? v.accepted.filter((d) => !ids.includes(d.subjectId)).map((d) => ({ subjectId: d.subjectId, reason: 'not_written' as const })) : [];
        // 4. Statut final et disjoncteur : jamais « generated » sans écriture complète.
        const status: T6EvaluationStatus = persisted === 0 ? 'persist_failed' : persisted < v.accepted.length ? 'partially_persisted' : 'generated';
        evalRecord(status !== 'persist_failed', key, p.accountId);
        const motifs = [
          v.rejected.length ? `${v.rejected.length} décision(s) rejetée(s)` : null,
          status === 'persist_failed' ? `aucune décision enregistrée${erreur ? ` : ${erreur}` : ''}` : null,
          status === 'partially_persisted' ? `${v.accepted.length - persisted} décision(s) non enregistrée(s)` : null,
        ].filter(Boolean);
        outcome = {
          ...base, status, accepted: v.accepted, rejected: v.rejected, persisted, persistedSubjectIds: ids, notPersisted,
          error: motifs.length ? motifs.join(' ; ') : null,
        };
      }
    } catch (e) {
      // Plafond IA du mois : pas d'échec du disjoncteur partagé.
      if (!isCostCapReached(e)) evalRecord(false, key, p.accountId);
      outcome = vide('error', isCostCapReached(e) ? 'plafond IA du mois du compte atteint' : (e as Error).message?.slice(0, 500) ?? 'erreur', promptVersion);
      outcome.latencyMs = Date.now() - startedAt;
    }
    // 5. Reporting conforme au résultat réel (après l'écriture).
    try { await deps.report?.(outcome); } catch { /* le reporting ne bloque jamais */ }
    return outcome;
  })().finally(() => evalInflight.delete(key));
  evalInflight.set(key, run);
  return run;
}

/** Contrats de l'opération EVALUATE (trace). */
export const T6_EVALUATION_CONTRACTS = { input: T6_EVALUATION_INPUT_SCHEMA_VERSION, output: T6_EVALUATION_OUTPUT_SCHEMA_VERSION } as const;
