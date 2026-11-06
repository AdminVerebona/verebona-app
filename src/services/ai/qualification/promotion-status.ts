/**
 * Lot 105B — ÉTAT RÉEL de la promotion automatique IA (ticket P1 « IA
 * auto-amélioration », §5) — MÊME lecture pour BO › Configuration IA ›
 * Promotion automatique, la note des tâches planifiées, la Supervision et le
 * diagnostic global (`ia/promotion-automatique.json`). Lecture seule.
 *
 * Distingue sans jamais les confondre :
 *   (a) planificateur LANCÉ (tâches IA : dernière exécution, prochaine, note) ;
 *   (b) tests RÉELLEMENT exécutés avec un compte technique valide (cas joués,
 *       appels fournisseur, coût — 0 dit « 0 ») ;
 *   (c) couverture du corpus et des risques (manques A1 par traitement,
 *       exigences du référentiel d'inventaire, exclusions motivées) ;
 *   (d) blocages : verrou A1, compte technique, absence de preuve ;
 *   (e) candidates créées / qualifiées / bloquées A1 / refusées / activées /
 *       surveillées / restaurées.
 * « Fonctionnement automatique » n'est affiché QUE si une progression
 * effective existe (activation sur la période) ; tests à zéro, blocage A1 ou
 * compte invalide sont dits tels quels (santé fonctionnelle 103G).
 * Aucune donnée de compte client, aucun secret.
 */
import { getAiEnvironment } from '../config/environment';
import type { Treatment } from '../config/treatments';
import { TREATMENTS } from '../config/treatments';
import { listPromotionEvents, type PromotionEvent } from './promotion-journal';
import { promotionParams } from './promotion-params';

type Row = Record<string, unknown>;
type Query = (text: string, params: unknown[]) => Promise<Row[]>;

/** Tâches planifiées de la chaîne de promotion (ordre d'exécution). */
export const PROMOTION_TASKS = ['ai-catalog-sync', 'ai-qualification-campaign', 'ai-prompt-conformity', 'ai-promotion-watch'] as const;

export type PromotionHealthCode = 'AUTOMATIC_PROGRESS' | 'NO_PROGRESS' | 'BLOCKED_A1' | 'BLOCKED_ACCOUNT' | 'NO_TESTS' | 'PRODUCTION_MANUAL';

export interface PromotionHealth { code: PromotionHealthCode; automatic: boolean; label: string; cause: string | null; nextAction: string | null }

/** Ce qui reste DIFFÉRÉ (P2) — affiché tel quel : jamais « auto-amélioration complète ». */
export const DEFERRED_P2: ReadonlyArray<{ title: string; needs: string[] }> = [
  {
    title: 'Amélioration autonome des prompts au-delà des contrats officiels (§4 P2)',
    needs: [
      'détection de défauts métier RÉPÉTÉS et PROUVÉS reliés à des cas certifiés et à leurs sources (ex. ellipse T2, omission T1, faux rapprochement T3)',
      'oracle indépendant approuvé pour chaque défaut ciblé (sinon : diagnostic explicite, aucune activation)',
      'générateur de correction candidate BORNÉ et versionné, soumis au guide PO, aux tests et à la revue des faits (aucun texte de prompt écrit par le développeur)',
      'garde anti-apprentissage sur des sorties non fiables (aucune sortie de modèle comme vérité)',
    ],
  },
  {
    title: 'Optimisation des paramètres techniques des configurations (§4 P2)',
    needs: [
      'objectifs et bornes explicites validés par le PO : profil par opération, niveau de raisonnement, délai, budget de jetons, chaîne de replis',
      'comparaison sur les MÊMES cas certifiés, modèles réellement servis (aucun repli masqué), latence, coût par résultat valide, concurrence',
      'garde « jamais activer un réglage non démontré meilleur », aucun changement silencieux de repli, aucune version créée en boucle',
    ],
  },
];

