/**
 * Catalogues de garde-fous et de déclencheurs — CDC BO IA §15.1, SCR-02.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FERMÉS, ET DANS LE CODE
 *
 * Le SCR-02 parle d'un « catalogue prédéfini » de garde-fous ; le T3-005 dit
 * que le catalogue d'événements est *code-defined*, le BO n'en assurant que la
 * « sélection/versioning ». L'administrateur choisit donc dans ces listes, il
 * ne les écrit pas — et les faire évoluer demande une mise en production, pas
 * une version de configuration.
 *
 * La raison est simple : un garde-fou n'est pas qu'un libellé, c'est du code
 * qui compte quelque chose et déclenche une réaction. Laisser saisir un code
 * libre produirait des garde-fous qui ne surveillent rien.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CATALOGUE ARRÊTÉ — validation produit du 18/09/2026
 *
 * Le CDC ne les énumère nulle part : elles ont été dérivées de ce qu'il
 * mentionne ailleurs — MOD-008 pour les échecs consécutifs, WF-22 pour les
 * alertes de coût, §15.1 pour les planifications — puis validées telles quelles.
 *
 * Le critère qui a présidé au choix, et qui doit présider aux ajouts : chaque
 * garde-fou compte une grandeur DÉJÀ observable dans la télémétrie. Un
 * garde-fou qu'on ne sait pas mesurer ne se déclenchera jamais et donnera
 * l'illusion d'une protection — c'est la seule façon dont cette liste peut se
 * dégrader.
 */

export type GuardrailUnit = 'compte' | 'pourcentage' | 'euros' | 'secondes';

export interface GuardrailDefinition {
  code: string;
  label: string;
  description: string;
  unit: GuardrailUnit;
  /** Traitements auxquels le garde-fou s'applique. Vide = tous. */
  treatments?: readonly string[];
}

/** Garde-fous du catalogue fermé. */
export const GUARDRAIL_CATALOG: readonly GuardrailDefinition[] = [
  {
    code: 'consecutive_failures',
    label: 'Échecs consécutifs',
    description:
      "Nombre d'échecs techniques d'affilée sur le traitement. Le MOD-008 fixe déjà "
      + "une alerte à dix échecs consécutifs d'un même modèle ; ce garde-fou porte sur "
      + 'le traitement dans son ensemble.',
    unit: 'compte',
  },
  {
    code: 'invalid_output_rate',
    label: 'Taux de sortie invalide',
    description:
      'Part des appels dont la sortie est rejetée par le schéma. Un taux qui monte '
      + "signale un désaccord entre le prompt et le contrat attendu — la panne du 18 "
      + 'septembre en était une.',
    unit: 'pourcentage',
  },
  {
    code: 'fallback_rate',
    label: 'Taux de repli',
    description:
      'Part des appels ayant dû basculer sur un fallback. Un taux élevé indique que '
      + 'le modèle principal est en difficulté, avant même que les échecs ne deviennent totaux.',
    unit: 'pourcentage',
  },
  {
    code: 'daily_cost',
    label: 'Coût journalier',
    description: 'Dépense cumulée du traitement sur la journée (WF-22).',
    unit: 'euros',
  },
  {
    code: 'execution_duration',
    label: "Durée d'exécution",
    description:
      "Durée d'une exécution complète. Sert à repérer une dérive progressive, "
      + 'que le timeout technique ne voit pas puisqu\'il coupe au-delà.',
    unit: 'secondes',
    treatments: ['T1', 'T3', 'T4'],
  },
];

export function listGuardrails(treatment?: string): GuardrailDefinition[] {
  return GUARDRAIL_CATALOG.filter(
    (g) => !g.treatments || !treatment || g.treatments.includes(treatment),
  );
}

export function guardrailCodes(): Set<string> {
  return new Set(GUARDRAIL_CATALOG.map((g) => g.code));
}

// ── Déclencheurs ────────────────────────────────────────────────────────────

export interface TriggerDefinition {
  code: string;
  label: string;
  kind: 'event' | 'schedule';
  /** Traitements auxquels le déclencheur s'applique. Vide = tous les batch. */
  treatments?: readonly string[];
}

