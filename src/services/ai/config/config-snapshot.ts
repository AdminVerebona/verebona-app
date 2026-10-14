/**
 * Instantané complet d'une révision de configuration IA — lot 54 (54C),
 * ticket « BO-IA — Refonte de la gestion des versions, restauration et
 * export ».
 *
 * Une révision porte TOUTE la configuration versionnée, de façon autonome :
 *   · les lignes des traitements opérationnels (T1, T2, T3, T4, T6) —
 *     modèles principaux et replis, niveaux de raisonnement, tokens de
 *     sortie, garde-fous, déclencheurs, cascade T2, préambule et texte master
 *     historique (D-03) ;
 *   · les prompts maîtres retenus pour chaque traitement : référence à une
 *     version de prompt maître (immuable en base, 0254) ET copie de son texte,
 *     de son empreinte et de sa configuration d'exécution (lot 34D). `null` /
 *     absent : la version ne pilote pas ce prompt maître (le prompt actif est
 *     conservé à l'activation).
 *
 * Pur (aucune base) : normalisation, JSON canonique, empreinte, comparaison.
 * Le format est identique à celui que produit la reprise SQL (0376).
 */
import { createHash } from 'node:crypto';
import { TREATMENTS, isTreatment, type Treatment } from './treatments';
import {
  REASONING_LEVELS, masterPromptOf, type TreatmentConfig, type ReasoningLevel,
} from './config-types';
import type { MasterExecutionConfig } from '../master-prompts/structured-context';

export const SNAPSHOT_FORMAT = 'ai-config-snapshot-v1' as const;

/** Prompt maître figé dans une révision. */
export interface MasterPromptRef {
  /** `ai_master_prompt_versions.id` — ligne immuable hors brouillon. */
  versionId: number;
  versionNumber: number;
  masterPromptCode: string;
  contentSha256: string;
  content: string;
  /**
   * Configuration d'exécution (lot 34D). `undefined` : inconnue de
   * l'instantané (lue sur la version de prompt référencée).
   */
  execution?: MasterExecutionConfig | null;
}

export interface ConfigSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  entries: TreatmentConfig[];
  masterPrompts: Partial<Record<Treatment, MasterPromptRef | null>>;
}

type Obj = Record<string, unknown>;

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const level = (v: unknown): ReasoningLevel | null =>
  typeof v === 'string' && (REASONING_LEVELS as readonly string[]).includes(v) ? (v as ReasoningLevel) : null;

/** Ligne de configuration réduite aux champs versionnés, dans un ordre fixe. */
export function snapshotEntry(raw: Partial<TreatmentConfig> & { treatment: Treatment }): TreatmentConfig {
  const mot = raw.maxOutputTokens;
  return {
    treatment: raw.treatment,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    primaryModel: str(raw.primaryModel),
    fallback1: str(raw.fallback1),
    fallback2: str(raw.fallback2),
    reasoningPrimary: level(raw.reasoningPrimary),
    reasoningFallback1: level(raw.reasoningFallback1),
    reasoningFallback2: level(raw.reasoningFallback2),
    maxOutputTokens: typeof mot === 'number' && Number.isFinite(mot) && mot > 0 ? Math.trunc(mot) : null,
    guardrails: Array.isArray(raw.guardrails) ? raw.guardrails.map((g) => ({ code: String(g.code), threshold: Number(g.threshold), reaction: g.reaction })) : [],
    triggers: Array.isArray(raw.triggers) ? raw.triggers.map((t) => ({ kind: t.kind === 'schedule' ? 'schedule' : 'event', code: String(t.code), active: Boolean(t.active) })) : [],
    cascade: raw.cascade && typeof raw.cascade === 'object'
      ? {
        database: Number(raw.cascade.database), text: Number(raw.cascade.text),
        semantic: Number(raw.cascade.semantic), semanticEnabled: Boolean(raw.cascade.semanticEnabled),
      }
      : null,
    // Lot 16b : `master` pour tous les traitements.
    promptArchitecture: 'master',
    masterPrompt: masterPromptOf(raw),
  };
}

