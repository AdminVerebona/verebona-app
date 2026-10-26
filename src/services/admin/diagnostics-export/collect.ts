/**
 * Lots 77C, 81C, 88A, 91A — génération du diagnostic (BO › Supervision ›
 * Diagnostics). Serveur uniquement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN DIAGNOSTIC, UN MOTEUR (lot 91A)
 *
 *   · le périmètre est résolu en FILTRE (`DiagFilter`) : « Ensemble de
 *     l'application » = aucun filtre (tous les comptes, tables transversales
 *     comprises) ; Compte / Utilisateur / Bien / Document / Opération =
 *     filtres du même moteur (`engine.ts`) — jamais un second chemin, jamais
 *     une information absente du global (les anciens fichiers propres aux
 *     périmètres ciblés — dossiers d'entité, journaux filtrés par période —
 *     sont supprimés : leurs lignes sont dans les tables du moteur) ;
 *   · UNE session REPEATABLE READ READ ONLY (`openReadSession`) : un seul
 *     instantané pour tout le diagnostic, TCO compris (lecture du moteur TCO
 *     dans la session) ; points de reprise par fichier ;
 *   · PLAN puis PRODUCTION EN FLUX : le plan (filtre, décomptes attendus,
 *     liste des fichiers et de leurs parties) est établi d'abord ; chaque
 *     fichier est ensuite produit à la demande, lot par lot, directement
 *     dans l'archive (`zip.ts`) — aucune construction intégrale en mémoire ;
 *   · par fichier : section, attendu, exporté, lots, statut COMPLETE /
 *     PARTIAL / FAILED, erreur, octets, SHA-256 ; manifeste et rapport en
 *     DERNIER ; jamais « n sur ? » (un attendu non calculé est une erreur) ;
 *   · masquage complet ligne par ligne, contrôle de sortie (aucun secret ni
 *     e-mail en clair).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DiagQuery } from '@/services/business-operations/diagnostics/service';
import { getBuildIdentity } from '@/lib/runtime-identity';
import { globalStatus, sectionStatus, type ExtractionStatus } from '@/services/admin/account-data/model';
import { countRows, jsonBatches, named, openReadSession, type ReadSession } from '@/services/admin/account-data/session';
import type { TextSink } from '@/services/admin/account-data/export';
import {
  DIAG_LIMITS, DIAG_REMOVED_CAPS, DIAG_SCHEMA, DIAG_SCOPE_LABELS, MASKING_NOTES, READ_ONLY_NOTE, buildReportTextFromLines, leaksSecretOrEmail, maskForExport, maskText,
  traceReportLines, type AmountTrace, type DiagFileInfo, type DiagManifest, type DiagRequest, type DiagUnavailable,
} from './model';
import { loadTcoContext, tcoSummary, traceTcoLine, type TcoContext } from './trace';
import type { DiagSectionCode } from './coverage';
import { buildAnalysisGuide, computeSectionManifests, globalWithSections, sectionOfPath } from './account-model';
import type { DiagFilter, EngineManifestPart } from './engine';

type Row = Record<string, unknown>;

export class DiagTargetNotFoundError extends Error {
  constructor(what: string) { super(`${what} introuvable.`); this.name = 'DiagTargetNotFoundError'; }
}
export class DiagBusyError extends Error {
  constructor() { super('Génération déjà en cours.'); this.name = 'DiagBusyError'; }
}

export interface DiagBundle {
  manifest: DiagManifest;
  report: string;
  /** Fichiers de l'archive (contenu sérialisé, déjà masqué) — génération EN MÉMOIRE (tests, petits volumes). */
  files: Array<{ path: string; content: string }>;
  totalBytes: number;
}

interface GenerateOptions {
  adminUserId: number;
  now?: () => Date;
  /** TCO : date du jour imposée (tests). */
  today?: string;
  /** Session de lecture fournie (tests de panne) ; sinon une session est ouverte. */
  session?: ReadSession;
  /** Lignes par partie de fichier (tests du découpage). */
  partRows?: number;
  /** Lignes par lot (tests). */
  batchRows?: number;
}

const ids = (rows: Row[], k = 'id'): number[] => [...new Set(rows.map((r) => Number(r[k])).filter((n) => Number.isSafeInteger(n) && n > 0))];
const N = (v: unknown) => Number(v ?? 0);
const errCode = (e: unknown): string | undefined => (e as { code?: string })?.code;
const describe = (e: unknown): string => `${errCode(e) ? `${errCode(e)} — ` : ''}${(e as Error)?.message ?? String(e)}`.slice(0, 500);

export interface Perimeter {
  label: string;
  accountIds: number[];
  assetIds: number[];
  equipmentIds: number[];
  fileIds: number[];
  operationIds: number[];
  userId: number | null;
  /** Objets référencés mais absents du compte (signalés, jamais reconstruits). */
  missing: DiagUnavailable[];
}

// ── Résolution du périmètre (exhaustive) ────────────────────────────────────