/**
 * Planifications simples du §15.1 — « toutes les X heures, quotidien,
 * hebdomadaire, mensuel ; pas de cron libre ».
 *
 * L'interdiction du cron libre est une contrainte volontaire, pas une
 * limitation : une expression mal formée ne se découvre qu'au moment où le job
 * ne part pas, c'est-à-dire trop tard.
 */
/**
 * ══════════════════════════════════════════════════════════════════════════
 * LUS AU RUNTIME (lot IA 2 — T1-UI-08, T3-UI-04/05, T4-UI-04, T3-003, WF-18)
 *
 * `queue/triggers.ts` décide, pour chaque événement émis et à chaque tour du
 * boucleur, si le déclencheur est actif dans la version effective. Deux
 * conséquences sur ce catalogue :
 *   · un code n'y figure que s'il est RÉELLEMENT émis quelque part, ou
 *     planifié par le boucleur ;
 *   · les planifications ne s'appliquent qu'aux traitements qui ont un
 *     « périmètre planifié » défini dans le code (§15.1) : T1 (sources non
 *     analysées ou en échec récupérable) et T3 (comptes à rationaliser). T4
 *     n'en a pas : ses candidats viennent d'une analyse T1, une planification
 *     n'aurait rien à lui donner.
 *
 * `agenda_item_due` a été retiré : aucun code ne l'émettait, il ne pouvait
 * donc rien déclencher. `document_linked` et `arbitration_resolved` ont été
 * ajoutés : ce sont les deux événements à impact de cohérence que le code
 * émettait déjà vers T3 sans qu'on puisse les choisir (T3-004, T3-005).
 */
const SCHEDULABLE = ['T1', 'T3'] as const;

export const TRIGGER_CATALOG: readonly TriggerDefinition[] = [
  { code: 'schedule_hourly', label: 'Toutes les heures', kind: 'schedule', treatments: SCHEDULABLE },
  { code: 'schedule_6h', label: 'Toutes les six heures', kind: 'schedule', treatments: SCHEDULABLE },
  { code: 'schedule_12h', label: 'Toutes les douze heures', kind: 'schedule', treatments: SCHEDULABLE },
  { code: 'schedule_daily', label: 'Quotidien', kind: 'schedule', treatments: SCHEDULABLE },
  { code: 'schedule_weekly', label: 'Hebdomadaire', kind: 'schedule', treatments: SCHEDULABLE },
  { code: 'schedule_monthly', label: 'Mensuel', kind: 'schedule', treatments: SCHEDULABLE },

  { code: 'source_uploaded', label: 'Dépôt d\'une source', kind: 'event', treatments: ['T1'] },
  // Conservé (versions existantes) mais NON conditionnant : l'analyse d'un
  // lien web est l'action synchrone de l'utilisateur qui l'ajoute, pas un
  // traitement de fond — la refuser silencieusement serait pire.
  { code: 'web_link_added', label: 'Ajout d\'un lien web', kind: 'event', treatments: ['T1'] },
  { code: 'source_analyzed', label: 'Analyse de source terminée', kind: 'event', treatments: ['T3', 'T4'] },
  { code: 'document_linked', label: 'Rattachement d\'un document à un bien', kind: 'event', treatments: ['T3'] },
  { code: 'asset_updated', label: 'Modification d\'un bien', kind: 'event', treatments: ['T3'] },
  { code: 'arbitration_resolved', label: 'Arbitrage « À traiter » résolu', kind: 'event', treatments: ['T3'] },
];

/**
 * Période d'une planification simple (§15.1, T3-006 : « X heures / quotidien /
 * hebdo / mensuel ; pas de cron libre »). Mensuel = 30 jours : l'intervalle
 * compte, pas la date du calendrier.
 */
export const SCHEDULE_PERIOD_HOURS: Readonly<Record<string, number>> = {
  schedule_hourly: 1,
  schedule_6h: 6,
  schedule_12h: 12,
  schedule_daily: 24,
  schedule_weekly: 24 * 7,
  schedule_monthly: 24 * 30,
};

export function listTriggers(treatment?: string): TriggerDefinition[] {
  return TRIGGER_CATALOG.filter(
    (t) => !t.treatments || !treatment || t.treatments.includes(treatment),
  );
}

export function triggerCodes(): Set<string> {
  return new Set(TRIGGER_CATALOG.map((t) => t.code));
}
