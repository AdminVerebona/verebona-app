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
 * modèle des sélecteurs. Seul un refus définitif (400/404, réponse vide,
 * JSON non conforme au schéma) vaut `false`.
 *
 * Aucune donnée utilisateur : prompts constants, image synthétique de 16×16
 * pixels. Appels tracés en TECHNIQUE, non facturables (comme les sondes).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { keyFingerprint } from './model-operational.service';
import type { ProviderCallInput } from '../gateway/providers/provider.port';

type Row = Record<string, unknown>;

/** Version des épreuves : la changer requalifie tous les modèles. */
export const QUALIFICATION_VERSION = 'qualif-v1' as const;

export type QualifiedCapability = 'generate' | 'structured' | 'multimodal' | 'thinking';

export interface QualificationResult {
  /** `null` : non concluant (transitoire) — rien n'est enregistré. */
  generate: boolean | null;
  structured: boolean | null;
  multimodal: boolean | null;
  thinking: boolean | null;
  errors: Partial<Record<QualifiedCapability, string>>;
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

/** Erreur transitoire (quota, délai, 5xx, réseau) : épreuve non concluante. */
export function isTransientError(message: string): boolean {
  return /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|timeout|timed out|délai|abort|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket/i.test(message);
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

type Outcome = { value: boolean | null; error?: string };

async function epreuve(
  run: () => Promise<{ rawText: string }>,
  check: (raw: string) => boolean,
  secret: string | null,
  refus: string,
): Promise<Outcome> {
  try {
    const r = await run();
    return check(r.rawText) ? { value: true } : { value: false, error: refus };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e ?? 'erreur inconnue');
    const propre = (secret ? msg.split(secret).join('***') : msg).slice(0, 300);
    return { value: isTransientError(msg) ? null : false, error: propre };
  }
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

  const gen = await epreuve(
    () => call({ ...base, prompt: 'Réponds exactement : OK' }),
    (raw) => raw.trim().length > 0, secret, 'réponse vide',
  );
  if (gen.error) errors.generate = gen.error;
  if (gen.value !== true) {
    return { generate: gen.value, structured: null, multimodal: null, thinking: null, errors };
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

  return { generate: true, structured: structured.value, multimodal: multimodal.value, thinking, errors };
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

/** Appel réel par le port fournisseur, tracé en technique. */
export function defaultQualificationCall(): QualificationCall {
  return async (input) => {
    const started = Date.now();
    const { getAiProvider } = await import('../gateway/providers');
    const { traceTechnicalCall } = await import('./model-operational.service');
    try {
      const r = await getAiProvider().call(input);
      await traceTechnicalCall('model_qualification_probe', input.model, true, Date.now() - started,
        { inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0 }, null);
      return r;
    } catch (e) {
      await traceTechnicalCall('model_qualification_probe', input.model, false, Date.now() - started,
        { inputTokens: 0, outputTokens: 0 }, String((e as Error)?.message ?? e).slice(0, 300));
      throw e;
    }
  };
}
