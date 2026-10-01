/**
 * GET /api/admin/ai/observability/[domain] — CDC 15 §18 (lot 17).
 *
 * Indicateurs d'observabilité d'un domaine (T1, T2, T3, T4, CONFIG, EXPORTS)
 * sur une période, filtrables par version de configuration et environnement.
 *
 *   ?days=1..90                 période glissante (défaut 7)
 *   ?configVersionId=<id>       version de configuration (facultatif)
 *   ?environment=<env>          environnement (facultatif ; autre que
 *                               l'environnement courant → base distincte)
 *
 * Un indicateur non mesurable rend `null` avec sa raison — jamais zéro.
 * Aucun contenu utilisateur : compteurs, codes et énumérations seulement.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  getObservability, isObservabilityDomain, ObservabilityVersionNotFound, OBSERVABILITY_DOMAINS,
} from '@/services/ai/telemetry/observability.repository';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { domain } = await params;
  if (!isObservabilityDomain(domain)) {
    return NextResponse.json(
      { error: 'UNKNOWN_DOMAIN', message: `Domaine inconnu : « ${domain} ». Attendus : ${OBSERVABILITY_DOMAINS.join(', ')}.` },
      { status: 400 },
    );
  }

  const sp = new URL(req.url).searchParams;
  const rawDays = sp.get('days');
  const rawVersion = sp.get('configVersionId');
  const environment = sp.get('environment');
  if (rawVersion && !/^\d+$/.test(rawVersion)) {
    return NextResponse.json({ error: 'INVALID_VERSION', message: 'configVersionId doit être un entier.' }, { status: 400 });
  }
  if (environment && !/^[a-z]{2,20}$/i.test(environment)) {
    return NextResponse.json({ error: 'INVALID_ENVIRONMENT', message: 'Environnement illisible.' }, { status: 400 });
  }

  try {
    return NextResponse.json(await getObservability({
      domain,
      days: rawDays && /^\d+$/.test(rawDays) ? Number(rawDays) : 7,
      configVersionId: rawVersion ? Number(rawVersion) : null,
      environment: environment || null,
    }));
  } catch (e) {
    if (e instanceof ObservabilityVersionNotFound) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 404 });
    }
    return toErrorResponse(e, 'GET /api/admin/ai/observability/[domain]');
  }
}