export async function resolvePerimeter(q: DiagQuery, r: Pick<DiagRequest, 'scope' | 'id'>): Promise<Perimeter> {
  const p: Perimeter = { label: DIAG_SCOPE_LABELS.global, accountIds: [], assetIds: [], equipmentIds: [], fileIds: [], operationIds: [], userId: null, missing: [] };
  const id = r.id ?? 0;
  if (r.scope === 'user') {
    const [u] = await q(`SELECT id FROM users WHERE id = $1`, [id]);
    if (!u) throw new DiagTargetNotFoundError('Utilisateur');
    p.userId = id;
    p.accountIds = ids(await q(`SELECT DISTINCT account_id AS id FROM account_memberships WHERE user_id = $1 ORDER BY 1`, [id]));
    p.label = `Utilisateur #${id} — ${p.accountIds.length} compte(s)`;
  } else if (r.scope === 'asset') {
    const [a] = await q(`SELECT id, account_id FROM assets WHERE id = $1`, [id]);
    if (!a) throw new DiagTargetNotFoundError('Bien');
    const A = N(a.account_id);
    p.accountIds = [A];
    p.assetIds = [id];
    p.equipmentIds = ids(await q(`SELECT e.id FROM equipments e WHERE e.asset_id = $1 ORDER BY e.id`, [id]));
    // Opérations : liens bien / équipement, et composantes qui ciblent le bien ou ses équipements (TCO).
    p.operationIds = ids(await q(`
      SELECT operation_id AS id FROM business_operation_asset_links WHERE account_id = $1 AND asset_id = $2
      UNION SELECT operation_id FROM business_operation_equipment_links WHERE account_id = $1 AND (asset_id = $2 OR equipment_id = ANY($3::int[]))
      UNION SELECT operation_id FROM business_operation_financial_components WHERE account_id = $1 AND (target_asset_id = $2 OR target_equipment_id = ANY($3::int[]))
      ORDER BY 1`, [A, id, p.equipmentIds]));
    // Documents : rattachés au bien, à ses équipements ou pièces, liés, et sources documentaires de ses Opérations.
    p.fileIds = ids(await q(`
      SELECT id FROM asset_files WHERE account_id = $1 AND (asset_id = $2 OR linked_asset_id = $2 OR equipment_id = ANY($3::int[])
                                                       OR substructure_id IN (SELECT s.id FROM substructures s WHERE s.asset_id = $2))
      UNION SELECT file_id FROM document_asset_links WHERE account_id = $1 AND (asset_id = $2 OR equipment_id = ANY($3::int[])
                                                       OR substructure_id IN (SELECT s.id FROM substructures s WHERE s.asset_id = $2))
      UNION SELECT f.id FROM business_operation_sources s JOIN asset_files f ON f.account_id = s.account_id AND f.id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END)
             WHERE s.account_id = $1 AND s.source_kind = 'DOCUMENT' AND s.operation_id = ANY($4::bigint[])
      ORDER BY 1`, [A, id, p.equipmentIds, p.operationIds]));
    p.label = `Bien #${id} (compte #${A}) — ${p.equipmentIds.length} équipement(s), ${p.fileIds.length} document(s), ${p.operationIds.length} Opération(s)`;
  } else if (r.scope === 'document') {
    const [f] = await q(`SELECT id, account_id, asset_id, linked_asset_id, equipment_id FROM asset_files WHERE id = $1`, [id]);
    if (!f) throw new DiagTargetNotFoundError('Document');
    const A = N(f.account_id);
    p.accountIds = [A];
    p.fileIds = [id];
    p.equipmentIds = ids(await q(`SELECT equipment_id AS id FROM asset_files WHERE id = $2 AND account_id = $1 AND equipment_id IS NOT NULL
                                  UNION SELECT equipment_id FROM document_asset_links WHERE account_id = $1 AND file_id = $2 AND equipment_id IS NOT NULL ORDER BY 1`, [A, id]));
    p.assetIds = ids(await q(`
      SELECT a.id FROM assets a WHERE a.account_id = $1 AND (a.id IN ($3::int, $4::int)
         OR a.id IN (SELECT asset_id FROM document_asset_links WHERE account_id = $1 AND file_id = $2)
         OR a.id IN (SELECT asset_id FROM equipments WHERE id = ANY($5::int[])))
      ORDER BY a.id`, [A, id, num0(f.asset_id), num0(f.linked_asset_id), p.equipmentIds]));
    p.operationIds = ids(await q(`
      SELECT operation_id AS id FROM business_operation_sources WHERE account_id = $1 AND source_kind = 'DOCUMENT' AND source_entity_key = ($2::int)::text
      UNION SELECT t3_operation_id FROM document_operation_candidates WHERE account_id = $1 AND file_id = $2 AND t3_operation_id IS NOT NULL
      ORDER BY 1`, [A, id]));
    p.label = `Document #${id} (compte #${A}) — ${p.assetIds.length} bien(s), ${p.operationIds.length} Opération(s)`;
  } else if (r.scope === 'account') {
    // Lot 88A : diagnostic global d'un compte — tous ses objets (l'export des tables du compte suit, `account.ts`).
    const [a] = await q(`SELECT id FROM accounts WHERE id = $1`, [id]);
    if (!a) throw new DiagTargetNotFoundError('Compte');
    p.accountIds = [id];
    p.assetIds = ids(await q(`SELECT id FROM assets WHERE account_id = $1 ORDER BY id`, [id]));
    p.equipmentIds = p.assetIds.length ? ids(await q(`SELECT id FROM equipments WHERE asset_id = ANY($1::int[]) ORDER BY id`, [p.assetIds])) : [];
    p.fileIds = ids(await q(`SELECT id FROM asset_files WHERE account_id = $1 ORDER BY id`, [id]));
    p.operationIds = ids(await q(`SELECT id FROM business_operations WHERE account_id = $1 ORDER BY id`, [id]));
    p.label = `Compte #${id} — ${p.assetIds.length} bien(s), ${p.equipmentIds.length} équipement(s), ${p.fileIds.length} document(s), ${p.operationIds.length} rapprochement(s)`;
  } else if (r.scope === 'global') {
    const [c] = await q(`SELECT (SELECT count(*)::int FROM accounts) AS comptes, (SELECT count(*)::int FROM assets) AS biens, (SELECT count(*)::int FROM asset_files) AS documents`);
    p.label = `Ensemble de l’application — ${N(c?.comptes)} compte(s), ${N(c?.biens)} bien(s), ${N(c?.documents)} document(s), tables transversales`;
  } else if (r.scope === 'operation') {
    const [o] = await q(`SELECT id, account_id FROM business_operations WHERE id = $1`, [id]);
    if (!o) throw new DiagTargetNotFoundError('Opération');
    const A = N(o.account_id);
    p.accountIds = [A];
    p.operationIds = [id];
    p.equipmentIds = ids(await q(`
      SELECT equipment_id AS id FROM business_operation_equipment_links WHERE account_id = $1 AND operation_id = $2
      UNION SELECT target_equipment_id FROM business_operation_financial_components WHERE account_id = $1 AND operation_id = $2 AND target_equipment_id IS NOT NULL
      ORDER BY 1`, [A, id]));
    p.assetIds = ids(await q(`
      SELECT asset_id AS id FROM business_operation_asset_links WHERE account_id = $1 AND operation_id = $2
      UNION SELECT asset_id FROM business_operation_equipment_links WHERE account_id = $1 AND operation_id = $2
      UNION SELECT target_asset_id FROM business_operation_financial_components WHERE account_id = $1 AND operation_id = $2 AND target_asset_id IS NOT NULL
      ORDER BY 1`, [A, id]));
    const refs = ids(await q(`
      SELECT (source_entity_key)::int AS id FROM business_operation_sources WHERE account_id = $1 AND operation_id = $2 AND source_kind = 'DOCUMENT' AND source_entity_key ~ '^[0-9]{1,9}$'
      UNION SELECT file_id FROM document_operation_candidates WHERE account_id = $1 AND t3_operation_id = $2
      ORDER BY 1`, [A, id]));
    p.fileIds = refs.length ? ids(await q(`SELECT id FROM asset_files WHERE account_id = $1 AND id = ANY($2::int[]) ORDER BY id`, [A, refs])) : [];
    for (const f of refs.filter((x) => !p.fileIds.includes(x))) p.missing.push({ element: `document #${f}`, motif: 'introuvable dans le compte (supprimé définitivement ?) : source citée, dossier non disponible' });
    p.label = `Opération #${id} (compte #${A}) — ${p.assetIds.length} bien(s), ${p.fileIds.length} document(s) source`;
  }
  return p;
}
const num0 = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const addTo = <K, T>(m: Map<K, T[]>, k: K, v: T) => { if (!m.has(k)) m.set(k, []); m.get(k)!.push(v); };

