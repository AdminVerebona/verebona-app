/**
 * Rapports lisibles des rattrapages lancés depuis le BO (lot 25, chantier B).
 *
 * PUR (types seulement importés) et testé : à partir du résultat brut d'un
 * service, construit la synthèse affichée — compteurs, cas ambigus,
 * conflits, avertissements, identifiant d'exécution du script (pour la
 * restauration) — et borne le rapport JSON conservé en base et téléchargé.
 */
import type { MergeResult, RestoreResult as RoomsRestoreResult } from '@/services/migration/rooms-merge';
import type { BackfillRunResult } from '@/services/migration/cdc15';
import type { RunSummary } from '@/services/migration/cdc15/report';
import type { RestoreResult as Cdc15RestoreResult } from '@/services/migration/cdc15/backup';
import type { BackfillReport as DalReport } from '@/services/documents/document-asset-links/backfill';
import type { DedupeReport, SourceLinksReport } from '@/services/agenda/backfill/agenda-backfill';
import type { BackfillAction, BackfillScript } from './definitions';

export interface BackfillSummary {
  headline: string;
  /** Identifiant d'exécution du script (`--report` / `--restore <runId>`), s'il en a un. */
  scriptRunId: string | null;
  /** Application restaurable depuis la page (`--restore`). */
  restorable: boolean;
  counters: Array<{ label: string; value: number | string }>;
  ambiguous: { count: number; samples: string[] };
  conflicts: { count: number; samples: string[] };
  warnings: string[];
  /** Rendu texte du script (`--report`), quand il existe. */
  text?: string;
}

/** Échantillons affichés (le rapport JSON complet est téléchargeable). */
export const SAMPLE_LIMIT = 20;
/** Éléments gardés par tableau dans le rapport JSON conservé. */
export const STORED_ARRAY_LIMIT = 2_000;

const echantillon = <T>(xs: readonly T[], f: (x: T) => string): string[] => xs.slice(0, SAMPLE_LIMIT).map(f);

type Raw = Record<string, unknown>;

/** Rapport « brut » d'une exécution : sortie du service + synthèse éventuelle du script. */
export interface RawBackfillOutput {
  result: unknown;
  /** `summarizeRoomsMerge` / `summarizeRun` (simulation, application). */
  scriptSummary?: unknown;
  /** `formatRoomsMergeSummary` / `formatRunSummary`. */
  scriptText?: string;
}

function mergeRooms(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  if (action === 'restore') {
    const r = out.result as RoomsRestoreResult & { runId?: string };
    return {
      headline: `Restauration : ${r.restored} valeur(s) restaurée(s), ${r.deletedSubstructures} sous-structure(s) supprimée(s), ${r.conflicts.length} conflit(s).`,
      scriptRunId: r.runId ?? null,
      restorable: false,
      counters: [
        { label: 'Valeurs restaurées', value: r.restored },
        { label: 'Sous-structures supprimées', value: r.deletedSubstructures },
        { label: 'Conflits (non restaurés)', value: r.conflicts.length },
      ],
      ambiguous: { count: 0, samples: [] },
      conflicts: { count: r.conflicts.length, samples: echantillon(r.conflicts, (c) => `${c.table}#${c.rowId} — ${c.reason}`) },
      warnings: [],
    };
  }
  const r = out.result as MergeResult;
  const s = out.scriptSummary as { byDecision?: Array<{ decision: string; table: string; n: number }>; samples?: Raw[] } | undefined;
  const parDecision = new Map<string, number>();
  for (const d of s?.byDecision ?? []) parDecision.set(d.decision, (parDecision.get(d.decision) ?? 0) + Number(d.n));
  const conflits = r.changes.filter((c) => c.decision === 'CONFLICT');
  const nbConflits = parDecision.get('CONFLICT') ?? conflits.length;
  const ambigus = r.changes.filter((c) => c.decision === 'SUPERSEDED' || (c.reason && c.decision !== 'CONFLICT'));
  return {
    headline: `${r.mode === 'apply' ? 'Application' : 'Simulation'} : ${r.counts.rooms ?? 0} pièce(s) parcourue(s), ${r.counts.failed ?? 0} échec(s).`,
    scriptRunId: r.runId,
    restorable: r.mode === 'apply',
    counters: [
      ...Object.entries(r.counts).map(([k, v]) => ({ label: ROOMS_LABELS[k] ?? k, value: v })),
      ...[...parDecision.entries()].map(([d, n]) => ({ label: `Décision ${d}`, value: n })),
    ],
    ambiguous: {
      count: ambigus.length,
      samples: echantillon(ambigus, (c) => `pièce ${c.roomId} — ${c.decision} ${c.table}#${c.rowId}${c.reason ? ` (${c.reason})` : ''}`),
    },
    conflicts: {
      count: nbConflits,
      samples: echantillon(conflits, (c) => `pièce ${c.roomId} — ${c.table}#${c.rowId} ${c.column}${c.reason ? ` (${c.reason})` : ''}`),
    },
    warnings: [...r.warnings],
    text: out.scriptText,
  };
}

