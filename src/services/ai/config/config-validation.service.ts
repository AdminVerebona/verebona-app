/**
 * Contrôles bloquants d'une version — CDC BO IA VER-003 et WF-02.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « AUCUNE TRANSITION D'ÉTAT » EN CAS D'ÉCHEC
 *
 * Le WF-02 l'exige. Ces contrôles sont donc exécutés AVANT la transition, et
 * leur résultat la conditionne — jamais l'inverse. Une version promue puis
 * rétrogradée aurait déjà pu être lue par une exécution en préproduction.
 *
 * Les erreurs sont rendues par traitement et par champ, comme le WF-02 le
 * demande : « présenter les erreurs éventuelles par traitement et champ ».
 * Un message global obligerait l'administrateur à chercher lui-même où est le
 * problème, sur cinq onglets.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES CATALOGUES SONT INJECTÉS
 *
 * Modèles disponibles, modèles tarifés, garde-fous et déclencheurs connus
 * viennent du code, pas de la configuration. Les injecter plutôt que les
 * importer rend ces contrôles testables sans base ni fournisseur, et laisse
 * ouverte la définition du catalogue de garde-fous, qui n'est pas arrêtée.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX CONTRÔLES QUE LE CDC NE DEMANDE PAS
 *
 * « Modèle tarifé » et « modèle présent au catalogue » ne figurent pas au
 * WF-02. Ils y sont ajoutés parce qu'ils évitent deux pannes déjà rencontrées :
 * `assertPricingReady` refuse le démarrage en production lorsqu'un modèle actif
 * n'a pas de tarif, et `gemini-2.5-flash-lite` a cessé d'être servi du jour au
 * lendemain. Sans eux, une version peut être validée, packagée, importée — et
 * faire échouer le démarrage de la production.
 */
import { TREATMENTS, getTreatment, isPromptAdministrable, type Treatment } from './treatments';
import {
  REASONING_LEVELS, GUARDRAIL_REACTIONS, FIELD_LABELS,
  type TreatmentConfig, type ConfigFieldKey,
} from './config-types';

export interface ValidationIssue {
  treatment: Treatment;
  field: ConfigFieldKey;
  label: string;
  message: string;
  /** Bloquant : interdit la promotion. Sinon, signalé sans empêcher. */
  blocking: boolean;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  /** Vrai si aucune issue bloquante — seul critère de promotion. */
  valid: boolean;
}

/** Ce que le code sait, et que la configuration doit respecter. */
export interface ConfigCatalogs {
  /** Modèles servis par le fournisseur, tels que l'écran Fournisseur IA les liste. */
  availableModels: ReadonlySet<string>;
  /** Modèles pour lesquels un tarif est connu. */
  pricedModels: ReadonlySet<string>;
  /** Codes de garde-fous du catalogue fermé. */
  guardrailCodes: ReadonlySet<string>;
  /** Codes d'événements et de planifications déclencheurs. */
  triggerCodes: ReadonlySet<string>;
  /** Borne haute de tokens de sortie, par modèle. Absent = non contrôlé. */
  maxOutputTokensByModel?: ReadonlyMap<string, number>;
  /**
   * Un traitement batch doit-il avoir au moins un déclencheur actif ?
   *
   * Point resté ouvert : une version sans déclencheur décrit un traitement qui
   * ne part que manuellement — cohérent, mais souvent un oubli que personne ne
   * remarque avant de constater que rien n'est analysé. Paramétrable tant que
   * l'arbitrage n'est pas rendu ; avertissement par défaut.
   */
  requireActiveTrigger?: boolean;
}

function issue(
  treatment: Treatment, field: ConfigFieldKey, message: string, blocking = true,
): ValidationIssue {
  return { treatment, field, label: FIELD_LABELS[field], message, blocking };
}

