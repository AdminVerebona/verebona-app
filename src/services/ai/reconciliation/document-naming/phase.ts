/**
 * T3 — HARMONISATION DU NOMMAGE DOCUMENTAIRE (lot 61, ticket « [P2] T3 —
 * Harmonisation intelligente du nommage documentaire » ; fiabilisée au lot
 * 72B, ticket « [P1] T3 — Fiabiliser l’harmonisation documentaire », E1-E9).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * OÙ ? Phase DOCUMENT_NAMING du passage T3 du COMPTE (`reconcileAccount`),
 * après les biens, la connaissance ouverte et les « À traiter » : exécutions
 * manuelles (BO), planifiées (balayage horaire) et événementielles — UN SEUL
 * moteur. Non obligatoire : une erreur de nommage ne fait jamais échouer les
 * autres missions T3 (phase isolée, erreurs par lot).
 *
 * DÉROULÉ D'UN PASSAGE
 *   1. LECTURE EXHAUSTIVE (E1) : les documents éligibles sont lus PAGE PAR
 *      PAGE (`T3_NAMING_SCAN_PAGE_SIZE`) à partir d'un CURSEUR PERSISTANT
 *      (ligne d'état « * » du compte), au plus `T3_NAMING_SCAN_PAGES_PER_PASS`
 *      pages par passage ; chaque page alimente l'INDEX PERSISTANT
 *      (`document_naming_members` : empreinte et clés de rapprochement de
 *      chaque document). Aucun plafond : un compte de 20 000 documents ou plus
 *      est lu en entier, sur un ou plusieurs passages ; en fin de cycle, les
 *      documents devenus inéligibles sortent de l'index.
 *   2. LOTS (E4) : recalculés sur l'index COMPLET (composantes reliées par
 *      émetteur, SIREN, contrat, Opération) — une famille lue sur des pages
 *      ou des passages différents est examinée ensemble. Avant la première
 *      couverture complète du stock, aucun lot n'est examiné (lots
 *      incomplets) : « lecture du stock en cours », signalé.
 *   3. EXAMEN des lots dont l'état a changé (empreinte E3) ou jamais
 *      examinés, par appels bornés ; progression persistée après CHAQUE
 *      appel (reprise exacte après interruption) ; réponses incomplètes
 *      (E9) jamais clôturées ; écritures échouées (E6) reprises sans nouvel
 *      appel ; propositions hors rôle TO_EXAMINE refusées (E7).
 *   4. ÉTAT DU COMPTE (E2, E8) : DONE seulement si le stock est couvert et
 *      qu'aucun lot ne reste à examiner ni à écrire ; sinon IN_PROGRESS avec
 *      la date de reprise exécutable (immédiate, fin du plafond journalier,
 *      délai d'erreur, vérification quotidienne de la version du prompt) —
 *      le balayage planifié réinscrit le compte à cette date, même sans bien.
 *
 * STABILITÉ : à état inchangé, aucun appel (empreinte du lot) ; un document
 * harmonisé n'est pas renommé à nouveau sans nouvelle information avant le
 * délai de stabilité (`T3_NAMING_COOLDOWN_DAYS`, 30 j).
 *
 * BORNES (variables d'environnement, défauts prudents) :
 *   · T3_DOCUMENT_NAMING_ENABLED (1) — 0 : phase désactivée (parade) ;
 *   · T3_NAMING_MAX_CALLS_PER_PASS (3) — appels par passage et par compte ;
 *   · T3_NAMING_MAX_CALLS_PER_DAY (24) — appels par compte sur 24 h ;
 *   · T3_NAMING_MAX_DOCUMENTS_PER_CALL (40) — documents par appel ;
 *   · T3_NAMING_COOLDOWN_DAYS (30) — délai de stabilité ;
 *   · T3_NAMING_SCAN_PAGE_SIZE (2000) — documents lus par page (lot 72B) ;
 *   · T3_NAMING_SCAN_PAGES_PER_PASS (50) — pages lues par passage (lot 72B).
 * Au-delà : le travail reste dû, repris au passage suivant.
 *
 * PROMPT : sans la section « BRANCHE TASK = DOCUMENT_NAMING » dans la
 * version ACTIVE du prompt maître T3, aucun appel ni renommage ; les lots dus
 * sont marqués PROMPT_UNAVAILABLE (une fois par version) et l'état est
 * DEFERRED (jamais DONE). Une sortie SANS `document_renames` est une réponse
 * incomplète (E9) : anomalie, reprise bornée, puis plus aucun rappel sur la
 * même version après `NAMING_INCOMPLETE_MAX` anomalies.
 *
 * LOT 76B — défauts résiduels du lot 72B (C1 à C6) :
 *   · C1 — les écritures restantes se lisent en BASE, tous passages
 *     confondus (`pendingWritesByGroup`) : un lot n'est DONE, et le compte
 *     n'est DONE, que sans aucune décision applicable en attente ; un lot
 *     terminé avec une écriture restante (état antérieur) est remis en
 *     reprise ; les décisions restantes sont reprises dès la fin de l'examen,
 *     sans appel IA ;
 *   · C2 — chaque décision validée est PERSISTÉE avant son application, dans
 *     la même transaction que la progression (`persistChunk`) ; si cette
 *     persistance échoue : aucune écriture, lot non terminé, motif
 *     DECISION_NOT_PERSISTED, réexamen IA annoncé comme tel (jamais une
 *     « reprise sans appel » d'une décision non sauvegardée) ;
 *   · C3 — la progression mémorise l'empreinte du contexte EXAMINÉ de chaque
 *     document ; à la reprise, un document modifié (et les autres membres de
 *     sa famille si ses données ont changé) est réexaminé, les autres gardent
 *     leur progression ; un renommage fait par l'examen lui-même est reconnu
 *     (justification déterministe) ;
 *   · C5 — un lot d'une version antérieure du contexte n'est recalé sans
 *     appel IA que sur PREUVE (`upgradeEvidence`) ; sinon UPGRADE_REVIEW :
 *     réexamen BORNÉ (`T3_NAMING_UPGRADE_REVIEWS_PER_PASS`, 1 par passage et
 *     par compte ; `T3_NAMING_UPGRADE_REVIEWS_PER_DAY`, 200 sur 24 h tous
 *     comptes ; plafonds d'appels existants), après tout autre travail ;
 *     reporting distinct : migration technique / réexamen attendu /
 *     réexamen effectué.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { envNumber } from '@/lib/env-number';
import { normalizeTitle } from '@/lib/documents/document-title-rules';
import { isExecutionCancelled, type ExecutionGuard } from '../../queue/execution-control';
import type { ReportEntry, ReportStep } from '../../execution-report/model';
import { namingOutputComplete, type T3DocumentNamingOutput } from '../master/t3-contract';
import {
  collidingProposals, judgeProposal, NAMING_MAX_LENGTH, RENAME_REFUSAL_LABEL,
  type NameOrigin, type NamingProposal, type NamingSnapshotDoc, type RenameRefusal,
} from './guards';
import {
  docSnapshotHash, documentFingerprint, examinedContextHash, groupFingerprint, groupMembers, groupSnapshot, isProtected, legacyGroupFingerprint,
  linkKeysOf, membersFingerprint, NAMING_CONTEXT_VERSION, NAMING_CONTEXT_VERSION_V1, NAMING_CONTEXT_VERSION_V2, nameHash, namingVariables, orderDocs,
  planChunks, reviewTargets, textHintRefs, upgradeEvidence, v2DocumentFingerprint, v2GroupFingerprint,
  type MemberGroup, type NamingDoc, type NamingDocDetail, type NamingDocState,
} from './context';
import type { GroupProgress, GroupState, NameTrace, RenameEvent, SaveGroupState } from './repository';
import type { NamingCall, NamingCallResult, NamingPromptStatus } from './model';

const namingEnabled = () => envNumber('T3_DOCUMENT_NAMING_ENABLED', 1) !== 0;
const namingCallsPerPass = () => Math.min(20, Math.floor(envNumber('T3_NAMING_MAX_CALLS_PER_PASS', 3, { min: 0 })));
const namingCallsPerDay = () => Math.min(500, Math.floor(envNumber('T3_NAMING_MAX_CALLS_PER_DAY', 24, { min: 0 })));
const namingDocsPerCall = () => Math.max(6, Math.min(100, Math.floor(envNumber('T3_NAMING_MAX_DOCUMENTS_PER_CALL', 40, { min: 6 }))));
const namingCooldownDays = () => envNumber('T3_NAMING_COOLDOWN_DAYS', 30, { min: 0 });
/** Lot 72B (E1) : documents lus par page (curseur persistant). */
const namingScanPageSize = () => Math.max(2, Math.min(10_000, Math.floor(envNumber('T3_NAMING_SCAN_PAGE_SIZE', 2_000, { min: 2 }))));
/** Lot 72B (E1) : pages lues par passage (au-delà, la lecture reprend au curseur au passage suivant). */
const namingScanPagesPerPass = () => Math.max(1, Math.min(1_000, Math.floor(envNumber('T3_NAMING_SCAN_PAGES_PER_PASS', 50, { min: 1 }))));
/** Ligne d'état réservée : état global du compte (curseur de lecture, stock, reprise). */
const ACCOUNT_MARKER = '*';
/** Lot 72B (E9) : réponses incomplètes successives tolérées sur une même version du prompt. */
const NAMING_INCOMPLETE_MAX = 3;
/** Lot 72B (E6) : tentatives de reprise d'une écriture avant réexamen du lot par l'IA. */
const NAMING_WRITE_RETRY_MAX = 5;
/** Lot 76B (C5) : réexamens « contexte enrichi » commencés par passage et par compte (0 : programme suspendu). */
const namingUpgradeReviewsPerPass = () => Math.min(20, Math.floor(envNumber('T3_NAMING_UPGRADE_REVIEWS_PER_PASS', 1, { min: 0 })));
/** Lot 76B (C5) : réexamens « contexte enrichi » sur 24 h glissantes, tous comptes confondus. */
const namingUpgradeReviewsPerDay = () => Math.min(100_000, Math.floor(envNumber('T3_NAMING_UPGRADE_REVIEWS_PER_DAY', 200, { min: 0 })));
/** Lignes « non examiné » détaillées au rapport (les autres sont comptées). */
const NOT_EXAMINED_DETAIL_MAX = 100;
const MINUTE = 60_000;
const HEURE = 3_600_000;

/**
 * État de la phase (E8), identique dans le rapport détaillé, la synthèse du
 * job et les phases du passage :
 *   · DONE — stock couvert, aucun lot à examiner, aucune écriture en attente ;
 *   · PARTIAL — travail fait pendant ce passage, il en reste ;
 *   · DEFERRED — rien n'a pu être fait (plafond, délai de reprise, prompt
 *     inutilisable), il en reste : reprise datée ;
 *   · FAILED — des lots ont échoué sans aucun progrès ;
 *   · DISABLED (variable) ; NOT_READY (migrations 0450 / 0513 absentes).
 */
export type NamingPhaseStatus = 'DONE' | 'PARTIAL' | 'DEFERRED' | 'FAILED' | 'DISABLED' | 'NOT_READY';

export interface NamingRemaining {
  /** Lots (≥ 2 documents) non terminés : à examiner, en reprise, en attente d'écriture. */
  groups: number;
  /** Documents de ces lots. */
  documents: number;
  /** Lots par motif (PASS_CAP, DAILY_CAP, PROMPT_WITHOUT_DOCUMENT_NAMING, RENAMES_SECTION_MISSING, WRITE_RETRY, SCAN_IN_PROGRESS…). */
  byReason: Record<string, number>;
  /** Prochaine reprise exécutable (null : immédiate ou rien à reprendre). */
  nextRetryAt: string | null;
  /** Détail des lots restants (50 au plus) : clé, documents, motif, reprise prévue. */
  details?: Array<{ key: string; documents: number; reason: string; retryAt: string | null }>;
}

