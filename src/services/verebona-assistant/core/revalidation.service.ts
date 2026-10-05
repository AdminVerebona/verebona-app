/**
 * Revalidation ciblée d'un fait par T2, et réinjection dans la connaissance.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * données T1 → contrôle de suffisance → revalidation ciblée → réponse →
 * réinjection du fait amélioré
 *
 * Ordre imposé, du moins coûteux au plus coûteux — la relance complète de T1
 * n'en fait JAMAIS partie :
 *   1. contenu persisté, sans modèle : l'extrait justificatif de T1 figure-t-il
 *      mot pour mot dans le texte extrait, et porte-t-il la valeur ?
 *   2. contenu persisté, avec modèle : une fenêtre du texte extrait autour de
 *      l'information, une question ciblée (mode PERSISTED_CONTENT) ;
 *   3. relecture ciblée de la source originale (mode SOURCE_RECHECK) : UNE
 *      question, la page connue — pas le pipeline T1.
 *
 * Le résultat n'est pas qu'une réponse de chat : il est réinjecté comme fait
 * (provenance REVALIDATION_T2), puis projeté sur le bien par les MÊMES règles
 * que T1 (preuves par champ + réconciliation T3 : une valeur validée par
 * l'utilisateur n'est jamais écrasée, l'arbitrage crée une action « À
 * traiter » si nécessaire). Un signal de lacune T1 est enregistré. Une
 * revalidation récente est réutilisée tant que la source et le fait n'ont
 * pas changé. Un échec ne modifie rien.
 *
 * LOT 15 (CDC 15 T2-27, T2-28, T2-30, §24 REVALIDATE) :
 *   · l'appel passe par la branche REVALIDATE du master T2 (`t2_revalidate`,
 *     PROVENANCE_MODE = TEXT | VISUAL) — seul moteur depuis le lot 16b-2
 *     (`revalidate_fact` retiré) ;
 *   · VISUAL_RECHECK : une observation VISUELLE (0161,
 *     sans extrait) est relue sur la source originale — jamais d'extrait
 *     inventé (C3, P-T2-04), preuve visuelle obligatoire, jamais « certaine » ;
 *   · T2-27 : AUCUNE écriture sur le bien hors du pipeline protégé
 *     (preuves par champ → réconciliation T3) ; l'impact de la revalidation
 *     (projection, preuves remplacées, effets T4) est tracé dans le signal
 *     (`t1_quality_signals.t2_result.impact`) ;
 *   · T2-28 : la projection est celle du rattachement tardif
 *     (`projectDocumentKnowledgeToAsset`) — preuves, T3, puis candidats
 *     agenda reconstruits et passés par la file T4.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { splitValueAndUnit } from '@/services/ai/knowledge/document-knowledge';
import type { AiCallBudget } from './ai-call-budget';

export type RevalidationTrigger = 'LOW_CONFIDENCE' | 'CONFLICT' | 'WEAK_EVIDENCE';
export type RevalidationMode = 'PERSISTED_CONTENT' | 'SOURCE_RECHECK' | 'VISUAL_RECHECK';
/** Provenance attendue par la branche REVALIDATE du master (§24). */
export type RevalidationProvenance = 'TEXT' | 'VISUAL';
/** Preuve visuelle d'une observation (0161 : `visual_evidence ? 'description'`). */
export interface VisualEvidence { description: string; page?: number | null }
export type RevalidationStatus = 'CONFIRMED' | 'CORRECTED' | 'NOT_FOUND' | 'AMBIGUOUS' | 'FAILED';

/** Sortie du master REVALIDATE, traduite (`fromT2Revalidate`). */
export interface RevalidationModelOutput {
  status: 'confirmed' | 'corrected' | 'not_found' | 'ambiguous';
  value?: string | null;
  unit?: string | null;
  confidence: 'certain' | 'probable';
  excerpt?: string | null;
  page?: number | null;
  /** PROVENANCE_MODE=VISUAL : preuve visuelle (C3). */
  visualEvidence?: VisualEvidence | null;
}

/** Fait à vérifier, tel que la base le connaît. */
export interface FactToCheck {
  id: number;
  accountId: number;
  fileId: number;
  extractionId: number;
  factKey: string;
  subject: string | null;
  attribute: string | null;
  label: string | null;
  valueText: string | null;
  valueNumber: number | null;
  valueUnit: string | null;
  confidence: string;
  /** Extrait littéral ; `null` pour une observation visuelle (0161). */
  excerpt: string | null;
  location: Record<string, unknown>;
  /** Provenance de la preuve T1 (0161) ; défaut TEXT_EXTRACTION. */
  evidenceOrigin?: 'TEXT_EXTRACTION' | 'VISUAL_ANALYSIS';
  visualEvidence?: VisualEvidence | null;
  // Extraction courante du document
  fullText: string | null;
  extractionVersion: string;
  t1Model: string | null;
  t1PromptVersion: string | null;
  analysisRunId: number | null;
  assetId: number | null;
}

