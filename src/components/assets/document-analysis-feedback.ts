/**
 * Retour d'une réanalyse depuis le tiroir du document (revue L16b-3) : motif
 * du serveur rendu par le système de toasts existant — `info` quand une
 * analyse est déjà en cours ou en file, `error` sinon. Module pur (aucun
 * import serveur), testé seul.
 */
export interface AnalyzeFeedback {
  level: 'info' | 'error';
  message: string;
}

const GENERIQUE = "Impossible de lancer l'analyse. Veuillez réessayer.";

export function analyzeErrorFeedback(evt: { code?: unknown; message?: unknown }): AnalyzeFeedback {
  const code = typeof evt.code === 'string' ? evt.code : '';
  const message = typeof evt.message === 'string' && evt.message.trim() ? evt.message.trim() : null;
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
  return { level: 'error', message: message ?? GENERIQUE };
}
