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
 *
 * Lot 113U (carte #720) : plus jamais le texte générique pour une cause
 * CONNUE. Chaque code (flux SSE, corps d'un refus HTTP, échec réseau) a sa
 * catégorie (`lib/ai/analysis-launch`) et son texte précis ; le générique ne
 * reste que pour l'inconnu, suivi de la référence d'incident (retrouvée au
 * BO › File d'attente IA › Refus de lancement d'analyse).
 */
import { userMessageText, ANALYSIS_FAILED_FINAL_MESSAGE } from '@/lib/ai/processing-status';
import { launchCategoryOf, normalizeLaunchCode, parseIncidentRef, type LaunchCategory } from '@/lib/ai/analysis-launch';

export interface AnalyzeFeedback {
  level: 'info' | 'error';
  message: string;
  /** Lot 113U : catégorie du refus (absente pour une issue d'analyse). */
  category?: LaunchCategory;
  /** Lot 113U : référence d'incident affichée (catégorie inconnue). */
  incidentRef?: string;
  /** Lot 113U : indisponibilité momentanée — le tiroir réessaie seul (borné). */
  autoRetry?: boolean;
}

const GENERIQUE = "Impossible de lancer l'analyse. Veuillez réessayer.";

/**
 * Lot 113U — textes par catégorie (référentiel fermé, À VALIDER PAR LE PO).
 * Aucun ne reprend un texte reçu.
 */
export const LAUNCH_MESSAGES = {
  SESSION: 'Votre session a expiré. Reconnectez-vous puis relancez l’analyse : votre document est conservé.',
  MFA: 'Confirmez votre identité (double authentification) puis relancez l’analyse : votre document est conservé.',
  CGUV: 'Acceptez les nouvelles conditions d’utilisation pour relancer l’analyse : votre document est conservé.',
  APP_UPDATE: 'Mettez à jour l’application Verebona pour relancer l’analyse : votre document est conservé.',
  ACCESS: 'Votre accès ne permet pas de lancer l’analyse de ce document.',
  PLAN_NOT_SUBSCRIBABLE: 'L’analyse automatique n’est pas disponible avec l’offre de ce compte.',
  TRIAL_EXPIRED: 'Votre période d’essai est terminée : l’analyse automatique n’est plus disponible.',
  SUBSCRIPTION_REQUIRED: 'Un abonnement actif est nécessaire pour lancer l’analyse automatique.',
  NOT_FOUND: 'Ce document est introuvable : il a peut-être été supprimé. Actualisez la liste de vos documents.',
  UNAVAILABLE: 'Le service d’analyse est momentanément indisponible. Un nouvel essai sera fait automatiquement dans quelques instants.',
  UNAVAILABLE_FINAL: 'Le service d’analyse reste indisponible pour le moment. Votre document est conservé : relancez l’analyse un peu plus tard.',
  NETWORK: 'Connexion impossible : vérifiez votre connexion Internet, puis relancez l’analyse.',
  STREAM_INTERRUPTED: 'La connexion a été interrompue pendant l’analyse. Son résultat s’affichera dans le document dès qu’il sera prêt.',
  ALREADY_QUEUED_AT: (heure: string) => `Ce document est déjà en file d’analyse : prochaine tentative vers ${heure}. Vous n’avez rien à faire.`,
} as const;

/** Texte générique (inconnu seulement), avec sa référence quand elle existe. */
export function genericLaunchMessage(incidentRef?: string | null): string {
  const ref = parseIncidentRef(incidentRef);
  return ref ? `${GENERIQUE} Référence : ${ref}.` : GENERIQUE;
}

/** Codes dont le message serveur est fonctionnel (rédigé pour l'utilisateur). */
const MESSAGES_FONCTIONNELS = new Set(['ALREADY_ANALYZING', 'ANALYSIS_COST_CAP_REACHED', 'ANALYSIS_QUOTA_REACHED', 'TRIAL_EXPIRED', 'SUBSCRIPTION_REQUIRED']);

/** Heure locale « 14 h 05 » (Europe/Paris) d'une prochaine tentative future, ou null. */
export function nextAttemptLabel(iso: unknown, now: number = Date.now()): string | null {
  if (typeof iso !== 'string') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() <= now) return null;
  const parts = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d);
  const h = parts.find((p) => p.type === 'hour')?.value;
  const m = parts.find((p) => p.type === 'minute')?.value;
  return h && m ? `${h} h ${m}` : null;
}