function validateModels(c: TreatmentConfig, cat: ConfigCatalogs): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const t = c.treatment;

  if (!c.primaryModel) {
    out.push(issue(t, 'primaryModel', 'Le modèle principal est obligatoire (MOD-001).'));
  }

  const declares: Array<[ConfigFieldKey, string | null]> = [
    ['primaryModel', c.primaryModel],
    ['fallback1', c.fallback1],
    ['fallback2', c.fallback2],
  ];

  for (const [field, model] of declares) {
    if (!model) continue;
    if (!cat.availableModels.has(model)) {
      out.push(issue(t, field, `Le modèle « ${model} » ne figure pas au catalogue fournisseur.`));
    } else if (!cat.pricedModels.has(model)) {
      // Séparé du précédent : un modèle absent du catalogue et un modèle non
      // tarifé appellent deux gestes différents — changer de modèle, ou
      // rafraîchir la grille.
      out.push(issue(t, field, `Aucun tarif connu pour « ${model} » : le démarrage en production échouerait.`));
    }
  }

  // Un fallback identique au principal ne protège de rien : si le principal
  // échoue techniquement, le même modèle échouera pareillement.
  const utilises = declares.filter(([, m]) => m).map(([, m]) => m!);
  const vus = new Set<string>();
  for (const [field, model] of declares) {
    if (!model) continue;
    if (vus.has(model)) {
      out.push(issue(t, field, `« ${model} » est déjà déclaré sur ce traitement : un repli identique ne protège de rien.`));
    }
    vus.add(model);
  }
  if (utilises.length === 0) return out;

  // §31.2 du CDC Assistant : aucun modèle Pro sur T2.
  if (t === 'T2') {
    for (const [field, model] of declares) {
      if (model && /-pro\b/.test(model)) {
        out.push(issue(t, field, `Aucun modèle Pro n'est autorisé sur l'assistant (« ${model} »).`));
      }
    }
  }

  return out;
}

function validateReasoning(c: TreatmentConfig): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const t = c.treatment;
  const paires: Array<[ConfigFieldKey, string | null, string | null]> = [
    ['reasoningPrimary', c.reasoningPrimary, c.primaryModel],
    ['reasoningFallback1', c.reasoningFallback1, c.fallback1],
    ['reasoningFallback2', c.reasoningFallback2, c.fallback2],
  ];

  for (const [field, level, model] of paires) {
    if (level && !(REASONING_LEVELS as readonly string[]).includes(level)) {
      out.push(issue(t, field, `Niveau de raisonnement inconnu : « ${level} ».`));
    }
    // Un niveau renseigné sur un fallback absent est un reste d'édition : il ne
    // s'appliquera jamais, et le laisser donnerait à croire qu'il agit.
    if (level && !model) {
      out.push(issue(t, field, 'Niveau renseigné alors que le modèle correspondant est absent.', false));
    }
    if (!level && model && field === 'reasoningPrimary') {
      out.push(issue(t, field, 'Le niveau de raisonnement du modèle principal est obligatoire.'));
    }
  }
  return out;
}

function validateTokens(c: TreatmentConfig, cat: ConfigCatalogs): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const t = c.treatment;
  if (c.maxOutputTokens === null) {
    out.push(issue(t, 'maxOutputTokens', 'Le nombre maximal de tokens de sortie est obligatoire.'));
    return out;
  }
  if (!Number.isInteger(c.maxOutputTokens) || c.maxOutputTokens <= 0) {
    out.push(issue(t, 'maxOutputTokens', 'Valeur invalide : un entier strictement positif est attendu.'));
    return out;
  }
  const borne = c.primaryModel ? cat.maxOutputTokensByModel?.get(c.primaryModel) : undefined;
  if (borne !== undefined && c.maxOutputTokens > borne) {
    out.push(issue(t, 'maxOutputTokens', `Au-delà de la borne du modèle principal (${borne}).`));
  }
  return out;
}

