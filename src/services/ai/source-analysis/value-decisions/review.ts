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
 *   · bornes : un appel, `REVIEW_MAX_UNITS` unités / `REVIEW_MAX_CHARS`
 *     caractères ; budget des relances IA et anti-boucle portés par le
 *     contrôle (une fois par diagnostic) ; plafond de coût IA du compte par
 *     la passerelle.
 */
import { valueDecisionsCapability } from './contract';
import { insertValueDecisions, valueDecisionsTableReady } from './store';
import { unitTextOf, validateValueDecisions, type AnchoredValueDecision } from './validate';
import { significantValues } from '../source-units/text';
import type { SourceUnit } from '../source-units/types';
import type { T1Fact, T1FactWithRef } from '../master/t1-contract';

const REVIEW_MAX_UNITS = 60;
const REVIEW_MAX_CHARS = 24_000;
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
}

/** Appel T1 injectable (tests) — par défaut `callAnalyzeDocument`. */
export type ReviewCall = (c: Parameters<typeof import('../steps/analyze-document.step').callAnalyzeDocument>[0]) =>
  Promise<{ output: { facts: T1Fact[] } & Record<string, unknown>; valueDecisions?: AnchoredValueDecision[] | null; res: { promptVersion?: string; traceId?: string } }>;

/** Formes comparables d'une valeur (montant en centimes, date ISO, identifiant compact). Pure. */
export function valueForms(v: unknown): Set<string> {
  const out = new Set<string>();
  if (v === null || v === undefined || v === '') return out;
  if (typeof v === 'number' && Number.isFinite(v)) {
    out.add(`AMOUNT:${Math.round(v * 100)}`);
    if (Number.isInteger(v)) out.add(`AMOUNT:${v}`);
    return out;
  }
  const s = String(v).trim();
  for (const x of significantValues(s, { identifiers: true })) out.add(`${x.kind}:${x.normalized}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) out.add(`DATE:${s}`);
  const m = /^-?(\d+)(?:[.,](\d{1,2}))?$/.exec(s.replace(/[\s  ]/g, ''));
  if (m) {
    out.add(`AMOUNT:${Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0)}`);
    if (!m[2]) out.add(`AMOUNT:${Number(m[1])}`);
  }
  return out;
}

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

export async function reviewDocumentValueDecisions(p: {
  accountId: number; fileId: number; unitIds: readonly string[]; origin?: string; call?: ReviewCall;
}): Promise<ReviewResult> {
  const cap = await valueDecisionsCapability();
  if (!cap.carried) return vide('CONTRACT_PENDING');
  if (!(await valueDecisionsTableReady())) return vide('FAILED', { error: 'table document_value_decisions absente (migration 0798)' });
  const { pgClient } = await import('@/db');
  const [doc] = (await pgClient.unsafe(
    `SELECT af.asset_id, af.linked_asset_id, coalesce(af.retained_title, af.original_filename) AS title, a.owner_user_id,
            e.id AS extraction_id, e.analysis_run_id
       FROM asset_files af JOIN accounts a ON a.id = af.account_id
       LEFT JOIN document_extractions e ON e.file_id = af.id AND e.account_id = af.account_id
      WHERE af.id = $1 AND af.account_id = $2 AND af.deleted_at IS NULL`,
    [p.fileId, p.accountId] as never[],
  )) as unknown as Row[];
  if (!doc) return vide('DOCUMENT_GONE');
  const { loadDocumentSourceUnits } = await import('../source-units/repository');
  const voulues = new Set(p.unitIds);
  const toutes = await loadDocumentSourceUnits(p.fileId, { accountId: p.accountId });
  const cibles: SourceUnit[] = [];
  let chars = 0;
  for (const u of toutes) {
    if (!voulues.has(u.sourceUnitId) || !UNITES_LUES.has(u.kind)) continue;
    const t = unitTextOf(u);
    if (!t) continue;
    if (cibles.length >= REVIEW_MAX_UNITS || chars + t.length > REVIEW_MAX_CHARS) break;
    chars += t.length + 40;
    cibles.push({
      sourceUnitId: u.sourceUnitId, kind: u.kind, page: u.page, ordinal: u.ordinal, parentUnitId: u.parentUnitId, text: t,
      label: u.label, value: u.value, payload: u.payload ?? {}, location: u.location ?? {}, origin: 'REPAIR', salient: u.salient,
    } as SourceUnit);
  }
  if (cibles.length === 0) return vide('NOTHING_TO_REVIEW');
  const unites = cibles.map((u) => u.sourceUnitId);
  const assetId = Number(doc.asset_id ?? doc.linked_asset_id ?? 0) || null;
  const userId = Number(doc.owner_user_id);
  const title = doc.title == null ? `document ${p.fileId}` : String(doc.title);

  // ── Appel T1 ciblé (même chemin que la passe de réparation) ──────────────
  const [{ loadAnalysisContext }, { getAccountCapabilities }, { loadAssetFamilies }, step, { enforceT1Capabilities }, { checkFactEvidence },
    { SourceUnitLinker }, { latestT1ExecutionIdForFile }, { runInBusinessExecution }] = await Promise.all([
    import('../pipeline'), import('@/services/account-capabilities.service'), import('../master/rubric-rules'),
    import('../steps/analyze-document.step'), import('../master/capability-guard'), import('../master/fact-evidence'),
    import('../source-units/coverage'), import('../../business-execution/repository'), import('../../business-execution/context'),
  ]);
  const ctx = await loadAnalysisContext(p.accountId, assetId);
  const capabilities = await getAccountCapabilities(p.accountId);
  const v2Families = await loadAssetFamilies(assetId ? [assetId] : []);
  const appel: ReviewCall = p.call ?? ((c) => step.callAnalyzeDocument(c) as never);
  const execution = await latestT1ExecutionIdForFile(p.accountId, p.fileId);
  let r: Awaited<ReturnType<ReviewCall>>;
  try {
    r = await runInBusinessExecution(execution ? [execution] : [], () => appel({
      input: {
        sourceType: 'file', sourceIds: [p.fileId], accountId: p.accountId, userId, mimeTypes: ['text/plain'], displayNames: [title],
        linkedAssetId: assetId, extractedContent: cibles.map((u) => `[${u.sourceUnitId}]\n${u.text ?? ''}`).join('\n\n'),
      },
      groupIndices: [0], ctx: { ...ctx, capabilities }, capabilities, v2Families, attachments: [],
      sources: JSON.stringify([{
        index: 0, name: `${title} — réexamen des valeurs significatives (${cibles.length} unité(s))`, mimeType: 'text/plain',
        kind: 'extrait du document déjà lu (contenu préextrait)',
      }]),
      triggerCode: 't1_value_decision_review', candidateOrigin: 'CHUNK',
    }), { origin: p.origin ?? 'coherence-control' });
  } catch (e) {
    return vide('FAILED', { calls: 1, units: unites, error: (e as Error).message?.slice(0, 300) ?? 'erreur' });
  }

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
  const { appendRepairedFacts } = await import('../source-units/jobs');
  const ajout = prouves.length
    ? await appendRepairedFacts({ fileId: p.fileId, accountId: p.accountId, extractionId: doc.extraction_id == null ? null : Number(doc.extraction_id), assetId, facts: prouves, linker })
    : { inserted: [], all: [] };

  // ── Décisions : validées contre les unités réexaminées, puis persistées ──
  if (!r.valueDecisions) {
    return { ...vide('NO_DECISION'), calls: 1, newFacts: ajout.inserted.length, units: unites };
  }
  const recues = r.valueDecisions.map((d) => ({
    ...d, origin: 'REVIEW' as const,
    evidence: { ...d.evidence, ...(d.evidence.excerpt ? { excerpt: d.evidence.excerpt.replace(PREFIXE, '').trim() } : {}) },
  }));
  const actifs = (await pgClient.unsafe(
    `SELECT id::float8 AS id, value_text, normalized_value, value_number::float8 AS value_number, to_jsonb(f)->>'raw_value' AS raw_value
       FROM document_facts f WHERE f.account_id = $1 AND f.file_id = $2 AND f.status = 'active'`,
    [p.accountId, p.fileId] as never[],
  )) as unknown as Row[];
  const cands = new Set(((await pgClient.unsafe(
    `SELECT candidate_key FROM document_operation_candidates WHERE account_id = $1 AND file_id = $2 AND status = 'ACTIVE'`,
    [p.accountId, p.fileId] as never[],
  )) as unknown as Row[]).map((c) => String(c.candidate_key)));
  const factIds = matchFactIds(r.output.facts as T1FactWithRef[], actifs.map((a) => ({
    id: Number(a.id), values: [a.value_text, a.normalized_value, a.raw_value, a.value_number == null ? null : Number(a.value_number)],
  })));
  const preparees = validateValueDecisions(recues, {
    units: cibles, keptFactRefs: new Set(factIds.keys()), candidateKeys: cands,
  });
  let written = 0;
  await pgClient.begin(async (tx) => {
    written = await insertValueDecisions(tx as never, {
      accountId: p.accountId, fileId: p.fileId, extractionId: doc.extraction_id == null ? null : Number(doc.extraction_id),
      analysisRunId: doc.analysis_run_id == null ? null : Number(doc.analysis_run_id), promptVersion: r.res.promptVersion ?? cap.version,
      aiTraceId: r.res.traceId ?? null, factIds,
    }, preparees, { replaceKeys: true });
  });
  // Bien rattaché : preuves, T3 et T4 depuis les faits persistés (même chemin que la reprise ciblée).
  if (assetId && ajout.inserted.some((f) => f.canonicalKey)) {
    const { projectDocumentKnowledgeToAsset } = await import('../../knowledge/document-knowledge.service');
    await projectDocumentKnowledgeToAsset({ accountId: p.accountId, userId, fileId: p.fileId, assetId })
      .catch((e: Error) => console.error('[t1-value-decisions] projection sur le bien :', e.message));
  }
  return {
    outcome: 'REVIEWED', calls: 1, newFacts: ajout.inserted.length, units: unites,
    decisions: {
      valid: preparees.filter((d) => d.validity === 'VALID').length,
      invalid: preparees.filter((d) => d.validity === 'INVALID').length,
      undetermined: preparees.filter((d) => d.validity === 'VALID' && d.decision === 'UNDETERMINED').length,
      written,
    },
  };
}
