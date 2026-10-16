/**
 * T3 — HARMONISATION DU NOMMAGE DOCUMENTAIRE (lot 61, ticket « [P2] T3 —
 * Harmonisation intelligente du nommage documentaire »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * OÙ ? Phase DOCUMENT_NAMING du passage T3 du COMPTE (`reconcileAccount`),
 * après les biens, la connaissance ouverte et les « À traiter » : exécutions
 * manuelles (BO), planifiées (balayage horaire) et événementielles. Aucun
 * traitement parallèle. Non obligatoire : une erreur de nommage ne fait
 * jamais échouer les autres missions T3 (phase isolée, erreurs par lot).
 *
 * QUOI ? Pour chaque lot de documents comparables du compte DONT L'ÉTAT A
 * CHANGÉ (nouveau document, nouveau nom, nouvelle donnée — ou jamais
 * examiné : réconciliation initiale du stock, par lots bornés), l'IA reçoit
 * les documents (noms actuel et original, origine du nom, historique, type,
 * date, fournisseur, bien, faits T1, extrait, Opérations liées) et les
 * conventions décrites au dernier examen, et rend ses familles et ses
 * propositions (`document_renames`). Le serveur juge chaque proposition
 * (`guards.ts`) puis écrit en compare-and-swap (`repository.ts`). Aucune
 * Opération n'est créée, fusionnée ni modifiée ; T1 n'est jamais relancé.
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
 *   · T3_NAMING_COOLDOWN_DAYS (30) — délai de stabilité.
 * Au-delà : le lot reste dû, repris au passage suivant (reprise exacte des
 * documents déjà examinés).
 *
 * PROMPT : sans la section « BRANCHE TASK = DOCUMENT_NAMING » dans la
 * version ACTIVE du prompt maître T3, aucun appel ni renommage ; les lots dus
 * sont marqués PROMPT_UNAVAILABLE (une fois par version) et le rapport le
 * dit. Une sortie sans `document_renames` = aucune proposition (signalé).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { envNumber } from '@/lib/env-number';
import { isExecutionCancelled, type ExecutionGuard } from '../../queue/execution-control';
import type { ReportEntry, ReportStep } from '../../execution-report/model';
import type { T3DocumentNamingOutput } from '../master/t3-contract';
import {
  collidingProposals, judgeProposal, NAMING_MAX_LENGTH, RENAME_REFUSAL_LABEL,
  type NamingProposal, type NamingSnapshotDoc, type RenameRefusal,
} from './guards';
import {
  buildGroups, documentFingerprint, groupFingerprint, groupSnapshot, namingVariables, planChunks, reviewTargets,
  type NamingDoc, type NamingDocState, type NamingGroup,
} from './context';
import type { GroupState, NameTrace, RenameEvent } from './repository';
import type { NamingCall, NamingCallResult, NamingPromptStatus } from './model';

export const namingEnabled = () => envNumber('T3_DOCUMENT_NAMING_ENABLED', 1) !== 0;
export const namingCallsPerPass = () => Math.min(20, Math.floor(envNumber('T3_NAMING_MAX_CALLS_PER_PASS', 3, { min: 0 })));
export const namingCallsPerDay = () => Math.min(500, Math.floor(envNumber('T3_NAMING_MAX_CALLS_PER_DAY', 24, { min: 0 })));
export const namingDocsPerCall = () => Math.max(6, Math.min(100, Math.floor(envNumber('T3_NAMING_MAX_DOCUMENTS_PER_CALL', 40, { min: 6 }))));
export const namingCooldownDays = () => envNumber('T3_NAMING_COOLDOWN_DAYS', 30, { min: 0 });
/** Ligne d'état réservée : le compte a été examiné au moins une fois (balayage du stock). */
export const ACCOUNT_MARKER = '*';
/** Documents lus par compte (borne de sécurité). */
export const NAMING_SCAN_LIMIT = 20_000;
/** Lignes « non examiné » détaillées au rapport (les autres sont comptées). */
const NOT_EXAMINED_DETAIL_MAX = 100;
const HEURE = 3_600_000;

