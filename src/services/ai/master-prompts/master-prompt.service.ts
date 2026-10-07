/**
 * Administration des prompts maîtres T1–T4 et T6 depuis le BO — ticket
 * BO-IA-PROMPTS-01.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CYCLE DE VIE : BROUILLON → ACTIF, ET RIEN D'AUTRE
 *
 *   Modifier → Enregistrer → (éventuellement Tester) → Activer
 *   Historique → Réactiver une ancienne version
 *
 * Chaque prompt s'administre INDÉPENDAMMENT des autres (AC06) et de la
 * version de configuration IA (modèles, replis, garde-fous) : activer T2 ne
 * lit ni l'état de T1, T3, T4, T6, ni aucun corpus. Seuls les contrôles
 * TECHNIQUES (`master-prompt-checks.ts`) bloquent une activation (AC09).
 *
 * Le corpus (« Tester avec le corpus ») est FACULTATIF (AC12) : ses
 * résultats sont rattachés à la version et à l'empreinte exacte du texte
 * testé (AC13, AC14), affichés à titre informatif (badge « Non testé »,
 * « 3 scénarios en échec sur 50 »), jamais exigés (AC03 à AC05).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * VERSIONS IMMUABLES, HISTORIQUE COMPLET
 *
 * Une version activée n'est jamais modifiée en place (déclencheur 0254) :
 * modifier l'Actif crée un brouillon (AC01, AC02). Activer passe l'ancienne
 * active en « Ancienne » (AC10) ; « Réactiver cette version » rend l'Actif à
 * une ancienne version sans rien effacer (AC11). Chaque bascule est journalisée
 * (prompt, version, utilisateur, date, ancienne et nouvelle version).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PRISE EN COMPTE IMMÉDIATE (AC15)
 *
 * Après chaque bascule : clé de version partagée `ai-config` incrémentée
 * (tous les conteneurs rechargent à l'appel suivant, ≤ 1 s), caches locaux
 * vidés (configuration, version tracée, fichiers de prompts). La version du
 * master entre dans les clés d'idempotence et du cache T6
 * (`code@pv<id>:<empreinte>`) : aucune sortie produite sous l'ancien texte
 * n'est resservie.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getAiEnvironment, type AiEnvironment } from '../config/environment';
import { T5_TARGETS, TREATMENT_DEFINITIONS, isTreatment, type Treatment } from '../config/treatments';
import { masterPromptForTreatment } from '../config/prompt-architecture';
import { masterPromptVersionOf } from '../prompts/prompt-loader';
import { checkMasterPromptContent, MASTER_PROMPT_MAX_CHARS, type MasterPromptIssue } from './master-prompt-checks';
import * as repo from './master-prompt.repository';
import type { MasterPromptTestRunRow, MasterPromptVersionRow, MasterPromptActivationRow, TestFailure } from './master-prompt.repository';

/** Refus fonctionnel (409), contrôle technique (422) ou introuvable (404). */
export class MasterPromptRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly httpStatus = 409,
  ) {
    super(message);
    this.name = 'MasterPromptRefused';
  }
}

/** Prompts administrables : T1, T2, T3, T4, T6 (T5 : dépôt, CDC BO IA T5-003). */
export const ADMIN_MASTER_TREATMENTS: readonly Treatment[] = T5_TARGETS;

export function assertAdministrable(raw: string): Treatment {
  if (!isTreatment(raw) || !ADMIN_MASTER_TREATMENTS.includes(raw) || !masterPromptForTreatment(raw)) {
    throw new MasterPromptRefused('UNKNOWN_PROMPT',
      raw === 'T5'
        ? 'Le prompt de Prompt Control (T5) est défini dans le dépôt : il n’est pas administrable.'
        : `Prompt « ${raw} » inconnu.`, null, 404);
  }
  return raw;
}

/** Une exécution « en cours » plus ancienne est présentée comme interrompue. */
export const TEST_RUN_STALE_MS = 10 * 60_000;
/** Durée maximale d'un test (rejeu, aucun appel modèle : quelques secondes au pire). */
export const TEST_RUN_TIMEOUT_MS = 120_000;

// ── Vues rendues au BO ──────────────────────────────────────────────────────