export interface NamingScanResult {
  /** Le cycle de lecture courant a couvert tout le stock éligible. */
  complete: boolean;
  /** Au moins une couverture complète du stock a eu lieu (lots fiables). */
  coveredOnce: boolean;
  cycle: number;
  /** Documents lus pendant ce passage. */
  scanned: number;
  pages: number;
  /** Documents nouveaux ou modifiés dans l'index. */
  changed: number;
  /** Documents retirés de l'index (plus éligibles). */
  purged: number;
}

/** Lot 76B (C5) : recalage des lots examinés avec un contexte antérieur. */
export interface NamingUpgradeReport {
  /** Ce passage : migrations techniques (preuve faite, aucun appel), réexamens programmés, réexamens effectués. */
  technical: number;
  expected: number;
  reviewed: number;
  /** État du compte (tous passages) : lots recalés techniquement, réexamens encore attendus, réexamens faits. */
  totals: { technical: number; expected: number; reviewed: number };
}

export interface DocumentNamingPhaseResult {
  status: NamingPhaseStatus;
  promptAvailable: boolean | null;
  promptVersion: string | null;
  /** Documents éligibles dans l'index du compte. */
  documents: number;
  withoutContext: number;
  groups: number;
  groupsDue: number;
  groupsExamined: number;
  groupsCompleted: number;
  documentsExamined: number;
  families: number;
  inconsistentFamilies: number;
  proposals: number;
  applied: number;
  refused: number;
  conflicts: number;
  unchanged: number;
  failed: number;
  aiCalls: number;
  deferred: number;
  errors: number;
  /** Sorties sans section `document_renames` (réponse incomplète, E9). */
  renamesSectionMissing: number;
  /** Lot 72B (E6) : écritures en attente de reprise à la fin du passage ; reprises tentées pendant le passage. */
  pendingWrites: number;
  writesRetried: number;
  /** Lot 72B : lots examinés au lot 61 et inchangés, recalés sans appel IA (lot 76B : sur preuve seulement, C5). */
  rebaselined: number;
  /** Lot 76B (C2) : décisions validées NON sauvegardées (incident base) — aucune écriture, réexamen IA. */
  decisionsUnsaved?: number;
  /** Lot 76B (C3) : documents déjà examinés réinscrits à la reprise (contexte modifié pendant l'interruption). */
  documentsRevalidated?: number;
  /** Lot 76B (C5). */
  upgrade?: NamingUpgradeReport;
  scan: NamingScanResult;
  remaining: NamingRemaining;
  appliedFileIds: number[];
  reportId: number | null;
}

interface DocumentNamingDeps {
  callModel?: (p: NamingCall) => Promise<NamingCallResult>;
  promptStatus?: () => Promise<NamingPromptStatus>;
  callsWindow?: (accountId: number) => Promise<{ count: number; oldestAt: string | null }>;
  maxCallsPerPass?: number;
  maxCallsPerDay?: number;
  maxDocsPerCall?: number;
  cooldownDays?: number;
  /** Lot 76B (C5) : bornes du réexamen « contexte enrichi » (défauts : variables d'environnement). */
  maxUpgradeReviewsPerPass?: number;
  maxUpgradeReviewsPerDay?: number;
  upgradeReviewsLastDay?: () => Promise<number>;
  scanPageSize?: number;
  scanPagesPerPass?: number;
  now?: () => Date;
  /** Écriture du rapport (défaut : rapport d'exécution T3, lot 58). `false` : aucun rapport. */
  writeReport?: boolean;
}

const vide = (): DocumentNamingPhaseResult => ({
  status: 'DONE', promptAvailable: null, promptVersion: null, documents: 0, withoutContext: 0, groups: 0, groupsDue: 0,
  groupsExamined: 0, groupsCompleted: 0, documentsExamined: 0, families: 0, inconsistentFamilies: 0, proposals: 0, applied: 0,
  refused: 0, conflicts: 0, unchanged: 0, failed: 0, aiCalls: 0, deferred: 0, errors: 0, renamesSectionMissing: 0,
  pendingWrites: 0, writesRetried: 0, rebaselined: 0, decisionsUnsaved: 0, documentsRevalidated: 0,
  upgrade: { technical: 0, expected: 0, reviewed: 0, totals: { technical: 0, expected: 0, reviewed: 0 } },
  scan: { complete: false, coveredOnce: false, cycle: 0, scanned: 0, pages: 0, changed: 0, purged: 0 },
  remaining: { groups: 0, documents: 0, byReason: {}, nextRetryAt: null },
  appliedFileIds: [], reportId: null,
});

/** Lot dû ? (pure) — délais de reprise respectés, lot terminé dû seulement s'il a changé. */
export function groupDue(st: GroupState | undefined, fp: string, prompt: NamingPromptStatus, now: Date): boolean {
  if (!st) return true;
  const echu = !st.retryAfter || Date.parse(st.retryAfter) <= now.getTime();
  switch (st.status) {
    case 'PROMPT_UNAVAILABLE': return prompt.version !== st.promptVersion;
    case 'IN_PROGRESS':
    case 'DEFERRED':
    case 'ERROR':
    case 'WRITE_PENDING':
    case 'UPGRADE_REVIEW': return echu;
    default: return st.fingerprint !== fp;
  }
}

/** Ordre de service (pure) : écritures à reprendre, examens commencés, lots modifiés, stock jamais examiné, reprises, réexamens « contexte enrichi ». */
export function dueRank(st: GroupState | undefined): number {
  if (!st) return 2;
  if (st.status === 'WRITE_PENDING') return -1;
  if (st.status === 'IN_PROGRESS') return 0;
  if (st.status === 'DONE') return 1;
  if (st.status === 'UPGRADE_REVIEW') return 4;
  return 3;
}

/**
 * Lot terminé (pure) : examen complet, empreinte à jour ET aucune écriture
 * restante en base (lot 76B, C1 : `pendingWrites`, tous passages confondus).
 */
export function groupSettled(st: GroupState | undefined, fp: string, pendingWrites = 0): boolean {
  return !!st && st.status === 'DONE' && st.fingerprint === fp && pendingWrites === 0;
}

/** Motif d'un lot non terminé (pure). */
export function remainingReason(st: GroupState | undefined, capReason: string | undefined, pendingWrites = 0): string {
  if (!st) return capReason ?? 'NEVER_EXAMINED';
  switch (st.status) {
    case 'DONE': return capReason ?? (pendingWrites > 0 ? 'WRITE_RETRY' : 'CHANGED_NOT_EXAMINED');
    case 'IN_PROGRESS': return capReason ?? 'IN_PROGRESS';
    case 'PROMPT_UNAVAILABLE': return 'PROMPT_WITHOUT_DOCUMENT_NAMING';
    case 'WRITE_PENDING': return 'WRITE_RETRY';
    case 'UPGRADE_REVIEW': return capReason ?? 'CONTEXT_UPGRADE_REVIEW';
    case 'DEFERRED': return (st.lastError ?? '').split(' ')[0] || 'DEFERRED';
    default: return (st.lastError ?? '').startsWith('RENAMES_SECTION_MISSING') ? 'RENAMES_SECTION_MISSING'
      : (st.lastError ?? '').startsWith('WRITE_RETRY_EXHAUSTED') ? 'WRITE_RETRY_EXHAUSTED'
        : (st.lastError ?? '').startsWith('DECISION_NOT_PERSISTED') ? 'DECISION_NOT_PERSISTED' : 'AI_ERROR';
  }
}

/**
 * État de la phase (pure, E8). `progress` : un travail utile a été fait
 * pendant ce passage (examen, écriture, lecture d'un stock pas encore couvert).
 * Lot 76B (C1) : jamais DONE avec une écriture restante en base.
 */
export function namingPhaseStatus(p: { remainingGroups: number; scanComplete: boolean; progress: boolean; errors: number; pendingWrites?: number }): NamingPhaseStatus {
  if (p.remainingGroups === 0 && p.scanComplete && (p.pendingWrites ?? 0) === 0) return 'DONE';
  if (p.errors > 0 && !p.progress) return 'FAILED';
  return p.progress ? 'PARTIAL' : 'DEFERRED';
}

/**
 * Prochaine reprise exécutable d'un lot non terminé (pure) : `null` =
 * immédiate (prochain balayage). Prompt inutilisable : vérification
 * quotidienne (aucun appel tant que la version ne change pas).
 */
export function retryAtOf(st: GroupState | undefined, capReason: string | undefined, dailyFreeAt: string | null, now: Date): string | null {
  if (capReason === 'DAILY_CAP') return dailyFreeAt;
  if (capReason === 'UPGRADE_PASS_CAP') return null;
  if (!st || st.status === 'DONE') return null;
  if (st.status === 'PROMPT_UNAVAILABLE') return new Date(now.getTime() + 24 * HEURE).toISOString();
  return st.retryAfter;
}

interface ScanProgress {
  cycle: number;
  /** Dernier identifiant lu du cycle en cours ; `null` : aucun cycle en cours. */
  cursor: number | null;
  completedCycles: number;
  cycleStartedAt: string | null;
  lastCompletedAt: string | null;
  /** Documents lus pendant le cycle en cours / le dernier cycle complet. */
  seen: number;
  eligible: number;
}
interface MarkerProgress { scan: ScanProgress; remaining?: NamingRemaining }

const scanVierge = (): ScanProgress => ({ cycle: 0, cursor: null, completedCycles: 0, cycleStartedAt: null, lastCompletedAt: null, seen: 0, eligible: 0 });

interface Item {
  group: { key: string; docs: NamingDoc[] };
  ids: number[];
  fp: string;
  st: GroupState | undefined;
  /** Conventions héritées des lots constitutifs (lot recomposé) quand le lot n'a pas encore d'état. */
  inherited: unknown[];
}

/**
 * Phase DOCUMENT_NAMING d'un passage T3 de compte. Ne lève pas, sauf
 * interruption d'exécution (arrêt d'urgence, annulation du travail) — l'état
 * du compte reste alors « en cours » et le balayage le réinscrit.
 */