const ROOMS_LABELS: Record<string, string> = {
  rooms: 'Pièces parcourues',
  failed: 'Échecs',
  existing: 'Déjà reprises',
  reenqueued: 'Travaux T3 relancés',
};

function documentAssetLinks(out: RawBackfillOutput): BackfillSummary {
  const r = out.result as DalReport;
  return {
    headline: `Liens créés : ${r.migrationLinksCreated} ; ${r.ambiguous.length} cas ambigu(s) laissé(s) au rapport.`,
    scriptRunId: null,
    restorable: false,
    counters: [
      { label: 'Documents parcourus', value: r.filesScanned },
      { label: 'Propositions parcourues', value: r.proposalsScanned },
      { label: 'Liens « colonnes » avant', value: r.legacyLinksBefore },
      { label: 'Liens « colonnes » après', value: r.legacyLinksAfter },
      { label: 'Liens MIGRATION créés', value: r.migrationLinksCreated },
      { label: 'Dernier document (curseur)', value: r.lastFileId },
      { label: 'Dernière proposition (curseur)', value: r.lastProposalId },
    ],
    ambiguous: {
      count: r.ambiguous.length,
      samples: echantillon(r.ambiguous, (a) => `document ${a.fileId}${a.proposalId ? ` / proposition ${a.proposalId}` : ''} — ${a.reason} : ${a.detail}`),
    },
    conflicts: { count: 0, samples: [] },
    warnings: [],
  };
}

function agenda(step: string | null, out: RawBackfillOutput): BackfillSummary {
  if (step === 'dedupe') {
    const r = out.result as DedupeReport;
    const proteges = r.groups.reduce((n, g) => n + g.protected.length, 0);
    return {
      headline: `Dédoublonnage ${r.applied ? 'appliqué' : '(simulation)'} : ${r.groups.length} groupe(s), ${r.removed.length} élément(s) ${r.applied ? 'retiré(s)' : 'à retirer'}.`,
      scriptRunId: null,
      restorable: false,
      counters: [
        { label: 'Comptes parcourus', value: r.accountsScanned },
        { label: 'Éléments parcourus', value: r.itemsScanned },
        { label: 'Groupes de doublons', value: r.groups.length },
        { label: r.applied ? 'Éléments retirés' : 'Éléments à retirer', value: r.removed.length },
        { label: 'Éléments protégés (modifiés par l’utilisateur)', value: proteges },
        { label: 'Dernier compte (curseur)', value: r.lastAccountId },
      ],
      ambiguous: {
        count: proteges,
        samples: echantillon(r.groups.filter((g) => g.protected.length > 0),
          (g) => `compte ${g.accountId} · bien ${g.assetId} · ${g.date} — protégés ${g.protected.join(', ')}`),
      },
      conflicts: { count: 0, samples: [] },
      warnings: [],
    };
  }
  const r = out.result as SourceLinksReport;
  return {
    headline: `Liens sources ${r.applied ? 'appliqués' : '(simulation)'} : ${r.fileLinksCreated} lien(s) document, ${r.sourceTracesCreated} trace(s), ${r.orphans.length} référence(s) inexploitable(s).`,
    scriptRunId: null,
    restorable: false,
    counters: [
      { label: 'Éléments parcourus', value: r.scanned },
      { label: 'Liens document', value: r.fileLinksCreated },
      { label: 'Traces de source', value: r.sourceTracesCreated },
      { label: 'Références inexploitables', value: r.orphans.length },
      { label: 'Dernier élément (curseur)', value: r.lastItemId },
    ],
    ambiguous: {
      count: r.orphans.length,
      samples: echantillon(r.orphans, (o) => `élément ${o.agendaItemId} (compte ${o.accountId}) → document ${o.originRefId} : ${o.reason}`),
    },
    conflicts: { count: 0, samples: [] },
    warnings: [],
  };
}