export interface DocumentNamingPhaseResult {
  /** DONE ; DISABLED (variable) ; NOT_READY (migration 0450 absente). */
  status: 'DONE' | 'DISABLED' | 'NOT_READY';
  promptAvailable: boolean | null;
  promptVersion: string | null;
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
  /** Sorties sans section `document_renames` (version du prompt qui ne la produit pas). */
  renamesSectionMissing: number;
  appliedFileIds: number[];
  reportId: number | null;
}

export interface DocumentNamingDeps {
  callModel?: (p: NamingCall) => Promise<NamingCallResult>;
  promptStatus?: () => Promise<NamingPromptStatus>;
  callsLastDay?: (accountId: number) => Promise<number>;
  maxCallsPerPass?: number;
  maxCallsPerDay?: number;
  maxDocsPerCall?: number;
  cooldownDays?: number;
  now?: () => Date;
  /** Écriture du rapport (défaut : rapport d'exécution T3, lot 58). `false` : aucun rapport. */
  writeReport?: boolean;
}

const vide = (): DocumentNamingPhaseResult => ({
  status: 'DONE', promptAvailable: null, promptVersion: null, documents: 0, withoutContext: 0, groups: 0, groupsDue: 0,
  groupsExamined: 0, groupsCompleted: 0, documentsExamined: 0, families: 0, inconsistentFamilies: 0, proposals: 0, applied: 0,
  refused: 0, conflicts: 0, unchanged: 0, failed: 0, aiCalls: 0, deferred: 0, errors: 0, renamesSectionMissing: 0,
  appliedFileIds: [], reportId: null,
});

/** Lot dû ? (pure) */
export function groupDue(st: GroupState | undefined, fp: string, prompt: NamingPromptStatus, now: Date): boolean {
  if (!st) return true;
  switch (st.status) {
    case 'IN_PROGRESS': return true;
    case 'PROMPT_UNAVAILABLE': return prompt.version !== st.promptVersion;
    case 'DEFERRED':
    case 'ERROR': return !st.retryAfter || Date.parse(st.retryAfter) <= now.getTime();
    default: return st.fingerprint !== fp;
  }
}

/** Ordre de service (pure) : examens commencés, puis lots modifiés (continuité), puis stock jamais examiné, puis reprises. */
export function dueRank(st: GroupState | undefined): number {
  if (!st) return 2;
  if (st.status === 'IN_PROGRESS') return 0;
  if (st.status === 'DONE') return 1;
  return 3;
}

interface Item { group: NamingGroup; fp: string; st: GroupState | undefined }

