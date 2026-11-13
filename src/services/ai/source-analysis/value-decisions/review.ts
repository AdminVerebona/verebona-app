/**
 * Lot 91D — RÉEXAMEN CIBLÉ des décisions T1 sur les valeurs significatives
 * (ticket « Fiabiliser la traçabilité des décisions T1 », §3.D).
 *
 * Demandé par COH-DOC-EXTRACT-CHAIN (réparation `DECISION_REVIEW`) pour un
 * document dont des valeurs de l'extract restent sans décision valide :
 * unité COUVERTE (omission volontaire ou accidentelle ?) ou reprise ÉPUISÉE.
 *
 *   · SEULES les unités en constat sont transmises, depuis leur texte
 *     PERSISTÉ (couche A) : le fichier n'est ni relu ni retéléchargé, le
 *     document n'est jamais réanalysé en entier ;
 *   · même prompt maître T1 (non modifié), même TASK ANALYZE_DOCUMENT, même
 *     contrat (v6) — exactement comme la passe de réparation ciblée ;
 *   · contrat `t1-value-decisions-v1` non porté par le prompt actif : AUCUN
 *     appel (`CONTRACT_PENDING`) ;
 *   · décisions validées par le serveur (`validate.ts`) puis persistées : les
 *     décisions actives des valeurs réexaminées sont supersédées (historique) ;
 *   · un fait rendu par T1 n'est retenu que s'il est PROUVÉ par une unité
 *     réexaminée, puis ajouté par le chemin existant (`appendRepairedFacts` :
 *     idempotent, projection, aucune écriture directe dans une fiche — une
 *     correction de l'utilisateur n'est jamais écrasée) ;
 *   · bornes PAR APPEL : `REVIEW_MAX_UNITS` unités / `REVIEW_MAX_CHARS`
 *     caractères ; budget des relances IA et anti-boucle portés par le
 *     contrôle ; plafond de coût IA du compte par la passerelle.
 *
 * Lot 108K (§D) — PAGINATION : toutes les unités demandées sont réparties en
 * LOTS (jamais une troncature) ; un passage traite au plus
 * `reviewMaxBatchesPerPass()` lots (et jamais plus que le budget de relances
 * restant), la PROGRESSION par unité est conservée
 * (`document_value_review_units`) et le passage suivant reprend les unités
 * restantes. Une unité seule plus longue que le plafond d'un appel est
 * envoyée seule jusqu'au plafond absolu `REVIEW_UNIT_HARD_MAX_CHARS`,
 * au-delà elle reste EN ATTENTE (`TOO_LARGE`, raison d'arrêt explicite).
 * Une unité n'est « examinée » que si elle a été transmise dans un lot dont
 * la réponse a été lue. Lot 108K (§C) : statut de la sortie de chaque lot
 * (présent, vide, absent, mal formé, tronqué) consigné par unité.
 */
import { valueDecisionsCapability } from './contract';
import { insertValueDecisions, valueDecisionsTableReady } from './store';
import { factContextOf, unitFingerprint, unitTextOf, validateValueDecisions, valueFormsOf, type AnchoredValueDecision } from './validate';
import type { ValueDecisionsOutputStatus } from './output-conformity';
import type { SourceUnit } from '../source-units/types';
import type { T1Fact, T1FactWithRef } from '../master/t1-contract';

/** Plafonds techniques d'UN appel (unités, caractères) — un lot ; jamais une limite du document. */
export const REVIEW_MAX_UNITS = 60;
export const REVIEW_MAX_CHARS = 24_000;
/** Plafond absolu d'une unité envoyée seule ; au-delà : en attente (`TOO_LARGE`), jamais tronquée. */
export const REVIEW_UNIT_HARD_MAX_CHARS = 60_000;
/** Tentatives techniques par version d'unité avant arrêt (raison `REVIEW_FAILED_REPEATEDLY`). */
export const REVIEW_MAX_ATTEMPTS = 3;
const DEFAULT_REVIEW_BATCHES_PER_PASS = 5;
/** Lots par passage (`COHERENCE_DECISION_REVIEW_BATCHES_MAX`, 5 par défaut, au moins 1). Pure. */
export function reviewMaxBatchesPerPass(env: Record<string, string | undefined> = process.env): number {
  const v = env.COHERENCE_DECISION_REVIEW_BATCHES_MAX;
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : DEFAULT_REVIEW_BATCHES_PER_PASS;
}

