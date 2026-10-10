/**
 * Retour d'une réanalyse depuis le tiroir du document (revue L16b-3) : rendu
 * par le système de toasts existant — `info` quand une analyse est déjà en
 * cours ou en file, `error` sinon. Module pur (aucun import serveur), testé
 * seul.
 *
 * Lot 34C : le texte vient d'un référentiel FERMÉ. Un message du serveur
 * n'est repris que pour les codes FONCTIONNELS listés ci-dessous (refus
 * d'accès, analyse déjà en file, plafond daté) ; pour un échec d'analyse,
 * seuls `processingStatus` / `userMessageCode` comptent — aucune exception,
 * aucun motif technique ne peut devenir un texte utilisateur.
 */
import { userMessageText, ANALYSIS_FAILED_FINAL_MESSAGE } from '@/lib/ai/processing-status';

export interface AnalyzeFeedback {
  level: 'info' | 'error';
  message: string;
}

const GENERIQUE = "Impossible de lancer l'analyse. Veuillez réessayer.";

/** Codes dont le message serveur est fonctionnel (rédigé pour l'utilisateur). */
const MESSAGES_FONCTIONNELS = new Set(['ALREADY_ANALYZING', 'ANALYSIS_COST_CAP_REACHED', 'ANALYSIS_QUOTA_REACHED', 'TRIAL_EXPIRED', 'SUBSCRIPTION_REQUIRED']);

export function analyzeErrorFeedback(evt: {
  code?: unknown; message?: unknown;
  processingStatus?: unknown; userMessageCode?: unknown; processingResumeAt?: unknown;
}): AnalyzeFeedback {
  const code = typeof evt.code === 'string' ? evt.code : '';
  const message = MESSAGES_FONCTIONNELS.has(code) && typeof evt.message === 'string' && evt.message.trim()
    ? evt.message.trim() : null;
  if (code === 'PLAN_UPGRADE_REQUIRED') {
    return { level: 'error', message: "L'analyse automatique nécessite un abonnement Premium." };
  }
  if (code === 'ALREADY_ANALYZING') {
    return { level: 'info', message: message ?? 'Ce document est déjà en cours d’analyse.' };
  }
  // Lot 22 : plafond IA du mois du compte atteint — l'analyse est reportée
  // (reprise automatique le 1er), ce n'est pas une erreur.
  if (code === 'ANALYSIS_COST_CAP_REACHED') {
    return { level: 'info', message: message ?? 'Plafond IA du mois atteint : l’analyse reprendra automatiquement le 1er du mois.' };
  }
  if (code === 'ANALYSIS_QUOTA_REACHED') {
    return { level: 'error', message: message ?? 'Quota d’analyse atteint.' };
  }
  if (code === 'ANALYSIS_FAILED' || code === 'ANALYSIS_INTERRUPTED') {
    // Lot 34C : statut fonctionnel calculé par le serveur.
    switch (evt.processingStatus) {
      case 'PENDING': case 'PROCESSING': case 'RETRYING':
        // Une reprise réelle existe : aucune alerte, l'analyse se poursuit.
        return { level: 'info', message: 'L’analyse de ce document se poursuit automatiquement.' };
      case 'NEEDS_USER_ACTION':
        return {
          level: 'error',
          message: userMessageText(evt.userMessageCode, {
            resumeAt: typeof evt.processingResumeAt === 'string' ? evt.processingResumeAt : null,
          }) ?? ANALYSIS_FAILED_FINAL_MESSAGE,
        };
      default:
        return { level: 'error', message: ANALYSIS_FAILED_FINAL_MESSAGE };
    }
  }
  return { level: 'error', message: message ?? GENERIQUE };
}