export interface TestRunView {
  id: number;
  status: 'RUNNING' | 'DONE' | 'ERROR';
  startedAt: string;
  finishedAt: string | null;
  total: number;
  passed: number;
  failed: number;
  failures: TestFailure[];
  error: string | null;
  /** Le test porte sur le texte actuel de la version. */
  current: boolean;
  requestedBy: string | null;
}

/** État des tests d'une version — information, jamais une condition. */
export type TestState =
  | { state: 'never'; label: 'Non testé'; message: string; previous: TestRunView | null }
  | { state: 'running'; label: 'Test en cours'; message: string; run: TestRunView }
  | { state: 'done'; label: string; message: string; run: TestRunView }
  | { state: 'error'; label: 'Test interrompu'; message: string; run: TestRunView };

export interface VersionView {
  id: number;
  versionNumber: number;
  status: repo.MasterPromptStatus;
  statusLabel: string;
  origin: repo.MasterPromptOrigin;
  originLabel: string;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  activatedAt: string | null;
  activatedBy: string | null;
  basedOnVersionNumber: number | null;
  contentLength: number;
  test: TestState;
  /** Volet « Détails techniques » : jamais dans le message principal (AC08). */
  technical: { masterPromptCode: string; contentSha256: string; runtimeVersion: string; versionId: number };
}

export interface ActivationView {
  id: number;
  action: 'activate' | 'rollback';
  actionLabel: string;
  fromVersionNumber: number | null;
  toVersionNumber: number;
  user: string | null;
  at: string;
  testSummary: string | null;
}

export interface PromptSummary {
  treatment: Treatment;
  label: string;
  masterPromptCode: string;
  active: { versionNumber: number | null; initial: boolean; activatedAt: string | null; test: TestState };
  draft: { versionNumber: number; updatedAt: string; test: TestState } | null;
}

export interface PromptDetail {
  treatment: Treatment;
  label: string;
  masterPromptCode: string;
  environment: string;
  /** Aucune version encore historisée : l'Actif est le texte qui s'exécute déjà. */
  initial: boolean;
  active: (VersionView & { content: string }) | null;
  /** Texte actif quand aucune version n'est encore historisée (`initial`). */
  initialContent: { content: string; source: 'config' | 'file' } | null;
  draft: (VersionView & { content: string; issues: MasterPromptIssue[]; warnings: MasterPromptIssue[] }) | null;
  history: VersionView[];
  activations: ActivationView[];
  limits: { maxChars: number };
}

const STATUS_LABEL: Record<repo.MasterPromptStatus, string> = { DRAFT: 'Brouillon', ACTIVE: 'Active', PREVIOUS: 'Ancienne' };
const ORIGIN_LABEL: Record<repo.MasterPromptOrigin, string> = {
  initial_file: 'Version initiale (texte livré avec l’application)',
  initial_config: 'Version initiale (texte de la configuration IA)',
  admin: 'Modifiée depuis le BO',
  prompt_control: 'Proposée par Prompt Control',
};

const iso = (x: Date | null) => (x ? x.toISOString() : null);

function runView(r: MasterPromptTestRunRow, sha: string, emails: Map<number, string>, now = Date.now()): TestRunView {
  const interrompu = r.status === 'RUNNING' && now - r.startedAt.getTime() > TEST_RUN_STALE_MS;
  return {
    id: r.id,
    status: interrompu ? 'ERROR' : r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: iso(r.finishedAt),
    total: r.scenariosTotal,
    passed: r.scenariosPassed,
    failed: r.scenariosFailed,
    failures: r.failures,
    error: interrompu ? 'Le test a été interrompu avant la fin. Relancez-le.' : r.error,
    current: r.contentSha256 === sha,
    requestedBy: r.requestedBy == null ? null : emails.get(r.requestedBy) ?? null,
  };
}

/**
 * État des tests d'une version : SEULE une exécution portant sur le texte
 * ACTUEL compte (AC14). Les exécutions d'un contenu antérieur restent
 * consultables (`previous`), jamais présentées comme celles du texte actuel.
 */
