/**
 * Exports des exécutions IA — formats, manifeste, découpage, reprise. PUR
 * (lot 84D, CDC Pilotage IA V2 P3 : EXP-01 à EXP-05, R27, R28, R63, R64).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FORMATS (stables, versionnés — EXP-05)
 *
 *   Unitaire  `verebona.ai-business-execution/1` : un JSON structuré (une
 *             exécution, tous ses appels, captures, travaux, rapports).
 *   Groupé / volumineux `verebona.ai-executions-export/1`, généré en tâche
 *             de fond et STOCKÉ (même stockage, même envoi compressé que
 *             l'export de recette 82E) :
 *     executions/executions.part-NNNN.jsonl.gz  une ligne JSON = une
 *             exécution (qualification, résultat natif, cause, nature,
 *             origine, dates, identifiants de corrélation, synthèse des appels) ;
 *     appels/appels.part-NNNN.jsonl.gz          une ligne JSON = un appel
 *             (colonnes du collecteur 77C, état de capture ; contenu de
 *             l'échange seulement sur demande d'un administrateur habilité) ;
 *     LISEZMOI.txt ; manifeste.json EN DERNIER (index commun : filtres,
 *             bornes, fuseau, instant de lecture, fichiers, nombres attendus
 *             et exportés, SHA-256, masquages, données absentes, volumes ZIP).
 *   Téléchargement : chaque fichier (JSONL compressé) ou un VOLUME ZIP
 *   (fractionnement : chaque volume contient des parties entières, le
 *   manifeste et le LISEZMOI — index commun à tous les volumes).
 *
 * PÉRIMÈTRE STABLE ET REPRISE (EXP-04, R28, R64)
 *
 *   · instant de lecture `readAt` FIXÉ au lancement : une exécution n'est
 *     exportée que si sa date de référence est dans [from, min(to, readAt)[ —
 *     une exécution apparue ou terminée APRÈS le lancement n'entre jamais,
 *     même lors d'une reprise : ni doublon, ni ajout silencieux ;
 *   · lecture par TRANCHES de temps successives, dans l'ordre (curseur =
 *     début de la tranche suivante) ; une tranche dont la lecture atteint le
 *     plafond de la projection est COUPÉE en deux, jusqu'à une minute — au-delà
 *     l'export est PARTIEL et le dit (jamais une coupe silencieuse, R63) ;
 *   · point de reprise écrit à chaque partie close (curseur, parties, totaux) :
 *     une génération interrompue reprend après la dernière partie écrite.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CARTE #802 — EXPORT DIAGNOSTIC : UN SEUL ZIP COMPLET ET VÉRIFIABLE, OU UN
 * BLOCAGE EXPLICITE (format `verebona.ai-executions-export/2`)
 *
 *   · les VOLUMES ZIP et le téléchargement fichier par fichier sont
 *     REMPLACÉS : la génération assemble UNE archive (`archive/…zip`),
 *     stockée, relue et vérifiée avant d'être proposée ; sans elle, rien
 *     n'est téléchargeable. Les fichiers intermédiaires (parties) sont purgés
 *     après vérification — ou à l'échec ;
 *   · contenu de l'archive : `index.csv` (une ligne par exécution et par
 *     appel technique autonome : fichier et ligne), `manifest.json`,
 *     `LISEZMOI.txt`, `executions/…jsonl` (fiche), `appels/…jsonl` (appels et
 *     échanges), `diagnostics/…jsonl` (travaux, rapports, écritures, ce qui
 *     manque — la profondeur de l'export unitaire, produite par le MÊME
 *     collecteur), `appels-autonomes/…jsonl` (sondes, qualification, tests :
 *     jamais présentés comme des exécutions métier) ;
 *   · statut de livraison : COMPLETE ou rien. Une lecture partielle, un
 *     plafond de projection, une source illisible, un doublon, un écart
 *     attendu / exporté ou une limite technique (`export-settings.ts`)
 *     arrêtent la génération : artefacts purgés, échec explicite, aucun ZIP.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { BusinessExecutionDto } from './dto';
import type { ExportScope } from './export-selection';
import type { ExecutionsExportLimits } from './export-settings';
import type { BusinessOutcome, BusinessTreatment } from './types';

/** /2 (carte #802) : archive unique, index CSV, diagnostics, appels autonomes ; plus de volumes. */
export const EXECUTIONS_EXPORT_SCHEMA = 'verebona.ai-executions-export/2';
export const EXECUTION_UNIT_SCHEMA = 'verebona.ai-business-execution/1';
export const EXECUTIONS_EXPORT_PREFIX = 'admin-exports/ia-executions/';
export const executionsExportPrefix = (generationId: string): string => `${EXECUTIONS_EXPORT_PREFIX}${generationId}/`;

