/**
 * POST /api/admin/ai/config-packages/import — CDC BO IA WF-04, VER-012, VER-013.
 *
 * Importe un package dans l'environnement courant. La version arrive au statut
 * Validé : le VER-012 réserve l'activation à un geste explicite, et importer en
 * activant ferait de la mise en production un effet de bord du déploiement.
 *
 * Trois issues possibles :
 *   201 · version créée
 *   200 · package déjà importé — l'import est idempotent (WF-04)
 *   409 · collision de numéro sous un autre identifiant (VER-013)
 *
 * Une divergence avec l'Active de production est rendue, jamais bloquante : le
 * WF-04 demande « avertissement + diff, mais pas blocage sauf conflit réel ».
 */
import { defaultT6Config } from '@/services/ai/config/t6-defaults';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { importPackage, type PackagePayload } from '@/services/ai/config/config-package.service';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

const Entry = z.object({
  treatment: z.enum(['T1', 'T2', 'T3', 'T4', 'T5', 'T6']),
  prompt: z.string(),
  primaryModel: z.string().nullable(),
  fallback1: z.string().nullable(),
  fallback2: z.string().nullable(),
  reasoningPrimary: z.string().nullable(),
  reasoningFallback1: z.string().nullable(),
  reasoningFallback2: z.string().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  guardrails: z.array(z.object({
    code: z.string(), threshold: z.number(), reaction: z.string(),
  })),
  triggers: z.array(z.object({
    kind: z.enum(['event', 'schedule']), code: z.string(), active: z.boolean(),
  })),
  cascade: z.object({
    database: z.number().min(0).max(1),
    text: z.number().min(0).max(1),
    semantic: z.number().min(0).max(1),
    semanticEnabled: z.boolean(),
  }).nullable().default(null),
});

const Body = z.object({
  uid: z.string().uuid(),
  payload: z.object({
    schemaVersion: z.literal('ai-config-package-v1'),
    sourceEnvironment: z.enum(['local', 'preprod', 'production']),
    visibleNumber: z.number().int().positive(),
    label: z.string().nullable(),
    // Un instantané complet (GEN-002). Six traitements depuis T6 ; un package
    // exporté avant T6 en compte cinq et reçoit la configuration T6 par défaut
    // (CDC Mascotte BO-004), sans quoi la version importée ne serait pas
    // promouvable.
    entries: z.array(Entry).min(5).max(6),
  }),
});

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_PACKAGE',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    );
  }

  try {
    const payload = parsed.data.payload as PackagePayload;
    if (!payload.entries.some((e) => e.treatment === 'T6')) {
      payload.entries = [...payload.entries, defaultT6Config()];
    }
    const r = await importPackage(
      payload,
      parsed.data.uid,
      guard.ctx.adminUserId,
    );
    return NextResponse.json(r, { status: r.outcome === 'created' ? 201 : 200 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-packages/import');
  }
}
