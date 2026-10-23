/**
 * Qualification technique automatique des modèles — lot 35B, ticket
 * « Catalogue IA dynamique Google » (migration 0303).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * C'EST ELLE QUI PERMET DE SUPPRIMER L'ALLOWLIST
 *
 * Un modèle nouvellement listé par Google ne devient pas sélectionnable sur
 * la foi de son nom. Verebona vérifie, AVEC LA CLÉ ACTIVE, les capacités dont
 * ses opérations ont réellement besoin :
 *
 *   · generate    — `generateContent` aboutit et rend du texte ;
 *   · structured  — sortie JSON contrainte par un SCHÉMA (structured output,
 *                   `responseJsonSchema`) et conforme à ce schéma ;
 *   · multimodal  — une image en entrée est acceptée et donne une réponse ;
 *   · thinking    — un niveau de raisonnement explicite est accepté (ou le
 *                   catalogue Google déclare `thinking`).
 *
 * L'éligibilité par traitement T1–T6 en est DÉDUITE (`usable-models.ts`) à
 * partir des capacités requises par les opérations du traitement : plus de
 * compatibilité maintenue à la main modèle par modèle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN ÉCHEC TRANSITOIRE N'EST PAS UN ÉCHEC DE QUALIFICATION
 *
 * Quota (429), délai dépassé, indisponibilité (5xx), réseau : résultat NON
 * CONCLUANT (`null`), jamais `false` — une panne passagère ne retire pas un
 * modèle des sélecteurs. Lot 49 (ticket 11) : réponse VIDE et erreur
 * GLOBALE de clé / projet aussi (`probe-classification.ts`). Génération :
 * seul un échec explicitement définitif ATTRIBUABLE AU MODÈLE (retrait, 404
 * du modèle) vaut `false` ; un échec présumé reste `null` et passe par la
 * confirmation de l'état opérationnel (second contrôle). Capacités : un
 * refus de l'épreuve (400, JSON non conforme au schéma) vaut `false`.
 *
 * Aucune donnée utilisateur : prompts constants, image synthétique de 16×16
 * pixels. Appels tracés en TECHNIQUE, non facturables (comme les sondes).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { keyFingerprint } from './model-operational.service';
import type { ProviderCallInput } from '../gateway/providers/provider.port';
import {
  classifyProbeFailure, classifyProbeResponse, sanitizeProviderError, type ProbeErrorKind, type ProbeOutcome,
} from './probe-classification';

type Row = Record<string, unknown>;

/** Version des épreuves : la changer requalifie tous les modèles. */
export const QUALIFICATION_VERSION = 'qualif-v2' as const;

export type QualifiedCapability = 'generate' | 'structured' | 'multimodal' | 'thinking';

export interface QualificationResult {
  /** `null` : non concluant (transitoire) — rien n'est enregistré. */
  generate: boolean | null;
  structured: boolean | null;
  multimodal: boolean | null;
  thinking: boolean | null;
  errors: Partial<Record<QualifiedCapability, string>>;
  /**
   * Lot 49 : issue CLASSÉE de l'épreuve de génération (ok, non concluant,
   * échec présumé ou définitif) — enregistrée dans l'état opérationnel.
   */
  generateOutcome?: ProbeOutcome;
}

export interface StoredQualification {
  generate: boolean;
  structured: boolean | null;
  multimodal: boolean | null;
  thinking: boolean | null;
  errors: Partial<Record<QualifiedCapability, string>>;
  qualifiedAt: string;
  version: string;
}

export type QualificationCall = (input: ProviderCallInput) => Promise<{ rawText: string; inputTokens?: number; outputTokens?: number }>;

const TIMEOUT_MS = 30_000;
const MAX_OUT = 512;

/** Schéma de l'épreuve « sortie structurée » (sous-ensemble accepté par Gemini). */
export const QUALIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    mot: { type: 'string' },
  },
  required: ['ok', 'mot'],
} as const;

/** Image synthétique (16×16, rouge uni) — aucune donnée utilisateur. */
export const QUALIFICATION_IMAGE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4IyJCEmIY1TCqYfhqAAACcQQQFwFJQgAAAABJRU5ErkJggg==';

/**
 * Erreur NON CONCLUANTE pour une épreuve de CAPACITÉ : transitoire (quota,
 * délai, 5xx, réseau) ou globale (clé, projet). Tout autre refus de
 * l'épreuve dit que la capacité manque.
 */
const CAPACITE_NON_CONCLUANTE: ReadonlySet<ProbeErrorKind> = new Set<ProbeErrorKind>([
  'quota', 'server', 'timeout', 'network', 'auth_global', 'project_global',
]);