async function safe(query: Query, text: string, params: unknown[] = []): Promise<Row[]> {
  try { return await query(text, params); } catch { return []; }
}

export async function promotionStatus(opts: { query?: Query; environment?: string; days?: number } = {}) {
  const query: Query = opts.query ?? (async (t, p) => {
    const { pgClient } = await import('@/db');
    return (await pgClient.unsafe(t, p as never[])) as unknown as Row[];
  });
  const environment = opts.environment ?? getAiEnvironment();
  const days = opts.days ?? 7;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();

  // (a) Planificateur.
  const taches = await safe(query, `SELECT code, last_started_at, last_status, last_success_at, next_run_at, last_note, last_error, consecutive_failures FROM scheduled_task_state WHERE code = ANY($1::text[])`, [[...PROMOTION_TASKS]]);
  const scheduler = PROMOTION_TASKS.map((code) => {
    const r = taches.find((x) => x.code === code);
    const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());
    return {
      code, launched: Boolean(r?.last_started_at), lastRunAt: iso(r?.last_started_at), lastStatus: r?.last_status == null ? null : String(r.last_status),
      lastSuccessAt: iso(r?.last_success_at), nextRunAt: iso(r?.next_run_at), note: r?.last_note == null ? null : String(r.last_note).slice(0, 500),
      consecutiveFailures: Number(r?.consecutive_failures ?? 0),
    };
  });

  // (b) Tests réellement exécutés (cas joués par le fournisseur ou le cache, coût réel), compte technique.
  const [ex] = await safe(query,
    `SELECT count(DISTINCT c.id)::int AS campaigns,
            count(k.*) FILTER (WHERE k.outcome IN ('PASSED', 'FAILED'))::int AS concluded,
            count(k.*) FILTER (WHERE k.outcome = 'INCONCLUSIVE')::int AS inconclusive,
            count(k.*) FILTER (WHERE k.from_cache IS NOT TRUE AND k.duration_ms IS NOT NULL)::int AS provider_calls,
            COALESCE(sum(k.cost_micros) FILTER (WHERE k.from_cache IS NOT TRUE), 0)::bigint AS cost_micros,
            max(c.created_at) AS last_at
       FROM ai_qualification_campaigns c
       LEFT JOIN ai_qualification_evidence e ON e.campaign_id = c.id
       LEFT JOIN ai_qualification_cases k ON k.evidence_id = e.id
      WHERE c.environment = $1 AND c.created_at >= $2::timestamptz`, [environment, since]);
  const parType = await safe(query, `SELECT kind, status, count(*)::int AS n FROM ai_qualification_campaigns WHERE environment = $1 AND created_at >= $2::timestamptz GROUP BY kind, status`, [environment, since]);
  const refusPrerequis = await safe(query, `SELECT count(*)::int AS n FROM ai_qualification_campaigns WHERE environment = $1 AND created_at >= $2::timestamptz AND summary ? 'prerequisite'`, [environment, since]);
  let account: { ok: boolean; code: string; label: string; nextAction: string | null } | null = null;
  try {
    const ta = await import('./technical-account');
    const s = ta.assessCorpusAccount(await ta.readCorpusAccountSnapshot({ query }));
    account = { ok: s.ok, code: s.code, label: s.label, nextAction: s.nextAction };
  } catch { account = null; }
  const executions = {
    days, campaigns: Number(ex?.campaigns ?? 0), concludedCases: Number(ex?.concluded ?? 0), inconclusiveCases: Number(ex?.inconclusive ?? 0),
    providerCalls: Number(ex?.provider_calls ?? 0), costMicros: Number(ex?.cost_micros ?? 0), lastCampaignAt: ex?.last_at == null ? null : new Date(String(ex.last_at)).toISOString(),
    byKindStatus: parType.map((r) => ({ kind: String(r.kind), status: String(r.status), n: Number(r.n) })), blockedByPrerequisite: Number(refusPrerequis[0]?.n ?? 0),
    technicalAccount: account,
  };

  // (c) Couverture (matrice seule, sans résultats : manques qu'aucun appel ne comble) par traitement.
  let coverage: Array<{ treatment: Treatment; blockers: number; structural: number; byCode: Array<{ code: string; label: string; n: number }>; requirements: { met: number; total: number; waived: Array<{ id: string; reason: string }> } }> = [];
  let inventory: { version: string; counts: Record<string, number>; expected: Record<string, number>; zipReceived: boolean; manifestVersion: number; entries: number } | null = null;
  try {
    const [{ loadCertificationState }, cov, inv] = await Promise.all([
      import('../governance/master-corpus/certification/state'), import('../governance/master-corpus/certification/coverage'), import('../governance/master-corpus/certification/expected-inventory'),
    ]);
    const etat = await loadCertificationState();
    const ref = inv.currentExpectedInventory();
    inventory = { version: ref.version, counts: inv.inventoryCounts(etat.manifest.entries), expected: ref.totals, zipReceived: etat.manifest.reference.zipReceived, manifestVersion: etat.manifest.version, entries: etat.manifest.entries.length };
    coverage = TREATMENTS.map((t) => {
      const a = cov.assessA1({ treatments: [t], entries: etat.manifest.entries, statusOf: etat.statusOf, results: null });
      const bl = a.blockers.filter((b) => b.code !== 'NO_RESULTS');
      const byCode = new Map<string, number>();
      for (const b of bl) byCode.set(b.code, (byCode.get(b.code) ?? 0) + 1);
      const reqs = a.inventory?.requirements ?? [];
      return {
        treatment: t, blockers: bl.length, structural: cov.structuralBlockers(a).length,
        byCode: [...byCode.entries()].map(([code, n]) => ({ code, label: cov.A1_CODE_LABELS[code as keyof typeof cov.A1_CODE_LABELS] ?? code, n })),
        requirements: { met: reqs.filter((r) => r.met).length, total: reqs.length, waived: reqs.filter((r) => r.waived).map((r) => ({ id: r.id, reason: r.waived!.reason })) },
      };
    });
  } catch { /* manifeste illisible : section vide, motif dans la santé */ }

  // (e) Candidates (30 jours).
  const cands = await safe(query,
    `SELECT candidate_state AS state, count(*)::int AS n,
            count(*) FILTER (WHERE COALESCE(to_jsonb(v)->'candidate_promotion'->'watch'->>'status', '') = 'WATCHING')::int AS watching,
            count(*) FILTER (WHERE COALESCE(to_jsonb(v)->'candidate_promotion'->'watch'->>'status', '') = 'ROLLED_BACK')::int AS rolled_back,
            count(*) FILTER (WHERE COALESCE(to_jsonb(v)->'candidate_promotion'->'watch'->>'status', '') = 'INSUFFICIENT_USAGE')::int AS insufficient_usage,
            count(*) FILTER (WHERE COALESCE(to_jsonb(v)->'candidate_promotion'->'watch'->>'status', '') = 'VALIDATED_IN_USAGE')::int AS validated_in_usage,
            count(*) FILTER (WHERE COALESCE(to_jsonb(v)->'candidate_promotion'->'watch'->>'status', '') = 'OBSERVATION_UNAVAILABLE')::int AS observation_unavailable,
            count(*) FILTER (WHERE COALESCE(to_jsonb(v)->'candidate_promotion'->'watch'->>'status', '') = 'ALERT')::int AS watch_alert,
            count(*) FILTER (WHERE COALESCE(to_jsonb(v)->'candidate_promotion'->'watch'->>'status', '') = 'ROLLBACK_FAILED')::int AS rollback_failed,
            count(*) FILTER (WHERE COALESCE(to_jsonb(v)->'candidate_promotion'->'watch'->>'status', '') = 'REPLACED')::int AS replaced
       FROM ai_config_versions v WHERE environment = $1 AND origin = 'auto' AND created_at >= $2::timestamptz GROUP BY candidate_state`, [environment, since30]);
  const nb = (s: string) => Number(cands.find((r) => r.state === s)?.n ?? 0);
  const candidates = {
    days: 30, created: cands.reduce((n, r) => n + Number(r.n), 0), qualified: nb('QUALIFIED'), blockedA1: nb('BLOCKED_A1'), refused: nb('REFUSED'),
    inconclusive: nb('INCONCLUSIVE'), notChosen: nb('NOT_CHOSEN'), activated: nb('ACTIVATED') + nb('SUSPENDED'), suspended: nb('SUSPENDED'),
    watching: cands.reduce((n, r) => n + Number(r.watching ?? 0), 0), rolledBack: cands.reduce((n, r) => n + Number(r.rolled_back ?? 0), 0),
    qualifying: nb('QUALIFYING') + nb('CREATED'),
    // Lot 113I (BO-07, OPS-05) : états de surveillance DISTINCTS (jamais « rejetée » pour un manque d'usage).
    insufficientUsage: cands.reduce((n, r) => n + Number(r.insufficient_usage ?? 0), 0),
    validatedInUsage: cands.reduce((n, r) => n + Number(r.validated_in_usage ?? 0), 0),
    observationUnavailable: cands.reduce((n, r) => n + Number(r.observation_unavailable ?? 0), 0),
    watchAlert: cands.reduce((n, r) => n + Number(r.watch_alert ?? 0), 0),
    rollbackFailed: cands.reduce((n, r) => n + Number(r.rollback_failed ?? 0), 0),
    replaced: cands.reduce((n, r) => n + Number(r.replaced ?? 0), 0),
  };
  const conf = await safe(query,
    `SELECT count(*) FILTER (WHERE (qualification->>'a1Blocked')::boolean IS TRUE AND status NOT IN ('RESOLVED', 'ACTIVATED'))::int AS a1,
            count(*) FILTER (WHERE status NOT IN ('RESOLVED', 'ACTIVATED'))::int AS open
       FROM ai_prompt_conformity_issues WHERE environment = $1`, [environment]);

  // (d) Blocages.
  const jamais = await safe(query,
    `SELECT count(DISTINCT operation_code)::int AS n FROM ai_qualification_evidence WHERE environment = $1 AND created_at >= $2::timestamptz`, [environment, since30]);
  const blocks = {
    a1Candidates: candidates.blockedA1, a1PromptIssues: Number(conf[0]?.a1 ?? 0), openPromptIssues: Number(conf[0]?.open ?? 0),
    account: account && !account.ok ? { code: account.code, label: account.label, nextAction: account.nextAction } : null,
    operationsWithEvidence30d: Number(jamais[0]?.n ?? 0),
    a1StructuralTreatments: coverage.filter((c) => c.structural > 0).map((c) => c.treatment),
  };

  // Santé fonctionnelle (jamais « automatique » sans progression effective).
  const health: PromotionHealth = environment === 'production'
    ? { code: 'PRODUCTION_MANUAL', automatic: false, label: 'Production : aucune campagne comparative ni activation automatique — transfert par export / import manuel validé (R9).', cause: null, nextAction: null }
    : account && !account.ok
      ? { code: 'BLOCKED_ACCOUNT', automatic: false, label: `Bloquée : compte technique de qualification (${account.code}) — aucun test réel possible.`, cause: account.label, nextAction: account.nextAction }
      : executions.concludedCases === 0
        ? { code: 'NO_TESTS', automatic: false, label: `Planificateur ${scheduler.some((x) => x.launched) ? 'lancé' : 'non lancé'}, mais AUCUN test réellement exécuté sur ${days} jours.`, cause: executions.campaigns ? `${executions.campaigns} campagne(s) sans cas concluant` : 'aucune campagne', nextAction: 'BO › Tâches planifiées : vérifier ai-qualification-campaign ; BO › Configuration IA › Qualification par couple.' }
        : candidates.activated > 0 && executions.concludedCases > 0
          ? { code: 'AUTOMATIC_PROGRESS', automatic: true, label: `Promotion automatique effective : ${candidates.activated} candidate(s) activée(s) sur 30 jours, ${executions.concludedCases} cas concluant(s) sur ${days} jours.`, cause: null, nextAction: null }
          : blocks.a1StructuralTreatments.length === TREATMENTS.length
            ? { code: 'BLOCKED_A1', automatic: false, label: 'Tests exécutés, mais AUCUNE promotion possible : verrou A1 (corpus #601 incomplet ou références non approuvées) sur tous les traitements.', cause: `${candidates.blockedA1} candidate(s) et ${blocks.a1PromptIssues} correction(s) de prompt qualifiées métier en attente du verrou A1`, nextAction: 'BO › Configuration IA › Corpus de qualification : approuver les références (une à une, sur sources) ; intégrer le ZIP #601.' }
            : { code: 'NO_PROGRESS', automatic: false, label: `Tests exécutés (${executions.concludedCases} cas concluants), aucune candidate activée sur 30 jours.`, cause: candidates.created ? `${candidates.created} candidate(s) créée(s), aucune activée` : 'aucune candidate proposée', nextAction: null };

  let events: PromotionEvent[] = [];
  events = await listPromotionEvents({ environment, limit: 30, query });
  const improvement = await improvementOverview({ environment, coverage }).catch((e) => ({ error: `lecture impossible : ${(e as Error).message.slice(0, 200)}` }));
  return {
    readAt: new Date().toISOString(), environment, params: promotionParams(), health, scheduler, executions, inventory, coverage, blocks, candidates, events, improvement,
    deferred: DEFERRED_P2,
    manualFlows: { manualActivation: 'Activation manuelle (#345) inchangée : la matrice A1 est affichée, jamais bloquante.', production: 'Production : export instantané de préproduction puis import manuel validé (config-export / config-import), preuve, journal, retour arrière.' },
  };
}

