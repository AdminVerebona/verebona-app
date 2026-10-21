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
import type { ClaimMigrationReport } from '@/services/business-operations/consolidation/claim-migration';
import type { RemediationReport, RemediationRestoreReport } from '@/services/security/cross-account/remediation';
import type { DataSeparationReport } from '@/services/equipment/data-separation-backfill';
import type { ValidationRepriseReport } from '@/services/documents/validation-reprise';
import type { BackfillAction, BackfillScript } from './definitions';
import type { DuoSharedAccountReport, RestoreReport as DuoRestoreReport } from '@/services/account/duo-shared-account-backfill';

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

const CLAIM_OUTCOME_LABELS: Record<string, string> = {
  CREATED: 'créé', MATCHED: 'rapproché d’un sinistre existant', LINKED: 'déjà migré', RESYNCED: 'resynchronisé (ancien client)',
  BELOW_THRESHOLD: 'sous le seuil (rien créé)', HOLD_AMBIGUOUS: 'plusieurs sinistres possibles (rien créé)', EMPTY: 'vide', UNCHANGED: 'inchangé',
};

function operationsClaims(out: RawBackfillOutput): BackfillSummary {
  const r = out.result as ClaimMigrationReport;
  const simulation = r.mode === 'simulate';
  const n = (k: keyof typeof r.outcomes) => r.outcomes[k] ?? 0;
  return {
    headline: `${simulation ? 'Simulation' : 'Application'} : ${r.processed} bien(s) examiné(s) sur ${r.scanned}, `
      + `${n('CREATED')} sinistre(s) ${simulation ? 'à créer' : 'créé(s)'}, ${n('MATCHED') + n('LINKED')} rapproché(s), `
      + `${r.changes} écriture(s), ${r.failed.length} échec(s)${r.more ? ' — d’autres biens restent à examiner' : ''}.`,
    scriptRunId: null,
    restorable: false,
    counters: [
      { label: 'Biens examinés (ce passage)', value: r.scanned },
      { label: 'Écritures', value: r.changes },
      ...(['CREATED', 'MATCHED', 'LINKED', 'RESYNCED', 'BELOW_THRESHOLD', 'HOLD_AMBIGUOUS', 'EMPTY'] as const)
        .map((k) => ({ label: `Sinistres : ${CLAIM_OUTCOME_LABELS[k]}`, value: n(k) })),
    ],
    ambiguous: {
      count: r.holds.length,
      samples: echantillon(r.holds, (h) => `bien ${h.assetId} (compte ${h.accountId}) — ${CLAIM_OUTCOME_LABELS[h.outcome] ?? h.outcome}${h.reason ? ` · ${h.reason}` : ''}`),
    },
    conflicts: { count: r.failed.length, samples: echantillon(r.failed, (f) => `bien ${f.assetId} (compte ${f.accountId}) — ${f.error}`) },
    warnings: [],
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
  return {
    headline: sim
      ? `Simulation : ${c.operations} intervention(s) examinée(s) sur ${c.accounts} compte(s) — ${c.certain} consolidation(s) certaine(s), `
        + `${c.arbitration} identité(s) incertaine(s) (carte « À traiter »), ${c.noOperationGroups} groupe(s) sans Opération (signalés).`
      : `Application : ${c.consolidated} événement(s) absorbé(s), ${c.linked} lien(s) posé(s), ${c.retitled} intitulé(s) précisé(s), `
        + `${c.arbitration} arbitrage(s) proposé(s), ${c.protectedItems} événement(s) protégé(s).`,
    scriptRunId: sim ? null : r.runId,
    restorable: !sim,
    counters: [
      { label: 'Comptes examinés', value: c.accounts },
      { label: 'Interventions examinées', value: c.operations },
      { label: 'Consolidations certaines', value: c.certain },
      { label: 'Identités incertaines (arbitrage)', value: c.arbitration },
      { label: 'Résidus de fusion d’Opérations', value: c.residualsAfterMerge },
      { label: 'Doublons sans Opération (signalés, non traités)', value: c.noOperationGroups },
      ...(sim ? [] : [
        { label: 'Événements absorbés', value: c.consolidated },
        { label: 'Liens posés', value: c.linked },
        { label: 'Intitulés précisés', value: c.retitled },
        { label: 'Événements protégés (modifiés, confirmés, à qualifier)', value: c.protectedItems },
        { label: 'Projections créées', value: c.projectionsCreated },
      ]),
      { label: 'Comptes en erreur', value: c.errors },
    ],
    ambiguous: { count: arb.length, samples: echantillon(arb, (e) => `compte ${e.accountId} · intervention ${e.operationId} : ${String(e.detail.reason ?? '')}`) },
    conflicts: { count: 0, samples: [] },
    warnings: sans.slice(0, SAMPLE_LIMIT).map((e) => `Compte ${e.accountId} · document ${String(e.detail.fileId)} du ${String(e.detail.date)} : événements ${JSON.stringify(e.detail.itemIds)} sans Opération d’intervention (T3 n’a rien établi) — conservés.`),
  };
}

/** Synthèse lisible d'une exécution terminée (pure). */
export function summarizeBackfill(script: BackfillScript, action: BackfillAction, step: string | null, out: RawBackfillOutput): BackfillSummary {
  switch (script) {
    case 'merge-rooms': return mergeRooms(action, out);
    case 'document-asset-links': return documentAssetLinks(out);
    case 'agenda': return agenda(step, out);
    case 'cdc15': return cdc15(action, out);
    case 'asset-account': return assetAccount(out);
    case 'operations-structured': return operationsStructured(out);
    case 'operations-claims': return operationsClaims(out);
    case 'cross-account': return crossAccount(action, out);
    case 'equipment-separation': return equipmentSeparation(out);
    case 'document-validation': return documentValidation(out);
    case 'duo-shared-account': return duoSharedAccount(action, out);
    case 'agenda-intervention-duplicates': return agendaInterventionDuplicates(action, out);
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