export async function runDocumentNamingPhase(
  accountId: number,
  opts: DocumentNamingDeps & { guard?: ExecutionGuard; accountRunId?: number | null; triggerCode?: string | null } = {},
): Promise<DocumentNamingPhaseResult> {
  const res = vide();
  if (!namingEnabled()) return { ...res, status: 'DISABLED' };
  const repo = await import('./repository');
  if (!(await repo.namingTablesReady())) return { ...res, status: 'NOT_READY' };
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const maxDocs = opts.maxDocsPerCall ?? namingDocsPerCall();
  const states = await repo.loadGroupStates(accountId);
  const save = async (st: SaveGroupState): Promise<void> => {
    await repo.saveGroupState(accountId, st);
    const avant = states.get(st.key);
    const { upgrade, reviewed, ...reste } = st;
    states.set(st.key, {
      ...reste, progress: (st.progress as GroupProgress | null) ?? null,
      lastReviewedAt: reviewed ? now().toISOString() : avant?.lastReviewedAt ?? null, updatedAt: now().toISOString(),
      upgradeState: upgrade ? upgrade.state : avant?.upgradeState ?? null, upgradeFrom: upgrade ? upgrade.from : avant?.upgradeFrom ?? null,
    });
  };
  const marker = states.get(ACCOUNT_MARKER);
  const mp: MarkerProgress = { scan: { ...scanVierge(), ...((marker?.progress as unknown as MarkerProgress | null)?.scan ?? {}) } };
  const saveMarker = (status: 'DONE' | 'IN_PROGRESS', retryAfter: string | null) => save({
    key: ACCOUNT_MARKER, status, fingerprint: null, progress: mp, snapshot: null, conventions: [], promptVersion: res.promptVersion,
    retryAfter, attempts: 0, documentCount: mp.scan.eligible, contextVersion: NAMING_CONTEXT_VERSION,
  });
  // E2 : « en cours » dès le début — une interruption laisse le compte réinscriptible.
  if (!marker || marker.status === 'DONE') await saveMarker('IN_PROGRESS', null);

  // ── 1. Lecture exhaustive à curseur persistant (E1) ──────────────────────
  const scan = await scanStep(accountId, mp, {
    repo, guard: opts.guard, now, saveMarker: () => saveMarker('IN_PROGRESS', null),
    pageSize: opts.scanPageSize ?? namingScanPageSize(), maxPages: opts.scanPagesPerPass ?? namingScanPagesPerPass(),
  });
  res.scan = scan;

  // ── 2. Lots, sur l'index complet (E4) ────────────────────────────────────
  const members = await repo.loadMembers(accountId);
  const hashes = new Map(members.map((m) => [m.id, m.hash]));
  const { groups, withoutContext } = groupMembers(members);
  const multi = groups.filter((g) => g.ids.length >= 2);
  res.documents = members.length;
  res.withoutContext = withoutContext.length;
  res.groups = multi.length;
  const items: Item[] = multi.map((g) => ({
    group: { key: g.key, docs: [] }, ids: g.ids,
    fp: membersFingerprint(g.ids.map((id) => ({ id, hash: hashes.get(id)! }))),
    st: states.get(g.key), inherited: states.has(g.key) ? [] : inheritedConventions(g, states),
  }));
  const fpNow = new Map(items.map((i) => [i.group.key, i.fp]));
  const rec = new NamingRecorder();
  let dailyFreeAt: string | null = null;
  const dailyFree = async () => {
    if (dailyFreeAt) return dailyFreeAt;
    const w = await (opts.callsWindow ?? repo.namingCallsWindow)(accountId).catch(() => ({ count: 0, oldestAt: null }));
    dailyFreeAt = new Date((w.oldestAt ? Date.parse(w.oldestAt) : now().getTime()) + 24 * HEURE + MINUTE).toISOString();
    return dailyFreeAt;
  };

  let examen = false;
  if (scan.coveredOnce) {
    // États de lots disparus (lot recomposé, documents supprimés) : retirés une fois le cycle couvert.
    if (scan.complete) {
      const actifs = new Set(items.map((i) => i.group.key));
      const orphelins = [...states.keys()].filter((k) => k !== ACCOUNT_MARKER && !actifs.has(k));
      if (orphelins.length) {
        await repo.supersedePendingWrites(accountId, orphelins);
        await repo.deleteGroupStates(accountId, orphelins);
        for (const k of orphelins) states.delete(k);
      }
      // C1 : décisions en attente d'un lot qui n'existe plus (aucun état) — sans objet, jamais bloquantes à vie.
      await repo.supersedePendingWritesExcept(accountId, [...actifs]);
    }
    // C1 : lot « terminé » avec une écriture restante en base (état antérieur au lot 76B) :
    // remis en reprise, jamais compté terminé.
    const pendants = await repo.pendingWritesByGroup(accountId);
    for (const it of items) {
      const n = pendants.get(it.group.key) ?? 0;
      if (n > 0 && it.st?.status === 'DONE') {
        await save({ ...it.st, status: 'WRITE_PENDING', progress: null, documentCount: it.ids.length, retryAfter: null, lastError: `WRITE_PENDING ${n}` });
        it.st = states.get(it.group.key);
      }
    }
    examen = await examineDueGroups(accountId, items, {
      repo, rec, res, maxDocs, now, opts, save, fpNow, dailyFree,
    });
  }

  // ── 4. État du compte et reporting (E2, E8) ──────────────────────────────
  const byReason: Record<string, number> = {};
  let restants = 0;
  let docsRestants = 0;
  const reprises: Array<string | null> = [];
  const details: NonNullable<NamingRemaining['details']> = [];
  // C1 : écritures restantes relues en BASE (tous passages confondus) — statuts et compteurs = état persisté.
  const pendantsFin = await repo.pendingWritesByGroup(accountId);
  for (const it of items) {
    const st = states.get(it.group.key);
    const fp = fpNow.get(it.group.key)!;
    const pend = pendantsFin.get(it.group.key) ?? 0;
    if (groupSettled(st, fp, pend)) continue;
    const cap = rec.capReasons.get(it.group.key);
    const motif = scan.coveredOnce ? remainingReason(st, cap, pend) : 'SCAN_IN_PROGRESS';
    byReason[motif] = (byReason[motif] ?? 0) + 1;
    restants++;
    docsRestants += it.ids.length;
    const quand = scan.coveredOnce ? (cap === 'DAILY_CAP' ? await dailyFree() : retryAtOf(st, cap, null, now())) : null;
    reprises.push(quand);
    if (details.length < 50) details.push({ key: it.group.key, documents: it.ids.length, reason: motif, retryAt: quand });
  }
  // Lecture du stock pas encore couverte sur ce cycle : jamais terminé, reprise immédiate.
  if (!scan.complete) { byReason.SCAN_IN_PROGRESS = Math.max(1, byReason.SCAN_IN_PROGRESS ?? 0); reprises.push(null); }
  const prochaine = reprises.length === 0 ? null : reprises.includes(null) ? null
    : (reprises as string[]).sort()[0];
  res.pendingWrites = [...pendantsFin.values()].reduce((a, b) => a + b, 0);
  res.remaining = { groups: restants, documents: docsRestants, byReason, nextRetryAt: prochaine, details };
  res.upgrade!.totals = await repo.upgradeTotals(accountId);
  const progres = res.groupsExamined > 0 || res.documentsExamined > 0 || res.applied > 0 || res.writesRetried > 0 || res.rebaselined > 0
    || (res.upgrade!.expected > 0) || (scan.pages > 0 && !scan.complete);
  res.status = namingPhaseStatus({
    remainingGroups: restants, scanComplete: scan.complete, progress: progres, errors: res.errors + res.renamesSectionMissing,
    pendingWrites: res.pendingWrites,
  });
  mp.remaining = res.remaining;
  await saveMarker(res.status === 'DONE' ? 'DONE' : 'IN_PROGRESS', res.status === 'DONE' ? null : prochaine);
  res.appliedFileIds = [...new Set(res.appliedFileIds)].sort((a, b) => a - b);
  if (examen && opts.writeReport !== false) res.reportId = await rec.write(accountId, res, opts, startedAt);
  return res;
}

/** Conventions des lots constitutifs d'un lot recomposé (aucune perte de convention). */
function inheritedConventions(g: MemberGroup, states: ReadonlyMap<string, GroupState>): unknown[] {
  const out: unknown[] = [];
  for (const k of g.keys) {
    const st = states.get(k);
    if (st && k !== ACCOUNT_MARKER) out.push(...st.conventions);
  }
  return out.slice(0, 20);
}

/** Une étape de lecture : pages à partir du curseur persistant (E1). */
async function scanStep(accountId: number, mp: MarkerProgress, c: {
  repo: typeof import('./repository');
  guard?: ExecutionGuard;
  now: () => Date;
  saveMarker: () => Promise<void>;
  pageSize: number;
  maxPages: number;
}): Promise<NamingScanResult> {
  const sc = mp.scan;
  if (sc.cursor == null) {
    sc.cycle += 1;
    sc.cursor = 0;
    sc.seen = 0;
    sc.cycleStartedAt = c.now().toISOString();
  }
  const out: NamingScanResult = { complete: false, coveredOnce: sc.completedCycles > 0, cycle: sc.cycle, scanned: 0, pages: 0, changed: 0, purged: 0 };
  let fin = false;
  while (out.pages < c.maxPages) {
    if (c.guard) await c.guard.assertActive('T3 harmonisation documentaire — lecture du stock');
    const docs = await c.repo.loadNamingDocsPage(accountId, sc.cursor!, c.pageSize);
    out.pages++;
    if (docs.length) {
      // C6 : indices textuels recalculés seulement à une nouvelle extraction (cache de l'index).
      const aCalculer = new Set(docs.filter((d) => d.textVersion !== c.repo.textVersionOf(d)).map((d) => d.id));
      if (aCalculer.size) {
        const avecTexte = docs.filter((d) => aCalculer.has(d.id) && d.extractionId != null).map((d) => d.id);
        const textes = avecTexte.length ? await c.repo.loadTextsForHints(accountId, avecTexte) : new Map<number, string>();
        for (const d of docs) if (aCalculer.has(d.id)) { d.textRefs = textHintRefs(textes.get(d.id)); d.textVersion = c.repo.textVersionOf(d); }
      }
      out.changed += await c.repo.upsertMembers(accountId, docs.map((d) => ({
        id: d.id, keys: linkKeysOf(d), hash: docSnapshotHash(d),
        ...(aCalculer.has(d.id) ? { textKeys: d.textRefs ?? [], textVersion: d.textVersion ?? '' } : {}),
      })));
      out.scanned += docs.length;
      sc.seen += docs.length;
      sc.cursor = docs[docs.length - 1].id;
    }
    if (docs.length < c.pageSize) { fin = true; break; }
    // Curseur persisté après chaque page (reprise exacte après interruption).
    if (out.pages < c.maxPages) await c.saveMarker();
  }
  // Budget atteint sur une page pleine : reste-t-il un document après le curseur ?
  if (!fin) fin = (await c.repo.loadNamingDocsPage(accountId, sc.cursor!, 1)).length === 0;
  if (fin) {
    out.purged = await c.repo.purgeIneligibleMembers(accountId);
    sc.cursor = null;
    sc.completedCycles += 1;
    sc.lastCompletedAt = c.now().toISOString();
    sc.eligible = sc.seen;
    out.complete = true;
    out.coveredOnce = true;
  }
  await c.saveMarker();
  return out;
}

interface ExamCtx {
  repo: typeof import('./repository');
  rec: NamingRecorder;
  res: DocumentNamingPhaseResult;
  prompt: NamingPromptStatus;
  maxDocs: number;
  cooldown: number;
  now: () => Date;
  callModel: (p: NamingCall) => Promise<NamingCallResult>;
  plafond: () => 'PASS_CAP' | 'DAILY_CAP' | null;
  dailyFree: () => Promise<string>;
  save: (st: SaveGroupState) => Promise<void>;
  fpNow: Map<string, string>;
  guard?: ExecutionGuard;
  accountRunId: number | null;
}

const V3 = NAMING_CONTEXT_VERSION;
/** Version du contexte d'un état antérieur (null : lot 61). */
const versionDe = (st: GroupState): string => (st.contextVersion === NAMING_CONTEXT_VERSION_V2 ? NAMING_CONTEXT_VERSION_V2 : NAMING_CONTEXT_VERSION_V1);
/** Empreinte d'un lot selon la formule d'une version antérieure (recalage prouvé, C5). */
const legacyFp = (docs: readonly NamingDoc[], version: string) => (version === NAMING_CONTEXT_VERSION_V2 ? v2GroupFingerprint(docs) : legacyGroupFingerprint(docs));
/** Lot d'une version antérieure dont le réexamen est programmé et dont rien n'a changé depuis : réexamen BORNÉ. */
const upgradeBorne = (it: Item) => it.st?.status === 'UPGRADE_REVIEW' && ((it.st.progress?.upgradeFp ?? it.fp) === it.fp);