/** Unité candidate au réexamen (texte persisté). */
export interface ReviewUnitInput { id: string; chars: number }

/**
 * Répartition PURE des unités en lots (ordre conservé) : au plus
 * `maxUnits` unités et `maxChars` caractères par lot ; une unité plus longue
 * que `maxChars` part seule ; au-delà de `hardMax`, elle n'est pas envoyée
 * (`tooLarge`). Aucune unité perdue : `batches` ∪ `tooLarge` = l'entrée.
 */
export function planReviewBatches(units: readonly ReviewUnitInput[], o: { maxUnits?: number; maxChars?: number; hardMax?: number } = {}): { batches: string[][]; tooLarge: string[] } {
  const maxUnits = o.maxUnits ?? REVIEW_MAX_UNITS;
  const maxChars = o.maxChars ?? REVIEW_MAX_CHARS;
  const hardMax = o.hardMax ?? REVIEW_UNIT_HARD_MAX_CHARS;
  const batches: string[][] = [];
  const tooLarge: string[] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const u of units) {
    const c = u.chars + 40;
    if (u.chars > hardMax) { tooLarge.push(u.id); continue; }
    if (cur.length && (cur.length >= maxUnits || chars + c > maxChars)) { batches.push(cur); cur = []; chars = 0; }
    cur.push(u.id);
    chars += c;
  }
  if (cur.length) batches.push(cur);
  return { batches, tooLarge };
}
const UNITES_LUES = new Set(['TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD', 'TABLE_ROW']);
const PREFIXE = /\[(?:page|doc):[^\]]+\]\s*/g;

type Row = Record<string, unknown>;

export interface ReviewResult {
  outcome: 'REVIEWED' | 'NO_DECISION' | 'CONTRACT_PENDING' | 'NOTHING_TO_REVIEW' | 'DOCUMENT_GONE' | 'FAILED';
  calls: number;
  newFacts: number;
  decisions: { valid: number; invalid: number; undetermined: number; written: number };
  /** Unités transmises (bornées). */
  units: string[];
  error?: string;
  /**
   * Lot 108K (§D) — progression COMPLÈTE du passage : unités demandées,
   * examinées (réponse lue), en échec, trop grandes, restantes (non
   * envoyées : plafond de lots ou budget), lots, statuts de sortie, raisons
   * d'arrêt. Jamais « examinée » une unité non transmise.
   */
  progress?: {
    requested: number; examined: number; failed: number; tooLarge: number; remaining: number;
    batches: number; batchesPlanned: number; outputStatuses: Partial<Record<ValueDecisionsOutputStatus, number>>; stopReasons: string[];
  };
}

/** Appel T1 injectable (tests) — par défaut `callAnalyzeDocument`. */
export type ReviewCall = (c: Parameters<typeof import('../steps/analyze-document.step').callAnalyzeDocument>[0]) =>
  Promise<{ output: { facts: T1Fact[] } & Record<string, unknown>; valueDecisions?: AnchoredValueDecision[] | null; res: { promptVersion?: string; traceId?: string };
    /** Lot 108K (§C) : statut de `valueDecisions` dans la réponse (présent, vide, absent, mal formé, tronqué). */
    valueDecisionsPass?: { status: ValueDecisionsOutputStatus } }>;

/** Formes comparables d'une valeur (montant en centimes, date ISO, identifiant compact). Pure — lot 108K : `validate.valueFormsOf`. */
export const valueForms = valueFormsOf;

