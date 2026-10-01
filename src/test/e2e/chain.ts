/**
 * Chaîne de bout en bout du corpus §15 (CDC 15) — document → T1 → T3 → T4 →
 * export → T2, sur PostgreSQL réel.
 *
 * Aucun raccourci métier : le document passe par `analyzeFileSources` (point
 * d'entrée unique de l'usage 1, prompt maître T1 par la vraie passerelle et
 * le rejeu des sorties enregistrées), ses abonnés (`emitSourceAnalyzed`)
 * mettent T3 et T4 en file durable, et la file est VIDÉE ici par le même
 * exécutant que la production (`runOne`). L'export lit sa source
 * (`loadExportSource`), l'assistant répond par `runAssistant` et ses ports
 * réels.
 *
 * Commutateurs : l'état cible (`TARGET_SWITCHES`, tout `enabled`, T1 en
 * `master` par la version de configuration) est posé par `useTargetState`,
 * restauré après chaque test.
 */
import { afterAll, afterEach, beforeAll } from 'vitest';
import type postgres from 'postgres';
import type { RecordedOutput, ReplayProvider } from './replay-gateway';

/** État cible des commutateurs du CDC 15 (plan, § Déploiement). */
export const TARGET_SWITCHES: Readonly<Record<string, string>> = {
  AI_T1_ANALYSIS_MODE: 'enabled',
  CANONICAL_WRITE_MODE: 'enabled',
  T3_NEGATIVE_RECONCILIATION: 'enabled',
  AI_T4_EFFECTS: 'enabled',
  ASSISTANT_CANONICAL_READ: 'enabled',
  EXPORTS_CANONICAL_SOURCE: 'enabled',
};

let cable = false;

/**
 * Câblage de l'application, comme au démarrage (`instrumentation-node.ts`,
 * étape 5) : abonnés T3 / T4 et adaptateurs de l'assistant. Une seule fois
 * par processus (les scénarios partagent un fork unique).
 */
async function cabler(): Promise<void> {
  if (cable) return;
  cable = true;
  // Client S3 : URL signée calculée localement, aucun appel réseau.
  process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
  process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
  process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
  process.env.OVH_S3_ENDPOINT ??= 'http://127.0.0.1:9';
  const { registerReconciliationHandlers } = await import('@/services/ai/reconciliation');
  const { registerAgendaHandlers } = await import('@/services/ai/agenda');
  const { loadExistingAgendaItems, persistAgendaDecisions } = await import('@/services/agenda/agenda-persistence');
  const { registerAllRetrievalAdapters } = await import('@/services/verebona-assistant/registries');
  registerReconciliationHandlers();
  registerAgendaHandlers(loadExistingAgendaItems, persistAgendaDecisions);
  registerAllRetrievalAdapters();
}

/**
 * Pose l'état cible pour les tests du fichier : commutateurs (restaurés
 * après chaque test) et version de configuration T1 `master`.
 */
export function useTargetState(
  extra: Record<string, string> = {},
  opts: { masters?: Array<'T1' | 'T2' | 'T4'> } = {},
): void {
  const avant = { ...process.env };
  beforeAll(async () => {
    await cabler();
    const cfg = await import('@/services/ai/config/config-resolver');
    const { emptyTreatmentConfig } = await import('@/services/ai/config/config-types');
    // Version réelle (clé étrangère des travaux en file), contenu simulé.
    const { pgClient } = await import('@/db');
    const [v] = (await pgClient.unsafe(
      `INSERT INTO ai_config_versions (environment, status, label) VALUES ('local', 'DRAFT', 'corpus §15 (e2e)') RETURNING id`,
    )) as unknown as Array<{ id: number }>;
    const entries = (opts.masters ?? ['T1']).map((t) => ({ ...emptyTreatmentConfig(t), promptArchitecture: 'master' as const }));
    cfg.__setConfigForTests({ versionId: Number(v.id), entries }, [{ versionId: Number(v.id), entries }]);
  });
  const poser = () => { for (const [k, v] of Object.entries({ ...TARGET_SWITCHES, ...extra })) process.env[k] = v; };
  beforeAll(poser);
  afterEach(() => {
    for (const k of Object.keys({ ...TARGET_SWITCHES, ...extra })) {
      if (avant[k] === undefined) delete process.env[k]; else process.env[k] = avant[k];
    }
    poser();
  });
  afterAll(async () => {
    for (const k of Object.keys({ ...TARGET_SWITCHES, ...extra })) {
      if (avant[k] === undefined) delete process.env[k]; else process.env[k] = avant[k];
    }
    (await import('@/services/ai/config/config-resolver')).__setConfigForTests(null);
  });
}