export type PromotionStatus = Awaited<ReturnType<typeof promotionStatus>>;

/** Ligne de santé courte (note des tâches planifiées). */
export function promotionHealthNote(h: PromotionHealth): string {
  return `Santé promotion : ${h.automatic ? 'AUTOMATIQUE (progrès effectif)' : h.code} — ${h.label}${h.cause ? ` · cause : ${h.cause}` : ''}${h.nextAction ? ` · geste : ${h.nextAction}` : ''}`;
}

// ══════════════════════════════════════════════════════════════════════════
// Lot 113I — VUE D'AMÉLIORATION PAR TRAITEMENT (CDC V2 BO-02, BO-04, BO-07,
// MAN-02, RLS-004, API-02) : projection CALCULÉE des preuves, gardes et
// prérequis — jamais une seconde source de configuration.
// ══════════════════════════════════════════════════════════════════════════

export type CapabilityState = 'OBSERVATION_ONLY' | 'QUALIFICATION_AVAILABLE' | 'AUTONOMOUS_PROMOTION_READY' | 'AUTONOMOUS_ACTIVE' | 'BLOCKED';

/** État de capacité d'un traitement (pur, RLS-004). */
export function capabilityState(p: { environment: string; budgetBlocked: string | null; structuralA1: number; activeWatch: boolean }): { state: CapabilityState; cause: string | null } {
  if (p.environment === 'production') return { state: 'OBSERVATION_ONLY', cause: 'production : lecture et diagnostic seulement (PRD-01)' };
  if (p.budgetBlocked) return { state: 'BLOCKED', cause: p.budgetBlocked };
  if (p.activeWatch) return { state: 'AUTONOMOUS_ACTIVE', cause: null };
  if (p.structuralA1 > 0) return { state: 'QUALIFICATION_AVAILABLE', cause: `${p.structuralA1} manque(s) structurel(s) de couverture A1 du traitement : qualification possible, promotion bloquée` };
  return { state: 'AUTONOMOUS_PROMOTION_READY', cause: null };
}

