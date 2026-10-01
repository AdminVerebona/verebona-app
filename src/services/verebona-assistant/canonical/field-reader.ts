/**
 * Lecture d'un champ canonique d'un bien — CDC 15 T2-01, T2-02, T2-22,
 * T2-23, T2-32 (lot 15).
 *
 * Ordre de vérité (§9, décision d'architecture) : valeur canonique de la
 * fiche (USER, puis état T3) → conflit ouvert (« À traiter ») → preuve
 * active → faits T1 → source originale. `readCanonicalField` rend les trois
 * premiers d'un coup : valeur, origine, date, preuve active, conflit ouvert.
 *
 * Tout est borné au compte : un bien d'un autre compte rend `null`.
 * Lecture seule — aucune écriture, aucun appel modèle.
 */
import { pgClient } from '@/db';
import { getCanonicalAssetState, type CanonicalAssetState, type CanonicalOrigin } from '@/services/canonical/asset-state';
import { fieldTargetTypes, getField, resolveAlias, type CanonicalFieldDef } from '@/services/canonical/registry';
import type { CanonicalEntityState, CanonicalEntityTarget } from '@/services/canonical/entity-state';
import type { EntityEvidenceWithTitle } from '@/services/ai/evidence/entity-evidence';
import type { RetrievedSource } from '../types/sources';

/** Preuve active retenue pour un champ (la plus autoritaire). */
export interface CanonicalFieldEvidence {
  evidenceId: number;
  fileId: number | null;
  documentTitle: string | null;
  documentDate: string | null;
  /** Extrait littéral ; null pour une observation visuelle. */
  excerpt: string | null;
  confidence: string;
}

/** Conflit ouvert sur le champ (carte « À traiter » non résolue). */
export interface CanonicalFieldConflict {
  publicId: string;
  ruleCode: string;
  question: string;
  /** Valeurs proposées à l'arbitrage (libellés). */
  proposals: string[];
}

export interface CanonicalFieldReading {
  assetId: number;
  assetName: string | null;
  key: string;
  label: string;
  /** Valeur canonique (null : non renseignée). */
  value: unknown;
  /** Valeur mise en forme pour une réponse (« 25 mai 2021 », « 12 500 € »). */
  display: string | null;
  origin: CanonicalOrigin | null;
  /** Libellé français de l'origine (« saisie par vous », « issue d'un document »…). */
  originLabel: string | null;
  updatedAt: string | null;
  /** Clé canonique, alias historique ou colonne historique (transition D-10). */
  from: 'key' | 'alias' | 'column' | null;
  evidence: CanonicalFieldEvidence | null;
  openConflict: CanonicalFieldConflict | null;
  /** Donnée sensible : jamais citée en clair au modèle (voir `assetFieldSource`). */
  sensitive: boolean;
  /**
   * Lot 18 (R3) : valeurs du même champ sur les ÉQUIPEMENTS ou PIÈCES du bien
   * (chaudière, salon) — jamais confondues avec la valeur du bien. Présent
   * seulement pour un champ dont `targetTypes` admet une entité.
   */
  entities?: CanonicalEntityFieldReading[];
}

/** Lecture d'un champ canonique d'un équipement ou d'une pièce (lot 18). */
export interface CanonicalEntityFieldReading {
  target: CanonicalEntityTarget;
  entityName: string | null;
  /** Bien porteur. */
  assetId: number;
  key: string;
  label: string;
  value: unknown;
  display: string | null;
  origin: CanonicalOrigin | null;
  originLabel: string | null;
  updatedAt: string | null;
  from: 'key' | 'alias' | 'column' | null;
  evidence: CanonicalFieldEvidence | null;
  sensitive: boolean;
}

export const ORIGIN_LABELS: Readonly<Record<string, string>> = {
  USER: 'saisie par vous',
  ADMIN: 'corrigée par le support',
  DOCUMENT_EXTRACTION: 'lue dans un document',
  RECONCILIATION: 'retenue après rapprochement de vos documents',
  IMPORT: 'importée',
  SYSTEM_RULE: 'calculée par une règle',
};

const MOIS = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Mise en forme d'une valeur canonique selon son type au registre (pure). */
export function formatCanonicalValue(def: Pick<CanonicalFieldDef, 'valueType' | 'unit' | 'enumLabels'>, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (def.valueType === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [y, m, d] = value.slice(0, 10).split('-').map(Number);
    return MOIS.format(new Date(Date.UTC(y, m - 1, d)));
  }
  if ((def.valueType === 'money_eur' || def.valueType === 'number') && typeof value === 'number') {
    const n = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(value);
    const unite = def.valueType === 'money_eur' || def.unit === 'EUR' ? '€' : def.unit ?? '';
    return unite ? `${n} ${unite}` : n;
  }
  if (def.valueType === 'money_cents' && typeof value === 'number') {
    return `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100)} €`;
  }
  if (def.valueType === 'enum' && typeof value === 'string') return def.enumLabels?.[value] ?? value;
  if (def.valueType === 'boolean') return value === true || value === 'true' ? 'oui' : 'non';
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 200);
  return String(value);
}