/** Erreur transitoire ou globale (quota, délai, 5xx, réseau, clé, projet) : épreuve non concluante. */
export function isTransientError(message: string): boolean {
  const c = classifyProbeFailure(message);
  return c.status === 'inconclusive' && CAPACITE_NON_CONCLUANTE.has(c.kind);
}

/** JSON conforme au schéma de l'épreuve (pur). */
export function conformsToQualificationSchema(raw: string): boolean {
  const txt = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let v: unknown;
  try { v = JSON.parse(txt); } catch { return false; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const cles = Object.keys(o);
  if (!cles.every((k) => k === 'ok' || k === 'mot')) return false;
  return o.ok === true && typeof o.mot === 'string' && o.mot.trim().length > 0;
}

type Outcome = { value: boolean | null; error?: string; outcome?: ProbeOutcome };

/** Épreuve de CAPACITÉ : réponse vide ou erreur transitoire / globale = non concluant. */
async function epreuve(
  run: () => Promise<{ rawText: string }>,
  check: (raw: string) => boolean,
  secret: string | null,
  refus: string,
): Promise<Outcome> {
  try {
    const r = await run();
    if (check(r.rawText)) return { value: true };
    // Lot 49 : une réponse vide ne prouve rien (budget de sortie, filtrage).
    if (r.rawText.trim().length === 0) return { value: null, error: 'réponse vide (non concluant)' };
    return { value: false, error: refus };
  } catch (e) {
    const c = classifyProbeFailure(e, { secret });
    return { value: c.status === 'inconclusive' && CAPACITE_NON_CONCLUANTE.has(c.kind) ? null : false, error: c.error.slice(0, 300) };
  }
}

/**
 * Épreuve de GÉNÉRATION (lot 49) : `true` si le modèle répond ; `false`
 * seulement sur un échec EXPLICITEMENT définitif attribuable au modèle ;
 * `null` sinon (non concluant, ou échec présumé à confirmer).
 */
async function epreuveGeneration(
  run: () => Promise<{ rawText: string }>, model: string, secret: string | null,
): Promise<Outcome> {
  let outcome: ProbeOutcome;
  try {
    outcome = classifyProbeResponse((await run()).rawText);
  } catch (e) {
    outcome = classifyProbeFailure(e, { model, secret });
  }
  if (outcome.status === 'ok') return { value: true, outcome };
  const error = sanitizeProviderError(outcome.error, secret).slice(0, 300);
  return { value: outcome.status === 'failed' && outcome.definitive ? false : null, error, outcome };
}

/**
 * Épreuves de qualification d'un modèle (pur si `call` est injecté).
 * Génération en échec définitif : les autres épreuves ne sont pas jouées
 * (le modèle est inutilisable de toute façon).
 */
export async function qualifyModel(
  model: string,
  call: QualificationCall,
  opts: { supportsThinking?: boolean | null; secret?: string | null; thinkingConfigured?: (model: string) => boolean } = {},
): Promise<QualificationResult> {
  const secret = opts.secret ?? null;
  const base = { model, attachments: [], timeoutMs: TIMEOUT_MS, maxOutputTokens: MAX_OUT, reasoning: 'minimal' as const };
  const errors: QualificationResult['errors'] = {};

  const gen = await epreuveGeneration(() => call({ ...base, prompt: 'Réponds exactement : OK' }), model, secret);
  if (gen.error) errors.generate = gen.error;
  if (gen.value !== true) {
    return { generate: gen.value, structured: null, multimodal: null, thinking: null, errors, ...(gen.outcome ? { generateOutcome: gen.outcome } : {}) };
  }

  const structured = await epreuve(
    () => call({
      ...base,
      prompt: 'Renvoie uniquement un objet JSON : "ok" vaut true et "mot" vaut "verebona".',
      jsonResponse: true,
      responseSchema: QUALIFICATION_SCHEMA as unknown as Record<string, unknown>,
    }),
    conformsToQualificationSchema, secret, 'sortie non conforme au schéma JSON',
  );
  if (structured.error) errors.structured = structured.error;

  const multimodal = await epreuve(
    () => call({
      ...base,
      prompt: 'Quelle est la couleur dominante de cette image ? Réponds en un mot.',
      attachments: [{ url: 'inline:qualification.png', mimeType: 'image/png', displayName: 'qualification.png', data: QUALIFICATION_IMAGE_PNG }],
    }),
    (raw) => raw.trim().length > 0, secret, 'réponse vide à une entrée image',
  );
  if (multimodal.error) errors.multimodal = multimodal.error;

  let thinking: boolean | null;
  if (opts.supportsThinking === false) {
    thinking = false;
    errors.thinking = 'raisonnement non déclaré par le catalogue du fournisseur';
  } else if (opts.thinkingConfigured && !opts.thinkingConfigured(model)) {
    // Aucun réglage de raisonnement connu pour cette famille : l'appel ne
    // prouverait rien. Le catalogue Google fait foi s'il le déclare.
    thinking = opts.supportsThinking === true ? true : null;
  } else {
    const t = await epreuve(
      () => call({ ...base, reasoning: 'étendu', maxOutputTokens: 2048, prompt: 'Combien font 17 × 3 ? Réponds par le nombre seul.' }),
      (raw) => raw.trim().length > 0, secret, 'réponse vide avec raisonnement étendu',
    );
    thinking = t.value;
    if (t.error) errors.thinking = t.error;
  }

  return { generate: true, structured: structured.value, multimodal: multimodal.value, thinking, errors, generateOutcome: { status: 'ok' } };
}

/** Faut-il (re)qualifier ? Jamais qualifié, version changée, échec de plus de 7 j, succès de plus de 30 j. */
export function needsQualification(q: StoredQualification | undefined, now: Date = new Date()): boolean {
  if (!q) return true;
  if (q.version !== QUALIFICATION_VERSION) return true;
  const age = now.getTime() - new Date(q.qualifiedAt).getTime();
  const echec = !q.generate || q.structured === false || q.multimodal === false;
  return age > (echec ? 7 : 30) * 24 * 3600_000;
}

/** Enregistre un résultat CONCLUANT sur la génération (best effort : ne lève jamais). */
export async function recordQualification(model: string, secret: string, r: QualificationResult): Promise<boolean> {
  if (r.generate === null) return false;
  try {
    await pgClient.unsafe(
      `INSERT INTO ai_model_qualification
         (provider, model, key_fingerprint, qualification_version, generate_ok, structured_ok, multimodal_ok, thinking_ok, errors, qualified_at)
       VALUES ('gemini', $1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
       ON CONFLICT (provider, model) DO UPDATE SET key_fingerprint = EXCLUDED.key_fingerprint,
         qualification_version = EXCLUDED.qualification_version, generate_ok = EXCLUDED.generate_ok,
         structured_ok = EXCLUDED.structured_ok, multimodal_ok = EXCLUDED.multimodal_ok,
         thinking_ok = EXCLUDED.thinking_ok, errors = EXCLUDED.errors, qualified_at = NOW()`,
      [model, keyFingerprint(secret), QUALIFICATION_VERSION, r.generate, r.structured, r.multimodal, r.thinking, JSON.stringify(r.errors)] as never[],
    );
    return true;
  } catch (e) {
    console.warn('[model-qualification] résultat non enregistré :', (e as Error).message);
    return false;
  }
}

/**
 * Qualifications obtenues AVEC LA CLÉ ACTIVE (lecture seule, aucun appel).
 * Sans clé, table absente (migration 0303) ou base indisponible : vide.
 */
export async function loadQualifications(activeSecret?: string | null): Promise<Map<string, StoredQualification>> {
  const out = new Map<string, StoredQualification>();
  try {
    const secret = activeSecret === undefined
      ? await (await import('./provider-secret')).getProviderSecret('gemini')
      : activeSecret;
    if (!secret) return out;
    const rows = (await pgClient.unsafe(
      `SELECT model, generate_ok, structured_ok, multimodal_ok, thinking_ok, errors, qualified_at, qualification_version
         FROM ai_model_qualification WHERE provider = 'gemini' AND key_fingerprint = $1`,
      [keyFingerprint(secret)] as never[],
    )) as unknown as Row[];
    const b = (v: unknown) => (v == null ? null : Boolean(v));
    for (const r of rows) {
      out.set(String(r.model), {
        generate: Boolean(r.generate_ok),
        structured: b(r.structured_ok),
        multimodal: b(r.multimodal_ok),
        thinking: b(r.thinking_ok),
        errors: (r.errors && typeof r.errors === 'object' ? r.errors : {}) as StoredQualification['errors'],
        qualifiedAt: new Date(String(r.qualified_at)).toISOString(),
        version: String(r.qualification_version),
      });
    }
  } catch {
    /* qualification inconnue */
  }
  return out;
}

/** Appel réel par le port fournisseur, tracé en technique (erreur nettoyée). */
export function defaultQualificationCall(secret?: string | null): QualificationCall {
  return async (input) => {
    const started = Date.now();
    const { getAiProvider } = await import('../gateway/providers');
    const { traceTechnicalCall } = await import('./model-operational.service');
    try {
      const r = await getAiProvider().call(input);
      await traceTechnicalCall('model_qualification_probe', input.model, true, Date.now() - started,
        { inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0 }, null, { input, responseRaw: r.rawText });
      return r;
    } catch (e) {
      await traceTechnicalCall('model_qualification_probe', input.model, false, Date.now() - started,
        { inputTokens: 0, outputTokens: 0 }, sanitizeProviderError(e, secret).slice(0, 300), { input, responseRaw: null });
      throw e;
    }
  };
}
