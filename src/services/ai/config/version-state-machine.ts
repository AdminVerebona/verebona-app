/**
 * Cycle de vie d'une version de configuration IA — CDC BO IA §4.1 et §7.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TABLE DE TRANSITIONS, ET RIEN D'AUTRE
 *
 * Toute transition absente de la table est refusée. C'est le même parti que
 * `governance/state-machine.ts`, et pour la même raison : un état de
 * configuration qui dérive silencieusement est indétectable — on ne s'en
 * aperçoit qu'en constatant qu'une version qu'on croyait archivée s'exécute.
 *
 * Trois propriétés structurantes, vérifiées par les tests :
 *   · VER-002 — une Active est en lecture seule : aucune modification ne part
 *     d'ACTIVE, seule une dérivation en Brouillon le permet ;
 *   · VER-009 — une Active ne peut pas être archivée : la transition
 *     ACTIVE → ARCHIVED n'existe pas ;
 *   · VER-008 — l'archivage est définitif : ARCHIVED n'a aucune sortie.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ACTIVER ET RESTAURER NE SONT PAS LE MÊME ÉVÉNEMENT
 *
 * Les deux mènent VALIDATED → ACTIVE, et on serait tenté de n'en garder qu'un
 * avec un drapeau. Le WF-05 et le WF-06 décrivent pourtant deux opérations
 * différentes : l'activation normale « laisse terminer les exécutions déjà en
 * cours », le rollback « interrompt immédiatement les exécutions concernées »
 * et « remet les jobs batch interrompus en tête de file ».
 *
 * Un drapeau sur un événement unique rendrait ce choix invisible à la lecture,
 * et un appelant distrait interromprait la production en croyant activer.
 * Deux événements distincts obligent à le dire.
 */
import type { AiEnvironment } from './environment';

export type ConfigVersionStatus =
  /** Configuration éditable dérivée d'une Active. Non exécutable. */
  | 'DRAFT'
  /** Version de test, effective en préproduction uniquement (VER-004). */
  | 'TO_TEST'
  /** Configuration effectivement utilisée. Une seule par environnement. */
  | 'ACTIVE'
  /** Validée mais non active — ancienne Active, ou version importée (VER-012). */
  | 'VALIDATED'
  /** Historique non restaurable. Définitif (VER-008). */
  | 'ARCHIVED';

export type ConfigVersionEvent =
  /** Brouillon prêt à être testé (WF-02). Préproduction uniquement. */
  | 'promote'
  /** Retour en Brouillon ; la préproduction revient sur la dernière Active (VER-005). */
  | 'demote'
  /** Tests concluants : la version devient Active et reçoit son numéro (WF-03). */
  | 'validate'
  /** Une autre version prend sa place (WF-03, WF-05). */
  | 'supersede'
  /** Activation normale : n'interrompt rien (WF-05). */
  | 'activate'
  /** Restauration : interrompt les exécutions en cours (WF-06). */
  | 'rollback'
  /** Import d'un package en production, au statut Validé (VER-012). */
  | 'import'
  /** Archivage définitif (VER-008). */
  | 'archive';

const TRANSITIONS: Record<ConfigVersionStatus, Partial<Record<ConfigVersionEvent, ConfigVersionStatus>>> = {
  DRAFT: {
    promote: 'TO_TEST',
    // Un Brouillon jamais promu peut être archivé : il encombre sinon la liste
    // sans qu'aucun geste ne puisse l'en retirer.
    archive: 'ARCHIVED',
  },
  TO_TEST: {
    validate: 'ACTIVE',
    demote: 'DRAFT',
  },
  ACTIVE: {
    // Seule sortie : céder la place. Pas d'archivage (VER-009), pas d'édition
    // (VER-002) — modifier une Active suppose d'en dériver un Brouillon, ce qui
    // crée une nouvelle version et ne fait pas transiter celle-ci.
    supersede: 'VALIDATED',
  },
  VALIDATED: {
    activate: 'ACTIVE',
    rollback: 'ACTIVE',
    archive: 'ARCHIVED',
  },
  // VER-008 : aucune sortie. Ni désarchivage, ni suppression.
  ARCHIVED: {},
};

export class InvalidConfigTransition extends Error {
  constructor(from: ConfigVersionStatus, event: ConfigVersionEvent) {
    super(`[config-version] Transition refusée : « ${event} » depuis « ${from} ».`);
    this.name = 'InvalidConfigTransition';
  }
}

export function canTransition(from: ConfigVersionStatus, event: ConfigVersionEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function transition(from: ConfigVersionStatus, event: ConfigVersionEvent): ConfigVersionStatus {
  const to = TRANSITIONS[from][event];
  if (!to) throw new InvalidConfigTransition(from, event);
  return to;
}

export function allowedEvents(from: ConfigVersionStatus): ConfigVersionEvent[] {
  return Object.keys(TRANSITIONS[from]) as ConfigVersionEvent[];
}

/** Une version exécutable est celle que les nouveaux démarrages utilisent. */
export function isExecutable(status: ConfigVersionStatus, environment: AiEnvironment): boolean {
  if (status === 'ACTIVE') return true;
  // VER-004 : en préproduction, la version À tester devient immédiatement la
  // configuration effective des nouveaux démarrages. En production, jamais.
  return status === 'TO_TEST' && environment !== 'production';
}

/** Éligible à un rollback : déjà Active par le passé, et non archivée (VER-007). */
export function isRollbackEligible(
  status: ConfigVersionStatus,
  activatedAt: Date | null,
): boolean {
  return status === 'VALIDATED' && activatedAt !== null;
}

export function getTransitionTable(): typeof TRANSITIONS {
  return TRANSITIONS;
}