/**
 * Phase DOCUMENT_NAMING d'un passage T3 de compte. Ne lève pas, sauf
 * interruption d'exécution (arrêt d'urgence, annulation du travail).
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
  const docs = await repo.loadNamingDocs(accountId, NAMING_SCAN_LIMIT);
  const { groups, withoutContext } = buildGroups(docs);
  const multi = groups.filter((g) => g.docs.length >= 2);
  res.documents = docs.length;
  res.withoutContext = withoutContext.length;
  res.groups = multi.length;
  const states = await repo.loadGroupStates(accountId);
  // Marqueur « compte examiné » : un compte sans bien n'est plus repris par le
  // balayage planifié pour son stock (ses événements suffisent ensuite).
  if (!states.has(ACCOUNT_MARKER) && docs.length > 0) {
    await repo.saveGroupState(accountId, {
      key: ACCOUNT_MARKER, status: 'DONE', fingerprint: null, progress: null, snapshot: null, conventions: [],
      promptVersion: null, retryAfter: null, attempts: 0, documentCount: docs.length,
    });
  }
  if (!multi.length) return res;

  const premier = multi.map((g) => ({ group: g, fp: groupFingerprint(g.docs), st: states.get(g.key) }));
  // Aucun lot modifié ni jamais examiné : pas même la lecture du prompt.
  if (!premier.some((i) => !i.st || i.st.status !== 'DONE' || i.st.fingerprint !== i.fp)) return res;
  const prompt = await (opts.promptStatus ?? (async () => (await import('./model')).documentNamingPromptStatus()))();
  res.promptAvailable = prompt.available;
  res.promptVersion = prompt.version;
  const dus = premier.filter((i) => groupDue(i.st, i.fp, prompt, now()))
    .sort((a, b) => dueRank(a.st) - dueRank(b.st) || (a.st?.lastReviewedAt ?? '').localeCompare(b.st?.lastReviewedAt ?? '') || a.group.key.localeCompare(b.group.key));
  res.groupsDue = dus.length;
  if (!dus.length) return res;

  const rec = new NamingRecorder();
  if (!prompt.available) {
    for (const it of dus) {
      await repo.saveGroupState(accountId, {
        key: it.group.key, status: 'PROMPT_UNAVAILABLE', fingerprint: it.st?.fingerprint ?? null, progress: it.st?.progress ?? null,
        snapshot: it.st?.snapshot ?? null, conventions: it.st?.conventions ?? [], promptVersion: prompt.version, retryAfter: null,
        attempts: it.st?.attempts ?? 0, documentCount: it.group.docs.length,
      });
      rec.notExamined(it, 'PROMPT_WITHOUT_DOCUMENT_NAMING', `Version active du prompt T3 sans branche DOCUMENT_NAMING (${prompt.version ?? 'version illisible'}) : aucune proposition, aucun renommage`);
    }
    rec.steps.push({ step: 'PROMPT', status: 'SKIPPED', error: null, detail: { version: prompt.version, branch: 'DOCUMENT_NAMING', available: false } });
    res.deferred = dus.length;
    res.reportId = opts.writeReport === false ? null : await rec.write(accountId, res, opts, startedAt);
    return res;
  }

  const parPassage = opts.maxCallsPerPass ?? namingCallsPerPass();
  const parJour = opts.maxCallsPerDay ?? namingCallsPerDay();
  const dejaJour = await (opts.callsLastDay ?? repo.namingCallsLastDay)(accountId);
  const plafond = (): 'PASS_CAP' | 'DAILY_CAP' | null =>
    res.aiCalls >= parPassage ? 'PASS_CAP' : dejaJour + res.aiCalls >= parJour ? 'DAILY_CAP' : null;
  const callModel = opts.callModel ?? (async (p: NamingCall) => (await import('./model')).callDocumentNamingModel(p));
  const cooldown = opts.cooldownDays ?? namingCooldownDays();

  for (const it of dus) {
    const cap = plafond();
    if (cap) {
      res.deferred++;
      rec.notExamined(it, cap, cap === 'PASS_CAP' ? 'Plafond d’appels du passage atteint : repris au passage suivant' : 'Plafond journalier d’appels atteint : repris dans les 24 h');
      continue;
    }
    if (opts.guard) await opts.guard.assertActive(`T3 harmonisation documentaire — lot ${it.group.key}`);
    try {
      await examineGroup(accountId, it, {
        repo, rec, res, prompt, maxDocs, cooldown, now, callModel, plafond, guard: opts.guard, accountRunId: opts.accountRunId ?? null,
      });
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      // Erreur isolée : le lot est repris plus tard, les autres continuent.
      res.errors++;
      const motif = (e as Error).message?.slice(0, 300) ?? 'erreur';
      rec.steps.push({ step: `LOT ${it.group.key}`, status: 'FAILED', error: motif });
      await repo.saveGroupState(accountId, {
        key: it.group.key, status: 'ERROR', fingerprint: it.st?.fingerprint ?? null, progress: it.st?.progress ?? null,
        snapshot: it.st?.snapshot ?? null, conventions: it.st?.conventions ?? [], promptVersion: prompt.version,
        retryAfter: new Date(now().getTime() + 6 * HEURE).toISOString(), attempts: (it.st?.attempts ?? 0) + 1,
        documentCount: it.group.docs.length, lastError: motif,
      }).catch(() => undefined);
      console.error(`[t3-naming] lot ${it.group.key} du compte ${accountId} en erreur :`, motif);
    }
  }
  res.appliedFileIds = [...new Set(res.appliedFileIds)].sort((a, b) => a - b);
  res.reportId = opts.writeReport === false ? null : await rec.write(accountId, res, opts, startedAt);
  return res;
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
  guard?: ExecutionGuard;
  accountRunId: number | null;
}

/** Examen (éventuellement partiel, repris ensuite) d'un lot. */
async function examineGroup(accountId: number, it: Item, c: ExamCtx): Promise<void> {
  const { repo, rec, res } = c;
  const g = it.group;
  const enCours = it.st?.status === 'IN_PROGRESS' || ((it.st?.status === 'DEFERRED' || it.st?.status === 'ERROR') && !!it.st?.progress);
  const examines = new Set<number>(enCours ? it.st?.progress?.examined ?? [] : []);
  const startedAt = enCours ? it.st?.progress?.startedAt ?? c.now().toISOString() : c.now().toISOString();
  const cibles = reviewTargets(g.docs, it.st?.snapshot ?? null, c.maxDocs)
    .filter((d) => !examines.has(d.id));
  const chunks = planChunks(g.docs, cibles, c.maxDocs);
  let conventions: unknown[] = it.st?.conventions ?? [];
  const traces = await repo.loadNameTraces(accountId, g.docs.map((d) => d.id));
  // Noms en mémoire, mis à jour au fil des écritures confirmées (empreinte finale).
  const courants = new Map<number, NamingDoc>(g.docs.map((d) => [d.id, d]));
  let examineQuelqueChose = false;

  const sauver = (status: GroupState['status'], extra: Partial<Parameters<typeof repo.saveGroupState>[1]> = {}) => repo.saveGroupState(accountId, {
    key: g.key, status, fingerprint: it.st?.fingerprint ?? null,
    progress: { nextChunk: 0, chunks: chunks.length, examined: [...examines], startedAt },
    snapshot: it.st?.snapshot ?? null, conventions, promptVersion: c.prompt.version, retryAfter: null,
    attempts: it.st?.attempts ?? 0, documentCount: g.docs.length, ...extra,
  });

  for (const chunk of chunks) {
    const cap = c.plafond();
    if (cap) {
      // Reprise exacte au passage suivant (documents déjà examinés conservés).
      await sauver('IN_PROGRESS');
      res.deferred++;
      rec.notExamined(it, cap, `Lot volumineux : ${examines.size}/${g.docs.length} document(s) examiné(s), suite au passage suivant`);
      if (examineQuelqueChose) res.groupsExamined++;
      return;
    }
    if (c.guard) await c.guard.assertActive(`T3 harmonisation documentaire — lot ${g.key}`);
    const appel = [...chunk.targets, ...chunk.references].map((d) => courants.get(d.id) ?? d);
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
    examineQuelqueChose = true;
    if (sortie.traceId) rec.traceIds.add(sortie.traceId);
    const out: T3DocumentNamingOutput = sortie.output;
    rec.steps.push({ step: `APPEL ${g.key} ${chunk.index + 1}/${chunk.count}`, status: 'OK', error: null, detail: {
      toExamine: chunk.targets.map((d) => d.id), references: chunk.references.map((d) => d.id), traceId: sortie.traceId,
      families: out.families?.length ?? 0, proposals: out.document_renames?.length ?? null,
    } });
    // Familles décrites par l'IA (reporting, mémoire de convention).
    const idsAppel = new Set(appel.map((d) => d.id));
    for (const f of out.families ?? []) {
      res.families++;
      if (f.inconsistent) res.inconsistentFamilies++;
      rec.family(g.key, f, idsAppel);
    }
    if (out.families?.length) conventions = mergeConventions(conventions, out.families);
    if (out.document_renames === undefined) {
      res.renamesSectionMissing++;
      rec.steps.push({ step: `SORTIE ${g.key}`, status: 'SKIPPED', error: null, detail: { reason: 'RENAMES_SECTION_MISSING', note: 'Sortie sans section document_renames : aucune proposition (version du prompt qui ne la produit pas).' } });
    }
    await applyProposals(accountId, out.document_renames ?? [], { it, appel, etats, courants, traces, c, traceId: sortie.traceId, callKey: `${it.fp}:${chunk.index}:${[...idsAppel].sort((a, b) => a - b).join(',')}` });
    for (const d of chunk.targets) examines.add(d.id);
    res.documentsExamined += chunk.targets.length;
  }

  // Lot entièrement examiné : état final mémorisé (aucun nouvel appel à état inchangé).
  const finaux = [...courants.values()];
  await repo.saveGroupState(accountId, {
    key: g.key, status: 'DONE', fingerprint: groupFingerprint(finaux), progress: null, snapshot: groupSnapshot(finaux),
    conventions, promptVersion: c.prompt.version, retryAfter: null, attempts: 0, documentCount: g.docs.length, reviewed: true,
  });
  res.groupsExamined++;
  res.groupsCompleted++;
}