/** Exécutions par partie (cible : une partie est close à la fin de la tranche qui l'atteint). */
const EXPORT_PART_ROWS = 20_000;
/** Largeur d'une tranche de lecture. */
const EXPORT_SLICE_MS = 24 * 3600_000;
/** Tranche minimale : en dessous, un dépassement du plafond de lecture rend l'export PARTIEL (signalé). */
export const EXPORT_MIN_SLICE_MS = 60_000;
/** Exécutions par lot de lecture des appels. */
export const EXPORT_CALL_BATCH = 200;
/** Appels autonomes ou groupes d'exécutions par lot de lecture (périmètre « appels », appels autonomes). */
export const EXPORT_AUTONOMOUS_BATCH = 500;
/** Durée de conservation des fichiers stockés (même règle que l'export de recette). */
export const EXPORT_RETENTION_DAYS = 30;

export type ExportFileStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED';

export type ExportFileKind = 'executions' | 'appels' | 'diagnostics' | 'autonomes' | 'index' | 'documentation';

export interface ExportFile {
  path: string;
  kind: ExportFileKind;
  part: number | null;
  /** Lignes attendues (projection / décompte dans l'instantané) ; null : document. */
  expected: number | null;
  exported: number;
  /** Octets et SHA-256 du contenu NON compressé. */
  bytes: number;
  compressedBytes: number | null;
  sha256: string | null;
  status: ExportFileStatus;
}

export interface ExportTotals {
  executions: { expected: number; exported: number };
  calls: { expected: number; exported: number };
  byOutcome: Partial<Record<BusinessOutcome, number>>;
  byTreatment: Partial<Record<BusinessTreatment, number>>;
  /** Mêmes nombres que les cartes pour le même périmètre (exécutions métier). */
  cards: { failed: number; incomplete: number };
  /** Exécutions non finales au moment de la lecture (signalées « en cours »). */
  nonFinal: number;
  /** Carte #802 : appels techniques autonomes (sans exécution) — jamais comptés comme des exécutions. */
  autonomousCalls?: { expected: number; exported: number };
  /** Carte #802 (périmètre « appels ») : appels des exécutions exportées HORS filtre — non exportés, comptés. */
  callsOutsideFilter?: number;
  /** Carte #802 : appels rattachés à une exécution exportée mais portés par un autre compte que celui filtré — non exportés, comptés. */
  callsOtherAccount?: number;
}

export const emptyTotals = (): ExportTotals => ({
  executions: { expected: 0, exported: 0 }, calls: { expected: 0, exported: 0 }, byOutcome: {}, byTreatment: {}, cards: { failed: 0, incomplete: 0 }, nonFinal: 0,
  autonomousCalls: { expected: 0, exported: 0 }, callsOutsideFilter: 0,
});

