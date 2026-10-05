/**
 * Seuils et interrupteurs de l'assistant, administrés dans le BO — CDC
 * Assistant §6.6 (« configurables sans redéploiement »), §31.10, §32.6, §32.7,
 * §39, CA-30 ; décision PO D-J1 (lot 21).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ORDRE DE RÉSOLUTION
 *
 *   1. valeur administrée dans le BO (`verebona_assistant_settings`, 0230) ;
 *   2. sinon la variable d'environnement historique (`env`) — VALEUR
 *      INITIALE ET REPLI DOCUMENTÉ : base illisible ou réglage jamais
 *      administré, l'assistant se comporte exactement comme avant ;
 *   3. sinon le défaut du code.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PRISE EN COMPTE SANS REDÉMARRAGE, SUR TOUTES LES INSTANCES
 *
 * Chaque modification incrémente le périmètre `assistant-settings` de
 * `verebona_cache_versions`. Les instances relisent ce compteur au plus
 * toutes les `REFRESH_MS` (une ligne par clé primaire) et rechargent les
 * réglages dès qu'il a bougé. Les lectures restent SYNCHRONES
 * (`settingOverride`) : les routes de l'assistant appellent
 * `refreshAssistantSettings()` au passage du limiteur de débit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * JOURNAL ET DOUBLE VALIDATION
 *
 * Toute modification est journalisée (`admin_audit_log` : auteur, date,
 * avant / après — CA-30). Un réglage marqué `doubleValidation` (autoriser un
 * modèle preview en production, §32.7) n'est appliqué qu'après l'accord d'un
 * SECOND administrateur, distinct du demandeur.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { AdminActionEntry } from '@/lib/admin-audit';

/** Journal admin, chargé à la demande (module lu par tout l'assistant). */
async function logAdminAction(e: AdminActionEntry): Promise<void> {
  const { logAdminAction: log } = await import('@/lib/admin-audit');
  await log(e);
}

export type SettingGroup = 'debits' | 'budget' | 'alertes' | 'interrupteurs' | 'historique' | 'modeles' | 'plafond_compte';
export type SettingType = 'int' | 'ratio' | 'usd' | 'usd_micros' | 'bool';
export type SettingValue = number | boolean;

export interface AssistantSettingDef {
  key: string;
  /** Variable d'environnement : valeur initiale et repli (ordre de résolution). */
  env: string;
  group: SettingGroup;
  label: string;
  description: string;
  type: SettingType;
  default: SettingValue;
  min?: number;
  max?: number;
  /** Valeurs qui exigent l'accord d'un second administrateur (§32.7). */
  doubleValidation?: (v: SettingValue) => boolean;
}

export const SETTING_GROUP_LABELS: Readonly<Record<SettingGroup, string>> = {
  debits: 'Débits',
  budget: 'Plafond mensuel',
  alertes: 'Seuils d’alerte',
  interrupteurs: 'Interrupteurs (§39)',
  historique: 'Historique',
  modeles: 'Modèles',
  plafond_compte: 'Plafond IA mensuel par compte — toutes IA, par offre (lot 22)',
};

const int = (key: string, env: string, group: SettingGroup, label: string, description: string, def: number, min: number, max: number): AssistantSettingDef =>
  ({ key, env, group, label, description, type: 'int', default: def, min, max });
const sw = (key: string, env: string, label: string, description: string, def: boolean): AssistantSettingDef =>
  ({ key, env, group: 'interrupteurs', label, description, type: 'bool', default: def });