/** Faits actifs du document correspondant à chaque fait rendu par T1 (même valeur), par empreinte. Pure. */
export function matchFactIds(
  output: ReadonlyArray<T1FactWithRef>, actifs: ReadonlyArray<{ id: number; values: unknown[] }>,
): Map<string, number[]> {
  const formesActifs = actifs.map((f) => ({ id: f.id, formes: new Set(f.values.flatMap((v) => [...valueForms(v)])) }));
  const out = new Map<string, number[]>();
  for (const f of output) {
    if (!f.t1FactRef) continue;
    const formes = new Set([...valueForms(f.normalizedValue), ...valueForms(f.rawValue)]);
    const ids = formesActifs.filter((a) => [...formes].some((x) => a.formes.has(x))).map((a) => a.id);
    if (ids.length) out.set(f.t1FactRef, ids);
  }
  return out;
}

const vide = (outcome: ReviewResult['outcome'], extra: Partial<ReviewResult> = {}): ReviewResult => ({
  outcome, calls: 0, newFacts: 0, decisions: { valid: 0, invalid: 0, undetermined: 0, written: 0 }, units: [], ...extra,
});

type Pg = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

/** Progression connue des unités d'un document (version de texte courante seulement). */
export async function loadReviewProgress(sql: Pg, accountId: number, fileIds: readonly number[]): Promise<Array<{
  fileId: number; unitId: string; fingerprint: string; status: string; outputStatus: string | null; attempts: number; updatedAt: string | null;
}>> {
  if (!fileIds.length || !(await reviewProgressTableReady(sql))) return [];
  return ((await sql.unsafe(
    `SELECT file_id, source_unit_id, unit_fingerprint, status, output_status, attempts, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
       FROM document_value_review_units WHERE account_id = $1 AND file_id = ANY($2::int[]) ORDER BY id`,
    [accountId, `{${fileIds.filter(Number.isInteger).join(',')}}`] as never[],
  )) as Row[]).map((r) => ({
    fileId: Number(r.file_id), unitId: String(r.source_unit_id), fingerprint: String(r.unit_fingerprint), status: String(r.status),
    outputStatus: (r.output_status as string | null) ?? null, attempts: Number(r.attempts ?? 1), updatedAt: (r.updated_at as string | null) ?? null,
  }));
}

let progressReady: boolean | null = null;
/** Table 1090 présente ? (lue une fois ; ne lève jamais). */
export async function reviewProgressTableReady(sql?: Pg): Promise<boolean> {
  if (progressReady !== null) return progressReady;
  try {
    const client = sql ?? (await import('@/db')).pgClient as unknown as Pg;
    const r = (await client.unsafe(`SELECT to_regclass('document_value_review_units') IS NOT NULL AS ok`)) as Array<{ ok: boolean }>;
    progressReady = r[0]?.ok === true;
  } catch { progressReady = false; }
  return progressReady;
}
/** Réservé aux tests. */
export function __resetReviewProgressProbeForTests(): void { progressReady = null; }

async function noterProgression(sql: Pg, p: {
  accountId: number; fileId: number; extractionId: number | null; units: Array<{ id: string; fp: string }>; status: 'EXAMINED' | 'FAILED' | 'TOO_LARGE';
  outputStatus: ValueDecisionsOutputStatus | null; batchNo: number; batches: number; written: number; promptVersion: string | null; traceId: string | null;
  origin: string; error?: string | null;
}): Promise<void> {
  if (!p.units.length || !(await reviewProgressTableReady(sql))) return;
  await sql.unsafe(
    `INSERT INTO document_value_review_units (account_id, file_id, extraction_id, source_unit_id, unit_fingerprint, status, output_status, batch_no, batches,
                                              decisions_written, prompt_version, ai_trace_id, origin, error)
     SELECT $1, $2, $3, u.id, u.fp, $5, $6, $7, $8, $9, $10, $11, $12, $13 FROM jsonb_to_recordset($4::jsonb) AS u(id text, fp text)
     ON CONFLICT (file_id, source_unit_id, unit_fingerprint) DO UPDATE SET
       status = CASE WHEN document_value_review_units.status = 'EXAMINED' AND EXCLUDED.status <> 'EXAMINED' THEN document_value_review_units.status ELSE EXCLUDED.status END,
       output_status = COALESCE(EXCLUDED.output_status, document_value_review_units.output_status),
       attempts = document_value_review_units.attempts + 1, batch_no = EXCLUDED.batch_no, batches = EXCLUDED.batches,
       decisions_written = document_value_review_units.decisions_written + EXCLUDED.decisions_written,
       prompt_version = COALESCE(EXCLUDED.prompt_version, document_value_review_units.prompt_version),
       ai_trace_id = COALESCE(EXCLUDED.ai_trace_id, document_value_review_units.ai_trace_id), error = EXCLUDED.error, updated_at = now()`,
    [p.accountId, p.fileId, p.extractionId, JSON.stringify(p.units), p.status, p.outputStatus, p.batchNo, p.batches, p.written,
      p.promptVersion, p.traceId, p.origin, p.error?.slice(0, 300) ?? null] as never[],
  );
}