/** Périmètre figé d'une génération (paramètres du journal + instants résolus). */
export interface ExportPerimeter {
  params: Record<string, string>;
  from: string;
  to: string;
  rule: string;
  /** Fuseau des jours saisis : Paris pour le journal des exécutions ; UTC pour l'onglet « Appels modèles » (carte #802). */
  timeZone: 'Europe/Paris' | 'UTC';
  treatment: BusinessTreatment | null;
  outcome: BusinessOutcome | null;
  nature: 'BUSINESS' | 'TECHNICAL' | null;
  origin: string | null;
  accountId: number | null;
  sensitiveContent: boolean;
  fingerprint: string;
  /** Carte #802 : périmètre de l'écran (absent : `executions`, générations antérieures). */
  scope?: ExportScope;
}

/** Carte #802 : précontrôle retenu au lancement (rappelé au manifeste). */
export interface ExportPrecheckSummary {
  at: string;
  executions: number;
  calls: number;
  autonomousCalls: number;
  estimatedRawBytes: number;
}

/** Carte #802 : donnée du périmètre non livrée — toujours motivée, jamais silencieuse. */
export interface ExportOmission {
  what: string;
  /** INEXISTANT : la donnée n'existe pas (ou plus) ; NON_EXPORTE : elle existe, hors contrat ; MASQUE : présente, contenu masqué ; NON_APPLICABLE : sans objet pour cette sélection. */
  status: 'INEXISTANT' | 'NON_EXPORTE' | 'MASQUE' | 'NON_APPLICABLE';
  reason: string;
  count?: number | null;
}

/** Carte #802 : archive unique stockée (clé, taille et empreinte connues après assemblage et vérification). */
export interface ExportArchive {
  fileName: string;
  key: string;
  bytes: number;
  sha256: string;
  entries: number;
  zip64: boolean;
  verifiedAt: string;
}

/** Carte #802 : échec définitif (limite, complétude) — la génération n'est pas reprenable. */
export interface ExportFailure {
  code: string;
  message: string;
  at: string;
}

/** Point de reprise (`admin_export_generations.resume_state`). */
export interface ExportResumeState {
  version: 1;
  perimeter: ExportPerimeter;
  readAt: string;
  /** Début de la prochaine tranche à lire. */
  cursorAt: string;
  sliceMs: number;
  partRows: number;
  /** Numéro de la prochaine partie. */
  nextPart: number;
  files: ExportFile[];
  totals: ExportTotals;
  warnings: string[];
  sessions: Array<{ at: string; snapshot: string | null; fromCursor: string }>;
  resumes: Array<{ at: string; adminUserId: number; fromCursor: string }>;
  /** Plafond de lecture atteint sur une tranche minimale ou traitement illisible : export PARTIEL. */
  partial: boolean;
  done: boolean;
  // ── Carte #802 (facultatifs : états antérieurs lisibles) ───────────────────
  /** Octets écrits avant compression (parties closes). */
  rawBytes?: number;
  /** Octets compressés écrits (parties closes). */
  compressedBytes?: number;
  /** Périmètre « appels » : dernier groupe d'exécutions écrit (plus petit identifiant d'appel du groupe) ; exécutions terminées ? */
  callCursor?: { after: number; done: boolean };
  /** Appels autonomes : dernier identifiant écrit ; phase terminée ? */
  autonomousCursor?: { after: number; done: boolean };
  /** Appels de gouvernance rattachés par leur trace à une exécution exportée : jamais réexportés comme « autonomes ». */
  traceAttachedGovernanceIds?: number[];
  /** Filtres d'appels (périmètre « appels »), tels que la route de la liste les lit. */
  callParams?: Record<string, string>;
  precontrol?: ExportPrecheckSummary | null;
  limits?: ExecutionsExportLimits;
  omissions?: ExportOmission[];
  archive?: ExportArchive | null;
  failure?: ExportFailure | null;
}

export function initialResumeState(perimeter: ExportPerimeter, readAt: Date, opts: { sliceMs?: number; partRows?: number } = {}): ExportResumeState {
  return {
    version: 1, perimeter, readAt: readAt.toISOString(), cursorAt: perimeter.from, sliceMs: Math.max(EXPORT_MIN_SLICE_MS, opts.sliceMs ?? EXPORT_SLICE_MS),
    partRows: Math.max(1, opts.partRows ?? EXPORT_PART_ROWS), nextPart: 1, files: [], totals: emptyTotals(), warnings: [], sessions: [], resumes: [],
    partial: false, done: false,
  };
}

