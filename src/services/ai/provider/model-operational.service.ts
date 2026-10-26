/**
 * État opérationnel connu des modèles — lot 32B, ticket « BO IA : ne proposer
 * que les modèles réellement utilisables par traitement » (§1.H), migration
 * 0273.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LISTÉ N'EST PAS OPÉRATIONNEL
 *
 * `GET /v1beta/models` dit qu'un modèle existe pour la clé ; seule une
 * génération dit qu'il répond. Le 18/09/2026, `gemini-2.5-flash-lite` était
 * listé et refusait toute génération aux comptes récents.
 *
 * Le résultat de la DERNIÈRE génération minimale connue est conservé par
 * modèle, avec l'empreinte (SHA-256 tronqué) de la clé testée — jamais la
 * clé. Il est mis à jour par les mécanismes de test fournisseur existants :
 *   · « Tester la clé » (WF-21, `testProviderKey`) ;
 *   · « Actualiser le catalogue » (E-04), qui sonde les modèles déclarés et
 *     listés (génération minimale, sans donnée utilisateur, coût technique).
 * Il n'est JAMAIS rafraîchi à l'affichage du BO : `usableModelsForTreatment`
 * le lit, sans appel fournisseur.
 *
 * Un résultat obtenu avec une autre clé que la clé active est ignoré : après
 * une rotation, l'état redevient « inconnu » jusqu'au prochain test.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 49 (ticket 11) — UN ÉCHEC DE SONDE N'EST PAS UNE PANNE DE MODÈLE
 *
 *   · sonde fiabilisée : prompt minimal sans donnée utilisateur, niveau de
 *     raisonnement `minimal` EXPLICITE, plafond de sortie 512 (un plafond,
 *     pas une consommation : la réponse attendue tient en un mot), délai
 *     borné à 20 s ; appel tracé TECHNIQUE, non facturable ;
 *   · classification (`probe-classification.ts`) : `inconclusive` (quota,
 *     5xx, délai, réseau, réponse vide, erreur de sonde, erreur globale de
 *     clé / projet, 403 ambigu) ne touche JAMAIS l'état retenu ; seul un
 *     échec attribuable au modèle peut le dégrader ;
 *   · confirmation avant dégradation : un premier échec présumé définitif
 *     rend le modèle SUSPECT (état sain conservé) et déclenche un second
 *     contrôle ; seul un échec répété, ou un message explicitement définitif
 *     (modèle retiré, 404 du modèle), donne `failed_confirmed` (`ok=false`) ;
 *   · diagnostic conservé (message nettoyé, catégorie, date, source,
 *     statut) : le BO l'affiche sans consultation SQL.
 * Aucun remplacement automatique de modèle, jamais.
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import {
  PROBE_MAX_OUTPUT_TOKENS, PROBE_PROMPT, PROBE_REASONING, PROBE_TIMEOUT_MS,
  classifyProbeFailure, classifyProbeResponse, nextOperationalState, reinterpretLegacyState, sanitizeProviderError,
  type CheckStatus, type KnownOperationalState, type NextOperationalState, type ProbeErrorKind, type ProbeOutcome,
} from './probe-classification';

type Row = Record<string, unknown>;

/** Source d'un contrôle (affichée au BO). */
type OperationalSource = 'provider_test' | 'catalog_refresh' | 'qualification';

/** État RETENU d'un modèle (lu par `usableModelsForTreatment`). */
interface OperationalStatus {
  ok: boolean;
  checkedAt: string;
  error: string | null;
  source: string;
}

/** Diagnostic complet du dernier contrôle (BO, sans consultation SQL). */
export interface OperationalDiagnostic {
  model: string;
  /** État retenu : `true` sain, `false` indisponible confirmé, `null` inconnu. */
  ok: boolean | null;
  /** Issue du dernier contrôle. */
  checkStatus: CheckStatus;
  /** Message fournisseur NETTOYÉ (jamais de secret). */
  error: string | null;
  errorKind: ProbeErrorKind | null;
  checkedAt: string;
  source: string;
  lastOkAt: string | null;
  suspectSince: string | null;
}