/** Remplace des identifiants fictifs d'une sortie enregistrée (`"entityId": 184` → réel). */
export function withIds<T>(output: T, ids: Record<number, number>): T {
  let json = JSON.stringify(output);
  for (const [fictif, reel] of Object.entries(ids)) {
    json = json.replace(new RegExp(`("entityId":)${fictif}\\b`, 'g'), `$1${reel}`);
  }
  return JSON.parse(json) as T;
}

/**
 * Vide les files durables T3 et T4 avec l'exécutant de production. Plusieurs
 * tours : T3 peut produire du T4 et inversement.
 */
export async function drainQueues(max = 60): Promise<number> {
  const { runOne } = await import('@/services/ai/queue/queue-worker');
  let n = 0;
  for (let i = 0; i < max; i += 1) {
    const t3 = await runOne('T3');
    const t4 = await runOne('T4');
    if (!t3 && !t4) break;
    n += Number(t3) + Number(t4);
  }
  return n;
}

export interface AnalyseInput {
  accountId: number;
  userId: number;
  fileId: number;
  linkedAssetId?: number | null;
  /** Sortie T1 (ANALYZE_DOCUMENT) rejouée. */
  output: Record<string, unknown>;
  /** Autres sorties rejouées pendant l'analyse et ses files (T3, T4…). */
  extra?: RecordedOutput[];
}

/**
 * Analyse un document par le point d'entrée de production, puis vide les
 * files (T3, T4). Le fichier reçoit un objet S3 fictif (URL signée locale).
 */