/** Examen des lots dus. Rend vrai si un lot a été traité ou signalé (rapport à écrire). */
async function examineDueGroups(accountId: number, items: Item[], p: {
  repo: typeof import('./repository');
  rec: NamingRecorder;
  res: DocumentNamingPhaseResult;
  maxDocs: number;
  now: () => Date;
  opts: DocumentNamingDeps & { guard?: ExecutionGuard; accountRunId?: number | null };
  save: (st: SaveGroupState) => Promise<void>;
  fpNow: Map<string, string>;
  dailyFree: () => Promise<string>;
}): Promise<boolean> {
  const { repo, rec, res, opts, now } = p;
  const up = res.upgrade!;
  // Aucun lot non terminé : pas même la lecture du prompt.
  if (!items.some((i) => !groupSettled(i.st, i.fp))) return false;

  // C5 — lots examinés avec un contexte ANTÉRIEUR (lot 61 / 72B) et terminés :
  // l'égalité de l'ancienne empreinte ne vaut pas examen du contexte enrichi.
  let faitsModifies: string | null | undefined;
  for (const it of items) {
    const st = it.st;
    if (!st || st.status !== 'DONE' || st.contextVersion === V3 || st.fingerprint === it.fp || st.upgradeState === 'EXPECTED') continue;
    if (faitsModifies === undefined) faitsModifies = await repo.lastFactsChangeAt(accountId);
    const from = versionDe(st);
    const docs = await repo.loadNamingDocsByIds(accountId, it.ids);
    if (docs.length !== it.ids.length || legacyFp(docs, from) !== st.fingerprint) {
      // Modifié depuis son examen : réexamen normal (non borné), suivi comme réexamen attendu.
      await p.save({ ...st, documentCount: it.ids.length, upgrade: { state: 'EXPECTED', from, reason: 'CHANGED_SINCE_REVIEW' } });
      it.st = { ...st, upgradeState: 'EXPECTED', upgradeFrom: from };
      up.expected++;
      continue;
    }
    const preuve = upgradeEvidence(docs, from, st.lastReviewedAt ?? st.updatedAt ?? null, faitsModifies);
    if (preuve.safe) {
      // Migration TECHNIQUE : rien de nouvellement exploitable (démontré) — aucun appel IA.
      const fp = groupFingerprint(docs);
      await p.save({ ...st, fingerprint: fp, snapshot: groupSnapshot(docs), contextVersion: V3, documentCount: docs.length, progress: null,
        upgrade: { state: 'TECHNICAL', from, reason: 'NO_NEWLY_EXPLOITABLE_INFORMATION' } });
      it.st = { ...st, fingerprint: fp, contextVersion: V3, upgradeState: 'TECHNICAL', upgradeFrom: from };
      p.fpNow.set(it.group.key, fp);
      if (fp !== it.fp) await repo.updateMemberHashes(accountId, docs.map((d) => ({ id: d.id, hash: docSnapshotHash(d) })));
      it.fp = fp;
      res.rebaselined++;
      up.technical++;
    } else {
      // Réexamen MÉTIER attendu, BORNÉ et reprenable : conventions et noms conservés d'ici là.
      const raison = `CONTEXT_UPGRADE ${from}→${V3} : ${preuve.reasons.join(', ')}`;
      const progress: GroupProgress = { nextChunk: 0, chunks: 0, examined: [], startedAt: now().toISOString(), upgradeFp: it.fp };
      await p.save({ ...st, status: 'UPGRADE_REVIEW', progress, documentCount: it.ids.length, retryAfter: null, lastError: raison,
        upgrade: { state: 'EXPECTED', from, reason: preuve.reasons.join(', ') } });
      it.st = { ...st, status: 'UPGRADE_REVIEW', progress, retryAfter: null, lastError: raison, upgradeState: 'EXPECTED', upgradeFrom: from };
      up.expected++;
    }
  }
  const recalage = up.technical + up.expected > 0;
  if (!items.some((i) => !groupSettled(i.st, i.fp))) {
    if (recalage) rec.steps.push({ step: 'RECALAGE', status: 'OK', error: null, detail: { technical: up.technical, expected: up.expected } });
    return recalage;
  }

  const prompt = await (opts.promptStatus ?? (async () => (await import('./model')).documentNamingPromptStatus()))();
  res.promptAvailable = prompt.available;
  res.promptVersion = prompt.version;
  const rang = (i: Item) => (i.st?.status === 'UPGRADE_REVIEW' && !upgradeBorne(i) ? 1 : dueRank(i.st));
  const dus = items.filter((i) => !groupSettled(i.st, i.fp) && groupDue(i.st, i.fp, prompt, now()))
    .sort((a, b) => rang(a) - rang(b) || (a.st?.lastReviewedAt ?? '').localeCompare(b.st?.lastReviewedAt ?? '') || a.group.key.localeCompare(b.group.key));
  res.groupsDue = dus.length;
  if (recalage) rec.steps.push({ step: 'RECALAGE', status: 'OK', error: null, detail: { technical: up.technical, expected: up.expected } });
  if (!dus.length) return recalage;

  const parPassage = opts.maxCallsPerPass ?? namingCallsPerPass();
  const parJour = opts.maxCallsPerDay ?? namingCallsPerDay();
  const dejaJour = (await (opts.callsWindow ?? repo.namingCallsWindow)(accountId)).count;
  const plafond = (): 'PASS_CAP' | 'DAILY_CAP' | null =>
    res.aiCalls >= parPassage ? 'PASS_CAP' : dejaJour + res.aiCalls >= parJour ? 'DAILY_CAP' : null;
  const c: ExamCtx = {
    repo, rec, res, prompt, maxDocs: p.maxDocs, cooldown: opts.cooldownDays ?? namingCooldownDays(), now,
    callModel: opts.callModel ?? (async (x: NamingCall) => (await import('./model')).callDocumentNamingModel(x)),
    plafond, dailyFree: p.dailyFree, save: p.save, fpNow: p.fpNow, guard: opts.guard, accountRunId: opts.accountRunId ?? null,
  };

  // E6 : écritures à reprendre À CONTEXTE INCHANGÉ — sans appel IA, quel que soit l'état du prompt.
  const examiner: Item[] = [];
  for (const it of dus) {
    if (it.st?.status === 'WRITE_PENDING') {
      let inchange = it.st.fingerprint === it.fp;
      if (!inchange && it.st.fingerprint) {
        const docs = await repo.loadNamingDocsByIds(accountId, it.ids);
        inchange = docs.length !== it.ids.length ? false
          // État d'une version antérieure : contexte inchangé au sens de SA formule (le recalage prouvé suit, C5).
          : it.st.contextVersion !== V3 ? legacyFp(docs, versionDe(it.st)) === it.st.fingerprint
            // Reprise interrompue après une partie des écritures : seuls changements = nos propres écritures (C2).
            : onlyOwnWrites(docs, it.st.snapshot, await repo.loadNameTraces(accountId, it.ids));
      }
      if (inchange) {
        if (opts.guard) await opts.guard.assertActive(`T3 harmonisation documentaire — reprise d’écriture ${it.group.key}`);
        try {
          await retryWrites(accountId, it, c);
        } catch (e) {
          if (isExecutionCancelled(e)) throw e;
          res.errors++;
          rec.steps.push({ step: `REPRISE ${it.group.key}`, status: 'FAILED', error: ((e as Error).message ?? '').slice(0, 300) });
        }
        continue;
      }
      // Contexte changé depuis la décision : les écritures en attente sont sans objet, le lot est réexaminé.
      await repo.supersedePendingWrites(accountId, [it.group.key]);
    }
    examiner.push(it);
  }

  if (!prompt.available) {
    for (const it of examiner) {
      await p.save({
        key: it.group.key, status: 'PROMPT_UNAVAILABLE', fingerprint: it.st?.fingerprint ?? null, progress: it.st?.progress ?? null,
        snapshot: it.st?.snapshot ?? null, conventions: it.st?.conventions ?? it.inherited, promptVersion: prompt.version, retryAfter: null,
        attempts: it.st?.attempts ?? 0, documentCount: it.ids.length, contextVersion: it.st?.contextVersion ?? null,
        lastError: it.st?.lastError ?? null,
      });
      rec.notExamined(it, 'PROMPT_WITHOUT_DOCUMENT_NAMING', `Version active du prompt T3 sans branche DOCUMENT_NAMING (${prompt.version ?? 'version illisible'}) : aucune proposition, aucun renommage`);
    }
    if (examiner.length) rec.steps.push({ step: 'PROMPT', status: 'SKIPPED', error: null, detail: { version: prompt.version, branch: 'DOCUMENT_NAMING', available: false } });
    res.deferred += examiner.length;
    return true;
  }

  // C5 : bornes du réexamen « contexte enrichi » (par passage et par compte ; 24 h tous comptes).
  const upParPassage = opts.maxUpgradeReviewsPerPass ?? namingUpgradeReviewsPerPass();
  const upParJour = opts.maxUpgradeReviewsPerDay ?? namingUpgradeReviewsPerDay();
  let upCommences = 0;
  let upJour: number | null = null;
  for (const it of examiner) {
    const cap = plafond();
    if (cap) {
      res.deferred++;
      rec.notExamined(it, cap, cap === 'PASS_CAP' ? 'Plafond d’appels du passage atteint : repris au passage suivant' : 'Plafond journalier d’appels atteint : repris dans les 24 h');
      continue;
    }
    if (upgradeBorne(it)) {
      if (upCommences >= upParPassage) {
        res.deferred++;
        rec.notExamined(it, 'UPGRADE_PASS_CAP', `Réexamen « contexte enrichi » programmé : ${upParPassage} famille(s) au plus par passage, reprise au passage suivant`);
        continue;
      }
      upJour ??= await (opts.upgradeReviewsLastDay ?? repo.upgradeReviewsLastDay)().catch(() => upParJour);
      if (upJour >= upParJour) {
        res.deferred++;
        rec.notExamined(it, 'UPGRADE_DAILY_CAP', `Réexamen « contexte enrichi » : plafond global de ${upParJour} famille(s) sur 24 h atteint, reprise dans 1 h`);
        await p.save({ ...it.st!, documentCount: it.ids.length, retryAfter: new Date(now().getTime() + HEURE).toISOString() });
        continue;
      }
      upCommences++;
      upJour++;
    }
    if (opts.guard) await opts.guard.assertActive(`T3 harmonisation documentaire — lot ${it.group.key}`);
    try {
      await examineGroup(accountId, it, c);
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      // Erreur isolée : le lot est repris plus tard, les autres continuent.
      res.errors++;
      const motif = (e as Error).message?.slice(0, 300) ?? 'erreur';
      rec.steps.push({ step: `LOT ${it.group.key}`, status: 'FAILED', error: motif });
      rec.notExamined(it, 'AI_ERROR', `Erreur pendant l’examen du lot (${motif}) : repris dans 6 h`);
      await p.save({
        key: it.group.key, status: 'ERROR', fingerprint: it.st?.fingerprint ?? null, progress: it.st?.progress ?? null,
        snapshot: it.st?.snapshot ?? null, conventions: it.st?.conventions ?? it.inherited, promptVersion: prompt.version,
        retryAfter: new Date(now().getTime() + 6 * HEURE).toISOString(), attempts: (it.st?.attempts ?? 0) + 1,
        documentCount: it.ids.length, lastError: motif, contextVersion: it.st?.contextVersion ?? null,
      }).catch(() => undefined);
      console.error(`[t3-naming] lot ${it.group.key} du compte ${accountId} en erreur :`, motif);
    }
  }
  return true;
}

/**
 * Lot 76B (C2) — contexte d'un lot en reprise d'écriture inchangé, hormis les
 * renommages faits par ces reprises (pure) : chaque document a l'empreinte de
 * l'instantané, ou l'aurait avec le nom remplacé par sa dernière écriture
 * journalisée (ancien nom = nom de l'instantané). Composition identique exigée.
 */
function onlyOwnWrites(docs: readonly NamingDoc[], snapshot: Record<string, string> | null, traces: ReadonlyMap<number, NameTrace>): boolean {
  if (!snapshot || Object.keys(snapshot).length !== docs.length) return false;
  for (const d of docs) {
    const attendu = snapshot[String(d.id)];
    if (!attendu) return false;
    if (docSnapshotHash(d) === attendu) continue;
    const h = traces.get(d.id)?.harmonization;
    if (h && h.oldName != null && h.name.trim() === d.name.trim() && docSnapshotHash({ ...d, name: h.oldName }) === attendu) continue;
    return false;
  }
  return true;
}

