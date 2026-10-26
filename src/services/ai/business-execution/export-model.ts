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
 */
import type { BusinessExecutionDto } from './dto';
import type { BusinessOutcome, BusinessTreatment } from './types';

export const EXECUTIONS_EXPORT_SCHEMA = 'verebona.ai-executions-export/1';
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
/** Taille compressée maximale d'un volume ZIP (sous la limite de 4 Gio du format sans ZIP64). */
const EXPORT_VOLUME_MAX_BYTES = 1024 ** 3;
/** Durée de conservation des fichiers stockés (même règle que l'export de recette). */
export const EXPORT_RETENTION_DAYS = 30;

export type ExportFileStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED';

export interface ExportFile {
  path: string;
  kind: 'executions' | 'appels' | 'documentation';
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
}

export const emptyTotals = (): ExportTotals => ({
  executions: { expected: 0, exported: 0 }, calls: { expected: 0, exported: 0 }, byOutcome: {}, byTreatment: {}, cards: { failed: 0, incomplete: 0 }, nonFinal: 0,
});

/** Périmètre figé d'une génération (paramètres du journal + instants résolus). */
export interface ExportPerimeter {
  params: Record<string, string>;
  from: string;
  to: string;
  rule: string;
  timeZone: 'Europe/Paris';
  treatment: BusinessTreatment | null;
  outcome: BusinessOutcome | null;
  nature: 'BUSINESS' | 'TECHNICAL' | null;
  origin: string | null;
  accountId: number | null;
  sensitiveContent: boolean;
  fingerprint: string;
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

export const partPath = (kind: 'executions' | 'appels', part: number): string => `${kind}/${kind}.part-${String(part).padStart(4, '0')}.jsonl.gz`;

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

export interface ExportVolume { index: number; files: string[]; compressedBytes: number }

/**
 * Volumes ZIP (fractionnement, pur) : les parties, dans l'ordre, chacune
 * ENTIÈRE (ses exécutions et leurs appels ensemble), regroupées sans
 * dépasser `maxBytes` compressés (une partie plus grosse forme seule son
 * volume). Chaque volume embarque aussi le manifeste et le LISEZMOI (index
 * commun).
 */
export function planVolumes(files: readonly Pick<ExportFile, 'path' | 'kind' | 'part' | 'compressedBytes' | 'bytes' | 'sha256'>[], maxBytes = EXPORT_VOLUME_MAX_BYTES): ExportVolume[] {
  const parts = new Map<number, { paths: string[]; size: number }>();
  for (const f of files) {
    if (f.kind === 'documentation' || f.sha256 === null || f.part === null) continue;
    const p = parts.get(f.part) ?? { paths: [], size: 0 };
    p.paths.push(f.path);
    p.size += f.compressedBytes ?? f.bytes;
    parts.set(f.part, p);
  }
  const out: ExportVolume[] = [];
  let cur: ExportVolume | null = null;
  for (const [, p] of [...parts.entries()].sort(([a], [b]) => a - b)) {
    if (!cur || (cur.files.length > 0 && cur.compressedBytes + p.size > maxBytes)) {
      cur = { index: out.length + 1, files: [], compressedBytes: 0 };
      out.push(cur);
    }
    cur.files.push(...p.paths.sort());
    cur.compressedBytes += p.size;
  }
  return out;
}

/** Statut global (pur) : COMPLETE seulement si tout est écrit, attendu = exporté, sans lecture partielle. */
export function exportStatus(s: Pick<ExportResumeState, 'files' | 'totals' | 'partial' | 'done'>): ExportFileStatus {
  if (!s.done) return 'FAILED';
  if (s.files.some((f) => f.status === 'FAILED')) return s.totals.executions.exported > 0 ? 'PARTIAL' : 'FAILED';
  if (s.partial || s.files.some((f) => f.status !== 'COMPLETE')) return 'PARTIAL';
  if (s.totals.executions.exported !== s.totals.executions.expected || s.totals.calls.exported !== s.totals.calls.expected) return 'PARTIAL';
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
  period: { from: string; to: string; readAt: string; effectiveTo: string; rule: string; timeZone: string; note: string };
  sessions: ExportResumeState['sessions'];
  resumes: ExportResumeState['resumes'];
  files: ExportFile[];
  volumes: ExportVolume[];
  totals: ExportTotals;
  status: ExportFileStatus;
  warnings: string[];
  absent: string[];
  masking: string[];
}

export function buildManifest(
  generationId: string, st: ExportResumeState, extra: { generatedAt: string; finishedAt: string; environment: string; build: { version: string | null; commit: string | null }; volumeMaxBytes?: number },
): ExecutionsManifest {
  const end = readEnd(st.perimeter, st.readAt);
  return {
    schema: EXECUTIONS_EXPORT_SCHEMA, generationId, generatedAt: extra.generatedAt, finishedAt: extra.finishedAt, environment: extra.environment, build: extra.build,
    perimeter: st.perimeter,
    period: {
      from: st.perimeter.from, to: st.perimeter.to, readAt: st.readAt, effectiveTo: end.toISOString(), rule: st.perimeter.rule, timeZone: 'Europe/Paris',
      note: 'Exécutions dont la date de référence (fin si finale, sinon dernière activité) est dans [from, effectiveTo[ — effectiveTo = min(to, readAt) : '
        + 'une exécution apparue ou terminée après le lancement n’entre pas, même après une reprise. Issue lue à l’instant de lecture de chaque tranche ; '
        + 'les exécutions non finales sont signalées (final = false, enCours).',
    },
    sessions: st.sessions, resumes: st.resumes, files: st.files, volumes: planVolumes(st.files, extra.volumeMaxBytes), totals: st.totals,
    status: exportStatus(st), warnings: st.warnings,
    absent: [
      'Documents originaux et texte intégral des documents : jamais exportés (sécurité).',
      'Échanges des appels antérieurs à la capture (lot 82C) : non conservés historiquement, jamais reconstitués.',
      ...(st.perimeter.sensitiveContent ? [] : ['Contenu des échanges IA : masqué (longueur + SHA-256) — export sans contenus sensibles.']),
    ],
    masking: [...EXPORT_MASKING_NOTES],
  };
}

export function exportReadme(m: ExecutionsManifest): string {
  const L = [
    'VEREBONA — EXPORT DES EXÉCUTIONS IA (Exécutions & logs)',
    '',
    `Génération        : ${m.generationId}`,
    `Lancée le         : ${m.generatedAt} — terminée le ${m.finishedAt}`,
    `Statut            : ${m.status} — ${m.totals.executions.exported} exécution(s) exportée(s) sur ${m.totals.executions.expected} attendue(s), `
      + `${m.totals.calls.exported} appel(s) sur ${m.totals.calls.expected}`,
    `Période           : [${m.period.from} ; ${m.period.effectiveTo}[ (UTC), jours saisis en Europe/Paris — lecture figée à ${m.period.readAt}`,
    `Filtres           : ${Object.entries(m.perimeter.params).map(([k, v]) => `${k}=${v}`).join(' ; ') || 'aucun'}`,
    `Contenus sensibles: ${m.perimeter.sensitiveContent ? 'INCLUS (administrateur habilité)' : 'masqués (longueur + SHA-256)'}`,
    `Cartes            : ${m.totals.cards.failed} échec(s), ${m.totals.cards.incomplete} incomplète(s) (exécutions métier du périmètre)`,
    `Reprises          : ${m.resumes.length}`,
    '',
    'FICHIERS',
    '  manifeste.json   écrit EN DERNIER : index commun (filtres, bornes, fichiers, attendu / exporté, SHA-256 du contenu décompressé, volumes ZIP).',
    '  executions/…     une ligne JSON par exécution (identifiant stable, issue, résultat natif, cause, nature, origine, dates, corrélations).',
    '  appels/…         une ligne JSON par appel IA de ces exécutions (businessExecutionId), état de capture et, si autorisé, contenu de l’échange.',
    '',
    'CONTRÔLER LA COMPLÉTUDE',
    '  status = COMPLETE ; pour chaque fichier, nombre de lignes du fichier décompressé = exported = expected ; SHA-256 du contenu décompressé = sha256.',
    '  Les volumes ZIP contiennent des parties entières : l’union des volumes = la liste des fichiers du manifeste.',
    '',
    'MASQUAGE',
    ...m.masking.map((x) => `  - ${x}`),
    '',
    'DONNÉES ABSENTES',
    ...m.absent.map((x) => `  - ${x}`),
  ];
  if (m.warnings.length) L.push('', 'AVERTISSEMENTS', ...m.warnings.map((x) => `  - ${x}`));
  return `${L.join('\n')}\n`;
}