/** Fin effective de lecture : jamais au-delà de l'instant de lecture figé. */
export function readEnd(p: Pick<ExportPerimeter, 'to'>, readAt: string): Date {
  return new Date(Math.min(Date.parse(p.to), Date.parse(readAt)));
}

/** Tranche suivante [début, fin[ (pur). */
export function sliceAt(cursor: Date, end: Date, widthMs: number): { from: Date; to: Date } {
  return { from: cursor, to: new Date(Math.min(end.getTime(), cursor.getTime() + Math.max(1, widthMs))) };
}

export const partPath = (kind: 'executions' | 'appels' | 'diagnostics', part: number): string => `${kind}/${kind}.part-${String(part).padStart(4, '0')}.jsonl.gz`;
/** Carte #802 : appels techniques autonomes (stockés compressés). */
export const autonomousPath = (part: number): string => `appels-autonomes/appels-autonomes.part-${String(part).padStart(4, '0')}.jsonl.gz`;
/** Carte #802 : fragment d'index d'une partie (fusionné en `index.csv` à l'assemblage). */
export const indexPartPath = (part: number): string => `index/index.part-${String(part).padStart(4, '0')}.csv.gz`;

// ══════════════════════════════════════════════════════════════════════════
// Carte #802 — index CSV (une ligne par exécution et par appel autonome)
// ══════════════════════════════════════════════════════════════════════════

export const INDEX_COLUMNS = [
  'type', 'identifiant', 'traitement', 'mode', 'nature', 'issue', 'origine', 'compte', 'objet_type', 'objet_id', 'date_reference',
  'appels', 'fichier', 'ligne', 'fichier_diagnostics', 'fichier_appels', 'premiere_ligne_appels',
] as const;
export const INDEX_SEPARATOR = ';';
export const INDEX_HEADER = INDEX_COLUMNS.join(INDEX_SEPARATOR);

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Chemin d'un fichier DANS l'archive (le stockage garde `.gz`, l'archive le contenu). */
export const zipPathOf = (storedPath: string): string => storedPath.replace(/\.gz$/, '');

/** Ligne d'index d'une exécution (pur). */
export function indexRowOfExecution(x: BusinessExecutionDto, at: { file: string; line: number; diagnostics: string; callsFile: string; firstCallLine: number | null; calls: number }): string {
  return [
    'EXECUTION', x.id, x.treatment, x.mode, x.nature, x.outcome, x.origin, x.accountId, x.objectType, x.objectId, x.referenceAt,
    at.calls, zipPathOf(at.file), at.line, zipPathOf(at.diagnostics), at.calls ? zipPathOf(at.callsFile) : '', at.firstCallLine,
  ].map(csvCell).join(INDEX_SEPARATOR);
}

/** Ligne d'index d'un appel technique autonome (pur) : jamais une exécution. */
export function indexRowOfAutonomousCall(c: { id: number; classe: string; accountId: number | null; createdAt: string | null; operationCode: string | null }, at: { file: string; line: number }): string {
  return [
    'APPEL_AUTONOME', `appel:${c.id}`, '', c.operationCode, c.classe, '', '', c.accountId, '', '', c.createdAt,
    1, zipPathOf(at.file), at.line, '', '', '',
  ].map(csvCell).join(INDEX_SEPARATOR);
}

/** Lecture d'un index CSV produit ici (pur) : cellules d'une ligne. */
export function parseIndexRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === INDEX_SEPARATOR) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Accumulation d'une exécution exportée dans les totaux (pur). */
export function addToTotals(t: ExportTotals, x: Pick<BusinessExecutionDto, 'outcome' | 'treatment' | 'nature'>): void {
  t.byOutcome[x.outcome] = (t.byOutcome[x.outcome] ?? 0) + 1;
  t.byTreatment[x.treatment] = (t.byTreatment[x.treatment] ?? 0) + 1;
  if (x.nature === 'BUSINESS' && x.outcome === 'FAILED') t.cards.failed++;
  if (x.nature === 'BUSINESS' && x.outcome === 'INCOMPLETE') t.cards.incomplete++;
  if (x.outcome === 'NOT_FINAL') t.nonFinal++;
}

