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
 * ══════════════════════════════════════════════════════════════════════════
 */
import { envNumber } from '@/lib/env-number';
import { normalizeTitle } from '@/lib/documents/document-title-rules';
import { isExecutionCancelled, type ExecutionGuard } from '../../queue/execution-control';
import type { ReportEntry, ReportStep } from '../../execution-report/model';
import { namingOutputComplete, type T3DocumentNamingOutput } from '../master/t3-contract';
import {
  collidingProposals, judgeProposal, NAMING_MAX_LENGTH, RENAME_REFUSAL_LABEL,
  type NamingProposal, type NamingSnapshotDoc, type RenameRefusal,
} from './guards';
import {
  docSnapshotHash, documentFingerprint, groupFingerprint, groupMembers, groupSnapshot, isProtected, legacyGroupFingerprint,
  linkKeysOf, membersFingerprint, NAMING_CONTEXT_VERSION, namingVariables, orderDocs, planChunks, reviewTargets,
  type MemberGroup, type NamingDoc, type NamingDocState,
} from './context';
import type { GroupProgress, GroupState, NameTrace, RenameEvent, SaveGroupState } from './repository';
import type { NamingCall, NamingCallResult, NamingPromptStatus } from './model';

export const namingEnabled = () => envNumber('T3_DOCUMENT_NAMING_ENABLED', 1) !== 0;
export const namingCallsPerPass = () => Math.min(20, Math.floor(envNumber('T3_NAMING_MAX_CALLS_PER_PASS', 3, { min: 0 })));
export const namingCallsPerDay = () => Math.min(500, Math.floor(envNumber('T3_NAMING_MAX_CALLS_PER_DAY', 24, { min: 0 })));
export const namingDocsPerCall = () => Math.max(6, Math.min(100, Math.floor(envNumber('T3_NAMING_MAX_DOCUMENTS_PER_CALL', 40, { min: 6 }))));
export const namingCooldownDays = () => envNumber('T3_NAMING_COOLDOWN_DAYS', 30, { min: 0 });
/** Lot 72B (E1) : documents lus par page (curseur persistant). */
export const namingScanPageSize = () => Math.max(2, Math.min(10_000, Math.floor(envNumber('T3_NAMING_SCAN_PAGE_SIZE', 2_000, { min: 2 }))));
/** Lot 72B (E1) : pages lues par passage (au-delà, la lecture reprend au curseur au passage suivant). */
export const namingScanPagesPerPass = () => Math.max(1, Math.min(1_000, Math.floor(envNumber('T3_NAMING_SCAN_PAGES_PER_PASS', 50, { min: 1 }))));
/** Ligne d'état réservée : état global du compte (curseur de lecture, stock, reprise). */
export const ACCOUNT_MARKER = '*';
/** Lot 72B (E9) : réponses incomplètes successives tolérées sur une même version du prompt. */
export const NAMING_INCOMPLETE_MAX = 3;
/** Lot 72B (E6) : tentatives de reprise d'une écriture avant réexamen du lot par l'IA. */
export const NAMING_WRITE_RETRY_MAX = 5;
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
  /** Lot 72B : lots examinés au lot 61 et inchangés, recalés sans appel IA. */
  rebaselined: number;
  scan: NamingScanResult;
  remaining: NamingRemaining;
  appliedFileIds: number[];
  reportId: number | null;
}

export interface DocumentNamingDeps {
  callModel?: (p: NamingCall) => Promise<NamingCallResult>;
  promptStatus?: () => Promise<NamingPromptStatus>;
  /** @deprecated lot 72B — préférer `callsWindow`. */
  callsLastDay?: (accountId: number) => Promise<number>;
  callsWindow?: (accountId: number) => Promise<{ count: number; oldestAt: string | null }>;
  maxCallsPerPass?: number;
  maxCallsPerDay?: number;
  maxDocsPerCall?: number;
  cooldownDays?: number;
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
  pendingWrites: 0, writesRetried: 0, rebaselined: 0,
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
    case 'WRITE_PENDING': return echu;
    default: return st.fingerprint !== fp;
  }
}

