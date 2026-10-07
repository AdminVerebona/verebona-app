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
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';

type Row = Record<string, unknown>;

export interface OperationalStatus {
  ok: boolean;
  checkedAt: string;
  error: string | null;
  source: string;
}

/** Empreinte non réversible d'une clé (jamais la clé elle-même). */
export function keyFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/** Enregistre le résultat d'une génération minimale (best effort : ne lève jamais). */
export async function recordOperationalStatus(p: {
  model: string; secret: string; ok: boolean; error?: string | null; source: 'provider_test' | 'catalog_refresh';
}): Promise<void> {
  try {
    await pgClient.unsafe(
      `INSERT INTO ai_model_operational_status (provider, model, key_fingerprint, ok, error, source, checked_at)
       VALUES ('gemini', $1, $2, $3, $4, $5, NOW())
       ON CONFLICT (provider, model) DO UPDATE SET key_fingerprint = EXCLUDED.key_fingerprint, ok = EXCLUDED.ok,
         error = EXCLUDED.error, source = EXCLUDED.source, checked_at = NOW()`,
      [p.model, keyFingerprint(p.secret), p.ok, p.error ? p.error.slice(0, 500) : null, p.source] as never[],
    );
  } catch (e) {
    // Table absente (migration 0273 non appliquée) ou base indisponible :
    // l'état reste inconnu, ce qui n'écarte aucun modèle.
    console.warn('[model-operational] état non enregistré :', (e as Error).message);
  }
}

/**
 * États connus AVEC LA CLÉ ACTIVE (lecture seule, aucun appel fournisseur).
 * Sans clé active, table absente ou base indisponible : vide (état inconnu).
 */
export async function loadOperationalStatuses(activeSecret?: string | null): Promise<Map<string, OperationalStatus>> {
  const out = new Map<string, OperationalStatus>();
  try {
    const secret = activeSecret === undefined
      ? await (await import('./provider-secret')).getProviderSecret('gemini')
      : activeSecret;
    if (!secret) return out;
    const rows = (await pgClient.unsafe(
      `SELECT model, ok, error, source, checked_at FROM ai_model_operational_status
        WHERE provider = 'gemini' AND key_fingerprint = $1`,
      [keyFingerprint(secret)] as never[],
    )) as unknown as Row[];
    for (const r of rows) {
      out.set(String(r.model), {
        ok: Boolean(r.ok),
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

/** Aucune donnée utilisateur, une réponse de quelques jetons. */
const PROBE_PROMPT = 'Réponds exactement : OK';
const PROBE_TIMEOUT_MS = 20_000;

export interface ProbeOutcome {
  model: string;
  ok: boolean;
  error: string | null;
}

/**
 * Génération minimale sur chaque modèle (port fournisseur, comme les sondes
 * du disjoncteur — MOD-013) et enregistrement de l'état. Tracée en appel
 * TECHNIQUE sans compte, non facturable. `call` est injectable en test.
 */
export async function probeModels(
  models: readonly string[],
  secret: string,
  deps: { call?: (model: string) => Promise<{ inputTokens?: number; outputTokens?: number; rawText: string }> } = {},
): Promise<ProbeOutcome[]> {
  const call = deps.call ?? (async (model: string) => {
    const { getAiProvider } = await import('../gateway/providers');
    return getAiProvider().call({ model, prompt: PROBE_PROMPT, attachments: [], timeoutMs: PROBE_TIMEOUT_MS, maxOutputTokens: 16 });
  });
  // En parallèle : une dizaine d'appels de quelques jetons, bornés chacun à
  // 20 s — l'actualisation reste un geste de quelques secondes.
  return Promise.all(models.map(async (model): Promise<ProbeOutcome> => {
    const started = Date.now();
    let ok = false;
    let error: string | null = null;
    let tokens = { inputTokens: 0, outputTokens: 0 };
    try {
      const r = await call(model);
      tokens = { inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0 };
      ok = r.rawText.trim().length > 0;
      if (!ok) error = 'réponse vide';
    } catch (e) {
      error = ((e as Error).message ?? 'erreur inconnue').split(secret).join('***').slice(0, 500);
    }
    await recordOperationalStatus({ model, secret, ok, error, source: 'catalog_refresh' });
    if (!deps.call) await traceProbe(model, ok, Date.now() - started, tokens, error);
    return { model, ok, error };
  }));
}

async function traceProbe(
  model: string, ok: boolean, durationMs: number,
  tokens: { inputTokens: number; outputTokens: number }, error: string | null,
): Promise<void> {
  try {
    const [{ recordCallTrace }, { calcCostMicros }] = await Promise.all([
      import('../telemetry/ai-trace.service'), import('../gateway/cost-catalog'),
    ]);
    await recordCallTrace({
      traceId: crypto.randomUUID(),
      useCaseCode: 'AI_GOVERNANCE',
      operationCode: 'model_operational_probe',
      accountId: null,
      provider: 'gemini',
      model,
      promptVersion: 'probe-v1',
      usedFallback: false,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      costMicros: tokens.inputTokens + tokens.outputTokens > 0
        ? calcCostMicros(model, tokens.inputTokens, tokens.outputTokens, 'gemini')
        : 0,
      durationMs,
      status: ok ? 'success' : 'error',
      errorMessage: error ?? undefined,
      billable: false,
      shadow: false,
    });
  } catch (e) {
    console.warn('[model-operational] trace de sonde impossible :', (e as Error).message);
  }
}