export async function reviewDocumentValueDecisions(p: {
  accountId: number; fileId: number; unitIds: readonly string[]; origin?: string; call?: ReviewCall;
  /** Lot 108K : lots au plus pour CE passage (budget de relances restant) ; défaut `reviewMaxBatchesPerPass()`. */
  maxBatches?: number;
}): Promise<ReviewResult> {
  const cap = await valueDecisionsCapability();
  if (!cap.carried) return vide('CONTRACT_PENDING');
  if (!(await valueDecisionsTableReady())) return vide('FAILED', { error: 'table document_value_decisions absente (migration 0798)' });
  const { pgClient } = await import('@/db');
  const pg = pgClient as unknown as Pg;
  const [doc] = (await pgClient.unsafe(
    `SELECT af.asset_id, af.linked_asset_id, coalesce(af.retained_title, af.original_filename) AS title, a.owner_user_id,
            e.id AS extraction_id, e.analysis_run_id
       FROM asset_files af JOIN accounts a ON a.id = af.account_id
       LEFT JOIN document_extractions e ON e.file_id = af.id AND e.account_id = af.account_id
      WHERE af.id = $1 AND af.account_id = $2 AND af.deleted_at IS NULL`,
    [p.fileId, p.accountId] as never[],
  )) as unknown as Row[];
  if (!doc) return vide('DOCUMENT_GONE');
  const extractionId = doc.extraction_id == null ? null : Number(doc.extraction_id);
  const origin = p.origin ?? 'coherence-control';
  const { loadDocumentSourceUnits } = await import('../source-units/repository');
  const voulues = new Set(p.unitIds);
  const toutes = await loadDocumentSourceUnits(p.fileId, { accountId: p.accountId });
  const lisibles: SourceUnit[] = [];
  for (const u of toutes) {
    if (!UNITES_LUES.has(u.kind)) continue;
    const t = unitTextOf(u);
    if (!t) continue;
    lisibles.push({
      sourceUnitId: u.sourceUnitId, kind: u.kind, page: u.page, ordinal: u.ordinal, parentUnitId: u.parentUnitId, text: t,
      label: u.label, value: u.value, payload: u.payload ?? {}, location: u.location ?? {}, origin: 'REPAIR', salient: u.salient,
    } as SourceUnit);
  }
  // Progression (lot 108K) : une unité déjà examinée sur CETTE version de son texte n'est jamais renvoyée (idempotent).
  const fpDe = new Map(lisibles.map((u) => [u.sourceUnitId, unitFingerprint(u.text) ?? '']));
  const deja = new Map((await loadReviewProgress(pg, p.accountId, [p.fileId])).filter((r) => r.fingerprint === fpDe.get(r.unitId)).map((r) => [r.unitId, r]));
  const stopReasons = new Set<string>();
  const demandees = lisibles.filter((u) => voulues.has(u.sourceUnitId));
  const aFaire = demandees.filter((u) => {
    const r = deja.get(u.sourceUnitId);
    if (r?.status === 'EXAMINED') return false;
    if (r?.status === 'FAILED' && r.attempts >= REVIEW_MAX_ATTEMPTS) { stopReasons.add('REVIEW_FAILED_REPEATEDLY'); return false; }
    return true;
  });
  const plan = planReviewBatches(aFaire.map((u) => ({ id: u.sourceUnitId, chars: (u.text ?? '').length })));
  const parId = new Map(lisibles.map((u) => [u.sourceUnitId, u]));
  const progress = {
    requested: demandees.length, examined: 0, failed: 0, tooLarge: plan.tooLarge.length,
    remaining: 0, batches: 0, batchesPlanned: plan.batches.length, outputStatuses: {} as Partial<Record<ValueDecisionsOutputStatus, number>>, stopReasons: [] as string[],
  };
  progress.examined = demandees.filter((u) => deja.get(u.sourceUnitId)?.status === 'EXAMINED').length;
  if (plan.tooLarge.length) {
    stopReasons.add('UNIT_TOO_LARGE');
    await noterProgression(pg, { accountId: p.accountId, fileId: p.fileId, extractionId, units: plan.tooLarge.map((id) => ({ id, fp: fpDe.get(id) ?? '' })),
      status: 'TOO_LARGE', outputStatus: null, batchNo: 0, batches: plan.batches.length, written: 0, promptVersion: null, traceId: null, origin });
  }
  if (plan.batches.length === 0) {
    progress.remaining = demandees.length - progress.examined;
    progress.stopReasons = [...stopReasons];
    return { ...vide('NOTHING_TO_REVIEW'), progress };
  }
  const maxLots = Math.max(0, Math.min(reviewMaxBatchesPerPass(), p.maxBatches ?? Number.POSITIVE_INFINITY));
  const lots = plan.batches.slice(0, maxLots);
  if (lots.length < plan.batches.length) stopReasons.add(maxLots < reviewMaxBatchesPerPass() ? 'RELAUNCH_BUDGET' : 'BATCH_LIMIT_PER_PASS');
  const assetId = Number(doc.asset_id ?? doc.linked_asset_id ?? 0) || null;
  const userId = Number(doc.owner_user_id);
  const title = doc.title == null ? `document ${p.fileId}` : String(doc.title);

  // ── Appel T1 ciblé (même chemin que la passe de réparation), un appel par lot ──
  const [{ loadAnalysisContext }, { getAccountCapabilities }, { loadAssetFamilies }, step, { enforceT1Capabilities }, { checkFactEvidence },
    { SourceUnitLinker }, { latestT1ExecutionIdForFile }, { runInBusinessExecution }, { appendRepairedFacts }] = await Promise.all([
    import('../pipeline'), import('@/services/account-capabilities.service'), import('../master/rubric-rules'),
    import('../steps/analyze-document.step'), import('../master/capability-guard'), import('../master/fact-evidence'),
    import('../source-units/coverage'), import('../../business-execution/repository'), import('../../business-execution/context'),
    import('../source-units/jobs'),
  ]);
  const ctx = await loadAnalysisContext(p.accountId, assetId);
  const capabilities = await getAccountCapabilities(p.accountId);
  const v2Families = await loadAssetFamilies(assetId ? [assetId] : []);
  const appel: ReviewCall = p.call ?? ((c) => step.callAnalyzeDocument(c) as never);
  const execution = await latestT1ExecutionIdForFile(p.accountId, p.fileId);
  const cands = new Set(((await pgClient.unsafe(
    `SELECT candidate_key FROM document_operation_candidates WHERE account_id = $1 AND file_id = $2 AND status = 'ACTIVE'`,
    [p.accountId, p.fileId] as never[],
  )) as unknown as Row[]).map((c) => String(c.candidate_key)));

  const total = { valid: 0, invalid: 0, undetermined: 0, written: 0 };
  let calls = 0;
  let newFacts = 0;
  let projeter = false;
  let lusAvecTableau = 0;
  let derniereErreur: string | null = null;
  const envoyees: string[] = [];
  for (let b = 0; b < lots.length; b++) {
    const cibles = lots[b].map((id) => parId.get(id)!).filter(Boolean);
    const unitesLot = cibles.map((u) => ({ id: u.sourceUnitId, fp: fpDe.get(u.sourceUnitId) ?? '' }));
    let r: Awaited<ReturnType<ReviewCall>>;
    calls++;
    try {
      r = await runInBusinessExecution(execution ? [execution] : [], () => appel({
        input: {
          sourceType: 'file', sourceIds: [p.fileId], accountId: p.accountId, userId, mimeTypes: ['text/plain'], displayNames: [title],
          linkedAssetId: assetId, extractedContent: cibles.map((u) => `[${u.sourceUnitId}]\n${u.text ?? ''}`).join('\n\n'),
        },
        groupIndices: [0], ctx: { ...ctx, capabilities }, capabilities, v2Families, attachments: [],
        sources: JSON.stringify([{
          index: 0, name: `${title} — réexamen des valeurs significatives (${cibles.length} unité(s)${lots.length > 1 ? `, lot ${b + 1}/${plan.batches.length}` : ''})`, mimeType: 'text/plain',
          kind: 'extrait du document déjà lu (contenu préextrait)',
        }]),
        triggerCode: 't1_value_decision_review', candidateOrigin: 'CHUNK',
      }), { origin });
    } catch (e) {
      derniereErreur = (e as Error).message?.slice(0, 300) ?? 'erreur';
      progress.failed += cibles.length;
      stopReasons.add('REVIEW_FAILED');
      await noterProgression(pg, { accountId: p.accountId, fileId: p.fileId, extractionId, units: unitesLot, status: 'FAILED', outputStatus: null,
        batchNo: b + 1, batches: plan.batches.length, written: 0, promptVersion: null, traceId: null, origin, error: derniereErreur });
      // Un lot en échec arrête le passage (le suivant reprendra ; anti-boucle et tentatives bornés).
      break;
    }
    envoyees.push(...unitesLot.map((u) => u.id));

    // ── Faits PROUVÉS par une unité réexaminée : ajoutés par le chemin existant ──
    const linker = new SourceUnitLinker(cibles);
    const { output } = enforceT1Capabilities(r.output as never, capabilities);
    const prouves: T1Fact[] = [];
    for (const f of output.facts as T1Fact[]) {
      if (f.provenance === 'VISUAL_ANALYSIS') continue;
      const c = checkFactEvidence(f);
      if (!c.ok) continue;
      const excerpt = (c.fact.evidence.excerpt ?? '').replace(PREFIXE, '').trim();
      if (linker.link({ excerpt, provenance: 'TEXT_EXTRACTION' }).length === 0) continue;
      const { table: _t, ...evidence } = c.fact.evidence;
      void _t;
      prouves.push({ ...c.fact, evidence: { ...evidence, excerpt } });
    }
    const ajout = prouves.length
      ? await appendRepairedFacts({ fileId: p.fileId, accountId: p.accountId, extractionId, assetId, facts: prouves, linker })
      : { inserted: [], all: [] };
    newFacts += ajout.inserted.length;
    if (ajout.inserted.some((f) => f.canonicalKey)) projeter = true;

    // ── Lot 108K (§C) : statut de la sortie du lot (jamais de décision inventée) ──
    const statut: ValueDecisionsOutputStatus = r.valueDecisionsPass?.status ?? (r.valueDecisions == null ? 'ABSENT' : r.valueDecisions.length ? 'PRESENT' : 'EMPTY');
    progress.outputStatuses[statut] = (progress.outputStatuses[statut] ?? 0) + 1;
    let written = 0;
    if (r.valueDecisions) {
      lusAvecTableau++;
      // ── Décisions : validées contre les unités réexaminées (voisinage : tout le document), puis persistées ──
      const recues = r.valueDecisions.map((d) => ({
        ...d, origin: 'REVIEW' as const,
        evidence: { ...d.evidence, ...(d.evidence.excerpt ? { excerpt: d.evidence.excerpt.replace(PREFIXE, '').trim() } : {}) },
      }));
      const actifs = (await pgClient.unsafe(
        `SELECT id::float8 AS id, value_text, normalized_value, value_number::float8 AS value_number, to_jsonb(f)->>'raw_value' AS raw_value
           FROM document_facts f WHERE f.account_id = $1 AND f.file_id = $2 AND f.status = 'active'`,
        [p.accountId, p.fileId] as never[],
      )) as unknown as Row[];
      const factIds = matchFactIds(r.output.facts as T1FactWithRef[], actifs.map((a) => ({
        id: Number(a.id), values: [a.value_text, a.normalized_value, a.raw_value, a.value_number == null ? null : Number(a.value_number)],
      })));
      const gardes = (r.output.facts as T1FactWithRef[]).filter((f) => f.t1FactRef && factIds.has(f.t1FactRef));
      const preparees = validateValueDecisions(recues, {
        units: cibles, contextUnits: lisibles, keptFactRefs: new Set(factIds.keys()), candidateKeys: cands,
        facts: factContextOf(gardes, lisibles),
      });
      await pgClient.begin(async (tx) => {
        written = await insertValueDecisions(tx as never, {
          accountId: p.accountId, fileId: p.fileId, extractionId,
          analysisRunId: doc.analysis_run_id == null ? null : Number(doc.analysis_run_id), promptVersion: r.res.promptVersion ?? cap.version,
          aiTraceId: r.res.traceId ?? null, factIds,
        }, preparees, { replaceKeys: true });
      });
      total.valid += preparees.filter((d) => d.validity === 'VALID').length;
      total.invalid += preparees.filter((d) => d.validity === 'INVALID').length;
      total.undetermined += preparees.filter((d) => d.validity === 'VALID' && d.decision === 'UNDETERMINED').length;
      total.written += written;
    } else stopReasons.add('OUTPUT_WITHOUT_DECISIONS');
    progress.batches++;
    progress.examined += cibles.length;
    await noterProgression(pg, { accountId: p.accountId, fileId: p.fileId, extractionId, units: unitesLot, status: 'EXAMINED', outputStatus: statut,
      batchNo: b + 1, batches: plan.batches.length, written, promptVersion: r.res.promptVersion ?? cap.version ?? null, traceId: r.res.traceId ?? null, origin });
  }
  // Bien rattaché : preuves, T3 et T4 depuis les faits persistés (même chemin que la reprise ciblée).
  if (assetId && projeter) {
    const { projectDocumentKnowledgeToAsset } = await import('../../knowledge/document-knowledge.service');
    await projectDocumentKnowledgeToAsset({ accountId: p.accountId, userId, fileId: p.fileId, assetId })
      .catch((e: Error) => console.error('[t1-value-decisions] projection sur le bien :', e.message));
  }
  // Lot 113AN (#741) : décisions et faits arrivés APRÈS l'analyse → couverture réconciliée (sans IA) ; jusqu'ici la
  // couche A gardait `not_extracted` pour une valeur pourtant qualifiée par le réexamen.
  if (total.written > 0 || newFacts > 0) {
    const { reconcileStoredDocumentCoverage } = await import('../source-units/stored-reconciliation');
    await reconcileStoredDocumentCoverage({ accountId: p.accountId, fileId: p.fileId, apply: true, origin: `value-review:${origin}` })
      .catch((e: Error) => console.error('[t1-value-decisions] réconciliation de la couverture :', e.message));
  }
  progress.remaining = Math.max(0, demandees.length - progress.examined);
  progress.stopReasons = [...stopReasons];
  if (progress.batches === 0) return { ...vide('FAILED', { calls, units: [], error: derniereErreur ?? 'échec' }), progress };
  return {
    outcome: lusAvecTableau === 0 ? 'NO_DECISION' : 'REVIEWED', calls, newFacts, units: envoyees, decisions: total, progress,
    ...(derniereErreur ? { error: derniereErreur } : {}),
  };
}
