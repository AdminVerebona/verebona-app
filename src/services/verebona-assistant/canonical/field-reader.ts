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
import { getField, resolveAlias, type CanonicalFieldDef } from '@/services/canonical/registry';
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
  opts: { state?: CanonicalAssetState | null; assetName?: string | null } = {},
): Promise<CanonicalFieldReading | null> {
  const key = canonicalKeyOf(keyOrAlias);
  const def = key ? getField(key) : undefined;
  if (!key || !def || !def.assistantReadable) return null;
  const state = opts.state !== undefined ? opts.state : await getCanonicalAssetState(assetId, accountId);
  if (!state || state.accountId !== accountId) return null;
  const f = state.fields[key];
  const [evidence, conflicts, nom] = await Promise.all([
    activeEvidence(accountId, assetId, def),
    openFieldConflicts(accountId, assetId, [key]),
    opts.assetName !== undefined ? Promise.resolve(opts.assetName) : assetNameOf(accountId, assetId),
  ]);
  return {
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
    },
  };
}