/**
 * Filtre du moteur unique correspondant au périmètre résolu (lot 91A).
 * Objets FOCUS (les lignes qui les désignent sont retenues) : Bien → le bien,
 * ses équipements, ses documents et ses Opérations ; Document → le document
 * et les Opérations qu'il source ; Opération → l'Opération et ses documents
 * sources. Biens de CONTEXTE (TCO, traçabilité des propriétés) : les biens
 * concernés par l'objet.
 */
export function filterOfPerimeter(req: Pick<DiagRequest, 'scope'>, p: Perimeter): DiagFilter {
  const entity = req.scope === 'asset'
    ? { assets: p.assetIds, files: p.fileIds, operations: p.operationIds, equipments: p.equipmentIds }
    : req.scope === 'document' ? { assets: [], files: p.fileIds, operations: p.operationIds, equipments: [] }
      : req.scope === 'operation' ? { assets: [], files: p.fileIds, operations: p.operationIds, equipments: [] } : null;
  return {
    scope: req.scope as DiagFilter['scope'],
    accounts: req.scope === 'global' ? null : p.accountIds,
    entity: entity ? { ...entity, contextAssets: p.assetIds } : null,
    userId: p.userId,
    label: p.label,
  };
}

// ── Production d'un fichier : statut, intégrité ─────────────────────────────

/** Fichier planifié de l'archive : produit À LA DEMANDE, dans l'ordre. */
interface PlannedEntry {
  path: string;
  produce: (sink: TextSink) => Promise<void>;
}

interface EntryResult { expected: number | null; count?: number; batches: number; error: string | null; status?: ExtractionStatus }

/** Sérialisation sûre d'une ligne masquée : contrôle de sortie (aucun secret ni e-mail en clair), JSON toujours valide. */
function safeJson(v: unknown): string {
  const s = JSON.stringify(v);
  if (!leaksSecretOrEmail(s)) return s;
  const m = maskText(s);
  try { JSON.parse(m); return m; } catch { return JSON.stringify({ $etat: 'masque', motif: 'ligne masquée (motif de secret résiduel)' }); }
}

// ── Plan du diagnostic ──────────────────────────────────────────────────────

export interface DiagPlan {
  generationId: string;
  perimeter: Perimeter;
  /** Lot 91A : filtre du moteur unique (accounts null : Ensemble de l'application). */
  filter: DiagFilter;
  /** Fichiers, dans l'ordre de production (rapport et manifeste en dernier). */
  entries: PlannedEntry[];
  /** Après production : manifeste et rapport. */
  result(): { manifest: DiagManifest; report: string };
  /** Une erreur fatale (écriture tentée, archive) : manifeste FAILED. */
  fail(e: unknown): void;
}

/**
 * Établit le plan d'un diagnostic DANS la session : filtre, décomptes
 * attendus (même instantané), fichiers et parties. Aucun contenu n'est lu ici.
 */