/** Ordre de service (pure) : écritures à reprendre, examens commencés, lots modifiés, stock jamais examiné, reprises. */
export function dueRank(st: GroupState | undefined): number {
  if (!st) return 2;
  if (st.status === 'WRITE_PENDING') return -1;
  if (st.status === 'IN_PROGRESS') return 0;
  if (st.status === 'DONE') return 1;
  return 3;
}

/** Lot terminé (pure) : examen complet, écritures finalisées, empreinte à jour. */
export function groupSettled(st: GroupState | undefined, fp: string): boolean {
  return !!st && st.status === 'DONE' && st.fingerprint === fp;
}

/** Motif d'un lot non terminé (pure). */
export function remainingReason(st: GroupState | undefined, capReason: string | undefined): string {
  if (!st) return capReason ?? 'NEVER_EXAMINED';
  switch (st.status) {
    case 'DONE': return capReason ?? 'CHANGED_NOT_EXAMINED';
    case 'IN_PROGRESS': return capReason ?? 'IN_PROGRESS';
    case 'PROMPT_UNAVAILABLE': return 'PROMPT_WITHOUT_DOCUMENT_NAMING';
    case 'WRITE_PENDING': return 'WRITE_RETRY';
    case 'DEFERRED': return (st.lastError ?? '').split(' ')[0] || 'DEFERRED';
    default: return (st.lastError ?? '').startsWith('RENAMES_SECTION_MISSING') ? 'RENAMES_SECTION_MISSING'
      : (st.lastError ?? '').startsWith('WRITE_RETRY_EXHAUSTED') ? 'WRITE_RETRY_EXHAUSTED' : 'AI_ERROR';
  }
}

/**
 * État de la phase (pure, E8). `progress` : un travail utile a été fait
 * pendant ce passage (examen, écriture, lecture d'un stock pas encore couvert).
 */
