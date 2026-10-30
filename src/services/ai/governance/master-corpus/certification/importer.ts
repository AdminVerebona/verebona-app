/**
 * Lot 100B — IMPORTEUR du corpus de référence #601 (ZIP
 * `verebona_corpus_IA_livraison_developpeurs_2026-10-27.zip`, 401 scénarios
 * + 15 stress). Le format du ZIP n'étant pas encore connu, l'importeur lit un
 * FORMAT D'ENTRÉE DOCUMENTÉ (docs/exploitation/corpus-qualification-601.md) :
 *
 *   cases/<id>.json        un cas par fichier (format `importCaseSchema`) ;
 *   cases.json             tableau de cas (même format) ;
 *   cases.csv              une ligne par cas (colonnes `CSV_COLUMNS`), avec
 *                          `contexts/<id>.json`, `oracles/<id>.json`,
 *                          `outputs/<id>.json` facultatifs ;
 *   pieces/…               pièces sources (PDF, images…) citées par les cas ;
 *   stress/<id>.json       scénarios de stress (E2E_MÉTIER).
 * Un adaptateur du format réel du ZIP n'aura qu'à produire ces fichiers.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * GARANTIES
 *   · aucune approbation par import : un statut RÉFÉRENCE_APPROUVÉE fourni
 *     est REFUSÉ (cas importé « À_COMPLÉTER », ligne signalée) ;
 *   · aucune suppression : un cas déjà au manifeste est RÉVISÉ (historique
 *     conservé, empreinte d'oracle tracée) ; un cas non convertible reste au
 *     manifeste avec sa cause ;
 *   · rapport ligne par ligne : importé, révisé, inchangé, non convertible
 *     (cause), approbation refusée ;
 *   · entrée réelle : construite par le constructeur de PRODUCTION de
 *     l'opération (`liveVariablesFor`) — sinon non convertible ;
 *   · multimodal : la pièce doit être fournie (copiée avec son empreinte),
 *     sinon le cas est NON REJOUABLE (jamais vert) ;
 *   · opérations recalculées depuis le registre ; T5 jamais réintroduit.
 * Conversion PURE (fichiers à écrire rendus à l'appelant) : le script
 * `scripts/ai-corpus-import.ts` écrit, le développeur relit et commite.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { basename, posix } from 'node:path';
import { z } from 'zod';
import { AI_OPERATIONS, isMasterOperation } from '../../../registry/operations';
import { treatmentOfUseCase } from '../../../config/treatments';
import { canonicalJson } from '../../../qualification/signature';
import type { MasterCorpusCase } from '../cases';
import { reviseEntry } from './manifest';
import {
  DIFFICULTIES, EVALUATION_TYPES, INPUT_MODES, oracleSchema, parseCaseStatus, TEST_TYPES,
  type CorpusManifest, type DeclarableStatus, type ManifestEntry, type Oracle,
} from './model';
import { oracleApprovalProblems, oracleFingerprint } from './oracle';

export const IMPORT_FORMAT_VERSION = 'corpus-601-import-v1';
/** Répertoire des cas convertis (lu par `MASTER_CORPUS_DIRS`). */
export const CORPUS_601_DIR = 'src/services/ai/governance/master-corpus/corpus-601';

const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === 'boolean' ? v : /^(1|true|oui|vrai|yes|o|x)$/i.test(v.trim())));