/** Clé canonique d'une clé ou d'un alias (null : hors registre). */
export function canonicalKeyOf(keyOrAlias: string): string | null {
  if (getField(keyOrAlias)) return keyOrAlias;
  return resolveAlias(keyOrAlias) ?? null;
}

/** Preuve active la plus autoritaire (clé canonique puis alias). */
async function activeEvidence(accountId: number, assetId: number, def: CanonicalFieldDef): Promise<CanonicalFieldEvidence | null> {
  const { getActiveEvidence } = await import('@/services/ai/evidence/field-evidence.service');
  for (const k of [def.key, ...def.aliases.slice(0, 4)]) {
    const rows = await getActiveEvidence(accountId, assetId, k).catch(() => []);
    const e = rows[0];
    if (!e) continue;
    let documentTitle: string | null = null;
    if (e.sourceType === 'document' && e.sourceId) {
      const [d] = (await pgClient.unsafe(
        `SELECT coalesce(retained_title, original_filename) AS t FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
        [e.sourceId, accountId] as never[],
      )) as unknown as Array<{ t: string | null }>;
      documentTitle = d?.t ?? null;
    }
    return {
      evidenceId: e.id,
      fileId: e.sourceType === 'document' ? e.sourceId : null,
      documentTitle,
      documentDate: e.documentDate ? e.documentDate.toISOString().slice(0, 10) : null,
      excerpt: e.evidenceOrigin === 'VISUAL_ANALYSIS' ? null : e.excerpt ?? null,
      confidence: e.confidence,
    };
  }
  return null;
}

/** Conflits ouverts « À traiter » sur des champs d'un bien, par clé canonique. */
export async function openFieldConflicts(accountId: number, assetId: number, keys?: string[]): Promise<Map<string, CanonicalFieldConflict>> {
  const rows = (await pgClient.unsafe(
    `SELECT public_id AS "publicId", rule_code AS "ruleCode", question, field_key AS "fieldKey", proposals_json AS proposals
       FROM to_process_actions
      WHERE account_id = $1 AND target_type = 'ASSET' AND target_id = $2 AND resolved_at IS NULL AND field_key IS NOT NULL
      ORDER BY id DESC LIMIT 200`,
    [accountId, assetId] as never[],
  )) as unknown as Array<{ publicId: string; ruleCode: string; question: string; fieldKey: string; proposals: Array<{ label?: string }> | null }>;
  const out = new Map<string, CanonicalFieldConflict>();
  for (const r of rows) {
    const k = canonicalKeyOf(r.fieldKey) ?? r.fieldKey;
    if (keys && !keys.includes(k)) continue;
    if (out.has(k)) continue;
    out.set(k, {
      publicId: r.publicId, ruleCode: r.ruleCode, question: r.question,
      proposals: (r.proposals ?? []).map((x) => x.label ?? '').filter(Boolean).slice(0, 4),
    });
  }
  return out;
}

/**
 * Lit un champ canonique d'un bien du compte (voir l'en-tête). `null` si le
 * bien n'est pas au compte ou si la clé est hors registre. Un champ non
 * renseigné rend une lecture de valeur `null` (utile : « non renseigné »).
 */
export async function readCanonicalField(
  accountId: number,
  assetId: number,
  keyOrAlias: string,
  opts: { state?: CanonicalAssetState | null; assetName?: string | null; entityCache?: EntityReadCache } = {},
): Promise<CanonicalFieldReading | null> {
  const key = canonicalKeyOf(keyOrAlias);
  const def = key ? getField(key) : undefined;
  if (!key || !def || !def.assistantReadable) return null;
  const state = opts.state !== undefined ? opts.state : await getCanonicalAssetState(assetId, accountId);
  if (!state || state.accountId !== accountId) return null;
  const f = state.fields[key];
  const [evidence, conflicts, nom, entities] = await Promise.all([
    activeEvidence(accountId, assetId, def),
    openFieldConflicts(accountId, assetId, [key]),
    opts.assetName !== undefined ? Promise.resolve(opts.assetName) : assetNameOf(accountId, assetId),
    readEntitiesOfAsset(accountId, assetId, def, opts.entityCache ?? new EntityReadCache()),
  ]);
  return {
    ...(entities ? { entities } : {}),
    assetId,
    assetName: nom,
    key,
    label: def.label,
    value: f?.value ?? null,
    display: formatCanonicalValue(def, f?.value ?? null),
    origin: f?.origin ?? null,
    originLabel: f?.origin ? ORIGIN_LABELS[f.origin] ?? null : null,
    updatedAt: f?.updatedAt ?? null,
    from: f?.from ?? null,
    evidence,
    openConflict: conflicts.get(key) ?? null,
    sensitive: def.sensitive === true,
  };
}

/** Lecture d'une entité déjà chargée (pure, hors preuve). */
function entityReading(def: CanonicalFieldDef, st: CanonicalEntityState, evidence: CanonicalFieldEvidence | null): CanonicalEntityFieldReading {
  const f = st.fields[def.key];
  return {
    target: st.target, entityName: st.name, assetId: st.assetId, key: def.key, label: def.label,
    value: f?.value ?? null, display: formatCanonicalValue(def, f?.value ?? null),
    origin: f?.origin ?? null, originLabel: f?.origin ? ORIGIN_LABELS[f.origin] ?? null : null,
    updatedAt: f?.updatedAt ?? null, from: f?.from ?? null, evidence, sensitive: def.sensitive === true,
  };
}

/** Preuve retenue (la plus autoritaire) au format de la lecture. */
function versPreuveLue(e: EntityEvidenceWithTitle): CanonicalFieldEvidence {
  const p = e.evidence;
  return {
    evidenceId: p.id,
    fileId: p.sourceType === 'document' ? p.sourceId : null,
    documentTitle: e.documentTitle,
    documentDate: p.documentDate ? p.documentDate.toISOString().slice(0, 10) : null,
    excerpt: p.evidenceOrigin === 'VISUAL_ANALYSIS' ? null : p.excerpt ?? null,
    confidence: p.confidence,
  };
}

interface EntitiesOfAsset {
  states: CanonicalEntityState[];
  /** `TYPE:id:cléCanonique` → preuve la plus autoritaire. */
  evidence: Map<string, CanonicalFieldEvidence>;
}

/**
 * Cache PAR DEMANDE des fiches d'équipements et de pièces (relecture lot 18) :
 * pour un bien, UNE requête pour les fiches (`loadAssetEntityRows`) et UNE
 * pour les preuves actives de toutes ses entités
 * (`listActiveEvidenceForTargets`), quel que soit le nombre de champs lus.
 * Preuves lues par cible et compte, jamais par `asset_id` (équipement
 * déplacé). À créer pour une demande, jamais partagé entre comptes.
 */
export class EntityReadCache {
  private readonly parBien = new Map<string, Promise<EntitiesOfAsset | null>>();

  entitiesOf(accountId: number, assetId: number): Promise<EntitiesOfAsset | null> {
    const k = `${accountId}:${assetId}`;
    let p = this.parBien.get(k);
    if (!p) {
      p = charger(accountId, assetId);
      this.parBien.set(k, p);
    }
    return p;
  }
}

async function charger(accountId: number, assetId: number): Promise<EntitiesOfAsset | null> {
  const es = await import('@/services/canonical/entity-state');
  if (!(await es.entityCanonicalColumnsReady())) return null;
  const rows = await es.loadAssetEntityRows(pgClient as never, accountId, assetId);
  const states = rows.map(es.buildCanonicalEntityState);
  const evidence = new Map<string, CanonicalFieldEvidence>();
  if (states.length) {
    const { listActiveEvidenceForTargets } = await import('@/services/ai/evidence/entity-evidence');
    for (const e of await listActiveEvidenceForTargets(accountId, states.map((x) => x.target))) {
      const k = `${e.target.type}:${e.target.id}:${canonicalKeyOf(e.evidence.fieldKey) ?? e.evidence.fieldKey}`;
      if (!evidence.has(k)) evidence.set(k, versPreuveLue(e));
    }
  }
  return { states, evidence };
}

/**
 * Lit un champ canonique d'un ÉQUIPEMENT ou d'une PIÈCE du compte (lot 18,
 * R3) : valeur de SA fiche, origine, preuve active ciblée. `null` : entité
 * hors compte, clé hors registre ou champ qui n'admet pas ce type de cible.
 */
export async function readCanonicalEntityField(
  accountId: number,
  target: CanonicalEntityTarget,
  keyOrAlias: string,
): Promise<CanonicalEntityFieldReading | null> {
  const key = canonicalKeyOf(keyOrAlias);
  const def = key ? getField(key) : undefined;
  if (!def || !def.assistantReadable || !fieldTargetTypes(def).includes(target.type)) return null;
  const { getCanonicalEntityState } = await import('@/services/canonical/entity-state');
  const st = await getCanonicalEntityState(target, accountId);
  if (!st) return null;
  let evidence: CanonicalFieldEvidence | null = null;
  if (st.fields[def.key]) {
    const { listActiveEvidenceForTargets } = await import('@/services/ai/evidence/entity-evidence');
    const e = (await listActiveEvidenceForTargets(accountId, [target]))
      .find((x) => (canonicalKeyOf(x.evidence.fieldKey) ?? x.evidence.fieldKey) === def.key);
    evidence = e ? versPreuveLue(e) : null;
  }
  return entityReading(def, st, evidence);
}

/** Valeurs RENSEIGNÉES du champ sur les entités actives du bien (undefined : champ sans cible entité). */
async function readEntitiesOfAsset(
  accountId: number, assetId: number, def: CanonicalFieldDef, cache: EntityReadCache,
): Promise<CanonicalEntityFieldReading[] | undefined> {
  const cibles = fieldTargetTypes(def);
  if (!cibles.some((t) => t === 'EQUIPMENT' || t === 'ROOM')) return undefined;
  try {
    const lu = await cache.entitiesOf(accountId, assetId);
    if (!lu) return undefined;
    return lu.states
      .filter((st) => cibles.includes(st.target.type) && st.fields[def.key])
      .slice(0, 50)
      .map((st) => entityReading(def, st, lu.evidence.get(`${st.target.type}:${st.target.id}:${def.key}`) ?? null));
  } catch (e) {
    console.warn('[assistant] lecture des équipements / pièces (non bloquante) :', (e as Error).message);
    return undefined;
  }
}

async function assetNameOf(accountId: number, assetId: number): Promise<string | null> {
  const [r] = (await pgClient.unsafe(
    `SELECT name FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
    [assetId, accountId] as never[],
  )) as unknown as Array<{ name: string }>;
  return r?.name ?? null;
}

// ── Source de niveau champ (T2-32) ───────────────────────────────────────

export { assetFieldSourceId, parseAssetFieldSourceId } from './source-ids';
import { assetFieldSourceId } from './source-ids';

/**
 * Source vérifiable d'une affirmation sur un champ (T2-32) : porte la valeur,
 * l'origine, la preuve et le conflit éventuel. Une donnée SENSIBLE n'est pas
 * écrite en clair dans le contenu (le modèle ne la voit pas) ; la méta ne
 * porte qu'un indicateur.
 */
export function assetFieldSource(r: CanonicalFieldReading): RetrievedSource {
  const valeur = r.sensitive ? '(donnée protégée)' : r.display ?? 'non renseigné';
  const parts = [`${r.label} : ${valeur}`];
  if (r.originLabel) parts.push(`origine : ${r.originLabel}${r.updatedAt ? `, le ${r.updatedAt.slice(0, 10)}` : ''}`);
  if (r.evidence) {
    const doc = r.evidence.documentTitle ? `« ${r.evidence.documentTitle} »` : 'un document';
    parts.push(r.evidence.excerpt ? `preuve : ${doc}, « ${r.evidence.excerpt.slice(0, 200)} »` : `preuve : ${doc}`);
  }
  if (r.openConflict) parts.push(`conflit ouvert (À traiter) : ${r.openConflict.question}`);
  // Lot 18 : valeurs des équipements / pièces du bien, chacune nommée.
  for (const e of entityValues(r)) {
    const doc = e.evidence?.documentTitle ? `, preuve « ${e.evidence.documentTitle} »` : '';
    parts.push(`${e.entityName ?? (e.target.type === 'ROOM' ? 'pièce' : 'équipement')} : ${e.sensitive ? '(donnée protégée)' : e.display}`
      + `${e.originLabel ? ` (${e.originLabel}${doc})` : ''}`);
  }
  return {
    id: assetFieldSourceId(r.assetId, r.key),
    type: 'asset_field',
    title: r.assetName ? `${r.label} — ${r.assetName}` : r.label,
    content: parts.join(' · ').slice(0, 1500),
    relevanceScore: 1,
    meta: {
      assetId: r.assetId,
      fieldKey: r.key,
      value: r.sensitive || r.value == null ? null : typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value),
      display: r.sensitive ? null : r.display,
      origin: r.origin,
      updatedAt: r.updatedAt,
      evidenceId: r.evidence?.evidenceId ?? null,
      evidenceFileId: r.evidence?.fileId ?? null,
      openConflict: r.openConflict !== null,
      sensitive: r.sensitive,
      ...(r.entities?.length ? {
        // Méta scalaire : liste sérialisée (cible, origine, preuve ; pas de valeur sensible).
        entities: JSON.stringify(entityValues(r).map((e) => ({
          type: e.target.type, id: e.target.id, name: e.entityName, display: e.sensitive ? null : e.display,
          origin: e.origin, evidenceId: e.evidence?.evidenceId ?? null, evidenceFileId: e.evidence?.fileId ?? null,
        }))),
      } : {}),
    },
  };
}

/** Valeurs renseignées des équipements / pièces d'une lecture (lot 18). */
export function entityValues(r: CanonicalFieldReading): CanonicalEntityFieldReading[] {
  return (r.entities ?? []).filter((e) => e.display !== null && e.display !== '');
}
