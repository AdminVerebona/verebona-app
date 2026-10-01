/**
 * GET /api/admin/ai/dashboard — CDC BO IA SCR-01.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « EN MOINS D'UN ÉCRAN »
 *
 * Le premier critère d'acceptation : « l'administrateur identifie en moins d'un
 * écran la version réellement active et l'état T1–T5 ». Une seule route donc,
 * qui rassemble ce que cinq écrans montrent en détail.
 *
 * Les rassembler côté serveur plutôt que côté client n'est pas qu'une question
 * de nombre d'appels : un Dashboard qui affiche la version active avant de
 * connaître l'état des traitements donne, pendant une seconde, une image
 * incohérente — et c'est souvent celle qu'on retient.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES ALERTES PORTENT LEUR DESTINATION
 *
 * « Chaque alerte ouvre directement la vue détaillée pertinente. » Chacune rend
 * donc son lien. Le calculer côté client obligerait l'écran à connaître la
 * correspondance entre un type d'alerte et un écran — une connaissance qui
 * diverge dès qu'on ajoute un type.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAiEnvironment } from '@/services/ai/config/environment';
import { listVersions, getActiveVersion, getEffectiveVersion } from '@/services/ai/config/config-version.repository';
import { listPackages } from '@/services/ai/config/config-package.service';
import { getQueueSummary, getTreatmentStates, getEmergencyStop } from '@/services/ai/queue/job-queue.repository';
import { getErrorBreakdown } from '@/services/ai/telemetry/execution-log.repository';
import { getCostReport } from '@/services/ai/telemetry/cost-report.repository';
import { TREATMENTS, TREATMENT_DEFINITIONS } from '@/services/ai/config/treatments';
import { unavailableModels } from '@/services/ai/config/config-validation.service';
import { GEMINI_PUBLIC_CATALOG } from '@/services/ai/gateway/pricing/gemini-public-catalog';
import { getModelAlerts } from '@/services/ai/queue/circuit-breaker.repository';
import { listAlerts } from '@/services/ai/alerts/alerts.repository';
import { getTreatmentActivity } from '@/services/ai/telemetry/treatment-activity.repository';
import { listDraftSummaries } from '@/services/ai/config/draft-summary.repository';
import {
  activityForWindow,
  globalAiStatus,
  parseDashboardWindow,
  shortUid,
} from '@/lib/admin/ai-dashboard';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export interface DashboardAlert {
  severity: 'critical' | 'warning' | 'info';
  message: string;
  /** Vue détaillée pertinente (SCR-01, critère d'acceptation). */
  href: string;
}