export function namingPhaseStatus(p: { remainingGroups: number; scanComplete: boolean; progress: boolean; errors: number }): NamingPhaseStatus {
  if (p.remainingGroups === 0 && p.scanComplete) return 'DONE';
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
    states.set(st.key, {
      ...st, progress: (st.progress as GroupProgress | null) ?? null,
      lastReviewedAt: st.reviewed ? now().toISOString() : avant?.lastReviewedAt ?? null,
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
  for (const it of items) {
    const st = states.get(it.group.key);
    const fp = fpNow.get(it.group.key)!;
    if (groupSettled(st, fp)) continue;
    const cap = rec.capReasons.get(it.group.key);
    const motif = scan.coveredOnce ? remainingReason(st, cap) : 'SCAN_IN_PROGRESS';
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
  res.pendingWrites = await repo.countPendingWrites(accountId);
  res.remaining = { groups: restants, documents: docsRestants, byReason, nextRetryAt: prochaine, details };
  const progres = res.groupsExamined > 0 || res.documentsExamined > 0 || res.applied > 0 || res.writesRetried > 0 || res.rebaselined > 0
    || (scan.pages > 0 && !scan.complete);
  res.status = namingPhaseStatus({ remainingGroups: restants, scanComplete: scan.complete, progress: progres, errors: res.errors + res.renamesSectionMissing });
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
      out.changed += await c.repo.upsertMembers(accountId, docs.map((d) => ({ id: d.id, keys: linkKeysOf(d), hash: docSnapshotHash(d) })));
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
  // Aucun lot non terminé : pas même la lecture du prompt.
  if (!items.some((i) => !groupSettled(i.st, i.fp))) return false;

  // Recalage lot 61 → 72B : lot examiné et inchangé depuis (empreinte v1 identique) → aucune nouvelle analyse.
  for (const it of items) {
    if (it.st?.status !== 'DONE' || it.st.contextVersion === NAMING_CONTEXT_VERSION || it.st.fingerprint === it.fp) continue;
    const docs = await repo.loadNamingDocsByIds(accountId, it.ids);
    if (docs.length !== it.ids.length || legacyGroupFingerprint(docs) !== it.st.fingerprint) continue;
    const fp = groupFingerprint(docs);
    await p.save({ ...it.st, fingerprint: fp, snapshot: groupSnapshot(docs), contextVersion: NAMING_CONTEXT_VERSION, documentCount: docs.length, progress: null });
    it.st = { ...it.st, fingerprint: fp, contextVersion: NAMING_CONTEXT_VERSION };
    p.fpNow.set(it.group.key, fp);
    if (fp !== it.fp) await repo.updateMemberHashes(accountId, docs.map((d) => ({ id: d.id, hash: docSnapshotHash(d) })));
    it.fp = fp;
    res.rebaselined++;
  }
  if (!items.some((i) => !groupSettled(i.st, i.fp))) return false;

  const prompt = await (opts.promptStatus ?? (async () => (await import('./model')).documentNamingPromptStatus()))();
  res.promptAvailable = prompt.available;
  res.promptVersion = prompt.version;
  const dus = items.filter((i) => !groupSettled(i.st, i.fp) && groupDue(i.st, i.fp, prompt, now()))
    .sort((a, b) => dueRank(a.st) - dueRank(b.st) || (a.st?.lastReviewedAt ?? '').localeCompare(b.st?.lastReviewedAt ?? '') || a.group.key.localeCompare(b.group.key));
  res.groupsDue = dus.length;
  if (!dus.length) return false;

  const parPassage = opts.maxCallsPerPass ?? namingCallsPerPass();
  const parJour = opts.maxCallsPerDay ?? namingCallsPerDay();
  const dejaJour = opts.callsWindow ? (await opts.callsWindow(accountId)).count
    : opts.callsLastDay ? await opts.callsLastDay(accountId) : (await repo.namingCallsWindow(accountId)).count;
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
    if (it.st?.status === 'WRITE_PENDING' && it.st.fingerprint === it.fp) {
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
    if (it.st?.status === 'WRITE_PENDING') await repo.supersedePendingWrites(accountId, [it.group.key]);
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

  for (const it of examiner) {
    const cap = plafond();
    if (cap) {
      res.deferred++;
      rec.notExamined(it, cap, cap === 'PASS_CAP' ? 'Plafond d’appels du passage atteint : repris au passage suivant' : 'Plafond journalier d’appels atteint : repris dans les 24 h');
      continue;
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
  if (g.docs.length < 2) {
    // Lot réduit à un document depuis la lecture : rien à harmoniser.
    const fp = groupFingerprint(g.docs);
    c.fpNow.set(g.key, fp);
    await c.save({ key: g.key, status: 'DONE', fingerprint: fp, progress: null, snapshot: groupSnapshot(g.docs), conventions: it.st?.conventions ?? it.inherited,
      promptVersion: c.prompt.version, retryAfter: null, attempts: 0, documentCount: g.docs.length, contextVersion: NAMING_CONTEXT_VERSION });
    return;
  }
  const reprise = it.st?.status === 'IN_PROGRESS' || ((it.st?.status === 'DEFERRED' || it.st?.status === 'ERROR') && !!it.st?.progress);
  const examines = new Set<number>(reprise ? it.st?.progress?.examined ?? [] : []);
  const startedAt = reprise ? it.st?.progress?.startedAt ?? c.now().toISOString() : c.now().toISOString();
  const cibles = reviewTargets(g.docs, it.st?.snapshot ?? null, c.maxDocs).filter((d) => !examines.has(d.id));
  const chunks = planChunks(g.docs, cibles, c.maxDocs);
  let conventions: unknown[] = it.st?.conventions?.length ? it.st.conventions : it.inherited;
  const traces = await repo.loadNameTraces(accountId, g.docs.map((d) => d.id));
  // Noms en mémoire, mis à jour au fil des écritures confirmées (empreinte finale).
  const courants = new Map<number, NamingDoc>(g.docs.map((d) => [d.id, d]));
  let examineQuelqueChose = false;
  let echecs = 0;

  const sauver = (status: GroupState['status'], extra: Partial<SaveGroupState> = {}) => c.save({
    key: g.key, status, fingerprint: it.st?.fingerprint ?? null,
    progress: { nextChunk: 0, chunks: chunks.length, examined: [...examines], startedAt },
    snapshot: it.st?.snapshot ?? null, conventions, promptVersion: c.prompt.version, retryAfter: null,
    attempts: it.st?.attempts ?? 0, documentCount: g.docs.length, contextVersion: it.st?.contextVersion ?? null,
    lastError: null, ...extra,
  });

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
    if (out.families?.length) conventions = mergeConventions(conventions, out.families);
    echecs += await applyProposals(accountId, out.document_renames ?? [], {
      it, appel, cibles: cibleIds, etats, courants, traces, c, traceId: sortie.traceId,
      callKey: `${it.fp}:${chunk.index}:${[...idsAppel].sort((a, b) => a - b).join(',')}`,
    });
    for (const d of chunk.targets) examines.add(d.id);
    res.documentsExamined += chunk.targets.length;
    // Progression persistée après chaque appel (reprise exacte après interruption).
    if (chunk.index < chunk.count - 1) await sauver('IN_PROGRESS');
  }

  // Examen IA terminé. Écritures finalisées → DONE ; sinon WRITE_PENDING (E6).
  const finaux = [...courants.values()];
  const fp = groupFingerprint(finaux);
  await repo.updateMemberHashes(accountId, finaux.map((d) => ({ id: d.id, hash: docSnapshotHash(d) })));
  c.fpNow.set(g.key, fp);
  await c.save({
    key: g.key, status: echecs > 0 ? 'WRITE_PENDING' : 'DONE', fingerprint: fp, progress: null, snapshot: groupSnapshot(finaux),
    conventions, promptVersion: c.prompt.version, retryAfter: echecs > 0 ? new Date(c.now().getTime() + 15 * MINUTE).toISOString() : null,
    attempts: 0, documentCount: g.docs.length, reviewed: true, contextVersion: NAMING_CONTEXT_VERSION,
    lastError: echecs > 0 ? `WRITE_PENDING ${echecs}` : null,
  });
  res.groupsExamined++;
  if (echecs === 0) res.groupsCompleted++;
}

/** Conventions mémorisées : dernières familles décrites par l'IA (bornées), jamais un gabarit. */
function mergeConventions(avant: unknown[], familles: NonNullable<T3DocumentNamingOutput['families']>): unknown[] {
  const neuves = familles.filter((f) => f.convention).map((f) => ({ label: f.label, convention: f.convention, documentIds: [...f.document_ids].sort((a, b) => a - b).slice(0, 50) }));
  const libelles = new Set(neuves.map((f) => f.label));
  const anciennes = avant.filter((x) => !(x && typeof x === 'object' && libelles.has(String((x as { label?: unknown }).label))));
  return [...neuves, ...anciennes].slice(0, 20);
}

/** Rend le nombre d'écritures en échec, persistées pour reprise (E6). */
async function applyProposals(accountId: number, proposals: NamingProposal[], p: {
  it: Item;
  appel: NamingDoc[];
  /** Documents TO_EXAMINE de l'appel (E7) : seuls renommables. */
  cibles: ReadonlySet<number>;
  etats: Map<number, NamingDocState & { trace?: NameTrace }>;
  courants: Map<number, NamingDoc>;
  /** Traces des noms (mises à jour après chaque écriture : origine et délai de stabilité des appels suivants). */
  traces: Map<number, NameTrace>;
  c: ExamCtx;
  traceId: string | null;
  callKey: string;
}): Promise<number> {
  const { repo, rec, res } = p.c;
  const { redact } = await import('../../gateway/redaction');
  const snap = new Map<number, NamingSnapshotDoc>();
  for (const d of p.appel) {
    const st = p.etats.get(d.id)!;
    const h = st.trace?.harmonization && st.trace.harmonization.name.trim() === d.name.trim() ? st.trace.harmonization : null;
    snap.set(d.id, {
      id: d.id, name: d.name, redactedName: redact(d.name), origin: st.origin, ids: { s3Key: d.s3Key, publicId: d.publicId },
      lastHarmonizedAt: h?.at ?? null, harmonizedFingerprint: h?.fingerprint ?? null, fingerprint: documentFingerprint(d),
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
  let echecs = 0;
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
    if (!verdict.accept) {
      const outcome = verdict.code === 'EQUIVALENT_NAME' ? 'NO_CHANGE' : 'REFUSED';
      if (outcome === 'NO_CHANGE') res.unchanged++; else res.refused++;
      // Document hors du lot : jamais journalisé sous son identifiant (peut appartenir à un autre compte).
      const id = verdict.code === 'UNKNOWN_DOCUMENT' ? null
        : await repo.recordRenameEvent({ ...base, outcome, reasonCode: verdict.code }).catch(() => null);
      rec.rename(p.it, prop, { writeResult: 'NOT_WRITTEN', reasonCode: verdict.code, reason: `${RENAME_REFUSAL_LABEL[verdict.code]}${verdict.detail ? ` (${verdict.detail})` : ''}`, eventId: id, origin: s?.origin ?? null });
      continue;
    }
    try {
      if (p.c.guard) await p.c.guard.assertActive('T3 harmonisation documentaire — écriture');
      const r = await repo.applyRename({ ...base, outcome: 'APPLIED', appliedName: verdict.name, validatedName: verdict.name });
      if (r.status === 'APPLIED') {
        res.applied++;
        res.appliedFileIds.push(prop.document_id);
        if (doc) {
          p.courants.set(doc.id, { ...doc, name: verdict.name });
          const t = p.traces.get(doc.id);
          p.traces.set(doc.id, { titleEvent: t?.titleEvent ?? null, harmonization: { name: verdict.name, at: p.c.now().toISOString(), fingerprint: documentFingerprint(doc) } });
        }
        rec.rename(p.it, prop, { writeResult: 'WRITTEN', reasonCode: 'APPLIED', reason: null, eventId: r.eventId, origin: s?.origin ?? null, applied: verdict.name });
      } else if (r.status === 'ALREADY_APPLIED') {
        res.unchanged++;
        rec.rename(p.it, prop, { writeResult: 'NOT_WRITTEN', reasonCode: 'ALREADY_APPLIED', reason: 'Décision déjà appliquée et journalisée (reprise)', eventId: null, origin: s?.origin ?? null });
      } else {
        res.conflicts++;
        const id = await repo.recordRenameEvent({ ...base, outcome: 'CONFLICT', reasonCode: r.reason }).catch(() => null);
        rec.rename(p.it, prop, { writeResult: 'NOT_WRITTEN', reasonCode: r.reason, eventId: id, origin: s?.origin ?? null, reason: conflictLabel(r.reason, r.currentName) });
      }
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      res.failed++;
      const motif = ((e as Error).message ?? 'erreur').slice(0, 300);
      // E6 : décision persistée pour reprise (nom validé, clé d'appel) — sans nouvel appel IA.
      const id = await repo.recordRenameEvent({ ...base, outcome: 'FAILED', reasonCode: 'WRITE_FAILED', validatedName: verdict.name, retryStatus: 'PENDING' }).catch(() => null);
      if (id != null) echecs++;
      rec.rename(p.it, prop, { writeResult: 'FAILED', reasonCode: 'WRITE_FAILED', reason: `Écriture en échec : ${motif} — reprise automatique sans nouvel appel IA`, eventId: id, origin: s?.origin ?? null });
    }
  }
  return echecs;
}

const conflictLabel = (reason: string, current: string | null) =>
  reason === 'CONCURRENT_USER_RENAME' ? `Renommé par l’utilisateur entre l’analyse IA et l’écriture : nom conservé (« ${current ?? ''} »)`
    : reason === 'DOCUMENT_GONE' ? 'Document supprimé entre l’analyse IA et l’écriture'
      : `Nom modifié entre l’analyse IA et l’écriture : nom conservé (« ${current ?? ''} »)`;

/**
 * E6 — reprise des écritures en échec d'un lot dont le contexte est
 * INCHANGÉ depuis la décision : aucun appel IA. Avant chaque reprise, le
 * compte, le document (éligible, du lot), le nom courant (= nom lu par
 * l'IA), la protection (jamais un nom utilisateur) et l'absence de nouvelle
 * information sont revalidés ; écriture transactionnelle sous
 * compare-and-swap, MÊME clé d'idempotence que la tentative d'origine
 * (jamais de doublon). Un conflit (renommage manuel) n'est jamais forcé.
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
    if (!doc) { await conflit('DOCUMENT_GONE', null); continue; }
    if (isProtected(doc)) { await conflit('CONCURRENT_USER_RENAME', doc.name); continue; }
    if (doc.name.trim() !== (w.oldName ?? '').trim()) { await conflit('CONCURRENT_NAME_CHANGE', doc.name); continue; }
    if (documentFingerprint(doc) !== w.documentFingerprint) {
      caduques++;
      await repo.markRetry(accountId, w.eventId, 'SUPERSEDED');
      ligne({ writeResult: 'NOT_WRITTEN', reasonCode: 'NEW_INFORMATION', reason: 'Nouvelle information depuis la décision : lot réexaminé par l’IA', eventId: null, origin: w.nameOrigin });
      continue;
    }
    const cible = normalizeTitle(w.validatedName);
    if ([...courants.values()].some((d) => d.id !== doc.id && normalizeTitle(d.name) === cible)) {
      caduques++;
      await repo.markRetry(accountId, w.eventId, 'SUPERSEDED');
      res.refused++;
      ligne({ writeResult: 'NOT_WRITTEN', reasonCode: 'NAME_COLLISION', reason: RENAME_REFUSAL_LABEL.NAME_COLLISION, eventId: null, origin: w.nameOrigin });
      continue;
    }
    res.writesRetried++;
    try {
      const r = await repo.applyRename({ ...w, accountRunId: c.accountRunId, outcome: 'APPLIED', appliedName: w.validatedName, retryOf: w.eventId, retryStatus: null });
      if (r.status === 'APPLIED' || r.status === 'ALREADY_APPLIED') {
        await repo.markRetry(accountId, w.eventId, 'RESOLVED', { attempted: true });
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
      await repo.markRetry(accountId, w.eventId, epuise ? 'ABANDONED' : 'PENDING', { attempted: true });
      if (epuise) epuisees++; else encore++;
      ligne({ writeResult: 'FAILED', reasonCode: 'WRITE_FAILED', reason: `Reprise d’écriture en échec (${w.retryAttempts + 1}/${NAMING_WRITE_RETRY_MAX}) : ${((e as Error).message ?? '').slice(0, 200)}${epuise ? ' — lot réexaminé par l’IA dans 24 h' : ''}`, eventId: null, origin: w.nameOrigin });
    }
  }
  const finaux = orderDocs([...courants.values()]);
  const fp = groupFingerprint(finaux);
  await repo.updateMemberHashes(accountId, finaux.map((d) => ({ id: d.id, hash: docSnapshotHash(d) })));
  c.fpNow.set(it.group.key, fp);
  const st = it.st!;
  const essais = st.attempts + 1;
  const etat: SaveGroupState = encore > 0
    ? { ...st, progress: null, status: 'WRITE_PENDING', fingerprint: fp, snapshot: groupSnapshot(finaux), documentCount: finaux.length, attempts: essais,
      retryAfter: new Date(c.now().getTime() + Math.min(6 * HEURE, 15 * MINUTE * 2 ** Math.min(essais, 5))).toISOString(), lastError: `WRITE_PENDING ${encore}` }
    : epuisees > 0 || caduques > 0
      // Jamais abandonné : décision périmée ou écriture impossible → réexamen IA (empreinte effacée).
      ? { ...st, progress: null, status: epuisees > 0 ? 'ERROR' : 'DONE', fingerprint: null, snapshot: st.snapshot, documentCount: finaux.length, attempts: 0,
        retryAfter: epuisees > 0 ? new Date(c.now().getTime() + 24 * HEURE).toISOString() : null, lastError: epuisees > 0 ? 'WRITE_RETRY_EXHAUSTED' : null }
      : { ...st, progress: null, status: 'DONE', fingerprint: fp, snapshot: groupSnapshot(finaux), documentCount: finaux.length, attempts: 0, retryAfter: null, lastError: null };
  await c.save({ ...etat, contextVersion: NAMING_CONTEXT_VERSION });
  rec.steps.push({ step: `REPRISE ${it.group.key}`, status: encore > 0 || epuisees > 0 ? 'FAILED' : 'OK', error: encore > 0 ? `${encore} écriture(s) toujours en échec` : null, detail: { pending: attente.length, stillPending: encore, exhausted: epuisees, superseded: caduques } });
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
export class NamingRecorder {
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
        },
        startedAt,
      }, entries);
    } catch (e) {
      console.error(`[t3-naming] rapport du compte ${accountId} non écrit :`, (e as Error).message);
      return null;
    }
  }
}
