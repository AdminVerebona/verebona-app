/**
 * /api/admin/ai/prompt-changes — CDC §4.5.3, critère d'acceptation n°18.
 *
 * POST : crée une demande de modification de prompt et la fait analyser.
 * GET  : liste les demandes, la plus récente d'abord.
 *
 * ── POURQUOI CETTE ROUTE N'EXISTAIT PAS, ET CE QUE ÇA IMPLIQUAIT ─────────
 * La gouvernance disposait de tout l'aval — `diff`, `activate`, `rollback`,
 * machine à états, double validation par deux personnes distinctes — mais
 * d'aucun moyen de CRÉER une demande. `analyzeInstruction` n'avait aucun
 * appelant. Le circuit conforme était donc complet et inutilisable, pendant que
 * `/api/admin/ai-instructions/apply` continuait d'appliquer les modifications
 * en écrivant dans les `.txt`, sans aperçu ni validation.
 *
 * ── CE QUE CETTE ROUTE NE FAIT PAS ───────────────────────────────────────
 * Elle n'active rien. Elle produit une proposition à l'état `PROPOSED` : le
 * diff devient consultable, les tests restent à exécuter, et deux validations
 * humaines distinctes restent nécessaires avant l'activation. C'est exactement
 * ce que le §4.5.3 exige et ce que l'ancienne route court-circuitait.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { requireAdmin } from '@/lib/auth-guards';
import { pgClient, ensureMigrations } from '@/db';
import { analyzeInstruction, hashContent, transition } from '@/services/ai/governance';
import { getActiveVersion } from '@/services/ai/governance/activation.service';
import { resolvePrompt } from '@/services/ai/prompts/prompt-loader';
import { listLlmOperations } from '@/services/ai/registry/operations';
import type { AiUseCaseCode } from '@/services/ai/registry/use-cases';

/**
 * Prompts gouvernables : ceux que le référentiel rattache à une opération.
 *
 * Catalogue FERMÉ. Un code libre permettrait de créer des versions pour un
 * prompt que personne n'exécute, et de les croire actives.
 */
function promptsGouvernables(): Map<string, AiUseCaseCode> {
  const m = new Map<string, AiUseCaseCode>();
  for (const op of listLlmOperations()) {
    if (op.promptCode) m.set(op.promptCode, op.useCaseCode);
  }
  return m;
}

/** Compte technique portant les appels de gouvernance. */
function compteTechnique(): number {
  const brut = Number(process.env.CORPUS_ACCOUNT_ID);
  if (!Number.isInteger(brut) || brut <= 0) {
    throw new Error(
      'CORPUS_ACCOUNT_ID est absente ou invalide. Renseignez un compte technique : ' +
      "rattacher une analyse d'instruction à un compte client fausserait ses coûts.",
    );
  }
  return brut;
}

