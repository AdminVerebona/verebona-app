/**
 * Lectures de la politique de secours — lot 87A (CDC Pilotage IA V2 P7 :
 * RUN-02, RUN-03, INV-10). Réutilise UNIQUEMENT l'existant :
 *   · état opérationnel connu des modèles (`ai_model_operational_status`,
 *     lot 32B / 49 — `loadOperationalStatuses`, clé active) ;
 *   · état de qualification des couples (86A — `couplesWithState`, état
 *     calculé contre la signature courante de la configuration ACTIVE) ;
 *   · exclusions manuelles (86B — surcouche de routage du résolveur).
 *
 * Toutes les lectures sont BORNÉES et mises en cache ; aucune ne fait
 * échouer un appel : une lecture impossible rend « inconnu » (aucun modèle
 * écarté pour l'état opérationnel ; qualification `UNKNOWN`, donc règle
 * prudente de `fallback-policy.ts`).
 *
 * Vérification bornée de rétablissement (RUN-03) : un modèle connu
 * indisponible dont le dernier contrôle date de plus de 30 min déclenche,
 * au plus une fois par 30 min et par instance, la sonde EXISTANTE
 * (`probeModels`, génération minimale sans donnée utilisateur) ; le modèle
 * redevient appelable dès que la sonde le confirme sain.
 */
import type { CoupleQualification } from './fallback-policy';
import type { OverlayIntervention } from '../config/routing-overlay';
import type { Treatment } from '../config/treatments';

export interface OperationalHint { checkedAt: string | null; error: string | null }

export interface CoupleQualificationView {
  /** Origine de la configuration exécutée (`null` : inconnue — exécution épinglée hors active). */
  origin: 'manual' | 'auto' | null;
  byModel: ReadonlyMap<string, CoupleQualification>;
}

interface FallbackContextReader {
  /** Modèles CONNUS indisponibles avec la clé active (`ok = false` confirmé). */
  knownUnavailable(): Promise<ReadonlyMap<string, OperationalHint>>;
  /** États de qualification des couples d'une opération, pour la configuration exécutée. */
  coupleQualifications(p: { operationCode: string; configVersionId: number | null; configRevisionId: number | null }): Promise<CoupleQualificationView>;
  /** Exclusions manuelles EN VIGUEUR (une exclusion prise en cours d'exécution ne fait que retirer). */
  currentExclusions(treatment: Treatment | null): Promise<ReadonlyArray<OverlayIntervention>>;
}

const STATUS_TTL_MS = 30_000;
const QUALIF_TTL_MS = 5 * 60_000;
const LOOKUP_TIMEOUT_MS = 2_000;
const RECHECK_AFTER_MS = 30 * 60_000;

const EMPTY_VIEW: CoupleQualificationView = { origin: null, byModel: new Map() };

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.())]);
}

let injected: Partial<FallbackContextReader> | null = null;
let dbForcedInTests = false;

/** Réservé aux tests : lectures simulées (`null` : lecteur par défaut). */
export function __setFallbackContextForTests(r: Partial<FallbackContextReader> | null): void {
  injected = r;
  statusCache = null;
  qualifCache.clear();
}

/** Réservé aux e2e : autorise les lectures en base sous `NODE_ENV=test`. */
export function __enableFallbackContextDbForTests(on: boolean): void {
  dbForcedInTests = on;
  statusCache = null;
  qualifCache.clear();
  rechecks.clear();
}

/** Les tests unitaires n'ouvrent aucune connexion (convention de `db/index.ts`). */
function dbAllowed(): boolean {
  return process.env.NODE_ENV !== 'test' || dbForcedInTests;
}

// ── État opérationnel ───────────────────────────────────────────────────────

let statusCache: { at: number; value: Map<string, OperationalHint> } | null = null;
const rechecks = new Map<string, number>();

/** Vidé après une sonde de rétablissement (et par les tests). */
export function invalidateFallbackStatusCache(): void {
  statusCache = null;
}

async function defaultKnownUnavailable(): Promise<ReadonlyMap<string, OperationalHint>> {
  if (!dbAllowed()) return new Map();
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const value = new Map<string, OperationalHint>();
  try {
    const { loadOperationalStatuses } = await import('../provider/model-operational.service');
    const all = await withTimeout(loadOperationalStatuses(), LOOKUP_TIMEOUT_MS, null);
    if (all === null) return statusCache?.value ?? value;
    for (const [model, s] of all) if (s.ok === false) value.set(model, { checkedAt: s.checkedAt, error: s.error });
  } catch {
    return statusCache?.value ?? value;
  }
  statusCache = { at: Date.now(), value };
  return value;
}