/** Identifiants des documents d'une famille mémorisée (conventions décrites par l'IA). */
const famillesDe = (conventions: unknown[]): number[][] => conventions
  .map((x) => (x && typeof x === 'object' && Array.isArray((x as { documentIds?: unknown }).documentIds) ? ((x as { documentIds: unknown[] }).documentIds).map(Number) : []))
  .filter((l) => l.length > 0);

/**
 * C3 — revalidation, à la reprise, des documents déjà examinés (pure) :
 * empreinte du contexte EXAMINÉ (`ctx`) comparée au contexte courant.
 *   · document sorti du lot : retiré ;
 *   · données modifiées (ou empreinte inconnue : progression antérieure au
 *     lot 76B, aucune preuve) : réinscrit, avec les autres membres de sa
 *     famille (familles décrites par l'IA) ;
 *   · seul le nom a changé : réinscrit, sauf si ce changement est
 *     l'écriture faite par l'examen lui-même (journal : ancien nom = nom
 *     examiné, nouveau nom = nom en place) — justification déterministe.
 * Les documents inchangés gardent leur progression.
 */
export function revalidateExamined(p: {
  examined: readonly number[];
  ctx: Readonly<Record<string, string>>;
  docs: readonly NamingDoc[];
  traces: ReadonlyMap<number, NameTrace>;
  conventions: unknown[];
}): { keep: number[]; ctx: Record<string, string>; reexamine: number[]; removed: number[]; dataChanged: number[] } {
  const parId = new Map(p.docs.map((d) => [d.id, d]));
  const ctx: Record<string, string> = {};
  const removed: number[] = [];
  const modifies = new Set<number>();
  const donnees: number[] = [];
  for (const id of p.examined) {
    const d = parId.get(id);
    if (!d) { removed.push(id); continue; }
    const avant = p.ctx[String(id)];
    const maintenant = examinedContextHash(d);
    if (!avant) { modifies.add(id); donnees.push(id); continue; }
    const [dAvant, nAvant] = avant.split(':');
    const [dMaint, nMaint] = maintenant.split(':');
    if (dAvant !== dMaint) { modifies.add(id); donnees.push(id); continue; }
    if (nAvant !== nMaint) {
      const h = p.traces.get(id)?.harmonization;
      const parExamen = !!h && h.name.trim() === d.name.trim() && h.oldName != null && nameHash(h.oldName) === nAvant;
      if (!parExamen) { modifies.add(id); continue; }
    }
    ctx[String(id)] = maintenant;
  }
  for (const fam of famillesDe(p.conventions)) {
    if (fam.some((x) => donnees.includes(x))) for (const x of fam) if (p.examined.includes(x) && parId.has(x)) modifies.add(x);
  }
  for (const id of modifies) delete ctx[String(id)];
  const keep = p.examined.filter((id) => parId.has(id) && !modifies.has(id));
  return { keep, ctx, reexamine: [...modifies].sort((a, b) => a - b), removed, dataChanged: donnees };
}

/** Examen (éventuellement partiel, repris ensuite) d'un lot. */
async function examineGroup(accountId: number, it: Item, c: ExamCtx): Promise<void> {
  const { repo, rec, res } = c;
  const lus = await repo.loadNamingDocsByIds(accountId, it.ids);
  // Documents de l'index devenus inéligibles depuis la lecture : retirés (empreinte cohérente).
  if (lus.length !== it.ids.length) {
    const presents = new Set(lus.map((d) => d.id));
    await repo.deleteMembers(accountId, it.ids.filter((id) => !presents.has(id)));
  }
  const g = { key: it.group.key, docs: orderDocs(lus) };
  it.group = g;
  const upgradeFait = it.st?.upgradeState === 'EXPECTED'
    ? { state: 'REVIEWED' as const, from: it.st.upgradeFrom ?? it.st.contextVersion ?? NAMING_CONTEXT_VERSION_V1, reason: 'Réexamen effectué avec le contexte enrichi' }
    : undefined;
  if (g.docs.length < 2) {
    // Lot réduit à un document depuis la lecture : rien à harmoniser (décisions en attente sans objet).
    await repo.supersedePendingWrites(accountId, [g.key]);
    const fp = groupFingerprint(g.docs);
    c.fpNow.set(g.key, fp);
    await c.save({ key: g.key, status: 'DONE', fingerprint: fp, progress: null, snapshot: groupSnapshot(g.docs), conventions: it.st?.conventions ?? it.inherited,
      promptVersion: c.prompt.version, retryAfter: null, attempts: 0, documentCount: g.docs.length, contextVersion: V3, upgrade: upgradeFait });
    if (upgradeFait) res.upgrade!.reviewed++;
    return;
  }
  const reprise = it.st?.status === 'IN_PROGRESS' || ((it.st?.status === 'DEFERRED' || it.st?.status === 'ERROR') && !!it.st?.progress);
  const startedAt = reprise ? it.st?.progress?.startedAt ?? c.now().toISOString() : c.now().toISOString();
  let conventions: unknown[] = it.st?.conventions?.length ? it.st.conventions : it.inherited;
  const traces = await repo.loadNameTraces(accountId, g.docs.map((d) => d.id));
  let examines = new Set<number>();
  let ctx: Record<string, string> = {};
  if (!reprise) {
    // Examen neuf : les décisions antérieures non appliquées sont remplacées par celles de cet examen (C1, C2).
    await repo.supersedePendingWrites(accountId, [g.key]);
  } else {
    // C3 : revalidation des documents déjà examinés (nouvelle information pendant l'interruption).
    const r = revalidateExamined({ examined: it.st?.progress?.examined ?? [], ctx: it.st?.progress?.ctx ?? {}, docs: g.docs, traces, conventions });
    examines = new Set(r.keep);
    ctx = r.ctx;
    if (r.reexamine.length || r.removed.length) {
      await repo.supersedePendingWritesForFiles(accountId, g.key, [...r.reexamine, ...r.removed]);
      res.documentsRevalidated = (res.documentsRevalidated ?? 0) + r.reexamine.length;
      rec.steps.push({ step: `REVALIDATION ${g.key}`, status: 'OK', error: null, detail: {
        reexamined: r.reexamine, dataChanged: r.dataChanged, removed: r.removed, kept: r.keep.length,
      } });
    }
  }
  const cibles = reviewTargets(g.docs, it.st?.snapshot ?? null, c.maxDocs).filter((d) => !examines.has(d.id));
  const chunks = planChunks(g.docs, cibles, c.maxDocs);
  // Noms en mémoire, mis à jour au fil des écritures confirmées (empreinte finale).
  const courants = new Map<number, NamingDoc>(g.docs.map((d) => [d.id, d]));
  let examineQuelqueChose = false;
  let echecs = 0;
  // Version du contexte conservée tant que l'examen n'est pas terminé (recalage suivi, C5) ; lot neuf : version courante.
  const versionEnCours = it.st ? it.st.contextVersion ?? null : V3;

  const etatEnCours = (status: GroupState['status'], extra: Partial<SaveGroupState> = {}): SaveGroupState => ({
    key: g.key, status, fingerprint: it.st?.fingerprint ?? null,
    progress: { nextChunk: 0, chunks: chunks.length, examined: [...examines], startedAt, ctx: { ...ctx } } satisfies GroupProgress,
    snapshot: it.st?.snapshot ?? null, conventions, promptVersion: c.prompt.version, retryAfter: null,
    attempts: it.st?.attempts ?? 0, documentCount: g.docs.length, contextVersion: versionEnCours,
    lastError: null, ...extra,
  });
  const sauver = (status: GroupState['status'], extra: Partial<SaveGroupState> = {}) => c.save(etatEnCours(status, extra));

  for (const chunk of chunks) {
    const cap = c.plafond();
    if (cap) {
      // Reprise exacte (documents déjà examinés conservés), datée au plafond journalier.
      await sauver('IN_PROGRESS', { retryAfter: cap === 'DAILY_CAP' ? await c.dailyFree() : null, lastError: cap });
      res.deferred++;
      rec.notExamined(it, cap, `Lot volumineux : ${examines.size}/${g.docs.length} document(s) examiné(s), suite ${cap === 'DAILY_CAP' ? 'à la libération du plafond journalier' : 'au passage suivant'}`);
      if (examineQuelqueChose) res.groupsExamined++;
      return;
    }
    if (c.guard) await c.guard.assertActive(`T3 harmonisation documentaire — lot ${g.key}`);
    const appel = [...chunk.targets, ...chunk.references].map((d) => courants.get(d.id) ?? d);
    const cibleIds = new Set(chunk.targets.map((d) => d.id));
    const etats = new Map<number, NamingDocState & { trace?: NameTrace }>();
    for (const d of appel) {
      const t = traces.get(d.id);
      const dates = [t?.harmonization?.at, t?.titleEvent?.at].filter((x): x is string => !!x).sort();
      etats.set(d.id, { origin: repo.deriveNameOrigin(d, t), lastRenamedAt: dates[dates.length - 1] ?? null, trace: t });
    }
    const details = await repo.loadDocDetails(accountId, appel.map((d) => d.id));
    attachMatchHints(details, appel, [...courants.values()]);
    const variables = namingVariables({
      group: { key: g.key, docs: [...courants.values()] }, chunk: { ...chunk, targets: chunk.targets.map((d) => courants.get(d.id) ?? d), references: chunk.references.map((d) => courants.get(d.id) ?? d) },
      conventions, states: etats, details, maxLength: NAMING_MAX_LENGTH,
    });
    res.aiCalls++;
    let sortie: NamingCallResult;
    try {
      sortie = await c.callModel({ accountId, sourceIds: appel.map((d) => d.id).sort((a, b) => a - b), variables });
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      const { isAiGatewayError } = await import('../../gateway/errors');
      const code = isAiGatewayError(e) ? e.code : 'UNKNOWN';
      const motif = `${code} : ${((e as Error).message ?? '').slice(0, 200)}`;
      if (code === 'MASTER_PROMPT_INVALID') {
        await sauver('PROMPT_UNAVAILABLE', { lastError: motif });
        rec.notExamined(it, 'PROMPT_WITHOUT_DOCUMENT_NAMING', `Prompt T3 refusé par la passerelle (${motif}) : aucun renommage`);
        res.deferred++;
        return;
      }
      const delai = code === 'COST_CAP_REACHED' ? 24 * HEURE : code === 'AI_BLOCKED' ? HEURE : 6 * HEURE;
      const reporte = code === 'COST_CAP_REACHED' || code === 'AI_BLOCKED';
      await sauver(reporte ? 'DEFERRED' : 'ERROR', {
        retryAfter: new Date(c.now().getTime() + delai).toISOString(), lastError: motif, attempts: (it.st?.attempts ?? 0) + (reporte ? 0 : 1),
      });
      if (reporte) res.deferred++; else res.errors++;
      rec.steps.push({ step: `APPEL ${g.key} ${chunk.index + 1}/${chunk.count}`, status: 'FAILED', error: motif });
      rec.notExamined(it, reporte ? String(code) : 'AI_ERROR', `Appel IA impossible (${motif}) : lot repris plus tard, aucun renommage`);
      if (examineQuelqueChose) res.groupsExamined++;
      return;
    }
    if (sortie.traceId) rec.traceIds.add(sortie.traceId);
    const out: T3DocumentNamingOutput = sortie.output;
    rec.steps.push({ step: `APPEL ${g.key} ${chunk.index + 1}/${chunk.count}`, status: namingOutputComplete(out) ? 'OK' : 'FAILED', error: namingOutputComplete(out) ? null : 'RENAMES_SECTION_MISSING', detail: {
      toExamine: chunk.targets.map((d) => d.id), references: chunk.references.map((d) => d.id), traceId: sortie.traceId,
      families: out.families?.length ?? 0, proposals: out.document_renames?.length ?? null,
    } });
    // E9 : section absente = réponse INCOMPLÈTE — jamais « rien à renommer ».
    if (!namingOutputComplete(out)) {
      res.renamesSectionMissing++;
      const precedentes = (it.st?.lastError ?? '').startsWith('RENAMES_SECTION_MISSING') ? it.st?.attempts ?? 0 : 0;
      const n = precedentes + 1;
      const bloque = n >= NAMING_INCOMPLETE_MAX;
      const motif = `RENAMES_SECTION_MISSING (${n}/${NAMING_INCOMPLETE_MAX}, prompt ${c.prompt.version ?? '?'})`;
      await sauver(bloque ? 'PROMPT_UNAVAILABLE' : 'ERROR', {
        retryAfter: bloque ? null : new Date(c.now().getTime() + 6 * n * HEURE).toISOString(), lastError: motif, attempts: n,
      });
      rec.notExamined(it, 'RENAMES_SECTION_MISSING', bloque
        ? `Sortie IA sans section document_renames (${n} fois sur la version ${c.prompt.version ?? '?'}) : plus aucun appel tant que la version du prompt ne change pas`
        : `Sortie IA sans section document_renames : réponse incomplète, lot non clôturé, nouvelle tentative dans ${6 * n} h`);
      console.warn(`[t3-naming] compte ${accountId}, lot ${g.key} : sortie sans document_renames (${n}/${NAMING_INCOMPLETE_MAX})`);
      if (examineQuelqueChose) res.groupsExamined++;
      return;
    }
    examineQuelqueChose = true;
    // Familles décrites par l'IA (reporting, mémoire de convention).
    const idsAppel = new Set(appel.map((d) => d.id));
    for (const f of out.families ?? []) {
      res.families++;
      if (f.inconsistent) res.inconsistentFamilies++;
      rec.family(g.key, f, idsAppel);
    }
    const conventionsAvant = conventions;
    if (out.families?.length) conventions = mergeConventions(conventions, out.families);
    const jugement = await judgeProposals(accountId, out.document_renames ?? [], {
      it, appel, cibles: cibleIds, etats, courants, c, traceId: sortie.traceId,
      callKey: `${it.fp}:${chunk.index}:${[...idsAppel].sort((a, b) => a - b).join(',')}`,
    });
    // C2 : progression (documents examinés + empreinte de leur contexte) et décisions validées
    // persistées ENSEMBLE, AVANT toute écriture.
    const examinesAvant = new Set(examines);
    const ctxAvant = { ...ctx };
    for (const d of chunk.targets) { examines.add(d.id); ctx[String(d.id)] = examinedContextHash(courants.get(d.id) ?? d); }
    let persistees: Awaited<ReturnType<typeof repo.persistChunk>>;
    try {
      persistees = await repo.persistChunk(accountId, etatEnCours('IN_PROGRESS'), jugement.accepted.map((a) => ({ event: { ...a.base, validatedName: a.name } })));
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      // Décisions NON sauvegardées : aucune écriture, lot non terminé, motif explicite — et jamais
      // l'annonce d'une reprise sans appel IA : ces documents seront réexaminés par l'IA.
      const motif = ((e as Error).message ?? 'erreur').slice(0, 200);
      examines = examinesAvant;
      ctx = ctxAvant;
      conventions = conventionsAvant;
      res.errors++;
      res.decisionsUnsaved = (res.decisionsUnsaved ?? 0) + jugement.accepted.length;
      for (const a of jugement.accepted) {
        rec.rename(it, a.prop, { writeResult: 'FAILED', reasonCode: 'DECISION_NOT_PERSISTED', eventId: null, origin: a.origin,
          reason: `Décision IA non sauvegardée (${motif}) : aucun renommage ; ce document sera réexaminé par l’IA (aucune reprise sans appel possible)` });
      }
      rec.steps.push({ step: `DECISIONS ${g.key} ${chunk.index + 1}/${chunk.count}`, status: 'FAILED', error: `DECISION_NOT_PERSISTED : ${motif}` });
      rec.notExamined(it, 'DECISION_NOT_PERSISTED', `Décisions non sauvegardées (${motif}) : lot non terminé, réexamen IA dans 1 h`);
      await sauver('ERROR', { retryAfter: new Date(c.now().getTime() + HEURE).toISOString(), lastError: `DECISION_NOT_PERSISTED : ${motif}`,
        attempts: (it.st?.attempts ?? 0) + 1 }).catch(() => undefined);
      if (examineQuelqueChose) res.groupsExamined++;
      return;
    }
    res.documentsExamined += chunk.targets.length;
    echecs += await applyDecisions(accountId, jugement.accepted, persistees, { it, courants, traces, c });
    // Noms écrits par cet examen : empreinte examinée à jour (aucune réinscription à la reprise).
    for (const d of chunk.targets) ctx[String(d.id)] = examinedContextHash(courants.get(d.id) ?? d);
  }

  // Examen IA terminé. Écritures restantes lues en BASE, tous passages confondus (C1) :
  // DONE seulement sans aucune ; sinon WRITE_PENDING, reprise sans appel IA.
  const finaux = [...courants.values()];
  const fp = groupFingerprint(finaux);
  await repo.updateMemberHashes(accountId, finaux.map((d) => ({ id: d.id, hash: docSnapshotHash(d) })));
  c.fpNow.set(g.key, fp);
  const restantes = (await repo.pendingWritesByGroup(accountId)).get(g.key) ?? 0;
  const final: SaveGroupState = {
    key: g.key, status: restantes > 0 ? 'WRITE_PENDING' : 'DONE', fingerprint: fp, progress: null, snapshot: groupSnapshot(finaux),
    conventions, promptVersion: c.prompt.version,
    retryAfter: restantes > 0 && echecs > 0 ? new Date(c.now().getTime() + 15 * MINUTE).toISOString() : null,
    attempts: 0, documentCount: g.docs.length, reviewed: true, contextVersion: V3,
    lastError: restantes > 0 ? `WRITE_PENDING ${restantes}` : null, upgrade: upgradeFait,
  };
  await c.save(final);
  if (upgradeFait) res.upgrade!.reviewed++;
  res.groupsExamined++;
  if (restantes === 0) { res.groupsCompleted++; return; }
  if (echecs === 0) {
    // Décisions d'un passage antérieur (ou d'une interruption) : reprises tout de suite, sans appel IA.
    if (c.guard) await c.guard.assertActive(`T3 harmonisation documentaire — reprise d’écriture ${g.key}`);
    const { upgrade: _u, reviewed: _r, ...etat } = final;
    await retryWrites(accountId, { ...it, fp, st: { ...etat, progress: null, lastReviewedAt: c.now().toISOString() } }, c);
  }
}