export async function POST(req: NextRequest) {
  let adminUserId: number;
  try {
    adminUserId = await requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();

  const body = await req.json().catch(() => ({}));
  const promptCode = typeof body.promptCode === 'string' ? body.promptCode.trim() : '';
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';

  const gouvernables = promptsGouvernables();
  if (!gouvernables.has(promptCode)) {
    return NextResponse.json(
      { error: 'UNKNOWN_PROMPT_CODE', message: `Prompt inconnu du référentiel : « ${promptCode} ».` },
      { status: 400 },
    );
  }
  if (instruction.length < 10) {
    return NextResponse.json(
      { error: 'INSTRUCTION_TOO_SHORT', message: "L'instruction doit décrire le comportement attendu." },
      { status: 400 },
    );
  }
  if (instruction.length > 2000) {
    return NextResponse.json({ error: 'INSTRUCTION_TOO_LONG' }, { status: 400 });
  }

  let accountId: number;
  try {
    accountId = compteTechnique();
  } catch (e) {
    return NextResponse.json({ error: 'NO_TECHNICAL_ACCOUNT', message: (e as Error).message }, { status: 503 });
  }

  // ── Contenu de référence ────────────────────────────────────────────────
  // La version active fait foi ; à défaut, le fichier d'amorçage du dépôt.
  // `resolvePrompt` avec des variables vides rend le gabarit brut : les
  // marqueurs `{{VAR}}` sans valeur sont laissés en place, ce qui est bien ce
  // qu'on veut analyser.
  const active = await getActiveVersion(promptCode);
  const baseContent = active?.content
    ?? (await resolvePrompt(promptCode, {}, gouvernables.get(promptCode))).text;

  if (!baseContent) {
    return NextResponse.json(
      { error: 'PROMPT_CONTENT_UNAVAILABLE', message: `Aucun contenu pour « ${promptCode} ».` },
      { status: 404 },
    );
  }

  // ── Demande à l'état DRAFT ──────────────────────────────────────────────
  // Créée AVANT l'appel modèle : une analyse qui échoue doit laisser une trace
  // de la demande, sinon l'administrateur ne sait pas si elle a été reçue.
  const crRows = await pgClient.unsafe(
    `INSERT INTO ai_prompt_change_requests (prompt_code, status, instruction, base_version_id, created_by)
     VALUES ($1, 'DRAFT', $2, $3, $4) RETURNING id`,
    [promptCode, instruction, active?.id ?? null, adminUserId] as never[],
  );
  const changeRequestId = Number((crRows as unknown as Array<{ id: number }>)[0].id);

  try {
    const proposition = await analyzeInstruction(
      promptCode, baseContent, instruction, accountId, adminUserId,
    );

    // Une proposition identique au prompt actif n'a pas à encombrer le circuit
    // de validation : elle est écartée avant même l'affichage du diff.
    if (proposition.rejected) {
      await pgClient.unsafe(
        `UPDATE ai_prompt_change_requests
            SET status = 'REJECTED', rejected_reason = $2, impact_analysis = $3, updated_at = NOW()
          WHERE id = $1`,
        [changeRequestId, proposition.rejected, proposition.impactAnalysis] as never[],
      );
      return NextResponse.json({
        changeRequestId, status: 'REJECTED', reason: proposition.rejected,
        impactAnalysis: proposition.impactAnalysis,
      });
    }

    // ── Version candidate ─────────────────────────────────────────────────
    // Statut CANDIDATE : l'index unique partiel de la migration 0106 garantit
    // qu'elle ne peut pas devenir active sans passer par `activateVersion`.
    const versionRows = await pgClient.unsafe(
      `INSERT INTO ai_prompt_versions (prompt_code, version, content, content_hash, status, created_by)
       VALUES ($1, $2, $3, $4, 'CANDIDATE', $5) RETURNING id`,
      [
        promptCode, `cr-${changeRequestId}`, proposition.proposedContent,
        hashContent(proposition.proposedContent), adminUserId,
      ] as never[],
    );
    const candidateVersionId = Number((versionRows as unknown as Array<{ id: number }>)[0].id);

    // La transition passe par la machine à états : aucun statut n'est écrit en
    // dur, toute transition non prévue lève.
    const statut = transition('DRAFT', 'analyze');

    await pgClient.unsafe(
      `UPDATE ai_prompt_change_requests
          SET status = $2, impact_analysis = $3, risks = $4::jsonb,
              candidate_version_id = $5, updated_at = NOW()
        WHERE id = $1`,
      [
        changeRequestId, statut, proposition.impactAnalysis,
        JSON.stringify(proposition.risks), candidateVersionId,
      ] as never[],
    );

    return NextResponse.json({
      changeRequestId,
      status: statut,
      candidateVersionId,
      impactAnalysis: proposition.impactAnalysis,
      risks: proposition.risks,
      diff: proposition.diff,
      // Rappel explicite : rien n'est appliqué à ce stade.
      nextSteps: [
        'Consulter le diff, puis approuver la proposition.',
        'Exécuter les tests sur le corpus de référence.',
        "Valider l'activation — par une personne distincte de l'approbateur.",
      ],
    });
  } catch (e) {
    await pgClient.unsafe(
      `UPDATE ai_prompt_change_requests
          SET status = 'REJECTED', rejected_reason = $2, updated_at = NOW()
        WHERE id = $1`,
      [changeRequestId, `analyse indisponible : ${(e as Error).message}`.slice(0, 500)] as never[],
    );
    console.error('[POST /api/admin/ai/prompt-changes]', e);
    return NextResponse.json(
      { error: 'ANALYSIS_FAILED', changeRequestId, message: "L'analyse du prompt a échoué." },
      { status: 502 },
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();

  const promptCode = new URL(req.url).searchParams.get('promptCode');
  const rows = await pgClient.unsafe(
    `SELECT id, prompt_code, status, instruction, impact_analysis, risks,
            base_version_id, candidate_version_id, created_by, approved_by,
            activated_by, rejected_reason, created_at, updated_at
       FROM ai_prompt_change_requests
      WHERE ($1::text IS NULL OR prompt_code = $1)
      ORDER BY created_at DESC
      LIMIT 50`,
    [promptCode] as never[],
  );

  // Le catalogue accompagne la liste : l'interface a besoin des codes
  // gouvernables pour proposer un choix, et les dupliquer côté client les
  // ferait diverger du référentiel au premier ajout d'opération.
  const catalogue = [...promptsGouvernables().entries()]
    .map(([promptCode, useCaseCode]) => ({ promptCode, useCaseCode }))
    .sort((a, b) => a.promptCode.localeCompare(b.promptCode));

  return NextResponse.json({ changeRequests: rows, governablePrompts: catalogue });
}