export function testStateOf(runs: TestRunView[]): TestState {
  const actuels = runs.filter((r) => r.current);
  const dernier = actuels[0];
  if (!dernier) {
    return {
      state: 'never', label: 'Non testé', message: 'Cette version n’a pas encore été testée.',
      previous: runs.find((r) => !r.current) ?? null,
    };
  }
  if (dernier.status === 'RUNNING') return { state: 'running', label: 'Test en cours', message: 'Test du corpus en cours…', run: dernier };
  if (dernier.status === 'ERROR') {
    return { state: 'error', label: 'Test interrompu', message: dernier.error ?? 'Le test n’a pas abouti.', run: dernier };
  }
  return {
    state: 'done',
    label: `Tests ${dernier.passed}/${dernier.total}`,
    message: dernier.failed === 0
      ? `${dernier.passed}/${dernier.total} scénarios réussis.`
      : `${dernier.failed} scénario${dernier.failed > 1 ? 's' : ''} en échec sur ${dernier.total}.`,
    run: dernier,
  };
}

/** Résumé texte des tests au moment d'une activation (journal). */
export function testSummaryText(t: TestState): string {
  if (t.state === 'done') return t.run.failed === 0 ? `Testée : ${t.run.passed}/${t.run.total}` : `Testée : ${t.run.failed} échec(s) sur ${t.run.total}`;
  if (t.state === 'never') return 'Non testée';
  return t.label;
}

function versionView(
  v: MasterPromptVersionRow, runs: TestRunView[], emails: Map<number, string>, numbers: Map<number, number>,
): VersionView {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    status: v.status,
    statusLabel: STATUS_LABEL[v.status],
    origin: v.origin,
    originLabel: ORIGIN_LABEL[v.origin],
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdBy == null ? null : emails.get(v.createdBy) ?? null,
    updatedAt: v.updatedAt.toISOString(),
    activatedAt: iso(v.activatedAt),
    activatedBy: v.activatedBy == null ? null : emails.get(v.activatedBy) ?? null,
    basedOnVersionNumber: v.basedOnId == null ? null : numbers.get(v.basedOnId) ?? null,
    contentLength: v.content.length,
    test: testStateOf(runs),
    technical: {
      masterPromptCode: v.masterPromptCode,
      contentSha256: v.contentSha256,
      runtimeVersion: masterPromptVersionOf({ masterPromptCode: v.masterPromptCode, configuredText: v.content, promptVersionId: v.id }),
      versionId: v.id,
    },
  };
}

// ── Texte qui s'exécute aujourd'hui (version initiale) ──────────────────────

/**
 * Texte du prompt EN SERVICE quand aucune version n'est encore historisée :
 * celui de la version de configuration effective (D-03), sinon le fichier du
 * dépôt. Devient la v1 au premier geste (brouillon, test, activation).
 */
export async function runtimeBaseline(treatment: Treatment, environment: AiEnvironment = getAiEnvironment()): Promise<{ content: string; source: 'config' | 'file' }> {
  const master = masterPromptForTreatment(treatment)!;
  try {
    const [{ getEffectiveVersion }, { masterPromptOf, promptArchitectureOf }] = await Promise.all([
      import('../config/config-version.repository'), import('../config/config-types'),
    ]);
    const version = await getEffectiveVersion(environment);
    const entry = version?.entries.find((e) => e.treatment === treatment);
    const texte = entry && promptArchitectureOf(entry) === 'master' ? masterPromptOf(entry) : null;
    if (texte) return { content: texte, source: 'config' };
  } catch { /* configuration illisible : fichier du dépôt */ }
  const { readMasterFileFromRepo } = await import('../governance/master-corpus/cases');
  return { content: readMasterFileFromRepo(master.masterPromptCode), source: 'file' };
}

async function assertTables(): Promise<void> {
  if (!(await repo.masterPromptTablesReady().catch(() => false))) {
    throw new MasterPromptRefused('PROMPT_ADMIN_UNAVAILABLE',
      'L’administration des prompts maîtres n’est pas encore disponible : la mise à jour de la base est en cours. Réessayez dans quelques minutes.',
      null, 503);
  }
}