/**
 * C6 : indices de rapprochement transmis à l'IA, avec leur provenance —
 * références (texte extrait, faits, Opérations) qu'un document partage avec
 * d'autres documents du lot. L'IA décide des familles ; le code ne regroupe pas.
 */
function attachMatchHints(details: Map<number, NamingDocDetail>, appel: readonly NamingDoc[], lot: readonly NamingDoc[]): void {
  const cles = new Map<number, Set<string>>(lot.map((d) => [d.id, new Set(linkKeysOf(d).filter((k) => k.startsWith('x:')))]));
  for (const d of appel) {
    const det = details.get(d.id);
    const miennes = cles.get(d.id);
    if (!det || !miennes?.size) continue;
    const structurees = new Set((d.contractRefs ?? []).map((r) => `x:${r}`));
    const hints: NonNullable<NamingDocDetail['matchHints']> = [];
    for (const k of [...miennes].sort()) {
      const avec = lot.filter((x) => x.id !== d.id && cles.get(x.id)?.has(k)).map((x) => x.id).slice(0, 20);
      if (avec.length) hints.push({ reference: k.slice(2), source: structurees.has(k) ? 'T1_FACT_OR_OPERATION' : 'EXTRACTION_FULL_TEXT', sharedWithDocumentIds: avec });
    }
    if (hints.length) det.matchHints = hints.slice(0, 10);
  }
}

/** Conventions mémorisées : dernières familles décrites par l'IA (bornées), jamais un gabarit. */
function mergeConventions(avant: unknown[], familles: NonNullable<T3DocumentNamingOutput['families']>): unknown[] {
  const neuves = familles.filter((f) => f.convention).map((f) => ({ label: f.label, convention: f.convention, documentIds: [...f.document_ids].sort((a, b) => a - b).slice(0, 50) }));
  const libelles = new Set(neuves.map((f) => f.label));
  const anciennes = avant.filter((x) => !(x && typeof x === 'object' && libelles.has(String((x as { label?: unknown }).label))));
  return [...neuves, ...anciennes].slice(0, 20);
}

interface AcceptedDecision {
  prop: NamingProposal;
  name: string;
  base: RenameEvent;
  doc: NamingDoc | undefined;
  origin: NameOrigin | null;
}

/**
 * Verdicts des garde-fous sur les propositions d'un appel. Les refus sont
 * journalisés ici ; les propositions ACCEPTÉES sont rendues, pour être
 * persistées avant toute écriture (C2).
 */
async function judgeProposals(accountId: number, proposals: NamingProposal[], p: {
  it: Item;
  appel: NamingDoc[];
  /** Documents TO_EXAMINE de l'appel (E7) : seuls renommables. */
  cibles: ReadonlySet<number>;
  etats: Map<number, NamingDocState & { trace?: NameTrace }>;
  courants: Map<number, NamingDoc>;
  c: ExamCtx;
  traceId: string | null;
  callKey: string;
}): Promise<{ accepted: AcceptedDecision[] }> {
  const { repo, rec, res } = p.c;
  const { redact } = await import('../../gateway/redaction');
  const snap = new Map<number, NamingSnapshotDoc>();
  for (const d of p.appel) {
    const st = p.etats.get(d.id)!;
    const h = st.trace?.harmonization && st.trace.harmonization.name.trim() === d.name.trim() ? st.trace.harmonization : null;
    const fpDoc = documentFingerprint(d);
    // Renommage antérieur au lot 76B (empreinte v2) sans nouvelle information depuis : même délai de stabilité.
    const fpHarmonise = h?.fingerprint && h.fingerprint === v2DocumentFingerprint(d) ? fpDoc : h?.fingerprint ?? null;
    snap.set(d.id, {
      id: d.id, name: d.name, redactedName: redact(d.name), origin: st.origin, ids: { s3Key: d.s3Key, publicId: d.publicId },
      lastHarmonizedAt: h?.at ?? null, harmonizedFingerprint: fpHarmonise, fingerprint: fpDoc,
      role: p.cibles.has(d.id) ? 'TO_EXAMINE' : 'REFERENCE',
    });
  }
  const vus = new Set<number>();
  const verdicts: Array<{ p: NamingProposal; v: ReturnType<typeof judgeProposal> }> = [];
  for (const prop of proposals) {
    res.proposals++;
    const doc = p.courants.get(prop.document_id);
    const s = doc ? snap.get(doc.id) : undefined;
    const known = s && s.origin !== 'USER' && s.role === 'TO_EXAMINE' ? await repo.loadKnownData(accountId, doc!) : null;
    verdicts.push({ p: prop, v: judgeProposal(prop, { docs: snap, seen: vus, known, now: p.c.now(), cooldownDays: p.c.cooldown }) });
  }
  const collisions = collidingProposals(
    verdicts.flatMap((x) => (x.v.accept ? [{ documentId: x.p.document_id, name: x.v.name }] : [])), snap,
  );
  const accepted: AcceptedDecision[] = [];
  for (const { p: prop, v } of verdicts) {
    const doc = p.courants.get(prop.document_id);
    const s = snap.get(prop.document_id);
    const base: RenameEvent = {
      accountId, fileId: prop.document_id, groupKey: p.it.group.key, accountRunId: p.c.accountRunId, outcome: 'REFUSED', reasonCode: null,
      oldName: s?.name ?? null, expectedName: prop.expected_current_name, proposedName: prop.proposed_name, appliedName: null,
      referenceIds: [...new Set(prop.reference_document_ids ?? [])], aiReason: prop.reason, confidence: prop.confidence,
      nameOrigin: s?.origin ?? 'UNKNOWN', documentFingerprint: doc ? documentFingerprint(doc) : '', promptVersion: p.c.prompt.version,
      traceId: p.traceId, callKey: p.callKey,
    };
    const verdict: { accept: true; name: string } | { accept: false; code: RenameRefusal; detail?: string } =
      v.accept && collisions.has(prop.document_id) ? { accept: false, code: 'NAME_COLLISION' } : v;
    if (verdict.accept) { accepted.push({ prop, name: verdict.name, base, doc, origin: s?.origin ?? null }); continue; }
    const outcome = verdict.code === 'EQUIVALENT_NAME' ? 'NO_CHANGE' : 'REFUSED';
    if (outcome === 'NO_CHANGE') res.unchanged++; else res.refused++;
    // Document hors du lot : jamais journalisé sous son identifiant (peut appartenir à un autre compte).
    const id = verdict.code === 'UNKNOWN_DOCUMENT' ? null
      : await repo.recordRenameEvent({ ...base, outcome, reasonCode: verdict.code }).catch(() => null);
    rec.rename(p.it, prop, { writeResult: 'NOT_WRITTEN', reasonCode: verdict.code, reason: `${RENAME_REFUSAL_LABEL[verdict.code]}${verdict.detail ? ` (${verdict.detail})` : ''}`, eventId: id, origin: s?.origin ?? null });
  }
  return { accepted };
}