export interface RevalidationResult {
  status: RevalidationStatus;
  mode: RevalidationMode;
  value: string | null;
  unit: string | null;
  confidence: 'certain' | 'probable' | null;
  excerpt: string | null;
  page: number | null;
  /** Fait réinjecté (provenance REVALIDATION_T2). */
  reinjectedFactId: number | null;
  /** Résultat récent réutilisé, sans nouvelle lecture. */
  reused: boolean;
  /** Preuve visuelle retenue (VISUAL_RECHECK). */
  visualEvidence?: VisualEvidence | null;
  /** T2-27 : impact tracé de la revalidation (null : rien de réinjecté). */
  impact?: RevalidationImpact | null;
  aiCalls: number;
  model: string | null;
  revalidationId: number | null;
}

/**
 * Impact d'une revalidation (T2-27) — tracé dans le signal de lacune. Aucune
 * écriture sur le bien n'a lieu hors de la projection (preuves → T3 → T4).
 */
export interface RevalidationImpact {
  assetId: number | null;
  /** La projection (preuves par champ + T3 + candidats T4) a abouti. */
  projected: boolean;
  /** Champs projetés (nombre rendu par la projection, si connu). */
  projectedFields: number | null;
  /** Preuves de l'ancien fait passées SUPERSEDED (T2-29). */
  supersededEvidence: number;
  /**
   * Mode du remplacement des preuves : `enabled` dès qu'un bien est projeté
   * (commutateur T3_NEGATIVE_RECONCILIATION retiré au lot 16b-3, valeur
   * conservée pour la lecture des traces).
   */
  evidenceMode: 'enabled' | null;
  /**
   * Effets agenda T4 au moment de la projection (candidats agenda, T2-28) :
   * `enabled` dès qu'un bien est projeté (commutateur AI_T4_EFFECTS retiré au
   * lot 16b-2, valeur conservée pour la lecture des traces).
   */
  t4Effects: 'enabled' | null;
  /** Écritures hors pipeline protégé : toujours 0 (T2-27). */
  directAssetWrites: 0;
}

// ── Fonctions pures ────────────────────────────────────────────────────────

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Valeur comparable d'un fait ou d'un résultat (« 24 kW » ≡ 24 + kW). */
export function comparable(value: string | null, unit: string | null): string {
  if (!value) return '';
  const split = splitValueAndUnit(value);
  if (split) return `${split.number}|${(split.unit ?? unit ?? '').toLowerCase()}`;
  const n = Number(value.replace(',', '.'));
  if (Number.isFinite(n) && /^\s*-?\d+([.,]\d+)?\s*$/.test(value)) return `${n}|${(unit ?? '').toLowerCase()}`;
  return norm(value);
}

export const factValue = (f: Pick<FactToCheck, 'valueText' | 'valueNumber'>) =>
  f.valueText ?? (f.valueNumber != null ? String(f.valueNumber) : null);

/**
 * Niveau 1, sans modèle : l'extrait de T1 figure-t-il dans le texte extrait
 * et porte-t-il la valeur ? Si oui, la valeur est établie par le document
 * lui-même — aucun appel, aucune relecture.
 */
export function confirmFromPersistedText(f: FactToCheck): boolean {
  const text = f.fullText ? norm(f.fullText) : '';
  const excerpt = norm(f.excerpt ?? '');
  const value = factValue(f);
  if (!text || excerpt.length < 4 || !value) return false;
  if (!text.includes(excerpt)) return false;
  const v = norm(value);
  const vNum = f.valueNumber != null ? String(f.valueNumber).replace('.', ',') : null;
  return excerpt.includes(v) || (vNum != null && excerpt.includes(norm(vNum)));
}

/** Fenêtre du texte persisté autour de l'information (jamais tout le document). */
export function windowAround(f: FactToCheck, max = 6000): string {
  const text = f.fullText ?? '';
  if (text.length <= max) return text;
  const hay = norm(text);
  const needles = [f.excerpt, f.attribute, f.label, f.subject].filter((x): x is string => !!x && x.length >= 3).map(norm);
  let at = -1;
  for (const n of needles) { const i = hay.indexOf(n); if (i >= 0) { at = i; break; } }
  if (at < 0) return text.slice(0, max);
  const start = Math.max(0, at - Math.floor(max / 2));
  return text.slice(start, start + max);
}

export function describeFact(f: FactToCheck): string {
  return [f.subject, f.attribute ?? f.label ?? f.factKey].filter(Boolean).join(' — ');
}

/** Un extrait rendu par le modèle en mode PERSISTED_CONTENT doit exister dans le texte. */
export function excerptIsGrounded(excerpt: string | null | undefined, fullText: string | null): boolean {
  if (!excerpt || !fullText) return false;
  const e = norm(excerpt);
  return e.length >= 4 && norm(fullText).includes(e);
}

/** Problème T1 à signaler, selon le déclencheur et le résultat. */
export function gapProblem(trigger: RevalidationTrigger, status: RevalidationStatus): string {
  if (status === 'CORRECTED') return 'POORLY_STRUCTURED';
  if (status === 'NOT_FOUND') return 'MISSING';
  if (trigger === 'CONFLICT') return 'CONFLICT';
  if (trigger === 'WEAK_EVIDENCE') return 'WEAK_EVIDENCE';
  return 'LOW_CONFIDENCE';
}