function validateGuardrails(c: TreatmentConfig, cat: ConfigCatalogs): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const t = c.treatment;
  const vus = new Set<string>();

  for (const g of c.guardrails) {
    if (!cat.guardrailCodes.has(g.code)) {
      out.push(issue(t, 'guardrails', `Garde-fou inconnu du catalogue : « ${g.code} ».`));
      continue;
    }
    if (vus.has(g.code)) {
      out.push(issue(t, 'guardrails', `Garde-fou « ${g.code} » déclaré deux fois.`));
    }
    vus.add(g.code);

    if (typeof g.threshold !== 'number' || !Number.isFinite(g.threshold)) {
      out.push(issue(t, 'guardrails', `Seuil manquant ou invalide pour « ${g.code} ».`));
    }
    if (!(GUARDRAIL_REACTIONS as readonly string[]).includes(g.reaction)) {
      out.push(issue(t, 'guardrails', `Réaction inconnue pour « ${g.code} » : « ${g.reaction} ».`));
    }
  }
  return out;
}

function validateTriggers(c: TreatmentConfig, cat: ConfigCatalogs): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const t = c.treatment;
  const batch = getTreatment(t).batch;

  // T2 et T5 sont synchrones et hors file (GEN-004). Un déclencheur y serait
  // sans effet : mieux vaut le refuser que le laisser croire actif.
  if (!batch) {
    if (c.triggers.length > 0) {
      out.push(issue(t, 'triggers', 'Ce traitement est synchrone : il ne peut pas avoir de déclencheur.'));
    }
    return out;
  }

  const vus = new Set<string>();
  for (const tr of c.triggers) {
    if (!cat.triggerCodes.has(tr.code)) {
      out.push(issue(t, 'triggers', `Déclencheur inconnu du catalogue : « ${tr.code} ».`));
      continue;
    }
    if (vus.has(tr.code)) {
      out.push(issue(t, 'triggers', `Déclencheur « ${tr.code} » déclaré deux fois.`));
    }
    vus.add(tr.code);
  }

  if (!c.triggers.some((x) => x.active)) {
    out.push(issue(
      t, 'triggers',
      "Aucun déclencheur actif : ce traitement ne partira que manuellement.",
      cat.requireActiveTrigger === true,
    ));
  }
  return out;
}

/**
 * Seuils de la cascade — T2 uniquement (§11.2).
 *
 * Les deux extrêmes sont légitimes et ne sont donc pas refusés : un seuil de 0
 * signifie « ce niveau suffit toujours », un seuil de 1 « il ne suffit jamais ».
 * Mais trois seuils à 1 envoient chaque question au modèle, et c'est le genre de
 * réglage qu'on pose en cherchant de la qualité sans voir ce qu'il coûte. On le
 * signale sans l'interdire : c'est un arbitrage, pas une faute.
 */
function validateCascade(c: TreatmentConfig): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const t = c.treatment;

  if (t !== 'T2') {
    if (c.cascade !== null) {
      out.push(issue(t, 'cascade', "La cascade coût/qualité n'existe que pour l'assistant."));
    }
    return out;
  }

  if (c.cascade === null) return out; // Non configuré : le code décide.

  const seuils: Array<[string, number]> = [
    ['base structurée', c.cascade.database],
    ['recherche textuelle', c.cascade.text],
    ['recherche sémantique', c.cascade.semantic],
  ];

  for (const [nom, valeur] of seuils) {
    if (typeof valeur !== 'number' || !Number.isFinite(valeur) || valeur < 0 || valeur > 1) {
      out.push(issue(t, 'cascade', `Seuil invalide pour ${nom} : attendu entre 0 et 1.`));
    }
  }

  if (seuils.every(([, v]) => v >= 1)) {
    out.push(issue(
      t, 'cascade',
      'Tous les niveaux escaladent systématiquement : chaque question ira au modèle.',
      false,
    ));
  }

  // Un niveau sémantique exigeant mais indisponible n'a aucun effet : la
  // question passe directement au modèle sans que le réglage le dise.
  if (!c.cascade.semanticEnabled && c.cascade.semantic < 1) {
    out.push(issue(
      t, 'cascade',
      'Le niveau sémantique est indisponible : son seuil ne s’appliquera pas.',
      false,
    ));
  }

  return out;
}