export async function planDiagnostic(req: DiagRequest, s: ReadSession, opts: GenerateOptions): Promise<DiagPlan> {
  const now = (opts.now ?? (() => new Date()))();
  const generationId = randomUUID();
  const partRows = Math.max(1, opts.partRows ?? DIAG_LIMITS.partRows);
  const batchRows = Math.max(1, opts.batchRows ?? DIAG_LIMITS.batchRows);
  const { isSensitiveCanonicalKey } = await import('@/services/admin/account-data/dossier');
  const maskOpts = { isSensitiveKey: isSensitiveCanonicalKey };
  const M = (v: unknown) => maskForExport(v, maskOpts);
  const row = (v: unknown) => safeJson(M(v));

  const per = await s.savepoint(() => resolvePerimeter(s.q, req));
  const filter = filterOfPerimeter(req, per);
  const global = filter.accounts === null;
  const txt = (xs: number[]) => xs.map(String);
  const e = filter.entity;
  const V: Record<string, unknown> = {
    accounts: filter.accounts ?? [], userId: per.userId,
    eAssetsT: txt(e?.assets ?? []), eFilesT: txt(e?.files ?? []), eOpsT: txt(e?.operations ?? []), eEquipT: txt(e?.equipments ?? []),
    ctxAssets: e?.contextAssets ?? [],
  };

  const infos: DiagFileInfo[] = [];
  const warnings: string[] = [];
  const unavailable: DiagUnavailable[] = [...per.missing];
  const traceLines: string[] = [];
  const counts: Record<string, number> = {};
  let fatal: string | null = null;
  const fileSections = new Map<string, DiagSectionCode>();
  const sectionIssues = new Map<DiagSectionCode, string[]>();
  const sectionFilters = new Map<DiagSectionCode, string[]>();
  const sectionLimitations = new Map<DiagSectionCode, string[]>();
  const sectionTruncations = new Map<DiagSectionCode, string[]>();

  /** Fichier : écrit dans `sink`, statut et intégrité consignés ; erreur non fatale → FAILED / PARTIAL, fichier refermé valide. */
  const entries: PlannedEntry[] = [];
  const entry = (path: string, description: string, body: (w: (c: string) => Promise<void>) => Promise<EntryResult>, part?: DiagFileInfo['part'], section?: DiagSectionCode) => {
    const sec = section ?? sectionOfPath(path);
    fileSections.set(path, sec);
    entries.push({
      path,
      produce: async (sink) => {
        const hash = createHash('sha256');
        let bytes = 0;
        const w = async (c: string) => { hash.update(c); bytes += Buffer.byteLength(c); await sink.write(c); };
        let r: EntryResult;
        try {
          r = await body(w);
        } catch (e) {
          if ((e as Error)?.name === 'SinkError' || errCode(e) === '25006') throw e;
          console.error(`[admin/diagnostics] ${path} :`, (e as Error)?.message ?? e);
          // Échec avant toute écriture : fichier JSON valide (null), statut FAILED, erreur exploitable.
          if (!bytes && path.endsWith('.json')) await w('null\n');
          r = { expected: null, batches: 0, error: describe(e) };
        }
        const status = r.status ?? sectionStatus(r.expected, r.count ?? 0, r.error);
        infos.push({
          path, description, section: sec, ...(r.count !== undefined ? { count: r.count } : {}), complete: status === 'COMPLETE',
          expected: r.expected, batches: r.batches, status, error: r.error, bytes, sha256: hash.digest('hex'), ...(part ? { part } : {}),
        });
        if (status !== 'COMPLETE') {
          // Jamais « n sur ? » : sans attendu, l'erreur dit pourquoi.
          const detail = r.error ? ` — ${r.error}` : r.expected !== null ? ` — ${r.count ?? 0} élément(s) exporté(s) sur ${r.expected} attendu(s)` : '';
          warnings.push(`${path} : ${status}${detail}.`);
        }
      },
    });
  };

  /** Liste JSON lue par curseur (lots), masquée ligne par ligne ; toujours refermée (JSON valide), même en erreur. */
  const streamList = async (w: (c: string) => Promise<void>, sql: string, params: unknown[], expected: number | null, transform?: (r: Row) => Row, pad = '', serialize?: (r: Row) => string): Promise<EntryResult> => {
    let n = 0;
    let batches = 0;
    let error: string | null = null;
    await w('[');
    try {
      await s.savepoint(async () => {
        for await (const lot of jsonBatches(s, sql, params, batchRows)) {
          let chunk = '';
          for (const r of lot) chunk += `${n++ ? ',' : ''}\n${pad}  ${serialize ? serialize(transform ? transform(r) : r) : row(transform ? transform(r) : r)}`;
          batches++;
          await w(chunk);
        }
      });
    } catch (e) {
      if ((e as Error)?.name === 'SinkError' || errCode(e) === '25006') throw e;
      console.error('[admin/diagnostics] liste :', (e as Error)?.message ?? e);
      error = describe(e);
    }
    await w(`${n ? `\n${pad}` : ''}]`);
    return { expected, count: n, batches, error };
  };

  /** Décompte attendu (même instantané) ; une erreur est rendue (fichier FAILED, motif exploitable). */
  const countOf = async (sql: string, params: unknown[]): Promise<{ n: number | null; error: string | null }> => {
    try { return { n: await s.savepoint(() => countRows(s.q, sql, params)), error: null }; } catch (e) {
      if (errCode(e) === '25006') throw e;
      return { n: null, error: `attendu non calculé : ${describe(e)}` };
    }
  };

  /** Fichier de liste (découpé en parties de `partRows` lignes si nécessaire, toutes dans l'archive). */
  const list = async (path: string, description: string, text: string, transform?: (r: Row) => Row,
    opt: { onlyIfRows?: boolean; serialize?: (r: Row) => string; section?: DiagSectionCode; values?: Record<string, unknown>; expected?: number } = {}) => {
    const { sql, params } = named(text, opt.values ? { ...V, ...opt.values } : V);
    const exp = opt.expected !== undefined ? { n: opt.expected, error: null } : await countOf(sql, params);
    if (opt.onlyIfRows && exp.n === 0) return 0;
    counts[path] = exp.n ?? 0;
    const parts = exp.n !== null && exp.n > partRows ? Math.ceil(exp.n / partRows) : 1;
    for (let k = 0; k < parts; k++) {
      const p = parts > 1 ? path.replace(/\.json$/, `.part-${String(k + 1).padStart(4, '0')}.json`) : path;
      const expected = exp.n === null ? null : parts > 1 ? Math.min(partRows, exp.n - k * partRows) : exp.n;
      // Pagination TECHNIQUE (parties d'un même fichier logique, toutes dans l'archive) — jamais une troncature.
      const pSql = parts > 1 ? `SELECT * FROM (${sql}) x LIMIT ${partRows} OFFSET ${k * partRows}` : sql;
      entry(p, parts > 1 ? `${description} — partie ${k + 1}/${parts}` : description, async (w) => {
        if (exp.error) { await w('[]\n'); return { expected: null, count: 0, batches: 0, error: exp.error }; }
        const r = await streamList(w, pSql, params, expected, transform, '', opt.serialize);
        await w('\n');
        return r;
      }, parts > 1 ? { index: k + 1, of: parts, group: path } : undefined, opt.section);
    }
    return exp.n ?? 0;
  };

  /** Objet JSON dont certaines clés sont des listes lues en flux. */
  type Part = { value: () => Promise<unknown> } | { list: string; transform?: (r: Row) => Row };
  const object = async (path: string, description: string, parts: Record<string, Part>, countKey?: string, section?: DiagSectionCode) => {
    const compiled: Record<string, { sql: string; params: unknown[]; n: number | null; error: string | null; transform?: (r: Row) => Row } | null> = {};
    for (const [k, p] of Object.entries(parts)) {
      if ('list' in p) {
        const c = named(p.list, V);
        const e = await countOf(c.sql, c.params);
        compiled[k] = { ...c, ...e, transform: p.transform };
      } else compiled[k] = null;
    }
    entry(path, description, async (w) => {
      await w('{');
      let first = true;
      let expected = 0;
      let count = 0;
      let batches = 0;
      const errors: string[] = [];
      for (const [k, p] of Object.entries(parts)) {
        await w(`${first ? '' : ','}\n  ${JSON.stringify(k)}: `);
        first = false;
        const c = compiled[k];
        if (c) {
          if (c.error) { errors.push(`${k} : ${c.error}`); await w('[]'); continue; }
          const r = await streamList(w, c.sql, c.params, c.n, c.transform, '  ');
          expected += c.n ?? 0;
          count += r.count ?? 0;
          batches += r.batches;
          if (r.error) errors.push(`${k} : ${r.error}`);
          if (countKey && k === countKey) counts[path] = r.count ?? 0;
        } else {
          try {
            const v = await s.savepoint(() => (p as { value: () => Promise<unknown> }).value());
            await w(JSON.stringify(M(v), null, 2).replace(/\n/g, '\n  '));
          } catch (e) {
            if (errCode(e) === '25006') throw e;
            errors.push(`${k} : ${describe(e)}`);
            await w('null');
          }
        }
      }
      await w('\n}\n');
      return { expected, count, batches, error: errors.length ? errors.join(' ; ') : null };
    }, undefined, section);
  };

  // ── Moteur unique : tables, fermeture, contrôles, traçabilité des propriétés ─
  const { planDiagnosticEngine } = await import('./engine');
  const enginePart: EngineManifestPart = await planDiagnosticEngine({
    s, V, isSensitiveKey: isSensitiveCanonicalKey, M, safeJson, entry, list, object,
    issues: sectionIssues, filters: sectionFilters, limitations: sectionLimitations, warnings, unavailable, today: opts.today,
  }, filter);

  // ── TCO et traçabilité de CHAQUE montant (moteur TCO existant, DANS l'instantané) ─
  let nTraces = 0;
  let nRuptures = 0;
  let nSansLien = 0;
  const summaries: Row[] = [];
  const assetsSql = enginePart.assetsSql;
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();
  const runner = { execute: async (q: import('drizzle-orm').SQL) => { const x = dialect.sqlToQuery(q); return s.q(x.sql, x.params); } };
  const writeTrace = async (w: (c: string) => Promise<void>, t: AmountTrace, first: boolean) => {
    const masked = M(t) as AmountTrace;
    await w(`${first ? '' : ','}\n  ${safeJson(masked)}`);
    traceLines.push(...(maskForExport(traceReportLines(masked).join('\n'), maskOpts) as string).split('\n'));
    nTraces++;
    if (t.rupture) nRuptures++;
    if (String(t.ligne.id ?? '').startsWith('c:')) {
      const ext = t.chaine.find((x) => x.etape === 'EXTRACTION_IA');
      if (ext && ext.statut !== 'sans_objet' && !(ext.donnees as { lienPersiste?: unknown } | undefined)?.lienPersiste) nSansLien++;
    }
  };
  entry('tracabilite/montants.json', 'Traçabilité de chaque montant TCO des biens du filtre : Document → Extraction IA → Décision → Enregistrement → Rapprochement → Calcul → Affichage ; valeurs source / proposée IA / enregistrée / calculée / affichée', async (w) => {
    await w('[');
    let n = 0;
    let expected = 0;
    const failed: string[] = [];
    let assets: Array<{ id: number; A: number }> = [];
    if (assetsSql) {
      const c = named(assetsSql, V);
      assets = (await s.savepoint(() => s.q(c.sql, c.params))).map((r) => ({ id: N(r.id), A: N(r.account_id) }));
    }
    if (!assets.length) unavailable.push({ element: 'TCO', motif: 'aucun bien dans le filtre : aucun montant TCO à tracer' });
    // Filtre Document / Opération : lignes TCO liées à l'objet (mêmes traces que le global, moins de lignes).
    const opIds = new Set(per.operationIds);
    let comps = new Set<string>();
    if (req.scope === 'operation' && per.operationIds.length) {
      comps = new Set((await s.savepoint(() => s.q(`SELECT id FROM business_operation_financial_components WHERE operation_id = ANY($1::bigint[])`, [per.operationIds]))).map((r) => `c:${r.id}`));
    }
    const keep = (l: { id: string; fileId: number | null; relatedFileId: number | null; operationId: number | null }) => {
      if (req.scope === 'document' && req.id) return l.fileId === req.id || l.relatedFileId === req.id || (l.operationId != null && opIds.has(l.operationId));
      if (req.scope === 'operation') return (l.operationId != null && opIds.has(l.operationId)) || comps.has(l.id);
      return true;
    };
    // Un bien à la fois : contexte TCO libéré après ses lignes (mémoire bornée).
    for (const { id, A } of assets) {
      let ctx: TcoContext;
      try {
        ctx = await s.savepoint(() => loadTcoContext(A, id, opts.today, runner));
      } catch (e) {
        if ((e as Error)?.name === 'SinkError' || errCode(e) === '25006') throw e;
        failed.push(`TCO du bien #${id} : ${describe(e)}`);
        continue;
      }
      summaries.push(tcoSummary(ctx));
      if (ctx.unavailable) unavailable.push({ element: `TCO du bien #${ctx.assetId}`, motif: ctx.unavailable });
      const lines = (ctx.result?.lines ?? []).filter(keep);
      expected += lines.length;
      for (const l of lines) {
        try {
          const t = await s.savepoint(() => traceTcoLine(s.q, A, ctx, l));
          await writeTrace(w, t, n++ === 0);
        } catch (e) {
          if ((e as Error)?.name === 'SinkError' || errCode(e) === '25006') throw e;
          failed.push(`ligne ${l.id} : ${describe(e)}`);
        }
      }
    }
    await w(`${n ? '\n' : ''}]\n`);
    return { expected, count: n, batches: 1, error: failed.length ? failed.join(' ; ') : null };
  }, undefined, 'tracabilite');
  entry('tracabilite/tco.json', 'TCO recalculé (moteur existant, dans l’instantané) des biens du filtre : synthèse, postes, fiabilité', async (w) => {
    await w(`${JSON.stringify(summaries.map((x) => M(x)), null, 2)}\n`);
    return { expected: summaries.length, count: summaries.length, batches: 1, error: null };
  }, undefined, 'tracabilite');

  // Diagnostic renforcé : sorties modèle conservées (accès existant, journalisé) — annexe à accès restreint.
  if (req.reinforced) {
    entry('ia/sorties-modele.json', 'DIAGNOSTIC RENFORCÉ — sorties modèle conservées des traces du filtre (accès AI_MODEL_OUTPUT_READ journalisé)', async (w) => {
      const rf = `(SELECT t.trace_ids FROM ai_execution_reports t WHERE (${enginePart.tableFilters.ai_execution_reports ?? 'FALSE'}))`;
      const tq = named(`SELECT DISTINCT unnest(r.trace_ids) AS trace FROM ${rf} r(trace_ids) ORDER BY 1`, V);
      const all = (await s.savepoint(() => s.q(tq.sql, tq.params))).map((r) => String(r.trace)).filter(Boolean);
      const traceIds = all.slice(0, DIAG_LIMITS.modelOutputTraces);
      const cq = named(`SELECT DISTINCT ON (metadata->>'traceId') metadata->>'traceId' AS trace, id FROM ai_usage_event
                         WHERE ${global ? 'TRUE' : 'account_id = ANY({{accounts}}::int[])'} AND metadata->>'traceId' = ANY({{traces}}::text[]) ORDER BY metadata->>'traceId', id DESC`, { ...V, traces: traceIds });
      const callsByTrace = new Map((await s.savepoint(() => s.q(cq.sql, cq.params))).map((r) => [String(r.trace), N(r.id)]));
      const { readModelOutputsForAdmin } = await import('@/services/ai/telemetry/model-output-access');
      const sorties: Row[] = [];
      let refus = false;
      let tronque = false;
      for (const t of traceIds) {
        const callId = callsByTrace.get(t);
        if (!callId) { unavailable.push({ element: `Sorties modèle de la trace ${t}`, motif: 'aucun appel IA corrélé conservé' }); continue; }
        const r = await readModelOutputsForAdmin({ adminUserId: opts.adminUserId, callId, purpose: 'export' });
        if (!r.ok) { if (r.code === 'FORBIDDEN') { refus = true; break; } unavailable.push({ element: `Sorties modèle de la trace ${t}`, motif: r.message }); continue; }
        const cut = (x: string | null) => {
          if (x === null || x.length <= DIAG_LIMITS.modelOutputChars) return x;
          tronque = true;
          return `${x.slice(0, DIAG_LIMITS.modelOutputChars)}… [tronqué : ${x.length} caractères — restriction d’accès aux sorties IA]`;
        };
        for (const o of r.outputs) sorties.push({ trace: t, appel: callId, diagnostic: o.diagnosticId, modele: o.model, rang: o.callIndex, sortieBrute: cut(o.raw), sortieExtraite: cut(o.extracted), sortieStructuree: o.parsed });
      }
      if (refus) unavailable.push({ element: 'Diagnostic renforcé', motif: 'refusé : consultation des sorties modèle réservée (AI_MODEL_OUTPUT_ADMIN_IDS) — refus journalisé' });
      else if (!all.length) unavailable.push({ element: 'Diagnostic renforcé', motif: 'aucune trace IA dans le filtre' });
      else if (!sorties.length) unavailable.push({ element: 'Diagnostic renforcé', motif: 'aucune sortie modèle conservée (diagnostics antérieurs au lot 82C purgés à 88 jours, ou appels sans sortie)' });
      const restreint = all.length > traceIds.length;
      if (restreint) unavailable.push({ element: `Sorties modèle de ${all.length - traceIds.length} trace(s)`, motif: `restriction d’accès aux sorties IA sensibles (inchangée) : ${DIAG_LIMITS.modelOutputTraces} traces jointes sur ${all.length}` });
      // Troncature DÉCLARÉE dans la section (jamais silencieuse).
      if (restreint) addTo(sectionTruncations, 'extractions-ia', `ia/sorties-modele.json : ${DIAG_LIMITS.modelOutputTraces} trace(s) jointe(s) sur ${all.length} (restriction d’accès aux sorties IA, inchangée).`);
      if (tronque) addTo(sectionTruncations, 'extractions-ia', `ia/sorties-modele.json : sortie(s) coupée(s) à ${DIAG_LIMITS.modelOutputChars} caractères (restriction d’accès aux sorties IA, inchangée).`);
      await w(`${JSON.stringify(sorties.map((x) => M(x)), null, 2)}\n`);
      // Restriction d'accès (requalifiée, signalée) : le fichier n'est pas présenté comme complet si des sorties ne sont pas jointes.
      return { expected: sorties.length, count: sorties.length, batches: 1, error: null, status: restreint || tronque ? 'PARTIAL' : 'COMPLETE' };
    }, undefined, 'extractions-ia');
  }

  // Sélections déclarées (aucune troncature silencieuse) : ce qui n'est pas « tout » est dit ici.
  const selections: string[] = [
    'tracabilite/identite-economique.json › sources[].motif_retrait : DERNIER motif de retrait de chaque source (sélection) — historique complet : donnees/historique/business_operation_history.json.',
    'tracabilite/montants.json › candidat retenu pour un montant (repli par clé de candidat) : candidat ACTIF le plus récent (sélection) — tous les candidats sont exportés (donnees/candidats/document_operation_candidates.json).',
    'Messages d’erreur de GÉNÉRATION du manifeste (champ error des fichiers) : 500 caractères. Les erreurs des DONNÉES (last_error, error_message…) sont exportées intégralement.',
  ];
  const sectionsOf = () => computeSectionManifests({
    files: infos.filter((f) => f.path !== 'LISEZMOI-ANALYSE.md'), fileSections, issues: sectionIssues,
    filters: sectionFilters, limitations: sectionLimitations, truncations: sectionTruncations, global,
    notApplicableMotif: () => `hors filtre « ${filter.label} » : aucune table de cette section ne concerne l’objet filtré — données présentes dans « Ensemble de l’application »`,
  });
  entry('LISEZMOI-ANALYSE.md', 'Guide d’analyse : vérifier la complétude, où se trouve quoi, reconstruire une chaîne source → … → affichage (exemple du prix d’achat traité comme cas général)', async (w) => {
    const sections = sectionsOf();
    await w(buildAnalysisGuide({
      scope: req.scope, scopeLabel: DIAG_SCOPE_LABELS[req.scope], target: per.label, generatedAt: now.toISOString(), global,
      sections: sections.map((x) => ({ code: x.code, label: x.label, status: x.status, motif: x.motif, files: x.files.length })),
    }));
    return { expected: null, batches: 1, error: null };
  }, undefined, 'controle');

  // Manifeste et rapport : en DERNIER (statuts, intégrité de tous les fichiers).
  const env = (process.env.NEXT_PUBLIC_APP_ENV || process.env.NODE_ENV || 'inconnu').trim();
  const build = getBuildIdentity();
  let finalManifest: DiagManifest | null = null;
  let finalReport = '';
  const buildManifest = (): DiagManifest => {
    if (finalManifest) return finalManifest;
    if (nRuptures) unavailable.push({ element: `Traçabilité de ${nRuptures} montant(s) sur ${nTraces}`, motif: 'au moins une étape non disponible (voir « rupture » de chaque ligne dans tracabilite/montants.json)' });
    if (nSansLien) unavailable.push({ element: `Lien composante → indice T1 (${nSansLien} montant(s))`, motif: 'non encore persisté (composante antérieure au lot 78A, pas encore reconsolidée) : indices du candidat exportés, correspondance de valeur signalée comme telle' });
    unavailable.push({ element: 'Documents originaux et texte intégral', motif: 'exclus par principe (sécurité) : seules les données structurées et extraits de preuve sont exportés' });
    const sections = sectionsOf();
    const status = fatal ? 'FAILED' : globalWithSections(globalStatus(infos.map((f) => ({ status: f.status ?? 'COMPLETE' }))), sections);
    finalManifest = {
      schema: DIAG_SCHEMA, generationId, generatedAt: now.toISOString(), environment: env,
      build: { version: build.version, commit: build.commit, commitSource: build.commitSource, container: build.container },
      request: { ...req, scopeLabel: DIAG_SCOPE_LABELS[req.scope] },
      target: { label: per.label, accountIds: per.accountIds, allAccounts: global },
      limits: DIAG_LIMITS, status,
      snapshot: {
        isolation: s.info.isolation, at: s.info.at, snapshot: s.info.snapshot,
        verification: 'Toutes les lectures, TCO compris, dans UNE transaction REPEATABLE READ READ ONLY ; attendu = count(*) (par compte) dans le même instantané ; exporté = lignes écrites (curseur, lots ordonnés) ; COMPLETE seulement si exporté = attendu pour chaque fichier, aucune erreur, aucune section PARTIAL ; SHA-256 de chaque fichier (contenu non compressé) ci-dessous.',
        exceptions: [...(fatal ? [`Génération interrompue : ${fatal}`] : [])],
      },
      removedCaps: DIAG_REMOVED_CAPS,
      files: [
        { path: 'rapport.txt', description: 'Rapport synthétique lisible (copiable)', complete: true, section: 'controle' },
        { path: 'manifeste.json', description: 'Contexte, filtre, instantané, sections et fichiers (section, attendu, exporté, statut, erreurs, SHA-256), troncatures, exclusions, auto-contrôle', complete: true, section: 'controle' },
        ...infos,
      ],
      warnings, unavailable, masking: [...MASKING_NOTES], readOnly: READ_ONLY_NOTE,
      sections, truncations: [...[...sectionTruncations.values()].flat(), ...selections],
      couverture: enginePart.couverture, exclusionsVolontaires: enginePart.exclusionsVolontaires, autoControle: enginePart.autoControle,
    };
    const summary: Array<[string, string | number]> = [
      ['Filtre', per.label],
      ['Statut de la génération', status],
      ['Tables exportées', `${enginePart.couverture.exportees} (couvertes : ${enginePart.couverture.couvertes}, exclues avec motif : ${enginePart.couverture.exclues}, hors filtre : ${enginePart.couverture.horsFiltre.length})`],
      ['Comptes couverts', `${enginePart.couverture.comptes.couverts} / ${enginePart.couverture.comptes.attendus}`],
      ['Anomalies de supervision', counts['donnees/technique/admin_anomalies.json'] ?? 0],
      ['Traitements (file)', counts['donnees/technique/ai_job_queue.json'] ?? 0],
      ['Rapports d’exécution', counts['donnees/extractions-ia/ai_execution_reports.json'] ?? 0],
      ['Appels IA', counts['donnees/technique/ai_usage_event.json'] ?? 0],
      ['Montants tracés', nTraces],
      ['Montants à trace interrompue', nRuptures],
      ['Avertissements', warnings.length],
      ['Sections complètes', `${sections.filter((x) => x.status === 'COMPLETE').length} / ${sections.filter((x) => x.status !== 'NOT_APPLICABLE').length} (non applicables : ${sections.filter((x) => x.status === 'NOT_APPLICABLE').length})`],
    ];
    finalReport = maskForExport(buildReportTextFromLines(finalManifest, summary, traceLines), maskOpts) as string;
    if (leaksSecretOrEmail(finalReport)) finalReport = maskText(finalReport);
    return finalManifest;
  };
  entries.push({
    path: 'rapport.txt',
    produce: async (sink) => { buildManifest(); await sink.write(finalReport); },
  });
  entries.push({
    path: 'manifeste.json',
    produce: async (sink) => {
      const rapport = createHash('sha256').update(finalReport).digest('hex');
      const m = buildManifest();
      m.files[0] = { ...m.files[0], bytes: Buffer.byteLength(finalReport), sha256: rapport, status: 'COMPLETE' };
      let json = `${JSON.stringify(maskForExport(m, maskOpts), null, 2)}\n`;
      if (leaksSecretOrEmail(json)) { const x = maskText(json); try { JSON.parse(x); json = x; } catch { /* JSON conservé : masquage par valeur déjà appliqué */ } }
      await sink.write(json);
    },
  });

  return {
    generationId, perimeter: per, filter, entries,
    result: () => ({ manifest: buildManifest(), report: finalReport }),
    fail: (e) => { fatal = describe(e); },
  };
}