// ── Accès base ─────────────────────────────────────────────────────────────

/**
 * Charge le fait (du compte, document non supprimé) avec son extraction courante.
 * `includeVisual` (VISUAL_RECHECK) : les observations visuelles (0161) sont
 * aussi chargées ; sinon, faits LUS seulement.
 */
export async function loadFactToCheck(
  accountId: number, factId: number, opts: { includeVisual?: boolean } = {},
): Promise<FactToCheck | null> {
  const rows = (await pgClient.unsafe(
    `SELECT f.id::float8 AS id, f.account_id AS "accountId", f.file_id AS "fileId", f.extraction_id AS "extractionId",
            f.fact_key AS "factKey", f.subject, f.attribute, f.label, f.value_text AS "valueText",
            f.value_number::float8 AS "valueNumber", f.value_unit AS "valueUnit", f.confidence, f.excerpt, f.location,
            e.full_text AS "fullText", e.extracted_at::text AS "extractionVersion", e.model AS "t1Model",
            e.prompt_version AS "t1PromptVersion", e.analysis_run_id AS "analysisRunId",
            coalesce(af.asset_id, af.linked_asset_id) AS "assetId",
            coalesce(f.evidence_origin, 'TEXT_EXTRACTION') AS "evidenceOrigin", f.visual_evidence AS "visualEvidence"
       FROM document_facts f
       JOIN document_extractions e ON e.id = f.extraction_id
       JOIN asset_files af ON af.id = f.file_id AND af.deleted_at IS NULL
      WHERE f.id = $1 AND f.account_id = $2 AND f.status = 'active'
        -- La revalidation confronte un extrait au texte : une observation
        -- visuelle (sans extrait, 0161) n'en relève que par VISUAL_RECHECK.
        AND (f.evidence_origin = 'TEXT_EXTRACTION' OR ($3::boolean AND f.evidence_origin = 'VISUAL_ANALYSIS'))`,
    [factId, accountId, opts.includeVisual === true] as never[],
  )) as unknown as FactToCheck[];
  return rows[0] ?? null;
}

/** Revalidation récente réutilisable (même fait, même extraction). */
async function recentRevalidation(f: FactToCheck) {
  const rows = (await pgClient.unsafe(
    `SELECT id, status, mode, new_value, new_unit, new_confidence, excerpt, page, reinjected_fact_id, model
       FROM verebona_fact_revalidations
      WHERE fact_id = $1 AND extraction_version = $2
        AND (
          (status IN ('CONFIRMED', 'CORRECTED') AND created_at > now() - interval '30 days')
          OR (status IN ('NOT_FOUND', 'AMBIGUOUS', 'FAILED') AND created_at > now() - interval '1 day')
        )
      ORDER BY created_at DESC LIMIT 1`,
    [f.id, f.extractionVersion] as never[],
  )) as unknown as Array<{
    id: number; status: RevalidationStatus; mode: RevalidationMode; new_value: string | null; new_unit: string | null;
    new_confidence: 'certain' | 'probable' | null; excerpt: string | null; page: number | null; reinjected_fact_id: number | null; model: string | null;
  }>;
  return rows[0] ?? null;
}

// ── Dépendances (injectables pour les tests) ───────────────────────────────

export interface RevalidationDeps {
  /** Appel modèle ciblé (branche REVALIDATE du master T2, `t2_revalidate`). */
  callModel(req: {
    accountId: number; userId: number; conversationId?: number;
    question: string; fact: string; currentValue: string; location: string;
    mode: RevalidationMode; content: string;
    attachment?: { url: string; mimeType: string; displayName?: string };
    /** PROVENANCE_MODE du master (TEXT pour un fait lu, VISUAL pour une observation). */
    provenance?: RevalidationProvenance;
    /** Budget d'appels modèle du message (§15.5, CA-07). */
    budget?: AiCallBudget;
    /** Demande d'origine : rattache l'appel à `verebona_ai_runs` (§28.8). */
    requestId?: string;
  }): Promise<{ output: RevalidationModelOutput; model: string | null; costMicros: number } | null>;
  /** URL signée de la source originale (pour SOURCE_RECHECK). */
  sourceUrl(accountId: number, fileId: number): Promise<{ url: string; mimeType: string; displayName?: string } | null>;
  /**
   * Projection sur le bien par les règles communes (preuves + T3, puis
   * candidats agenda T4) — SEUL chemin d'écriture vers le bien (T2-27).
   * Rend le nombre de champs projetés si connu.
   */
  project(p: { accountId: number; userId: number; fileId: number; assetId: number }): Promise<number | void>;
  /**
   * Tableau persisté d'où provient le fait (texte borné) — la revalidation
   * d'une cellule relit CE tableau, pas le document entier. Facultatif.
   */
  tableText?(accountId: number, fileId: number, tableIndex: number): Promise<string | null>;
  /**
   * CDC 15 T2-29 (lot 13) : remplacement des preuves de l'ancien fait.
   * Facultatif (tests) ; défaut : `replaceRevalidatedEvidence`.
   */
  replaceEvidence?(p: ReplaceEvidenceInput): Promise<ReplaceEvidenceResult>;
}