export async function analyserDocument(
  sql: postgres.Sql,
  rejouer: (r: RecordedOutput[]) => Promise<ReplayProvider>,
  p: AnalyseInput,
): Promise<{ replay: ReplayProvider; analysedCount: number }> {
  await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = coalesce(original_filename, ${`doc-${p.fileId}.pdf`}),
              analysis_state = NULL WHERE id = ${p.fileId}`;
  const replay = await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: p.output }, ...(p.extra ?? [])]);
  // Aiguillage de production (critère 24, `ai:check-legacy`) : jamais le
  // pipeline directement. Il ne lève pas : un échec rend `null`.
  const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
  const r = await analyzeFileSources([p.fileId], p.accountId, {
    userId: p.userId, linkedAssetId: p.linkedAssetId ?? null, billable: false, origin: 'e2e/corpus-cdc15',
  });
  if (!r) throw new Error(`[e2e] analyse du fichier ${p.fileId} en échec (voir le journal source-analysis).`);
  await drainQueues();
  return { replay, analysedCount: r.analysedCount };
}

// ── Construction de sorties T1 synthétiques (D-08) ───────────────────────────

export interface FaitT1 {
  canonicalKey: string | null;
  rawKey?: string;
  label?: string;
  value: string | number;
  valueType: 'date' | 'number' | 'money_eur' | 'string';
  unit?: string | null;
  excerpt: string;
  assetId: number | null;
  targetType?: 'ASSET' | 'EQUIPMENT' | 'ROOM';
  equipmentId?: number;
  confidence?: 'certain' | 'probable';
  semanticEvent?: { type: string; nature: 'HISTORICAL' | 'DEADLINE' } | null;
  recurrence?: Record<string, unknown> | null;
}

/**
 * Sortie ANALYZE_DOCUMENT du master T1 (contrat `t1-contract`), cohérente :
 * la transcription contient chaque extrait cité (contrôle de preuve).
 */
export function sortieT1(p: {
  title: string;
  date: string;
  documentTypeCode: string;
  canonicalType?: string;
  rubricCode?: string;
  amountCents?: number | null;
  supplier?: string | null;
  assets: Array<{ id: number; label: string }>;
  equipments?: Array<{ id: number; label: string }>;
  facts: FaitT1[];
  multiAsset?: boolean;
  /** Lignes supplémentaires de la transcription (texte lu non converti en fait). */
  texte?: string[];
}): Record<string, unknown> {
  const extraits = p.facts.map((f) => f.excerpt);
  const transcription = [p.title, p.date, p.supplier ?? '', ...extraits, ...(p.texte ?? []),
    p.amountCents != null ? `TOTAL TTC ${(p.amountCents / 100).toFixed(2).replace('.', ',')} €` : ''].join('\n');
  const ev = (excerpt: string) => ({ excerpt, page: 1 });
  return {
    task: 'ANALYZE_DOCUMENT',
    document: {
      title: { value: p.title, confidence: 'certain', evidence: ev(p.title) },
      documentDate: { value: p.date, confidence: 'certain', evidence: ev(p.date) },
      ...(p.supplier ? { supplier: { name: p.supplier, confidence: 'certain', evidence: { excerpt: p.supplier } } } : {}),
      ...(p.amountCents != null ? {
        amountCents: { value: p.amountCents, confidence: 'certain', evidence: ev(`TOTAL TTC ${(p.amountCents / 100).toFixed(2).replace('.', ',')} €`) },
      } : {}),
      classification: {
        canonicalType: p.canonicalType ?? p.documentTypeCode, rubricCode: p.rubricCode ?? 'PROPERTY_MANAGEMENT',
        documentTypeCode: p.documentTypeCode, confidence: 0.95, evidence: { excerpt: p.title },
      },
    },
    entities: {
      assets: p.assets.map((a) => ({
        entityId: a.id, rawLabel: a.label, score: 0.97, confidence: 'certain', evidenceSignals: [a.label], reason: 'désignation lue',
      })),
      rooms: [],
      equipments: (p.equipments ?? []).map((e) => ({
        entityId: e.id, rawLabel: e.label, score: 0.95, confidence: 'certain', evidenceSignals: [e.label], reason: 'équipement désigné',
      })),
      suppliers: [],
      multiAsset: p.multiAsset ?? p.assets.length > 1,
    },
    transcription,
    tables: [],
    facts: p.facts.map((f) => ({
      canonicalKey: f.canonicalKey,
      rawKey: f.rawKey ?? f.canonicalKey ?? 'prestation',
      label: f.label ?? null,
      subject: null,
      attribute: null,
      rawValue: String(f.value),
      normalizedValue: f.value,
      valueType: f.valueType,
      canonicalUnit: f.unit ?? (f.valueType === 'money_eur' ? 'EUR' : null),
      target: {
        type: f.targetType ?? 'ASSET',
        entityId: f.targetType === 'EQUIPMENT' ? f.equipmentId ?? null : f.assetId,
        rawLabel: null, confidence: f.confidence ?? 'certain', evidenceSignals: [],
      },
      provenance: 'TEXT_EXTRACTION',
      confidence: f.confidence ?? 'certain',
      evidence: ev(f.excerpt),
      ...(f.semanticEvent ? { semanticEvent: f.semanticEvent } : {}),
      ...(f.recurrence ? { recurrence: f.recurrence } : {}),
    })),
    hasExploitableContent: true,
  };
}

// ── Lectures d'état final ────────────────────────────────────────────────────

/** Fiche canonique (`key_characteristics`) et colonnes miroirs. */
export async function fiche(sql: postgres.Sql, assetId: number): Promise<Record<string, unknown> & {
  _purchaseDate: string | null; _purchasePriceCents: number | null; _registration: string | null;
}> {
  const [r] = await sql<{ kc: string | null; pd: string | null; pp: number | null; reg: string | null }[]>`
    SELECT key_characteristics AS kc, to_char(purchase_date, 'YYYY-MM-DD') AS pd, purchase_price_cents AS pp,
           registration_number AS reg
      FROM assets WHERE id = ${assetId}`;
  const kc = (typeof r.kc === 'string' ? JSON.parse(r.kc) : r.kc ?? {}) as Record<string, unknown>;
  return { ...kc, _purchaseDate: r.pd, _purchasePriceCents: r.pp === null ? null : Number(r.pp), _registration: r.reg };
}

/** Preuves ACTIVES d'un bien (champ canonique → valeurs). */
export async function preuves(sql: postgres.Sql, assetId: number): Promise<Array<{ key: string; value: string; sourceId: number }>> {
  return (await sql<{ key: string; value: string; source_id: number }[]>`
    SELECT coalesce(canonical_key, field_key) AS key, value_json #>> '{}' AS value, source_id
      FROM field_evidence
     WHERE asset_id = ${assetId} AND status = 'active' AND coalesce(lifecycle_status, 'ACTIVE') = 'ACTIVE'
     ORDER BY 1, 3`).map((x) => ({ key: x.key, value: x.value, sourceId: Number(x.source_id) }));
}

/** Éléments d'agenda liés à un bien, avec nature, type métier et documents sources. */
export async function agenda(sql: postgres.Sql, assetId: number): Promise<Array<{
  id: number; title: string; date: string; nature: string | null; businessType: string | null;
  status: string | null; category: string | null; sources: number[];
}>> {
  const rows = await sql<{ id: number; title: string; d: string; nature: string | null; bt: string | null; st: string | null; cat: string | null; sources: number[] | null }[]>`
    SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS d, i.event_nature AS nature, i.business_type AS bt,
           i.manual_status AS st, i.home_category AS cat,
           (SELECT array_agg(DISTINCT s.asset_file_id ORDER BY s.asset_file_id) FROM (
              SELECT asset_file_id FROM agenda_file_links WHERE agenda_item_id = i.id
              UNION SELECT asset_file_id FROM agenda_item_sources WHERE agenda_item_id = i.id) s) AS sources
      FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id
     WHERE l.asset_id = ${assetId}
     ORDER BY i.start_date, i.id`;
  return rows.map((r) => ({
    id: Number(r.id), title: r.title, date: r.d, nature: r.nature, businessType: r.bt, status: r.st, category: r.cat,
    sources: (r.sources ?? []).map(Number),
  }));
}

/** Source d'export V12 d'un bien (données du snapshot, sans rendu). */
export async function exportDe(compte: { id: number; ownerUserId: number }, assetId: number) {
  const { loadExportSource } = await import('@/services/exports/v12/data/source');
  return loadExportSource({ assetId, accountId: compte.id, userId: compte.ownerUserId, exportType: 'DOSSIER_COMPLET' });
}

let n = 0;
/** Question à l'assistant, parcours complet (`runAssistant`, ports réels). */
export async function demander(
  compte: { id: number; ownerUserId: number },
  message: string,
  extra: Record<string, unknown> = {},
) {
  const { runAssistant } = await import('@/services/verebona-assistant/core/assistant-orchestrator.service');
  const { buildOrchestratorPorts } = await import('@/services/verebona-assistant/core/ports');
  n += 1;
  return runAssistant({
    accountId: compte.id, userId: compte.ownerUserId, planType: 'PREMIUM', message,
    clientRequestId: `corpus-${Date.now()}-${n}`, locale: 'fr-FR', ...extra,
  } as never, buildOrchestratorPorts());
}