/** Empreinte non réversible d'une clé (jamais la clé elle-même). */
export function keyFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());

function toKnown(r: Row): KnownOperationalState {
  const checkStatus = r.check_status == null ? null : (String(r.check_status) as CheckStatus);
  const okBrut = r.ok == null ? null : Boolean(r.ok);
  return {
    ok: reinterpretLegacyState({ ok: okBrut, checkStatus, error: r.error == null ? null : String(r.error) }),
    checkStatus,
    suspectSince: iso(r.suspect_since),
  };
}

async function readKnown(model: string, fingerprint: string): Promise<KnownOperationalState | null> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT ok, check_status, error, suspect_since FROM ai_model_operational_status
        WHERE provider = 'gemini' AND model = $1 AND key_fingerprint = $2`,
      [model, fingerprint] as never[],
    )) as unknown as Row[];
    return rows[0] ? toKnown(rows[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Enregistre l'issue d'un contrôle (best effort : ne lève jamais) et rend le
 * nouvel état. `prev` fourni : transition calculée sur lui (confirmation
 * immédiate) ; sinon, état connu relu avec la même clé.
 */
export async function recordOperationalCheck(p: {
  model: string; secret: string; outcome: ProbeOutcome; source: OperationalSource;
  prev?: KnownOperationalState | null; now?: Date;
}): Promise<NextOperationalState> {
  const fp = keyFingerprint(p.secret);
  const prev = p.prev !== undefined ? p.prev : await readKnown(p.model, fp);
  const next = nextOperationalState(prev, p.outcome, p.now ?? new Date());
  const error = next.error ? sanitizeProviderError(next.error, p.secret) : null;
  try {
    await pgClient.unsafe(
      `INSERT INTO ai_model_operational_status
         (provider, model, key_fingerprint, ok, error, source, checked_at, check_status, error_kind, suspect_since, last_ok_at)
       VALUES ('gemini', $1, $2, $3, $4, $5, NOW(), $6, $7, $8, CASE WHEN $9::boolean THEN NOW() ELSE NULL END)
       ON CONFLICT (provider, model) DO UPDATE SET
         ok = EXCLUDED.ok, error = EXCLUDED.error, source = EXCLUDED.source, checked_at = NOW(),
         check_status = EXCLUDED.check_status, error_kind = EXCLUDED.error_kind, suspect_since = EXCLUDED.suspect_since,
         last_ok_at = CASE WHEN $9::boolean THEN NOW()
                           WHEN ai_model_operational_status.key_fingerprint = EXCLUDED.key_fingerprint THEN ai_model_operational_status.last_ok_at
                           ELSE NULL END,
         key_fingerprint = EXCLUDED.key_fingerprint`,
      [p.model, fp, next.ok, error, p.source, next.checkStatus, next.errorKind, next.suspectSince, next.healthy] as never[],
    );
  } catch (e) {
    // Table absente (migrations 0273 / 0335 non appliquées) ou base
    // indisponible : l'état reste inconnu, ce qui n'écarte aucun modèle.
    console.warn('[model-operational] état non enregistré :', sanitizeProviderError((e as Error).message, p.secret));
  }
  return { ...next, error };
}

async function rowsForActiveKey(activeSecret?: string | null): Promise<Row[]> {
  const secret = activeSecret === undefined
    ? await (await import('./provider-secret')).getProviderSecret('gemini')
    : activeSecret;
  if (!secret) return [];
  try {
    return (await pgClient.unsafe(
      `SELECT model, ok, error, source, checked_at, check_status, error_kind, suspect_since, last_ok_at
         FROM ai_model_operational_status
        WHERE provider = 'gemini' AND key_fingerprint = $1`,
      [keyFingerprint(secret)] as never[],
    )) as unknown as Row[];
  } catch {
    // Colonnes 0335 absentes : lecture du format 0273.
    return (await pgClient.unsafe(
      `SELECT model, ok, error, source, checked_at FROM ai_model_operational_status
        WHERE provider = 'gemini' AND key_fingerprint = $1`,
      [keyFingerprint(secret)] as never[],
    )) as unknown as Row[];
  }
}

/**
 * États RETENUS avec la clé active (lecture seule, aucun appel fournisseur).
 * Un état inconnu (`ok` NULL, ou ancien `ok=false` non concluant) est absent :
 * il n'écarte aucun modèle. Sans clé active, table absente ou base
 * indisponible : vide.
 */
export async function loadOperationalStatuses(activeSecret?: string | null): Promise<Map<string, OperationalStatus>> {
  const out = new Map<string, OperationalStatus>();
  try {
    for (const r of await rowsForActiveKey(activeSecret)) {
      const known = toKnown(r);
      if (known.ok === null) continue;
      out.set(String(r.model), {
        ok: known.ok,
        checkedAt: new Date(String(r.checked_at)).toISOString(),
        error: r.error == null ? null : String(r.error),
        source: String(r.source),
      });
    }
  } catch {
    /* état inconnu */
  }
  return out;
}

/** Diagnostic de chaque modèle contrôlé avec la clé active (BO). */
export async function loadOperationalDiagnostics(activeSecret?: string | null): Promise<Map<string, OperationalDiagnostic>> {
  const out = new Map<string, OperationalDiagnostic>();
  try {
    for (const r of await rowsForActiveKey(activeSecret)) {
      const known = toKnown(r);
      const error = r.error == null ? null : sanitizeProviderError(String(r.error));
      // Ligne antérieure au lot 49 : statut déduit de la classification.
      let checkStatus = known.checkStatus;
      let errorKind = (r.error_kind == null ? null : String(r.error_kind)) as ProbeErrorKind | null;
      if (checkStatus === null) {
        if (r.ok) checkStatus = 'ok';
        else {
          const c = /^réponse vide/i.test(error ?? '') || error == null ? classifyProbeResponse('') : classifyProbeFailure(error);
          checkStatus = c.status === 'failed' ? 'failed_confirmed' : 'inconclusive';
          errorKind = c.status === 'ok' ? null : c.kind;
        }
      }
      out.set(String(r.model), {
        model: String(r.model), ok: known.ok, checkStatus, error, errorKind,
        checkedAt: new Date(String(r.checked_at)).toISOString(), source: String(r.source),
        lastOkAt: iso(r.last_ok_at), suspectSince: known.suspectSince,
      });
    }
  } catch {
    /* diagnostic indisponible */
  }
  return out;
}

// ── Sonde ───────────────────────────────────────────────────────────────────

export { PROBE_PROMPT, PROBE_TIMEOUT_MS, PROBE_MAX_OUTPUT_TOKENS, PROBE_REASONING } from './probe-classification';
/** Pause avant le second contrôle d'un modèle suspect. */
const CONFIRM_DELAY_MS = 2_000;

/** Paramètres d'appel d'une sonde (port fournisseur). */
export function probeCallInput(model: string) {
  return {
    model, prompt: PROBE_PROMPT, attachments: [], timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS, reasoning: PROBE_REASONING,
  };
}

interface ProbeResult {
  model: string;
  /** Le modèle a répondu. */
  ok: boolean;
  /** Message nettoyé du dernier contrôle, sinon null. */
  error: string | null;
  /** Non concluant ou en attente de confirmation : l'état connu est conservé. */
  transient?: boolean;
  checkStatus: CheckStatus;
}

type ProbeCall = (model: string) => Promise<{ inputTokens?: number; outputTokens?: number; rawText: string }>;

/** Un contrôle : appel, classification, trace technique. */
async function controle(model: string, secret: string, call: ProbeCall, traced: boolean): Promise<ProbeOutcome> {
  const started = Date.now();
  let tokens = { inputTokens: 0, outputTokens: 0 };
  let outcome: ProbeOutcome;
  let raw: string | null = null;
  try {
    const r = await call(model);
    raw = r.rawText;
    tokens = { inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0 };
    outcome = classifyProbeResponse(r.rawText);
  } catch (e) {
    outcome = classifyProbeFailure(e, { model, secret });
  }
  if (traced) {
    const error = outcome.status === 'ok' ? null : outcome.error;
    await traceTechnicalCall('model_operational_probe', model, outcome.status === 'ok', Date.now() - started, tokens,
      error, { input: probeCallInput(model), responseRaw: raw });
  }
  return outcome;
}

/**
 * Génération minimale sur chaque modèle (port fournisseur, comme les sondes
 * du disjoncteur — MOD-013), classification et enregistrement de l'état ;
 * un modèle devenu SUSPECT est recontrôlé aussitôt (confirmation avant
 * dégradation). Tracée en appel TECHNIQUE sans compte, non facturable.
 * `call` et `confirmDelayMs` sont injectables en test.
 */
export async function probeModels(
  models: readonly string[],
  secret: string,
  deps: { call?: ProbeCall; confirmDelayMs?: number } = {},
): Promise<ProbeResult[]> {
  const call: ProbeCall = deps.call ?? (async (model: string) => {
    const { getAiProvider } = await import('../gateway/providers');
    return getAiProvider().call(probeCallInput(model));
  });
  const traced = !deps.call;
  const pause = deps.confirmDelayMs ?? CONFIRM_DELAY_MS;
  // En parallèle : une dizaine d'appels courts, bornés chacun à 20 s —
  // l'actualisation reste un geste de quelques secondes.
  return Promise.all(models.map(async (model): Promise<ProbeResult> => {
    let etat = await recordOperationalCheck({ model, secret, outcome: await controle(model, secret, call, traced), source: 'catalog_refresh' });
    if (etat.checkStatus === 'suspect') {
      // Second contrôle : seul un échec répété confirme l'indisponibilité.
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
      etat = await recordOperationalCheck({
        model, secret, outcome: await controle(model, secret, call, traced), source: 'catalog_refresh', prev: etat,
      });
    }
    return {
      model,
      ok: etat.checkStatus === 'ok',
      error: etat.error,
      ...(etat.checkStatus === 'inconclusive' || etat.checkStatus === 'suspect' ? { transient: true } : {}),
      checkStatus: etat.checkStatus ?? 'inconclusive',
    };
  }));
}

/**
 * Trace d'un appel TECHNIQUE (sonde opérationnelle, qualification — lot
 * 35B) : usage technique AI_GOVERNANCE (jamais une exécution T1–T6 ; lot
 * 49 : plus « T5 »), sans compte, non facturable, coût au tarif connu (sinon
 * non calculable). Message d'erreur NETTOYÉ. Ne lève jamais.
 */
export async function traceTechnicalCall(
  operationCode: 'model_operational_probe' | 'model_qualification_probe',
  model: string, ok: boolean, durationMs: number,
  tokens: { inputTokens: number; outputTokens: number }, error: string | null,
  /** Lot 82C (LOG-01) : requête transmise et réponse brute, pour la capture complète. */
  exchange?: { input: import('../gateway/providers/provider.port').ProviderCallInput; responseRaw: string | null },
): Promise<void> {
  try {
    const [{ recordCallTrace }, { calcCostMicros }] = await Promise.all([
      import('../telemetry/ai-trace.service'), import('../gateway/cost-catalog'),
    ]);
    await recordCallTrace({
      traceId: crypto.randomUUID(),
      useCaseCode: 'AI_GOVERNANCE',
      operationCode,
      accountId: null,
      provider: 'gemini',
      model,
      promptVersion: operationCode === 'model_qualification_probe' ? 'qualif-v2' : 'probe-v2',
      usedFallback: false,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      costMicros: tokens.inputTokens + tokens.outputTokens > 0
        ? calcCostMicros(model, tokens.inputTokens, tokens.outputTokens, 'gemini')
        : 0,
      durationMs,
      status: ok ? 'success' : 'error',
      errorMessage: error ? sanitizeProviderError(error) : undefined,
      billable: false,
      shadow: false,
      ...(exchange ? {
        capture: (await import('../telemetry/call-capture')).technicalCapture({
          origin: operationCode, input: exchange.input, responseRaw: exchange.responseRaw,
          error: error ? sanitizeProviderError(error) : null, durationMs,
        }),
      } : {}),
    });
  } catch (e) {
    console.warn('[model-operational] trace de sonde impossible :', sanitizeProviderError((e as Error).message));
  }
}