/**
 * Application des décisions PERSISTÉES (C2) : écriture + historique +
 * résolution de la décision dans une transaction. Rend le nombre d'écritures
 * en échec — toujours reprenables : la décision est en base, quoi qu'il
 * advienne de la journalisation de l'échec.
 */
async function applyDecisions(accountId: number, accepted: readonly AcceptedDecision[], persistees: Map<number, { eventId: number; retryStatus: string | null; outcome: string }>, p: {
  it: Item;
  courants: Map<number, NamingDoc>;
  traces: Map<number, NameTrace>;
  c: ExamCtx;
}): Promise<number> {
  const { repo, rec, res } = p.c;
  let echecs = 0;
  for (const a of accepted) {
    const { prop, doc } = a;
    const pd = persistees.get(prop.document_id);
    if (!pd || pd.retryStatus !== 'PENDING' || (pd.outcome !== 'DECIDED' && pd.outcome !== 'FAILED')) {
      // Décision déjà traitée (reprise rejouée) : jamais réappliquée.
      res.unchanged++;
      rec.rename(p.it, prop, { writeResult: 'NOT_WRITTEN', reasonCode: 'ALREADY_APPLIED', reason: 'Décision déjà traitée (reprise) : aucune nouvelle écriture', eventId: pd?.eventId ?? null, origin: a.origin });
      continue;
    }
    try {
      if (p.c.guard) await p.c.guard.assertActive('T3 harmonisation documentaire — écriture');
      const r = await repo.applyRename({ ...a.base, outcome: 'APPLIED', appliedName: a.name, validatedName: a.name }, { id: pd.eventId, outcome: pd.outcome as 'DECIDED' | 'FAILED' });
      if (r.status === 'APPLIED') {
        res.applied++;
        res.appliedFileIds.push(prop.document_id);
        if (doc) {
          p.courants.set(doc.id, { ...doc, name: a.name });
          const t = p.traces.get(doc.id);
          p.traces.set(doc.id, { titleEvent: t?.titleEvent ?? null, harmonization: { name: a.name, at: p.c.now().toISOString(), fingerprint: documentFingerprint(doc), oldName: doc.name } });
        }
        rec.rename(p.it, prop, { writeResult: 'WRITTEN', reasonCode: 'APPLIED', reason: null, eventId: r.eventId, origin: a.origin, applied: a.name });
      } else if (r.status === 'ALREADY_APPLIED') {
        res.unchanged++;
        rec.rename(p.it, prop, { writeResult: 'NOT_WRITTEN', reasonCode: 'ALREADY_APPLIED', reason: 'Décision déjà appliquée et journalisée (reprise)', eventId: null, origin: a.origin });
      } else {
        res.conflicts++;
        // La décision devient la trace du conflit (même clé d'idempotence) ; à défaut, elle reste
        // en attente et la reprise constatera le conflit à nouveau — jamais forcé.
        await repo.resolveDecisionConflict(accountId, pd.eventId, r.reason).catch(() => undefined);
        rec.rename(p.it, prop, { writeResult: 'NOT_WRITTEN', reasonCode: r.reason, eventId: pd.eventId, origin: a.origin, reason: conflictLabel(r.reason, r.currentName) });
      }
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      res.failed++;
      echecs++;
      const motif = ((e as Error).message ?? 'erreur').slice(0, 300);
      // Décision déjà persistée : reprise garantie sans nouvel appel IA, même si la mise à jour échoue ici.
      await repo.markRetry(accountId, pd.eventId, 'PENDING', { attempted: true, failed: true }).catch(() => undefined);
      rec.rename(p.it, prop, { writeResult: 'FAILED', reasonCode: 'WRITE_FAILED', reason: `Écriture en échec : ${motif} — décision sauvegardée (#${pd.eventId}), reprise automatique sans nouvel appel IA`, eventId: pd.eventId, origin: a.origin });
    }
  }
  return echecs;
}

const conflictLabel = (reason: string, current: string | null) =>
  reason === 'CONCURRENT_USER_RENAME' ? `Renommé par l’utilisateur entre l’analyse IA et l’écriture : nom conservé (« ${current ?? ''} »)`
    : reason === 'DOCUMENT_GONE' ? 'Document supprimé entre l’analyse IA et l’écriture'
      : `Nom modifié entre l’analyse IA et l’écriture : nom conservé (« ${current ?? ''} »)`;

/**
 * E6 — reprise des écritures en attente d'un lot dont le contexte est
 * INCHANGÉ depuis la décision : aucun appel IA. Avant chaque reprise, le
 * compte, le document (éligible, du lot), le nom courant (= nom lu par
 * l'IA), la protection (jamais un nom utilisateur) et l'absence de nouvelle
 * information sont revalidés ; écriture transactionnelle sous
 * compare-and-swap, MÊME clé d'idempotence que la tentative d'origine
 * (jamais de doublon). Un conflit (renommage manuel) n'est jamais forcé.
 * Lot 76B : décisions persistées non appliquées (DECIDED) comprises ; état
 * final calculé sur les écritures restantes EN BASE (C1).
 */
async function retryWrites(accountId: number, it: Item, c: ExamCtx): Promise<void> {
  const { repo, rec, res } = c;
  const attente = await repo.loadPendingWrites(accountId, it.group.key);
  const docs = await repo.loadNamingDocsByIds(accountId, it.ids);
  const courants = new Map(docs.map((d) => [d.id, d]));
  let encore = 0;
  let epuisees = 0;
  let caduques = 0;
  for (const w of attente) {
    if (c.guard) await c.guard.assertActive('T3 harmonisation documentaire — reprise d’écriture');
    const doc = courants.get(w.fileId);
    const prop: NamingProposal = { document_id: w.fileId, expected_current_name: w.expectedName, proposed_name: w.proposedName, reference_document_ids: w.referenceIds, reason: w.aiReason, confidence: w.confidence as NamingProposal['confidence'] };
    const ligne = (l: Parameters<NamingRecorder['rename']>[2]) => rec.rename(it, prop, { ...l, retryOf: w.eventId });
    const conflit = async (reason: 'CONCURRENT_USER_RENAME' | 'CONCURRENT_NAME_CHANGE' | 'DOCUMENT_GONE', current: string | null) => {
      res.conflicts++;
      await repo.markRetry(accountId, w.eventId, 'CONFLICT');
      // Clé d'appel distincte : la ligne de conflit de la reprise ne se confond pas avec l'échec d'origine.
      const id = await repo.recordRenameEvent({ ...w, callKey: `${w.callKey}:reprise`, accountRunId: c.accountRunId, outcome: 'CONFLICT', reasonCode: reason, retryOf: w.eventId, retryStatus: null }).catch(() => null);
      ligne({ writeResult: 'NOT_WRITTEN', reasonCode: reason, reason: conflictLabel(reason, current), eventId: id, origin: w.nameOrigin });
    };
    const perimee = async (code: 'NEW_INFORMATION' | 'NAME_COLLISION' | 'MOVED', libelle: string) => {
      caduques++;
      await repo.markRetry(accountId, w.eventId, 'SUPERSEDED');
      if (code === 'NAME_COLLISION') res.refused++;
      ligne({ writeResult: 'NOT_WRITTEN', reasonCode: code, reason: libelle, eventId: null, origin: w.nameOrigin });
    };
    if (!doc) {
      // Sorti du lot mais toujours présent (déplacé, recomposé) : décision sans objet, jamais un faux conflit.
      const ailleurs = (await repo.loadNamingDocsByIds(accountId, [w.fileId]))[0];
      if (ailleurs) await perimee('MOVED', 'Document déplacé vers un autre lot : décision sans objet, réexaminé avec son nouveau lot');
      else await conflit('DOCUMENT_GONE', null);
      continue;
    }
    if (isProtected(doc)) { await conflit('CONCURRENT_USER_RENAME', doc.name); continue; }
    if (doc.name.trim() !== (w.oldName ?? '').trim()) { await conflit('CONCURRENT_NAME_CHANGE', doc.name); continue; }
    if (documentFingerprint(doc) !== w.documentFingerprint && v2DocumentFingerprint(doc) !== w.documentFingerprint) {
      await perimee('NEW_INFORMATION', 'Nouvelle information depuis la décision : lot réexaminé par l’IA');
      continue;
    }
    const cible = normalizeTitle(w.validatedName);
    if ([...courants.values()].some((d) => d.id !== doc.id && normalizeTitle(d.name) === cible)) {
      await perimee('NAME_COLLISION', RENAME_REFUSAL_LABEL.NAME_COLLISION);
      continue;
    }
    res.writesRetried++;
    try {
      const r = await repo.applyRename(
        { ...w, accountRunId: c.accountRunId, outcome: 'APPLIED', appliedName: w.validatedName, retryOf: w.pendingOutcome === 'FAILED' ? w.eventId : null, retryStatus: null },
        { id: w.eventId, outcome: w.pendingOutcome },
      );
      if (r.status === 'APPLIED' || r.status === 'ALREADY_APPLIED') {
        if (r.status === 'APPLIED') {
          res.applied++;
          res.appliedFileIds.push(doc.id);
          courants.set(doc.id, { ...doc, name: w.validatedName });
          ligne({ writeResult: 'WRITTEN', reasonCode: 'APPLIED', reason: 'Écriture reprise (décision IA d’origine, sans nouvel appel)', eventId: r.eventId, origin: w.nameOrigin, applied: w.validatedName });
        } else {
          res.unchanged++;
          ligne({ writeResult: 'NOT_WRITTEN', reasonCode: 'ALREADY_APPLIED', reason: 'Décision déjà appliquée et journalisée (reprise)', eventId: null, origin: w.nameOrigin });
        }
      } else {
        await conflit(r.reason, r.currentName);
      }
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      res.failed++;
      const epuise = w.retryAttempts + 1 >= NAMING_WRITE_RETRY_MAX;
      await repo.markRetry(accountId, w.eventId, epuise ? 'ABANDONED' : 'PENDING', { attempted: true, failed: true }).catch(() => undefined);
      if (epuise) epuisees++; else encore++;
      ligne({ writeResult: 'FAILED', reasonCode: 'WRITE_FAILED', reason: `Reprise d’écriture en échec (${w.retryAttempts + 1}/${NAMING_WRITE_RETRY_MAX}) : ${((e as Error).message ?? '').slice(0, 200)}${epuise ? ' — lot réexaminé par l’IA dans 24 h' : ''}`, eventId: null, origin: w.nameOrigin });
    }
  }
  const finaux = orderDocs([...courants.values()]);
  const st = it.st!;
  // État d'une version antérieure du contexte : empreinte de SA formule conservée — le recalage prouvé (C5) suit.
  const ancienne = st.contextVersion !== V3 ? versionDe(st) : null;
  const fp = ancienne ? legacyFp(finaux, ancienne) : groupFingerprint(finaux);
  await repo.updateMemberHashes(accountId, finaux.map((d) => ({ id: d.id, hash: docSnapshotHash(d) })));
  if (!ancienne) c.fpNow.set(it.group.key, fp);
  const essais = st.attempts + 1;
  // C1 : écritures restantes lues en base (une mise à jour d'échec perdue reste une écriture due).
  const restantes = (await repo.pendingWritesByGroup(accountId)).get(it.group.key) ?? 0;
  const etat: SaveGroupState = restantes > 0
    ? { ...st, progress: null, status: 'WRITE_PENDING', fingerprint: fp, snapshot: groupSnapshot(finaux), documentCount: finaux.length, attempts: essais,
      retryAfter: new Date(c.now().getTime() + Math.min(6 * HEURE, 15 * MINUTE * 2 ** Math.min(essais, 5))).toISOString(), lastError: `WRITE_PENDING ${restantes}` }
    : epuisees > 0 || caduques > 0
      // Jamais abandonné : décision périmée ou écriture impossible → réexamen IA (empreinte effacée).
      ? { ...st, progress: null, status: epuisees > 0 ? 'ERROR' : 'DONE', fingerprint: null, snapshot: st.snapshot, documentCount: finaux.length, attempts: 0,
        retryAfter: epuisees > 0 ? new Date(c.now().getTime() + 24 * HEURE).toISOString() : null, lastError: epuisees > 0 ? 'WRITE_RETRY_EXHAUSTED' : null }
      : { ...st, progress: null, status: 'DONE', fingerprint: fp, snapshot: ancienne ? st.snapshot : groupSnapshot(finaux), documentCount: finaux.length, attempts: 0, retryAfter: null, lastError: null };
  await c.save({ ...etat, contextVersion: ancienne ? st.contextVersion ?? null : V3 });
  rec.steps.push({ step: `REPRISE ${it.group.key}`, status: encore > 0 || epuisees > 0 ? 'FAILED' : 'OK', error: encore > 0 ? `${encore} écriture(s) toujours en échec` : null, detail: { pending: attente.length, stillPending: encore, exhausted: epuisees, superseded: caduques, remaining: restantes } });
}