function normalizeRef(raw: unknown): MasterPromptRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Obj;
  const id = Number(r.versionId);
  if (!Number.isInteger(id) || id <= 0 || typeof r.content !== 'string') return null;
  const ref: MasterPromptRef = {
    versionId: id,
    versionNumber: Number(r.versionNumber),
    masterPromptCode: String(r.masterPromptCode ?? ''),
    contentSha256: String(r.contentSha256 ?? ''),
    content: r.content,
  };
  if ('execution' in r) ref.execution = (r.execution ?? null) as MasterExecutionConfig | null;
  return ref;
}

/**
 * Instantané lu (base, requête) → forme canonique. Les traitements retirés
 * (T5, lot 49) ou inconnus sont écartés ; ordre du référentiel.
 */
export function normalizeSnapshot(raw: unknown): ConfigSnapshot {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Obj;
  const vus = new Set<string>();
  const entries = (Array.isArray(o.entries) ? o.entries : [])
    .filter((e): e is Obj => Boolean(e) && typeof e === 'object' && isTreatment(String((e as Obj).treatment)))
    .filter((e) => { const t = String(e.treatment); if (vus.has(t)) return false; vus.add(t); return true; })
    .map((e) => snapshotEntry(e as unknown as TreatmentConfig))
    .sort((a, b) => TREATMENTS.indexOf(a.treatment) - TREATMENTS.indexOf(b.treatment));
  const mp = (o.masterPrompts && typeof o.masterPrompts === 'object' ? o.masterPrompts : {}) as Obj;
  const masterPrompts: ConfigSnapshot['masterPrompts'] = {};
  for (const t of TREATMENTS) {
    const ref = normalizeRef(mp[t]);
    if (ref) masterPrompts[t] = ref;
  }
  return { format: SNAPSHOT_FORMAT, entries, masterPrompts };
}

/** Construit un instantané à partir de lignes et de prompts maîtres. */
export function buildSnapshot(
  entries: TreatmentConfig[],
  masterPrompts: ConfigSnapshot['masterPrompts'] = {},
): ConfigSnapshot {
  return normalizeSnapshot({ format: SNAPSHOT_FORMAT, entries, masterPrompts });
}

/** JSON canonique : clés triées à tous les niveaux, `undefined` omis. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const o = value as Obj;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Empreinte d'un instantané. Le contenu des prompts maîtres est comparé par
 * son empreinte et sa référence ; la configuration d'exécution inconnue
 * (`undefined`, reprise) n'entre pas dans la comparaison.
 */
export function snapshotSha256(s: ConfigSnapshot): string {
  return sha256(canonicalJson(comparable(s)));
}

function comparable(s: ConfigSnapshot): unknown {
  const n = normalizeSnapshot(s);
  const mp: Obj = {};
  for (const [t, r] of Object.entries(n.masterPrompts)) {
    if (r) mp[t] = { versionId: r.versionId, contentSha256: r.contentSha256 };
  }
  return { format: n.format, entries: n.entries, masterPrompts: mp };
}

export function snapshotsEqual(a: ConfigSnapshot, b: ConfigSnapshot): boolean {
  return snapshotSha256(a) === snapshotSha256(b);
}

/**
 * Fusion d'une sauvegarde PARTIELLE (traitements modifiés seulement) dans
 * l'instantané courant. Un traitement absent de `changes` est conservé tel
 * quel ; `masterPrompts` : clé présente = valeur remplacée (`null` : la
 * version cesse de piloter ce prompt), clé absente = conservée.
 */
export function mergeSnapshot(
  current: ConfigSnapshot,
  changes: { entries?: Array<Partial<TreatmentConfig> & { treatment: Treatment }>; masterPrompts?: ConfigSnapshot['masterPrompts'] },
): ConfigSnapshot {
  const byT = new Map(current.entries.map((e) => [e.treatment, e]));
  for (const e of changes.entries ?? []) {
    const avant = byT.get(e.treatment);
    // Champ omis : valeur en place (client partiel) — jamais remis à vide.
    const fusion = { ...(avant ?? {}), ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) };
    byT.set(e.treatment, snapshotEntry(fusion as TreatmentConfig));
  }
  const masterPrompts = { ...current.masterPrompts };
  for (const [t, r] of Object.entries(changes.masterPrompts ?? {})) {
    if (!isTreatment(t)) continue;
    if (r) masterPrompts[t] = r; else delete masterPrompts[t];
  }
  return buildSnapshot([...byT.values()], masterPrompts);
}