const isoOrNull = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  try {
    const environment = getAiEnvironment();
    // PER-01 : fenêtre de supervision (24 h / 7 j / 30 j). Elle ne change que
    // la lecture des métriques (erreurs, coûts, activité), jamais les données.
    const windowDays = parseDashboardWindow(new URL(req.url).searchParams.get('days'));

    // ══════════════════════════════════════════════════════════════════════
    // ⚠️ NEUF SOURCES, ET AUCUNE NE DOIT POUVOIR BLANCHIR L'ÉCRAN
    //
    // `Promise.all` rejetait l'ensemble dès qu'une seule requête échouait :
    // l'écran restait vide, sans dire laquelle ni pourquoi. C'est ce qui s'est
    // produit en recette le 21/09/2026.
    //
    // Le tableau de bord est le premier écran qu'on ouvre quand quelque chose
    // ne va pas. Qu'il disparaisse à la première anomalie est le pire moment
    // pour le perdre — et il devient impossible de diagnostiquer ce qui cloche
    // depuis l'outil fait pour ça.
    //
    // Chaque source est donc isolée. Celles qui répondent s'affichent, celles
    // qui échouent sont NOMMÉES dans `degraded`, et l'écran le montre.
    // ══════════════════════════════════════════════════════════════════════
    const resultats = await Promise.allSettled([
      listVersions(environment, 20),
      getActiveVersion(environment),
      getEffectiveVersion(environment),
      listPackages(10),
      getQueueSummary(),
      getTreatmentStates(),
      getEmergencyStop(),
      getErrorBreakdown(windowDays),
      getCostReport({ since: new Date(Date.now() - windowDays * 86_400_000) }),
      // MOD-008 / OPS-019 : modèles à dix échecs consécutifs ou plus, par
      // traitement (alertingModels). Dixième source, isolée comme les autres.
      getModelAlerts(),
      // Alertes système ouvertes : garde-fous, budgets, anomalies de coût
      // (T1-UI-09, WF-22, WF-44, ALT-01). Onzième source, isolée.
      listAlerts({ openOnly: true, limit: 20 }),
      // HLT-01, PER-01, VOL-01 (lot IA 2) : volumes 24 h / 7 j / 30 j, taux de
      // succès, dernier appel, par traitement. Douzième source, isolée.
      getTreatmentActivity(),
      // DRF-01 : brouillons détaillés (base, auteur). Treizième source, isolée.
      listDraftSummaries(environment, 20),
    ]);

    const NOMS = [
      'versions', 'version active', 'version effective', 'packages',
      'file d’attente', 'états des traitements', 'arrêt d’urgence',
      'erreurs récentes', 'coûts', 'alertes modèles', 'alertes système',
      'activité par traitement', 'brouillons',
    ];

    const degraded: Array<{ source: string; message: string }> = [];
    resultats.forEach((r, i) => {
      if (r.status === 'rejected') {
        const message = (r.reason as Error)?.message ?? 'erreur inconnue';
        console.error(`[dashboard] source « ${NOMS[i]} » indisponible :`, message);
        degraded.push({ source: NOMS[i], message: message.slice(0, 300) });
      }
    });

    const valeur = <T,>(i: number, defaut: T): T =>
      resultats[i].status === 'fulfilled'
        ? ((resultats[i] as PromiseFulfilledResult<T>).value ?? defaut)
        : defaut;

    const versions = valeur(0, [] as Awaited<ReturnType<typeof listVersions>>);
    const active = valeur(1, null as Awaited<ReturnType<typeof getActiveVersion>>);
    const effective = valeur(2, null as Awaited<ReturnType<typeof getEffectiveVersion>>);
    const packages = valeur(3, [] as Awaited<ReturnType<typeof listPackages>>);
    const queue = valeur(4, [] as Awaited<ReturnType<typeof getQueueSummary>>);
    const states = valeur(5, [] as Awaited<ReturnType<typeof getTreatmentStates>>);
    const stop = valeur(6, { active: false, reason: null, engagedAt: null });
    const errors = valeur(7, [] as Awaited<ReturnType<typeof getErrorBreakdown>>);
    const costs = valeur(8, {
      totals: {
        functionalMicros: 0, technicalMicros: 0, calls: 0,
        failedCalls: 0, inputTokens: 0, outputTokens: 0, unpricedCalls: 0,
      },
      incomplete: false,
    } as Awaited<ReturnType<typeof getCostReport>>);

    const modelAlerts = valeur(9, [] as Awaited<ReturnType<typeof getModelAlerts>>);
    const systemAlerts = valeur(10, [] as Awaited<ReturnType<typeof listAlerts>>);
    const activity = valeur(11, [] as Awaited<ReturnType<typeof getTreatmentActivity>>);
    const drafts = valeur(12, [] as Awaited<ReturnType<typeof listDraftSummaries>>);
    const windowLabel = windowDays === 1 ? '24 h' : `${windowDays} jours`;

    const alerts: DashboardAlert[] = [];

    if (stop.active) {
      alerts.push({
        severity: 'critical',
        message: `Arrêt d'urgence engagé${stop.reason ? ` : ${stop.reason}` : ''}.`,
        href: '/admin/ai-queue',
      });
    }

    // Garde-fous franchis, budgets dépassés, anomalies — liens préfiltrés vers
    // les exécutions responsables (WF-22 étape 143, COST-009).
    for (const a of systemAlerts) {
      alerts.push({
        severity: a.severity,
        message: a.message,
        href: a.drilldownHref ?? (a.kind === 'guardrail' ? '/admin/ai-queue' : '/admin/ai-costs'),
      });
    }

    for (const s of states) {
      if (s.state === 'SUSPENDED') {
        alerts.push({
          severity: 'critical',
          message: `${s.treatment} est suspendu${s.suspendedReason ? ` : ${s.suspendedReason}` : ''}.`,
          href: `/admin/ai-queue?treatment=${s.treatment}`,
        });
      } else if (s.state === 'DISABLED') {
        alerts.push({
          severity: 'warning',
          message: `${s.treatment} est désactivé : sa file se remplit sans être servie.`,
          href: `/admin/ai-queue?treatment=${s.treatment}`,
        });
      }
    }

    // MOD-008 : alerte INFORMATIONNELLE — elle n'arrête rien (seul le
    // disjoncteur, sur échecs complets, suspend). Elle se résout au premier
    // succès de CE modèle (MOD-014, OPS-020), réactivation forcée comprise.
    for (const m of modelAlerts) {
      alerts.push({
        severity: 'warning',
        message: `${m.treatment} : le modèle « ${m.model} » a échoué ${m.consecutiveFailures} fois de suite.`,
        href: `/admin/ai-executions?treatment=${m.treatment}&errorsOnly=1`,
      });
    }

    // Les erreurs répétées comptent davantage qu'une erreur isolée : c'est la
    // répétition qui distingue un incident d'un aléa.
    for (const e of errors.filter((x) => x.count >= 5).slice(0, 5)) {
      alerts.push({
        severity: 'warning',
        message: `${e.count} échecs en ${windowLabel} sur ${e.treatment ?? 'un traitement'}`
          + `${e.errorCode ? ` (${e.errorCode})` : ''}.`,
        href: `/admin/ai-executions?errorsOnly=1${e.treatment ? `&treatment=${e.treatment}` : ''}${e.model ? `&model=${encodeURIComponent(e.model)}` : ''}`,
      });
    }

    // Un traitement batch sans déclencheur actif ne partira que manuellement.
    // C'est un choix légitime — et c'est aussi la forme que prend un oubli.
    // L'avertissement de promotion se lit une fois ; celui-ci reste, ce qui
    // distingue le choix assumé de l'oubli que personne ne revoit.
    for (const t of TREATMENTS) {
      const def = TREATMENT_DEFINITIONS[t];
      if (!def.batch) continue;
      const entry = effective?.entries.find((e) => e.treatment === t);
      if (!entry) continue;
      // Liste vide = déclencheurs par défaut du code (queue/triggers.ts) : pas
      // d'alerte. Liste renseignée sans actif = manuel uniquement.
      if (entry.triggers.length > 0 && !entry.triggers.some((x) => x.active)) {
        alerts.push({
          severity: 'warning',
          message: `${t} n'a aucun déclencheur actif : rien ne le lancera automatiquement.`,
          href: '/admin/ai-config',
        });
      }
    }

    // Un modèle retiré par le fournisseur ne coupe pas la version active — on ne
    // veut pas qu'une décision extérieure éteigne la production. Mais elle cesse
    // d'être rejouable, et c'est le genre de chose qu'on découvre au pire moment :
    // en tentant un retour arrière pendant un incident.
    if (effective) {
      const retires = unavailableModels(
        effective.entries,
        new Set(GEMINI_PUBLIC_CATALOG.map((e) => e.model)),
      );
      for (const r of retires) {
        alerts.push({
          severity: 'warning',
          message: `${r.treatment} utilise « ${r.model} » (${r.rank}), que le fournisseur ne sert plus.`,
          href: '/admin/ai-provider',
        });
      }
    }

    if (costs.incomplete) {
      alerts.push({
        severity: 'warning',
        message: `${costs.totals.unpricedCalls} appel(s) sans tarif : la dépense affichée est incomplète.`,
        href: '/admin/ai-provider',
      });
    }

    // PUB-01 (CDC Centre d'aide) : corpus d'aide publié refusé ou injoignable
    // — l'assistant sert le dernier corpus valide, ou aucun. Lecture en cache.
    try {
      const { loadHelpCorpus, helpCorpusHealth } = await import('@/services/verebona-assistant/core/help-corpus.service');
      await loadHelpCorpus();
      const h = helpCorpusHealth();
      if (h.alert) {
        alerts.push({
          severity: h.source === 'none' ? 'critical' : 'warning',
          message: `${h.alert.message}${h.source === 'none'
            ? ' Aucun corpus valide connu : l’assistant ne répond plus aux questions d’aide.'
            : ` Corpus servi : ${h.version ?? '?'}${h.lastValidAt ? `, lu le ${h.lastValidAt.slice(0, 16).replace('T', ' ')} UTC (${ageLisible(h.lastValidAgeSeconds)})` : ''}.`}`,
          href: '/api/health',
        });
      }
    } catch {
      /* indicatif */
    }

    // Aucune Active : état initial bloquant, avec indication de bootstrap.
    if (!active) {
      alerts.push({
        severity: 'info',
        message: 'Aucune version active. Créez un brouillon pour amorcer la configuration.',
        href: '/admin/ai-config',
      });
    }

    const health = TREATMENTS.map((t) => {
      const def = TREATMENT_DEFINITIONS[t];
      const entry = effective?.entries.find((e) => e.treatment === t) ?? null;
      const state = states.find((s) => s.treatment === t);
      const q = queue.find((x) => x.treatment === t);
      return {
        treatment: t,
        label: def.label,
        batch: def.batch,
        state: state?.state ?? 'ENABLED',
        suspendedReason: state?.suspendedReason ?? null,
        nextProbeAt: state?.nextProbeAt ?? null,
        // Modèles en alerte (MOD-008), affichés sur la carte du traitement.
        alertingModels: modelAlerts
          .filter((m) => m.treatment === t)
          .map((m) => ({ model: m.model, consecutiveFailures: m.consecutiveFailures })),
        primaryModel: entry?.primaryModel ?? null,
        pending: q?.pending ?? 0,
        running: q?.running ?? 0,
        failed: q?.failed ?? 0,
        // HLT-01 / PER-01 / VOL-01 : `null` si la source est dégradée.
        activity: (() => {
          const a = activity.find((x) => x.treatment === t);
          return a ? { ...a, window: activityForWindow(a, windowDays) } : null;
        })(),
      };
    });

    return NextResponse.json({
      environment,
      isProduction: environment === 'production',
      emergencyStop: stop,
      // GST-01 : « Opérationnel » ou « Arrêt d'urgence », rien d'autre.
      globalStatus: globalAiStatus(Boolean(stop.active)),
      windowDays,
      // VER-01 : vN, libellé, UID abrégé et date d'activation.
      activeVersion: active
        ? {
            id: active.id,
            visibleNumber: active.visibleNumber,
            label: active.label,
            uid: active.uid,
            shortUid: shortUid(active.uid),
            activatedAt: isoOrNull(active.activatedAt),
          }
        : null,
      // VER-004 : en préproduction, une version « À tester » prime sur l'Active.
      // Le bandeau doit le dire, sinon on lit la configuration active en croyant
      // lire celle qui s'exécute. Une « À tester » n'a pas de date
      // d'activation : on donne sa date de validation.
      effectiveVersion: effective && effective.id !== active?.id
        ? {
            id: effective.id,
            status: effective.status,
            visibleNumber: effective.visibleNumber,
            label: effective.label,
            uid: effective.uid,
            shortUid: shortUid(effective.uid),
            activatedAt: isoOrNull(effective.activatedAt),
            validatedAt: isoOrNull(effective.validatedAt),
          }
        : null,
      // DRF-01 : liste détaillée des brouillons (libellé, base, obsolète, date, auteur).
      drafts,
      health,
      versions,
      packages,
      alerts,
      modelAlerts,
      systemAlerts,
      // Nommées plutôt que tues : un tableau de bord partiel qui ne le dit pas
      // ferait lire des zéros comme des mesures.
      degraded,
      // Coûts de la fenêtre choisie (PER-01), portée donnée par `windowDays`.
      costs: {
        functionalMicros: costs.totals.functionalMicros,
        technicalMicros: costs.totals.technicalMicros,
        calls: costs.totals.calls,
        failedCalls: costs.totals.failedCalls,
      },
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/dashboard');
  }
}

/** Âge lisible du dernier corpus valide (« il y a 3 h », « il y a 2 j »). */
function ageLisible(secondes: number | null): string {
  if (secondes == null) return 'âge inconnu';
  if (secondes < 3600) return `il y a ${Math.max(1, Math.round(secondes / 60))} min`;
  if (secondes < 172_800) return `il y a ${Math.round(secondes / 3600)} h`;
  return `il y a ${Math.round(secondes / 86_400)} j`;
}