// ── Exécutions ──────────────────────────────────────────────────────────────

/** Ouvre la session, établit le plan, exécute `run`, ferme la session (place de génération réservée). */
export async function withDiagnosticPlan<T>(req: DiagRequest, opts: GenerateOptions, run: (plan: DiagPlan, s: ReadSession) => Promise<T>): Promise<T> {
  const { tryAcquireExportSlot } = await import('@/services/admin/export-generations');
  const slot = tryAcquireExportSlot('TECH_DIAGNOSTIC');
  if (!slot) throw new DiagBusyError();
  const own = !opts.session;
  const s = opts.session ?? await openReadSession().catch((e) => { slot.release(); throw e; });
  try {
    const plan = await planDiagnostic(req, s, opts);
    return await run(plan, s);
  } finally {
    if (own) await (s as ReadSession & { close(): Promise<void> }).close();
    slot.release();
  }
}

/** Produit tous les fichiers dans l'ordre vers `open(path)` ; rend le manifeste et le rapport. */
async function producePlan(plan: DiagPlan, open: (path: string) => TextSink & { close?: () => Promise<void> | void }): Promise<{ manifest: DiagManifest; report: string }> {
  for (const e of plan.entries) {
    const sink = open(e.path);
    await e.produce(sink);
    await sink.close?.();
  }
  return plan.result();
}