/** Ligne d'exécution (pur) : la forme du journal, plus le caractère final explicite (EXP-04). */
export function executionLine(x: BusinessExecutionDto): Record<string, unknown> {
  return { ...x, final: x.outcome !== 'NOT_FINAL', enCours: x.outcome === 'NOT_FINAL' ? (x.progress ?? 'PENDING') : null };
}

/**
 * Règle remplacée (carte #802) : plus de volumes ZIP. Entrées de l'archive
 * UNIQUE (pur) : `index.csv`, `manifest.json` et `LISEZMOI.txt` en tête
 * (lecture humaine), puis les fichiers de données dans l'ordre des parties —
 * chacun une seule fois.
 */
export interface ArchivePlanEntry { path: string; storedPath: string; bytes: number; compressedBytes: number; sha256: string | null }

export const ARCHIVE_INDEX = 'index.csv';
export const ARCHIVE_MANIFEST = 'manifest.json';
export const ARCHIVE_README = 'LISEZMOI.txt';
/** Dossier de stockage des trois documents de tête (compressés pour la copie sans recompression). */
export const ARCHIVE_DOC_DIR = 'zip/';

export function planArchive(
  files: readonly Pick<ExportFile, 'path' | 'kind' | 'part' | 'compressedBytes' | 'bytes' | 'sha256'>[],
  docs: readonly ArchivePlanEntry[],
): ArchivePlanEntry[] {
  const order = (p: string) => (p === ARCHIVE_INDEX ? 0 : p === ARCHIVE_MANIFEST ? 1 : p === ARCHIVE_README ? 2 : 3);
  const kindOrder: Record<string, number> = { executions: 0, appels: 1, diagnostics: 2, autonomes: 3 };
  const data = files
    .filter((f) => f.kind in kindOrder && f.sha256 !== null && f.part !== null && f.compressedBytes !== null)
    .slice()
    .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || (a.part ?? 0) - (b.part ?? 0))
    .map((f) => ({ path: zipPathOf(f.path), storedPath: f.path, bytes: f.bytes, compressedBytes: f.compressedBytes as number, sha256: f.sha256 }));
  const head = docs.slice().sort((a, b) => order(a.path) - order(b.path));
  const seen = new Set<string>();
  return [...head, ...data].filter((e) => (seen.has(e.path) ? false : (seen.add(e.path), true)));
}

/** Nom du fichier remis à l'administrateur. */
export const archiveFileName = (generationId: string): string => `verebona-diagnostic-executions-ia-${generationId.slice(0, 8)}.zip`;

/** Statut global (pur) : COMPLETE seulement si tout est écrit, attendu = exporté, sans lecture partielle. */
export function exportStatus(s: Pick<ExportResumeState, 'files' | 'totals' | 'partial' | 'done'>): ExportFileStatus {
  if (!s.done) return 'FAILED';
  if (s.files.some((f) => f.status === 'FAILED')) return s.totals.executions.exported > 0 ? 'PARTIAL' : 'FAILED';
  if (s.partial || s.files.some((f) => f.status !== 'COMPLETE')) return 'PARTIAL';
  if (s.totals.executions.exported !== s.totals.executions.expected || s.totals.calls.exported !== s.totals.calls.expected) return 'PARTIAL';
  if (s.totals.autonomousCalls && s.totals.autonomousCalls.exported !== s.totals.autonomousCalls.expected) return 'PARTIAL';
  return 'COMPLETE';
}