/**
 * Vérification BORNÉE de rétablissement d'un modèle sauté (RUN-03) : sonde
 * existante, au plus une fois par `RECHECK_AFTER_MS` et par instance, si le
 * dernier contrôle est lui-même plus ancien. Lancée sans attente ; ne lève jamais.
 */
export function noteKnownUnavailableSkipped(model: string, hint: OperationalHint, now = Date.now()): boolean {
  if (!dbAllowed() || injected?.knownUnavailable) return false;
  const last = hint.checkedAt ? Date.parse(hint.checkedAt) : 0;
  if (Number.isFinite(last) && now - last < RECHECK_AFTER_MS) return false;
  const prev = rechecks.get(model);
  if (prev !== undefined && now - prev < RECHECK_AFTER_MS) return false;
  rechecks.set(model, now);
  void (async () => {
    try {
      const [{ getProviderSecret }, { probeModels }] = await Promise.all([
        import('../provider/provider-secret'), import('../provider/model-operational.service'),
      ]);
      const secret = await getProviderSecret('gemini');
      if (!secret) return;
      await probeModels([model], secret);
      invalidateFallbackStatusCache();
    } catch (e) {
      console.warn('[fallback] vérification de rétablissement impossible (non bloquant) :', String((e as Error)?.message ?? e).slice(0, 200));
    }
  })();
  return true;
}

// ── Qualification des couples ───────────────────────────────────────────────

const qualifCache = new Map<string, { at: number; value: CoupleQualificationView }>();

async function defaultCoupleQualifications(p: { operationCode: string; configVersionId: number | null; configRevisionId: number | null }): Promise<CoupleQualificationView> {
  if (!dbAllowed() || p.configVersionId === null) return EMPTY_VIEW;
  const key = `${p.configVersionId}|${p.configRevisionId ?? ''}|${p.operationCode}`;
  const hit = qualifCache.get(key);
  if (hit && Date.now() - hit.at < QUALIF_TTL_MS) return hit.value;
  const lire = async (): Promise<CoupleQualificationView> => {
    const [{ getActiveVersion }, { couplesWithState, defaultMasterReader }, { getAiEnvironment }] = await Promise.all([
      import('../config/config-version.repository'), import('../qualification/context'), import('../config/environment'),
    ]);
    const active = await getActiveVersion(getAiEnvironment());
    // Les états 86A sont calculés contre la configuration ACTIVE : une
    // exécution épinglée sur une autre version / révision n'en déduit rien.
    if (!active || active.id !== p.configVersionId
      || (p.configRevisionId !== null && (active.currentRevisionId ?? null) !== p.configRevisionId)) {
      return EMPTY_VIEW;
    }
    const couples = await couplesWithState(active, { readMasterFile: await defaultMasterReader(), operationCodes: [p.operationCode] });
    const byModel = new Map<string, CoupleQualification>();
    for (const c of [...couples].sort((a, b) => a.rank - b.rank)) {
      if (c.operationCode !== p.operationCode || byModel.has(c.model)) continue;
      byModel.set(c.model, c.state.state);
    }
    return { origin: active.origin ?? 'manual', byModel };
  };
  let value: CoupleQualificationView;
  try {
    value = await withTimeout(lire(), LOOKUP_TIMEOUT_MS, EMPTY_VIEW);
  } catch {
    value = EMPTY_VIEW;
  }
  if (value !== EMPTY_VIEW) qualifCache.set(key, { at: Date.now(), value });
  return value;
}

// ── Exclusions en vigueur ───────────────────────────────────────────────────

async function defaultCurrentExclusions(treatment: Treatment | null): Promise<ReadonlyArray<OverlayIntervention>> {
  try {
    const { currentRoutingOverlay } = await import('../config/config-resolver');
    const o = await currentRoutingOverlay();
    return (o?.exclusions ?? []).filter((x) => x.kind === 'EXCLUSION' && (x.treatment === null || x.treatment === treatment));
  } catch {
    return [];
  }
}

/** Lecteur utilisé par la passerelle (simulé en test, sinon les lectures ci-dessus). */
export function fallbackContext(): FallbackContextReader {
  return {
    knownUnavailable: injected?.knownUnavailable ?? defaultKnownUnavailable,
    coupleQualifications: injected?.coupleQualifications ?? defaultCoupleQualifications,
    currentExclusions: injected?.currentExclusions ?? defaultCurrentExclusions,
  };
}
