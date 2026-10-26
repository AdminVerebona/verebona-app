/**
 * Supervision BO des reprises automatiques de publication — lot 53I.
 *
 * Module PUR (aucun import serveur) : utilisé par le diagnostic
 * (`catalog-diagnostic.service`) et par le panneau BO (desktop et mobile).
 *
 * Quatre statuts DISTINCTS, jamais confondus :
 *   en cours        tentative en train de s'exécuter ;
 *   en attente      prévue au prochain passage, condition attendue, ou
 *                   nouvelle tentative programmée après une panne passagère ;
 *   échec définitif plus aucune tentative automatique (erreur fonctionnelle,
 *                   tentatives épuisées, contrôles en écart) : ACTION REQUISE ;
 *   terminé         publication active ET contrôles réussis.
 *
 * « Aucune action nécessaire » n'est affiché QUE lorsque c'est vrai (en cours,
 * en attente, terminé) — jamais sur un échec définitif.
 */

type RecoveryRowStatus = 'WAITING' | 'RUNNING' | 'RETRY_WAIT' | 'DONE' | 'FAILED' | 'CHECK_FAILED';
type RecoveryPhase = 'in_progress' | 'pending' | 'failed' | 'done';
type RecoveryTone = 'ok' | 'warn' | 'error' | 'muted';

interface RecoveryDisplay {
  phase: RecoveryPhase;
  label: string;
  tone: RecoveryTone;
  /** Ce que l'exploitant doit savoir / faire (texte exact affiché). */
  guidance: string;
  actionRequired: boolean;
}

export const RECOVERY_PHASE_LABELS: Readonly<Record<RecoveryPhase, string>> = {
  in_progress: 'En cours',
  pending: 'En attente',
  failed: 'Échec définitif',
  done: 'Terminé',
};

const NO_ACTION = 'Aucune action n’est nécessaire dans le BO ni dans Stripe.';

/** Statut affiché d'une reprise (ligne absente + `pending` : prévue). Pure. */
export function recoveryDisplay(row: { status: RecoveryRowStatus; nextAttemptAt?: string | null } | null, pending: boolean): RecoveryDisplay | null {
  if (!row) {
    return pending
      ? { phase: 'pending', label: `${RECOVERY_PHASE_LABELS.pending} — prévue au prochain passage de la tâche de publication (≤ 5 min)`, tone: 'warn', guidance: NO_ACTION, actionRequired: false }
      : null;
  }
  switch (row.status) {
    case 'RUNNING':
      return { phase: 'in_progress', label: `${RECOVERY_PHASE_LABELS.in_progress} — reprise automatique en cours d’exécution`, tone: 'warn', guidance: NO_ACTION, actionRequired: false };
    case 'WAITING':
      return { phase: 'pending', label: `${RECOVERY_PHASE_LABELS.pending} — une condition préalable est attendue (voir l’étape)`, tone: 'warn', guidance: `${NO_ACTION} La reprise repart seule dès que la condition est remplie.`, actionRequired: false };
    case 'RETRY_WAIT':
      return { phase: 'pending', label: `${RECOVERY_PHASE_LABELS.pending} — nouvelle tentative programmée après une panne Stripe passagère`, tone: 'warn', guidance: `${NO_ACTION} La tentative suivante est automatique.`, actionRequired: false };
    case 'DONE':
      return { phase: 'done', label: `${RECOVERY_PHASE_LABELS.done} — grille publiée, contrôles réussis`, tone: 'ok', guidance: 'Reprise terminée : publication active, six clés conformes, portail vérifié, abonnements existants inchangés.', actionRequired: false };
    case 'CHECK_FAILED':
      return { phase: 'failed', label: `${RECOVERY_PHASE_LABELS.failed} — grille publiée mais contrôles en écart`, tone: 'error', guidance: 'Plus aucune tentative automatique. Action requise : examiner les contrôles en écart ci-dessous et transmettre ce diagnostic à l’équipe technique.', actionRequired: true };
    case 'FAILED':
    default:
      return { phase: 'failed', label: `${RECOVERY_PHASE_LABELS.failed} — plus aucune tentative automatique`, tone: 'error', guidance: 'Action requise : l’étape bloquante et l’erreur ci-dessous ne se résoudront pas seules. Transmettre ce diagnostic à l’équipe technique (aucune manipulation dans Stripe).', actionRequired: true };
  }
}

/** Libellé lisible de l'étape bloquante journalisée. Pure. */
export function recoveryStepLabel(step: unknown): string {
  const s = typeof step === 'string' ? step : '';
  const labels: Record<string, string> = {
    publication: 'Publication (reprise de l’exécution)',
    products: 'Produits de vente',
    candidate: 'Prix candidats (six Price existants)',
    'validate-candidate': 'Contrôle des prix candidats',
    transfer: 'Transfert des lookup_key',
    reread: 'Relecture des six clés',
    'portal-backup': 'Sauvegarde du portail',
    portal: 'Portail de montée en gamme (prix autorisés)',
    'portal-final': 'Vérification finale du portail',
    controles: 'Contrôles après activation',
    terminee: 'Terminée',
    unexpected: 'Erreur inattendue',
    refused: 'Préconditions de publication',
  };
  return labels[s] ?? (s || '—');
}