const EXPORT_MASKING_NOTES: readonly string[] = [
  'Identifiants (exécution, travail, rapport, trace, appel, compte, objet) : jamais masqués — corrélation et comparaison avant / après.',
  'Secrets et jetons : jamais exportés (liste blanche de colonnes du collecteur 77C, motifs de secret masqués dans les textes).',
  'E-mails : pseudonyme stable ; identité, téléphone, adresse, n° de contrat : marqueur de masquage.',
  'Échanges IA (prompt final, contexte, variables, messages, paramètres, réponse brute, sortie parsée) : {"$etat":"masque","longueur":N,"sha256":…} — '
    + 'intégraux seulement si l’export a été demandé « avec contenus sensibles » par un administrateur habilité (AI_MODEL_OUTPUT_ADMIN_IDS), demande journalisée.',
  'Contenu non capturé (appel antérieur à la capture, échec de capture) : {"$etat":"absent","motif":…} — jamais reconstitué, aucun appel IA relancé (LOG-08).',
  'Un marqueur n’est jamais confondu avec NULL : NULL en base = null JSON.',
];

export interface ExecutionsManifest {
  schema: typeof EXECUTIONS_EXPORT_SCHEMA;
  generationId: string;
  generatedAt: string;
  finishedAt: string;
  environment: string;
  build: { version: string | null; commit: string | null };
  perimeter: ExportPerimeter;
  /** Carte #802 : sélection exacte (périmètre de l'écran et filtres tels qu'appliqués). */
  selection: { scope: ExportScope; filters: Record<string, string>; sensitiveContent: boolean };
  period: { from: string; to: string; readAt: string; effectiveTo: string; rule: string; timeZone: string; note: string };
  sessions: ExportResumeState['sessions'];
  resumes: ExportResumeState['resumes'];
  /** Fichiers de l'archive (chemins dans le ZIP ; les fichiers intermédiaires du stockage sont purgés après assemblage). Le manifeste ne se liste pas lui-même. */
  files: ExportFile[];
  /** Archive unique : nom remis et chemins de ses entrées (taille et empreinte de l'archive : suivi de la génération). */
  archive: { fileName: string; entries: string[] };
  totals: ExportTotals;
  /** Contrôles de complétude effectués avant livraison (tous satisfaits : sinon aucune archive). */
  completeness: {
    executions: { expected: number; exported: number; indexed: number; uniqueIds: boolean };
    calls: { expected: number; exported: number };
    autonomousCalls: { expected: number; exported: number; indexed: number };
    checks: string[];
  };
  precontrol: ExportPrecheckSummary | null;
  limits: ExecutionsExportLimits | null;
  status: ExportFileStatus;
  warnings: string[];
  /** Données du périmètre non livrées, motivées (inexistant / non exporté / masqué / non applicable). */
  omissions: ExportOmission[];
  absent: string[];
  masking: string[];
}

const scopeOf = (p: ExportPerimeter): ExportScope => p.scope ?? 'executions';

/** Fichier tel qu'il figure au manifeste : chemin DANS l'archive. */
const manifestFile = (f: ExportFile): ExportFile => ({ ...f, path: zipPathOf(f.path) });