export const importCaseSchema = z.object({
  id: z.string().min(1).max(80),
  operation: z.string().min(1).max(80).optional(),
  treatment: z.string().max(4).optional(),
  description: z.string().max(4000).default(''),
  contract: z.string().max(80).nullable().optional(),
  schema: z.string().max(80).nullable().optional(),
  riskFamily: z.string().max(80).nullable().optional(),
  difficulty: z.string().max(40).nullable().optional(),
  critical: bool.optional(),
  pair: z.object({ id: z.string().min(1).max(80), side: z.enum(['A', 'B']), discriminantChangesDecision: bool, discriminant: z.string().max(400).nullable().optional() }).nullable().optional(),
  provenance: z.string().max(40).optional(),
  sourcePieces: z.array(z.string().max(400)).max(20).default([]),
  inputMode: z.string().max(20).optional(),
  testType: z.string().max(40).optional(),
  evaluationType: z.string().max(40).optional(),
  status: z.string().max(40).optional(),
  reason: z.string().max(1000).optional(),
  cdc35Category: z.string().max(40).nullable().optional(),
  role: z.enum(['answer', 'guard']).optional(),
  category: z.string().max(40).optional(),
  /** Entrée du cas (contexte natif de la fixture, lu par le constructeur de production). */
  context: z.record(z.string(), z.unknown()).nullable().optional(),
  /** Attendus des contrôles serveur existants (`evaluators.ts`). */
  expected: z.record(z.string(), z.unknown()).nullable().optional(),
  oracle: z.unknown().optional(),
  /** Sortie de RÉFÉRENCE vérifiée (facultative) : rejouée en CI et base des tests de mutation. */
  referenceOutput: z.unknown().optional(),
  /** Fixture historique visée (révision d'un cas existant). */
  historicalFixture: z.string().max(400).optional(),
});
export type ImportCase = z.infer<typeof importCaseSchema>;

/** Colonnes du CSV (synonymes français admis, insensibles à la casse et aux accents). */
export const CSV_COLUMNS: Readonly<Record<string, keyof ImportCase | 'pairId' | 'pairSide' | 'pairChanges' | 'discriminant'>> = {
  id: 'id', identifiant: 'id', operation: 'operation', operationcode: 'operation', traitement: 'treatment', treatment: 'treatment',
  description: 'description', contrat: 'contract', contract: 'contract', schema: 'schema', famille_risque: 'riskFamily', risk_family: 'riskFamily',
  niveau: 'difficulty', difficulte: 'difficulty', difficulty: 'difficulty', critique: 'critical', critical: 'critical',
  paire: 'pairId', pair_id: 'pairId', cote: 'pairSide', pair_side: 'pairSide', discriminant_change_decision: 'pairChanges', discriminant_changes_decision: 'pairChanges', discriminant: 'discriminant',
  provenance: 'provenance', pieces: 'sourcePieces', pieces_source: 'sourcePieces', source_pieces: 'sourcePieces', mode_entree: 'inputMode', input_mode: 'inputMode',
  type_test: 'testType', test_type: 'testType', type_evaluation: 'evaluationType', evaluation_type: 'evaluationType', statut: 'status', status: 'status',
  motif: 'reason', reason: 'reason', categorie_cdc35: 'cdc35Category', cdc35_category: 'cdc35Category', role: 'role', categorie: 'category', category: 'category',
  fixture_historique: 'historicalFixture', historical_fixture: 'historicalFixture',
};

export type ImportOutcome = 'IMPORTED' | 'REVISED' | 'UNCHANGED' | 'NOT_CONVERTIBLE';

export interface ImportLine {
  line: number;
  origin: string;
  sourceId: string;
  id: string | null;
  outcome: ImportOutcome;
  status: DeclarableStatus | null;
  /** Statut RÉFÉRENCE_APPROUVÉE fourni et refusé (aucune approbation par import). */
  approvalRefused: boolean;
  causes: string[];
  warnings: string[];
}

export interface ImportReport {
  format: string;
  source: { name: string; sha256: string; files: number };
  at: string;
  by: string;
  manifestVersionBefore: number;
  manifestVersionAfter: number;
  totals: Record<ImportOutcome, number> & { lines: number; approvalRefused: number; stress: number };
  lines: ImportLine[];
}

// ══════════════════════════════════════════════════════════════════════════
// Lecture de la livraison (dossier ou ZIP)
// ══════════════════════════════════════════════════════════════════════════

export interface ImportSource { name: string; files: Map<string, Buffer> }

const normPath = (p: string) => posix.normalize(p.replace(/\\/g, '/')).replace(/^(\.\/)+/, '');

/** Livraison en mémoire depuis un ZIP (racine commune retirée). */
export async function readZipSource(name: string, data: Buffer): Promise<ImportSource> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(data);
  const files = new Map<string, Buffer>();
  for (const [p, f] of Object.entries(zip.files)) {
    if (f.dir || /(^|\/)(__MACOSX|\.DS_Store)/.test(p)) continue;
    files.set(normPath(p), Buffer.from(await f.async('uint8array')));
  }
  return { name, files: stripCommonRoot(files) };
}

