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
import type { AssetAccountBackfillReport } from '@/services/assets/asset-account-backfill';
import type { StructuredMigrationReport } from '@/services/business-operations/consolidation/asset-data-consolidator';
import type { CleanupResult, CleanupRestoreReport } from '@/services/business-operations/claims/legacy-cleanup';
import type { FinalizeResult } from '@/services/business-operations/claims/legacy-finalize';
import type { RebuildResult, RebuildRestoreReport } from '@/services/business-operations/rebuild/service';
import { ACCOUNT_STATUS_LABELS, KEEP_REASON_LABELS, type KeepReason } from '@/services/business-operations/rebuild/model';
import type { RemediationReport, RemediationRestoreReport } from '@/services/security/cross-account/remediation';
import type { DataSeparationReport } from '@/services/equipment/data-separation-backfill';
import type { ValidationRepriseReport } from '@/services/documents/validation-reprise';
import type { BackfillAction, BackfillScript } from './definitions';
import type { AddressLinkRepairReport, AddressLinkRestoreReport } from '@/services/documents/document-asset-links/address-link-repair';
import type { DuoSharedAccountReport, RestoreReport as DuoRestoreReport } from '@/services/account/duo-shared-account-backfill';
import type { BackupManifestV2 } from '@/services/backup/database-backup.service';
import type { RestoreReport as DatabaseRestoreReport } from '@/services/backup/database-restore.service';
import type { ReclassificationReport, ReclassificationRestoreReport } from '@/services/ai/history-reclassification/service';
import type { PropertyRepriseReport } from '@/services/ai/source-analysis/projection/property-evidence-reprise';
import type { CostClassificationReport, CostClassificationRestoreReport } from '@/services/ai/cost/cost-classification-backfill';
import type { ProvenanceCatchupReport, ProvenanceRestoreReport } from '@/services/ai/source-analysis/source-units/provenance-repair';
import type { T6AttributionReport, T6AttributionRestoreReport } from '@/services/home/mascot/t6-attribution-repair';

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
const STORED_ARRAY_LIMIT = 2_000;

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
      headline: `Restauration : ${r.restored} valeur(s) restaurée(s), ${r.deletedSubstructures} Pièce(s) créée(s) par la reprise supprimée(s), ${r.conflicts.length} conflit(s).`,
      scriptRunId: r.runId ?? null,
      restorable: false,
      counters: [
        { label: 'Valeurs restaurées', value: r.restored },
        { label: 'Pièces créées par la reprise supprimées', value: r.deletedSubstructures },
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

function assetAccount(out: RawBackfillOutput): BackfillSummary {
  const r = out.result as AssetAccountBackfillReport;
  const somme = (f: (x: AssetAccountBackfillReport['results'][number]) => number) => r.results.reduce((n, x) => n + f(x), 0);
  const simulation = r.mode === 'simulate';
  const gardes = r.results.filter((x) => x.keptFileIds.length > 0);
  return {
    headline: `${simulation ? 'Simulation' : 'Application'} : ${r.processed} bien(s) ${simulation ? 'à remettre' : 'remis'} en cohérence `
      + `sur ${r.detected} détecté(s), ${r.failed.length} échec(s)${r.more ? ' — d’autres biens restent à traiter' : ''}.`,
    scriptRunId: null,
    restorable: false,
    counters: [
      { label: 'Biens détectés (ce passage)', value: r.detected },
      // Lot 54 (SEC-P0-CORR) : sans demande de déplacement acceptée, rien n'est transféré.
      { label: 'Sans preuve de déplacement (non transférés, Isolation des comptes)', value: r.unproven ?? 0 },
      { label: simulation ? 'Biens à traiter' : 'Biens traités', value: r.processed },
      { label: 'Documents qui suivent le bien', value: somme((x) => x.movedFileIds.length) },
      { label: 'Documents multi-biens restés (lien retiré)', value: somme((x) => x.keptFileIds.length) },
      { label: 'Liens document ↔ bien retirés', value: somme((x) => x.linksRemoved) },
      { label: 'Éléments d’agenda qui suivent', value: somme((x) => x.movedAgendaItemIds.length) },
      { label: 'Éléments d’agenda multi-biens détachés', value: somme((x) => x.detachedAgendaItemIds.length) },
      { label: 'Actions « À traiter » déplacées', value: somme((x) => x.toProcessActionsMoved) },
      { label: 'Preuves retirées', value: somme((x) => x.evidenceWithdrawn) },
      { label: 'Fournisseurs réutilisés / copiés', value: `${somme((x) => x.suppliersReused)} / ${somme((x) => x.suppliersCopied)}` },
      { label: 'Transmissions en attente annulées', value: somme((x) => x.transmissionsCancelled) },
      { label: 'Sources d’Opération désactivées', value: somme((x) => x.operationSourcesDeactivated) },
    ],
    ambiguous: {
      count: gardes.length,
      samples: echantillon(gardes, (x) => `bien ${x.assetId} (compte ${x.fromAccountId} → ${x.toAccountId}) — documents restés : ${x.keptFileIds.join(', ')}`),
    },
    conflicts: { count: r.failed.length, samples: echantillon(r.failed, (f) => `bien ${f.assetId} (compte ${f.fromAccountId}) — ${f.error}`) },
    warnings: [],
  };
}

const NATURE_LABELS: Record<keyof StructuredMigrationReport['outcomes'], string> = {
  ACQUISITION: 'Acquisitions', DISPOSAL: 'Cessions', CONTRACT: 'Contrats',
};

function operationsStructured(out: RawBackfillOutput): BackfillSummary {
  const r = out.result as StructuredMigrationReport;
  const simulation = r.mode === 'simulate';
  const n = (nature: keyof StructuredMigrationReport['outcomes'], outcome: string) => (r.outcomes[nature] as Record<string, number | undefined>)[outcome] ?? 0;
  const counters: BackfillSummary['counters'] = [
    { label: 'Biens examinés (ce passage)', value: r.scanned },
    { label: 'Écritures Opération', value: r.changes },
  ];
  for (const k of ['ACQUISITION', 'DISPOSAL', 'CONTRACT'] as const) {
    counters.push({
      label: NATURE_LABELS[k],
      value: `${n(k, 'CREATE_NEW')} ${simulation ? 'à créer' : 'créée(s)'} · ${n(k, 'MATCH_AND_ENRICH')} rapprochée(s) d’un document · `
        + `${n(k, 'LINKED')} déjà liée(s) · ${n(k, 'WITHDRAWN')} retirée(s) · ${n(k, 'HOLD_UNRESOLVED') + n(k, 'ARBITRATION_REQUIRED')} sans création`,
    });
  }
  return {
    headline: `${simulation ? 'Simulation' : 'Application'} : ${r.processed} bien(s) ${simulation ? 'à réconcilier' : 'réconcilié(s)'} `
      + `sur ${r.scanned} examiné(s), ${r.changes} écriture(s) Opération, ${r.failed.length} échec(s)`
      + `${r.more ? ' — d’autres biens restent à examiner' : ''}.`,
    scriptRunId: null,
    restorable: false,
    counters,
    ambiguous: {
      count: r.holds.length,
      samples: echantillon(r.holds, (h) => `bien ${h.assetId} (compte ${h.accountId}) · ${NATURE_LABELS[h.nature]} — ${h.reason ?? 'ambiguïté'}`),
    },
    conflicts: { count: r.failed.length, samples: echantillon(r.failed, (f) => `bien ${f.assetId} (compte ${f.accountId}) — ${f.error}`) },
    warnings: [],
  };
}

const CLEANUP_LABELS: Record<string, string> = {
  ACTIONS: 'Actions de sinistre (ancien modèle)',
  EXCHANGES: 'Échanges de sinistre (ancien modèle)',
  CHILDREN: 'Liens « intervention enfant » (interventions conservées)',
  LEGACY_FORM: 'Ancien formulaire Sinistre des biens',
  MIGRATION_MARKS: 'Repères de migration de l’ancien formulaire',
  CARDS: 'Questions « À traiter » retirées encore ouvertes',
};

/** Lot 83D (V-Q2) : nettoyage de l'ancien modèle Sinistres. */
function claimsLegacyCleanup(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  if (action === 'restore') {
    const r = out.result as CleanupRestoreReport;
    return {
      headline: `Restauration de ${r.runId} : ${r.restored} ligne(s) rétablie(s), ${r.conflicts.length} conflit(s).`,
      scriptRunId: r.restoreRunId,
      restorable: false,
      counters: [{ label: 'Lignes rétablies', value: r.restored }, { label: 'Conflits', value: r.conflicts.length }],
      ambiguous: { count: 0, samples: [] },
      conflicts: { count: r.conflicts.length, samples: echantillon(r.conflicts, (c) => c) },
      warnings: [],
    };
  }
  const r = out.result as CleanupResult;
  const simulation = r.mode === 'SIMULATE';
  const total = Object.values(r.counters).reduce((a, b) => a + b, 0);
  if (r.finalized) {
    // Lot 84A (O-10) : ancien modèle supprimé définitivement — plus rien à nettoyer.
    return {
      headline: `${simulation ? 'Simulation' : 'Application'} : ancien modèle supprimé définitivement${r.finalized.at ? ` le ${r.finalized.at.slice(0, 10)}` : ''} — rien à nettoyer.`,
      scriptRunId: r.runId, restorable: false, counters: [{ label: 'Éléments de l’ancien modèle', value: 0 }],
      ambiguous: { count: 0, samples: [] }, conflicts: { count: 0, samples: [] }, warnings: [],
    };
  }
  return {
    headline: `${simulation ? 'Simulation' : 'Application'} : ${total} élément(s) de l’ancien modèle ${simulation ? 'à purger' : 'purgé(s)'} `
      + `sur ${r.accounts.length} compte(s)${simulation ? '' : ` — ${r.journalRows} ligne(s) journalisée(s), restaurable par ${r.runId}`}.`,
    scriptRunId: r.runId,
    restorable: !simulation && total > 0,
    counters: [
      ...Object.entries(r.counters).map(([k, v]) => ({ label: CLEANUP_LABELS[k] ?? k, value: v })),
      { label: 'Comptes concernés', value: r.accounts.length },
      ...(simulation ? [] : [
        { label: 'Point de restauration', value: r.restorePoint?.backupId ?? '—' },
        { label: 'Contrôle de cohérence (campagne)', value: r.coherence.campaignId ?? 'non demandé' },
        { label: 'Comptes non actifs (sans contrôle)', value: r.coherence.skippedAccounts.length },
      ]),
    ],
    ambiguous: { count: 0, samples: [] },
    conflicts: { count: 0, samples: [] },
    warnings: [
      ...echantillon(r.samples, (x) => `Compte ${x.accountId} · ${CLEANUP_LABELS[x.category] ?? x.category} — ${x.label}`),
      'Documents, photos, Opérations, événements, agenda, Pièces, équipements, détails d’assurance et dommages : jamais modifiés.',
    ],
  };
}

/** Lot 84A (O-10) : étape finale « Finaliser » du nettoyage de l'ancien modèle Sinistres. */
function claimsLegacyFinalize(out: RawBackfillOutput): BackfillSummary {
  const r = out.result as FinalizeResult;
  const simulation = r.mode === 'SIMULATE';
  const presents = r.objects.filter((o) => o.present || r.dropped.includes(o.name));
  const headline = r.alreadyFinalized
    ? `Ancien modèle Sinistres déjà supprimé${r.finalizedAt ? ` (finalisation du ${r.finalizedAt.slice(0, 10)})` : ''} : rien à faire.`
    : simulation
      ? (r.possible
        ? `Simulation : finalisation POSSIBLE — ${presents.length} objet(s) de l’ancien modèle seraient supprimés définitivement (rien n’est modifié).`
        : `Simulation : finalisation REFUSÉE pour l’instant — ${r.blockers.map((b) => b.message).join(' ')}`)
      : `Finalisation : ${r.dropped.length} objet(s) de l’ancien modèle supprimé(s) définitivement. Créez un nouveau point de restauration (bloc 0).`;
  const restants = Object.entries(r.remaining).filter(([, v]) => v > 0);
  return {
    headline,
    scriptRunId: r.runId,
    restorable: false,
    counters: [
      ...r.objects.map((o) => ({ label: `${o.kind === 'TABLE' ? 'Table' : 'Colonne'} ${o.name}`, value: o.present ? `présente${o.rows !== null ? ` (${o.rows} ligne(s) non vide(s))` : ''}` : 'supprimée' })),
      { label: 'Données héritées restantes (tous comptes)', value: Object.values(r.remaining).reduce((a, b) => a + b, 0) },
      { label: 'Comptes encore à nettoyer', value: r.remainingAccounts.length },
      { label: 'Point de restauration (< 24 h)', value: r.restorePoint?.backupId ?? 'aucun' },
    ],
    ambiguous: { count: 0, samples: [] },
    conflicts: { count: r.blockers.length, samples: r.blockers.map((b) => `${b.code} — ${b.message}`) },
    warnings: [
      ...restants.map(([k, v]) => `Reste à nettoyer : ${CLEANUP_LABELS[k] ?? k} — ${v}`),
      ...(r.remainingAccounts.length ? [`Comptes concernés : ${r.remainingAccounts.slice(0, SAMPLE_LIMIT).join(', ')}${r.remainingAccounts.length > SAMPLE_LIMIT ? '…' : ''}`] : []),
      ...(r.dropped.length ? [`Supprimé : ${r.dropped.join(', ')}`] : []),
      'Documents, photos, Opérations, événements, agenda, Pièces, équipements, détails d’assurance et dommages : jamais touchés.',
      ...(r.alreadyFinalized ? [] : ['Après la finalisation : le nettoyage (étape 1) ne peut plus être restauré et les points de restauration antérieurs sont refusés.']),
    ],
  };
}

/** Lot 53 (D23) : correction contrôlée des relations intercomptes. */
function crossAccount(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  if (action === 'restore') {
    const r = out.result as RemediationRestoreReport;
    return {
      headline: `Restauration de ${r.runId} : ${r.restored} ligne(s) remise(s) dans leur état d’avant, ${r.conflicts.length} conflit(s).`,
      scriptRunId: r.runId,
      restorable: false,
      counters: [
        { label: 'Lignes restaurées', value: r.restored },
        { label: 'Conflits (non restaurés)', value: r.conflicts.length },
      ],
      ambiguous: { count: 0, samples: [] },
      conflicts: { count: r.conflicts.length, samples: echantillon(r.conflicts, (c) => `${c.ref} — ${c.reason}`) },
      warnings: [],
    };
  }
  const r = out.result as RemediationReport;
  const simulation = r.mode === 'simulate';
  const duo = r.categories.flatMap((c) => c.duoSamples.map((x) => `${c.code} · ${x}`));
  return {
    headline: `${simulation ? 'Simulation' : 'Application'} (${r.family}) : ${r.corrected} relation(s) ${simulation ? 'à corriger' : 'corrigée(s)'}, `
      + `${r.duo} relevant du Duo (signalées, non corrigées), ${r.undecidable} indécidable(s), ${r.failed} échec(s)${r.more ? ' — d’autres relations restent : relancer' : ''}.`,
    scriptRunId: simulation ? null : r.runId,
    restorable: !simulation && r.corrected > 0,
    counters: r.categories.flatMap((c): BackfillSummary['counters'] => [
      { label: `${c.code} : relations`, value: c.candidates },
      { label: `${c.code} : ${simulation ? 'à corriger' : 'corrigées'}`, value: c.corrected },
      ...(c.duo ? [{ label: `${c.code} : Duo (signalées)`, value: c.duo }] : []),
      ...(c.undecidable ? [{ label: `${c.code} : indécidables`, value: c.undecidable }] : []),
      ...(c.manual ? [{ label: `${c.code} : en attente de décision (procédure d’incident)`, value: c.manual }] : []),
    ]).concat(r.postCheck ? [
      // Lot 54 (SEC-09) : recontrôle d'intégrité après application.
      { label: 'Recontrôle après correction : relations restantes', value: Object.values(r.postCheck.remaining).reduce((n, x) => n + x, 0) },
      ...(r.postCheck.incomplete.length ? [{ label: 'Recontrôle incomplet', value: r.postCheck.incomplete.join(', ') }] : []),
    ] : []),
    ambiguous: { count: r.duo + r.undecidable, samples: duo.slice(0, SAMPLE_LIMIT) },
    conflicts: { count: r.failed, samples: echantillon(r.categories.flatMap((c) => c.failures.map((x) => `${c.code} · ${x}`)), (x) => x) },
    warnings: [
      ...(r.duo ? [`${r.duo} relation(s) relèvent du Duo (D3 ouvert côté PO) : signalées, aucune correction appliquée.`] : []),
      ...(r.undecidable ? [`${r.undecidable} relation(s) dont un compte est inconnu : signalées, aucune correction appliquée.`] : []),
      ...(r.categories.some((c) => c.manual) ? ['Liens « cœur » des Opérations : procédure d’incident (BO › Opérations), aucune correction appliquée ici.'] : []),
      ...(r.postCheck?.incomplete.length ? [`Recontrôle incomplet (${r.postCheck.incomplete.join(', ')}) : l’intégrité n’est PAS confirmée.`] : []),
    ],
  };
}

/** Lot 71A : séparation bien / équipement. */
function equipmentSeparation(out: RawBackfillOutput): BackfillSummary {
  const r = out.result as DataSeparationReport;
  const simulation = r.mode === 'simulate';
  const n = (k: string) => r.cases.filter((c) => c.kind === k).length;
  return {
    headline: `${simulation ? 'Simulation' : 'Application'} : ${r.cases.length} valeur(s) d’origine erronée démontrée ${simulation ? 'à corriger' : 'traitée(s)'}, `
      + `${r.preserved.length} valeur(s) utilisateur préservée(s), ${r.documents.linked} document(s) ${simulation ? 'à rattacher' : 'rattaché(s)'} à un équipement, `
      + `${r.documents.ambiguous} ambigu(s), ${r.suspects?.length ?? 0} situation(s) suspecte(s) non modifiée(s), ${r.failed.length} échec(s).`,
    scriptRunId: simulation ? null : r.runId,
    restorable: false,
    counters: [
      { label: 'Comptes examinés', value: r.accountsScanned },
      { label: 'Bien : date / prix déduits d’un achat d’équipement ou même preuve', value: n('ASSET_EVIDENCE_WITHDRAWN') },
      { label: 'Équipement : valeur du bien recopiée (même preuve, acte)', value: n('EQUIPMENT_EVIDENCE_WITHDRAWN') },
      { label: 'Bien : date d’achat recopiée d’un événement d’équipement', value: n('AGENDA_PURCHASE_MOVED') },
      { label: 'Champs corrigés sur les fiches', value: r.fieldsCorrected.length },
      { label: 'Situations suspectes (signalées, non modifiées)', value: r.suspects?.length ?? 0 },
      { label: 'Réconciliations reprises (exécution interrompue)', value: r.resumed ?? 0 },
      { label: 'Valeurs utilisateur préservées', value: r.preserved.length },
      { label: 'Documents examinés', value: r.documents.examined },
      { label: `Documents ${simulation ? 'à rattacher' : 'rattachés'} à un équipement`, value: r.documents.linked },
      { label: `Liens document ↔ équipement ${simulation ? 'à créer' : 'créés'}`, value: r.documents.linksCreated },
    ],
    ambiguous: { count: r.documents.ambiguous, samples: [] },
    conflicts: { count: r.failed.length, samples: echantillon(r.failed, (f) => `${f.ref} — ${f.error}`) },
    warnings: [
      ...r.cases.slice(0, SAMPLE_LIMIT).map((c) => `${c.kind} · compte ${c.accountId} · bien ${c.assetId}${c.equipmentId ? ` · équipement ${c.equipmentId}` : ''} · ${c.fieldKey} : ${c.motive}`),
      ...r.documents.samples.slice(0, 5),
      ...(r.suspects ?? []).slice(0, SAMPLE_LIMIT).map((c) => `SUSPECT ${c.kind} · compte ${c.accountId} · bien ${c.assetId}${c.equipmentId ? ` · équipement ${c.equipmentId}` : ''} · ${c.fieldKey} : ${c.motive}`),
    ],
  };
}

/** Lot 71B : reprise des documents « à valider ». */
function documentValidation(out: RawBackfillOutput): BackfillSummary {
  const r = out.result as ValidationRepriseReport;
  const simulation = r.mode === 'simulate';
  return {
    headline: simulation
      ? `Simulation : ${r.scanned} document(s) « à valider » à reprendre, ${r.pendingProposals} proposition(s) en attente, `
        + `${r.openCards} carte(s) « À traiter » déjà ouverte(s), ${r.equipment.linksCreated} lien(s) équipement à poser.`
      : `Application : ${r.processed} document(s) repris, ${r.rules.written} donnée(s) écrite(s), ${r.rules.created} carte(s) « À traiter » créée(s), `
        + `${r.equipment.linksCreated} lien(s) équipement posé(s), ${r.failed.length} échec(s).`,
    scriptRunId: simulation ? null : r.runId,
    restorable: false,
    counters: [
      { label: 'Documents « à valider » examinés', value: r.scanned },
      { label: simulation ? 'Documents à reprendre' : 'Documents repris', value: simulation ? r.scanned : r.processed },
      { label: 'Ignorés (état changé entre-temps)', value: r.skipped },
      { label: 'Propositions en attente', value: r.pendingProposals },
      { label: 'Cartes « À traiter » déjà ouvertes', value: r.openCards },
      { label: 'Données fiables écrites', value: r.rules.written },
      { label: 'Cartes « À traiter » créées', value: r.rules.created },
      { label: 'Cartes « À traiter » mises à jour', value: r.rules.updated },
      { label: 'Cartes « À traiter » fermées (résolues)', value: r.rules.closed },
      { label: `Liens équipement ${simulation ? 'à poser' : 'posés'}`, value: r.equipment.linksCreated },
      { label: 'Cartes équipement (ambiguïté)', value: r.equipment.cards },
    ],
    ambiguous: { count: r.equipment.ambiguous, samples: [] },
    conflicts: { count: r.failed.length, samples: echantillon(r.failed, (f) => `document ${f.fileId} · compte ${f.accountId} — ${f.error}`) },
    warnings: [...r.samples.slice(0, SAMPLE_LIMIT), ...(r.more ? ['Il reste des documents : relancez ou laissez la tâche planifiée poursuivre.'] : [])],
  };
}

/** Lot 72D : Premium Duo en compte partagé. */
function duoSharedAccount(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  if (action === 'restore') {
    const r = out.result as DuoRestoreReport;
    return {
      headline: `Restauration : ${r.restored} écriture(s) annulée(s), ${r.conflicts.length} conflit(s).`,
      scriptRunId: r.runId, restorable: false,
      counters: [{ label: 'Écritures annulées', value: r.restored }, { label: 'Ignorées', value: r.skipped }],
      ambiguous: { count: 0, samples: [] },
      conflicts: { count: r.conflicts.length, samples: r.conflicts.slice(0, SAMPLE_LIMIT) },
      warnings: [],
    };
  }
  const r = out.result as DuoSharedAccountReport;
  const sim = r.mode === 'simulate';
  const a = r.actions;
  const b = r.before;
  const membres = a.memberMembershipsCreated + a.memberMembershipsReactivated;
  const titulaires = a.ownerMembershipsCreated + a.ownerMembershipsReactivated;
  return {
    headline: sim
      ? `Simulation : ${b.B} membre(s) Duo à rattacher au compte partagé, ${b.A} adhésion(s) titulaire à rétablir, `
        + `${b.D1} compte(s) artificiel(s) vide(s) à archiver, ${b.C} Duo indécidable(s).`
      : `Application : ${membres} membre(s) rattaché(s), ${titulaires} titulaire(s) rétabli(s), ${a.accountsArchived} compte(s) archivé(s), `
        + `${a.planTypesFixed} offre(s) affichée(s) corrigée(s). Après : ${r.after?.B ?? 0} membre(s) restant à rattacher.`,
    scriptRunId: sim ? null : r.runId,
    restorable: !sim,
    counters: [
      { label: 'INV-A titulaires sans adhésion (avant)', value: b.A },
      { label: 'INV-B membres Duo sans adhésion (avant)', value: b.B },
      { label: 'INV-C Duo indécidables', value: b.C },
      { label: 'INV-D1 comptes artificiels vides', value: b.D1 },
      { label: 'INV-D2 comptes d’invité avec données (aucune action)', value: b.D2 },
      { label: 'INV-D3 comptes d’invité avec facturation (aucune action)', value: b.D3 },
      { label: 'INV-D4 comptes d’invité avec biens reçus (aucune action)', value: b.D4 },
      { label: 'INV-E essais indus (rapport, aucune remise à zéro)', value: b.E },
      { label: 'INV-F incohérences d’offre', value: b.F },
      { label: 'INV-G demandes croisées / biens verrouillés', value: b.G },
      { label: 'INV-H anciens membres', value: b.H },
      { label: 'INV-I invitations à vérifier (inviteur non titulaire)', value: b.I },
      ...(sim ? [] : [
        { label: 'Adhésions membre créées', value: a.memberMembershipsCreated },
        { label: 'Adhésions membre réactivées', value: a.memberMembershipsReactivated },
        { label: 'Adhésions titulaire créées / réactivées', value: titulaires },
        { label: 'Comptes archivés', value: a.accountsArchived },
        { label: 'Offres affichées corrigées', value: a.planTypesFixed },
        { label: 'INV-B après application', value: r.after?.B ?? 0 },
      ]),
    ],
    ambiguous: { count: r.undecidable.length, samples: echantillon(r.undecidable, (u) => `Duo ${u.duoId} : ${u.reason}`) },
    conflicts: {
      count: r.seatsExceeded.length,
      samples: echantillon(r.seatsExceeded, (x) => `Duo ${x.duoId} · compte ${x.accountId} · utilisateur ${x.userId} : places épuisées`),
    },
    warnings: [
      ...r.billingMismatches.slice(0, SAMPLE_LIMIT).map((x) => `Duo ${x.duoId} : ${x.reason}`),
      ...r.suspiciousInvitations.slice(0, SAMPLE_LIMIT).map((x) => `Compte ${x.accountId} · membre ${x.userId} invité par ${x.invitedBy ?? '?'} (non titulaire) : à vérifier`),
    ],
  };
}

/** Lot 76H : doublons d'interventions dans l'agenda (simulation, application, restauration). */
function agendaInterventionDuplicates(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  if (action === 'restore') {
    const r = out.result as { restored: number; conflicts: Array<{ journalId: number; itemId: number; reason: string }>; runId?: string | null };
    return {
      headline: `Restauration : ${r.restored} écriture(s) annulée(s), ${r.conflicts.length} conflit(s).`,
      scriptRunId: r.runId ?? null, restorable: false,
      counters: [{ label: 'Écritures annulées', value: r.restored }],
      ambiguous: { count: 0, samples: [] },
      conflicts: { count: r.conflicts.length, samples: echantillon(r.conflicts, (c) => `journal ${c.journalId} · événement ${c.itemId} : ${c.reason}`) },
      warnings: [],
    };
  }
  const r = out.result as import('@/services/business-operations/agenda-projection/duplicates-reprise').RepriseResult;
  const c = r.counters;
  const sim = r.mode === 'SIMULATE';
  const arb = r.report.filter((e) => e.category === 'ARBITRATION');
  const sans = r.report.filter((e) => e.category === 'NO_OPERATION');
  const t4 = r.report.filter((e) => e.category === 'T4_DECISION');
  return {
    headline: sim
      ? `Simulation : ${c.operations} Opération(s) examinée(s) sur ${c.accounts} compte(s) — ${c.t4Required} représentation(s) à décider par T4 `
        + `(${c.t4Unavailable} en attente du contrat T4 multi-événements, ${c.t4Settled} déjà décidée(s)), ${c.arbitration} carte(s) « À traiter », `
        + `${c.noOperationGroups} groupe(s) sans Opération (signalés). Aucune fusion par le code.`
      : `Application : ${c.linked} lien(s) posé(s) (provenance), ${c.retitled} intitulé(s) précisé(s), ${c.arbitration} carte(s) « À traiter » ; `
        + `décisions T4 : ${c.t4Applied} appliquée(s), ${c.t4NoChange} sans changement, ${c.t4Rejected} refusée(s), ${c.t4Unavailable} indisponible(s), `
        + `${c.t4Deferred} reportée(s) (plafond), ${c.aiCalls} appel(s) IA.`,
    scriptRunId: sim ? null : r.runId,
    restorable: !sim,
    counters: [
      { label: 'Comptes examinés', value: c.accounts },
      { label: 'Opérations examinées', value: c.operations },
      { label: 'Représentations à décider par T4', value: c.t4Required },
      { label: 'Identités incertaines (carte « À traiter »)', value: c.arbitration },
      { label: 'Résidus de fusion d’Opérations', value: c.residualsAfterMerge },
      { label: 'Doublons sans Opération (signalés, non traités)', value: c.noOperationGroups },
      { label: 'Décisions T4 indisponibles (contrat non livré)', value: c.t4Unavailable },
      { label: 'Décisions T4 déjà prises sur ce contexte', value: c.t4Settled },
      ...(sim ? [] : [
        { label: 'Liens posés (provenance)', value: c.linked },
        { label: 'Intitulés précisés', value: c.retitled },
        { label: 'Projections créées', value: c.projectionsCreated },
        { label: 'Décisions T4 appliquées', value: c.t4Applied },
        { label: 'Décisions T4 sans changement', value: c.t4NoChange },
        { label: 'Décisions T4 refusées (invalides, objet protégé)', value: c.t4Rejected },
        { label: 'Décisions T4 reportées (plafond)', value: c.t4Deferred },
        { label: 'Appels IA', value: c.aiCalls },
      ]),
      { label: 'Comptes en erreur', value: c.errors },
    ],
    ambiguous: {
      count: arb.length + t4.filter((e) => e.detail.status !== 'APPLIED' && e.detail.status !== 'NO_CHANGE' && e.detail.status !== 'SETTLED').length,
      samples: [
        ...echantillon(arb, (e) => `compte ${e.accountId} · Opération ${e.operationId} : ${String(e.detail.reason ?? '')}`),
        ...echantillon(t4, (e) => `compte ${e.accountId} · Opération ${e.operationId} : décision T4 ${String(e.detail.status)}${e.detail.reason ? ` (${String(e.detail.reason)})` : ''}`),
      ].slice(0, SAMPLE_LIMIT),
    },
    conflicts: { count: 0, samples: [] },
    warnings: sans.slice(0, SAMPLE_LIMIT).map((e) => `Compte ${e.accountId} · document ${String(e.detail.fileId)} du ${String(e.detail.date)} : événements ${JSON.stringify(e.detail.itemIds)} sans Opération d’intervention (T3 n’a rien établi) — conservés.`),
  };
}

/** Lot 81A : faux arbitrages « À traiter » (simulation, application). */
function falseArbitrations(out: RawBackfillOutput): BackfillSummary {
  const r = out.result as import('@/services/to-process/arbitration-equivalence-reprise').RepriseRunResult;
  const c = r.counters;
  const sim = r.mode === 'SIMULATE';
  const ligne = (i: (typeof r.items)[number]) => `compte ${i.accountId} · ${i.targetType} ${i.targetId} · ${i.fieldKey} · carte ${i.actionId} : `
    + `${(i.before ?? []).map((p) => `${p.isCurrentValue ? 'actuelle ' : ''}${String(p.value)}`).join(' / ')}`
    + `${i.after ? ` → ${i.after.map((p) => `${p.isCurrentValue ? 'actuelle ' : ''}${String(p.value)}`).join(' / ')}` : ''}`
    + `${i.initial?.registryReason ? ` (motif initial ${i.initial.registryReason})` : ''}${i.error ? ` — ${i.error}` : ''}`;
  return {
    headline: `${sim ? 'Simulation' : 'Application'} : ${c.scanned} carte(s) « À arbitrer » parcourue(s), ${c.suspects} faux arbitrage(s) — `
      + `${c.CORRECTED} ${sim ? 'à corriger' : 'corrigé(s)'} (contradiction réelle), ${c.OBSOLETE} ${sim ? 'à clore' : 'clos'} sans objet, `
      + `${c.OUT_OF_SCOPE} hors périmètre T3, ${c.ERROR} en erreur. Aucune valeur de fiche modifiée.`,
    scriptRunId: null,
    restorable: false,
    counters: [
      { label: 'Cartes parcourues', value: c.scanned },
      { label: 'Faux arbitrages détectés', value: c.suspects },
      { label: sim ? 'À corriger (contradiction réelle)' : 'Corrigées (contradiction réelle)', value: c.CORRECTED },
      { label: sim ? 'À clore sans objet' : 'Closes sans objet', value: c.OBSOLETE },
      { label: 'Hors périmètre T3 (signalées, non traitées)', value: c.OUT_OF_SCOPE },
      { label: 'Cible introuvable', value: c.TARGET_MISSING },
      { label: 'Erreurs', value: c.ERROR },
    ],
    ambiguous: { count: c.CORRECTED, samples: echantillon(r.items.filter((i) => i.outcome === 'CORRECTED'), ligne) },
    conflicts: { count: c.ERROR, samples: echantillon(r.items.filter((i) => i.outcome === 'ERROR'), ligne) },
    warnings: [
      ...r.items.filter((i) => i.outcome === 'OBSOLETE').slice(0, SAMPLE_LIMIT).map((i) => `Sans objet : ${ligne(i)}`),
      ...r.items.filter((i) => i.outcome === 'OUT_OF_SCOPE' || i.outcome === 'TARGET_MISSING').slice(0, SAMPLE_LIMIT).map((i) => `${i.outcome === 'OUT_OF_SCOPE' ? 'Hors périmètre' : 'Cible introuvable'} : ${ligne(i)}`),
    ],
  };
}

/** Lot 85A (CDC v5 O-2) — purge et reconstruction des Opérations (préproduction). */
function operationsV5Rebuild(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  if (action === 'restore') {
    const r = out.result as RebuildRestoreReport;
    return {
      headline: `Restauration de ${r.runId} : ${r.restored.length} compte(s) remis exactement à leur état d’avant, ${r.refused.length} refusé(s).`,
      scriptRunId: r.restoreRunId,
      restorable: false,
      counters: [
        { label: 'Comptes restaurés', value: r.restored.length },
        { label: 'Lignes rétablies', value: r.restored.reduce((n, x) => n + x.writes, 0) },
        { label: 'Comptes refusés (modifiés depuis)', value: r.refused.length },
      ],
      ambiguous: { count: 0, samples: [] },
      conflicts: { count: r.refused.length, samples: echantillon(r.conflicts, (c) => c) },
      warnings: [],
    };
  }
  const r = out.result as RebuildResult;
  const sim = r.mode === 'SIMULATE';
  const n = (k: string) => r.counters[k] ?? 0;
  const traites = r.accounts.filter((a) => a.plan);
  const motifs: Partial<Record<KeepReason, number>> = {};
  for (const a of traites) for (const [k, v] of Object.entries(a.plan!.keptByReason)) motifs[k as KeepReason] = (motifs[k as KeepReason] ?? 0) + (v ?? 0);
  const ligne = (a: RebuildResult['accounts'][number]) => {
    const p = a.plan;
    const base = `Compte ${a.accountId} — ${ACCOUNT_STATUS_LABELS[a.status]}`;
    if (!p) return base;
    return `${base} : ${p.operations.active} Opération(s) active(s) avant${a.operations?.after != null ? `, ${a.operations.after} après` : ''} ; `
      + `${p.purged.length} ${sim ? 'à purger' : 'purgée(s)'}, ${p.kept.length} conservée(s), ${p.projectionsRemoved.length} événement(s) automatique(s) ${sim ? 'à retirer' : 'retiré(s)'}, `
      + `${p.candidatesRequeued} candidat(s) T1 remis en consolidation${a.steps ? `, M3 ${a.steps.m3.calls} appel(s)` : ''}`
      + `${a.tco?.differences.length ? ` ; TCO : ${a.tco.differences.join(' ; ')}` : a.tco?.after ? ' ; TCO identique' : ''}`
      + `${a.signature?.identical === true ? ' ; résultat métier inchangé' : ''}`;
  };
  return {
    headline: `${sim ? 'Simulation' : 'Application'} : ${r.accounts.length} compte(s) examiné(s), ${r.excluded.length} exclu(s) (non actifs) — `
      + `${n('operationsPurged')} Opération(s) ${sim ? 'à purger' : 'purgée(s)'}, ${n('operationsKept')} conservée(s) (gestes de l’utilisateur)`
      + `${sim ? '' : ` ; ${n('status_REBUILT')} compte(s) reconstruit(s), ${n('status_PARTIAL')} avec points à reprendre, ${n('status_FAILED')} en échec, `
        + `${n('status_UP_TO_DATE')} déjà à jour — restaurable par ${r.runId}`}.`,
    scriptRunId: r.runId,
    restorable: !sim && (n('status_REBUILT') + n('status_PARTIAL')) > 0,
    counters: [
      { label: 'Comptes examinés', value: r.accounts.length },
      { label: 'Comptes exclus (non actifs ou en lecture seule)', value: r.excluded.length },
      { label: sim ? 'Comptes à reconstruire' : 'Comptes reconstruits', value: sim ? n('status_PLANNED') : n('status_REBUILT') },
      ...(sim ? [] : [
        { label: 'Comptes reconstruits avec points à reprendre', value: n('status_PARTIAL') },
        { label: 'Comptes en échec (remis à l’état d’avant)', value: n('status_FAILED') },
      ]),
      { label: 'Comptes déjà reconstruits et inchangés (rien à faire)', value: n('status_UP_TO_DATE') },
      { label: 'Comptes reportés (traitement en cours)', value: n('status_BUSY') },
      { label: sim ? 'Opérations à purger' : 'Opérations purgées', value: n('operationsPurged') },
      { label: 'Opérations conservées (touchées par l’utilisateur)', value: n('operationsKept') },
      ...Object.entries(motifs).map(([k, v]) => ({ label: `  dont : ${KEEP_REASON_LABELS[k as KeepReason]}`, value: v ?? 0 })),
      { label: sim ? 'Événements automatiques à retirer' : 'Événements automatiques retirés', value: n('projectionsRemoved') },
      { label: 'Candidats T1 remis en consolidation (sans nouvelle analyse)', value: n('candidatesRequeued') },
      { label: 'Décisions TCO re-clées (aucune perdue)', value: n('tcoDecisionsRekeyed') },
      ...(sim ? [] : [
        { label: 'Appels IA de rapprochement (M3)', value: n('m3Calls') },
        { label: 'Analyses T1 relancées', value: n('t1Calls') },
        { label: 'Point de restauration', value: r.restorePoint?.backupId ?? '—' },
        { label: 'Contrôle de cohérence (campagne)', value: r.coherence.campaignId ?? 'non demandé' },
      ]),
    ],
    ambiguous: { count: 0, samples: [] },
    conflicts: {
      count: r.accounts.filter((a) => a.status === 'FAILED' || a.status === 'PARTIAL').length,
      samples: echantillon(r.accounts.filter((a) => a.status === 'FAILED' || a.status === 'PARTIAL'), (a) => `${ligne(a)}${a.warnings.length ? ` — ${a.warnings.slice(0, 3).join(' ; ')}` : ''}`),
    },
    warnings: [
      ...echantillon(r.accounts, ligne),
      ...r.excluded.slice(0, SAMPLE_LIMIT).map((e) => `Compte ${e.accountId} exclu : ${e.reason}`),
      'Jamais modifiés : éléments d’agenda saisis ou modifiés, dates choisies, liens manuels, décisions de l’utilisateur, biens retirés, événements supprimés, décisions TCO.',
    ],
  };
}

/** Synthèse lisible d'une exécution terminée (pure). */
/** Lot 82E — point de restauration (sauvegarde format 2) et restauration de la base. */
function databaseRestorePoint(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  if (action === 'restore') {
    const r = out.result as DatabaseRestoreReport;
    const neutralises = r.neutralized.reduce((n, x) => n + x.rows, 0);
    return {
      headline: `Restauration au point ${r.backupId} (instantané du ${r.backupSnapshotAt}) : ${r.rows} ligne(s) rechargée(s) dans ${r.restoredTables} table(s), `
        + `${r.foreignKeys.restored} relation(s) revalidée(s)${neutralises ? `, ${neutralises} envoi(s) en attente neutralisé(s)` : ''}.`,
      // Le point de l'état d'avant la restauration : restaurable à son tour (retour arrière).
      scriptRunId: r.safetyBackupId,
      restorable: false,
      counters: [
        { label: 'Lignes rechargées', value: r.rows },
        { label: 'Tables restaurées', value: r.restoredTables },
        { label: 'Tables conservées en l’état', value: r.keptTables.length },
        { label: 'Contraintes de clé étrangère revalidées', value: r.foreignKeys.restored },
        { label: 'Déclencheurs suspendus pendant le rechargement', value: r.triggersSuspended },
        { label: 'Point de l’état d’avant restauration', value: r.safetyBackupId ?? '—' },
        ...r.neutralized.map((x) => ({ label: x.label, value: x.rows })),
        { label: 'Durée (s)', value: Math.round(r.durationMs / 1000) },
      ],
      ambiguous: { count: 0, samples: [] },
      conflicts: { count: 0, samples: [] },
      warnings: [
        ...(r.foreignKeys.keptNotValid.length ? [`Journaux conservés citant des objets absents du point (contrainte gardée « NOT VALID ») : ${r.foreignKeys.keptNotValid.join(', ')}.`] : []),
        ...(r.sequencesAdvanced.length ? [`Séquences avancées : ${r.sequencesAdvanced.join(', ')}.`] : []),
        'Les fichiers du stockage ne sont pas restaurés (un document supprimé définitivement après le point reste absent).',
      ],
    };
  }
  const m = out.result as Omit<BackupManifestV2, 'tables'> & { tables: Array<{ name: string; rows: number }> };
  return {
    headline: `Point de restauration créé : ${m.backupId} — ${m.totalRows} ligne(s), ${m.tables.length} table(s), instantané du ${m.snapshot.at}.`,
    scriptRunId: m.backupId,
    restorable: true,
    counters: [
      { label: 'Identifiant du point', value: m.backupId },
      { label: 'Instantané (instant de cohérence)', value: m.snapshot.at },
      { label: 'Lignes', value: m.totalRows },
      { label: 'Tables', value: m.tables.length },
      { label: 'Taille compressée (octets)', value: m.sizeBytes },
      { label: 'Empreinte du schéma', value: m.schema.fingerprint },
      { label: 'Dernière migration', value: m.schema.lastMigration ?? '—' },
      { label: 'Durée (s)', value: Math.round(m.durationMs / 1000) },
    ],
    ambiguous: { count: 0, samples: [] },
    conflicts: { count: 0, samples: [] },
    warnings: ['Point conservé 30 jours (rétention des sauvegardes). Restaurable tant que le schéma ne change pas (pas de nouvelle migration).'],
  };
}

/** Lot 89A (Pilotage IA V2 P8) : reclassement de l'historique et marquage des configurations existantes. */
const NATURE_FR: Record<string, string> = { BUSINESS: 'métier', TECHNICAL: 'technique', UNDETERMINED: 'non déterminable' };
const ISSUE_FR: Record<string, string> = { SUCCEEDED: 'Réussie', INCOMPLETE: 'Incomplète', FAILED: 'Échouée', NOT_FINAL: 'Non finale', VOID: 'Sans objet', UNDETERMINED: 'Non déterminable' };
function aiHistoryReclassification(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  if (action === 'restore') {
    const r = out.result as ReclassificationRestoreReport;
    return {
      headline: `Reclassement annulé : ${r.callsRestored} appel(s) remis dans leur état antérieur, ${r.configurationsRestored} marque(s) de configuration retirée(s).`,
      scriptRunId: r.runId, restorable: false,
      counters: [{ label: 'Appels remis dans leur état antérieur', value: r.callsRestored }, { label: 'Marques « manuel, non qualifié » retirées', value: r.configurationsRestored }],
      ambiguous: { count: 0, samples: [] }, conflicts: { count: 0, samples: [] },
      warnings: ['Les traces d’origine n’ont jamais été modifiées : seul le classement ajouté est retiré.'],
    };
  }
  const r = out.result as ReclassificationReport;
  const sim = action === 'simulate';
  const c = r.calls;
  const parNature = Object.entries(c.byNature).map(([k, v]) => ({ label: `Appels ${NATURE_FR[k] ?? k}`, value: v }));
  const parIssue = Object.entries(c.byOutcome).map(([k, v]) => ({ label: `Issue de l’exécution : ${ISSUE_FR[k] ?? k}`, value: v }));
  const parTraitement = Object.entries(c.byTreatment).map(([k, v]) => ({ label: `Traitement ${k}`, value: v }));
  const nd = Object.entries(c.undeterminedReasons).sort((a, b) => b[1] - a[1]);
  return {
    headline: r.disabled
      ? `Rien à reclasser : ${r.disabled}.`
      : `${sim ? 'Simulation' : 'Reclassement'} (${r.rule}) : ${c.examined} appel(s) historique(s) examiné(s)${sim ? '' : `, ${c.classified} classé(s)`}, `
        + `${c.alreadyClassified} déjà classé(s) ; ${sim ? r.configurations.versionIds.length : r.configurations.marked} version(s) de configuration `
        + `${sim ? 'à marquer' : 'marquée(s)'} « manuel, non qualifié »${c.more ? ' — reste à examiner' : ''}.`,
    scriptRunId: r.runId,
    restorable: !sim && (c.classified > 0 || r.configurations.marked > 0 || c.alreadyClassified > 0),
    counters: [
      { label: 'Règle', value: r.rule },
      { label: 'AI_PILOTAGE_V2', value: r.pilotageV2 },
      { label: 'Suivi par exécution depuis', value: r.correlationStartedAt ?? '—' },
      { label: 'Appels examinés', value: c.examined },
      ...(sim ? [] : [{ label: 'Appels classés', value: c.classified }, { label: 'Appels écartés (rattachés entre-temps par le nouveau chemin)', value: c.skippedConcurrent }]),
      { label: 'Appels déjà classés par cette règle', value: c.alreadyClassified },
      ...parNature, ...parTraitement, ...parIssue,
      { label: 'Versions de configuration examinées', value: r.configurations.examined },
      { label: sim ? 'Versions à marquer « manuel, non qualifié »' : 'Versions marquées « manuel, non qualifié »', value: sim ? r.configurations.versionIds.length : r.configurations.marked },
      { label: 'Versions déjà marquées', value: r.configurations.alreadyMarked },
      { label: 'Candidates automatiques (jamais marquées)', value: r.configurations.automaticSkipped },
    ],
    ambiguous: { count: nd.reduce((n, [, v]) => n + v, 0), samples: nd.slice(0, SAMPLE_LIMIT).map(([k, v]) => `${v} × ${k}`) },
    conflicts: { count: c.skippedConcurrent, samples: [] },
    warnings: [
      ...(c.more ? ['Historique non entièrement examiné dans le temps imparti : relancer (rien n’est réécrit).'] : []),
      'Aucun appel IA, aucune reconstitution : sans preuve enregistrée, l’appel reste « non déterminable » avec son motif.',
    ],
  };
}

/** Lot 91B — rattrapage des propriétés manquantes (objets jamais examinés). */
function missingPropertiesCatchup(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  const r = out.result as import('@/services/coherence/orchestrator').CatchupRequestResult & {
    controls: { processed: number; results: Record<string, number>; skippedAccounts: number; aiCalls: number } | null;
  };
  const sim = action === 'simulate';
  const total = Object.values(r.requested).reduce((n, v) => n + v, 0);
  const jamais = r.items.filter((i) => i.reason === 'NEVER_CONTROLLED').length;
  return {
    headline: `${sim ? 'Simulation' : 'Application'} : ${total} objet(s) ${sim ? 'à reprendre' : 'repris'} (${jamais} jamais contrôlé(s) dans l’échantillon)`
      + `${r.controls ? ` — ${r.controls.processed} contrôle(s) exécuté(s), ${r.controls.aiCalls} appel(s) IA` : ''}.`,
    scriptRunId: null,
    restorable: false,
    counters: [
      ...Object.entries(r.requested).map(([k, v]) => ({ label: `${sim ? 'À reprendre' : 'Repris'} — ${k}`, value: v })),
      ...(r.controls ? Object.entries(r.controls.results).map(([k, v]) => ({ label: `Résultat du contrôle : ${k}`, value: v })) : []),
    ],
    ambiguous: { count: 0, samples: [] },
    conflicts: { count: 0, samples: [] },
    warnings: [
      ...echantillon(r.items, (i) => `${i.checkId} · compte ${i.accountId} · objet ${i.objectId} : ${i.reason === 'NEVER_CONTROLLED' ? 'jamais contrôlé' : 'aucune issue récente'}`),
      'Chaque issue est lisible dans l’export de recette : property_recovery_runs (statut, cause) et property_recovery_decisions.',
    ],
  };
}

/** Lot 91D — réexamen ciblé des omissions documentaires T1. */
function extractChainDecisionReview(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  const r = out.result as import('@/services/coherence/orchestrator').CatchupRequestResult & {
    controls: { processed: number; results: Record<string, number>; skippedAccounts: number; aiCalls: number } | null;
    contract: string;
  };
  const sim = action === 'simulate';
  const total = Object.values(r.requested).reduce((n, v) => n + v, 0);
  const porte = r.contract === 'CARRIED';
  return {
    headline: !porte
      ? `Contrat T1 « t1-value-decisions-v1 » non porté par le prompt T1 actif (${r.contract}) : rien à reprendre — collez d’abord l’étape T1 du guide des prompts.`
      : `${sim ? 'Simulation' : 'Application'} : ${total} document(s) en constat d’omission ${sim ? 'à reprendre' : 'repris'}`
        + `${r.controls ? ` — ${r.controls.processed} contrôle(s) exécuté(s), ${r.controls.aiCalls} appel(s) IA` : ''}.`,
    scriptRunId: null,
    restorable: false,
    counters: [
      ...Object.entries(r.requested).map(([k, v]) => ({ label: `${sim ? 'À reprendre' : 'Repris'} — ${k}`, value: v })),
      ...(r.controls ? Object.entries(r.controls.results).map(([k, v]) => ({ label: `Résultat du contrôle : ${k}`, value: v })) : []),
    ],
    ambiguous: { count: 0, samples: [] },
    conflicts: { count: 0, samples: [] },
    warnings: [
      ...echantillon(r.items, (i) => `${i.checkId} · compte ${i.accountId} · document ${i.objectId}`),
      'Chaque décision est lisible dans l’export de recette : document_value_decisions (valeur, décision, motif, validité) ; le réexamen dans coherence_repairs.',
    ],
  };
}

/** Montant indicatif en dollars (micro-dollars → « 1,23 $ »), « non estimable » sinon. */
const usd = (micros: number | null) => (micros == null ? 'non estimable' : `${(micros / 1_000_000).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`);

/** Lot 113AC — requalification T1 des périodes métier (textes à valider par le PO). */
function businessPeriodsRequalification(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  const r = out.result as import('@/services/documents/business-periods/requalification').RequalificationReport;
  const recense = (c: typeof r.before, quand: string) => [
    { label: `${quand} — à requalifier`, value: c.toRequalify },
    { label: `${quand} — demandés, analyse en attente`, value: c.requestedPending },
    { label: `${quand} — requalifiés (sortie v2)`, value: c.requestedQualified },
    { label: `${quand} — demandés, toujours sans sortie v2`, value: c.requestedWithoutV2 },
    { label: `${quand} — qualifiés v2 sans requalification`, value: c.qualifiedOtherwise },
  ];
  const headline = r.refused
    ? `Application refusée : ${r.availability.reason}`
    : action === 'simulate'
      ? `Simulation : ${r.before.toRequalify} document(s) à requalifier ; prochain lot : ${r.batch.length} document(s) ; coût indicatif du reste : ${usd(r.estimate.estimatedMicros)}.${r.availability.available ? '' : ` ${r.availability.reason}`}`
      : `Application : ${r.queued?.length ?? 0} document(s) mis en file T1 (lot de ${r.batchSize} au plus) ; ${r.notAccepted?.length ?? 0} non accepté(s) par la file.`;
  return {
    headline,
    scriptRunId: null,
    restorable: false,
    counters: [
      { label: 'Contrat t1-business-periods-v2', value: r.availability.contractState },
      ...recense(r.before, 'Avant'),
      ...(r.after && action === 'apply' ? recense(r.after, 'Après') : []),
      { label: 'Coût moyen T1 observé par document', value: usd(r.estimate.averageMicrosPerDocument) },
      { label: `Documents analysés sur ${r.estimate.windowDays} jours (base de la moyenne)`, value: r.estimate.sampleDocuments },
      { label: 'Comptes écartés (non éligibles au traitement IA)', value: r.ineligibleAccounts.length },
    ],
    ambiguous: { count: 0, samples: [] },
    conflicts: { count: 0, samples: [] },
    warnings: [
      ...(r.before.requestedWithoutV2 > 0 ? [`${r.before.requestedWithoutV2} document(s) déjà requalifié(s) restent sans sortie v2 : ils ne sont pas redemandés (à examiner dans le diagnostic du document).`] : []),
      'Coût indicatif : moyenne observée des analyses T1 récentes, pas un devis. Suivi des analyses : BO › File d’attente IA (origine business-periods-v2-requalification).',
    ],
  };
}

const ORIGINE_FR: Record<string, string> = {
  ACCOUNT_SERVICE: 'métier (service du compte)', TECHNICAL: 'technique et essais', SHADOW: 'observation', UNDETERMINED: 'non déterminable',
};
const usdMicros = (m: number) => `${(m / 1_000_000).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} $`;

/**
 * Lot 113AF (#730) : rapport du rattrapage « IA : origine des coûts » —
 * avant / après, métier reclassé, technique réel, coût inconnu, non classables
 * et réconciliation (textes à valider par le PO).
 */
function aiCostClassification(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  if (action === 'restore') {
    const r = out.result as CostClassificationRestoreReport;
    return {
      headline: `Classement retiré : ${r.events} appel(s) et ${r.rollups} agrégat(s) journalier(s) reviennent au classement à la lecture (même règle).`,
      scriptRunId: r.runId, restorable: false,
      counters: [{ label: 'Appels remis sans classement figé', value: r.events }, { label: 'Agrégats remis sans classement figé', value: r.rollups }],
      ambiguous: { count: 0, samples: [] }, conflicts: { count: 0, samples: [] },
      warnings: ['Les coûts, l’ancien indicateur de quota et les traces d’origine n’ont jamais été modifiés.'],
    };
  }
  const r = out.result as CostClassificationReport;
  const sim = action === 'simulate';
  if (r.disabled || !r.before || !r.after) {
    return {
      headline: `Rien à classer : ${r.disabled ?? 'état illisible'}.`, scriptRunId: null, restorable: false, counters: [],
      ambiguous: { count: 0, samples: [] }, conflicts: { count: 0, samples: [] }, warnings: [],
    };
  }
  const st = r.after;
  const rec = r.reconciliation;
  const montant = (a: { calls: number; micros: number }) => `${usdMicros(a.micros)} (${a.calls} appel(s))`;
  const enAttente = r.before.pending.events + r.before.pending.rollups;
  return {
    headline: sim
      ? `Simulation (${r.rule}) : ${enAttente} ligne(s) sans origine figée — métier reclassé ${montant(st.reclassifiedToBusiness)}, `
        + `technique réel ${montant(st.after.TECHNICAL)}, non classable ${montant(st.after.UNDETERMINED)}.`
      : `Application (${r.rule}) : ${r.written.events} appel(s) et ${r.written.rollups} agrégat(s) classés${r.more ? ' — reste à classer, relancer' : ''}.`,
    scriptRunId: r.runId,
    restorable: !sim && r.written.events + r.written.rollups > 0,
    counters: [
      { label: 'Règle', value: r.rule },
      ...(r.runId ? [{ label: 'Identifiant de l’exécution (pour Restaurer)', value: r.runId }] : []),
      { label: 'Avant : « métier » selon l’ancien indicateur', value: montant(r.before.before.business) },
      { label: 'Avant : « technique » selon l’ancien indicateur', value: montant(r.before.before.technical) },
      ...(['ACCOUNT_SERVICE', 'TECHNICAL', 'SHADOW', 'UNDETERMINED'] as const).map((o) => ({ label: `Après : ${ORIGINE_FR[o]}`, value: montant(st.after[o]) })),
      { label: 'Métier reclassé (rangé en technique par l’ancien indicateur)', value: montant(st.reclassifiedToBusiness) },
      { label: 'Technique réel compté en métier par l’ancien indicateur', value: montant(st.movedToTechnical) },
      ...(['ACCOUNT_SERVICE', 'TECHNICAL', 'SHADOW', 'UNDETERMINED'] as const).map((o) => ({ label: `Appels au coût inconnu : ${ORIGINE_FR[o]}`, value: st.unknownCalls[o] })),
      { label: 'Lignes sans origine figée (avant)', value: enAttente },
      { label: 'Lignes sans origine figée (après)', value: st.pending.events + st.pending.rollups },
      ...(sim ? [] : [{ label: 'Appels classés', value: r.written.events }, { label: 'Agrégats journaliers classés', value: r.written.rollups }]),
      ...(rec ? [
        { label: 'Réconciliation : total avant = total après', value: rec.totalsMatch ? 'oui' : 'NON' },
        { label: 'Réconciliation : appels comptés deux fois (appel + agrégat)', value: rec.overlap.calls },
        ...(rec.costReport ? [{ label: 'Réconciliation : total de l’écran Coûts IA', value: `${usdMicros(rec.costReport.providerMicros)} (${rec.costReport.calls} appel(s)) — ${rec.costReport.matches ? 'identique' : 'différent'}` }] : []),
      ] : []),
    ],
    ambiguous: { count: r.nonClassifiable.rows, samples: r.nonClassifiable.samples },
    conflicts: { count: rec?.overlap.calls ?? 0, samples: (rec?.overlap.days ?? []).slice(0, SAMPLE_LIMIT).map((d) => `journée ${d} : appels présents et agrégat journalier`) },
    warnings: [
      ...(r.more ? ['Temps imparti écoulé : relancer « Appliquer » (rien n’est réécrit).'] : []),
      ...(rec && !rec.totalsMatch ? ['Totaux avant / après différents : ne pas appliquer, transmettre le rapport.'] : []),
      ...(rec?.costReport && !rec.costReport.matches ? ['Total de l’écran Coûts IA différent : des appels ont pu arriver pendant le contrôle ; relancer la simulation au calme.'] : []),
      ...(r.nonClassifiable.rows > 0 ? [`${r.nonClassifiable.rows} ligne(s) restent « non déterminables » : comptées à part, jamais attribuées à un compte.`] : []),
      'Aucun appel IA, aucun coût recalculé : montants figés à l’appel, régularisations comprises.',
    ],
  };
}

/** Lot 113AK (#736) : libellés des qualifications de provenance et de preuves (textes à valider par le PO). */
const PROVENANCE_FR: Record<string, string> = {
  RELINKED: 'provenance rétablie (données conservées du même document)', NOT_RECONSTRUCTIBLE: 'provenance non reconstituable (valeur conservée)',
  CONTRADICTION: 'unité présente sans l’extrait cité (constat)', SUPERSEDED_VERSION: 'fait actif d’une extraction remplacée (constat)',
  SOURCE_UNLINKED: 'source déliée', ASSET_DELETED: 'bien supprimé', ASSET_TRANSFERRED: 'bien transféré vers un autre compte',
  DOCUMENT_DELETED: 'document supprimé', DOCUMENT_PURGED: 'document purgé', DOCUMENT_TRANSFERRED: 'document transféré vers un autre compte',
  DOCUMENT_MERGED: 'document fusionné',
};

/** Libellés des rôles d'adresse (rapport du rattrapage 113AM). */
const ADDRESS_ROLE_FR: Readonly<Record<string, string>> = {
  CORRESPONDENCE: 'destinataire / souscripteur / facturation', DELIVERY: 'livraison', ISSUER: 'émetteur',
  INSTALLATION: 'lieu d’installation d’un appareil', OTHER_ASSET_LOCATION: 'adresse d’un autre bien', DOCUMENT_PARTY: 'partie au document',
  UNQUALIFIED: 'rôle non établi', PROPERTY_LOCATION: 'lieu du bien',
};

/**
 * Lot 113AM (#739) : rapport du rattrapage « Rattachements : liens
 * automatiques fondés sur une adresse de correspondance ».
 */
function documentAddressLinks(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  const vide = { ambiguous: { count: 0, samples: [] }, conflicts: { count: 0, samples: [] } };
  if (action === 'restore') {
    const r = out.result as AddressLinkRestoreReport;
    return {
      headline: `Restauration : ${r.restored} lien(s) remis ; ${r.skipped} lien(s) modifié(s) depuis, laissé(s) tel(s) quel(s).`,
      scriptRunId: r.runId, restorable: false, ...vide,
      counters: [{ label: 'Liens remis', value: r.restored }, { label: 'Liens laissés tels quels', value: r.skipped }],
      warnings: ['Le journal de la garde est conservé (lignes marquées « restaurées »).'],
    };
  }
  const r = out.result as AddressLinkRepairReport;
  if (r.disabled) return { headline: `Rien à faire : ${r.disabled}.`, scriptRunId: null, restorable: false, counters: [], ...vide, warnings: [] };
  const sim = action === 'simulate';
  return {
    headline: sim
      ? `Simulation : ${r.erroneous} lien(s) automatique(s) fondé(s) sur une adresse qui n’est pas celle du lieu du bien, sur ${r.examined} examiné(s) ; rien n’est écrit.`
      : `Application : ${r.repaired} lien(s) retiré(s) sur ${r.erroneous} détecté(s)${r.more ? ' — reste à traiter, relancer' : ''}.`,
    scriptRunId: r.runId,
    restorable: !sim && r.repaired > 0,
    counters: [
      ...(r.runId ? [{ label: 'Identifiant de l’exécution (pour Restaurer)', value: r.runId }] : []),
      { label: 'Comptes examinés', value: r.accounts },
      { label: 'Liens automatiques examinés', value: r.examined },
      { label: 'Conservés : autre preuve que l’adresse', value: r.kept.proven },
      { label: 'Conservés : aucune adresse du bien dans le document', value: r.kept.noAddressMatch },
      { label: 'Conservés : connaissance du document indisponible', value: r.kept.noKnowledge },
      { label: 'Fondés sur une adresse de correspondance', value: r.erroneous },
      ...(sim ? [] : [
        { label: 'Liens retirés', value: r.repaired },
        { label: 'Biens réconciliés', value: r.derived.reconciled },
        { label: 'Rattachements réexaminés', value: r.derived.resolutionRequested },
        { label: 'Effets dérivés en échec', value: r.derived.failed },
      ]),
    ],
    ambiguous: { count: 0, samples: [] },
    conflicts: {
      count: r.erroneous,
      samples: echantillon(r.samples, (x) => `compte ${x.accountId} · document ${x.fileId} · bien ${x.assetId} · lien ${x.linkId} (${x.origin}, ${x.role}) — adresse : ${ADDRESS_ROLE_FR[x.addressRole] ?? x.addressRole}${x.repaired ? ' — retiré' : ''}`),
    },
    warnings: sim ? [] : ['Les liens confirmés par l’utilisateur ne sont jamais touchés.'],
  };
}

/**
 * Lot 113AK (#736) : rapport du rattrapage « T1 : provenance des faits et
 * preuves orphelines » — compteurs par statut, échantillons consultables
 * (compte, document, fait / preuve, unité, statut, cause).
 */
function sourceUnitProvenance(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  if (action === 'restore') {
    const r = out.result as ProvenanceRestoreReport;
    return {
      headline: `Restauration : ${r.facts} fait(s) et ${r.evidence} preuve(s) remis dans leur état d’avant ; ${r.skipped} objet(s) modifié(s) depuis, laissé(s) tel(s) quel(s).`,
      scriptRunId: r.runId, restorable: false,
      counters: [{ label: 'Faits restaurés', value: r.facts }, { label: 'Preuves restaurées', value: r.evidence }, { label: 'Objets laissés tels quels', value: r.skipped }],
      ambiguous: { count: 0, samples: [] }, conflicts: { count: 0, samples: [] },
      warnings: ['Le journal de provenance est conservé (lignes marquées « restaurées »).'],
    };
  }
  const r = out.result as ProvenanceCatchupReport;
  if (r.disabled) {
    return { headline: `Rien à faire : ${r.disabled}.`, scriptRunId: null, restorable: false, counters: [],
      ambiguous: { count: 0, samples: [] }, conflicts: { count: 0, samples: [] }, warnings: [] };
  }
  const sim = action === 'simulate';
  const f = r.facts;
  const e = r.evidence;
  const ecrit = r.written.relinked + r.written.notReconstructible + r.written.evidenceWithdrawn;
  const ligne = (x: ProvenanceCatchupReport['samples'][number]) =>
    `compte ${x.accountId} · document ${x.fileId}${x.factId ? ` · fait ${x.factId}` : ''}${x.evidenceId ? ` · preuve ${x.evidenceId}` : ''}`
    + `${x.assetId ? ` · bien ${x.assetId}` : ''}${x.unit ? ` · unité ${x.unit}` : ''} — ${PROVENANCE_FR[x.status] ?? x.status} (${x.cause})`;
  return {
    headline: sim
      ? `Simulation : ${f.broken} fait(s) à lien cassé (${f.relinkable} rétabli(s), ${f.notReconstructible} non reconstituable(s)), `
        + `${e.withdrawable} preuve(s) active(s) orpheline(s) ; rien n’est écrit.`
      : `Application : ${r.written.relinked} provenance(s) rétablie(s), ${r.written.notReconstructible} fait(s) qualifié(s) non reconstituable(s), `
        + `${r.written.evidenceWithdrawn} preuve(s) retirée(s) de l’usage actif${r.more ? ' — reste à traiter, relancer' : ''}.`,
    scriptRunId: r.runId,
    restorable: !sim && ecrit > 0,
    counters: [
      ...(r.runId ? [{ label: 'Identifiant de l’exécution (pour Restaurer)', value: r.runId }] : []),
      { label: 'Comptes examinés', value: r.accounts },
      { label: 'Documents examinés', value: r.documents },
      { label: 'Faits actifs examinés (avec provenance)', value: f.examined },
      { label: 'Faits à provenance valide', value: f.valid },
      { label: 'Références historiques (faits supersédés, légitimes)', value: f.historicalReferences },
      { label: 'Faits hors périmètre (document supprimé)', value: f.outOfScope },
      { label: 'Faits à lien cassé', value: f.broken },
      { label: '… dont provenance rétablie', value: f.relinkable },
      { label: '… dont provenance non reconstituable', value: f.notReconstructible },
      { label: 'Faits dont l’identifiant manquant existe dans un AUTRE document (jamais utilisé)', value: f.crossDocumentIds },
      { label: 'Contradictions (constat)', value: f.contradictions },
      { label: 'Faits actifs d’une extraction remplacée (constat)', value: f.supersededVersion },
      { label: 'Faits d’un document d’un autre compte (constat)', value: f.sourceUnlinked },
      { label: 'Couche source pas encore reconstruite (reprise historique en cours)', value: f.layerPending },
      { label: 'Déjà qualifiés non reconstituables', value: f.alreadyNotReconstructible },
      { label: 'Preuves actives examinées', value: e.examined },
      { label: 'Preuves valides', value: e.valid },
      { label: 'Preuves de biens archivés, vendus ou transmis (historique légitime)', value: e.historicalArchived },
      ...Object.entries(e.byStatus).map(([k, n]) => ({ label: `Preuves orphelines : ${PROVENANCE_FR[k] ?? k}`, value: n })),
      ...(sim ? [] : [
        { label: 'Provenances rétablies', value: r.written.relinked },
        { label: 'Faits qualifiés non reconstituables', value: r.written.notReconstructible },
        { label: 'Preuves retirées de l’usage actif', value: r.written.evidenceWithdrawn },
        { label: 'Lignes de journal écrites', value: r.written.events },
      ]),
    ],
    ambiguous: { count: f.contradictions + f.supersededVersion + f.sourceUnlinked, samples: r.samples.filter((x) => ['CONTRADICTION', 'SUPERSEDED_VERSION', 'SOURCE_UNLINKED'].includes(x.status) && x.factId).slice(0, SAMPLE_LIMIT).map(ligne) },
    conflicts: { count: f.broken + e.withdrawable, samples: r.samples.filter((x) => !(['CONTRADICTION', 'SUPERSEDED_VERSION'].includes(x.status) || (x.status === 'SOURCE_UNLINKED' && x.factId))).slice(0, SAMPLE_LIMIT).map(ligne) },
    warnings: [
      ...(r.more ? ['Temps imparti écoulé : relancer (rien n’est réécrit).'] : []),
      ...(r.assetsToReconcile.length ? [`${r.assetsToReconcile.length} bien(s) ont perdu des preuves : leurs valeurs ne sont pas modifiées ; elles seront réexaminées au prochain passage T3 du bien.`] : []),
      'Aucun appel IA, aucune réanalyse, aucune citation fabriquée ; aucune ligne supprimée.',
    ],
  };
}

/** Libellés des motifs de refus du rattrapage 91C (jamais de valeur dans le rapport). */
const REFUS_91C: Record<string, string> = {
  FIELD_STATES_REALIZATION: 'date d’achat (réalisation non prouvée)',
  SOURCE_NOT_ADMISSIBLE: 'type de document non admis pour le prix d’achat',
  TRANSACTION_NOT_PURCHASE: 'preuve de paiement, acompte ou avoir',
  NOT_EXPLICIT_EXTRACTION: 'valeur non extraite explicitement',
  TARGET_NOT_ESTABLISHED: 'bien non identifié ou supprimé',
  MULTI_ASSET: 'document multi-biens',
  MULTI_ASSET_UNKNOWN: 'analyse ancienne (multi-biens inconnu)',
  NO_LITERAL_EVIDENCE: 'aucun extrait littéral',
  PARTIAL_PAYMENT: 'acompte, dépôt de garantie, somme versée',
  VALUATION_NOT_PRICE: 'valeur estimée',
  CONFLICTUAL: 'lecture conflictuelle',
  KEY_NOT_RECOVERABLE: 'clé d’origine non retrouvée',
  DOCUMENT_NOT_LINKED_TO_TARGET: 'document plus rattaché au bien',
};

function projectionPropertyEvidence(out: RawBackfillOutput): BackfillSummary {
  const r = out.result as PropertyRepriseReport;
  const sim = r.mode === 'simulate';
  const ligne = (i: PropertyRepriseReport['items'][number]) => `compte ${i.accountId} · document ${i.fileId} · bien ${i.assetId ?? '—'} · fait ${i.factId}`
    + ` (${i.documentType ?? 'type inconnu'})${i.reason ? ` — ${REFUS_91C[i.reason] ?? i.reason}` : ''}${i.error ? ` — ${i.error}` : ''}`;
  const refus = Object.entries(r.refused);
  return {
    headline: `${sim ? 'Simulation' : 'Application'} : ${r.scanned} information(s) mise(s) de côté examinée(s), ${r.admitted} prix d’acquisition `
      + `${sim ? 'à reprendre' : `admis — ${r.requalified} repris, ${r.evidenceWritten} preuve(s) écrite(s), ${r.assetsReconciled} bien(s) réévalué(s) par T3`}. `
      + 'Aucun appel IA, aucune valeur saisie par l’utilisateur remplacée.',
    scriptRunId: null,
    restorable: false,
    counters: [
      { label: 'Informations examinées', value: r.scanned },
      { label: sim ? 'Prix à reprendre' : 'Prix admis', value: r.admitted },
      ...(sim ? [] : [
        { label: 'Prix repris', value: r.requalified },
        { label: 'Preuves écrites', value: r.evidenceWritten },
        { label: 'Biens mis en réévaluation T3', value: r.assetsReconciled },
      ]),
      ...refus.map(([k, v]) => ({ label: `Non repris : ${REFUS_91C[k] ?? k}`, value: v ?? 0 })),
      { label: 'Échecs', value: r.failed },
    ],
    ambiguous: { count: r.admitted, samples: echantillon(r.items.filter((i) => i.outcome === 'TO_REQUALIFY' || i.outcome === 'REQUALIFIED'), ligne) },
    conflicts: { count: r.failed, samples: echantillon(r.items.filter((i) => i.outcome === 'ERROR'), ligne) },
    warnings: [
      ...(r.more ? ['Périmètre non entièrement parcouru : relancer (rien n’est repris deux fois).'] : []),
      ...r.items.filter((i) => i.outcome === 'REFUSED').slice(0, SAMPLE_LIMIT).map((i) => `Non repris : ${ligne(i)}`),
    ],
  };
}

/** Lot 113AO (#748, B) : rattachement des appels T6 à leur exécution T6. */
function t6ExecutionAttribution(action: BackfillAction, out: RawBackfillOutput): BackfillSummary {
  if (action === 'restore') {
    const r = out.result as T6AttributionRestoreReport;
    return {
      headline: `Restauration : ${r.restored} appel(s) remis dans leur rattachement d’avant ; ${r.skipped} appel(s) modifié(s) depuis, laissé(s) tel(s) quel(s).`,
      scriptRunId: r.runId, restorable: false,
      counters: [{ label: 'Appels restaurés', value: r.restored }, { label: 'Appels laissés tels quels', value: r.skipped }, { label: 'Captures d’échange restaurées', value: r.captures }],
      ambiguous: { count: 0, samples: [] }, conflicts: { count: 0, samples: [] }, warnings: [],
    };
  }
  const r = out.result as T6AttributionReport;
  if (r.disabled) {
    return { headline: `Rien à faire : ${r.disabled}.`, scriptRunId: null, restorable: false, counters: [],
      ambiguous: { count: 0, samples: [] }, conflicts: { count: 0, samples: [] }, warnings: [] };
  }
  const sim = action === 'simulate';
  const prouves = r.proven.formulate + r.proven.evaluate;
  const ligne = (x: T6AttributionReport['items'][number]) =>
    `appel ${x.usageEventId} · compte ${x.accountId ?? '—'} · ${x.operation} · ${x.previous} → ${x.next ?? (x.ids ?? []).join(', ') ?? '—'}${x.reason ? ` — ${x.reason}` : ''}`;
  return {
    headline: sim
      ? `Simulation (${r.rule}) : ${r.examined} appel(s) T6 rattaché(s) à une autre exécution, ${prouves} rattachable(s) avec preuve, ${r.unproven} non prouvé(s) ; rien n’est écrit.`
      : `Application (${r.rule}) : ${r.written} appel(s) rattaché(s) à leur exécution T6${r.more ? ' — reste à traiter, relancer' : ''}.`,
    scriptRunId: r.runId,
    restorable: !sim && r.written > 0,
    counters: [
      ...(r.runId ? [{ label: 'Identifiant de l’exécution (pour Restaurer)', value: r.runId }] : []),
      { label: 'Appels T6 examinés', value: r.examined },
      { label: 'Formulations prouvées', value: r.proven.formulate },
      { label: 'Évaluations prouvées', value: r.proven.evaluate },
      ...(sim ? [] : [{ label: 'Appels rattachés', value: r.written }]),
      { label: 'Non prouvés (laissés tels quels)', value: r.unproven },
      { label: 'Exécutions T6 qui retrouvent leurs appels', value: r.executionsGaining },
      { label: 'Exécutions d’origine qui les perdent', value: r.executionsLosing },
      ...Object.entries(r.previousTreatments).map(([k, v]) => ({ label: `Rattachés jusqu’ici à ${k}`, value: v })),
    ],
    ambiguous: { count: r.unproven, samples: echantillon(r.items.filter((i) => i.outcome === 'UNPROVEN'), ligne) },
    conflicts: { count: r.items.filter((i) => i.outcome === 'CHANGED_SINCE').length, samples: echantillon(r.items.filter((i) => i.outcome === 'CHANGED_SINCE'), ligne) },
    warnings: [
      ...(r.more ? ['Périmètre non entièrement parcouru : relancer (rien n’est réécrit).'] : []),
      'L’exécution d’origine reste lisible comme déclencheur de chaque appel rattaché (lien de causalité).',
    ],
  };
}

export function summarizeBackfill(script: BackfillScript, action: BackfillAction, step: string | null, out: RawBackfillOutput): BackfillSummary {
  switch (script) {
    case 'database-restore-point': return databaseRestorePoint(action, out);
    case 'merge-rooms': return mergeRooms(action, out);
    case 'document-asset-links': return documentAssetLinks(out);
    case 'agenda': return agenda(step, out);
    case 'cdc15': return cdc15(action, out);
    case 'asset-account': return assetAccount(out);
    case 'operations-structured': return operationsStructured(out);
    case 'claims-legacy-cleanup': return step === 'finalize' ? claimsLegacyFinalize(out) : claimsLegacyCleanup(action, out);
    case 'cross-account': return crossAccount(action, out);
    case 'equipment-separation': return equipmentSeparation(out);
    case 'document-validation': return documentValidation(out);
    case 'duo-shared-account': return duoSharedAccount(action, out);
    case 'agenda-intervention-duplicates': return agendaInterventionDuplicates(action, out);
    case 'to-process-false-arbitrations': return falseArbitrations(out);
    case 'operations-v5-rebuild': return operationsV5Rebuild(action, out);
    case 'ai-history-reclassification': return aiHistoryReclassification(action, out);
    case 'missing-properties-catchup': return missingPropertiesCatchup(action, out);
    case 'projection-property-evidence': return projectionPropertyEvidence(out);
    case 'extract-chain-decision-review': return extractChainDecisionReview(action, out);
    case 'business-periods-v2-requalification': return businessPeriodsRequalification(action, out);
    case 'ai-cost-classification': return aiCostClassification(action, out);
    case 'source-unit-provenance': return sourceUnitProvenance(action, out);
    case 'document-address-links': return documentAddressLinks(action, out);
    case 't6-execution-attribution': return t6ExecutionAttribution(action, out);
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