/** Active du prompt, créée (v1) à partir du texte en service si besoin. */
async function ensureActive(treatment: Treatment, environment: AiEnvironment): Promise<MasterPromptVersionRow> {
  const active = await repo.getActive(environment, treatment);
  if (active) return active;
  const base = await runtimeBaseline(treatment, environment);
  return repo.ensureInitialVersion({
    environment, treatment, masterPromptCode: masterPromptForTreatment(treatment)!.masterPromptCode,
    content: base.content, origin: base.source === 'config' ? 'initial_config' : 'initial_file',
  });
}

// ── Lectures ────────────────────────────────────────────────────────────────

async function runsByVersion(versions: MasterPromptVersionRow[]): Promise<{ byVersion: Map<number, TestRunView[]>; emails: Map<number, string> }> {
  const runs = await repo.listTestRuns(versions.map((v) => v.id));
  const emails = await repo.userEmails([
    ...versions.flatMap((v) => [v.createdBy, v.activatedBy]),
    ...runs.map((r) => r.requestedBy),
  ].filter((x): x is number => x != null));
  const sha = new Map(versions.map((v) => [v.id, v.contentSha256]));
  const byVersion = new Map<number, TestRunView[]>();
  for (const r of runs) {
    const liste = byVersion.get(r.promptVersionId) ?? [];
    liste.push(runView(r, sha.get(r.promptVersionId) ?? '', emails));
    byVersion.set(r.promptVersionId, liste);
  }
  return { byVersion, emails };
}

/** Vue d'ensemble : un résumé par prompt administrable. */
export async function listPromptSummaries(environment: AiEnvironment = getAiEnvironment()): Promise<PromptSummary[]> {
  await assertTables();
  const out: PromptSummary[] = [];
  for (const t of ADMIN_MASTER_TREATMENTS) {
    const master = masterPromptForTreatment(t);
    if (!master) continue;
    const versions = (await repo.listPromptVersions(environment, t)).filter((v) => v.status !== 'PREVIOUS');
    const { byVersion } = await runsByVersion(versions);
    const active = versions.find((v) => v.status === 'ACTIVE');
    const draft = versions.find((v) => v.status === 'DRAFT');
    const etat = (v: MasterPromptVersionRow | undefined) => testStateOf(v ? byVersion.get(v.id) ?? [] : []);
    out.push({
      treatment: t, label: TREATMENT_DEFINITIONS[t].label, masterPromptCode: master.masterPromptCode,
      active: { versionNumber: active?.versionNumber ?? null, initial: !active, activatedAt: iso(active?.activatedAt ?? null), test: etat(active) },
      draft: draft ? { versionNumber: draft.versionNumber, updatedAt: draft.updatedAt.toISOString(), test: etat(draft) } : null,
    });
  }
  return out;
}

/** Détail d'un prompt : actif, brouillon, historique, journal des activations. */
export async function getPromptDetail(treatment: Treatment, environment: AiEnvironment = getAiEnvironment()): Promise<PromptDetail> {
  await assertTables();
  const master = masterPromptForTreatment(treatment)!;
  const versions = await repo.listPromptVersions(environment, treatment);
  const { byVersion, emails } = await runsByVersion(versions);
  const numbers = new Map(versions.map((v) => [v.id, v.versionNumber]));
  const vue = (v: MasterPromptVersionRow) => versionView(v, byVersion.get(v.id) ?? [], emails, numbers);
  const active = versions.find((v) => v.status === 'ACTIVE') ?? null;
  const draft = versions.find((v) => v.status === 'DRAFT') ?? null;
  const activations = await repo.listActivations(environment, treatment);
  const checks = draft ? checkMasterPromptContent(treatment, draft.content) : null;
  return {
    treatment, label: TREATMENT_DEFINITIONS[treatment].label, masterPromptCode: master.masterPromptCode, environment,
    initial: !active,
    active: active ? { ...vue(active), content: active.content } : null,
    initialContent: active ? null : await runtimeBaseline(treatment, environment),
    draft: draft && checks ? { ...vue(draft), content: draft.content, issues: checks.blocking, warnings: checks.warnings } : null,
    history: versions.filter((v) => v.status !== 'DRAFT').map(vue),
    activations: activations.map(activationView),
    limits: { maxChars: MASTER_PROMPT_MAX_CHARS },
  };
}