export async function improvementOverview(p: { environment?: string; coverage?: ReadonlyArray<{ treatment: string; structural: number }> } = {}) {
  const environment = p.environment ?? getAiEnvironment();
  const [{ budgetSummary }, { loadPolicy, POLICY_SUGGESTIONS }, { listQueue }, cfg, watchMod] = await Promise.all([
    import('./improvement-budget'), import('./improvement-policy'), import('./improvement-objectives'), import('../config/config-version.repository'), import('./promotion-watch'),
  ]);
  const [budget, policy, queue] = await Promise.all([budgetSummary({ environment }), loadPolicy(environment), listQueue(environment, ['QUEUED', 'WAITING_BUDGET', 'WAITING_PREREQUISITE', 'EXPERIMENTING', 'QUALIFYING', 'BLOCKED'])]);
  const promues = await cfg.listCandidates(environment, ['ACTIVATED']);
  const treatments = await Promise.all(TREATMENTS.map(async (t) => {
    const eff = await cfg.activeTreatmentFingerprint(environment, t).catch(() => null);
    const surv = promues.find((c) => (c.promotion.watch as { treatment?: string; fingerprint?: string } | undefined)?.treatment === t
      && watchMod.ACTIVE_WATCH_STATES.includes((c.promotion.watch as { status?: string }).status as never));
    const qualifiee = Boolean(eff && promues.some((c) => (c.promotion.targeted as { afterFingerprint?: string } | undefined)?.afterFingerprint === eff.fingerprint));
    const w = surv?.promotion.watch as { status?: string; activatedAt?: string; sevenDayReviewAt?: string; lastObservedAt?: string | null } | undefined;
    const tete = queue.find((o) => o.treatment === t) ?? null;
    const cap = capabilityState({ environment, budgetBlocked: budget.blocked, structuralA1: p.coverage?.find((c) => c.treatment === t)?.structural ?? 0, activeWatch: Boolean(surv) });
    return {
      treatment: t, effectiveVersionId: eff?.versionId ?? null, fingerprint: eff?.fingerprint?.slice(0, 16) ?? null,
      // MAN-02 : configuration effective issue d'une promotion qualifiée, ou « non qualifiée métier » (geste manuel).
      qualification: qualifiee ? 'QUALIFIED_ON_CORPUS' : 'NOT_BUSINESS_QUALIFIED',
      qualificationLabel: qualifiee ? 'Qualifiée sur corpus (promotion automatique)' : 'Non qualifiée métier (configuration manuelle ou de départ)',
      watch: surv ? { candidateVersionId: surv.id, status: w?.status ?? null, label: watchMod.WATCH_STATUS_LABELS[(w?.status ?? 'WATCHING') as keyof typeof watchMod.WATCH_STATUS_LABELS], activatedAt: w?.activatedAt ?? null, sevenDayReviewAt: w?.sevenDayReviewAt ?? null, lastObservedAt: w?.lastObservedAt ?? null } : null,
      headObjective: tete ? { id: tete.id, kind: tete.kind, status: tete.status, priority: tete.priority, createdAt: tete.createdAt, reason: tete.reason } : null,
      capability: cap,
    };
  }));
  return {
    budget,
    policy: { version: policy.version, sha256: policy.sha256, updatedAt: policy.updatedAt, budget: policy.budget, fx: policy.fx, costBound: policy.costBound, variants: policy.variants, economics: policy.economics, usage: policy.usage, verifiedStableModels: policy.verifiedStableModels, judges: policy.judges, semanticGainThreshold: policy.semanticGainThreshold, suggestions: POLICY_SUGGESTIONS },
    queue: queue.slice(0, 50).map((o) => ({ id: o.id, treatment: o.treatment, kind: o.kind, status: o.status, priority: o.priority, variantCount: o.variantCount, nextEligibleMonth: o.nextEligibleMonth, createdAt: o.createdAt, reason: o.reason })),
    treatments,
  };
}
