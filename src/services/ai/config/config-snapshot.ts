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
import { normalizeOperationProfiles } from './operation-profiles';

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
    // Lot 85C : profils par opération — présents seulement s'ils existent,
    // pour que l'empreinte des révisions antérieures reste inchangée.
    ...profilesOf(raw.operationProfiles),
  };
}

function profilesOf(raw: unknown): Pick<TreatmentConfig, 'operationProfiles'> {
  const p = normalizeOperationProfiles(raw);
  return Object.keys(p).length ? { operationProfiles: p } : {};
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

// ══════════════════════════════════════════════════════════════════════════
// Lot 113I — UNITÉ DE CHANGEMENT PAR TRAITEMENT (CDC V2 §2.3, PRO-03/05,
// SQL-005, LIF-007/008). La configuration reste GLOBALE (une version active) ;
// une promotion ou un retour arrière automatiques ne portent que sur la part
// d'UN traitement (ligne de configuration + prompt maître piloté), fusionnée
// sur la DERNIÈRE active avec `mergeSnapshot`. Pur.
// ══════════════════════════════════════════════════════════════════════════

/** Part d'un traitement dans un instantané : sa ligne et son prompt maître piloté (null : non piloté). */
export interface TreatmentPart {
  treatment: Treatment;
  entry: TreatmentConfig | null;
  masterPrompt: MasterPromptRef | null;
}

export function treatmentPart(s: ConfigSnapshot, t: Treatment): TreatmentPart {
  const n = normalizeSnapshot(s);
  return { treatment: t, entry: n.entries.find((e) => e.treatment === t) ?? null, masterPrompt: n.masterPrompts[t] ?? null };
}

/** Empreinte de la part d'un traitement (prompt comparé par référence + empreinte de texte, comme `snapshotSha256`). */
export function treatmentFingerprint(s: ConfigSnapshot, t: Treatment): string {
  const p = treatmentPart(s, t);
  return sha256(canonicalJson({
    treatment: t, entry: p.entry,
    masterPrompt: p.masterPrompt ? { versionId: p.masterPrompt.versionId, contentSha256: p.masterPrompt.contentSha256 } : null,
  }));
}

/** Traitements dont la part diffère entre deux instantanés. */
export function changedTreatments(a: ConfigSnapshot, b: ConfigSnapshot): Treatment[] {
  return TREATMENTS.filter((t) => treatmentFingerprint(a, t) !== treatmentFingerprint(b, t));
}

/** Axes modifiés d'une part de traitement (GEN-02 : delta structuré). */
export type ChangeAxis = 'MODEL' | 'PROMPT' | 'INFERENCE_PROFILE' | 'FALLBACK_CHAIN';

export function changedAxes(before: TreatmentPart, after: TreatmentPart): ChangeAxis[] {
  const axes = new Set<ChangeAxis>();
  const a = before.entry;
  const b = after.entry;
  if ((a?.primaryModel ?? null) !== (b?.primaryModel ?? null)) axes.add('MODEL');
  if ((a?.fallback1 ?? null) !== (b?.fallback1 ?? null) || (a?.fallback2 ?? null) !== (b?.fallback2 ?? null)) axes.add('FALLBACK_CHAIN');
  const profil = (e: TreatmentConfig | null) => canonicalJson(e ? {
    rp: e.reasoningPrimary, r1: e.reasoningFallback1, r2: e.reasoningFallback2, mot: e.maxOutputTokens, op: e.operationProfiles ?? null,
  } : null);
  if (profil(a) !== profil(b)) axes.add('INFERENCE_PROFILE');
  const prompt = (p: TreatmentPart) => canonicalJson({ prompt: p.entry?.prompt ?? '', master: p.entry?.masterPrompt ?? null, ref: p.masterPrompt ? p.masterPrompt.contentSha256 : null });
  if (prompt(before) !== prompt(after)) axes.add('PROMPT');
  return [...axes];
}

/**
 * Champs d'une ligne qu'aucun changement AUTOMATIQUE ne peut toucher (CDC §1.3 : garde-fous, déclencheurs, cascade
 * T2 — règles de sécurité / fonctionnement administrées). Un delta qui les modifie est refusé (LIF-007, SEC-02).
 */
export const PROTECTED_ENTRY_FIELDS = ['guardrails', 'triggers', 'cascade', 'promptArchitecture'] as const;

export class TreatmentDeltaRefused extends Error {
  constructor(readonly code: 'MULTI_TREATMENT_DELTA' | 'FORBIDDEN_CHANGE' | 'NO_EFFECT', message: string) {
    super(message);
    this.name = 'TreatmentDeltaRefused';
  }
}

/** Delta structuré d'un seul traitement entre la référence et la candidate (vérifié par différence structurelle). */
export interface TreatmentDelta {
  treatment: Treatment;
  beforeFingerprint: string;
  afterFingerprint: string;
  axes: ChangeAxis[];
  after: TreatmentPart;
}

/**
 * LIF-007 : la candidate ne diffère de sa référence QUE par la part du traitement ciblé (sinon refus avant toute
 * création de version), sans toucher aux champs protégés, et diffère réellement (sinon NO_EFFECT).
 */
export function assertOnlyTreatmentChanged(base: ConfigSnapshot, next: ConfigSnapshot, t: Treatment, opts: { allowNoEffect?: boolean } = {}): TreatmentDelta {
  const autres = changedTreatments(base, next).filter((x) => x !== t);
  if (autres.length) {
    throw new TreatmentDeltaRefused('MULTI_TREATMENT_DELTA', `Delta automatique refusé : il modifie aussi ${autres.join(', ')} (une candidate ne porte qu'un traitement : ${t}).`);
  }
  const before = treatmentPart(base, t);
  const after = treatmentPart(next, t);
  for (const f of PROTECTED_ENTRY_FIELDS) {
    if (canonicalJson(before.entry?.[f] ?? null) !== canonicalJson(after.entry?.[f] ?? null)) {
      throw new TreatmentDeltaRefused('FORBIDDEN_CHANGE', `Delta automatique refusé : champ protégé « ${f} » de ${t} modifié (garde-fous et règles administrées non auto-modifiables).`);
    }
  }
  const beforeFingerprint = treatmentFingerprint(base, t);
  const afterFingerprint = treatmentFingerprint(next, t);
  if (beforeFingerprint === afterFingerprint && !opts.allowNoEffect) {
    throw new TreatmentDeltaRefused('NO_EFFECT', `Delta automatique sans effet sur ${t} : aucune candidate créée.`);
  }
  return { treatment: t, beforeFingerprint, afterFingerprint, axes: changedAxes(before, after), after };
}

/**
 * Instantané courant où SEULE la part du traitement est remplacée (promotion : part de la candidate ; retour
 * arrière : part antérieure). Vérifie que les autres traitements sont strictement identiques (SQL-005).
 */
export function replaceTreatmentPart(current: ConfigSnapshot, part: TreatmentPart): ConfigSnapshot {
  const t = part.treatment;
  const entries = normalizeSnapshot(current).entries.filter((e) => e.treatment !== t);
  if (part.entry) entries.push(snapshotEntry({ ...part.entry, treatment: t }));
  const masterPrompts = { ...normalizeSnapshot(current).masterPrompts };
  if (part.masterPrompt) masterPrompts[t] = part.masterPrompt; else delete masterPrompts[t];
  const next = buildSnapshot(entries, masterPrompts);
  const touches = changedTreatments(current, next).filter((x) => x !== t);
  if (touches.length) throw new TreatmentDeltaRefused('MULTI_TREATMENT_DELTA', `Fusion refusée : ${touches.join(', ')} modifié(s) par une opération ciblée sur ${t}.`);
  return next;
}