function activationView(a: MasterPromptActivationRow): ActivationView {
  return {
    id: a.id, action: a.action,
    actionLabel: a.action === 'rollback' ? 'Réactivation' : 'Activation',
    fromVersionNumber: a.fromVersionNumber, toVersionNumber: a.toVersionNumber,
    user: a.userEmail, at: a.createdAt.toISOString(), testSummary: a.testSummary,
  };
}

/** Une version (texte compris) et ses tests. */
export async function getPromptVersionDetail(treatment: Treatment, versionId: number): Promise<VersionView & { content: string; runs: TestRunView[] }> {
  await assertTables();
  const v = await repo.getPromptVersion(versionId);
  if (!v || v.treatment !== treatment || v.environment !== getAiEnvironment()) {
    throw new MasterPromptRefused('VERSION_NOT_FOUND', 'Version introuvable.', null, 404);
  }
  const { byVersion, emails } = await runsByVersion([v]);
  const runs = byVersion.get(v.id) ?? [];
  const numbers = new Map<number, number>();
  if (v.basedOnId) {
    const base = await repo.getPromptVersion(v.basedOnId);
    if (base) numbers.set(base.id, base.versionNumber);
  }
  return { ...versionView(v, runs, emails, numbers), content: v.content, runs };
}

// ── Brouillon (AC01, AC02) ──────────────────────────────────────────────────

/**
 * Ouvre le brouillon du prompt : l'existant, ou un nouveau, copie du texte
 * ACTIF. L'Actif n'est jamais touché (AC01) ; le brouillon est une version
 * distincte, jamais utilisée par l'application (AC02).
 */
export async function startDraft(treatment: Treatment, userId: number, content?: string): Promise<MasterPromptVersionRow> {
  await assertTables();
  const environment = getAiEnvironment();
  const existant = await repo.getDraft(environment, treatment);
  if (existant) {
    return content === undefined ? existant : saveDraft(treatment, existant.id, content, userId);
  }
  const active = await ensureActive(treatment, environment);
  const texte = content ?? active.content;
  assertStorable(texte);
  const cree = await repo.insertDraft({
    environment, treatment, masterPromptCode: active.masterPromptCode, content: texte,
    origin: 'admin', basedOnId: active.id, userId,
  });
  // Création concurrente : un autre administrateur vient d'ouvrir le brouillon.
  return cree ?? (await repo.getDraft(environment, treatment))!;
}

function assertStorable(content: string): void {
  if (typeof content !== 'string') throw new MasterPromptRefused('INVALID_CONTENT', 'Le texte du prompt est illisible.', null, 400);
  // Caractère nul : impossible à enregistrer (PostgreSQL le refuse).
  if (content.includes('\u0000')) {
    throw new MasterPromptRefused('INVALID_CONTENT',
      'Le texte contient un caractère invalide (caractère nul) : recollez-le depuis un éditeur de texte.', null, 400);
  }
  // Enregistrer un brouillon imparfait est permis (il n'est pas utilisé) ;
  // seule une taille déraisonnable est refusée dès l'enregistrement.
  if (content.length > MASTER_PROMPT_MAX_CHARS * 2) {
    throw new MasterPromptRefused('TOO_LONG', `Le texte dépasse la taille maximale (${MASTER_PROMPT_MAX_CHARS.toLocaleString('fr-FR')} caractères).`, null, 400);
  }
}

/** Enregistre le texte du brouillon. Une version active ou ancienne n'est jamais modifiable. */
export async function saveDraft(treatment: Treatment, versionId: number, content: string, userId: number): Promise<MasterPromptVersionRow> {
  await assertTables();
  assertStorable(content);
  const v = await repo.getPromptVersion(versionId);
  if (!v || v.treatment !== treatment || v.environment !== getAiEnvironment()) {
    throw new MasterPromptRefused('VERSION_NOT_FOUND', 'Version introuvable.', null, 404);
  }
  if (v.status !== 'DRAFT') {
    throw new MasterPromptRefused('VERSION_NOT_EDITABLE',
      `La version v${v.versionNumber} n’est plus un brouillon : elle ne peut pas être modifiée. Cliquez sur « Modifier » pour créer un nouveau brouillon.`);
  }
  const ecrit = await repo.updateDraftContent({ id: versionId, content, userId });
  if (!ecrit) {
    throw new MasterPromptRefused('VERSION_NOT_EDITABLE', 'Ce brouillon vient d’être activé ou abandonné : rechargez la page.');
  }
  return ecrit;
}

