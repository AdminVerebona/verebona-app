/**
 * T3 DOCUMENT_ASSET — PANNE TECHNIQUE ≠ QUESTION MÉTIER (lot 108E, ticket
 * « T3 DOCUMENT_ASSET — correctif #626 bis », A6, A5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ : à la dernière tentative, un modèle indisponible menait à
 * AI_UNAVAILABLE puis à une carte « À quel bien rattacher ce document ? » ; la
 * recherche sémantique rendait NO_CANDIDATE sur une erreur du fournisseur et
 * ouvrait elle aussi une carte. Une panne devenait une question à
 * l'utilisateur.
 *
 * LA RÈGLE : une panne (modèle, file, quota, schéma, données, base, graphe
 * d'identité) n'est JAMAIS une absence de preuve :
 *   · aucune carte « À traiter » nouvelle n'est créée, aucune n'est mise à
 *     jour par la panne ; une carte NÉE D'UNE PANNE (issue précédente
 *     technique) est fermée — la question n'existait pas ;
 *   · l'issue T3 est TECHNICAL_FAILURE (statut ABSTAINED, empreinte de contexte
 *     effacée : jamais « contexte inchangé ») — RELANCE DURABLE par le
 *     balayage T3 après `T3_TECHNICAL_RETRY_MINUTES` (défaut 60), sans
 *     intervention ;
 *   · anomalie Supervision (domaine IA) par compte et par catégorie, résolue
 *     automatiquement au premier succès.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { envNumber } from '@/lib/env-number';

/** Motif persisté d'une issue technique (`document_asset_resolutions.reason_code`). */
export const TECHNICAL_FAILURE_REASON = 'TECHNICAL_FAILURE';

/** Délai avant la relance durable d'un document en panne (minutes). */
export const T3_TECHNICAL_RETRY_MINUTES = envNumber('T3_TECHNICAL_RETRY_MINUTES', 60, { min: 5 });

export type TechnicalFailureCategory = 'MODEL' | 'QUOTA' | 'SCHEMA' | 'QUEUE' | 'DATA' | 'DATABASE' | 'IDENTITY_GRAPH';

/** Catégorie stable d'une erreur technique (pure, sans contenu). */
export function technicalCategoryOf(e: unknown): TechnicalFailureCategory {
  const code = String((e as { code?: unknown })?.code ?? '');
  const msg = String((e as Error)?.message ?? e ?? '').toLowerCase();
  if (/^(08|53|57|58|40|42p01|42703|xx)/i.test(code) || /econnrefused|connection terminated|deadlock|relation .* does not exist|statement timeout/.test(msg)) return 'DATABASE';
  if (/quota|rate.?limit|429|budget|plafond|insufficient_quota/.test(msg) || /QUOTA|RATE_LIMIT|BUDGET/.test(code)) return 'QUOTA';
  if (/schema|zod|invalid json|parse|sortie invalide|output_invalid/.test(msg) || /SCHEMA|OUTPUT_INVALID|PARSE/.test(code)) return 'SCHEMA';
  if (/queue|file d.?attente|lease|bail/.test(msg)) return 'QUEUE';
  if (/donn[ée]e|data/.test(msg) && !/database/.test(msg)) return 'DATA';
  return 'MODEL';
}

/**
 * IA NON CONFIGURÉE pour ce compte / cette opération (opération inactive ou
 * inconnue, compte inéligible) : ce n'est PAS une panne — même traitement que
 * T3 inactif (déterministe seul, vraie absence de preuve, question si utile),
 * aucune Supervision, aucune relance. Pure.
 */
export const AI_NOT_CONFIGURED_CODES: readonly string[] = ['OPERATION_INACTIVE', 'OPERATION_UNKNOWN', 'ACCOUNT_INELIGIBLE'];
export function aiNotConfigured(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && AI_NOT_CONFIGURED_CODES.includes(code);
}

/**
 * La carte « À traiter » OUVERTE du document est-elle NÉE D'UNE PANNE ? (pure)
 *   · issue d'avant le lot 108E : modèle en erreur (`ai.status = ERROR`) et
 *     carte ouverte par cette évaluation (AI_UNAVAILABLE, NO_CANDIDATE sur
 *     erreur du fournisseur) ;
 *   · issue TECHNICAL_FAILURE : origine de la carte RECONDUITE depuis
 *     l'évaluation précédente (`technicalFailure.cardOrigin`) — une carte
 *     d'ambiguïté réelle reste réelle même si une panne survient ensuite.
 */
export function wasTechnicalOutcome(r: { reasonCode: string | null; lastEvaluation: Record<string, unknown> | null } | null): boolean {
  if (!r) return false;
  const e = r.lastEvaluation as { ai?: { status?: string }; technicalFailure?: { cardOrigin?: string | null } } | null;
  if (r.reasonCode === TECHNICAL_FAILURE_REASON) return e?.technicalFailure?.cardOrigin === 'TECHNICAL';
  return e?.ai?.status === 'ERROR';
}

/** Détail technique porté par l'évaluation. */
export interface TechnicalFailureDetail {
  category: TechnicalFailureCategory;
  error: string;
  /** Relance durable prévue (balayage T3). */
  retryAfterMinutes: number;
  /** Carte née d'une panne fermée par cette évaluation. */
  technicalCardClosed: number | null;
  /** Origine de la carte encore ouverte après cette évaluation (BUSINESS : vraie question, conservée). */
  cardOrigin: 'TECHNICAL' | 'BUSINESS' | null;
}

const FP = 't3-document-asset-technical';

/** Anomalie Supervision (compte × catégorie, consolidée). Ne lève jamais. */
export async function reportTechnicalFailure(p: { accountId: number; fileId: number; category: TechnicalFailureCategory; error: string }): Promise<void> {
  try {
    const { reportAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
    await reportAnomaly({
      domain: 'ai', fingerprint: buildFingerprint('ai', FP, p.category, p.accountId), accountId: p.accountId,
      title: `T3 — rattachement des documents : panne technique (${p.category}), relance automatique`,
      detail: {
        code: `T3_DOCUMENT_ASSET_${p.category}`, fileId: p.fileId, cause: p.error.slice(0, 300), retryAfterMinutes: T3_TECHNICAL_RETRY_MINUTES,
        effect: 'aucune carte « À traiter » créée par la panne ; document repris par le balayage T3',
      },
    });
  } catch (e) {
    console.error(`[t3-document-asset] supervision non alimentée (document ${p.fileId}) :`, (e as Error).message);
  }
}

/** Premier succès d'un appel modèle pour le compte : incidents MODEL / QUOTA / SCHEMA résolus. Ne lève jamais. */
export async function resolveTechnicalFailures(accountId: number, categories: readonly TechnicalFailureCategory[]): Promise<void> {
  try {
    const { autoResolveAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
    for (const c of categories) await autoResolveAnomaly(buildFingerprint('ai', FP, c, accountId), { origin: 't3_document_asset', cause: 'appel réussi après la panne' });
  } catch { /* jamais bloquant */ }
}
