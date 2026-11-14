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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 114 (carte #771) — UN VERDICT PAR ACCÈS, ÉCRIT UNE FOIS, DANS L'ORDRE
 *
 *   · périmètre : un verdict vaut pour (modèle, ACCÈS = empreinte de la clé,
 *     capacité « génération de texte », generateContent). Le contrôle d'une
 *     autre clé n'efface plus celui de la clé active (migration 1692) ;
 *   · écriture ATOMIQUE et ordonnée (`recordOperationalCheck`) : verrou par
 *     (modèle, accès), état relu sous verrou, transition, écriture de l'état
 *     et de l'historique dans la même transaction. Un contrôle ENVOYÉ avant
 *     le verdict en vigueur est écarté (historisé `applied = false`) : une
 *     réponse lente n'efface jamais un refus plus récent ;
 *   · sources : sonde, qualification, test de clé, et — E04 — refus définitif
 *     d'un APPEL RÉEL (`gateway_call`), classé par la même fonction ;
 *   · propagation : tout changement de verdict incrémente la clé de version
 *     partagée (`verebona_cache_versions`, périmètre `ai-model-operational`) ;
 *     chaque instance relit son cache dès qu'elle la voit changer ;
 *   · recontrôle borné d'un modèle refusé (`next_probe_at`, délai doublé de
 *     1 h à 24 h) : ni retest en boucle, ni exclusion permanente ;
 *   · diagnostic : code HTTP, code fournisseur, catégorie, message nettoyé,
 *     appel technique (`probe_call_id`), accès pseudonymisé — au BO, dans la
 *     trace et l'export (`MODEL_UNAVAILABLE_CONFIRMED`… au lieu d'`UNKNOWN`).
 * Disponibilité, tarif (#770) et aptitude métier restent trois dimensions
 * distinctes et cumulatives : ce module ne lit ni n'écrit aucun tarif.
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import {
  PROBE_CAPABILITY, PROBE_ENDPOINT, PROBE_MAX_OUTPUT_TOKENS, PROBE_PROMPT, PROBE_REASONING, PROBE_TIMEOUT_MS,
  GLOBAL_PROBE_KINDS, PROBE_ERROR_KIND_LABELS, classifyProbeFailure, classifyProbeResponse, nextOperationalState, nextProbeDelayMs, probeErrorCodeOf, providerCodesOf,
  reinterpretLegacyState, sanitizeProviderError,
  type CheckStatus, type KnownOperationalState, type NextOperationalState, type ProbeErrorKind, type ProbeOutcome,
} from './probe-classification';

type Row = Record<string, unknown>;

/**
 * Source d'un contrôle (affichée au BO). Lot 114 (#771) : `gateway_call` — refus définitif reçu par un appel
 * réel (E04) ; `recovery_check` — recontrôle borné d'un modèle sauté par la passerelle.
 */
export type OperationalSource = 'provider_test' | 'catalog_refresh' | 'qualification' | 'gateway_call' | 'recovery_check';

/** Périmètre de la clé de version partagée (`verebona_cache_versions`, 0209) — #771, P03. */
export const OPERATIONAL_CACHE_SCOPE = 'ai-model-operational';

/** État RETENU d'un modèle (lu par `usableModelsForTreatment`). */
interface OperationalStatus {
  ok: boolean;
  checkedAt: string;
  error: string | null;
  source: string;
  /** #771 : prochain recontrôle au plus tôt d'un modèle confirmé indisponible (absent avant la migration 1692). */
  nextProbeAt?: string | null;
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
  // ── Lot 114 (#771, S06 / S07 / B01) — absents avant la migration 1692 ──
  /** Code HTTP et code fournisseur (`NOT_FOUND`…) du dernier contrôle en échec. */
  httpStatus?: number | null;
  providerCode?: string | null;
  /** Accès concerné, PSEUDONYMISÉ (début de l'empreinte de la clé — jamais la clé). */
  access?: string | null;
  /** Capacité et point d'accès éprouvés. */
  capability?: string | null;
  endpoint?: string | null;
  /** Appel technique tracé qui fonde le verdict. */
  probeCallId?: number | null;
  /** Indisponibilité confirmée depuis ; prochain recontrôle au plus tôt. */
  confirmedAt?: string | null;
  nextProbeAt?: string | null;
}

/** Accès pseudonymisé affiché (8 premiers caractères de l'empreinte, non réversible). */
export function accessLabel(fingerprint: string): string {
  return `clé …${fingerprint.slice(0, 8)}`;
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

type SqlRunner = { unsafe: (query: string, params?: never[]) => Promise<unknown> };

/** État rendu par `recordOperationalCheck` (#771). */
export interface RecordedOperationalState extends NextOperationalState {
  /** Contrôle ÉCARTÉ : envoyé avant le verdict en vigueur (état inchangé). */
  stale?: boolean;
  /** Le modèle devient, ou cesse d'être, confirmé indisponible : caches invalidés dans toutes les instances. */
  changed?: boolean;
  /** Prochain recontrôle au plus tôt d'un modèle confirmé indisponible. */
  nextProbeAt?: string | null;
}

/** Schéma antérieur à la migration 1692 (colonne, contrainte ou table absente). */
function schemaAnterieur(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === '42703' || code === '42P10' || code === '42P01';
}

/** Incrémente la clé de version partagée dans la transaction du verdict. */
async function bumpOperationalVersion(sql: SqlRunner, reason: string): Promise<void> {
  await sql.unsafe(
    `INSERT INTO verebona_cache_versions (scope, version, last_reason, updated_at)
     VALUES ($1, 1, $2, now())
     ON CONFLICT (scope) DO UPDATE SET version = verebona_cache_versions.version + 1,
       last_reason = EXCLUDED.last_reason, updated_at = now()`,
    [OPERATIONAL_CACHE_SCOPE, reason.slice(0, 60)] as never[],
  );
}

/** Version partagée de l'état opérationnel ; `null` si illisible. Ne lève jamais. */
export async function readOperationalVersion(): Promise<number | null> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT version FROM verebona_cache_versions WHERE scope = $1`, [OPERATIONAL_CACHE_SCOPE] as never[],
    )) as unknown as Array<{ version: string | number }>;
    return rows[0] ? Number(rows[0].version) : 0;
  } catch { return null; }
}

/** Écriture au format antérieur à 1692 (une ligne par modèle) — repli, jamais d'échec. */
async function ecrireFormatAnterieur(p: { model: string; fp: string; next: NextOperationalState; error: string | null; source: OperationalSource }): Promise<void> {
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
    [p.model, p.fp, p.next.ok, p.error, p.source, p.next.checkStatus, p.next.errorKind, p.next.suspectSince, p.next.healthy] as never[],
  );
}

/**
 * Enregistre l'issue d'un contrôle (best effort : ne lève jamais) et rend le
 * nouvel état.
 *
 * Lot 114 (#771, P02) : UNE transaction — verrou par (modèle, accès), état
 * relu sous verrou, transition (`nextOperationalState`), écriture de l'état,
 * de l'historique et de la clé de version si l'état retenu change.
 *   · `observedAt` : instant d'ENVOI du contrôle (défaut : maintenant). Un
 *     contrôle envoyé avant celui qui fonde l'état en vigueur est écarté ;
 *   · `prev` : n'est plus utilisé que si l'état ne peut pas être relu (schéma
 *     absent) — l'état relu sous verrou fait foi ;
 *   · rejouer le même contrôle (même `observedAt`, même issue) ne change rien
 *     à l'état retenu.
 */
export async function recordOperationalCheck(p: {
  model: string; secret: string; outcome: ProbeOutcome; source: OperationalSource;
  prev?: KnownOperationalState | null; now?: Date;
  /** #771 : instant d'envoi du contrôle, appel technique tracé, codes du fournisseur. */
  observedAt?: Date; probeCallId?: number | null; httpStatus?: number | null; providerCode?: string | null;
}): Promise<RecordedOperationalState> {
  const fp = keyFingerprint(p.secret);
  const now = p.now ?? new Date();
  const observedAt = p.observedAt ?? now;
  const brut = p.outcome.status === 'ok' ? null : p.outcome.error;
  const lus = brut ? providerCodesOf(brut) : { httpStatus: null, providerCode: null };
  const httpStatus = p.httpStatus ?? lus.httpStatus;
  const providerCode = p.providerCode ?? lus.providerCode;
  const definitive = p.outcome.status === 'failed' ? p.outcome.definitive : null;
  const kind = p.outcome.status === 'ok' ? null : p.outcome.kind;

  const transaction = async (sql: SqlRunner): Promise<RecordedOperationalState> => {
    await sql.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai-model-operational:${p.model}:${fp}`] as never[]);
    const row = ((await sql.unsafe(
      `SELECT ok, check_status, error, suspect_since, error_kind, observed_at, failure_count, state_version, next_probe_at
         FROM ai_model_operational_status
        WHERE provider = 'gemini' AND model = $1 AND key_fingerprint = $2`,
      [p.model, fp] as never[],
    )) as unknown as Row[])[0];
    const prev = row ? toKnown(row) : p.prev ?? null;
    const version = Number(row?.state_version ?? 0);
    const historise = async (etat: { checkStatus: CheckStatus | null; ok: boolean | null }, applied: boolean, v: number) => {
      await sql.unsafe(
        `INSERT INTO ai_model_operational_history
           (provider, model, key_fingerprint, capability, endpoint, source, outcome, definitive, error_kind, http_status, provider_code,
            error, check_status, ok_after, applied, state_version, probe_call_id, observed_at)
         VALUES ('gemini', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [p.model, fp, PROBE_CAPABILITY, PROBE_ENDPOINT, p.source, p.outcome.status, definitive, kind, httpStatus, providerCode,
         brut ? sanitizeProviderError(brut, p.secret) : null, etat.checkStatus, etat.ok, applied, v, p.probeCallId ?? null, observedAt.toISOString()] as never[],
      );
    };

    // Hors ordre : ce contrôle a été ENVOYÉ avant celui qui fonde l'état en vigueur — écarté, état inchangé.
    const enVigueur = row?.observed_at == null ? null : new Date(String(row.observed_at));
    if (row && prev && enVigueur && observedAt.getTime() < enVigueur.getTime()) {
      await historise({ checkStatus: prev.checkStatus, ok: prev.ok }, false, version);
      return {
        ...prev, error: row.error == null ? null : String(row.error),
        errorKind: (row.error_kind == null ? null : String(row.error_kind)) as ProbeErrorKind | null,
        healthy: false, stale: true, changed: false, nextProbeAt: iso(row.next_probe_at),
      };
    }

    // Réception idempotente (E06) : les appels réels encore en vol au moment du verdict rapportent le même
    // refus — il est déjà opposable, rien n'est réécrit (ni échéance de recontrôle repoussée).
    if (row && prev && prev.ok === false && p.source === 'gateway_call' && p.outcome.status === 'failed') {
      await historise({ checkStatus: prev.checkStatus, ok: prev.ok }, false, version);
      return {
        ...prev, error: row.error == null ? null : String(row.error),
        errorKind: (row.error_kind == null ? null : String(row.error_kind)) as ProbeErrorKind | null,
        healthy: false, changed: false, nextProbeAt: iso(row.next_probe_at),
      };
    }

    const next = nextOperationalState(prev, p.outcome, now);
    const error = next.error ? sanitizeProviderError(next.error, p.secret) : null;
    // Changement OPPOSABLE : le modèle devient, ou cesse d'être, confirmé indisponible (inconnu → sain n'exclut rien).
    const changed = (prev?.ok === false) !== (next.ok === false);
    // Recontrôle borné : chaque échec confirmé consécutif double le délai (1 h → 24 h).
    const failureCount = next.checkStatus === 'failed_confirmed' ? Number(row?.failure_count ?? 0) + 1
      : next.checkStatus === 'ok' ? 0 : Number(row?.failure_count ?? 0);
    // Non concluant sur un modèle déjà refusé : l'échéance en vigueur est conservée (pas de retest immédiat).
    const nextProbeAt = next.checkStatus === 'failed_confirmed' ? new Date(now.getTime() + nextProbeDelayMs(failureCount)).toISOString()
      : next.ok === false ? iso(row?.next_probe_at) : null;
    await sql.unsafe(
      `INSERT INTO ai_model_operational_status
         (provider, model, key_fingerprint, ok, error, source, checked_at, check_status, error_kind, suspect_since, last_ok_at,
          http_status, provider_code, capability, endpoint, probe_call_id, observed_at, confirmed_at, failure_count, next_probe_at, state_version)
       VALUES ('gemini', $1, $2, $3, $4, $5, NOW(), $6, $7, $8, CASE WHEN $9::boolean THEN NOW() ELSE NULL END,
               $10, $11, $12, $13, $14, $15, CASE WHEN $16::boolean THEN NOW() ELSE NULL END, $17, $18, $19)
       ON CONFLICT (provider, model, key_fingerprint) DO UPDATE SET
         ok = EXCLUDED.ok, error = EXCLUDED.error, source = EXCLUDED.source, checked_at = NOW(),
         check_status = EXCLUDED.check_status, error_kind = EXCLUDED.error_kind, suspect_since = EXCLUDED.suspect_since,
         last_ok_at = CASE WHEN $9::boolean THEN NOW() ELSE ai_model_operational_status.last_ok_at END,
         http_status = EXCLUDED.http_status, provider_code = EXCLUDED.provider_code, capability = EXCLUDED.capability,
         endpoint = EXCLUDED.endpoint, probe_call_id = EXCLUDED.probe_call_id, observed_at = EXCLUDED.observed_at,
         confirmed_at = CASE WHEN NOT $16::boolean THEN NULL
                             ELSE COALESCE(ai_model_operational_status.confirmed_at, NOW()) END,
         failure_count = EXCLUDED.failure_count, next_probe_at = EXCLUDED.next_probe_at, state_version = EXCLUDED.state_version`,
      [p.model, fp, next.ok, error, p.source, next.checkStatus, next.errorKind, next.suspectSince, next.healthy,
       httpStatus, providerCode, PROBE_CAPABILITY, PROBE_ENDPOINT, p.probeCallId ?? null, observedAt.toISOString(),
       next.checkStatus === 'failed_confirmed', failureCount, nextProbeAt, version + 1] as never[],
    );
    await historise({ checkStatus: next.checkStatus, ok: next.ok }, true, version + 1);
    if (changed) await bumpOperationalVersion(sql, `${p.source}:${next.ok === false ? 'indisponible' : next.ok ? 'sain' : 'inconnu'}`);
    return { ...next, error, changed, nextProbeAt };
  };

  let etat: RecordedOperationalState;
  try {
    const client = pgClient as unknown as SqlRunner & { begin?: <T>(fn: (tx: SqlRunner) => Promise<T>) => Promise<T> };
    etat = typeof client.begin === 'function' ? await client.begin((tx) => transaction(tx)) : await transaction(client);
  } catch (e) {
    const prev = p.prev !== undefined ? p.prev : await readKnown(p.model, fp);
    const next = nextOperationalState(prev, p.outcome, now);
    const error = next.error ? sanitizeProviderError(next.error, p.secret) : null;
    if (schemaAnterieur(e)) {
      // Migration 1692 non appliquée : format antérieur (une ligne par modèle), sans historique ni ordre.
      try {
        await ecrireFormatAnterieur({ model: p.model, fp, next, error, source: p.source });
      } catch (e2) {
        console.warn('[model-operational] état non enregistré :', sanitizeProviderError((e2 as Error).message, p.secret));
      }
    } else {
      // Table absente (migrations 0273 / 0335 non appliquées) ou base
      // indisponible : l'état reste inconnu, ce qui n'écarte aucun modèle.
      console.warn('[model-operational] état non enregistré :', sanitizeProviderError((e as Error).message, p.secret));
    }
    return { ...next, error, changed: false };
  }
  if (etat.changed) {
    // Cette instance n'attend pas la relecture de la clé de version (#771, P03).
    try { (await import('../gateway/fallback-context')).invalidateFallbackStatusCache(); } catch { /* cache absent */ }
  }
  // #771 (B05) : journal de propagation — sans secret ni donnée de compte.
  if (etat.changed || etat.stale) {
    console.info(`[model-operational] ${p.model} (${accessLabel(fp)}) : ${etat.stale ? 'contrôle écarté (antérieur au verdict en vigueur)' : `état retenu → ${etat.ok === false ? 'indisponible confirmé' : etat.ok ? 'sain (blocage de disponibilité levé)' : 'inconnu'}`} — source ${p.source}${p.probeCallId ? `, appel ${p.probeCallId}` : ''}${etat.nextProbeAt ? `, prochain contrôle ${etat.nextProbeAt}` : ''}.`);
  }
  return etat;
}

/**
 * Contrôle de disponibilité FINAL, lu dans la transaction de l'appelant (promotion, activation) — #771, A03 :
 * le modèle a pu être confirmé indisponible entre la campagne et l'écriture. Lecture directe de l'état canonique
 * (pas du cache d'instance), pour l'accès actif. Rend le motif nettoyé, ou `null` si rien ne s'oppose.
 * État absent, inconnu ou illisible : `null` — un état inconnu n'est jamais une indisponibilité (P04).
 */
export async function operationalRefusalInTx(
  sql: SqlRunner, model: string, activeSecret?: string | null,
): Promise<{ error: string | null; checkedAt: string | null } | null> {
  const secret = activeSecret === undefined
    ? await (await import('./provider-secret')).getProviderSecret('gemini').catch(() => null)
    : activeSecret;
  if (!secret) return null;
  try {
    await sql.unsafe(`SAVEPOINT l114q_disponibilite`);
    const rows = (await sql.unsafe(
      `SELECT ok, check_status, error, suspect_since, checked_at FROM ai_model_operational_status
        WHERE provider = 'gemini' AND model = $1 AND key_fingerprint = $2 FOR SHARE`,
      [model, keyFingerprint(secret)] as never[],
    )) as unknown as Row[];
    await sql.unsafe(`RELEASE SAVEPOINT l114q_disponibilite`);
    const r = rows[0];
    if (!r || toKnown(r).ok !== false) return null;
    return { error: r.error == null ? null : sanitizeProviderError(String(r.error)), checkedAt: iso(r.checked_at) };
  } catch {
    await sql.unsafe(`ROLLBACK TO SAVEPOINT l114q_disponibilite`).catch(() => undefined);
    return null;
  }
}

async function rowsForActiveKey(activeSecret?: string | null): Promise<Row[]> {
  const secret = activeSecret === undefined
    ? await (await import('./provider-secret')).getProviderSecret('gemini')
    : activeSecret;
  if (!secret) return [];
  try {
    return (await pgClient.unsafe(
      `SELECT model, ok, error, source, checked_at, check_status, error_kind, suspect_since, last_ok_at,
              key_fingerprint, http_status, provider_code, capability, endpoint, probe_call_id, confirmed_at, next_probe_at
         FROM ai_model_operational_status
        WHERE provider = 'gemini' AND key_fingerprint = $1`,
      [keyFingerprint(secret)] as never[],
    )) as unknown as Row[];
  } catch (e) {
    if (!schemaAnterieur(e)) throw e;
    // Colonnes 1692 absentes : lecture du format 0335, sinon 0273 (ci-dessous).
  }
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
        ...(r.next_probe_at != null ? { nextProbeAt: iso(r.next_probe_at) } : {}),
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
        // #771 : diagnostic étendu (absent avant la migration 1692 : codes relus dans le message nettoyé).
        httpStatus: r.http_status == null ? providerCodesOf(error ?? '').httpStatus : Number(r.http_status),
        providerCode: r.provider_code == null ? providerCodesOf(error ?? '').providerCode : String(r.provider_code),
        access: r.key_fingerprint == null ? null : accessLabel(String(r.key_fingerprint)),
        capability: r.capability == null ? null : String(r.capability),
        endpoint: r.endpoint == null ? null : String(r.endpoint),
        probeCallId: r.probe_call_id == null ? null : Number(r.probe_call_id),
        confirmedAt: iso(r.confirmed_at), nextProbeAt: iso(r.next_probe_at),
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
  /** #771 : sonde NON ENVOYÉE (incident global constaté pendant le passage) — rien n'est conclu sur ce modèle. */
  notSent?: boolean;
}

type ProbeCall = (model: string) => Promise<{ inputTokens?: number; outputTokens?: number; rawText: string }>;

/** Un contrôle : issue classée, instant d'envoi, appel technique tracé, codes du fournisseur (#771). */
interface Controle {
  outcome: ProbeOutcome;
  observedAt: Date;
  probeCallId: number | null;
  httpStatus: number | null;
  providerCode: string | null;
}

/** Un contrôle : appel, classification, trace technique. */
async function controle(model: string, secret: string, call: ProbeCall, traced: boolean): Promise<Controle> {
  const started = Date.now();
  let tokens = { inputTokens: 0, outputTokens: 0 };
  let outcome: ProbeOutcome;
  let raw: string | null = null;
  let codes: { httpStatus: number | null; providerCode: string | null } = { httpStatus: null, providerCode: null };
  try {
    const r = await call(model);
    raw = r.rawText;
    tokens = { inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0 };
    outcome = classifyProbeResponse(r.rawText);
  } catch (e) {
    outcome = classifyProbeFailure(e, { model, secret });
    codes = providerCodesOf(e);
  }
  let probeCallId: number | null = null;
  if (traced) {
    const error = outcome.status === 'ok' ? null : outcome.error;
    probeCallId = await traceTechnicalCall('model_operational_probe', model, outcome.status === 'ok', Date.now() - started, tokens,
      error, { input: probeCallInput(model), responseRaw: raw }, { outcome, ...codes });
  }
  return { outcome, observedAt: new Date(started), probeCallId, ...codes };
}

/**
 * Génération minimale sur chaque modèle (port fournisseur, comme les sondes
 * du disjoncteur — MOD-013), classification et enregistrement de l'état ;
 * un modèle devenu SUSPECT est recontrôlé aussitôt (confirmation avant
 * dégradation). Tracée en appel TECHNIQUE sans compte, non facturable.
 * `call` et `confirmDelayMs` sont injectables en test.
 *
 * Lot 114 (#771, S04) : un incident GLOBAL (clé, authentification, projet)
 * constaté sur un modèle arrête les sondes restantes du passage — aucun
 * modèle n'en est tenu responsable, aucun appel répété n'est dépensé.
 */
export async function probeModels(
  models: readonly string[],
  secret: string,
  deps: { call?: ProbeCall; confirmDelayMs?: number; source?: OperationalSource } = {},
): Promise<ProbeResult[]> {
  const call: ProbeCall = deps.call ?? (async (model: string) => {
    const { getAiProvider } = await import('../gateway/providers');
    return getAiProvider().call(probeCallInput(model));
  });
  const traced = !deps.call;
  const pause = deps.confirmDelayMs ?? CONFIRM_DELAY_MS;
  const source: OperationalSource = deps.source ?? 'catalog_refresh';
  // Lot 114 (Trello #770) : la sonde est une GÉNÉRATION — un modèle sans tarif officiel vérifié n'est pas sondé
  // (aucun appel, aucun état opérationnel modifié : ce n'est pas une indisponibilité du modèle).
  models = (await (await import('../gateway/pricing/pricing-guard')).splitByPricing(models)).priced;
  // #771 (S04) : incident global constaté pendant ce passage — les sondes non encore envoyées sont abandonnées.
  let incidentGlobal: Exclude<ProbeOutcome, { status: 'ok' }> | null = null;
  const enregistrer = (model: string, c: Controle) => recordOperationalCheck({
    model, secret, outcome: c.outcome, source, observedAt: c.observedAt, probeCallId: c.probeCallId,
    httpStatus: c.httpStatus, providerCode: c.providerCode,
  });
  const sonder = async (model: string): Promise<ProbeResult> => {
    if (incidentGlobal) {
      // Sonde NON ENVOYÉE : le dernier contrôle du modèle est noté non concluant pour le motif global (état
      // retenu inchangé, aucun appel tracé) — le BO montre que rien n'a été conclu, jamais un modèle fautif.
      const etat = await recordOperationalCheck({ model, secret, outcome: incidentGlobal, source });
      return { model, ok: false, error: etat.error, transient: true, checkStatus: 'inconclusive', notSent: true };
    }
    const premier = await controle(model, secret, call, traced);
    if (premier.outcome.status === 'inconclusive' && GLOBAL_PROBE_KINDS.has(premier.outcome.kind)) incidentGlobal = premier.outcome;
    let etat = await enregistrer(model, premier);
    if (etat.checkStatus === 'suspect' && !etat.stale) {
      // Second contrôle : seul un échec répété confirme l'indisponibilité.
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
      etat = await enregistrer(model, await controle(model, secret, call, traced));
    }
    return {
      model,
      ok: etat.checkStatus === 'ok',
      error: etat.error,
      ...(etat.checkStatus === 'inconclusive' || etat.checkStatus === 'suspect' ? { transient: true } : {}),
      checkStatus: etat.checkStatus ?? 'inconclusive',
    };
  };
  // #771 (S04) : le premier modèle est sondé SEUL (éclaireur) — s'il bute sur un incident global, les autres
  // sondes ne partent pas. Puis en parallèle : une dizaine d'appels courts, bornés chacun à 20 s —
  // l'actualisation reste un geste de quelques secondes.
  const [eclaireur, ...suite] = models;
  if (eclaireur === undefined) return [];
  const premierResultat = await sonder(eclaireur);
  return [premierResultat, ...(await Promise.all(suite.map(sonder)))];
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
  /**
   * Lot 114 (#771, S07) : issue CLASSÉE du contrôle — la trace porte un code d'erreur, la famille et l'étape de
   * l'échec, le code HTTP et le code fournisseur (l'export n'affiche plus `UNKNOWN` quand la cause est connue).
   */
  verdict?: { outcome: ProbeOutcome; httpStatus: number | null; providerCode: string | null },
): Promise<number | null> {
  try {
    const [{ recordCallTrace }, { calcCostMicros }] = await Promise.all([
      import('../telemetry/ai-trace.service'), import('../gateway/cost-catalog'),
    ]);
    const diag = verdict && verdict.outcome.status !== 'ok' ? probeFailureDiagnostic(verdict.outcome, verdict) : null;
    return await recordCallTrace({
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
      ...(diag ? { errorCode: diag.errorCode, failure: diag.failure, providerMeta: diag.providerMeta } : {}),
      billable: false,
      shadow: false,
      ...(exchange ? {
        capture: withProbeDiagnostic((await import('../telemetry/call-capture')).technicalCapture({
          origin: operationCode, input: exchange.input, responseRaw: exchange.responseRaw,
          error: error ? sanitizeProviderError(error) : null, durationMs,
        }), diag),
      } : {}),
    });
  } catch (e) {
    console.warn('[model-operational] trace de sonde impossible :', sanitizeProviderError((e as Error).message));
    return null;
  }
}

/** Diagnostic d'un contrôle en échec, tel que figé dans la trace technique (#771, S07). */
interface ProbeFailureDiagnostic {
  errorCode: string;
  failure: { family: string; subtype: string | null; stage: string | null; signature: string | null };
  providerMeta: Record<string, unknown>;
}

/** Famille d'échec (taxonomie de la passerelle) d'une catégorie de sonde. */
const FAMILLE_PAR_CATEGORIE: Readonly<Record<ProbeErrorKind, string>> = {
  empty_response: 'INVALID_OUTPUT', quota: 'RATE_LIMIT', server: 'PROVIDER_ERROR', timeout: 'TIMEOUT', network: 'NETWORK_ERROR',
  auth_global: 'AUTH_ERROR', project_global: 'AUTH_ERROR', forbidden_ambiguous: 'AUTH_ERROR', forbidden_model: 'AUTH_ERROR',
  model_not_found: 'INPUT_ERROR', model_retired: 'INPUT_ERROR', model_access_closed: 'INPUT_ERROR', unsupported_method: 'INPUT_ERROR',
  model_invalid_request: 'INPUT_ERROR', probe_parameter_rejected: 'INPUT_ERROR', probe_error: 'INTERNAL_ERROR',
};

/**
 * Diagnostic restitué d'un contrôle en échec (pure) : code d'erreur (`MODEL_UNAVAILABLE_CONFIRMED`,
 * `MODEL_UNAVAILABLE_SUSPECTED`, `PROVIDER_AUTH_FAILURE`, `PROBE_INCONCLUSIVE`), famille et étape, code HTTP et
 * code fournisseur, catégorie et libellé. Sépare l'échec technique de la sonde, le rejet du fournisseur et
 * l'incident global. Aucun secret : le message est celui, nettoyé, de l'issue.
 */
export function probeFailureDiagnostic(
  outcome: Exclude<ProbeOutcome, { status: 'ok' }>, codes: { httpStatus: number | null; providerCode: string | null },
): ProbeFailureDiagnostic {
  const errorCode = probeErrorCodeOf(outcome) ?? 'PROBE_INCONCLUSIVE';
  const nature = outcome.status === 'failed' ? 'provider_rejection'
    : GLOBAL_PROBE_KINDS.has(outcome.kind) ? 'provider_global_incident'
      : outcome.kind === 'probe_error' || outcome.kind === 'empty_response' || outcome.kind === 'probe_parameter_rejected' ? 'probe_technical_failure' : 'provider_transient';
  return {
    errorCode,
    failure: {
      family: FAMILLE_PAR_CATEGORIE[outcome.kind],
      subtype: outcome.kind === 'empty_response' ? 'EMPTY_RESPONSE' : null,
      stage: outcome.kind === 'empty_response' ? 'provider_generation' : 'provider_request',
      signature: `probe:${outcome.kind}`,
    },
    providerMeta: {
      httpStatus: codes.httpStatus, providerErrorCode: codes.providerCode,
      probe: {
        verdict: outcome.status === 'failed' ? (outcome.definitive ? 'failed_confirmed' : 'suspect') : 'inconclusive',
        kind: outcome.kind, kindLabel: PROBE_ERROR_KIND_LABELS[outcome.kind], nature,
        definitive: outcome.status === 'failed' ? outcome.definitive : false,
        capability: PROBE_CAPABILITY, endpoint: PROBE_ENDPOINT,
      },
    },
  };
}

/** Ajoute le diagnostic classé à la capture technique (sans en changer la forme). */
function withProbeDiagnostic<T extends { diagnostic?: unknown }>(capture: T, diag: ProbeFailureDiagnostic | null): T {
  if (!diag) return capture;
  const existant = (capture.diagnostic && typeof capture.diagnostic === 'object' ? capture.diagnostic : {}) as Record<string, unknown>;
  return { ...capture, diagnostic: { ...existant, errorCode: diag.errorCode, ...diag.failure, ...diag.providerMeta } };
}