export async function discardDraft(treatment: Treatment, versionId: number): Promise<void> {
  await assertTables();
  const v = await repo.getPromptVersion(versionId);
  if (!v || v.treatment !== treatment || v.environment !== getAiEnvironment() || v.status !== 'DRAFT') {
    throw new MasterPromptRefused('VERSION_NOT_FOUND', 'Brouillon introuvable.', null, 404);
  }
  await repo.deleteDraft(versionId);
}

// ── Activation et réactivation (AC03 à AC11, AC15) ──────────────────────────

export interface SwitchOutcome {
  treatment: Treatment;
  previousVersionNumber: number | null;
  activeVersionNumber: number;
  activeVersionId: number;
  /** Informations NON bloquantes (tests, emplacements facultatifs). */
  notices: string[];
}

/**
 * Active le brouillon : contrôles techniques, puis bascule, journal et
 * invalidation. AUCUN corpus n'est lu ni exigé (AC03, AC04, AC05), aucun
 * autre prompt n'est consulté (AC06).
 */
export async function activateDraft(treatment: Treatment, versionId: number, userId: number): Promise<SwitchOutcome> {
  return switchTo(treatment, versionId, userId, 'activate');
}

/** « Réactiver cette version » depuis l'historique (AC11). L'Actif courant reste dans l'historique. */
export async function reactivateVersion(treatment: Treatment, versionId: number, userId: number): Promise<SwitchOutcome> {
  return switchTo(treatment, versionId, userId, 'rollback');
}

async function switchTo(treatment: Treatment, versionId: number, userId: number, action: 'activate' | 'rollback'): Promise<SwitchOutcome> {
  await assertTables();
  const environment = getAiEnvironment();
  const v = await repo.getPromptVersion(versionId);
  if (!v || v.treatment !== treatment || v.environment !== environment) {
    throw new MasterPromptRefused('VERSION_NOT_FOUND', 'Version introuvable.', null, 404);
  }
  if (action === 'activate' && v.status !== 'DRAFT') {
    throw new MasterPromptRefused('NOT_A_DRAFT', v.status === 'ACTIVE'
      ? `La version v${v.versionNumber} est déjà active.`
      : `La version v${v.versionNumber} n’est pas un brouillon : utilisez « Réactiver cette version » depuis l’historique.`);
  }
  if (action === 'rollback' && v.status !== 'PREVIOUS') {
    throw new MasterPromptRefused('NOT_REACTIVABLE', v.status === 'ACTIVE'
      ? `La version v${v.versionNumber} est déjà active.`
      : `La version v${v.versionNumber} est un brouillon : utilisez « Activer ».`);
  }

  // AC09 — seuls les défauts qui empêchent réellement l'exécution bloquent.
  const checks = checkMasterPromptContent(treatment, v.content);
  if (!checks.ok) {
    throw new MasterPromptRefused('TECHNICAL_CHECK_FAILED',
      `Activation impossible : ${checks.blocking.map((i) => i.message).join(' ')}`,
      { issues: checks.blocking }, 422);
  }

  // Initiale : l'Actif en service devient la v1 de l'historique avant bascule.
  await ensureActive(treatment, environment);

  // État des tests : INFORMATIF (journal, message), jamais une condition.
  const { byVersion, emails } = await runsByVersion([v]);
  const tests = testStateOf(byVersion.get(v.id) ?? []);
  const email = (await repo.userEmails([userId])).get(userId) ?? emails.get(userId) ?? null;

  const r = await repo.switchActivePrompt({
    environment, treatment, targetId: v.id, action, userId, userEmail: email, testSummary: testSummaryText(tests),
  });
  if ('refused' in r) {
    throw new MasterPromptRefused(r.refused === 'NOT_FOUND' ? 'VERSION_NOT_FOUND' : 'VERSION_CHANGED',
      r.refused === 'NOT_FOUND' ? 'Version introuvable.' : 'La version vient de changer d’état : rechargez la page.',
      null, r.refused === 'NOT_FOUND' ? 404 : 409);
  }

  await invalidateAfterSwitch(treatment, r.current.versionNumber, r.current.masterPromptCode);
  await recordAudit({ userId, email, treatment, action, from: r.previous, to: r.current, tests: testSummaryText(tests) });

  const notices: string[] = [];
  if (tests.state === 'never') notices.push('Cette version n’a pas encore été testée avec le corpus.');
  if (tests.state === 'done' && tests.run.failed > 0) notices.push(tests.message);
  for (const w of checks.warnings) notices.push(w.message);
  return {
    treatment, previousVersionNumber: r.previous?.versionNumber ?? null,
    activeVersionNumber: r.current.versionNumber, activeVersionId: r.current.id, notices,
  };
}

