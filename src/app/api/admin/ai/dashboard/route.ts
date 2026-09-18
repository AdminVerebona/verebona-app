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
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export interface DashboardAlert {
  severity: 'critical' | 'warning' | 'info';
  message: string;
  /** Vue détaillée pertinente (SCR-01, critère d'acceptation). */
  href: string;
}

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  try {
    const environment = getAiEnvironment();

    const [versions, active, effective, packages, queue, states, stop, errors, costs] =
      await Promise.all([
        listVersions(environment, 20),
        getActiveVersion(environment),
        getEffectiveVersion(environment),
        listPackages(10),
        getQueueSummary(),
        getTreatmentStates(),
        getEmergencyStop(),
        getErrorBreakdown(7),
        getCostReport({ since: new Date(Date.now() - 7 * 86_400_000) }),
      ]);

    const alerts: DashboardAlert[] = [];

    if (stop.active) {
      alerts.push({
        severity: 'critical',
        message: `Arrêt d'urgence engagé${stop.reason ? ` : ${stop.reason}` : ''}.`,
        href: '/admin/ai-queue',
      });
    }

    for (const s of states) {
      if (s.state === 'SUSPENDED') {
        alerts.push({
          severity: 'critical',
          message: `${s.treatment} est suspendu${s.suspendedReason ? ` : ${s.suspendedReason}` : ''}.`,
          href: '/admin/ai-queue',
        });
      } else if (s.state === 'DISABLED') {
        alerts.push({
          severity: 'warning',
          message: `${s.treatment} est désactivé : sa file se remplit sans être servie.`,
          href: '/admin/ai-queue',
        });
      }
    }

    // Les erreurs répétées comptent davantage qu'une erreur isolée : c'est la
    // répétition qui distingue un incident d'un aléa.
    for (const e of errors.filter((x) => x.count >= 5).slice(0, 5)) {
      alerts.push({
        severity: 'warning',
        message: `${e.count} échecs en 7 jours sur ${e.treatment ?? 'un traitement'}`
          + `${e.errorCode ? ` (${e.errorCode})` : ''}.`,
        href: '/admin/ai-executions?errorsOnly=1',
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
      if (!entry.triggers.some((x) => x.active)) {
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
        primaryModel: entry?.primaryModel ?? null,
        pending: q?.pending ?? 0,
        running: q?.running ?? 0,
        failed: q?.failed ?? 0,
      };
    });

    return NextResponse.json({
      environment,
      isProduction: environment === 'production',
      emergencyStop: stop,
      activeVersion: active
        ? { id: active.id, visibleNumber: active.visibleNumber, label: active.label }
        : null,
      // VER-004 : en préproduction, une version « À tester » prime sur l'Active.
      // Le bandeau doit le dire, sinon on lit la configuration active en croyant
      // lire celle qui s'exécute.
      effectiveVersion: effective && effective.id !== active?.id
        ? { id: effective.id, status: effective.status, visibleNumber: effective.visibleNumber }
        : null,
      health,
      versions,
      packages,
      alerts,
      costs7d: {
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