export interface ReplaceEvidenceInput {
  accountId: number;
  fileId: number;
  assetId: number;
  factKey: string;
  /** Valeur établie par la revalidation (celle de la nouvelle preuve). */
  newValue: string;
  /** La projection du fait revalidé (preuves + T3) ; peut lever. */
  project: () => Promise<number | void>;
  /**
   * Réconciliation T3 du bien APRÈS le remplacement (corpus §15 E2E-T2-22) :
   * la projection a réconcilié pendant que l'ancienne preuve était encore
   * active — la fiche gardait l'ancienne valeur. Appelée seulement si des
   * preuves ont été remplacées (mode enabled) ; ne fait jamais échouer.
   */
  reconcile?: () => Promise<unknown>;
}

export interface ReplaceEvidenceResult {
  superseded: number;
  /** false : la projection a échoué — rien n'a été retiré. */
  projected: boolean;
}

/**
 * T2-29 — les preuves revalidées REMPLACENT les anciennes. Ordre sûr
 * (relecture lot 13) :
 *   1. PROJECTION d'abord (la nouvelle preuve est écrite, T3 relancé) ;
 *      si elle échoue, rien n'est retiré (journalisé) ;
 *   2. puis, seulement s'il existe une preuve ACTIVE de la valeur revalidée
 *      (la remplaçante), les autres preuves ACTIVE du champ pour ce document
 *      et ce bien passent SUPERSEDED, reliées à elle, puis le bien est
 *      réconcilié.
 */
export async function replaceRevalidatedEvidence(p: ReplaceEvidenceInput): Promise<ReplaceEvidenceResult> {
  try {
    await p.project();
  } catch (e) {
    console.error(`[revalidation] projection du fait ${p.factKey} (document ${p.fileId}) en échec — aucune preuve retirée :`, (e as Error).message);
    return { superseded: 0, projected: false };
  }
  const { supersedeFieldEvidenceExcept } = await import('@/services/ai/evidence/field-evidence.service');
  const { resolveAlias } = await import('@/services/canonical/registry');
  const fieldKeys = [...new Set([p.factKey, resolveAlias(p.factKey) ?? p.factKey])];
  try {
    const r = await supersedeFieldEvidenceExcept({
      accountId: p.accountId, sourceId: p.fileId, assetId: p.assetId, fieldKeys, keepValue: p.newValue,
    });
    if (r.superseded > 0 && p.reconcile) {
      await p.reconcile().catch((e: Error) => console.error('[revalidation] réconciliation après remplacement :', e.message));
    }
    return { superseded: r.superseded, projected: true };
  } catch (e) {
    console.error('[revalidation] remplacement des anciennes preuves :', (e as Error).message);
    return { superseded: 0, projected: true };
  }
}

