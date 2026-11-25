/**
 * Carte #843 (E11) — INSTRUMENTATION NON SENSIBLE des appels T2 au modèle : relier chaque exécution au code servi
 * (SHA du build), au prompt RÉELLEMENT utilisé (version servie par la passerelle, empreinte du texte effectif,
 * source BO ou fichier du dépôt) et au repli éventuel.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Avant #843, `verebona_ai_runs` portait la version de prompt (déclarée par l'appelant), l'empreinte des VARIABLES
 * de l'appel et le repli — pas l'empreinte du TEXTE du prompt, ni sa source, ni le SHA du code servi : impossible de
 * prouver, exécution par exécution, quel prompt BO a été utilisé avec quel code.
 *
 * Ici, en LECTURE SEULE et sans appel modèle :
 *   · `promptIdentityFor(operationCode)` — même résolution que la passerelle (`effectivePromptOf` : version BO
 *     active, texte de la version de configuration, sinon fichier du dépôt) → version, SOURCE et EMPREINTE
 *     SHA-256 (16 caractères) du texte ; jamais le texte lui-même. Cache court (60 s) par opération ; une
 *     lecture impossible rend `source: 'UNKNOWN'` avec son code (jamais une identité inventée) ;
 *   · `runIdentity()` — SHA du build servi (`getBuildIdentity`), ou `null` s'il n'est pas connu ;
 *   · `promptDrift(servie, résolue)` — la passerelle a servi une AUTRE version que celle résolue ici (cache
 *     échu, activation BO entre deux lectures) : signalé, jamais corrigé.
 *
 * NON VÉRIFIÉ ICI — dépendance externe : que le prompt actif du BO de préproduction / production soit bien celui
 * attendu et compatible avec UNDERSTAND / ANSWER / REVALIDATE. Ce module donne les éléments pour le prouver ; la
 * preuve reste à faire par une personne habilitée (protocole dans `recette-c843-assistant-t2-ecarts.md`).
 * Le prompt du BO n'est JAMAIS modifié à partir du code.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';
import { getBuildIdentity } from '@/lib/runtime-identity';

export type PromptSource = 'BO_VERSION' | 'BO_CONFIG' | 'REPO_FILE' | 'UNKNOWN';

export interface PromptIdentity {
  operationCode: string;
  /** Version tracée par la résolution (`…@pv12:…`, `…@file`…) ; `null` si illisible. */
  version: string | null;
  source: PromptSource;
  /** SHA-256 (16 premiers caractères hexadécimaux) du TEXTE effectif ; `null` si illisible. */
  fingerprint: string | null;
  /** Code de l'échec de lecture, si `source = UNKNOWN`. */
  errorCode?: string;
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: PromptIdentity }>();

/** Empreinte non réversible d'un texte de prompt (pure). */
export function promptTextFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** Source d'une version résolue (pure) : version BO active, texte de configuration BO, ou fichier du dépôt. */
export function promptSourceOf(version: string | null, execSource?: string | null): PromptSource {
  if (execSource === 'version') return 'BO_VERSION';
  if (execSource === 'config') return 'BO_CONFIG';
  if (execSource === 'file') return 'REPO_FILE';
  if (!version) return 'UNKNOWN';
  if (/@pv\d+/.test(version)) return 'BO_VERSION';
  if (/@file\b/.test(version)) return 'REPO_FILE';
  return 'BO_CONFIG';
}

/**
 * Identité du prompt effectif d'une opération T2 (lecture seule). `resolver` : injectable (tests) ; par défaut la
 * résolution de la passerelle (`effectivePromptOf`). Ne lève jamais.
 */
export async function promptIdentityFor(
  operationCode: string,
  deps: { resolver?: (op: string) => Promise<{ text: string; version: string; execution?: { source?: string | null } | null }>; now?: () => number } = {},
): Promise<PromptIdentity> {
  const now = deps.now ?? Date.now;
  const hit = cache.get(operationCode);
  if (!deps.resolver && hit && now() - hit.at < TTL_MS) return hit.value;
  let value: PromptIdentity;
  try {
    const resolver = deps.resolver ?? (async (op: string) => (await import('@/services/ai/master-prompts/effective-prompt')).effectivePromptOf(op));
    const eff = await resolver(operationCode);
    const src = (eff.execution as { source?: string | null } | null | undefined)?.source ?? null;
    value = { operationCode, version: eff.version, source: promptSourceOf(eff.version, src), fingerprint: promptTextFingerprint(eff.text) };
  } catch (e) {
    value = { operationCode, version: null, source: 'UNKNOWN', fingerprint: null, errorCode: String((e as { code?: string }).code ?? (e as Error).name ?? 'ERREUR').slice(0, 60) };
  }
  if (!deps.resolver) cache.set(operationCode, { at: now(), value });
  return value;
}

/**
 * Identité EN CACHE, sans attente (trace d'un appel) ; `null` si elle n'est pas (ou plus) en cache — une lecture est
 * alors lancée en arrière-plan pour les traces suivantes. Ne lève jamais.
 */
export function cachedPromptIdentity(operationCode: string, now: () => number = Date.now): PromptIdentity | null {
  const hit = cache.get(operationCode);
  if (hit && now() - hit.at < TTL_MS) return hit.value;
  void promptIdentityFor(operationCode).catch(() => undefined);
  return hit?.value ?? null;
}

/** Vide le cache (tests, activation BO observée). */
export function resetPromptIdentityCache(): void { cache.clear(); }

/** SHA du build servi, ou `null` (jamais inventé). */
export function runIdentity(env: Record<string, string | undefined> = process.env): string | null {
  try {
    return getBuildIdentity(env).commit;
  } catch {
    return null;
  }
}

/** La version servie par la passerelle diffère-t-elle de la version résolue ? (pure) `null` : non comparable. */
export function promptDrift(served: string | null | undefined, resolved: string | null | undefined): boolean | null {
  if (!served || !resolved) return null;
  return served !== resolved;
}