/** Retour d'une issue d'analyse (`ANALYSIS_FAILED` / `ANALYSIS_INTERRUPTED`, ou erreur sans code avec statut). */
function analysisOutcome(evt: { processingStatus?: unknown; userMessageCode?: unknown; processingResumeAt?: unknown }): AnalyzeFeedback {
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

/** Texte d'une catégorie de refus (hors issue d'analyse et hors « déjà en file »). */
function categoryFeedback(category: LaunchCategory, code: string, incidentRef: string | null): AnalyzeFeedback {
  const ref = incidentRef ? { incidentRef } : {};
  switch (category) {
    case 'SESSION': return { level: 'error', category, message: LAUNCH_MESSAGES.SESSION, ...ref };
    case 'MFA': return { level: 'error', category, message: LAUNCH_MESSAGES.MFA, ...ref };
    case 'CGUV': return { level: 'error', category, message: LAUNCH_MESSAGES.CGUV, ...ref };
    case 'APP_UPDATE': return { level: 'error', category, message: LAUNCH_MESSAGES.APP_UPDATE, ...ref };
    case 'ACCESS': return { level: 'error', category, message: LAUNCH_MESSAGES.ACCESS, ...ref };
    case 'PLAN': {
      const message = code === 'PLAN_UPGRADE_REQUIRED' ? "L'analyse automatique nécessite un abonnement Premium."
        : code === 'TRIAL_EXPIRED' ? LAUNCH_MESSAGES.TRIAL_EXPIRED
          : code === 'SUBSCRIPTION_REQUIRED' ? LAUNCH_MESSAGES.SUBSCRIPTION_REQUIRED
            : code === 'ANALYSIS_QUOTA_REACHED' ? 'Quota d’analyse atteint.'
              : LAUNCH_MESSAGES.PLAN_NOT_SUBSCRIBABLE;
      return { level: 'error', category, message, ...ref };
    }
    case 'NOT_FOUND': return { level: 'error', category, message: LAUNCH_MESSAGES.NOT_FOUND, ...ref };
    case 'UNAVAILABLE': return { level: 'error', category, message: LAUNCH_MESSAGES.UNAVAILABLE, autoRetry: true, ...ref };
    case 'NETWORK':
      return code === 'STREAM_INTERRUPTED'
        ? { level: 'info', category, message: LAUNCH_MESSAGES.STREAM_INTERRUPTED, ...ref }
        : { level: 'error', category, message: LAUNCH_MESSAGES.NETWORK, ...ref };
    default:
      return { level: 'error', category: 'UNKNOWN', message: genericLaunchMessage(incidentRef), ...ref };
  }
}

export function analyzeErrorFeedback(evt: {
  code?: unknown; message?: unknown;
  processingStatus?: unknown; userMessageCode?: unknown; processingResumeAt?: unknown;
  nextAttemptAt?: unknown; incidentRef?: unknown; httpStatus?: unknown;
}): AnalyzeFeedback {
  const code = normalizeLaunchCode(evt.code);
  const incidentRef = parseIncidentRef(evt.incidentRef);
  const message = MESSAGES_FONCTIONNELS.has(code) && typeof evt.message === 'string' && evt.message.trim()
    ? evt.message.trim() : null;
  if (code === 'ALREADY_ANALYZING' || code === 'ANALYSIS_WAITING_TECHNICAL') {
    // Lot 113R / 113U : job vivant en attente technique — texte du référentiel, jamais « relancer ».
    if (code === 'ANALYSIS_WAITING_TECHNICAL' || evt.userMessageCode === 'ANALYSIS_WAITING_TECHNICAL') {
      return { level: 'info', category: 'IN_PROGRESS', message: userMessageText('ANALYSIS_WAITING_TECHNICAL') ?? 'Ce document est déjà en cours d’analyse.' };
    }
    const heure = nextAttemptLabel(evt.nextAttemptAt);
    if (heure) return { level: 'info', category: 'IN_PROGRESS', message: LAUNCH_MESSAGES.ALREADY_QUEUED_AT(heure) };
    return { level: 'info', category: 'IN_PROGRESS', message: message ?? 'Ce document est déjà en cours d’analyse.' };
  }
  // Lot 22 : plafond IA du mois du compte atteint — l'analyse est reportée
  // (reprise automatique le 1er), ce n'est pas une erreur.
  if (code === 'ANALYSIS_COST_CAP_REACHED') {
    return { level: 'info', category: 'IN_PROGRESS', message: message ?? 'Plafond IA du mois atteint : l’analyse reprendra automatiquement le 1er du mois.' };
  }
  if (code === 'ANALYSIS_QUOTA_REACHED' && message) return { level: 'error', category: 'PLAN', message };
  if ((code === 'TRIAL_EXPIRED' || code === 'SUBSCRIPTION_REQUIRED') && message) return { level: 'error', category: 'PLAN', message };
  if (code === 'ANALYSIS_FAILED' || code === 'ANALYSIS_INTERRUPTED') return analysisOutcome(evt);
  // Lot 113U : événement d'erreur SANS code mais avec un statut fonctionnel
  // (relais d'un échec du pipeline par un serveur antérieur) : c'est une
  // issue d'analyse, jamais un « impossible de lancer ».
  if (!code && typeof evt.processingStatus === 'string') return analysisOutcome(evt);
  const status = typeof evt.httpStatus === 'number' ? evt.httpStatus : null;
  return categoryFeedback(launchCategoryOf(code, status), code, incidentRef);
}

/**
 * Lot 113U — refus HTTP de `POST /api/documents/[id]/analyze` (middleware,
 * proxy de l'hébergeur, version d'application) : le code est lu dans `code`
 * (le champ `error` des refus du middleware est un libellé, jamais un code),
 * puis dans `error` s'il a la forme d'un code ; à défaut, le statut HTTP.
 */
export function analyzeHttpFeedback(status: number, body: unknown, incidentRef?: string | null): AnalyzeFeedback {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const code = normalizeLaunchCode(b.code) || normalizeLaunchCode(b.error);
  return analyzeErrorFeedback({
    code, message: b.message, httpStatus: status,
    incidentRef: parseIncidentRef(b.incidentRef) ?? incidentRef ?? null,
    nextAttemptAt: b.nextAttemptAt, userMessageCode: b.userMessageCode,
  });
}