/**
 * Modèles d'une version que le fournisseur ne sert plus — CDC BO IA SCR-10.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CALCULÉ, JAMAIS STOCKÉ
 *
 * Le SCR-10 dit qu'« un modèle indisponible bloque une future validation qui le
 * référence » — c'est le contrôle de promotion. Il ne dit rien des versions
 * DÉJÀ validées, dont une peut devenir non rejouable du jour au lendemain parce
 * que le fournisseur a retiré un modèle. C'est arrivé le 18/09/2026.
 *
 * Une marque posée en base se périmerait : un modèle peut revenir, un autre
 * disparaître, et rien ne la rafraîchirait. Une marque fausse est pire qu'une
 * absence de marque, parce qu'elle est crue. Le calcul, lui, est toujours juste.
 *
 * ⚠️ Cette fonction NE DOIT PAS servir à exclure une version du rollback.
 * Pendant un incident, restaurer une version dont le repli fonctionne encore
 * peut être le moins mauvais choix. Elle sert à NOMMER le problème, pas à
 * décider à la place de l'administrateur.
 */
export function unavailableModels(
  entries: TreatmentConfig[],
  availableModels: ReadonlySet<string>,
): Array<{ treatment: Treatment; model: string; rank: string }> {
  const out: Array<{ treatment: Treatment; model: string; rank: string }> = [];
  for (const e of entries) {
    const chaine: Array<[string, string | null]> = [
      ['modèle principal', e.primaryModel],
      ['repli 1', e.fallback1],
      ['repli 2', e.fallback2],
    ];
    for (const [rank, model] of chaine) {
      if (model && !availableModels.has(model)) {
        out.push({ treatment: e.treatment, model, rank });
      }
    }
  }
  return out;
}

export function validateTreatment(c: TreatmentConfig, cat: ConfigCatalogs): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (!isPromptAdministrable(c.treatment)) {
    // T5-003, E-02 : le comportement de T5 est dans le code. Un texte hérité
    // d'une version antérieure est ignoré à l'exécution ; on le signale sans
    // bloquer, puisque l'administrateur n'a plus de champ pour le vider — le
    // prochain enregistrement de l'onglet T5 le fera.
    if (c.prompt && c.prompt.trim() !== '') {
      out.push(issue(
        c.treatment, 'prompt',
        "Le prompt de Prompt Control n'est pas administrable : ce texte hérité est ignoré.",
        false,
      ));
    }
  } else if (!c.prompt || c.prompt.trim() === '') {
    out.push(issue(c.treatment, 'prompt', 'Le prompt est obligatoire.'));
  }
  out.push(...validateModels(c, cat));
  out.push(...validateReasoning(c));
  out.push(...validateTokens(c, cat));
  out.push(...validateGuardrails(c, cat));
  out.push(...validateTriggers(c, cat));
  out.push(...validateCascade(c));
  return out;
}

/**
 * Valide une version entière avant promotion.
 *
 * Un traitement manquant est bloquant : le GEN-002 veut un instantané cohérent
 * des cinq, et une version incomplète laisserait deux traitements sur l'ancienne
 * configuration sans que rien ne le signale.
 */
export function validateVersion(
  entries: TreatmentConfig[],
  cat: ConfigCatalogs,
): ValidationResult {
  const parTraitement = new Map(entries.map((e) => [e.treatment, e]));
  const issues: ValidationIssue[] = [];

  for (const t of TREATMENTS) {
    const config = parTraitement.get(t);
    if (!config) {
      issues.push(issue(t, 'prompt', `Configuration absente pour ${t} : une version couvre les cinq traitements.`));
      continue;
    }
    issues.push(...validateTreatment(config, cat));
  }

  return { issues, valid: !issues.some((i) => i.blocking) };
}