export const defaultRevalidationDeps: RevalidationDeps = {
  async callModel(req) {
    const { executeWithinBudget } = await import('./ai-call-budget');
    return callT2RevalidateMaster(req, executeWithinBudget);
  },
  async sourceUrl(accountId, fileId) {
    const [row] = (await pgClient.unsafe(
      `SELECT s3_key AS "s3Key", s3_bucket AS "s3Bucket", mime_type AS "mimeType", original_filename AS name
         FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
      [fileId, accountId] as never[],
    )) as unknown as Array<{ s3Key: string | null; s3Bucket: string | null; mimeType: string | null; name: string | null }>;
    if (!row?.s3Key || !row.s3Bucket) return null;
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const { s3Client } = await import('@/lib/s3-client');
    const url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: row.s3Bucket, Key: row.s3Key }), { expiresIn: 900 });
    return { url, mimeType: row.mimeType ?? 'application/pdf', displayName: row.name ?? undefined };
  },
  async project(p) {
    const { projectDocumentKnowledgeToAsset } = await import('@/services/ai/knowledge/document-knowledge.service');
    return projectDocumentKnowledgeToAsset(p);
  },
  async tableText(accountId, fileId, tableIndex) {
    const { getDocumentTables } = await import('@/services/ai/knowledge/document-knowledge.service');
    const { renderTableText } = await import('@/services/ai/knowledge/document-tables');
    const t = (await getDocumentTables(accountId, fileId)).find((x) => x.index === tableIndex);
    return t ? renderTableText(t) : null;
  },
};

/**
 * Branche REVALIDATE du master T2 (§24, C1–C5). Sortie traduite vers la
 * forme historique ; en VISUAL, l'extrait est TOUJOURS retiré (C3,
 * P-T2-04) — une observation n'est jamais une citation.
 */
export function fromT2Revalidate(
  o: { status: RevalidationModelOutput['status']; value?: string | null; unit?: string | null; confidence: 'certain' | 'probable';
    evidence: { provenance: 'TEXT_EXTRACTION' | 'VISUAL_ANALYSIS'; excerpt?: string | null; page?: number | null;
      visualEvidence?: string | { description: string; page?: number } | null } },
  provenance: RevalidationProvenance,
): RevalidationModelOutput {
  const ve = o.evidence.visualEvidence;
  const visual: VisualEvidence | null = typeof ve === 'string'
    ? (ve.trim() ? { description: ve.trim(), page: o.evidence.page ?? null } : null)
    : ve ? { description: ve.description, page: ve.page ?? o.evidence.page ?? null } : null;
  const visuel = provenance === 'VISUAL' || o.evidence.provenance === 'VISUAL_ANALYSIS';
  return {
    status: o.status,
    value: o.value ?? null,
    unit: o.unit ?? null,
    confidence: o.confidence,
    excerpt: visuel ? null : (o.evidence.excerpt ?? null),
    page: o.evidence.page ?? visual?.page ?? null,
    visualEvidence: visuel ? visual : null,
  };
}

async function callT2RevalidateMaster(
  req: Parameters<RevalidationDeps['callModel']>[0],
  executeWithinBudget: typeof import('./ai-call-budget').executeWithinBudget,
): Promise<{ output: RevalidationModelOutput; model: string | null; costMicros: number } | null> {
  const { T2RevalidateOutput } = await import('@/services/ai/assistant/master/t2-contract');
  const { t2MasterVariables } = await import('@/services/ai/assistant/master/t2-answer');
  const { maskSensitiveText, sensitiveNecessityFor } = await import('./sensitive-data.policy');
  const provenance = req.provenance ?? (req.mode === 'VISUAL_RECHECK' ? 'VISUAL' : 'TEXT');
  try {
    const res = await executeWithinBudget(req.budget, {
      useCaseCode: 'INTELLIGENT_ASSISTANT',
      operationCode: 't2_revalidate',
      accountId: req.accountId,
      userId: req.userId,
      promptVariables: t2MasterVariables('REVALIDATE', {
        // §29.4 : la question est masquée comme pour les autres branches.
        QUESTION: maskSensitiveText(req.question, sensitiveNecessityFor(req.question)).text.replace(/</g, '&lt;'),
        FACT: req.fact, CURRENT_VALUE: req.currentValue, PROVENANCE_MODE: provenance,
        LOCATION: req.location, CONTENT: req.content.replace(/</g, '&lt;'),
      }),
      attachments: req.attachment ? [req.attachment] : undefined,
      outputSchema: T2RevalidateOutput,
    }, req.requestId ? {
      requestId: req.requestId, routeReason: `revalidation ${req.mode}`,
      promptId: 't2_master_v1', promptVersion: 'REVALIDATE',
    } : undefined);
    return { output: fromT2Revalidate(res.data, provenance), model: res.model ?? null, costMicros: res.costMicros ?? 0 };
  } catch (e) {
    console.warn('[revalidation] appel master impossible :', (e as Error).message);
    return null;
  }
}

/** Contexte tabulaire d'un fait issu d'une cellule (0162), ou null. */
export function tableContextOf(f: Pick<FactToCheck, 'location'>): { tableIndex: number; title: string | null; rowHeader: string | null; columnHeader: string | null; page: number | null } | null {
  const t = f.location?.table as Record<string, unknown> | undefined;
  if (!t || typeof t.tableIndex !== 'number') return null;
  return {
    tableIndex: t.tableIndex,
    title: (t.title as string | null) ?? null,
    rowHeader: (t.rowHeader as string | null) ?? null,
    columnHeader: (t.columnHeader as string | null) ?? null,
    page: typeof t.page === 'number' ? t.page : null,
  };
}

export function describeLocation(page: number | null, table: ReturnType<typeof tableContextOf>): string {
  const parts: string[] = [];
  if (page ?? table?.page) parts.push(`page ${page ?? table?.page}`);
  if (table) {
    parts.push(`tableau${table.title ? ` « ${table.title} »` : ` n° ${table.tableIndex + 1}`}`);
    if (table.rowHeader) parts.push(`ligne « ${table.rowHeader} »`);
    if (table.columnHeader) parts.push(`colonne « ${table.columnHeader} »`);
  }
  return parts.length ? parts.join(', ') : 'inconnue';
}

// ── Parcours ───────────────────────────────────────────────────────────────

export async function revalidateFact(
  p: {
    accountId: number; userId: number; conversationId?: number; requestId?: string;
    factId: number; question: string; trigger: RevalidationTrigger;
    /**
     * Appels modèle permis (usage basculé, offre éligible). Sinon, seule la
     * vérification sans modèle sur le contenu persisté est tentée.
     */
    allowModel?: boolean;
    /**
     * Budget d'appels modèle du message (§15.5, CA-07). Épuisé : aucune
     * relecture par modèle n'est tentée, seule la vérification sans modèle
     * reste possible.
     */
    budget?: AiCallBudget;
  },
  deps: RevalidationDeps = defaultRevalidationDeps,
): Promise<RevalidationResult | null> {
  // Branche REVALIDATE du master T2 : faits lus ET observations visuelles
  // (VISUAL_RECHECK).
  const f = await loadFactToCheck(p.accountId, p.factId, { includeVisual: true });
  if (!f) return null;
  const visuel = f.evidenceOrigin === 'VISUAL_ANALYSIS';

  // Déduplication : même fait, même extraction → on réutilise.
  const prev = await recentRevalidation(f);
  if (prev) {
    return {
      status: prev.status, mode: prev.mode, value: prev.new_value, unit: prev.new_unit, confidence: prev.new_confidence,
      excerpt: prev.excerpt, page: prev.page, reinjectedFactId: prev.reinjected_fact_id, reused: true, aiCalls: 0,
      model: prev.model, revalidationId: prev.id,
    };
  }

  const initial = factValue(f);
  const table = tableContextOf(f);
  const page = typeof f.location?.page === 'number' ? (f.location.page as number) : (table?.page ?? null);
  // Fait issu d'une cellule : seul le tableau concerné est relu (T2-07).
  const tableText = table && deps.tableText ? await deps.tableText(p.accountId, f.fileId, table.tableIndex).catch(() => null) : null;
  const grounded = (excerpt: string | null | undefined) => excerptIsGrounded(excerpt, f.fullText) || excerptIsGrounded(excerpt, tableText);
  let aiCalls = 0;
  let costMicros = 0;
  let model: string | null = null;
  let mode: RevalidationMode = 'PERSISTED_CONTENT';
  let out: { status: RevalidationStatus; value: string | null; unit: string | null; confidence: 'certain' | 'probable' | null; excerpt: string | null; page: number | null; visualEvidence?: VisualEvidence | null } | null = null;

  // 1. Contenu persisté, sans modèle (faits LUS seulement).
  if (!visuel && p.trigger !== 'CONFLICT' && confirmFromPersistedText(f)) {
    out = { status: 'CONFIRMED', value: initial, unit: f.valueUnit, confidence: 'certain', excerpt: f.excerpt, page };
  }

  const ask = async (m: RevalidationMode, content: string, attachment?: { url: string; mimeType: string; displayName?: string }) => {
    // Budget du message épuisé : pas d'appel, donc pas de tentative comptée.
    if (p.budget && !p.budget.canCall()) return null;
    aiCalls += 1;
    const r = await deps.callModel({
      accountId: p.accountId, userId: p.userId, conversationId: p.conversationId,
      question: p.question, fact: describeFact(f), currentValue: `${initial ?? '—'}${f.valueUnit ? ` ${f.valueUnit}` : ''}`,
      location: describeLocation(page, table), mode: m, content, attachment, budget: p.budget,
      requestId: p.requestId, provenance: visuel ? 'VISUAL' : 'TEXT',
    });
    if (!r) return null;
    model = r.model; costMicros += r.costMicros;
    return r.output;
  };
  const traduire = (o: RevalidationModelOutput, m: RevalidationMode) => {
    const st: RevalidationStatus = o.status === 'confirmed' ? 'CONFIRMED' : o.status === 'corrected' ? 'CORRECTED' : o.status === 'not_found' ? 'NOT_FOUND' : 'AMBIGUOUS';
    const value = st === 'CONFIRMED' ? (o.value ?? initial) : (o.value ?? null);
    return {
      status: st, value, unit: o.unit ?? (st === 'CONFIRMED' ? f.valueUnit : null), confidence: o.confidence,
      // Observation visuelle : jamais d'extrait (C3, P-T2-04, contrainte 0161).
      excerpt: visuel ? null : (o.excerpt ?? null), page: o.page ?? page, mode: m,
      visualEvidence: visuel ? (o.visualEvidence ?? null) : null,
    };
  };

  // Sans modèle permis, rien d'autre n'est tenté — et rien n'est tracé comme
  // un échec : aucune vérification n'a eu lieu.
  if (!out && p.allowModel === false) return null;

  // VISUAL_RECHECK : l'observation est relue sur la SOURCE (pas de texte à
  // confronter). Établie seulement avec une preuve visuelle ; jamais
  // « certaine » (aucun texte pour la contrôler).
  if (!out && visuel) {
    const src = await deps.sourceUrl(p.accountId, f.fileId).catch(() => null);
    if (src) {
      mode = 'VISUAL_RECHECK';
      const origine = f.visualEvidence?.description ? ` Observation d'origine : ${f.visualEvidence.description}.` : '';
      const o = await ask('VISUAL_RECHECK', `${page ? `Observe uniquement la page ${page}.` : 'Observe uniquement cette information.'}${origine}`, src);
      if (o) {
        const t = traduire(o, 'VISUAL_RECHECK');
        t.confidence = t.confidence ? 'probable' : t.confidence;
        const etablie = (t.status === 'CONFIRMED' || t.status === 'CORRECTED') && t.value && t.visualEvidence?.description;
        out = (t.status === 'CONFIRMED' || t.status === 'CORRECTED') && !etablie ? { ...t, status: 'AMBIGUOUS' } : t;
      } else {
        out = { status: 'FAILED', value: null, unit: null, confidence: null, excerpt: null, page };
      }
    }
  }

  // 2. Contenu persisté, avec modèle — l'extrait doit exister dans le texte.
  if (!out && !visuel && (tableText || f.fullText)) {
    const o = await ask('PERSISTED_CONTENT', tableText ?? windowAround(f));
    if (o) {
      const t = traduire(o, 'PERSISTED_CONTENT');
      const etabli = (t.status === 'CONFIRMED' || t.status === 'CORRECTED') && grounded(t.excerpt) && t.value;
      if (etabli) out = t;
    }
  }

  // 3. Relecture ciblée de la source originale.
  if (!out && !visuel) {
    const src = await deps.sourceUrl(p.accountId, f.fileId).catch(() => null);
    if (src) {
      mode = 'SOURCE_RECHECK';
      const o = await ask(
        'SOURCE_RECHECK',
        table
          ? `Regarde uniquement ${describeLocation(page, table)} : la cellule à l'intersection de cette ligne et de cette colonne.`
          : page ? `Regarde uniquement la page ${page}.` : 'Cherche uniquement cette information.',
        src,
      );
      if (o) {
        const t = traduire(o, 'SOURCE_RECHECK');
        // Sans texte persisté pour la contrôler, une valeur relue n'est jamais « certaine ».
        if (t.confidence === 'certain' && !grounded(t.excerpt)) t.confidence = 'probable';
        out = (t.status === 'CONFIRMED' || t.status === 'CORRECTED') && !t.value ? { ...t, status: 'AMBIGUOUS' } : t;
      } else {
        out = { status: 'FAILED', value: null, unit: null, confidence: null, excerpt: null, page };
      }
    }
  }
  if (!out) out = { status: 'FAILED', value: null, unit: null, confidence: null, excerpt: null, page };
  // Une « correction » vers la même valeur est une confirmation.
  if (out.status === 'CORRECTED' && comparable(out.value, out.unit) === comparable(initial, f.valueUnit)) out.status = 'CONFIRMED';

  // ── Trace (avant réinjection : son id est la provenance du nouveau fait) ─
  const [rev] = (await pgClient.unsafe(
    `INSERT INTO verebona_fact_revalidations
       (account_id, user_id, conversation_id, request_id, file_id, fact_id, extraction_id, extraction_version,
        fact_key, question, trigger_reason, initial_value, initial_confidence, mode, status,
        new_value, new_unit, new_confidence, excerpt, page, model, ai_calls, cost_micros)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     RETURNING id`,
    [p.accountId, p.userId, p.conversationId ?? null, p.requestId ?? null, f.fileId, f.id, f.extractionId, f.extractionVersion,
     f.factKey, p.question, p.trigger, initial, f.confidence, mode, out.status,
     out.value, out.unit, out.confidence, out.excerpt, out.page, model, aiCalls, costMicros] as never[],
  )) as unknown as Array<{ id: number }>;

  // ── Réinjection : seulement un résultat établi ──────────────────────────
  let reinjectedFactId: number | null = null;
  let impact: RevalidationImpact | null = null;
  if ((out.status === 'CONFIRMED' || out.status === 'CORRECTED') && out.value) {
    reinjectedFactId = await reinject(f, { ...out, value: out.value, confidence: out.confidence ?? 'probable' }, rev.id, model);
    impact = {
      assetId: f.assetId, projected: false, projectedFields: null, supersededEvidence: 0, evidenceMode: null,
      t4Effects: f.assetId ? 'enabled' : null, directAssetWrites: 0,
    };
    if (f.assetId) {
      // Mêmes règles communes que T1 : preuves par champ puis T3 (valeurs
      // utilisateur protégées, arbitrage « À traiter » si nécessaire), puis
      // candidats agenda (T4, T2-28). AUCUNE autre écriture sur le bien (T2-27).
      const assetId = f.assetId;
      const trace = impact;
      const project = async () => {
        const n = await deps.project({ accountId: p.accountId, userId: p.userId, fileId: f.fileId, assetId });
        trace.projected = true;
        trace.projectedFields = typeof n === 'number' ? n : null;
        return n;
      };
      // T2-29 : l'ancien fait a cédé la place (confirmé, ou corrigé avec une
      // preuve certaine) — ses preuves aussi, APRÈS la projection. Sinon les
      // deux faits restent actifs, comme leurs preuves (conflit conservé).
      if (out.status === 'CONFIRMED' || out.confidence === 'certain') {
        const r = await (deps.replaceEvidence ?? replaceRevalidatedEvidence)({
          accountId: p.accountId, fileId: f.fileId, assetId, factKey: f.factKey, newValue: out.value, project,
          reconcile: async () => (await import('@/services/ai/reconciliation/t3-queue')).enqueueT3ForAssets({
            accountId: p.accountId, userId: p.userId, assetIds: [assetId], sourceFileId: f.fileId, reason: 'FACT_REVALIDATED',
          }),
        }).catch((e: Error) => { console.error('[revalidation] remplacement des preuves :', e.message); return null; });
        if (r) { trace.supersededEvidence = r.superseded; trace.evidenceMode = 'enabled'; trace.projected = r.projected; }
      } else {
        await project().catch((e: Error) => console.error('[revalidation] projection :', e.message));
      }
    }
  }

  // ── Signal de lacune T1 : T2 a dû compenser ─────────────────────────────
  const [sig] = (await pgClient.unsafe(
    `INSERT INTO t1_quality_signals
       (account_id, file_id, extraction_id, analysis_run_id, fact_key, information, problem, t2_result, t1_model, t1_prompt_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id`,
    [p.accountId, f.fileId, f.extractionId, f.analysisRunId, f.factKey, describeFact(f), gapProblem(p.trigger, out.status),
     JSON.stringify({
       status: out.status, mode, value: out.value, unit: out.unit, confidence: out.confidence, revalidationId: rev.id,
       architecture: 'master',
       ...(out.visualEvidence ? { visualEvidence: out.visualEvidence } : {}),
       // T2-27 : trace d'impact (projection, preuves remplacées, effets T4).
       ...(impact ? { impact } : {}),
     }),
     f.t1Model, f.t1PromptVersion] as never[],
  )) as unknown as Array<{ id: number }>;
  await pgClient.unsafe(
    `UPDATE verebona_fact_revalidations SET reinjected_fact_id = $2, signal_id = $3 WHERE id = $1`,
    [rev.id, reinjectedFactId, sig.id] as never[],
  );

  return {
    status: out.status, mode, value: out.value, unit: out.unit, confidence: out.confidence, excerpt: out.excerpt,
    page: out.page, reinjectedFactId, reused: false, aiCalls, model, revalidationId: rev.id,
    visualEvidence: out.visualEvidence ?? null, impact,
  };
}

/**
 * Nouveau fait, provenance REVALIDATION_T2, même document, même extraction.
 *
 *   · confirmé : l'ancien fait T1 cède la place (superseded) au fait vérifié ;
 *   · corrigé avec preuve certaine : même règle — c'est LE MÊME document relu
 *     avec une preuve littérale ; les autres documents et les valeurs de
 *     l'utilisateur ne sont pas touchés ;
 *   · corrigé sans certitude : les deux faits restent actifs — le conflit est
 *     conservé, jamais tranché en silence.
 */
async function reinject(
  f: FactToCheck,
  out: { status: RevalidationStatus; value: string; unit: string | null; confidence: 'certain' | 'probable'; excerpt: string | null; page: number | null; visualEvidence?: VisualEvidence | null },
  revalidationId: number,
  model: string | null,
  promptVersion = 't2_master_v1',
): Promise<number> {
  return pgClient.begin(async (tx) => {
    const split = splitValueAndUnit(out.value);
    const valueNumber = split ? split.number : (Number.isFinite(Number(out.value.replace(',', '.'))) && /^\s*-?\d+([.,]\d+)?\s*$/.test(out.value) ? Number(out.value.replace(',', '.')) : null);
    const unit = out.unit ?? split?.unit ?? null;
    const location = { ...(f.location ?? {}), ...(out.page ? { page: out.page } : {}) };
    // Observation visuelle (VISUAL_RECHECK) : provenance VISUAL_ANALYSIS,
    // AUCUN extrait, preuve visuelle décrite (contrainte 0161).
    const visuel = f.evidenceOrigin === 'VISUAL_ANALYSIS';
    const visual = visuel ? (out.visualEvidence ?? f.visualEvidence ?? null) : null;
    const [row] = (visuel
      ? await tx.unsafe(
        `INSERT INTO document_facts (
           account_id, file_id, extraction_id, fact_key, subject, attribute, label,
           value_text, value_number, value_unit, value_json, normalized_value,
           confidence, excerpt, location, source_type, provider, model, prompt_version, status, provenance, revalidation_id,
           evidence_origin, visual_evidence
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,NULL,$14::jsonb,'asset_file','gemini',$15,$18,'active','REVALIDATION_T2',$16,
                   'VISUAL_ANALYSIS',$17::jsonb)
         RETURNING id::float8 AS id`,
        [f.accountId, f.fileId, f.extractionId, f.factKey, f.subject, f.attribute, f.label,
         out.value, valueNumber, unit, JSON.stringify(out.value), valueNumber != null ? String(valueNumber) : norm(out.value),
         out.confidence, JSON.stringify(location), model, revalidationId, JSON.stringify(visual), promptVersion] as never[],
      )
      : await tx.unsafe(
        `INSERT INTO document_facts (
           account_id, file_id, extraction_id, fact_key, subject, attribute, label,
           value_text, value_number, value_unit, value_json, normalized_value,
           confidence, excerpt, location, source_type, provider, model, prompt_version, status, provenance, revalidation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,'asset_file','gemini',$16,$18,'active','REVALIDATION_T2',$17)
         RETURNING id::float8 AS id`,
        [f.accountId, f.fileId, f.extractionId, f.factKey, f.subject, f.attribute, f.label,
         out.value, valueNumber, unit, JSON.stringify(out.value), valueNumber != null ? String(valueNumber) : norm(out.value),
         out.confidence, out.excerpt ?? f.excerpt, JSON.stringify(location), model, revalidationId, promptVersion] as never[],
      )) as unknown as Array<{ id: number }>;
    if (out.status === 'CONFIRMED' || out.confidence === 'certain') {
      await tx.unsafe(`UPDATE document_facts SET status = 'superseded' WHERE id = $1`, [f.id] as never[]);
    }
    return row.id;
  }) as Promise<number>;
}