/** Livraison depuis un dossier du disque. */
export async function readDirectorySource(dir: string): Promise<ImportSource> {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const files = new Map<string, Buffer>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else files.set(normPath(relative(dir, p)), readFileSync(p));
    }
  };
  walk(dir);
  return { name: basename(dir), files: stripCommonRoot(files) };
}

function stripCommonRoot(files: Map<string, Buffer>): Map<string, Buffer> {
  const tops = new Set([...files.keys()].map((p) => p.split('/')[0]));
  if (tops.size !== 1 || [...files.keys()].some((p) => !p.includes('/'))) return files;
  const root = `${[...tops][0]}/`;
  return new Map([...files.entries()].map(([p, b]) => [p.slice(root.length), b]));
}

/** CSV (RFC 4180, séparateur `,` ou `;`). */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const first = t.split(/\r?\n/)[0] ?? '';
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const colKey = (h: string) => h.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[\s-]+/g, '_');

/** Cas bruts de la livraison, dans l'ordre (ligne, origine). */
export function collectRawCases(src: ImportSource): { items: Array<{ line: number; origin: string; raw: Record<string, unknown>; stress: boolean }>; errors: string[] } {
  const items: Array<{ line: number; origin: string; raw: Record<string, unknown>; stress: boolean }> = [];
  const errors: string[] = [];
  let n = 0;
  const json = (p: string): unknown => JSON.parse(src.files.get(p)!.toString('utf8'));
  const paths = [...src.files.keys()].sort();
  for (const p of paths.filter((x) => /^cases\/[^/]+\.json$/i.test(x) || /^stress\/[^/]+\.json$/i.test(x))) {
    try { items.push({ line: ++n, origin: p, raw: json(p) as Record<string, unknown>, stress: p.startsWith('stress/') }); } catch (e) { errors.push(`${p} : JSON illisible (${(e as Error).message})`); }
  }
  for (const p of paths.filter((x) => /^cases\.json$/i.test(x) || /^stress\.json$/i.test(x))) {
    try {
      const arr = json(p);
      if (!Array.isArray(arr)) { errors.push(`${p} : tableau de cas attendu`); continue; }
      arr.forEach((raw, i) => items.push({ line: ++n, origin: `${p}[${i}]`, raw: raw as Record<string, unknown>, stress: /stress/i.test(p) }));
    } catch (e) { errors.push(`${p} : JSON illisible (${(e as Error).message})`); }
  }
  for (const p of paths.filter((x) => /^(cases|manifest|manifeste|stress)\.csv$/i.test(x))) {
    const rows = parseCsv(src.files.get(p)!.toString('utf8'));
    const header = (rows.shift() ?? []).map(colKey);
    rows.forEach((r, i) => {
      const raw: Record<string, unknown> = {};
      const pair: Record<string, unknown> = {};
      header.forEach((h, k) => {
        const champ = CSV_COLUMNS[h];
        const v = (r[k] ?? '').trim();
        if (!champ || v === '') return;
        if (champ === 'pairId') pair.id = v; else if (champ === 'pairSide') pair.side = v.toUpperCase(); else if (champ === 'pairChanges') pair.discriminantChangesDecision = v; else if (champ === 'discriminant') pair.discriminant = v;
        else if (champ === 'sourcePieces') raw.sourcePieces = v.split(/[;|]/).map((x) => x.trim()).filter(Boolean);
        else raw[champ] = v;
      });
      if (pair.id) raw.pair = pair;
      const id = String(raw.id ?? '');
      for (const [k, dir] of [['context', 'contexts'], ['oracle', 'oracles'], ['referenceOutput', 'outputs'], ['expected', 'expected']] as const) {
        const f = `${dir}/${id}.json`;
        if (id && src.files.has(f)) { try { raw[k] = json(f); } catch (e) { errors.push(`${f} : JSON illisible (${(e as Error).message})`); } }
      }
      items.push({ line: ++n, origin: `${p}:${i + 2}`, raw, stress: /stress/i.test(p) || /stress/i.test(String(raw.category ?? '')) });
    });
  }
  if (!items.length) errors.push('aucun cas trouvé : attendu cases/<id>.json, cases.json, cases.csv ou stress/<id>.json (voir la documentation du format)');
  return { items, errors };
}

