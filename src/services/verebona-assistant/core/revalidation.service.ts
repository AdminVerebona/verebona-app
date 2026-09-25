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
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';
import { pgClient } from '@/db';
import { splitValueAndUnit } from '@/services/ai/knowledge/document-knowledge';

export type RevalidationTrigger = 'LOW_CONFIDENCE' | 'CONFLICT' | 'WEAK_EVIDENCE';
export type RevalidationMode = 'PERSISTED_CONTENT' | 'SOURCE_RECHECK';
export type RevalidationStatus = 'CONFIRMED' | 'CORRECTED' | 'NOT_FOUND' | 'AMBIGUOUS' | 'FAILED';

export const RevalidationOutput = z.object({
  status: z.enum(['confirmed', 'corrected', 'not_found', 'ambiguous']),
  value: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
  unit: z.string().nullable().optional(),
  confidence: z.enum(['certain', 'probable']).default('probable'),
  excerpt: z.string().nullable().optional(),
  page: z.number().int().positive().nullable().optional(),
});
export type RevalidationModelOutput = z.infer<typeof RevalidationOutput>;

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
  excerpt: string;
  location: Record<string, unknown>;
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
  aiCalls: number;
  model: string | null;
  revalidationId: number | null;
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

/** Charge le fait (du compte, document non supprimé) avec son extraction courante. */
export async function loadFactToCheck(accountId: number, factId: number): Promise<FactToCheck | null> {
  const rows = (await pgClient.unsafe(
    `SELECT f.id::float8 AS id, f.account_id AS "accountId", f.file_id AS "fileId", f.extraction_id AS "extractionId",
            f.fact_key AS "factKey", f.subject, f.attribute, f.label, f.value_text AS "valueText",
            f.value_number::float8 AS "valueNumber", f.value_unit AS "valueUnit", f.confidence, f.excerpt, f.location,
            e.full_text AS "fullText", e.extracted_at::text AS "extractionVersion", e.model AS "t1Model",
            e.prompt_version AS "t1PromptVersion", e.analysis_run_id AS "analysisRunId",
            coalesce(af.asset_id, af.linked_asset_id) AS "assetId"
       FROM document_facts f
       JOIN document_extractions e ON e.id = f.extraction_id
       JOIN asset_files af ON af.id = f.file_id AND af.deleted_at IS NULL
      WHERE f.id = $1 AND f.account_id = $2 AND f.status = 'active'
        -- La revalidation confronte un extrait au texte : une observation
        -- visuelle (sans extrait, 0161) n'en relève pas.
        AND f.evidence_origin = 'TEXT_EXTRACTION'`,
    [factId, accountId] as never[],
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
  /** Appel modèle ciblé (opération revalidate_fact, usage T2). */
  callModel(req: {
    accountId: number; userId: number; conversationId?: number;
    question: string; fact: string; currentValue: string; location: string;
    mode: RevalidationMode; content: string;
    attachment?: { url: string; mimeType: string; displayName?: string };
  }): Promise<{ output: RevalidationModelOutput; model: string | null; costMicros: number } | null>;
  /** URL signée de la source originale (pour SOURCE_RECHECK). */
  sourceUrl(accountId: number, fileId: number): Promise<{ url: string; mimeType: string; displayName?: string } | null>;
  /** Projection sur le bien par les règles communes (preuves + T3). */
  project(p: { accountId: number; userId: number; fileId: number; assetId: number }): Promise<void>;
  /**
   * Tableau persisté d'où provient le fait (texte borné) — la revalidation
   * d'une cellule relit CE tableau, pas le document entier. Facultatif.
   */
  tableText?(accountId: number, fileId: number, tableIndex: number): Promise<string | null>;
}

export const defaultRevalidationDeps: RevalidationDeps = {
  async callModel(req) {
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    try {
      const res = await AiGateway.execute({
        useCaseCode: 'INTELLIGENT_ASSISTANT',
        operationCode: 'revalidate_fact',
        accountId: req.accountId,
        userId: req.userId,
        promptVariables: {
          QUESTION: req.question, FACT: req.fact, CURRENT_VALUE: req.currentValue,
          LOCATION: req.location, MODE: req.mode === 'PERSISTED_CONTENT' ? 'texte déjà extrait du document' : 'document original joint',
          CONTENT: req.content,
        },
        attachments: req.attachment ? [req.attachment] : undefined,
        outputSchema: RevalidationOutput,
      });
      return { output: res.data, model: res.model ?? null, costMicros: res.costMicros ?? 0 };
    } catch (e) {
      console.warn('[revalidation] appel modèle impossible :', (e as Error).message);
      return null;
    }
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
    await projectDocumentKnowledgeToAsset(p);
  },
  async tableText(accountId, fileId, tableIndex) {
    const { getDocumentTables } = await import('@/services/ai/knowledge/document-knowledge.service');
    const { renderTableText } = await import('@/services/ai/knowledge/document-tables');
    const t = (await getDocumentTables(accountId, fileId)).find((x) => x.index === tableIndex);
    return t ? renderTableText(t) : null;
  },
};

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
  },
  deps: RevalidationDeps = defaultRevalidationDeps,
): Promise<RevalidationResult | null> {
  const f = await loadFactToCheck(p.accountId, p.factId);
  if (!f) return null;

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
  let out: { status: RevalidationStatus; value: string | null; unit: string | null; confidence: 'certain' | 'probable' | null; excerpt: string | null; page: number | null } | null = null;

  // 1. Contenu persisté, sans modèle.
  if (p.trigger !== 'CONFLICT' && confirmFromPersistedText(f)) {
    out = { status: 'CONFIRMED', value: initial, unit: f.valueUnit, confidence: 'certain', excerpt: f.excerpt, page };
  }

  const ask = async (m: RevalidationMode, content: string, attachment?: { url: string; mimeType: string; displayName?: string }) => {
    aiCalls += 1;
    const r = await deps.callModel({
      accountId: p.accountId, userId: p.userId, conversationId: p.conversationId,
      question: p.question, fact: describeFact(f), currentValue: `${initial ?? '—'}${f.valueUnit ? ` ${f.valueUnit}` : ''}`,
      location: describeLocation(page, table), mode: m, content, attachment,
    });
    if (!r) return null;
    model = r.model; costMicros += r.costMicros;
    return r.output;
  };
  const traduire = (o: RevalidationModelOutput, m: RevalidationMode) => {
    const st: RevalidationStatus = o.status === 'confirmed' ? 'CONFIRMED' : o.status === 'corrected' ? 'CORRECTED' : o.status === 'not_found' ? 'NOT_FOUND' : 'AMBIGUOUS';
    const value = st === 'CONFIRMED' ? (o.value ?? initial) : (o.value ?? null);
    return { status: st, value, unit: o.unit ?? (st === 'CONFIRMED' ? f.valueUnit : null), confidence: o.confidence, excerpt: o.excerpt ?? null, page: o.page ?? page, mode: m };
  };

  // Sans modèle permis, rien d'autre n'est tenté — et rien n'est tracé comme
  // un échec : aucune vérification n'a eu lieu.
  if (!out && p.allowModel === false) return null;

  // 2. Contenu persisté, avec modèle — l'extrait doit exister dans le texte.
  if (!out && (tableText || f.fullText)) {
    const o = await ask('PERSISTED_CONTENT', tableText ?? windowAround(f));
    if (o) {
      const t = traduire(o, 'PERSISTED_CONTENT');
      const etabli = (t.status === 'CONFIRMED' || t.status === 'CORRECTED') && grounded(t.excerpt) && t.value;
      if (etabli) out = t;
    }
  }

  // 3. Relecture ciblée de la source originale.
  if (!out) {
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
  if ((out.status === 'CONFIRMED' || out.status === 'CORRECTED') && out.value) {
    reinjectedFactId = await reinject(f, { ...out, value: out.value, confidence: out.confidence ?? 'probable' }, rev.id, model);
    if (f.assetId) {
      // Mêmes règles communes que T1 : preuves par champ puis T3 (valeurs
      // utilisateur protégées, arbitrage « À traiter » si nécessaire).
      await deps.project({ accountId: p.accountId, userId: p.userId, fileId: f.fileId, assetId: f.assetId })
        .catch((e: Error) => console.error('[revalidation] projection :', e.message));
    }
  }

  // ── Signal de lacune T1 : T2 a dû compenser ─────────────────────────────
  const [sig] = (await pgClient.unsafe(
    `INSERT INTO t1_quality_signals
       (account_id, file_id, extraction_id, analysis_run_id, fact_key, information, problem, t2_result, t1_model, t1_prompt_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id`,
    [p.accountId, f.fileId, f.extractionId, f.analysisRunId, f.factKey, describeFact(f), gapProblem(p.trigger, out.status),
     JSON.stringify({ status: out.status, mode, value: out.value, unit: out.unit, confidence: out.confidence, revalidationId: rev.id }),
     f.t1Model, f.t1PromptVersion] as never[],
  )) as unknown as Array<{ id: number }>;
  await pgClient.unsafe(
    `UPDATE verebona_fact_revalidations SET reinjected_fact_id = $2, signal_id = $3 WHERE id = $1`,
    [rev.id, reinjectedFactId, sig.id] as never[],
  );

  return {
    status: out.status, mode, value: out.value, unit: out.unit, confidence: out.confidence, excerpt: out.excerpt,
    page: out.page, reinjectedFactId, reused: false, aiCalls, model, revalidationId: rev.id,
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
  out: { status: RevalidationStatus; value: string; unit: string | null; confidence: 'certain' | 'probable'; excerpt: string | null; page: number | null },
  revalidationId: number,
  model: string | null,
): Promise<number> {
  return pgClient.begin(async (tx) => {
    const split = splitValueAndUnit(out.value);
    const valueNumber = split ? split.number : (Number.isFinite(Number(out.value.replace(',', '.'))) && /^\s*-?\d+([.,]\d+)?\s*$/.test(out.value) ? Number(out.value.replace(',', '.')) : null);
    const unit = out.unit ?? split?.unit ?? null;
    const location = { ...(f.location ?? {}), ...(out.page ? { page: out.page } : {}) };
    const [row] = (await tx.unsafe(
      `INSERT INTO document_facts (
         account_id, file_id, extraction_id, fact_key, subject, attribute, label,
         value_text, value_number, value_unit, value_json, normalized_value,
         confidence, excerpt, location, source_type, provider, model, prompt_version, status, provenance, revalidation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,'asset_file','gemini',$16,'revalidate_fact_v1','active','REVALIDATION_T2',$17)
       RETURNING id::float8 AS id`,
      [f.accountId, f.fileId, f.extractionId, f.factKey, f.subject, f.attribute, f.label,
       out.value, valueNumber, unit, JSON.stringify(out.value), valueNumber != null ? String(valueNumber) : norm(out.value),
       out.confidence, out.excerpt ?? f.excerpt, JSON.stringify(location), model, revalidationId] as never[],
    )) as unknown as Array<{ id: number }>;
    if (out.status === 'CONFIRMED' || out.confidence === 'certain') {
      await tx.unsafe(`UPDATE document_facts SET status = 'superseded' WHERE id = $1`, [f.id] as never[]);
    }
    return row.id;
  }) as Promise<number>;
}