function cdc15(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  if (action === 'restore') {
    const r = out.result as Cdc15RestoreResult & { runId?: string };
    return {
      headline: `Restauration : ${r.restored} valeur(s) restaurée(s), ${r.conflicts.length} modifiée(s) depuis (non restaurées).`,
      scriptRunId: r.runId ?? null,
      restorable: false,
      counters: [
        { label: 'Valeurs restaurées', value: r.restored },
        { label: 'Modifiées depuis (non restaurées)', value: r.conflicts.length },
      ],
      ambiguous: { count: 0, samples: [] },
      conflicts: { count: r.conflicts.length, samples: echantillon(r.conflicts, (c) => `${c.targetType}#${c.targetId} — ${c.name}`) },
      warnings: [],
    };
  }
  const r = out.result as BackfillRunResult;
  const s = out.scriptSummary as RunSummary | undefined;
  const tot = { APPLIED: 0, SKIPPED_USER: 0, AMBIGUOUS: 0, NO_CHANGE: 0 } as Record<string, number>;
  for (const x of r.results) for (const [d, n] of Object.entries(x.counts)) tot[d] = (tot[d] ?? 0) + n;
  const cartes = r.results.reduce((n, x) => n + x.cards, 0);
  const ambigus = (s?.samples ?? []).filter((x) => x.decision === 'AMBIGUOUS');
  return {
    headline: `${r.mode === 'apply' ? 'Application' : 'Simulation'} : ${r.results.length} étape(s) — ${tot.APPLIED} ${r.mode === 'apply' ? 'appliquée(s)' : 'à appliquer'}, ${tot.AMBIGUOUS} ambiguë(s).`,
    scriptRunId: r.runId,
    restorable: r.mode === 'apply',
    counters: [
      ...r.results.map((x) => ({
        label: x.step,
        value: x.skipped ? `ignorée (${x.skipped})` : `${x.scanned} parcouru(s)${x.complete ? '' : ' (limite)'} · ${Object.entries(x.counts).map(([d, n]) => `${d} ${n}`).join(', ')}`,
      })),
      { label: 'Total appliqué / à appliquer', value: tot.APPLIED },
      { label: 'Préservé (saisie utilisateur)', value: tot.SKIPPED_USER },
      { label: 'Ambigu', value: tot.AMBIGUOUS },
      { label: 'Sans changement', value: tot.NO_CHANGE },
      { label: 'Cartes « À traiter »', value: cartes },
    ],
    ambiguous: {
      count: tot.AMBIGUOUS,
      samples: echantillon(ambigus, (x) => `${x.step} · compte ${x.accountId ?? '-'} · bien ${x.assetId ?? '-'} · ${x.entityType}#${x.entityId ?? '-'}${x.fieldKey ? ` · ${x.fieldKey}` : ''}${x.reason ? ` — ${x.reason}` : ''}`),
    },
    conflicts: { count: 0, samples: [] },
    warnings: [...r.warnings],
    text: out.scriptText,
  };
}

/** Synthèse lisible d'une exécution terminée (pure). */
export function summarizeBackfill(script: BackfillScript, action: BackfillAction, step: string | null, out: RawBackfillOutput): BackfillSummary {
  switch (script) {
    case 'merge-rooms': return mergeRooms(action, out);
    case 'document-asset-links': return documentAssetLinks(out);
    case 'agenda': return agenda(step, out);
    case 'cdc15': return cdc15(action, out);
  }
}

/**
 * Rapport JSON conservé et téléchargeable : tableaux bornés
 * (`STORED_ARRAY_LIMIT`, signalé par `…tronqué`), dates en ISO.
 */
export function boundReport(value: unknown, limit = STORED_ARRAY_LIMIT, depth = 0): unknown {
  if (depth > 12) return '[profondeur maximale]';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    const garde = value.slice(0, limit).map((v) => boundReport(v, limit, depth + 1));
    if (value.length > limit) garde.push(`… tronqué : ${value.length - limit} élément(s) de plus (rapport complet : tables du script ou CLI).`);
    return garde;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = boundReport(v, limit, depth + 1);
    return out;
  }
  return value;
}

/** Nom de fichier du rapport téléchargé (sans caractère problématique sous Windows). */
export function reportFileName(script: string, action: string, step: string | null, startedAt: string | Date, id: string): string {
  const d = new Date(startedAt);
  const stamp = Number.isNaN(d.getTime()) ? 'date-inconnue' : d.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `rattrapage_${script}${step ? `_${step}` : ''}_${action}_${stamp}_${id.slice(0, 8)}.json`.replace(/[^A-Za-z0-9._-]/g, '_');
}