export function buildManifest(
  generationId: string, st: ExportResumeState,
  extra: { generatedAt: string; finishedAt: string; environment: string; build: { version: string | null; commit: string | null }; indexed?: { executions: number; autonomousCalls: number; uniqueIds: boolean }; archiveEntries?: string[] },
): ExecutionsManifest {
  const end = readEnd(st.perimeter, st.readAt);
  const scope = scopeOf(st.perimeter);
  const auto = st.totals.autonomousCalls ?? { expected: 0, exported: 0 };
  const indexed = extra.indexed ?? { executions: st.totals.executions.exported, autonomousCalls: auto.exported, uniqueIds: true };
  return {
    schema: EXECUTIONS_EXPORT_SCHEMA, generationId, generatedAt: extra.generatedAt, finishedAt: extra.finishedAt, environment: extra.environment, build: extra.build,
    perimeter: st.perimeter,
    selection: { scope, filters: scope === 'calls' ? (st.callParams ?? {}) : st.perimeter.params, sensitiveContent: st.perimeter.sensitiveContent },
    period: {
      from: st.perimeter.from, to: st.perimeter.to, readAt: st.readAt, effectiveTo: end.toISOString(), rule: st.perimeter.rule, timeZone: st.perimeter.timeZone,
      note: scope === 'calls'
        ? 'Appels dont la date de création est dans la période filtrée à l’écran (jours UTC, fin de journée incluse) et antérieure à l’instant de lecture figé : '
          + 'un appel écrit après le lancement n’entre pas, même après une reprise.'
        : 'Exécutions dont la date de référence (fin si finale, sinon dernière activité) est dans [from, effectiveTo[ — effectiveTo = min(to, readAt) : '
          + 'une exécution apparue ou terminée après le lancement n’entre pas, même après une reprise. Issue lue à l’instant de lecture de chaque tranche ; '
          + 'les exécutions non finales sont signalées (final = false, enCours).',
    },
    sessions: st.sessions, resumes: st.resumes, files: st.files.map(manifestFile),
    archive: { fileName: archiveFileName(generationId), entries: extra.archiveEntries ?? [] },
    totals: st.totals,
    completeness: {
      executions: { ...st.totals.executions, indexed: indexed.executions, uniqueIds: indexed.uniqueIds },
      calls: { ...st.totals.calls },
      autonomousCalls: { ...auto, indexed: indexed.autonomousCalls },
      checks: [
        'exécutions attendues (sélection lue) = exécutions écrites = lignes d’index relues depuis le stockage',
        'identifiants uniques sur l’ensemble de la sélection (index relu)',
        'appels attendus = appels écrits ; appels autonomes attendus = écrits = indexés',
        'aucune tranche plafonnée, aucune source illisible',
        'SHA-256 et taille de chaque fichier relus dans l’archive stockée (entrée décompressée) avant livraison',
      ],
    },
    precontrol: st.precontrol ?? null, limits: st.limits ?? null,
    status: exportStatus(st), warnings: st.warnings,
    omissions: [
      { what: 'Documents originaux et texte intégral des documents', status: 'NON_EXPORTE', reason: 'jamais embarqués (sécurité) ; références et métadonnées de diagnostic conservées' },
      { what: 'Échanges des appels antérieurs à la capture (lot 82C) ou dont la capture a échoué', status: 'INEXISTANT', reason: 'non conservés ; jamais reconstitués — chaque appel porte {"$etat":"absent","motif":…}' },
      ...(st.perimeter.sensitiveContent
        ? []
        : [{ what: 'Contenu des échanges IA', status: 'MASQUE' as const, reason: 'export sans contenus sensibles : longueur et SHA-256 seulement' }]),
      { what: 'Contenu des échanges des comptes opposés à l’amélioration', status: 'MASQUE', reason: 'opposition du compte (lot 102D) : {"$etat":"exclu"}, longueur et SHA-256 seulement, même pour un administrateur habilité' },
      { what: 'Valeurs écrites par les traitements', status: 'NON_EXPORTE', reason: 'métadonnées des écritures seulement (table, champ, résultat, motif) ; valeurs consultables au rapport d’exécution (accès journalisé)' },
      ...(st.omissions ?? []),
    ],
    absent: [
      'Documents originaux et texte intégral des documents : jamais exportés (sécurité).',
      'Échanges des appels antérieurs à la capture (lot 82C) : non conservés historiquement, jamais reconstitués.',
      ...(st.perimeter.sensitiveContent ? [] : ['Contenu des échanges IA : masqué (longueur + SHA-256) — export sans contenus sensibles.']),
    ],
    masking: [...EXPORT_MASKING_NOTES],
  };
}