/**
 * Génération EN MÉMOIRE (tests, petits volumes) : contenu de chaque fichier.
 * Le BO utilise la production en flux (`zip.ts`, aperçu sans contenu).
 */
export async function generateDiagnostic(req: DiagRequest, opts: GenerateOptions): Promise<DiagBundle> {
  return withDiagnosticPlan(req, opts, async (plan) => {
    const files: Array<{ path: string; content: string }> = [];
    const { manifest, report } = await producePlan(plan, (path) => {
      const parts: string[] = [];
      return { write: async (c: string) => { parts.push(c); }, close: () => { files.push({ path, content: parts.join('') }); } };
    });
    // Ordre historique : rapport et manifeste en tête.
    files.sort((a, b) => (a.path === 'rapport.txt' ? -1 : b.path === 'rapport.txt' ? 1 : a.path === 'manifeste.json' ? -1 : b.path === 'manifeste.json' ? 1 : 0));
    return { manifest, report, files, totalBytes: files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) };
  });
}

/** Aperçu d'un plan : production complète SANS conserver le contenu — manifeste, rapport, tailles. */
export async function previewPlan(plan: DiagPlan): Promise<{ manifest: DiagManifest; report: string; files: Array<{ path: string; bytes: number }> }> {
  const sizes: Array<{ path: string; bytes: number }> = [];
  const { manifest, report } = await producePlan(plan, (path) => {
    let bytes = 0;
    return { write: async (c: string) => { bytes += Buffer.byteLength(c); }, close: () => { sizes.push({ path, bytes }); } };
  });
  return { manifest, report, files: sizes };
}

