/**
 * PUT /api/admin/ai/config-versions/[id]/entries/[treatment] — CDC BO IA WF-01.
 *
 * Enregistre la configuration d'UN traitement dans un Brouillon. Le WF-01
 * demande un enregistrement explicite onglet par onglet : c'est pourquoi la
 * route porte sur un traitement et non sur la version entière.
 *
 * ── LA VALIDATION D'ENTRÉE N'EST PAS LES CONTRÔLES BLOCANTS ────────────────
 * Ici, on vérifie que la charge utile a la bonne FORME. Les contrôles
 * fonctionnels du WF-02 — modèle disponible, tarif connu, garde-fou du
 * catalogue — n'interviennent qu'à la promotion. Un Brouillon en cours
 * d'édition a le droit d'être incomplet ; l'interdire obligerait à tout saisir
 * d'un coup ou à ne rien enregistrer.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { saveTreatmentConfig } from '@/services/ai/config/config-version.service';
import { isTreatment, type Treatment } from '@/services/ai/config/treatments';
import { REASONING_LEVELS, GUARDRAIL_REACTIONS } from '@/services/ai/config/config-types';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../../_shared';

const Guardrail = z.object({
  code: z.string().min(1).max(100),
  threshold: z.number().finite(),
  reaction: z.enum(GUARDRAIL_REACTIONS),
});

const Trigger = z.object({
  kind: z.enum(['event', 'schedule']),
  code: z.string().min(1).max(100),
  active: z.boolean(),
});

const Payload = z.object({
  // Pas de borne haute : le SCR-02 veut un éditeur « sans limite artificielle
  // imposée par le BO ». La borne réelle est celle du modèle, contrôlée ailleurs.
  prompt: z.string().default(''),
  primaryModel: z.string().max(200).nullable().default(null),
  fallback1: z.string().max(200).nullable().default(null),
  fallback2: z.string().max(200).nullable().default(null),
  reasoningPrimary: z.enum(REASONING_LEVELS).nullable().default(null),
  reasoningFallback1: z.enum(REASONING_LEVELS).nullable().default(null),
  reasoningFallback2: z.enum(REASONING_LEVELS).nullable().default(null),
  maxOutputTokens: z.number().int().positive().nullable().default(null),
  guardrails: z.array(Guardrail).max(50).default([]),
  triggers: z.array(Trigger).max(50).default([]),
  // Seuils de la cascade — T2 uniquement. Les bornes sont ici ; le fait que
  // seul T2 puisse en avoir est un contrôle fonctionnel, pas de forme.
  cascade: z.object({
    database: z.number().min(0).max(1),
    text: z.number().min(0).max(1),
    semantic: z.number().min(0).max(1),
    semanticEnabled: z.boolean(),
  }).nullable().default(null),
});

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; treatment: string }> },
) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id, treatment } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  if (!isTreatment(treatment)) {
    return NextResponse.json(
      { error: 'UNKNOWN_TREATMENT', message: `Traitement inconnu : « ${treatment} ».` },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = Payload.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_PAYLOAD',
        // Rendus par champ, comme les contrôles du WF-02 : l'administrateur doit
        // savoir quel champ reprendre, pas seulement que quelque chose cloche.
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    );
  }

  try {
    await saveTreatmentConfig(
      versionId,
      { treatment: treatment as Treatment, ...parsed.data },
      guard.ctx.adminUserId,
    );
    return NextResponse.json({ saved: true, treatment });
  } catch (e) {
    return toErrorResponse(e, 'PUT /api/admin/ai/config-versions/[id]/entries/[treatment]');
  }
}