export function exportReadme(m: ExecutionsManifest): string {
  const auto = m.totals.autonomousCalls ?? { expected: 0, exported: 0 };
  const L = [
    'VEREBONA — EXPORT DIAGNOSTIC COMPLET DES EXÉCUTIONS IA (Exécutions & logs)',
    '',
    `Génération        : ${m.generationId}`,
    `Lancée le         : ${m.generatedAt} — terminée le ${m.finishedAt}`,
    `Environnement     : ${m.environment} — version ${m.build.version ?? 'inconnue'}, commit ${m.build.commit ?? 'inconnu'}`,
    `Statut            : ${m.status} — ${m.totals.executions.exported} exécution(s) exportée(s) sur ${m.totals.executions.expected} attendue(s), `
      + `${m.totals.calls.exported} appel(s) sur ${m.totals.calls.expected}, ${auto.exported} appel(s) technique(s) autonome(s) sur ${auto.expected}`,
    `Périmètre         : ${m.selection.scope === 'calls' ? 'onglet « Appels modèles » (appels filtrés, regroupés par exécution)' : 'journal des exécutions'}`,
    `Période           : [${m.period.from} ; ${m.period.effectiveTo}[ (UTC), jours saisis en ${m.period.timeZone} — lecture figée à ${m.period.readAt}`,
    `Filtres           : ${Object.entries(m.selection.filters).map(([k, v]) => `${k}=${v}`).join(' ; ') || 'aucun'}`,
    `Contenus sensibles: ${m.perimeter.sensitiveContent ? 'INCLUS (administrateur habilité)' : 'masqués (longueur + SHA-256)'}`,
    `Cartes            : ${m.totals.cards.failed} échec(s), ${m.totals.cards.incomplete} incomplète(s) (exécutions métier du périmètre)`,
    `Reprises          : ${m.resumes.length}`,
    '',
    'CONTENU DE L’ARCHIVE (un seul ZIP)',
    '  index.csv            une ligne par exécution et par appel technique autonome : identifiant, traitement, issue, fichier et numéro de ligne.',
    '  manifest.json        périmètre et filtres exacts, environnement, version, instants de lecture et de génération, fichiers (attendu / exporté, SHA-256), omissions motivées.',
    '  LISEZMOI.txt         ce fichier.',
    '  executions/…jsonl    une ligne JSON par exécution (identifiant stable, issue, résultat natif, cause, nature, origine, dates, corrélations).',
    '  appels/…jsonl        une ligne JSON par appel IA de ces exécutions (businessExecutionId), état de capture et, si autorisé, contenu de l’échange.',
    '  diagnostics/…jsonl   une ligne JSON par exécution (executionId) : travaux de file, rapports, écritures, ce qui manque, usage de l’IA —',
    '                       exécution + ses appels + cette ligne = l’export unitaire de l’exécution.',
    '  appels-autonomes/…   appels techniques SANS exécution (sondes, qualification, tests fournisseur, évaluation de prompt) ou non rattachés :',
    '                       jamais comptés comme des exécutions métier.',
    '',
    'CONTRÔLER LA COMPLÉTUDE',
    '  status = COMPLETE (sinon aucune archive n’est livrée) ; nombre de lignes EXECUTION de index.csv = totals.executions.exported = expected ;',
    '  pour chaque fichier listé au manifeste : nombre de lignes = exported = expected ; SHA-256 du fichier extrait = sha256.',
    ...m.completeness.checks.map((x) => `  - ${x}`),
    '',
    'MASQUAGE',
    ...m.masking.map((x) => `  - ${x}`),
    '',
    'OMISSIONS (motivées)',
    ...m.omissions.map((x) => `  - [${x.status}] ${x.what}${x.count !== null && x.count !== undefined ? ` (${x.count})` : ''} : ${x.reason}`),
  ];
  if (m.warnings.length) L.push('', 'AVERTISSEMENTS', ...m.warnings.map((x) => `  - ${x}`));
  return `${L.join('\n')}\n`;
}