/**
 * AC15 — la nouvelle version est utilisée dès l'appel suivant : clé de
 * version partagée (tous les conteneurs, ≤ 1 s), puis caches de CE conteneur.
 */
export async function invalidateAfterSwitch(treatment: Treatment, versionNumber: number, masterPromptCode: string): Promise<void> {
  const [{ bumpConfigVersionCounter }, { invalidateConfigCache }, { invalidateConfigVersionCache }, { invalidatePromptCache }] = await Promise.all([
    import('../config/config-cache-version'), import('../config/config-resolver'),
    import('../telemetry/execution-context'), import('../prompts/prompt-loader'),
  ]);
  await bumpConfigVersionCounter(`prompt:${treatment}:v${versionNumber}`);
  invalidateConfigCache();
  invalidateConfigVersionCache();
  invalidatePromptCache(masterPromptCode);
}

async function recordAudit(a: {
  userId: number; email: string | null; treatment: Treatment; action: 'activate' | 'rollback';
  from: MasterPromptVersionRow | null; to: MasterPromptVersionRow; tests: string;
}): Promise<void> {
  // Le journal dédié est écrit dans la transaction de bascule ; ce double
  // dans le journal des gestes d'administration IA est best effort.
  try {
    const [{ db }, { aiAdminAuditLog }] = await Promise.all([import('@/db'), import('@/db/schema')]);
    await db.insert(aiAdminAuditLog).values({
      adminUserId: a.userId,
      adminEmail: a.email ?? `user:${a.userId}`,
      actionType: a.action === 'rollback' ? 'ai_master_prompt_rollback' : 'ai_master_prompt_activate',
      beforeValue: { treatment: a.treatment, versionId: a.from?.id ?? null, versionNumber: a.from?.versionNumber ?? null },
      afterValue: { treatment: a.treatment, versionId: a.to.id, versionNumber: a.to.versionNumber, tests: a.tests },
      reason: null,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error('[master-prompts] journal d’administration non écrit :', (e as Error).message);
  }
}

// ── Tests du corpus (AC12, AC13, AC14) ──────────────────────────────────────

/**
 * « Tester avec le corpus » sur une version (brouillon, active ou ancienne).
 * Facultatif. Le résultat est rattaché à la version ET à l'empreinte du
 * texte testé. Rejeu sans appel modèle : exécuté dans la requête, borné ;
 * l'exécution est enregistrée avant de démarrer (statut consultable).
 */
export async function runPromptTest(treatment: Treatment, versionId: number | 'active', userId: number): Promise<TestRunView> {
  await assertTables();
  const environment = getAiEnvironment();
  const v = versionId === 'active' ? await ensureActive(treatment, environment) : await repo.getPromptVersion(versionId);
  if (!v || v.treatment !== treatment || v.environment !== environment) {
    throw new MasterPromptRefused('VERSION_NOT_FOUND', 'Version introuvable.', null, 404);
  }
  const runId = await repo.insertTestRun({
    promptVersionId: v.id, environment, treatment, contentSha256: v.contentSha256, requestedBy: userId,
  });
  try {
    const { runCorpusOnText } = await import('./master-prompt-corpus');
    const r = await Promise.race([
      runCorpusOnText(treatment, v.content),
      new Promise<never>((_ok, ko) => setTimeout(() => ko(new Error('délai dépassé')), TEST_RUN_TIMEOUT_MS).unref?.()),
    ]);
    await repo.finishTestRun(runId, { status: 'DONE', total: r.total, passed: r.passed, failed: r.failed, failures: r.failures, details: r.details });
  } catch (e) {
    console.error('[master-prompts] test du corpus en échec :', (e as Error).message);
    await repo.finishTestRun(runId, {
      status: 'ERROR', total: 0, passed: 0, failed: 0, failures: [],
      error: 'Le test n’a pas pu s’exécuter. Relancez-le ; si l’erreur persiste, consultez les journaux techniques.',
      details: { cause: (e as Error).message.slice(0, 500) },
    });
  }
  return getPromptTestRun(treatment, runId);
}

export async function getPromptTestRun(treatment: Treatment, runId: number): Promise<TestRunView> {
  await assertTables();
  const r = await repo.getTestRun(runId);
  if (!r || r.treatment !== treatment) throw new MasterPromptRefused('TEST_RUN_NOT_FOUND', 'Test introuvable.', null, 404);
  const v = await repo.getPromptVersion(r.promptVersionId);
  const emails = await repo.userEmails(r.requestedBy == null ? [] : [r.requestedBy]);
  return runView(r, v?.contentSha256 ?? '', emails);
}

// ── Prompt Control (T5) : lecture et écriture des textes de travail ─────────

export interface WorkingText {
  treatment: Treatment;
  text: string;
  /** Brouillon lu (écriture conditionnelle), sinon `null`. */
  draftId: number | null;
  activeId: number | null;
}

/**
 * Textes des prompts administrés au BO, pour Prompt Control. `analyze` lit
 * l'ACTIF (ce qui tourne) ; `modify` lit le brouillon s'il existe, sinon
 * l'Actif (le brouillon en sera la suite). Seuls les prompts qui ont déjà
 * une version au BO sont rendus ; les autres restent lus dans la version de
 * configuration ou le dépôt, comme avant. Tables absentes : vide.
 */
export async function workingTexts(mode: 'analyze' | 'modify', environment: AiEnvironment = getAiEnvironment()): Promise<Map<Treatment, WorkingText>> {
  const out = new Map<Treatment, WorkingText>();
  if (!(await repo.masterPromptTablesReady().catch(() => false))) return out;
  for (const t of ADMIN_MASTER_TREATMENTS) {
    const active = await repo.getActive(environment, t);
    const draft = mode === 'modify' ? await repo.getDraft(environment, t) : null;
    const lu = draft ?? active;
    if (lu) out.set(t, { treatment: t, text: lu.content, draftId: draft?.id ?? null, activeId: active?.id ?? null });
  }
  return out;
}

/**
 * Écrit une proposition de Prompt Control dans le BROUILLON du prompt —
 * jamais dans l'Actif. Écriture conditionnelle : le brouillon lu doit avoir
 * encore le texte lu (`expected`) ; sans brouillon lu, aucun ne doit avoir
 * été créé entre-temps. `null` : conflit, rien n'est écrasé.
 */
export async function writeDraftFromPromptControl(p: {
  treatment: Treatment; expected: string; readDraftId: number | null; readActiveId: number | null; next: string; userId: number;
}): Promise<MasterPromptVersionRow | null> {
  await assertTables();
  const environment = getAiEnvironment();
  if (p.readDraftId !== null) {
    return repo.updateDraftContent({ id: p.readDraftId, content: p.next, userId: p.userId, expectedContent: p.expected });
  }
  if (await repo.getDraft(environment, p.treatment)) return null;
  // Actif lu par T5 remplacé entre-temps (activation, réactivation) : la
  // proposition porte sur un texte qui ne tourne plus — conflit.
  const enService = await repo.getActive(environment, p.treatment);
  if (p.readActiveId !== null && enService?.id !== p.readActiveId) return null;
  const active = enService ?? await ensureActive(p.treatment, environment);
  return repo.insertDraft({
    environment, treatment: p.treatment, masterPromptCode: active.masterPromptCode, content: p.next,
    origin: 'prompt_control', basedOnId: active.id, userId: p.userId,
  });
}