/** Conventions mémorisées : dernières familles décrites par l'IA (bornées), jamais un gabarit. */
function mergeConventions(avant: unknown[], familles: NonNullable<T3DocumentNamingOutput['families']>): unknown[] {
  const neuves = familles.filter((f) => f.convention).map((f) => ({ label: f.label, convention: f.convention, documentIds: [...f.document_ids].sort((a, b) => a - b).slice(0, 50) }));
  const libelles = new Set(neuves.map((f) => f.label));
  const anciennes = avant.filter((x) => !(x && typeof x === 'object' && libelles.has(String((x as { label?: unknown }).label))));
  return [...neuves, ...anciennes].slice(0, 20);
}

async function applyProposals(accountId: number, proposals: NamingProposal[], p: {
  it: Item;
  appel: NamingDoc[];
  etats: Map<number, NamingDocState & { trace?: NameTrace }>;
  courants: Map<number, NamingDoc>;
  /** Traces des noms (mises à jour après chaque écriture : origine et délai de stabilité des appels suivants). */
  traces: Map<number, NameTrace>;
  c: ExamCtx;
  traceId: string | null;
  callKey: string;
}): Promise<void> {
  const { repo, rec, res } = p.c;
  const { redact } = await import('../../gateway/redaction');
  const snap = new Map<number, NamingSnapshotDoc>();
  for (const d of p.appel) {
    const st = p.etats.get(d.id)!;
    const h = st.trace?.harmonization && st.trace.harmonization.name.trim() === d.name.trim() ? st.trace.harmonization : null;
    snap.set(d.id, {
      id: d.id, name: d.name, redactedName: redact(d.name), origin: st.origin, ids: { s3Key: d.s3Key, publicId: d.publicId },
      lastHarmonizedAt: h?.at ?? null, harmonizedFingerprint: h?.fingerprint ?? null, fingerprint: documentFingerprint(d),
    });
  }
  const vus = new Set<number>();
  const verdicts: Array<{ p: NamingProposal; v: ReturnType<typeof judgeProposal> }> = [];
  for (const prop of proposals) {
    res.proposals++;
    const doc = p.courants.get(prop.document_id);
    const known = doc && snap.has(doc.id) && snap.get(doc.id)!.origin !== 'USER' ? await repo.loadKnownData(accountId, doc) : null;
    verdicts.push({ p: prop, v: judgeProposal(prop, { docs: snap, seen: vus, known, now: p.c.now(), cooldownDays: p.c.cooldown }) });
  }
  const collisions = collidingProposals(
    verdicts.flatMap((x) => (x.v.accept ? [{ documentId: x.p.document_id, name: x.v.name }] : [])), snap,
  );
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
      const r = await repo.applyRename({ ...base, outcome: 'APPLIED', appliedName: verdict.name });
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
        rec.rename(p.it, prop, {
          writeResult: 'NOT_WRITTEN', reasonCode: r.reason, eventId: id, origin: s?.origin ?? null,
          reason: r.reason === 'CONCURRENT_USER_RENAME' ? `Renommé par l’utilisateur entre l’analyse IA et l’écriture : nom conservé (« ${r.currentName ?? ''} »)`
            : r.reason === 'DOCUMENT_GONE' ? 'Document supprimé entre l’analyse IA et l’écriture'
              : `Nom modifié entre l’analyse IA et l’écriture : nom conservé (« ${r.currentName ?? ''} »)`,
        });
      }
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      res.failed++;
      const motif = ((e as Error).message ?? 'erreur').slice(0, 300);
      const id = await repo.recordRenameEvent({ ...base, outcome: 'FAILED', reasonCode: 'WRITE_FAILED' }).catch(() => null);
      rec.rename(p.it, prop, { writeResult: 'FAILED', reasonCode: 'WRITE_FAILED', reason: `Écriture en échec : ${motif}`, eventId: id, origin: s?.origin ?? null });
    }
  }
}