export const ASSISTANT_SETTINGS: readonly AssistantSettingDef[] = [
  int('rate_limit_per_minute', 'VEREBONA_ASSISTANT_RATE_LIMIT_PER_MINUTE', 'debits', 'Questions par minute et par utilisateur',
    'Questions posées à l’assistant (§6.6 : 10).', 10, 1, 120),
  int('read_rate_limit_per_minute', 'VEREBONA_ASSISTANT_READ_RATE_LIMIT_PER_MINUTE', 'debits', 'Lectures par minute et par utilisateur',
    'Historique, sources, explications, suggestions.', 120, 10, 2000),
  int('mutation_rate_limit_per_minute', 'VEREBONA_ASSISTANT_MUTATION_RATE_LIMIT_PER_MINUTE', 'debits', 'Écritures par minute et par utilisateur',
    'Avis, fils, annulations, commandes (par famille).', 30, 1, 600),
  int('account_rate_multiplier', 'VEREBONA_ASSISTANT_ACCOUNT_RATE_MULTIPLIER', 'debits', 'Multiplicateur par compte',
    'Plafond d’un compte = plafond utilisateur × ce multiplicateur (Duo, plusieurs onglets).', 3, 1, 20),
  int('ip_rate_multiplier', 'VEREBONA_ASSISTANT_IP_RATE_MULTIPLIER', 'debits', 'Multiplicateur par adresse IP',
    'Plafond d’une adresse = plafond utilisateur × ce multiplicateur (réseaux partagés).', 5, 1, 100),
  int('max_ai_calls_per_request', 'VEREBONA_ASSISTANT_MAX_AI_CALLS_PER_REQUEST', 'debits', 'Appels modèle par message',
    '§6.6 : 2 au plus.', 2, 0, 4),
  { key: 'monthly_budget_micros', env: 'VEREBONA_ASSISTANT_MONTHLY_BUDGET_MICROS', group: 'budget', label: 'Plafond par compte et par mois',
    description: 'Coût IA maximal d’un compte par mois civil (0 : sans plafond).', type: 'usd_micros', default: 2_000_000, min: 0, max: 1_000_000_000 },
  { key: 'budget_alert_ratio', env: 'VEREBONA_ASSISTANT_BUDGET_ALERT_RATIO', group: 'alertes', label: 'Alerte de plafond',
    description: 'Part du plafond mensuel à partir de laquelle une alerte d’exploitation est émise.', type: 'ratio', default: 0.8, min: 0.1, max: 1 },
  { key: 'cost_alert_per_response_usd', env: 'VEREBONA_ASSISTANT_COST_ALERT_USD', group: 'alertes', label: 'Alerte de coût par réponse',
    description: 'Coût d’une réponse au-delà duquel une alerte est émise (USD).', type: 'usd', default: 0.005, min: 0, max: 1 },
  sw('enabled', 'VEREBONA_ASSISTANT_ENABLED', 'Assistant', 'verebona_assistant_enabled — coupé : assistant indisponible.', true),
  sw('product_help', 'VEREBONA_ASSISTANT_PRODUCT_HELP', 'Aide produit', 'verebona_assistant_product_help — coupé : renvoi au Centre d’aide.', true),
  sw('account_ai', 'VEREBONA_ASSISTANT_ACCOUNT_AI', 'IA sur les données du compte', 'verebona_assistant_account_ai — coupé : aucun appel modèle.', true),
  sw('fallback_model', 'VEREBONA_ASSISTANT_FALLBACK_MODEL', 'Modèle de repli', 'verebona_assistant_fallback_model — coupé : aucune escalade.', true),
  sw('sources', 'VEREBONA_ASSISTANT_SOURCES', 'Sources', 'verebona_assistant_sources — coupé : sources non exposées.', true),
  sw('semantic_retrieval', 'VEREBONA_ASSISTANT_SEMANTIC_RETRIEVAL', 'Recherche sémantique', 'verebona_assistant_semantic_retrieval.', false),
  sw('write_commands', 'VEREBONA_ASSISTANT_WRITE_COMMANDS', 'Commandes d’écriture', 'Modifications depuis le chat (écart acté au §4.8).', true),
  int('history_days', 'VEREBONA_ASSISTANT_HISTORY_DAYS', 'historique', 'Conservation de l’historique (jours)',
    'Durée de conservation des conversations (cadrage produit : 90 jours).', 90, 7, 365),
  { key: 'preview_models_allowed', env: 'VEREBONA_ASSISTANT_PREVIEW_MODELS_ALLOWED', group: 'modeles', label: 'Modèles preview en production',
    description: 'Autorise l’activation, en production, d’une version de configuration utilisant un modèle preview (§15.13, §32.7). '
      + 'Activation soumise à la validation d’un second administrateur.',
    type: 'bool', default: false, doubleValidation: (v) => v === true },
  // Lot 22 — plafond mensuel de coût IA par compte, TOUS traitements (hors
  // administration T5), appliqué par la passerelle (`account-cost-cap`). Un
  // réglage par offre ; 0 = sans plafond (défaut : comportement inchangé tant
  // que le PO n'a pas fixé les montants). Dérogation par compte : Suivi IA >
  // compte. Les clés sont aussi celles de `COST_CAP_SETTING_KEYS`.
  ...([
    ['standard', 'STANDARD', 'Offre Standard'],
    ['premium', 'PREMIUM', 'Offre Premium'],
    ['premium_duo', 'PREMIUM_DUO', 'Offre Premium Duo'],
    ['premium_pro', 'PREMIUM_PRO', 'Offre Premium Pro'],
  ] as const).map(([plan, env, label]): AssistantSettingDef => ({
    key: `ai_cost_cap_${plan}_micros`, env: `VEREBONA_AI_COST_CAP_${env}_MICROS`, group: 'plafond_compte', label,
    description: 'Coût IA maximal d’un compte par mois civil (Europe/Paris), tous traitements hors administration ; '
      + 'alerte à 80 %, à 100 % analyses reportées au 1er et assistant/mascotte sans IA (0 : sans plafond).',
    // Même borne que la dérogation par compte (`COST_CAP_MAX_MICROS`, testé).
    type: 'usd_micros', default: 0, min: 0, max: 1_000_000_000,
  })),
];