// ── Reporting (rapport d'exécution T3, lot 58) ─────────────────────────────

interface RenameLine {
  writeResult: ReportEntry['writeResult'];
  reasonCode: string;
  reason: string | null;
  eventId: number | null;
  origin: string | null;
  applied?: string;
  /** Lot 72B (E6) : échec d'origine d'une écriture reprise. */
  retryOf?: number | null;
}

/**
 * Section « Harmonisation documentaire » du rapport d'exécution T3.
 * Propositions IA (`NAMING_RENAME`, valeur proposée) et écritures
 * CONFIRMÉES (WRITTEN seulement si le journal transactionnel relu contient
 * le renommage) sont distinctes ; familles (`NAMING_FAMILY`) ; lots non
 * examinés et motif (`NAMING_GROUP`).
 */
class NamingRecorder {
  readonly steps: ReportStep[] = [];
  readonly traceIds = new Set<string>();
  private readonly entries: Array<ReportEntry & { eventId?: number | null }> = [];
  private notExaminedCount = 0;
  /** Motif de non-examen par lot (plafonds…) : état restant exact (E8). */
  readonly capReasons = new Map<string, string>();

  notExamined(it: Item, code: string, reason: string): void {
    if (!this.capReasons.has(it.group.key)) this.capReasons.set(it.group.key, code);
    this.notExaminedCount++;
    if (this.notExaminedCount > NOT_EXAMINED_DETAIL_MAX) return;
    this.entries.push({
      section: 'NAMING_GROUP', tableName: 'document_naming_groups', columnPath: 'status', fieldKey: it.group.key,
      label: `Lot ${it.group.key} (${it.ids.length} documents)`, value: it.ids.slice(0, 50),
      writeResult: 'NOT_EXAMINED', reasonCode: code, reason, links: { groupKey: it.group.key, documents: it.ids.length },
    });
  }

  family(groupKey: string, f: NonNullable<T3DocumentNamingOutput['families']>[number], fournis: Set<number>): void {
    this.entries.push({
      section: 'NAMING_FAMILY', fieldKey: groupKey, label: f.label.slice(0, 200),
      value: { convention: f.convention ?? null, documentIds: f.document_ids.filter((id) => fournis.has(id)), inconsistent: f.inconsistent ?? null },
      writeResult: 'OBSERVED', reasonCode: f.inconsistent ? 'INCONSISTENT_NAMES' : 'CONSISTENT_NAMES',
      reason: f.inconsistent ? 'Famille aux intitulés incohérents (analyse IA)' : 'Famille identifiée par l’IA (analyse, aucune écriture)',
      links: { groupKey },
    });
  }

  rename(it: Item, p: NamingProposal, l: RenameLine): void {
    this.entries.push({
      section: 'NAMING_RENAME', tableName: 'asset_files', recordId: p.document_id, columnPath: 'retained_title',
      fieldKey: it.group.key, entityType: 'DOCUMENT', entityId: p.document_id,
      oldValue: p.expected_current_name, value: p.proposed_name, valueType: 'string',
      writeResult: l.writeResult, reasonCode: l.reasonCode, reason: l.reason, eventId: l.eventId,
      links: {
        proposal: 'IA', referenceDocumentIds: p.reference_document_ids ?? [], aiReason: p.reason, confidence: p.confidence,
        nameOrigin: l.origin, renameEventId: l.eventId, appliedName: l.applied ?? null, groupKey: it.group.key,
        ...(l.retryOf != null ? { retryOfEventId: l.retryOf, aiCall: 'NONE (reprise de la décision d’origine)' } : {}),
      },
    });
  }

  /** Écrit le rapport (relecture du journal et des noms finaux). Ne lève jamais. */
  async write(accountId: number, res: DocumentNamingPhaseResult, opts: { accountRunId?: number | null; triggerCode?: string | null }, startedAt: Date): Promise<number | null> {
    try {
      const [{ writeExecutionReport }, { reportStatus }, { currentJobContext }, repo, { pgClient }] = await Promise.all([
        import('../../execution-report/repository'), import('../../execution-report/model'), import('../../queue/job-context'),
        import('./repository'), import('@/db'),
      ]);
      const ecrits = this.entries.filter((e) => e.writeResult === 'WRITTEN' && e.eventId != null).map((e) => e.eventId as number);
      const confirmes = await repo.confirmedRenames(accountId, ecrits);
      const ids = [...new Set(this.entries.filter((e) => e.section === 'NAMING_RENAME').map((e) => Number(e.recordId)))];
      const finaux = ids.length ? (await pgClient.unsafe(
        `SELECT id, retained_title FROM asset_files WHERE account_id = $1 AND id = ANY($2::int[])`, [accountId, ids] as never[],
      )) as unknown as Array<{ id: number; retained_title: string | null }> : [];
      const nomFinal = new Map(finaux.map((r) => [Number(r.id), r.retained_title]));
      const entries: ReportEntry[] = this.entries.map(({ eventId, ...e }) => {
        if (e.section !== 'NAMING_RENAME') return e;
        const links = { ...(e.links ?? {}), finalName: nomFinal.get(Number(e.recordId)) ?? null };
        if (e.writeResult === 'WRITTEN' && !(eventId != null && confirmes.has(eventId))) {
          return { ...e, links, writeResult: 'DECIDED_NOT_CONFIRMED' as const, reason: 'Renommage annoncé, absent du journal relu' };
        }
        return e.writeResult === 'WRITTEN' ? { ...e, links, value: confirmes.get(eventId!)!.appliedName } : { ...e, links };
      });
      const ctx = currentJobContext();
      const renames = entries.filter((e) => e.section === 'NAMING_RENAME');
      return await writeExecutionReport({
        accountId, treatment: 'T3', scope: 'DOCUMENT_NAMING', jobId: ctx?.jobId ?? null, jobAttempt: ctx?.jobAttempt ?? null,
        traceIds: [...this.traceIds], targetType: 'ACCOUNT', targetId: accountId, accountRunId: opts.accountRunId ?? null,
        triggerCode: ctx?.triggerCode ?? opts.triggerCode ?? null,
        // E8 : statut harmonisé avec l'état de la phase (jamais SUCCESS / NO_CHANGE s'il reste du travail).
        status: res.status === 'FAILED' ? 'FAILED' : res.status === 'DONE'
          ? reportStatus({ failed: false, entries: renames, steps: this.steps, treatment: 'T3' }) : 'PARTIAL',
        counters: {
          documents: res.documents, groups: res.groups, groupsDue: res.groupsDue, groupsExamined: res.groupsExamined,
          documentsExamined: res.documentsExamined, families: res.families, inconsistentFamilies: res.inconsistentFamilies,
          proposals: res.proposals, written: renames.filter((e) => e.writeResult === 'WRITTEN').length, refused: res.refused,
          conflicts: res.conflicts, unchanged: res.unchanged, failed: res.failed, aiCalls: res.aiCalls, deferred: res.deferred,
          errors: res.errors, notExamined: this.notExaminedCount, withoutContext: res.withoutContext,
          renamesSectionMissing: res.renamesSectionMissing, promptUnavailable: res.promptAvailable === false ? 1 : 0,
          pendingWrites: res.pendingWrites, writesRetried: res.writesRetried, rebaselined: res.rebaselined,
          // Lot 76B : décisions non sauvegardées (C2), documents réinscrits à la reprise (C3), recalage (C5).
          decisionsUnsaved: res.decisionsUnsaved ?? 0, documentsRevalidated: res.documentsRevalidated ?? 0,
          upgradeTechnical: res.upgrade?.technical ?? 0, upgradeExpected: res.upgrade?.expected ?? 0, upgradeReviewed: res.upgrade?.reviewed ?? 0,
          upgradeTechnicalTotal: res.upgrade?.totals.technical ?? 0, upgradeExpectedTotal: res.upgrade?.totals.expected ?? 0,
          upgradeReviewedTotal: res.upgrade?.totals.reviewed ?? 0,
          remainingGroups: res.remaining.groups, remainingDocuments: res.remaining.documents,
          scanComplete: res.scan.complete ? 1 : 0, scanned: res.scan.scanned,
        },
        steps: this.steps,
        sources: {
          section: 'Harmonisation documentaire',
          namingStatus: res.status,
          remaining: res.remaining,
          scan: res.scan,
          promptVersion: res.promptVersion, promptBranchAvailable: res.promptAvailable,
          documentsRead: { table: 'asset_files', count: res.documents, withoutComparableContext: res.withoutContext },
          history: { table: 'document_rename_events', note: 'APPLIED = renommages enregistrés (ancien / nouveau nom, origine, date, justification)' },
          groupsState: { table: 'document_naming_groups' },
          index: { table: 'document_naming_members', note: 'Index persistant des documents éligibles (lecture exhaustive à curseur persistant)' },
          operations: { modified: false, note: 'Aucune Opération créée, fusionnée ni modifiée par l’harmonisation' },
          contextVersion: NAMING_CONTEXT_VERSION,
          upgrade: res.upgrade ? {
            ...res.upgrade,
            note: 'Recalage des familles examinées avec un contexte antérieur : TECHNICAL = migration technique sans appel IA (preuve d’absence d’information nouvellement exploitable) ; EXPECTED = réexamen métier attendu (borné, reprenable) ; REVIEWED = réexamen effectué',
          } : null,
        },
        startedAt,
      }, entries);
    } catch (e) {
      console.error(`[t3-naming] rapport du compte ${accountId} non écrit :`, (e as Error).message);
      return null;
    }
  }
}