// ── Reporting (rapport d'exécution T3, lot 58) ─────────────────────────────

interface RenameLine {
  writeResult: ReportEntry['writeResult'];
  reasonCode: string;
  reason: string | null;
  eventId: number | null;
  origin: string | null;
  applied?: string;
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

  notExamined(it: Item, code: string, reason: string): void {
    this.notExaminedCount++;
    if (this.notExaminedCount > NOT_EXAMINED_DETAIL_MAX) return;
    this.entries.push({
      section: 'NAMING_GROUP', tableName: 'document_naming_groups', columnPath: 'status', fieldKey: it.group.key,
      label: `Lot ${it.group.key} (${it.group.docs.length} documents)`, value: it.group.docs.map((d) => d.id).slice(0, 50),
      writeResult: 'NOT_EXAMINED', reasonCode: code, reason, links: { groupKey: it.group.key, documents: it.group.docs.length },
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
        status: reportStatus({ failed: false, entries: renames, steps: this.steps, treatment: 'T3' }),
        counters: {
          documents: res.documents, groups: res.groups, groupsDue: res.groupsDue, groupsExamined: res.groupsExamined,
          documentsExamined: res.documentsExamined, families: res.families, inconsistentFamilies: res.inconsistentFamilies,
          proposals: res.proposals, written: renames.filter((e) => e.writeResult === 'WRITTEN').length, refused: res.refused,
          conflicts: res.conflicts, unchanged: res.unchanged, failed: res.failed, aiCalls: res.aiCalls, deferred: res.deferred,
          errors: res.errors, notExamined: this.notExaminedCount, withoutContext: res.withoutContext,
          renamesSectionMissing: res.renamesSectionMissing, promptUnavailable: res.promptAvailable === false ? 1 : 0,
        },
        steps: this.steps,
        sources: {
          section: 'Harmonisation documentaire',
          promptVersion: res.promptVersion, promptBranchAvailable: res.promptAvailable,
          documentsRead: { table: 'asset_files', count: res.documents, withoutComparableContext: res.withoutContext },
          history: { table: 'document_rename_events', note: 'APPLIED = renommages enregistrés (ancien / nouveau nom, origine, date, justification)' },
          groupsState: { table: 'document_naming_groups' },
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