const PAR_CLE = new Map(ASSISTANT_SETTINGS.map((d) => [d.key, d]));
const PAR_ENV = new Map(ASSISTANT_SETTINGS.map((d) => [d.env, d]));

export function assistantSettingDef(key: string): AssistantSettingDef | undefined {
  return PAR_CLE.get(key);
}

// ── Lecture d'une valeur d'environnement (même tolérance qu'avant) ───────────

function envValue(def: AssistantSettingDef, env: NodeJS.ProcessEnv): SettingValue | undefined {
  const raw = env[def.env];
  if (raw == null || raw.trim() === '') return undefined;
  if (def.type === 'bool') {
    const v = raw.trim().toLowerCase();
    if (['off', 'false', '0', 'no', 'disabled'].includes(v)) return false;
    if (['on', 'true', '1', 'yes', 'enabled'].includes(v)) return true;
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Valeur administrée valide ? (type, bornes) — pur. */
export function validateSettingValue(def: AssistantSettingDef, value: unknown): { ok: true; value: SettingValue } | { ok: false; message: string } {
  if (def.type === 'bool') {
    return typeof value === 'boolean' ? { ok: true, value } : { ok: false, message: 'Valeur attendue : activé ou désactivé.' };
  }
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return { ok: false, message: 'Valeur numérique attendue.' };
  if (def.type === 'int' || def.type === 'usd_micros') {
    if (!Number.isInteger(n)) return { ok: false, message: 'Nombre entier attendu.' };
  }
  if (def.min != null && n < def.min) return { ok: false, message: `Minimum : ${def.min}.` };
  if (def.max != null && n > def.max) return { ok: false, message: `Maximum : ${def.max}.` };
  return { ok: true, value: n };
}

// ── Stockage ────────────────────────────────────────────────────────────────

export const ASSISTANT_SETTINGS_CACHE_SCOPE = 'assistant-settings';

export interface StoredRequest {
  id: number; key: string; value: SettingValue; requestedBy: number | null; requestedAt: string;
  decidedBy: number | null; decidedAt: string | null; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
}

export interface AssistantSettingsStore {
  version(): Promise<number>;
  readAll(): Promise<Array<{ key: string; value: unknown; updatedBy: number | null; updatedAt: string }>>;
  /** Écrit la valeur et incrémente la version partagée ; rend l'ancienne valeur. */
  write(key: string, value: SettingValue, adminId: number): Promise<{ before: unknown }>;
  createRequest(key: string, value: SettingValue, adminId: number): Promise<StoredRequest>;
  getRequest(id: number): Promise<StoredRequest | null>;
  /**
   * Clôt une demande en attente. `APPROVED` : la valeur demandée est écrite
   * DANS LA MÊME TRANSACTION (comme `write`) — jamais une demande approuvée
   * sans valeur appliquée, ni l'inverse. `false` : demande déjà close.
   */
  decideRequest(id: number, adminId: number, status: 'APPROVED' | 'REJECTED' | 'CANCELLED'): Promise<boolean>;
  listRequests(limit: number): Promise<StoredRequest[]>;
}

const asRequest = (r: Record<string, unknown>): StoredRequest => ({
  id: Number(r.id), key: String(r.key), value: r.value as SettingValue,
  requestedBy: r.requested_by == null ? null : Number(r.requested_by),
  requestedAt: new Date(String(r.requested_at)).toISOString(),
  decidedBy: r.decided_by == null ? null : Number(r.decided_by),
  decidedAt: r.decided_at == null ? null : new Date(String(r.decided_at)).toISOString(),
  status: String(r.status) as StoredRequest['status'],
});

type TxUnsafe = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

/** Écriture d'un réglage + version partagée, dans la transaction `tx`. */
async function ecrireReglage(tx: TxUnsafe, key: string, value: SettingValue, adminId: number): Promise<{ before: unknown }> {
  const [avant] = (await tx.unsafe(`SELECT value FROM verebona_assistant_settings WHERE key = $1 FOR UPDATE`,
    [key] as never[])) as unknown as Array<{ value: unknown }>;
  await tx.unsafe(
    `INSERT INTO verebona_assistant_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), adminId] as never[],
  );
  await tx.unsafe(
    `INSERT INTO verebona_cache_versions (scope, version, last_reason, updated_at)
     VALUES ($1, 1, $2, now())
     ON CONFLICT (scope) DO UPDATE
       SET version = verebona_cache_versions.version + 1, last_reason = EXCLUDED.last_reason, updated_at = now()`,
    [ASSISTANT_SETTINGS_CACHE_SCOPE, `setting:${key}`.slice(0, 60)] as never[],
  );
  return { before: avant?.value ?? null };
}

export const dbAssistantSettingsStore: AssistantSettingsStore = {
  async version() {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(`SELECT version FROM verebona_cache_versions WHERE scope = $1`,
      [ASSISTANT_SETTINGS_CACHE_SCOPE] as never[])) as unknown as Array<{ version: string | number }>;
    return rows[0] ? Number(rows[0].version) : 0;
  },
  async readAll() {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT key, value, updated_by, updated_at FROM verebona_assistant_settings`,
    )) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      key: String(r.key), value: r.value, updatedBy: r.updated_by == null ? null : Number(r.updated_by),
      updatedAt: new Date(String(r.updated_at)).toISOString(),
    }));
  },
  async write(key, value, adminId) {
    const { pgClient } = await import('@/db');
    return pgClient.begin((tx) => ecrireReglage(tx, key, value, adminId)) as Promise<{ before: unknown }>;
  },
  async createRequest(key, value, adminId) {
    const { pgClient } = await import('@/db');
    const [r] = (await pgClient.unsafe(
      `INSERT INTO verebona_assistant_setting_requests (key, value, requested_by) VALUES ($1, $2::jsonb, $3)
       RETURNING *`,
      [key, JSON.stringify(value), adminId] as never[],
    )) as unknown as Array<Record<string, unknown>>;
    return asRequest(r);
  },
  async getRequest(id) {
    const { pgClient } = await import('@/db');
    const [r] = (await pgClient.unsafe(`SELECT * FROM verebona_assistant_setting_requests WHERE id = $1`,
      [id] as never[])) as unknown as Array<Record<string, unknown>>;
    return r ? asRequest(r) : null;
  },
  async decideRequest(id, adminId, status) {
    const { pgClient } = await import('@/db');
    return pgClient.begin(async (tx) => {
      const rows = (await tx.unsafe(
        `UPDATE verebona_assistant_setting_requests SET status = $3, decided_by = $2, decided_at = now()
          WHERE id = $1 AND status = 'PENDING' RETURNING key, value`,
        [id, adminId, status] as never[],
      )) as unknown as Array<{ key: string; value: SettingValue }>;
      if (rows.length === 0) return false;
      if (status === 'APPROVED') await ecrireReglage(tx, rows[0].key, rows[0].value, adminId);
      return true;
    }) as Promise<boolean>;
  },
  async listRequests(limit) {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT * FROM verebona_assistant_setting_requests ORDER BY requested_at DESC, id DESC LIMIT $1`,
      [limit] as never[],
    )) as unknown as Array<Record<string, unknown>>;
    return rows.map(asRequest);
  },
};

let store: AssistantSettingsStore | null = null;

/** Réservé aux tests : stockage (`null` : défaut). Posé, il sert même sous NODE_ENV=test. */
export function setAssistantSettingsStoreForTests(s: AssistantSettingsStore | null): void {
  store = s;
  resetAssistantSettingsCache();
}

function currentStore(): AssistantSettingsStore | null {
  if (store) return store;
  if (process.env.NODE_ENV === 'test') return null;
  return dbAssistantSettingsStore;
}

// ── Cache par instance ──────────────────────────────────────────────────────

/** Fréquence maximale de relecture du compteur partagé. */
export const REFRESH_MS = 5_000;
let overrides = new Map<string, { value: SettingValue; updatedBy: number | null; updatedAt: string }>();
let version: number | null = null;
let checkedAt = 0;
let enVol: Promise<void> | null = null;
const auditeurs = new Set<() => void>();

/** Appelé quand les valeurs administrées changent (config de l'assistant mise en cache). */
export function onAssistantSettingsChange(fn: () => void): void {
  auditeurs.add(fn);
}

export function resetAssistantSettingsCache(): void {
  overrides = new Map();
  version = null;
  checkedAt = 0;
  for (const f of auditeurs) f();
}

/**
 * Relit les réglages si le compteur partagé a bougé (au plus toutes les
 * `REFRESH_MS`, sauf `force`). Ne lève jamais : base illisible, les valeurs
 * déjà chargées (ou l'environnement) continuent de s'appliquer.
 */
export async function refreshAssistantSettings(force = false): Promise<void> {
  const s = currentStore();
  if (!s) return;
  if (!force && Date.now() - checkedAt < REFRESH_MS) return;
  if (enVol) return enVol;
  enVol = (async () => {
    try {
      const v = await s.version();
      checkedAt = Date.now();
      if (!force && version !== null && v === version) return;
      const rows = await s.readAll();
      const next = new Map<string, { value: SettingValue; updatedBy: number | null; updatedAt: string }>();
      for (const r of rows) {
        const def = PAR_CLE.get(r.key);
        if (!def) continue;
        const ok = validateSettingValue(def, r.value);
        if (ok.ok) next.set(r.key, { value: ok.value, updatedBy: r.updatedBy, updatedAt: r.updatedAt });
      }
      overrides = next;
      version = v;
      for (const f of auditeurs) f();
    } catch (e) {
      checkedAt = Date.now();
      console.warn('[assistant] réglages administrés illisibles — valeurs courantes conservées :', (e as Error).message);
    } finally {
      enVol = null;
    }
  })();
  return enVol;
}

/** Valeur administrée d'un réglage (synchrone), ou `undefined`. */
export function settingOverride(key: string): SettingValue | undefined {
  return overrides.get(key)?.value;
}

/** Valeur administrée pour une variable d'environnement historique. */
export function overrideForEnv(envName: string): SettingValue | undefined {
  const def = PAR_ENV.get(envName);
  return def ? settingOverride(def.key) : undefined;
}

/** Valeur effective : BO > environnement > défaut. */
export function effectiveSetting(key: string, env: NodeJS.ProcessEnv = process.env): SettingValue {
  const def = PAR_CLE.get(key);
  if (!def) throw new Error(`Réglage inconnu : ${key}`);
  const o = settingOverride(key);
  if (o !== undefined) return o;
  const e = envValue(def, env);
  if (e !== undefined) {
    const ok = validateSettingValue(def, e);
    if (ok.ok) return ok.value;
  }
  return def.default;
}

export interface EffectiveSetting extends Omit<AssistantSettingDef, 'doubleValidation'> {
  value: SettingValue;
  source: 'bo' | 'env' | 'defaut';
  updatedBy: number | null;
  updatedAt: string | null;
  doubleValidation: boolean;
}

/** Tous les réglages avec leur valeur effective et sa provenance (écran BO). */
export function effectiveAssistantSettings(env: NodeJS.ProcessEnv = process.env): EffectiveSetting[] {
  return ASSISTANT_SETTINGS.map(({ doubleValidation, ...def }) => {
    const o = overrides.get(def.key);
    const e = envValue(def as AssistantSettingDef, env);
    return {
      ...def,
      value: effectiveSetting(def.key, env),
      source: o ? 'bo' : e !== undefined && validateSettingValue(def as AssistantSettingDef, e).ok ? 'env' : 'defaut',
      updatedBy: o?.updatedBy ?? null,
      updatedAt: o?.updatedAt ?? null,
      doubleValidation: Boolean(doubleValidation),
    };
  });
}

// ── Modification ────────────────────────────────────────────────────────────

export class AssistantSettingRefused extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = 'AssistantSettingRefused';
  }
}

export type UpdateResult =
  | { status: 'APPLIED'; key: string; before: SettingValue; after: SettingValue }
  | { status: 'PENDING_APPROVAL'; key: string; requestId: number };

/**
 * Modifie un réglage. Valeur soumise à double validation : demande en
 * attente, appliquée par `decideAssistantSettingRequest` (autre administrateur).
 */
export async function updateAssistantSetting(p: { key: string; value: unknown; adminId: number; adminEmail?: string }): Promise<UpdateResult> {
  const def = PAR_CLE.get(p.key);
  if (!def) throw new AssistantSettingRefused('UNKNOWN_SETTING', `Réglage inconnu « ${p.key} ».`, 400);
  const ok = validateSettingValue(def, p.value);
  if (!ok.ok) throw new AssistantSettingRefused('INVALID_VALUE', ok.message, 400);
  const s = currentStore();
  if (!s) throw new AssistantSettingRefused('STORE_UNAVAILABLE', 'Stockage des réglages indisponible.', 503);
  await refreshAssistantSettings(true);
  const before = effectiveSetting(p.key);

  if (def.doubleValidation?.(ok.value)) {
    let req: StoredRequest;
    try {
      req = await s.createRequest(p.key, ok.value, p.adminId);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new AssistantSettingRefused('REQUEST_PENDING', 'Une demande est déjà en attente de validation pour ce réglage.');
      }
      throw e;
    }
    await logAdminAction({
      adminId: p.adminId, adminEmail: p.adminEmail, action: 'ASSISTANT_SETTING_REQUEST', targetType: 'ASSISTANT_SETTING',
      targetId: req.id, result: 'SUCCESS', before: { key: p.key, value: before }, after: { key: p.key, value: ok.value },
      details: { doubleValidation: true },
    });
    return { status: 'PENDING_APPROVAL', key: p.key, requestId: req.id };
  }

  await s.write(p.key, ok.value, p.adminId);
  await logAdminAction({
    adminId: p.adminId, adminEmail: p.adminEmail, action: 'ASSISTANT_SETTING_UPDATE', targetType: 'ASSISTANT_SETTING',
    targetId: null, result: 'SUCCESS', before: { key: p.key, value: before }, after: { key: p.key, value: ok.value },
  });
  await refreshAssistantSettings(true);
  return { status: 'APPLIED', key: p.key, before, after: ok.value };
}

/**
 * Décision sur une demande en attente : `approve` par un administrateur
 * DISTINCT du demandeur (double validation), `reject` par tout autre
 * administrateur, `cancel` par le demandeur lui-même.
 */
export async function decideAssistantSettingRequest(p: {
  requestId: number; adminId: number; adminEmail?: string; decision: 'approve' | 'reject' | 'cancel';
}): Promise<{ status: StoredRequest['status']; key: string }> {
  const s = currentStore();
  if (!s) throw new AssistantSettingRefused('STORE_UNAVAILABLE', 'Stockage des réglages indisponible.', 503);
  const req = await s.getRequest(p.requestId);
  if (!req) throw new AssistantSettingRefused('REQUEST_NOT_FOUND', 'Demande introuvable.', 404);
  if (req.status !== 'PENDING') throw new AssistantSettingRefused('REQUEST_CLOSED', 'Cette demande a déjà été traitée.');
  const meme = req.requestedBy === p.adminId;
  if (p.decision === 'cancel' && !meme) {
    throw new AssistantSettingRefused('NOT_REQUESTER', 'Seul l’administrateur à l’origine de la demande peut l’annuler.', 403);
  }
  if (p.decision !== 'cancel' && meme) {
    await logAdminAction({
      adminId: p.adminId, adminEmail: p.adminEmail, action: 'ASSISTANT_SETTING_APPROVE', targetType: 'ASSISTANT_SETTING',
      targetId: req.id, result: 'DENIED', after: { key: req.key, value: req.value }, details: { code: 'SAME_ADMIN' },
    });
    throw new AssistantSettingRefused('SAME_ADMIN', 'La double validation exige un second administrateur, distinct du demandeur.', 403);
  }
  const status = p.decision === 'approve' ? 'APPROVED' : p.decision === 'reject' ? 'REJECTED' : 'CANCELLED';
  await refreshAssistantSettings(true);
  const before = effectiveSetting(req.key);
  // Clôture de la demande et écriture de la valeur : une seule transaction.
  if (!(await s.decideRequest(req.id, p.adminId, status))) {
    throw new AssistantSettingRefused('REQUEST_CLOSED', 'Cette demande a déjà été traitée.');
  }
  await logAdminAction({
    adminId: p.adminId, adminEmail: p.adminEmail,
    action: status === 'APPROVED' ? 'ASSISTANT_SETTING_APPROVE' : status === 'REJECTED' ? 'ASSISTANT_SETTING_REJECT' : 'ASSISTANT_SETTING_CANCEL',
    targetType: 'ASSISTANT_SETTING', targetId: req.id, result: 'SUCCESS',
    before: { key: req.key, value: before }, after: { key: req.key, value: status === 'APPROVED' ? req.value : before },
    details: { requestedBy: req.requestedBy },
  });
  await refreshAssistantSettings(true);
  return { status, key: req.key };
}

export async function listAssistantSettingRequests(limit = 20): Promise<StoredRequest[]> {
  const s = currentStore();
  return s ? s.listRequests(Math.min(Math.max(limit, 1), 100)) : [];
}

/** Modèle preview (§15.13) : nom portant « preview » ou « -exp ». */
export function isPreviewModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && /(^|[-_.])(preview|exp|experimental)([-_.]|$)/i.test(model);
}
