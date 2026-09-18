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
export const TRIGGER_CATALOG: readonly TriggerDefinition[] = [
  { code: 'schedule_hourly', label: 'Toutes les heures', kind: 'schedule' },
  { code: 'schedule_6h', label: 'Toutes les six heures', kind: 'schedule' },
  { code: 'schedule_daily', label: 'Quotidien', kind: 'schedule' },
  { code: 'schedule_weekly', label: 'Hebdomadaire', kind: 'schedule' },
  { code: 'schedule_monthly', label: 'Mensuel', kind: 'schedule' },

  { code: 'source_uploaded', label: 'Dépôt d\'une source', kind: 'event', treatments: ['T1'] },
  { code: 'web_link_added', label: 'Ajout d\'un lien web', kind: 'event', treatments: ['T1'] },
  { code: 'source_analyzed', label: 'Analyse de source terminée', kind: 'event', treatments: ['T3', 'T4'] },
  { code: 'asset_updated', label: 'Modification d\'un bien', kind: 'event', treatments: ['T3'] },
  { code: 'agenda_item_due', label: 'Échéance arrivée à terme', kind: 'event', treatments: ['T4'] },
];

export function listTriggers(treatment?: string): TriggerDefinition[] {
  return TRIGGER_CATALOG.filter(
    (t) => !t.treatments || !treatment || t.treatments.includes(treatment),
  );
}

export function triggerCodes(): Set<string> {
  return new Set(TRIGGER_CATALOG.map((t) => t.code));
}
