/**
 * Lot 87C — harnais E2E du contrat des questions fondées (`t6-suggestions-v3`).
 *
 * Aucun prompt n'est modifié : `activerContratQuestions` active, comme le
 * ferait le PO au BO, une VERSION SIMULÉE du prompt maître T6 (texte du dépôt
 * + marqueurs du contrat) — celle que l'équipe IA livrera (demande
 * 87C-t6-suggestions-fondees). `fondee` construit, à partir du contexte
 * RÉELLEMENT transmis à T6, une question conforme au contrat (natures
 * recopiées des fondements cités) ; `over` permet d'en produire une non
 * conforme.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

export const MARQUEURS_CONTRAT = '\nR12 (contrat t6-suggestions-v3) — version simulée (e2e) : {"question":"…","subject":"…","purpose":"…","decision":{},"groundRefs":[],"informationNature":[]}\n';

/** Texte du prompt maître du dépôt + marqueurs du contrat (version BO simulée). */
export function masterAvecContrat(): string {
  return `${readFileSync(join(process.cwd(), 'src/services/ai/prompts/mascot/t6_master_v1.txt'), 'utf8')}${MARQUEURS_CONTRAT}`;
}

/** Active (ou retire, `false`) la version simulée du prompt T6 porteuse du contrat. */
export async function activerContratQuestions(actif = true): Promise<void> {
  const rt = await import('@/services/ai/master-prompts/master-prompt-runtime');
  rt.__setActiveMasterPromptsForTests(actif ? [{ id: 8701, treatment: 'T6' as never, versionNumber: 8701, content: masterAvecContrat() }] : null);
}

type Ctx = Record<string, unknown>;
type G = { ref: string; nature: string } | null | undefined;

/** Référence → nature, d'après le contexte transmis à T6. */
export function naturesDu(ctx: Ctx): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of (ctx.accountRefs as Array<{ ref: string; nature: string }> | undefined) ?? []) m.set(a.ref, a.nature);
  for (const a of (ctx.assets as Array<{ ref: string; documentsRef?: string | null }> | undefined) ?? []) {
    m.set(a.ref, 'ASSET_DATA');
    if (a.documentsRef) m.set(a.documentsRef, 'DOCUMENT_TITLE');
  }
  for (const d of (ctx.nextDeadlines as Array<{ ref: string; nature: string; identifiedAction?: G; description?: G; facts?: G[]; documents?: G[] }> | undefined) ?? []) {
    m.set(d.ref, d.nature);
    for (const g of [d.identifiedAction, d.description, ...(d.facts ?? []), ...(d.documents ?? [])]) if (g) m.set(g.ref, g.nature);
  }
  return m;
}

/** Question conforme au contrat, construite sur le contexte transmis. */
export function fondee(
  ctx: Ctx, question: string, groundRefs: string[],
  over: Partial<{ subject: string; purpose: string; assetRef: string | null; deadlineRef: string | null; decision: unknown; informationNature: string[] }> = {},
): Record<string, unknown> {
  const natures = naturesDu(ctx);
  const deadlineRef = over.deadlineRef !== undefined ? over.deadlineRef : groundRefs.find((r) => /^D\d+$/.test(r)) ?? null;
  const assetRef = over.assetRef !== undefined ? over.assetRef : null;
  const compte = (ctx.accountRefs as Array<{ ref: string; subject: string }> | undefined) ?? [];
  const subject = over.subject ?? (deadlineRef ? 'DEADLINE' : assetRef ? 'ASSET' : compte.find((a) => groundRefs.includes(a.ref))?.subject ?? 'DEADLINES');
  const purpose = over.purpose ?? 'CONSULT';
  return {
    question, subject, purpose, assetRef, deadlineRef,
    decision: over.decision ?? { relevant: true, answerable: true, preparationUseful: purpose === 'PREPARE' ? true : null },
    groundRefs,
    informationNature: over.informationNature ?? [...new Set(groundRefs.map((r) => natures.get(r)).filter((x): x is string => !!x))],
  };
}

/** Première échéance transmise (référence, libellé, fondements). */
export const premiereEcheance = (ctx: Ctx) => ((ctx.nextDeadlines as Array<Record<string, unknown> & { ref: string; label: string }> | undefined) ?? [])[0];