// ══════════════════════════════════════════════════════════════════════════
// Conversion
// ══════════════════════════════════════════════════════════════════════════

export interface ConvertDeps {
  /** Variables réelles du cas par le constructeur de production (`liveVariablesFor`). */
  liveVariables: (c: MasterCorpusCase) => Promise<Record<string, unknown> | null>;
  at?: string;
  by?: string;
}

export interface ConversionResult {
  manifest: CorpusManifest;
  /** Fichiers à écrire, relatifs au dépôt. */
  writes: Map<string, Buffer>;
  report: ImportReport;
}

const sanitizeId = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const DEF_DIFF = (v: string | null | undefined) => {
  const k = (v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  return (DIFFICULTIES as readonly string[]).find((d) => k.startsWith(d.slice(0, 5))) as ManifestEntry['difficulty'] ?? (k ? 'INTERMEDIAIRE' : null);
};

/** Convertit la livraison en entrées de manifeste et fixtures natives (sans écrire). */
export async function convertImport(given: ImportSource, manifest: CorpusManifest, deps: ConvertDeps): Promise<ConversionResult> {
  const src: ImportSource = { ...given, files: stripCommonRoot(given.files) };
  const at = deps.at ?? new Date().toISOString();
  const by = deps.by ?? 'importeur-601';
  const { items, errors } = collectRawCases(src);
  const entries = [...manifest.entries];
  const writes = new Map<string, Buffer>();
  const lines: ImportLine[] = [];
  const vus = new Set<string>();
  const allSrc = [...src.files.values()].reduce((h, b) => h.update(b), createHash('sha256')).digest('hex');

  for (const e of errors) lines.push({ line: 0, origin: 'livraison', sourceId: '—', id: null, outcome: 'NOT_CONVERTIBLE', status: null, approvalRefused: false, causes: [e], warnings: [] });

  for (const it of items) {
    const causes: string[] = [];
    const warnings: string[] = [];
    const parsed = importCaseSchema.safeParse(it.raw);
    const sourceId = String((it.raw as { id?: unknown }).id ?? `ligne ${it.line}`);
    if (!parsed.success) {
      lines.push({ line: it.line, origin: it.origin, sourceId, id: null, outcome: 'NOT_CONVERTIBLE', status: null, approvalRefused: false, causes: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'cas'} : ${i.message}`), warnings });
      continue;
    }
    const c = parsed.data;
    const stress = it.stress || /stress|e2e/i.test(c.category ?? '') || parseCaseStatus(c.status) === 'E2E_METIER';
    // Révision d'une fixture historique : par fichier désigné, sinon par identifiant d'origine (unique).
    const hist = c.historicalFixture
      ? entries.find((e) => e.file && (e.file === normPath(c.historicalFixture!) || e.file.endsWith(`/${basename(c.historicalFixture!)}`)))
      : entries.filter((e) => e.sourceCaseId === c.id && e.provenance !== 'ZIP_601' && e.provenance !== 'STRESS_601').length === 1
        ? entries.find((e) => e.sourceCaseId === c.id && e.provenance !== 'ZIP_601' && e.provenance !== 'STRESS_601') : undefined;
    const id = hist?.id ?? sanitizeId(c.id);
    if (!/^[A-Z0-9][A-Z0-9._-]{1,79}$/.test(id)) {
      lines.push({ line: it.line, origin: it.origin, sourceId, id: null, outcome: 'NOT_CONVERTIBLE', status: null, approvalRefused: false, causes: [`identifiant « ${c.id} » inutilisable`], warnings });
      continue;
    }
    if (vus.has(id)) {
      lines.push({ line: it.line, origin: it.origin, sourceId, id, outcome: 'NOT_CONVERTIBLE', status: null, approvalRefused: false, causes: [`identifiant ${id} dupliqué dans la livraison (première occurrence conservée)`], warnings });
      continue;
    }
    vus.add(id);

    // Opération : active, master, rattachée à un traitement (jamais T5).
    const op = c.operation ? AI_OPERATIONS[c.operation] : undefined;
    const treatment = op ? treatmentOfUseCase(op.useCaseCode) : null;
    if (!stress) {
      if (!op) causes.push(`opération « ${c.operation ?? '—'} » inconnue du registre`);
      else if (!op.active || !isMasterOperation(op) || !treatment) causes.push(`opération ${op.operationCode} inactive ou hors traitements T1–T6 (T5 n'est jamais réintroduit)`);
      if (treatment && c.treatment && c.treatment.toUpperCase() !== treatment) causes.push(`traitement ${c.treatment} incohérent avec ${op!.operationCode} (${treatment})`);
    }

    // Statut : jamais approuvé par import.
    const demande = parseCaseStatus(c.status);
    const approvalRefused = demande === 'REFERENCE_APPROUVEE';
    if (approvalRefused) warnings.push('statut RÉFÉRENCE_APPROUVÉE fourni : REFUSÉ (aucune approbation par import) — approbation individuelle au BO requise');
    if (c.status && !demande) warnings.push(`statut « ${c.status} » inconnu : À_COMPLÉTER retenu`);
    let status: DeclarableStatus = stress ? 'E2E_METIER' : c.role === 'guard' ? 'GARDE_SERVEUR'
      : demande && demande !== 'REFERENCE_APPROUVEE' ? demande as DeclarableStatus : 'A_COMPLETER';

    // Oracle.
    let oracle: Oracle | null = null;
    if (c.oracle !== undefined && c.oracle !== null) {
      const o = oracleSchema.safeParse({ version: 1, ...(c.oracle as object) });
      if (o.success) oracle = o.data; else causes.push(`oracle invalide : ${o.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join(' ; ')}`);
    }
    const expected = (oracle?.serverExpected ?? c.expected ?? null) as Record<string, unknown> | null;
    if (oracle && c.expected && !oracle.serverExpected) oracle = { ...oracle, serverExpected: c.expected };
    if (!oracle && expected && !stress && status !== 'GARDE_SERVEUR') {
      oracle = oracleSchema.parse({ version: 1, serverExpected: expected, notes: 'Oracle minimal issu de l’attendu serveur de la livraison #601 : faits, preuves et décisions à compléter avant approbation.' });
    }
    if (oracle && status === 'GARDE_SERVEUR') { warnings.push('garde serveur : oracle ignoré (jamais une référence de promotion)'); oracle = null; }
    if (!stress && status === 'A_COMPLETER') for (const p of oracleApprovalProblems(oracle)) warnings.push(`approbation impossible en l’état : ${p}`);

    // Pièces sources (copiées, empreinte).
    const pieces: ManifestEntry['sourcePieces'] = [];
    for (const p of c.sourcePieces) {
      const k = normPath(p.startsWith('pieces/') ? p : `pieces/${p}`);
      const b = src.files.get(k) ?? src.files.get(normPath(p));
      if (!b) { causes.push(`pièce source « ${p} » absente de la livraison`); continue; }
      const dest = `${CORPUS_601_DIR}/pieces/${id}/${basename(p)}`;
      writes.set(dest, b);
      pieces.push({ path: dest, mimeType: mimeOf(p), sha256: sha(b) });
    }
    const declaredMode = (INPUT_MODES as readonly string[]).find((m) => m === (c.inputMode ?? '').toUpperCase()) as ManifestEntry['inputMode'] | undefined;
    const inputMode: ManifestEntry['inputMode'] = declaredMode ?? (pieces.some((x) => /^image\/|pdf/.test(x.mimeType)) ? 'FILE' : op?.operationCode.startsWith('t1_') ? 'TEXT' : 'STRUCTURED');
    if (inputMode === 'FILE' && !pieces.length) {
      causes.push('cas multimodal sans fichier réel : non rejouable (jamais vert)');
      if (status === 'A_COMPLETER') status = 'HISTORIQUE';
    }

    // Fixture native (contexte réel construit par le constructeur de production).
    let file: string | null = hist?.file ?? null;
    if (!stress && op && treatment && isMasterOperation(op) && !causes.some((x) => /opération|traitement/.test(x))) {
      if (!c.context) causes.push('contexte d’entrée absent : spécification à convertir (aucune fixture exécutable)');
      else {
        const context = { ...c.context, ...(pieces.length ? { attachments: pieces.map((x) => ({ path: x.path, mimeType: x.mimeType })) } : {}) };
        const candidate: MasterCorpusCase = {
          id, description: c.description, file: `${CORPUS_601_DIR}/${id.toLowerCase()}.json`, operationCode: op.operationCode, masterPromptCode: op.masterPromptCode,
          task: op.task, taskField: op.taskField ?? 'task', outputSchema: op.outputSchema, context, output: c.referenceOutput, expected,
          qualificationRole: status === 'GARDE_SERVEUR' ? 'guard' : 'answer', outputContract: c.contract ?? null,
        };
        const vars = await deps.liveVariables(candidate).catch((e: Error) => { causes.push(`constructeur de production ${op.operationCode} : ${e.message}`); return null; });
        if (!vars) { if (!causes.some((x) => x.startsWith('constructeur'))) causes.push(`contexte non reconstituable par le constructeur de production de ${op.operationCode}`); }
        else if (!hist) {
          file = candidate.file;
          const fixture = {
            case: id, description: c.description || `Cas #601 ${c.id}`,
            qualification: { role: status === 'GARDE_SERVEUR' ? 'guard' : 'answer' },
            context,
            recording: { operationCode: op.operationCode, task: op.task, ...(c.contract ? { outputContract: c.contract } : {}), ...(c.referenceOutput !== undefined ? { output: c.referenceOutput } : {}) },
            ...(expected ? { expected } : {}),
          };
          writes.set(file, Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`));
        }
      }
    }
    if (stress) {
      file = `${CORPUS_601_DIR}/stress/${id.toLowerCase()}.json`;
      writes.set(file, Buffer.from(`${JSON.stringify({ ...it.raw, id, importedAt: at }, null, 2)}\n`));
    }
    const convertible = stress ? true : Boolean(file) && !causes.length;
    if (!convertible && status === 'A_COMPLETER') warnings.push('cas conservé au manifeste (spécification), non exécutable tant que la cause n’est pas levée');

    const base: Omit<ManifestEntry, 'revisions'> = {
      id, sourceCaseId: c.id, file: convertible || hist ? file : null,
      operationCode: op?.operationCode ?? null, treatment: (treatment as ManifestEntry['treatment']) ?? null,
      contract: c.contract ?? hist?.contract ?? null, schema: c.schema ?? op?.outputSchema ?? null,
      riskFamily: c.riskFamily ?? hist?.riskFamily ?? null, difficulty: DEF_DIFF(c.difficulty) ?? hist?.difficulty ?? null,
      critical: status === 'GARDE_SERVEUR' || stress ? false : c.critical ?? hist?.critical ?? true,
      pair: c.pair ? { id: c.pair.id, side: c.pair.side, discriminantChangesDecision: c.pair.discriminantChangesDecision, discriminant: c.pair.discriminant ?? null } : hist?.pair ?? null,
      provenance: stress ? 'STRESS_601' : hist ? hist.provenance : 'ZIP_601', sourcePieces: pieces.length ? pieces : hist?.sourcePieces ?? [], inputMode,
      testType: stress ? 'E2E_METIER' : status === 'GARDE_SERVEUR' ? 'GARDE_SERVEUR' : c.pair ? 'PAIRE_ADVERSARIALE' : ((TEST_TYPES as readonly string[]).includes(String(c.testType)) ? c.testType as ManifestEntry['testType'] : 'QUALITE_MODELE'),
      evaluationType: stress ? 'E2E' : status === 'GARDE_SERVEUR' ? 'GARDE_SERVEUR' : ((EVALUATION_TYPES as readonly string[]).includes(String(c.evaluationType)) ? c.evaluationType as ManifestEntry['evaluationType'] : 'ORACLE'),
      status, reason: [c.reason ?? (stress ? 'scénario de stress #601 : exécution E2E avec données persistées' : 'cas #601 importé : oracle à vérifier sur les sources puis approuver individuellement'), ...causes].join(' ; ').slice(0, 1000),
      historicalClass: hist?.historicalClass ?? null, cdc35Category: c.cdc35Category ?? hist?.cdc35Category ?? null,
      oracle: oracle ?? hist?.oracle ?? null, expectedSummary: expected ? JSON.stringify(expected).slice(0, 2000) : c.description.slice(0, 2000) || null,
    };
    let outcome: ImportOutcome;
    const i = entries.findIndex((e) => e.id === id);
    if (i >= 0) {
      const { revisions: _r, ...avant } = entries[i];
      void _r;
      const revue = reviseEntry(entries[i], base, by, `import #601 (${src.name}, ligne ${it.line})`, at);
      outcome = canonicalJson(avant) === canonicalJson({ ...avant, ...base }) || revue === entries[i] ? 'UNCHANGED' : 'REVISED';
      entries[i] = revue;
      if (outcome === 'REVISED' && oracleFingerprint(revue.oracle) !== oracleFingerprint(manifest.entries[i]?.oracle ?? null)) warnings.push('oracle modifié : toute approbation antérieure et les qualifications qui l’utilisaient sont invalidées');
    } else {
      entries.push({ ...base, revisions: [{ revision: 1, at, by, reason: `import #601 (${src.name}, ${it.origin})`, changes: ['*'], oracleFingerprint: oracleFingerprint(base.oracle) }] });
      outcome = 'IMPORTED';
    }
    if (!convertible) outcome = 'NOT_CONVERTIBLE';
    lines.push({ line: it.line, origin: it.origin, sourceId: c.id, id, outcome, status, approvalRefused, causes, warnings });
  }

  const changed = lines.some((l) => l.id && l.outcome !== 'UNCHANGED');
  const out: CorpusManifest = {
    version: manifest.version + (changed ? 1 : 0),
    generatedAt: changed ? at : manifest.generatedAt,
    reference: { ...manifest.reference, zipReceived: true },
    entries,
    ledger: [...new Set([...manifest.ledger, ...entries.map((e) => e.id)])],
  };
  const totals = { IMPORTED: 0, REVISED: 0, UNCHANGED: 0, NOT_CONVERTIBLE: 0, lines: lines.length, approvalRefused: lines.filter((l) => l.approvalRefused).length, stress: items.filter((x) => x.stress).length };
  for (const l of lines) totals[l.outcome] += 1;
  const report: ImportReport = {
    format: IMPORT_FORMAT_VERSION, source: { name: src.name, sha256: allSrc, files: src.files.size }, at, by,
    manifestVersionBefore: manifest.version, manifestVersionAfter: out.version, totals, lines,
  };
  return { manifest: out, writes, report };
}

function mimeOf(p: string): string {
  const e = p.toLowerCase().split('.').pop() ?? '';
  return ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', txt: 'text/plain', html: 'text/html', htm: 'text/html', json: 'application/json', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } as Record<string, string>)[e] ?? 'application/octet-stream';
}

/** Rapport d'import lisible (une ligne par cas). */
export function importReportText(r: ImportReport): string {
  const L = [
    `Import du corpus #601 — ${r.source.name} (${r.source.files} fichier(s), SHA-256 ${r.source.sha256.slice(0, 16)}…) — ${r.at}`,
    `Manifeste v${r.manifestVersionBefore} → v${r.manifestVersionAfter}. Lignes : ${r.totals.lines} · importés ${r.totals.IMPORTED} · révisés ${r.totals.REVISED} · inchangés ${r.totals.UNCHANGED} · NON CONVERTIBLES ${r.totals.NOT_CONVERTIBLE} · approbations refusées ${r.totals.approvalRefused} · stress ${r.totals.stress}.`,
    'Aucun cas n’est approuvé par l’import : chaque référence s’approuve individuellement au BO.',
    '',
  ];
  for (const l of r.lines) {
    L.push(`${String(l.line).padStart(4)} ${l.outcome.padEnd(15)} ${(l.id ?? '—').padEnd(32)} ${l.status ?? '—'}${l.approvalRefused ? ' [approbation refusée]' : ''}${l.causes.length ? ` — cause : ${l.causes.join(' ; ')}` : ''}${l.warnings.length ? ` — note : ${l.warnings.join(' ; ')}` : ''}`);
  }
  return `${L.join('\n')}\n`;
}
