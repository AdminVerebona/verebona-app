/**
 * Lot 58B — ticket P1 « À traiter : questions inutiles sur des échéances
 * passées et données déjà connues ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CAUSE PROUVÉE (voir `l58b-a-traiter-echeances.e2e.ts`, ECH-01 à ECH-04)
 *
 *   1. Une date lue « 20:06:2026 » était refusée PARTOUT : le registre
 *      (`normalizeDateValue`) n'acceptait que « / . - », la projection T1
 *      requalifiait donc le fait `contractEndDate` en connaissance GÉNÉRIQUE
 *      (VALUE_NOT_NORMALIZABLE), et le pont documentaire (`toIsoDate`, ISO
 *      seul ; `rawValueOf`, sans « : ») l'écartait aussi : la date connue
 *      devenait « absente » → carte « À compléter ».
 *   2. La création INITIALE ignorait la connaissance persistée : l'analyse
 *      ne lisait que les faits canoniques de la sortie (ni alias, ni fait
 *      générique, ni unité « libellé : valeur ») et le balayage horaire
 *      créait la carte sur la seule absence de `document_field_values`.
 *      Seul le passage T3 (57B) relisait la connaissance — après coup.
 *   3. Aucune notion de pertinence : une échéance PASSÉE sans action
 *      produisait la même question qu'un contrat en cours.
 *
 * CE MODULE (sans règle propre à un type de contrat, sans liste de
 * formulations) :
 *   · `parseDocumentDate` — dates NON ambiguës normalisées (20:06:2026,
 *     20/06/2026, 20.06.2026, 20-06-2026, 20 juin 2026, 2026/06/20) ; refus
 *     des formes ambiguës (année sur deux chiffres, séparateurs mêlés) ; une
 *     forme JJ/MM où jour et mois sont tous deux ≤ 12 est lue à la française
 *     mais ne vaut jamais « certaine » (ORDER_AMBIGUOUS) ;
 *   · `gatherFieldEvidence` — faits actifs (clé canonique, alias, clé brute,
 *     libellé), faits non intégrés, unités « libellé : valeur », et indice du
 *     TITRE / nom de fichier : il oriente la recherche mais ne prouve jamais
 *     seul — une date du titre n'est proposée que si elle est RETROUVÉE dans
 *     le contenu du document, et jamais écrite sans validation ;
 *   · `assessDeadlinePertinence` — échéance passée : la branche IA EXISTANTE
 *     T4 CLASSIFY_EVENT (prompt inchangé) dit si l'événement exige une
 *     action (`homeCategory = action`) ou n'est qu'une information
 *     historique. Information → aucune question ; action, abstention, refus
 *     ou échec technique → la question reste (variante prudente). La
 *     décision est mémorisée (signature des éléments) : ni rappel de l'IA,
 *     ni recréation de carte aux balayages suivants ;
 *   · `recordRuleEvaluation` — diagnostic par règle (migration 0418), lu
 *     par le BO (Diagnostic des « À traiter »).
 *
 * ── LOT 61 — ÉCARTS RÉSIDUELS DU 58B ET PERTINENCE DES CARTES ─────────────
 *
 *   · décision CENTRALE `assessDeadlinePertinence` : AUTO_RESOLVED /
 *     NO_ACTION / DEFER / CREATE_ACTION, hybride (code : préconditions,
 *     temps, historique, mémoire ; T4 `t4_output_v3` : intervention concrète,
 *     justification, preuve — contrôlée par `checkInterventionCoherence`) ;
 *     contrat de décision interne versionné (`DecisionContract`) ;
 *   · date du TITRE seule : indice, jamais preuve (écart 7) ; date absente :
 *     contexte documentaire examiné avant toute question (écart 3) ;
 *   · lecture en échec distinguée d'une donnée absente (`errors`, écart 5) ;
 *   · mémoire invalidée par l'empreinte des preuves, la révision de
 *     connaissance et la configuration IA (écart 4) ;
 *   · consolidation entre documents d'un MÊME contrat (référence exacte) ;
 *   · diagnostic : issue, contrat de décision, écriture, cartes, passages
 *     (migration 0444, écart 6).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';
import { pgClient } from '@/db';
import { getField, resolveAlias } from '@/services/canonical/registry';
import { documentBridgeRules, type ProcessingRule } from './rules-catalog';
import { checkInterventionCoherence, type InterventionDecision } from './intervention-check';
import type { TraceFailure } from './trace-retries';
import {
  DEFAULT_TO_PROCESS_THRESHOLDS, composeConfigRef, deferThresholdsRef, loadToProcessThresholds, type ToProcessThresholds,
} from './relevance-thresholds';

/** Version du traitement (diagnostic, BO). */
/**
 * Version du traitement (diagnostic, BO). Lot 76 : `l76-1` — durées
 * partiellement interprétées refusées (C1), fin effective prouvée (C2), T4
 * incompatible sans décision (C3), preuves du même contrat (C4) : les valeurs
 * calculées et décisions du moteur antérieur sont revues (balayage, campagne
 * `l76-pertinence-1`). Lot 76 (I) : `l76-2` — fin calculée par l'échéancier
 * (dernière échéance, première échéance + nombre d'échéances) et date de fin
 * d'un remboursement par échéances sans démarche de fin jamais demandée : la
 * même campagne reprend les décisions de `l76-1`.
 */
export const DOCUMENT_RULE_ENGINE_VERSION = 'l76-2';

// ══════════════════════════════════════════════════════════════════════════
// DATES — fonctions pures
// ══════════════════════════════════════════════════════════════════════════

export type DateParseStatus = 'ISO' | 'NORMALIZED' | 'ORDER_AMBIGUOUS' | 'REFUSED_AMBIGUOUS' | 'INVALID' | 'NOT_A_DATE';
export interface DateParse { iso: string | null; status: DateParseStatus }

const MOIS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};
const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const pad = (n: number) => String(n).padStart(2, '0');

function jour(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900 && y <= 2200
    ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/**
 * Date lue dans un document → ISO, avec le statut de normalisation. Pure.
 *   ISO (AAAA-MM-JJ[…]) · NORMALIZED (forme non ISO sans ambiguïté) ·
 *   ORDER_AMBIGUOUS (JJ/MM/AAAA avec jour et mois ≤ 12 et différents : lu à
 *   la française, jamais certain) · REFUSED_AMBIGUOUS (année sur deux
 *   chiffres, séparateurs mêlés) · INVALID (31/02…) · NOT_A_DATE.
 */
export function parseDocumentDate(raw: unknown): DateParse {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? { iso: null, status: 'INVALID' } : { iso: raw.toISOString().slice(0, 10), status: 'ISO' };
  if (typeof raw !== 'string') return { iso: null, status: 'NOT_A_DATE' };
  const s = sansAccents(raw.trim().toLowerCase()).replace(/\s+/g, ' ');
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[t ])/.exec(s);
  if (m) { const iso = jour(+m[1], +m[2], +m[3]); return iso ? { iso, status: 'ISO' } : { iso: null, status: 'INVALID' }; }
  m = /^(\d{4})([/.])(\d{1,2})\2(\d{1,2})$/.exec(s);
  if (m) { const iso = jour(+m[1], +m[3], +m[4]); return iso ? { iso, status: 'NORMALIZED' } : { iso: null, status: 'INVALID' }; }
  m = /^(\d{1,2})([/.\-: ])(\d{1,2})\2(\d{4})$/.exec(s);
  if (m) {
    const d = +m[1], mo = +m[3];
    const iso = jour(+m[4], mo, d);
    if (!iso) return { iso: null, status: 'INVALID' };
    return { iso, status: d <= 12 && mo <= 12 && d !== mo ? 'ORDER_AMBIGUOUS' : 'NORMALIZED' };
  }
  if (/^\d{1,2}[/.\-: ]\d{1,2}[/.\-: ]\d{4}$/.test(s) || /^\d{1,2}[/.\-:]\d{1,2}[/.\-:]\d{2}$/.test(s)) return { iso: null, status: 'REFUSED_AMBIGUOUS' };
  m = /^(1er|\d{1,2}) ([a-z]+) (\d{4})$/.exec(s);
  if (m && MOIS[m[2]]) {
    const iso = jour(+m[3], MOIS[m[2]], m[1] === '1er' ? 1 : +m[1]);
    return iso ? { iso, status: 'NORMALIZED' } : { iso: null, status: 'INVALID' };
  }
  return { iso: null, status: 'NOT_A_DATE' };
}

const RE_DATES = new RegExp([
  String.raw`(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)`,
  String.raw`(?<!\d)\d{4}([/.])\d{1,2}\1\d{1,2}(?!\d)`,
  String.raw`(?<![\d/.:-])\d{1,2}([/.\-:])\d{1,2}\2\d{4}(?!\d)`,
  String.raw`(?<![\p{L}\d])(?:1er|\d{1,2})\s+[\p{L}]+\s+\d{4}(?!\d)`,
].join('|'), 'giu');

/** Dates NON refusées mentionnées dans un texte (ISO, dédoublonnées, dans l'ordre). Pure. */
export function datesMentionedIn(text: string | null | undefined): Array<{ raw: string; iso: string; status: DateParseStatus }> {
  if (!text) return [];
  const out = new Map<string, { raw: string; iso: string; status: DateParseStatus }>();
  for (const m of text.matchAll(RE_DATES)) {
    const p = parseDocumentDate(m[0]);
    if (p.iso && !out.has(p.iso)) out.set(p.iso, { raw: m[0], iso: p.iso, status: p.status });
  }
  return [...out.values()];
}

// ══════════════════════════════════════════════════════════════════════════
// CLÉS — registre canonique (pures)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Clé d'une donnée documentaire du pont pour une clé d'écran ou une clé lue
 * (`warrantyEndDate`, `dateFinContrat`…), sinon null.
 */
export function documentBridgeFieldKey(screenKey: string): string | null {
  const keys = new Set(documentBridgeRules().filter((r) => r.fieldKey).map((r) => r.fieldKey!));
  if (keys.has(screenKey)) return screenKey;
  const canonique = resolveAlias(screenKey);
  return canonique && keys.has(canonique) ? canonique : null;
}

/** Une clé lue par T1 désigne-t-elle la donnée `key` du pont ? (pure, registre canonique) */
export function t1KeyDesignates(raw: string | null | undefined, key: string): boolean {
  if (!raw) return false;
  if (raw === key) return true;
  return documentBridgeFieldKey(raw) === key;
}

const normLabel = (v: string) => sansAccents(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Libellé LU dans le document (unité « libellé : valeur ») qui désigne la
 * donnée `key` : clé ou alias du registre, ou libellé du registre contenu
 * dans le libellé lu (« Date de fin de contrat » ⊃ « Fin de contrat »). Pure.
 */
export function t1LabelDesignates(label: string | null | undefined, key: string, registryLabel: string | null): boolean {
  if (!label) return false;
  if (t1KeyDesignates(label, key)) return true;
  if (!registryLabel) return false;
  const l = ` ${normLabel(label)} `;
  const r = normLabel(registryLabel);
  return r.length >= 6 && l.includes(` ${r} `);
}

/** La donnée est-elle une DATE du registre ? */
export const isDateKey = (key: string) => getField(key)?.valueType === 'date';

/** Règle d'ÉCHÉANCE (date dont l'approche est suivie) : sa pertinence dépend du temps. */
export const isDeadlineRule = (rule: ProcessingRule) => rule.dueSoonDays != null && !!rule.fieldKey && isDateKey(rule.fieldKey);

// ══════════════════════════════════════════════════════════════════════════
// CONNAISSANCE PERSISTÉE — faits, faits non intégrés, unités, titre
// ══════════════════════════════════════════════════════════════════════════

export type EvidenceConfidence = 'certain' | 'probable' | 'conflictual';

export interface EvidenceFact {
  value: string | number | boolean | null;
  confidence: EvidenceConfidence | string;
  excerpt?: string | null;
  source: string;
  /** Lot 61 : clé (canonique ou lue) ou libellé qui a désigné la donnée. */
  key?: string | null;
  /** Lot 72 (C1) : libellé LU du fait ou de l'unité (« Date d'édition »…), distinct de la clé. */
  label?: string | null;
}

/**
 * Lot 72 (C2) — signaux de CYCLE DE VIE du contrat lus dans la connaissance
 * persistée (faits actifs, unités source) : jamais l'âge du document.
 *   · renewal   : reconduction / renouvellement prévu (« reconduit
 *                 tacitement », « renouvelable ») — un contrat ancien peut
 *                 rester actif ;
 *   · terminated: fin effective constatée (résiliation effective, contrat
 *                 « a pris fin », dossier soldé, échu sans reconduction) ;
 *   · residual  : obligation qui survit à la fin (restituer, régler un
 *                 solde, rendre le matériel…).
 * Vocabulaire générique du français contractuel, aucune règle propre à un
 * fournisseur ou à un contrat.
 */
export interface LifecycleSignals {
  renewal: boolean;
  /**
   * Lot 76 (C2) : fin effective du contrat PROUVÉE — constat (« a été
   * résilié », « a pris fin », « résiliation effective », « prêt soldé ») sans
   * négation, sans condition, portant sur ce contrat, daté au plus aujourd'hui,
   * lu dans une preuve FIABLE (fait certain, unité couverte). Seul signal qui
   * autorise une décision déterministe « contrat terminé ».
   */
  terminated: boolean;
  residual: boolean;
  signals: string[];
  /**
   * Lot 75I (A) : CLAUSES lues qui portent ces signaux (≤ 5 × 300 caractères,
   * dédoublonnées) — transmises à T4 pour juger une obligation, même quand
   * elles ne sont pas dans l'extrait associé à la date.
   */
  clauses?: string[];
  /** Lot 76 (C2) : non-renouvellement (« non renouvelable », « sans tacite reconduction ») — jamais une fin effective. */
  nonRenewal?: boolean;
  /** Lot 76 (C2) : fins PRÉVUES lues (« prend fin le 31/12/2030 »), ISO. */
  scheduledEnd?: string[];
  /**
   * Lot 76 (C2) : INDICE d'une fin (fin prévue déjà passée, constat lu dans
   * une preuve peu fiable) — jamais une preuve : décision différée, motivée.
   */
  terminationHint?: boolean;
  /** Lot 76 (C2) : résiliation niée (« n'est pas résilié »). */
  negatedTermination?: boolean;
  /** Lot 76 (C6) : CONTENUS (sans libellé) des clauses porteuses — base de la clé de preuve. */
  clauseBodies?: string[];
  /** Lot 76 (C2) : clause de résiliation conditionnelle ou générique (« peut être résilié en cas de… »). */
  conditionalTermination?: boolean;
}

/**
 * Texte lu et sa fiabilité (lot 76, C2) : la fin effective exige une preuve
 * fiable. `body` : CONTENU lu seul (valeur, extrait — sans libellé ni clé),
 * base de la clé de preuve (C6) : un libellé renommé n'est pas un nouveau problème.
 */
export interface LifecycleText { text: string | null | undefined; confidence?: string | null; source?: string | null; body?: string | null }

/** Clauses transmises à T4 au plus (lot 75I). */
export const MAX_OBLIGATION_CLAUSES = 5;

const RE_SANS_RECONDUCTION = /\b(sans|non|pas|pas de|aucune?|ni|jamais)\s+(\w+\s){0,2}(reconduction|reconduit\w*|reconductible|renouvel\w*)/;
const RE_RECONDUCTION = /\b(reconduction|reconduit\w*|reconductible\w*|renouvel\w*|tacite\w*|prorogation|proroge\w*)\b/;
/** Vocabulaire d'une FIN (effective, prévue ou envisagée) — à qualifier. */
const RE_FIN = /\b(resili\w*|pris fin|prend fin|prendra fin|prendre fin|termine\w*|cloture\w*|expire\w*|expirera|arrive\w* a (son )?(terme|echeance)|fin effective|solde\w*|rompu\w*|rupture)\b/;
/** CONSTAT d'une fin survenue (passé composé, état) — Lot 76 (C2). */
const RE_FIN_CONSTATEE = new RegExp([
  String.raw`\b(a ete|ont ete|est|sont|etait|etaient|fut|avait ete|se trouve)\s+(definitivement\s+|bien\s+|effectivement\s+)?(resilie\w*|termine\w*|cloture\w*|expire\w*|rompu\w*)\b`,
  String.raw`\b(a|ont|avait|avaient)\s+(definitivement\s+|bien\s+)?pris fin\b`, String.raw`\bayant pris fin\b`,
  String.raw`\bresiliation (effective|prise en compte|enregistree|confirmee|acceptee)\b`, String.raw`\bfin effective\b`,
  String.raw`\b(integralement|definitivement|totalement)\s+solde\w*\b`, String.raw`\b(pret|credit|dossier|compte|emprunt|contrat)\s+(est\s+|a ete\s+)?solde\w*\b`,
  String.raw`\b(est|a ete)\s+arrive\w* a (son )?terme\b`,
].join('|'));
/** FIN PRÉVUE (présent ou futur) : « prend fin le », « expirera le », « valable jusqu'au ». */
const RE_FIN_PREVUE = /\b(prend fin|prendra fin|expire le|expirera|arrive a echeance|arrivera a (son )?(terme|echeance)|se termine|se terminera|valable jusqu|jusqu au|prendre fin)\b/;
/** Négation portée par la phrase (« n'est pas résilié », « aucune résiliation », « non résilié »). */
const RE_NEGATION = /\bn (est|a|ont|etait|avait|sont|etaient|fut|sera|aura|y a)\b|\b(ne|pas|non|aucune?|jamais|ni|nullement)\b/;
/** Condition, faculté, éventualité (« en cas de », « si », « peut être résilié »). */
const RE_CONDITION = /\b(en cas d\w*|si|sauf|peut|peuvent|pourra|pourront|pourrait|possibilite|faculte|droit de|a defaut|sous reserve|lorsque|des lors|en l absence|eventuel\w*|le cas echeant|modalites|conditions de|preavis)\b/;
/** Portée : la phrase vise un AUTRE contrat (ancien, précédent, remplacé). */
const RE_AUTRE_CONTRAT = /\b(ancien|precedent|remplace\w*|anterieur|annule et remplace)\b/;
const RE_OBLIGATION_RESIDUELLE = /\b(restitu\w*|rendre|retourner|rembourser|regler|reste a payer|reste du|solde restant|solde du|penalite\w*|frais de resiliation|indemnite\w*)\b/;
/**
 * Lot 75I (A) — vocabulaire générique d'une OBLIGATION possible (démarche,
 * préavis, paiement, restitution, reconduction…) : ouvre l'examen par T4
 * d'une échéance connue. Jamais une décision à lui seul.
 */
const RE_OBLIGATION_POSSIBLE = /\b(restitu\w*|rendre|retourn\w*|rembours\w*|regler|payer|paiement\w*|verser|versement\w*|solde\w*|penalit\w*|indemnit\w*|frais de \w+|preavis|resili\w*|denonc\w*|reconduc\w*|reconduit\w*|renouvel\w*|tacite\w*|prorog\w*|remettre|remise des cles|etat des lieux|obligation\w*|tenu de|tenue de|au plus tard)\b/;

const normCycle = (t: string) => ` ${sansAccents(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;

/** Un texte mentionne-t-il une obligation possible ? (pure) */
export const mentionsObligation = (texte: string | null | undefined): boolean =>
  !!texte && RE_OBLIGATION_POSSIBLE.test(normCycle(String(texte)));

/**
 * Lot 76 (C2) — qualification d'une PHRASE qui parle de fin du contrat (pure) :
 * EFFECTIVE (constat sans négation ni condition, daté au plus aujourd'hui),
 * SCHEDULED (fin prévue, avec ses dates), NEGATED, CONDITIONAL, OTHER_CONTRACT
 * ou null (aucune fin évoquée).
 */
export function terminationKindOf(phrase: string, today: string): { kind: 'EFFECTIVE' | 'SCHEDULED' | 'NEGATED' | 'CONDITIONAL' | 'OTHER_CONTRACT' | null; dates: string[] } {
  const t = normCycle(phrase);
  const dates = datesMentionedIn(phrase).map((d) => d.iso);
  if (!RE_FIN.test(t)) return { kind: null, dates };
  // Négation proche du mot de fin (« n'est pas résilié », « non résilié », « aucune résiliation »).
  const m = RE_FIN.exec(t)!;
  const avant = t.slice(Math.max(0, m.index - 40), m.index);
  if (RE_NEGATION.test(avant)) return { kind: 'NEGATED', dates };
  if (RE_AUTRE_CONTRAT.test(t)) return { kind: 'OTHER_CONTRACT', dates };
  if (RE_CONDITION.test(t)) return { kind: 'CONDITIONAL', dates };
  if (RE_FIN_CONSTATEE.test(t) && !RE_FIN_PREVUE.test(t)) {
    return dates.some((d) => d > today) ? { kind: 'SCHEDULED', dates } : { kind: 'EFFECTIVE', dates };
  }
  if (RE_FIN_PREVUE.test(t)) return { kind: 'SCHEDULED', dates };
  // Mot de fin sans constat ni prévision (« Résiliation : … », « solde ») : clause générique.
  return { kind: 'CONDITIONAL', dates };
}

/**
 * Signaux de cycle de vie d'un ensemble de textes lus (pure). Lot 76 (C2) :
 * chaque PHRASE est qualifiée (`terminationKindOf`) — non-renouvellement, fin
 * prévue, résiliation envisagée ou niée ne sont jamais une fin effective ;
 * une fin constatée dans une preuve peu fiable n'est qu'un indice.
 */
export function lifecycleSignalsOf(textes: Array<string | LifecycleText | null | undefined>, today: string = todayParis()): LifecycleSignals {
  const out: LifecycleSignals = {
    renewal: false, terminated: false, residual: false, signals: [], clauses: [], clauseBodies: [],
    nonRenewal: false, scheduledEnd: [], terminationHint: false, negatedTermination: false, conditionalTermination: false,
  };
  const signal = (k: string, brut: string) => { if (out.signals.length < 8) out.signals.push(`${k}:${brut.slice(0, 60)}`); };
  for (const entree of textes) {
    if (!entree) continue;
    const brut = typeof entree === 'string' ? entree : entree.text;
    if (!brut) continue;
    // Texte transmis tel quel (recette, appelant) : fiable ; lu en base : sa confiance.
    const fiable = typeof entree === 'string' || !entree.confidence || entree.confidence === 'certain';
    const t = normCycle(String(brut));
    let porteur = false;
    const sans = RE_SANS_RECONDUCTION.test(t);
    if (sans) { porteur = true; out.nonRenewal = true; signal('nonRenewal', String(brut)); }
    else if (RE_RECONDUCTION.test(t)) { porteur = true; out.renewal = true; signal('renewal', String(brut)); }
    // Phrases, puis propositions (virgule, point-virgule, parenthèse, deux-points suivi d'un espace) :
    // une négation ou une condition ne déborde jamais sur la proposition voisine.
    for (const phrase of String(brut).split(/(?<=[.;!?])\s+|\n+|[,;()]|:\s/)) {
      const q = terminationKindOf(phrase, today);
      if (!q.kind) continue;
      porteur = true;
      if (q.kind === 'EFFECTIVE') {
        if (fiable) { out.terminated = true; signal('terminated', phrase); } else { out.terminationHint = true; signal('terminationHint', phrase); }
      } else if (q.kind === 'SCHEDULED') {
        for (const d of q.dates) if (!out.scheduledEnd!.includes(d)) out.scheduledEnd!.push(d);
        // Fin prévue DÉJÀ passée : indice d'une fin, jamais une preuve.
        if (q.dates.length && q.dates.every((d) => d < today)) { out.terminationHint = true; signal('terminationHint', phrase); }
        else signal('scheduledEnd', phrase);
      } else if (q.kind === 'NEGATED') { out.negatedTermination = true; signal('negatedTermination', phrase); }
      else if (q.kind === 'CONDITIONAL') { out.conditionalTermination = true; signal('conditionalTermination', phrase); }
    }
    if (RE_OBLIGATION_RESIDUELLE.test(t)) { porteur = true; out.residual = true; signal('residual', String(brut)); }
    if (!porteur && RE_OBLIGATION_POSSIBLE.test(t)) porteur = true;
    // Lot 75I (A) : la clause elle-même (texte lu, borné) — preuve transmise à T4.
    const clause = String(brut).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (porteur && clause && out.clauses!.length < MAX_OBLIGATION_CLAUSES && !out.clauses!.includes(clause)) out.clauses!.push(clause);
    const corps = typeof entree === 'string' ? null : entree.body?.replace(/\s+/g, ' ').trim().slice(0, 300) ?? null;
    if (porteur && corps && out.clauseBodies!.length < 20 && !out.clauseBodies!.includes(corps)) out.clauseBodies!.push(corps);
  }
  // Une fin effective prouvée l'emporte sur un indice ; une reconduction lue n'est jamais effacée.
  if (out.terminated) out.terminationHint = false;
  return out;
}

/** Valeur lue, pour le diagnostic (jamais un texte intégral). */
export interface EvidenceObservation {
  source: string;
  key: string | null;
  raw: string | null;
  normalized: string | null;
  status: DateParseStatus | 'TEXT' | 'EMPTY';
}

export interface FieldEvidence {
  hasExtraction: boolean;
  facts: EvidenceFact[];
  sources: Record<string, number>;
  /** Sources ABSENTES (migration non appliquée, couche non construite) : la donnée peut exister ailleurs. */
  missing: string[];
  /**
   * Lot 61 (écart 5) : sources dont la LECTURE a échoué (erreur technique).
   * Jamais confondue avec une donnée absente : aucune fermeture, aucune
   * décision « sans intervention » n'est prise sur une absence de preuve
   * causée par une panne.
   */
  errors: string[];
  observations: EvidenceObservation[];
  /** Indice du titre / nom de fichier (dates) et dates retrouvées dans le contenu. */
  titleHint: { dates: string[]; confirmed: string[]; excerpt: string | null } | null;
  /** Titre lu du document (contexte transmis à T4 pour la pertinence, ≤ 200 caractères). */
  documentTitle?: string | null;
  /** Lot 61 : autres dates FIABLES lues dans le document (faits actifs, hors donnée visée), ≤ 20. */
  contextDates?: Array<{ key: string; iso: string; confidence: string }>;
  /** Lot 61 (écart 4) : empreinte des éléments lus (valeurs, sources, statuts, titre). */
  fingerprint?: string;
  /** Lot 72 (C2) : signaux de cycle de vie du contrat (reconduction, fin effective, obligation résiduelle). */
  lifecycle?: LifecycleSignals;
  /** Lot 76 (C4) : textes lus (avec leur fiabilité) qui fondent `lifecycle` — enrichis des documents du même contrat. */
  lifecycleTexts?: LifecycleText[];
}

const court = (v: unknown, n = 120) => (v === null || v === undefined ? null : String(v).slice(0, n));
const sha = (v: unknown, n = 20) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, n);

/**
 * Normalise une valeur lue pour la donnée `key` : date → ISO avec statut ;
 * autre donnée → texte. `confidence` est plafonnée à `probable` pour une date
 * dont l'ordre jour / mois reste ambigu. Pure.
 */
export function readValue(key: string, raw: unknown, confidence: string, valueType?: 'date' | 'text'): { value: string | null; confidence: string; status: EvidenceObservation['status'] } {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { value: null, confidence, status: 'EMPTY' };
  if ((valueType ?? (isDateKey(key) ? 'date' : 'text')) !== 'date') return { value: String(raw).trim(), confidence, status: 'TEXT' };
  const p = parseDocumentDate(raw);
  if (!p.iso) return { value: null, confidence, status: p.status };
  return { value: p.iso, confidence: p.status === 'ORDER_AMBIGUOUS' && confidence === 'certain' ? 'probable' : confidence, status: p.status };
}

/** Options de lecture (lot 61) : désignation élargie (calculs), type de valeur, indice du titre. */
export interface GatherOptions {
  /** Clés lues (insensibles à la casse) et libellés qui désignent AUSSI la donnée. */
  designation?: { keys: readonly string[]; labelMatch: (label: string) => boolean };
  /** Indice du titre (défaut : pour une date). */
  withTitleHint?: boolean;
  /** Type de valeur (défaut : celui du registre). */
  valueType?: 'date' | 'text';
}

const errMsg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

/**
 * Connaissance T1 PERSISTÉE relative à `key` (lecture seule) : faits actifs,
 * faits non intégrés fiables, unités « libellé : valeur », et — pour une
 * date — indice du titre / nom de fichier vérifié contre le contenu.
 * Jamais le fichier, jamais un nouvel appel T1. Lot 61 : une lecture en
 * échec est consignée dans `errors` (jamais dans `missing`).
 */
export async function gatherFieldEvidence(accountId: number, fileId: number, key: string, opts: GatherOptions = {}): Promise<FieldEvidence> {
  const sources: Record<string, number> = {};
  const missing: string[] = [];
  const errors: string[] = [];
  const facts: EvidenceFact[] = [];
  const observations: EvidenceObservation[] = [];
  const contextDates: NonNullable<FieldEvidence['contextDates']> = [];
  const registryLabel = getField(key)?.label ?? null;
  const designeCles = new Set((opts.designation?.keys ?? []).map((k) => k.toLowerCase()));
  const designe = (canonical: string | null, raw: string | null, label: string | null): boolean => {
    if (t1KeyDesignates(canonical, key) || t1KeyDesignates(raw, key)) return true;
    if (!canonical && t1LabelDesignates(label, key, registryLabel)) return true;
    if (!opts.designation) return false;
    if ((canonical && designeCles.has(canonical.toLowerCase())) || (raw && designeCles.has(raw.toLowerCase()))) return true;
    return !canonical && !!label && opts.designation.labelMatch(label);
  };
  const noter = (source: string, k: string | null, raw: unknown, confidence: string, excerpt?: string | null, label?: string | null) => {
    sources[source] = (sources[source] ?? 0) + 1;
    const r = readValue(key, raw, confidence, opts.valueType);
    if (observations.length < 30) observations.push({ source, key: k, raw: court(raw), normalized: r.value, status: r.status });
    if (r.value !== null) facts.push({ value: r.value, confidence: r.confidence, excerpt: excerpt ?? null, source, key: k, label: label ?? null });
  };
  // Lot 72 (C2) : textes lus (faits, unités) — signaux de cycle de vie du contrat.
  const cycle: LifecycleText[] = [];
  const fin = (titleHint: FieldEvidence['titleHint'], documentTitle: string | null, hasExtraction: boolean): FieldEvidence => ({
    hasExtraction, facts, sources, missing, errors, observations, titleHint, documentTitle, contextDates, lifecycle: lifecycleSignalsOf(cycle.slice(0, 400)),
    lifecycleTexts: cycle.slice(0, 400),
    fingerprint: sha([
      // Écart 4 : la CLAUSE (extrait) compte autant que la valeur — une clause modifiée invalide la décision.
      facts.map((f) => [f.source, f.value, f.confidence, f.excerpt ?? null]).sort(), observations.map((o) => [o.source, o.normalized, o.status]).sort(),
      titleHint, contextDates.map((d) => [d.key, d.iso]).sort(),
      // Lot 72 (C3) : signaux de cycle de vie utilisés par la décision (absents : empreinte inchangée).
      // Lot 76 (C2) : + non-renouvellement, indice de fin, fins prévues (qualification de la fin).
      ...(() => {
        const c = lifecycleSignalsOf(cycle.slice(0, 400));
        return c.renewal || c.terminated || c.residual || c.nonRenewal || c.terminationHint || c.scheduledEnd?.length
          ? [['cycle', c.renewal, c.terminated, c.residual, !!c.nonRenewal, !!c.terminationHint, [...(c.scheduledEnd ?? [])].sort()]] : [];
      })(),
    ]),
  });

  const [ext] = (await pgClient.unsafe(
    `SELECT e.id, e.title, f.original_filename AS filename, to_jsonb(f) ->> 'retained_title' AS retained
       FROM asset_files f LEFT JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
      WHERE f.id = $1 AND f.account_id = $2 ORDER BY e.id DESC NULLS LAST LIMIT 1`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ id: number | null; title: string | null; filename: string | null; retained: string | null }>;
  if (!ext?.id) { missing.push('EXTRACTION'); return fin(null, null, false); }

  const contenu: string[] = [];
  try {
    const rows = (await pgClient.unsafe(
      `SELECT to_jsonb(f) ->> 'canonical_key' AS canonical, f.fact_key AS raw, f.label, f.normalized_value AS norm,
              f.value_text AS text, f.confidence, f.excerpt
         FROM document_facts f WHERE f.file_id = $1 AND f.account_id = $2 AND f.status = 'active'`,
      [fileId, accountId] as never[],
    )) as unknown as Array<{ canonical: string | null; raw: string; label: string | null; norm: string | null; text: string | null; confidence: string; excerpt: string | null }>;
    for (const r of rows) {
      contenu.push(r.text ?? '', r.excerpt ?? '');
      // Lot 76 (C2) : la fiabilité de la preuve accompagne le texte (fin effective : preuve fiable exigée).
      cycle.push({ text: [r.label, r.raw, r.text, r.excerpt].filter(Boolean).join(' : '), confidence: r.confidence, source: 'FACTS',
        body: [...new Set([r.text, r.excerpt].filter(Boolean))].join(' : ') });
      if (!designe(r.canonical, r.raw, r.label)) {
        // Lot 61 : autres dates fiables du document (situer le contrat dans le temps).
        const d = parseDocumentDate(r.norm ?? r.text);
        if (d.iso && (d.status === 'ISO' || d.status === 'NORMALIZED') && contextDates.length < 20) {
          contextDates.push({ key: r.canonical ?? r.raw, iso: d.iso, confidence: r.confidence });
        }
        continue;
      }
      // Valeur normalisée d'abord ; une valeur brute non ISO (fait générique
      // requalifié faute de normalisation) est relue ici.
      const brut = r.norm && readValue(key, r.norm, r.confidence, opts.valueType).value !== null ? r.norm : (r.text ?? r.norm);
      noter('FACTS', r.canonical ?? r.raw, brut, r.confidence, r.excerpt, r.label);
    }
  } catch (e) { errors.push(`FACTS: ${errMsg(e)}`); }

  try {
    const { sourceLayerReady } = await import('@/services/ai/source-analysis/source-units/repository');
    if (!(await sourceLayerReady())) {
      missing.push('SOURCE_UNITS', 'UNRESOLVED_FACTS');
    } else {
      const { RELIABLE_UNRESOLVED_REASONS } = await import('@/services/ai/reconciliation/document-asset/source-unit-provider');
      const nr = (await pgClient.unsafe(
        `SELECT canonical_key AS canonical, raw_key AS raw, raw_value AS value, reason
           FROM document_unresolved_facts WHERE file_id = $1 AND account_id = $2 AND status IN ('UNRESOLVED', 'RETAINED') LIMIT 500`,
        [fileId, accountId] as never[],
      )) as unknown as Array<{ canonical: string | null; raw: string | null; value: string | null; reason: string }>;
      for (const r of nr) {
        if (!r.value || !designe(r.canonical, r.raw, null)) continue;
        // Charge brute : jamais « certaine » (proposition seulement).
        noter('UNRESOLVED_FACTS', r.canonical ?? r.raw, r.value, RELIABLE_UNRESOLVED_REASONS.includes(r.reason) ? 'probable' : 'conflictual');
      }
      const units = (await pgClient.unsafe(
        `SELECT kind, label, value_text AS value, content_text AS text, coverage_status AS coverage
           FROM document_source_units
          WHERE file_id = $1 AND account_id = $2 AND coverage_status IN ('COVERED', 'UNRESOLVED', 'UNCERTAIN')
          ORDER BY ordinal LIMIT 2000`,
        [fileId, accountId] as never[],
      )) as unknown as Array<{ kind: string; label: string | null; value: string | null; text: string | null; coverage: string }>;
      for (const u of units) {
        contenu.push(u.value ?? '', u.text ?? '');
        if (u.label || u.value || u.text) {
          cycle.push({ text: [u.label, u.value, u.text].filter(Boolean).join(' : '), confidence: u.coverage === 'COVERED' ? 'certain' : 'probable', source: 'SOURCE_UNITS',
            body: [u.value, u.text].filter(Boolean).join(' : ') });
        }
        if (!['LABEL_VALUE', 'FORM_FIELD'].includes(u.kind) || !u.label || !u.value) continue;
        if (!t1LabelDesignates(u.label, key, registryLabel) && !(opts.designation && opts.designation.labelMatch(u.label))) continue;
        // Unité lue mais non structurée en fait : proposition, jamais écriture silencieuse.
        noter('SOURCE_UNITS', u.label, u.value, u.coverage === 'UNCERTAIN' ? 'conflictual' : 'probable', null, u.label);
      }
    }
  } catch (e) { errors.push(`SOURCE_UNITS: ${errMsg(e)}`); }

  // ── Indice du titre / nom de fichier (dates seulement) ──────────────────
  let titleHint: FieldEvidence['titleHint'] = null;
  if ((opts.withTitleHint ?? true) && (opts.valueType ?? (isDateKey(key) ? 'date' : 'text')) === 'date') {
    const titres = [ext.title, ext.retained, ext.filename].filter((t): t is string => !!t);
    const dates = [...new Set(titres.flatMap((t) => datesMentionedIn(t).map((d) => d.iso)))];
    if (dates.length) {
      try {
        const [t] = (await pgClient.unsafe(
          `SELECT left(full_text, 200000) AS txt FROM document_extractions WHERE id = $1`, [ext.id] as never[],
        )) as unknown as Array<{ txt: string | null }>;
        contenu.push(t?.txt ?? '');
      } catch (e) { errors.push(`FULL_TEXT: ${errMsg(e)}`); }
      const dansContenu = new Set(contenu.flatMap((c) => datesMentionedIn(c).map((d) => d.iso)));
      const confirmed = dates.filter((d) => dansContenu.has(d));
      titleHint = { dates, confirmed, excerpt: court(titres[0], 200) };
      sources.TITLE_HINT = dates.length;
      for (const iso of confirmed) {
        // Date du titre RETROUVÉE dans le contenu : proposition, jamais certaine.
        if (facts.some((f) => f.value === iso)) continue;
        sources.TITLE_CONFIRMED = (sources.TITLE_CONFIRMED ?? 0) + 1;
        if (observations.length < 30) observations.push({ source: 'TITLE_CONFIRMED', key: null, raw: iso, normalized: iso, status: 'NORMALIZED' });
        facts.push({ value: iso, confidence: 'probable', excerpt: court(titres[0], 120), source: 'TITLE_CONFIRMED', key: null });
      }
      for (const iso of dates.filter((d) => !confirmed.includes(d))) {
        if (observations.length < 30) observations.push({ source: 'TITLE_ONLY', key: null, raw: iso, normalized: null, status: 'NOT_A_DATE' });
      }
    }
  }
  return fin(titleHint, court(ext.title ?? ext.retained ?? ext.filename, 200), true);
}

// ══════════════════════════════════════════════════════════════════════════
// LOT 61 — CONSOLIDATION ENTRE DOCUMENTS D'UN MÊME CONTRAT
// ══════════════════════════════════════════════════════════════════════════

/** Clés (registre) qui identifient un contrat : même référence exacte = même contrat. */
const CONTRACT_REFERENCE_KEYS = ['contractNumber', 'insuranceContractNumber'];

/** Référence normalisée (majuscules, alphanumérique), ≥ 5 caractères, sinon null. Pure. */
export function normalizeContractReference(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length >= 5 && /\d/.test(s) ? s : null;
}

/**
 * Valeur de la donnée `key` déjà retenue sur un AUTRE document du même compte
 * portant EXACTEMENT la même référence de contrat (n° de contrat, de police).
 * Jamais de rapprochement par ressemblance, par bien ou par fournisseur : deux
 * contrats distincts rattachés au même bien ne se mélangent pas.
 *   · une valeur de l'utilisateur, unique → fait certain (écrit, provenance) ;
 *   · sinon (valeur lue ou calculée) → proposition « probable » ;
 *   · plusieurs valeurs distinctes → propositions (arbitrage).
 */
export interface RelatedDocumentEvidence {
  facts: EvidenceFact[];
  related: Array<{ fileId: number; value: string; userValidated: boolean; kind: string | null }>;
  /**
   * Lot 76 (C4) : PREUVES des documents du même contrat (faits actifs, unités
   * source — avec leur fiabilité) : clauses, statuts, résiliations, obligations
   * lus ailleurs que dans les valeurs retenues. Bornées.
   */
  texts?: LifecycleText[];
  /** Lot 76 (C4) : documents du même contrat (référence exacte), vivants. */
  relatedFiles?: number[];
}

/** Textes de preuve lus par document lié, au plus (lot 76, C4). */
const MAX_TEXTES_LIES = 200;

export async function gatherRelatedDocumentValues(accountId: number, fileId: number, key: string): Promise<RelatedDocumentEvidence> {
  const aliases = CONTRACT_REFERENCE_KEYS.flatMap((k) => [k, ...(getField(k)?.aliases ?? [])]);
  const refs = (await pgClient.unsafe(
    `SELECT DISTINCT COALESCE(normalized_value, value_text) AS v FROM document_facts
      WHERE file_id = $1 AND account_id = $2 AND status = 'active'
        AND (to_jsonb(document_facts) ->> 'canonical_key' = ANY($3::text[]) OR fact_key = ANY($3::text[]))`,
    [fileId, accountId, aliases] as never[],
  )) as unknown as Array<{ v: string | null }>;
  const mesRefs = [...new Set(refs.map((r) => normalizeContractReference(r.v)).filter((x): x is string => !!x))];
  if (mesRefs.length === 0) return { facts: [], related: [], texts: [], relatedFiles: [] };
  // Lot 76 (C4) : documents du MÊME contrat (référence exacte, jamais le bien ni le fournisseur), vivants.
  const liesRows = (await pgClient.unsafe(
    `SELECT DISTINCT x.file_id FROM document_facts x
       JOIN asset_files f ON f.id = x.file_id AND f.account_id = x.account_id AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
      WHERE x.account_id = $1 AND x.file_id <> $2 AND x.status = 'active'
        AND (to_jsonb(x) ->> 'canonical_key' = ANY($3::text[]) OR x.fact_key = ANY($3::text[]))
        AND regexp_replace(upper(COALESCE(x.normalized_value, x.value_text, '')), '[^A-Z0-9]', '', 'g') = ANY($4::text[])
      ORDER BY x.file_id LIMIT 20`,
    [accountId, fileId, aliases, mesRefs] as never[],
  )) as unknown as Array<{ file_id: number }>;
  const relatedFiles = liesRows.map((r) => Number(r.file_id));
  const texts: LifecycleText[] = [];
  if (relatedFiles.length) {
    const faits = (await pgClient.unsafe(
      `SELECT file_id, label, fact_key AS raw, value_text AS text, excerpt, confidence FROM document_facts
        WHERE account_id = $1 AND file_id = ANY($2::int[]) AND status = 'active' ORDER BY file_id, id LIMIT ${MAX_TEXTES_LIES}`,
      [accountId, relatedFiles] as never[],
    )) as unknown as Array<{ file_id: number; label: string | null; raw: string | null; text: string | null; excerpt: string | null; confidence: string }>;
    for (const r of faits) {
      texts.push({ text: [r.label, r.raw, r.text, r.excerpt].filter(Boolean).join(' : '), confidence: r.confidence, source: `RELATED_DOCUMENT:${r.file_id}`,
        body: [...new Set([r.text, r.excerpt].filter(Boolean))].join(' : ') });
    }
    const { sourceLayerReady } = await import('@/services/ai/source-analysis/source-units/repository');
    if (await sourceLayerReady()) {
      const units = (await pgClient.unsafe(
        `SELECT file_id, label, value_text AS value, content_text AS text, coverage_status AS coverage FROM document_source_units
          WHERE account_id = $1 AND file_id = ANY($2::int[]) AND coverage_status IN ('COVERED', 'UNRESOLVED', 'UNCERTAIN')
          ORDER BY file_id, ordinal LIMIT ${MAX_TEXTES_LIES}`,
        [accountId, relatedFiles] as never[],
      )) as unknown as Array<{ file_id: number; label: string | null; value: string | null; text: string | null; coverage: string }>;
      for (const u of units) {
        if (u.label || u.value || u.text) {
          texts.push({ text: [u.label, u.value, u.text].filter(Boolean).join(' : '), confidence: u.coverage === 'COVERED' ? 'certain' : 'probable', source: `RELATED_DOCUMENT:${u.file_id}`,
            body: [u.value, u.text].filter(Boolean).join(' : ') });
        }
      }
    }
  }
  const lignes = (await pgClient.unsafe(
    `SELECT DISTINCT v.file_id, v.value_text AS value, v.user_validated AS uv, to_jsonb(v) ->> 'value_kind' AS kind
       FROM document_facts x
       JOIN asset_files f ON f.id = x.file_id AND f.account_id = x.account_id
                         AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
       JOIN document_field_values v ON v.file_id = x.file_id AND v.account_id = x.account_id AND v.field_key = $4
      WHERE x.account_id = $1 AND x.file_id <> $2 AND x.status = 'active'
        AND (to_jsonb(x) ->> 'canonical_key' = ANY($3::text[]) OR x.fact_key = ANY($3::text[]))
        AND regexp_replace(upper(COALESCE(x.normalized_value, x.value_text, '')), '[^A-Z0-9]', '', 'g') = ANY($5::text[])
        AND v.value_text IS NOT NULL
      LIMIT 20`,
    [accountId, fileId, aliases, key, mesRefs] as never[],
  )) as unknown as Array<{ file_id: number; value: string; uv: boolean; kind: string | null }>;
  const related = lignes.map((l) => ({ fileId: Number(l.file_id), value: l.value, userValidated: l.uv === true, kind: l.kind }));
  const valeurs = new Set(related.map((r) => r.value));
  const facts: EvidenceFact[] = related
    // Une valeur CALCULÉE ailleurs n'est jamais reprise comme une donnée lue.
    .filter((r) => r.kind !== 'CALCULATED')
    .map((r) => ({
      value: r.value, source: 'RELATED_DOCUMENTS', key: `document:${r.fileId}`,
      confidence: r.userValidated && valeurs.size === 1 ? 'certain' : 'probable',
      excerpt: `Même contrat que le document ${r.fileId}`,
    }));
  return { facts, related, texts, relatedFiles };
}

/**
 * Lot 76 (C4) — preuves du MÊME contrat intégrées à la connaissance d'un
 * document (pure) : signaux de cycle de vie recalculés sur ses textes ET ceux
 * des documents liés (résiliation, clause, obligation lues ailleurs),
 * empreinte enrichie — une preuve liée ajoutée, retirée ou modifiée change
 * l'empreinte et la décision mémorisée. Sans document lié : inchangée.
 */
export function withRelatedEvidence(ev: FieldEvidence, lies: Pick<RelatedDocumentEvidence, 'texts' | 'relatedFiles'>, today?: string): FieldEvidence {
  const textes = (lies.texts ?? []).filter((t) => !!t.text);
  if (textes.length === 0) return ev;
  const tous = [...(ev.lifecycleTexts ?? []), ...textes];
  return {
    ...ev, lifecycleTexts: tous, lifecycle: lifecycleSignalsOf(tous.slice(0, 600), today),
    sources: { ...ev.sources, RELATED_EVIDENCE: textes.length },
    fingerprint: sha([ev.fingerprint ?? null, 'lies', [...(lies.relatedFiles ?? [])].sort(), textes.map((t) => [t.source, t.text, t.confidence]).sort()]),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// PERTINENCE — DÉCISION CENTRALE « À TRAITER » (lot 61)
// ══════════════════════════════════════════════════════════════════════════

export type Pertinence =
  /** Règle sans échéance : la question vaut par elle-même. */
  | 'NOT_EVALUATED'
  /** (58B, historique) date future ou inconnue. */
  | 'FUTURE_OR_UNDATED'
  /** Échéance passée qui exige encore une intervention identifiée. */
  | 'ACTION_REQUIRED'
  /** Échéance historique, aucune intervention attendue. */
  | 'NO_ACTION_NEEDED'
  /** L'IA s'abstient, refuse ou échoue : décision différée (jamais une carte arbitraire). */
  | 'UNDECIDED'
  /** Lot 61 : date future proche — la donnée compte maintenant. */
  | 'FUTURE_SOON'
  /** Lot 61 : date future lointaine — interpellation différée. */
  | 'FUTURE_DEFERRABLE'
  /** Lot 61 : date inconnue, document historique sans enjeu actuel. */
  | 'UNDATED_HISTORICAL'
  /** Lot 61 : date inconnue, nécessaire à un besoin réel. */
  | 'UNDATED_NEEDED'
  /** Lot 61 : date inconnue, non nécessaire. */
  | 'UNDATED_NOT_NEEDED'
  /** Lot 61 : seule une date du titre (indice, jamais une preuve). */
  | 'TITLE_HINT_ONLY'
  /** Lot 61 : valeurs FIABLES contradictoires — arbitrage justifié, quel que soit l'horizon. */
  | 'CONTRADICTION'
  /** Lot 72 (C2) : fin effective du contrat PROUVÉE (sans reconduction ni obligation résiduelle). */
  | 'CONTRACT_TERMINATED'
  /**
   * Lot 75I (D) : la configuration T4 active ne prend pas en charge
   * l'évaluation structurée (`t4_output_v3`) — situation indécidable : ni
   * question, ni carte, ni fermeture ; réévaluée dès qu'une configuration
   * compatible est activée (référence de configuration changée).
   */
  | 'T4_INCOMPATIBLE'
  /** Lot 75I (A) : échéance CONNUE ancienne, aucun signal d'obligation lu — réévaluation programmée, jamais « sans enjeu » sur l'âge seul. */
  | 'KNOWN_HISTORICAL'
  /**
   * Lot 75I (A) : échéance CONNUE, AUCUNE clause d'obligation dans la
   * connaissance (ni clause, ni extrait de la date, ni titre) — aucune
   * intervention ne peut être établie : pas de carte, pas d'appel IA ; revue
   * dès que la connaissance change. N'est PAS un « règlement » (T6 garde ses rappels).
   */
  | 'NO_OBLIGATION_EVIDENCE';

export type RelevanceOutcome = 'AUTO_RESOLVED' | 'NO_ACTION' | 'DEFER' | 'CREATE_ACTION';
/** Lot 75I (A) : `KNOWN_DEADLINE` — date CONNUE (lue, saisie, écrite ou calculée) : seule l'obligation est évaluée. */
export type RelevanceSituation = 'NOT_DEADLINE' | 'PAST_DEADLINE' | 'FUTURE_DEADLINE' | 'UNDATED' | 'TITLE_ONLY' | 'KNOWN_DEADLINE';

export type { InterventionDecision } from './intervention-check';

/** Version du contrat de décision interne (§5 du ticket « pertinence »). */
export const DECISION_CONTRACT_VERSION = 'atr-decision-v1';

/** Contrat de décision interne — structuré, jamais exposé tel quel à l'utilisateur. */
export interface DecisionContract {
  version: string;
  ruleCode: string;
  dataKey: string;
  fileId: number;
  documentType: string | null;
  /** Nature du problème. */
  problem: 'MISSING_DATA' | 'UNCERTAIN_DATA' | 'DEADLINE_INTERVENTION' | 'DEADLINE_OBLIGATION';
  /** Intervention précise attendue (null si aucune). */
  intervention: { kind: string | null; action: string | null; actBy: string | null } | null;
  consequence: string | null;
  /** Pourquoi la résolution automatique ne suffit pas. */
  autoResolution: string;
  temporal: { situation: RelevanceSituation; today: string; candidates: string[]; nearestFuture: string | null; reevaluateAt: string | null; knownDate?: string | null };
  reliability: { level: 'HIGH' | 'MEDIUM' | 'LOW'; sources: string[]; evidence: string | null };
  decision: RelevanceOutcome | null;
  motive: string;
  /** Lot 63 — seuils « À traiter » utilisés (BO › Configuration IA, défaut lot 61). */
  thresholds?: ToProcessThresholds;
  /** Lot 76 (C3) — état T4, configuration effective et modalité de reprise (null : décision sans T4). */
  t4?: { state: T4State; configRef: string | null; interventionCapable: boolean | null; resume: string | null } | null;
}

export interface PertinenceResult {
  pertinence: Pertinence;
  reason: string;
  /** Appel IA effectué (false si décision mémorisée, déterministe ou sans objet). */
  aiCalled: boolean;
  cached: boolean;
  aiStatus: 'OK' | 'ERROR' | null;
  aiTraceId: string | null;
  signature: string | null;
  /** Lot 61 : décision proposée (null : règle sans échéance, chemin antérieur). */
  outcome: RelevanceOutcome | null;
  situation: RelevanceSituation;
  /** CREATE_ACTION : question sur la donnée, ou carte d'intervention réelle. */
  card: 'DATA_QUESTION' | 'INTERVENTION' | null;
  intervention: InterventionDecision | null;
  /** DEFER : réévaluation prévue (ISO). */
  reevaluateAt: string | null;
  /** Échec technique (IA, lecture) : aucune fermeture ne doit en découler. */
  technicalFailure: boolean;
  /** Lot 75I (D) : contrat T4 actif incompatible — état prudent (aucune carte créée ni fermée), signalé au diagnostic. */
  incompatible?: boolean;
  /**
   * Lot 76 (C3) : état de l'interprétation T4 pour CETTE décision —
   * OK (rendue, ou inutile), INCOMPATIBLE (contrat actif sans t4_output_v3),
   * UNAVAILABLE (configuration illisible, panne du fournisseur), INVALID_OUTPUT
   * (sortie hors contrat). null : décision sans T4.
   */
  t4State?: T4State | null;
  contract: DecisionContract | null;
}

/** Lot 76 (C3) — état de l'interprétation T4 d'une décision. */
export type T4State = 'OK' | 'INCOMPATIBLE' | 'UNAVAILABLE' | 'INVALID_OUTPUT';

/** Modalité de reprise affichée au diagnostic (lot 76, C3). */
export const T4_RESUME: Record<Exclude<T4State, 'OK'>, string> = {
  INCOMPATIBLE: 'réévaluée automatiquement dès l’activation d’une version T4 au contrat t4_output_v3 (BO › Prompts maîtres › T4)',
  UNAVAILABLE: 'nouvelle tentative automatique au balayage suivant (configuration ou fournisseur T4 indisponible)',
  INVALID_OUTPUT: 'nouvelle tentative automatique le lendemain (sortie T4 hors contrat)',
};

export interface PertinenceCandidate { iso: string; source: string; excerpt?: string | null }

type DecideFn = typeof import('@/services/ai/agenda/master/classify-event').decideAgendaEvent;

/** Date du jour à Paris (AAAA-MM-JJ). */
export function todayParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Seuils par DÉFAUT (lot 61). Lot 63 : réglables dans le BO (`relevance-thresholds`,
 * BO › Configuration IA › Réglages › « À traiter ») ; la décision lit les
 * seuils EFFECTIFS portés par la configuration (`T4AssessmentConfig.thresholds`).
 */
export const FUTURE_HORIZON_DAYS = DEFAULT_TO_PROCESS_THRESHOLDS.futureHorizonDays;
export const HISTORICAL_YEARS = DEFAULT_TO_PROCESS_THRESHOLDS.historicalYears;
export const DEFER_UNCERTAIN_DAYS = DEFAULT_TO_PROCESS_THRESHOLDS.deferUncertainDays;
export const DEFER_UNDATED_DAYS = DEFAULT_TO_PROCESS_THRESHOLDS.deferUndatedDays;
export const DEFER_TITLE_ONLY_DAYS = DEFAULT_TO_PROCESS_THRESHOLDS.deferTitleOnlyDays;
/** Reprise après un échec technique (minutes). */
export const RETRY_AFTER_FAILURE_MIN = 60;

const plusJours = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const joursEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const aMinuit = (iso: string) => `${iso}T00:00:00.000Z`;

/**
 * Signature des éléments qui fondent la décision de pertinence (pure).
 * Lot 61 (écart 4) : + situation, empreinte des preuves, configuration IA.
 */
export function pertinenceSignature(key: string, documentType: string | null, cands: PertinenceCandidate[], extra: { situation?: string; evidence?: string | null; config?: string | null } = {}): string {
  const base = [key, documentType ?? '', ...[...new Set(cands.map((c) => `${c.iso}@${c.source}`))].sort(),
    extra.situation ?? '', extra.evidence ?? '', extra.config ?? ''].join('|');
  return createHash('sha1').update(base).digest('hex').slice(0, 20);
}

export { checkInterventionCoherence } from './intervention-check';

/** Configuration T4 effective, pour la décision et la mémoire (écart 4). */
export interface T4AssessmentConfig {
  /**
   * Référence de la configuration (version BO + contrat de sortie, ou défaut
   * du dépôt) ; lot 63 : suivie des seuils « À traiter » MODIFIÉS
   * (`|seuils:h=150`), absente aux valeurs par défaut. Écrite dans `config_ref`.
   */
  ref: string;
  /** Contrat de sortie `t4_output_v3` (ou suivant) : évaluation structurée d'une intervention possible. */
  interventionCapable: boolean;
  /** Lot 63 — référence de la seule configuration IA (sans les seuils) ; défaut : `ref`. */
  aiRef?: string;
  /** Lot 63 — seuils effectifs (BO) ; absents : valeurs par défaut du lot 61. */
  thresholds?: ToProcessThresholds;
  /**
   * Lot 72 (C3) — empreinte du CONTENU de la configuration T4 effective
   * (texte du prompt maître actif, contrat d'exécution, modèles, niveaux de
   * raisonnement, garde-fous du traitement T4 de la révision courante) : une
   * révision SAUVEGARDÉE de la version active change la référence, même à
   * numéro de version égal.
   */
  contentHash?: string | null;
  /** Lot 72 : suivi des révisions disponible (migration 0516) ; faux : seul le numéro de version compte (signalé au BO). */
  revisionTracked?: boolean;
  /**
   * Lot 76 (C3) : configuration T4 ILLISIBLE (panne de lecture) — indisponibilité
   * technique, jamais confondue avec un contrat incompatible.
   */
  unavailable?: boolean;
}

/**
 * Lot 72 (C3) — référence d'une décision DÉTERMINISTE (aucun appel IA) :
 * capacité T4 (contrat structuré ou non) + seuils modifiés. Une révision du
 * texte ou du modèle T4 n'invalide pas une décision que l'IA n'a pas prise
 * (aucune réévaluation sans incidence métier). Pure.
 */
export function deterministicConfigRef(c: Pick<T4AssessmentConfig, 'interventionCapable' | 'thresholds'>): string {
  return composeConfigRef(`det:${c.interventionCapable ? 'structured' : 'legacy'}`, c.thresholds);
}

/** Texte normalisé (espaces) : une remise en forme sans changement n'invalide rien. Pure. */
const texteNormalise = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v ?? null);

/**
 * Empreinte du contenu T4 qui influence une décision (pure) : prompt maître
 * actif (texte normalisé, contrat d'exécution) et réglages du traitement T4
 * (prompt, modèles, raisonnement, plafond de sortie, garde-fous). Les
 * déclencheurs, la cascade T2 et les libellés n'y entrent pas.
 */
export function t4ContentHash(p: { master?: { content?: string | null; execution?: unknown } | null; entry?: Record<string, unknown> | null }): string {
  const e = p.entry ?? {};
  return sha([
    texteNormalise(p.master?.content ?? null), p.master?.execution ?? null,
    texteNormalise(e.prompt ?? null), texteNormalise(e.masterPrompt ?? null), e.primaryModel ?? null, e.fallback1 ?? null, e.fallback2 ?? null,
    e.reasoningPrimary ?? null, e.reasoningFallback1 ?? null, e.reasoningFallback2 ?? null, e.maxOutputTokens ?? null, e.guardrails ?? null,
  ], 16);
}

/**
 * Référence T4 avec empreinte de contenu, rapportée à la BASE LIGNE
 * mémorisée pour ce numéro de version (table 0516) : contenu identique à la
 * base → référence historique (`bo:v3:t4_output_v3`, aucune décision
 * mémorisée invalidée au déploiement) ; contenu modifié depuis →
 * `bo:v3:t4_output_v3#<empreinte>` (décisions IA dépendantes réévaluées).
 * Table absente : référence historique, suivi signalé indisponible.
 */
async function withContentBaseline(base: string, hash: string): Promise<{ ref: string; tracked: boolean }> {
  try {
    const [t] = (await pgClient.unsafe(`SELECT to_regclass('to_process_config_baselines') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    if (!t?.ok) return { ref: base, tracked: false };
    await pgClient.unsafe(
      `INSERT INTO to_process_config_baselines (base_ref, content_hash) VALUES ($1, $2) ON CONFLICT (base_ref) DO NOTHING`, [base, hash] as never[],
    );
    const [r] = (await pgClient.unsafe(`SELECT content_hash FROM to_process_config_baselines WHERE base_ref = $1`, [base] as never[])) as unknown as Array<{ content_hash: string }>;
    return { ref: r?.content_hash === hash ? base : `${base}#${hash.slice(0, 12)}`, tracked: true };
  } catch (e) {
    console.warn('[to-process] base de configuration T4 illisible (numéro de version seul) :', errMsg(e));
    return { ref: base, tracked: false };
  }
}

/** Seuils effectifs d'une configuration (pure). */
export function thresholdsOf(config: Pick<T4AssessmentConfig, 'thresholds'> | null | undefined): ToProcessThresholds {
  return config?.thresholds ?? { ...DEFAULT_TO_PROCESS_THRESHOLDS };
}

/**
 * Part « configuration » de la signature d'une décision IA mémorisée (pure) :
 * configuration IA + délais de réévaluation MODIFIÉS (seuls seuils qui
 * changent une décision rendue par T4). Aux valeurs par défaut : `ref`,
 * comme au lot 61 (aucune décision mémorisée invalidée au déploiement).
 */
export function pertinenceConfigKey(config: T4AssessmentConfig): string {
  const ia = config.aiRef ?? config.ref;
  const d = deferThresholdsRef(config.thresholds);
  return d ? `${ia}|${d}` : ia;
}

/** Éléments documentaires de la décision (preuves déjà lues). */
export interface RelevanceInput {
  accountId: number;
  fileId: number;
  rule: ProcessingRule;
  documentType: string | null;
  candidates: PertinenceCandidate[];
  today: string;
  decide?: DecideFn;
  /** Titre lu du document : contexte de la décision (oriente, ne prouve pas). */
  documentTitle?: string | null;
  /** Autres dates fiables du document. */
  contextDates?: Array<{ key: string; iso: string; confidence?: string }>;
  /** Empreinte des preuves (mémoire de décision). */
  evidenceFingerprint?: string | null;
  config?: T4AssessmentConfig;
  /** Décision mémorisée (dernière évaluation de la règle). */
  remembered?: RememberedDecision | null;
  /** Plusieurs valeurs FIABLES (faits certains) contradictoires : arbitrage justifié. */
  contradictory?: boolean;
  /** Lot 72 (C2) : signaux de cycle de vie lus (reconduction, fin effective, obligation résiduelle). */
  lifecycle?: LifecycleSignals | null;
  /**
   * Lot 76 (I) : la date de fin conditionne-t-elle une démarche ? (`endDateNeed`,
   * document-derivations) — remboursement par échéances sans démarche de fin :
   * la date inconnue n'est demandée à personne.
   */
  endDateNeed?: { repaymentSchedule: boolean; endActions: string[]; notNeeded: boolean } | null;
}

/**
 * Pertinence d'une question sur une donnée d'ÉCHÉANCE — décision centrale
 * AUTO_RESOLVED / NO_ACTION / DEFER / CREATE_ACTION (lot 61). Hybride :
 *
 *   CODE (déterministe, sans IA)
 *     · date future proche (≤ 120 j) → la donnée compte maintenant :
 *       CREATE_ACTION (question / arbitrage) ;
 *     · date future lointaine → DEFER jusqu'à l'approche (aucune carte) ;
 *     · aucune date, document dont toutes les dates fiables ont plus de
 *       5 ans — lot 72 (C2) : l'ANCIENNETÉ n'est qu'un indice, jamais la
 *       preuve qu'aucune obligation ne subsiste :
 *         - fin effective PROUVÉE (résiliation, « a pris fin », échu sans
 *           reconduction), ni reconduction ni obligation résiduelle → NO_ACTION ;
 *         - reconduction / renouvellement lu → l'âge est ignoré : décision
 *           ordinaire (T4 structuré, sinon question) ;
 *         - sinon (ancien, rien de probant) → DEFER sans carte ni appel IA,
 *           réévaluation programmée ;
 *     · date suggérée par le seul TITRE : jamais une preuve — au mieux DEFER
 *       (jamais NO_ACTION sur ce seul indice) ;
 *   IA (T4 CLASSIFY_EVENT, `t4_output_v3`)
 *     · échéance passée, ou date inconnue d'un document récent : T4 dit
 *       quelle intervention CONCRÈTE est attendue (preuve à l'appui, contrôlée
 *       par `checkInterventionCoherence`) : oui → carte décrivant l'action
 *       réelle (jamais une question de date) ou question de date si la date
 *       elle-même est nécessaire ; non → NO_ACTION ; incertain → DEFER ;
 *   VARIANTE PRUDENTE
 *     · échec technique → DEFER court, une carte active n'est PAS fermée ;
 *     · version T4 active antérieure (v1 / v2, sans évaluation structurée) :
 *       échéance passée « action » → DEFER (intervention non identifiée,
 *       signalée au BO) ; date inconnue d'un document récent → question
 *       maintenue (comportement antérieur), sans appel IA inutile.
 */
export async function assessDeadlinePertinence(p: RelevanceInput): Promise<PertinenceResult> {
  const vide = { aiCalled: false, cached: false, aiStatus: null, aiTraceId: null, intervention: null, technicalFailure: false, incompatible: false, t4State: null } as const;
  const config: T4AssessmentConfig = p.config ?? { ref: 'unknown', interventionCapable: false };
  // Lot 63 : seuils réglables (BO), portés par la configuration effective.
  const { futureHorizonDays: FUTURE_HORIZON_DAYS, historicalYears: HISTORICAL_YEARS, deferUncertainDays: DEFER_UNCERTAIN_DAYS,
    deferUndatedDays: DEFER_UNDATED_DAYS, deferTitleOnlyDays: DEFER_TITLE_ONLY_DAYS } = thresholdsOf(config);
  const key = p.rule.fieldKey ?? '';
  const res = (r: Omit<PertinenceResult, 'contract' | keyof typeof vide> & Partial<Pick<PertinenceResult, keyof typeof vide>>): PertinenceResult => {
    const full = { ...vide, ...r } as PertinenceResult;
    return { ...full, contract: decisionContractOf({ ...p, config }, full) };
  };
  if (!isDeadlineRule(p.rule)) {
    return res({ pertinence: 'NOT_EVALUATED', reason: 'rule_without_deadline', signature: null, outcome: null, situation: 'NOT_DEADLINE', card: null, reevaluateAt: null });
  }

  const cands = p.candidates.filter((c) => !!c.iso);
  // Écart 7 : la date du TITRE seul est un indice, jamais une preuve.
  const preuves = cands.filter((c) => c.source !== 'TITLE_ONLY');
  const indicesTitre = cands.filter((c) => c.source === 'TITLE_ONLY');

  // ── Lot 76 (I) : date de fin nécessaire à aucune démarche ─────────────────
  // Remboursement par échéances lu, aucune clause n'attache de démarche à la fin
  // (reconduction, préavis, restitution, option…), aucune date LUE (au plus une
  // estimation calculée) : l'absence de la date ne justifie aucune question —
  // déterministe, sans appel IA. Une date lue (même incertaine) suit la règle commune.
  if (p.endDateNeed?.notNeeded && preuves.every((c) => c.source === 'CALCULATED_PROBABLE')) {
    const sit: RelevanceSituation = preuves.length ? (preuves.some((c) => c.iso >= p.today) ? 'FUTURE_DEADLINE' : 'PAST_DEADLINE') : indicesTitre.length ? 'TITLE_ONLY' : 'UNDATED';
    return res({ pertinence: 'UNDATED_NOT_NEEDED', reason: 'repayment_schedule_without_end_action', signature: null, outcome: 'NO_ACTION', situation: sit, card: null, reevaluateAt: null });
  }

  // ── Date(s) future(s) : déterministe, sans IA ─────────────────────────────
  const futures = preuves.filter((c) => c.iso >= p.today).map((c) => c.iso).sort();
  if (futures.length) {
    // Contradiction entre valeurs fiables : l'arbitrage est justifié maintenant
    // (aucune valeur ne peut être retenue, aucun rappel ne serait juste).
    if (p.contradictory) {
      return res({ pertinence: 'CONTRADICTION', reason: 'contradictory_reliable_values', signature: null, outcome: 'CREATE_ACTION', situation: 'FUTURE_DEADLINE', card: 'DATA_QUESTION', reevaluateAt: null });
    }
    const proche = futures[0];
    const delai = joursEntre(p.today, proche);
    if (delai <= FUTURE_HORIZON_DAYS) {
      return res({ pertinence: 'FUTURE_SOON', reason: `future_within_${FUTURE_HORIZON_DAYS}d`, signature: null, outcome: 'CREATE_ACTION', situation: 'FUTURE_DEADLINE', card: 'DATA_QUESTION', reevaluateAt: null });
    }
    return res({
      pertinence: 'FUTURE_DEFERRABLE', reason: `future_beyond_${FUTURE_HORIZON_DAYS}d`, signature: null, outcome: 'DEFER', situation: 'FUTURE_DEADLINE',
      card: null, reevaluateAt: aMinuit(plusJours(proche, -FUTURE_HORIZON_DAYS)),
    });
  }

  const situation: RelevanceSituation = preuves.length ? 'PAST_DEADLINE' : indicesTitre.length ? 'TITLE_ONLY' : 'UNDATED';

  // ── Date inconnue : document historique (déterministe) ────────────────────
  if (situation !== 'PAST_DEADLINE') {
    // Lot 72 (C2) : seules les dates FIABLES situent le document (certaines,
    // ou sans niveau précisé — recette) ; jamais une date probable ou ambiguë.
    const datesFiables = (p.contextDates ?? []).filter((d) => d.confidence === undefined || d.confidence === 'certain').map((d) => d.iso);
    const seuil = plusJours(p.today, -Math.round(HISTORICAL_YEARS * 365.25));
    const ancien = datesFiables.length > 0 && datesFiables.every((d) => d < seuil);
    const cycle = p.lifecycle ?? null;
    if (ancien && !cycle?.renewal) {
      if (situation !== 'TITLE_ONLY' && cycle?.terminated && !cycle.residual) {
        // Fin effective PROUVÉE par le document (lot 76 : constat fiable, ni nié, ni conditionnel, ni futur) — pas par son âge.
        return res({ pertinence: 'CONTRACT_TERMINATED', reason: 'contract_end_evidenced', signature: null, outcome: 'NO_ACTION', situation, card: null, reevaluateAt: null });
      }
      if (cycle?.terminationHint && !cycle.residual) {
        // Lot 76 (C2) : fin seulement PROBABLE (fin prévue passée, preuve peu fiable) — incertitude non
        // résolue : différée, motivée, réévaluation programmée ; ni question, ni appel IA.
        return res({ pertinence: 'UNDECIDED', reason: 'termination_not_proven:end_hint_only', signature: null, outcome: 'DEFER', situation, card: null,
          reevaluateAt: aMinuit(plusJours(p.today, DEFER_UNDATED_DAYS)) });
      }
      // Ancienneté seule : indice, jamais preuve — ni carte, ni appel IA, réévaluation programmée.
      return res({
        pertinence: 'UNDATED_HISTORICAL', reason: `old_document_age_is_only_a_hint_${HISTORICAL_YEARS}y`, signature: null, outcome: 'DEFER', situation, card: null,
        reevaluateAt: aMinuit(plusJours(p.today, situation === 'TITLE_ONLY' ? DEFER_TITLE_ONLY_DAYS : DEFER_UNDATED_DAYS)),
      });
    }
  }

  // ── Lot 76 (C3) : interprétation structurée T4 impossible ──────────────────
  // Configuration illisible : indisponibilité technique (reprise rapide). Contrat
  // actif incompatible (v1 / v2) : aucune décision fiable de l'IA — ni question
  // par défaut, ni fermeture sur une classification non structurée, ni appel
  // IA inutile ; état prudent signalé, repris à l'activation d'un contrat compatible.
  if (config.unavailable) {
    return res({ pertinence: 'UNDECIDED', reason: 't4_config_unavailable', signature: null, outcome: 'DEFER', situation, card: null,
      reevaluateAt: new Date(Date.now() + RETRY_AFTER_FAILURE_MIN * 60_000).toISOString(), technicalFailure: true, t4State: 'UNAVAILABLE' });
  }
  if (!config.interventionCapable) {
    return situation === 'TITLE_ONLY'
      ? res({ pertinence: 'TITLE_HINT_ONLY', reason: 'title_only_no_t4_assessment', signature: null, outcome: 'DEFER', situation, card: null,
        reevaluateAt: aMinuit(plusJours(p.today, DEFER_TITLE_ONLY_DAYS)), t4State: 'INCOMPATIBLE' })
      : res({ pertinence: 'T4_INCOMPATIBLE', reason: `${situation === 'PAST_DEADLINE' ? 'past' : 'undated'}:t4_contract_incompatible`, signature: null, outcome: 'DEFER',
        situation, card: null, reevaluateAt: null, incompatible: true, t4State: 'INCOMPATIBLE' });
  }

  // Lot 76 (C4 / C6) : CLAUSES lues (document et documents du même contrat) transmises à T4 —
  // une obligation nouvelle ne peut être prouvée que si sa clause est fournie ; elles entrent
  // dans la mémoire (une clause changée réévalue, une clause inchangée ne rappelle pas l'IA).
  const clauses = [...new Set((p.lifecycle?.clauses ?? []).map((c) => c.replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean))].slice(0, MAX_OBLIGATION_CLAUSES);
  // ── Décision mémorisée pour les mêmes éléments ────────────────────────────
  const signature = pertinenceSignature(key, p.documentType, cands, {
    situation, evidence: clauses.length ? `${p.evidenceFingerprint ?? ''}|${sha(clauses, 12)}` : (p.evidenceFingerprint ?? null), config: pertinenceConfigKey(config),
  });
  const m = p.remembered;
  if (m && m.signature === signature && m.outcome && m.pertinence && m.aiStatus !== 'ERROR') {
    return res({
      pertinence: m.pertinence as Pertinence, reason: 'remembered_decision', signature, cached: true, outcome: m.outcome, situation,
      card: m.card ?? (m.outcome === 'CREATE_ACTION' ? 'DATA_QUESTION' : null), intervention: m.intervention ?? null,
      reevaluateAt: m.outcome === 'DEFER' ? (m.reevaluateAt ?? aMinuit(plusJours(p.today, DEFER_UNCERTAIN_DAYS))) : null, t4State: 'OK',
    });
  }

  // ── IA : T4 CLASSIFY_EVENT ────────────────────────────────────────────────
  const def = getField(key);
  const latest = [...(preuves.length ? preuves : indicesTitre)].sort((a, b) => b.iso.localeCompare(a.iso))[0] ?? null;
  // Lot 76 (C3) : seul un contrat structuré atteint cette étape — l'évaluation est toujours demandée.
  const request = {
    contractVersion: DECISION_CONTRACT_VERSION, situation, dataKey: key, question: p.rule.question, today: p.today,
    candidates: cands.slice(0, 10).map((c) => ({ date: c.iso, source: c.source })),
    documentDates: (p.contextDates ?? []).slice(0, 10).map((d) => ({ key: d.key, date: d.iso })),
    documentTitle: p.documentTitle ?? null,
    ...(clauses.length ? { clauses } : {}),
  };
  const description = [
    situation === 'PAST_DEADLINE' ? `Échéance passée (date du jour : ${p.today}).`
      : situation === 'TITLE_ONLY' ? `Date suggérée uniquement par le titre ou le nom du document, non retrouvée dans son contenu (date du jour : ${p.today}).`
        : `Date inconnue (date du jour : ${p.today}).`,
    preuves.length ? `Date lue dans le document (${[...new Set(preuves.map((c) => c.source))].join(', ')}).` : '',
    `Question qui serait posée à l'utilisateur : « ${p.rule.question} »`,
    p.documentTitle ? `Document : « ${p.documentTitle} ».` : '',
  ].filter(Boolean).join(' ');
  const excerpt = (latest?.excerpt ?? p.documentTitle ?? '').slice(0, 500) || undefined;
  const decide: DecideFn = p.decide ?? (await import('@/services/ai/agenda/master/classify-event')).decideAgendaEvent;
  const d = await decide(
    {
      title: def?.label ?? key, description, originType: 'qualified_document', originFieldKey: key,
      nature: 'DEADLINE', businessType: def?.agendaEffect?.businessType ?? null,
    },
    {
      accountId: p.accountId, sourceFileId: p.fileId, date: latest?.iso ?? null, documentType: p.documentType,
      excerpt, recurrenceCandidate: null, toProcessAssessment: request,
    },
  );
  const ia = { aiCalled: true, cached: false, aiTraceId: d.traceId ?? null, signature, t4State: 'OK' as const };
  if (d.outcome === 'technical_failure') {
    // Écart 5 : une panne n'est jamais une décision. Réessai rapide, aucune fermeture.
    const at = new Date(Date.now() + RETRY_AFTER_FAILURE_MIN * 60_000).toISOString();
    return res({ ...ia, aiStatus: 'ERROR', pertinence: 'UNDECIDED', reason: `t4_failure:${d.error?.code ?? 'UNKNOWN'}`, outcome: 'DEFER', situation, card: null, reevaluateAt: at,
      technicalFailure: true, t4State: 'UNAVAILABLE' });
  }
  const motif = (s: string) => s.slice(0, 300);
  // Lot 72 (C2) : contrat reconductible dont l'échéance est inconnue — jamais « sans enjeu » sans preuve de fin.
  const reconductibleSansDate = situation === 'UNDATED' && !!p.lifecycle?.renewal && !p.lifecycle.terminated;
  const iv = checkInterventionCoherence(d.intervention, { requested: true, providedText: [description, excerpt ?? '', p.documentTitle ?? '', ...clauses].join(' ') });

  if (d.contractVersion === 3 && iv) {
    // ── Évaluation structurée (t4_output_v3), contrôlée ────────────────────
    if (iv.needed === 'yes') {
      const donnee = iv.kind === 'PROVIDE_INFORMATION';
      if (iv.timing === 'LATER') {
        const quand = iv.actBy ? plusJours(iv.actBy, -DEFER_UNCERTAIN_DAYS) : plusJours(p.today, DEFER_UNDATED_DAYS);
        return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: situation === 'PAST_DEADLINE' ? 'ACTION_REQUIRED' : 'UNDATED_NEEDED',
          reason: motif(`t4:intervention_later:${iv.justification}`), outcome: 'DEFER', situation, card: null,
          reevaluateAt: aMinuit(quand > p.today ? quand : plusJours(p.today, 1)) });
      }
      if (donnee && iv.dataNeeded === false && reconductibleSansDate) {
        return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'UNDECIDED', reason: motif(`renewable_contract_requires_evidence:${iv.justification}`),
          outcome: 'DEFER', situation, card: null, reevaluateAt: aMinuit(plusJours(p.today, DEFER_UNDATED_DAYS)) });
      }
      if (donnee && iv.dataNeeded === false) {
        return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'UNDATED_NOT_NEEDED', reason: motif(`t4:data_not_needed:${iv.justification}`),
          outcome: situation === 'TITLE_ONLY' ? 'DEFER' : 'NO_ACTION', situation, card: null,
          reevaluateAt: situation === 'TITLE_ONLY' ? aMinuit(plusJours(p.today, DEFER_TITLE_ONLY_DAYS)) : null });
      }
      return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: situation === 'PAST_DEADLINE' ? 'ACTION_REQUIRED' : 'UNDATED_NEEDED',
        reason: motif(`t4:intervention:${iv.kind}:${iv.justification}`), outcome: 'CREATE_ACTION', situation,
        card: donnee ? 'DATA_QUESTION' : 'INTERVENTION', reevaluateAt: null });
    }
    if (iv.needed === 'no' && reconductibleSansDate) {
      // Lot 72 (C2) : contrat RECONDUCTIBLE sans date connue — « aucune
      // intervention » exige une preuve (fin effective) : décision différée.
      return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'UNDECIDED', reason: motif(`renewable_contract_requires_evidence:${iv.justification}`),
        outcome: 'DEFER', situation, card: null, reevaluateAt: aMinuit(plusJours(p.today, DEFER_UNDATED_DAYS)) });
    }
    if (iv.needed === 'no') {
      // Écart 7 : jamais « sans intervention » sur la seule foi du titre.
      return situation === 'TITLE_ONLY'
        ? res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'TITLE_HINT_ONLY', reason: motif(`t4:no_intervention_title_only:${iv.justification}`), outcome: 'DEFER', situation, card: null, reevaluateAt: aMinuit(plusJours(p.today, DEFER_TITLE_ONLY_DAYS)) })
        : res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: situation === 'PAST_DEADLINE' ? 'NO_ACTION_NEEDED' : 'UNDATED_NOT_NEEDED',
          reason: motif(`t4:no_intervention:${iv.justification}`), outcome: 'NO_ACTION', situation, card: null, reevaluateAt: null });
    }
    return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'UNDECIDED', reason: motif(`t4:uncertain:${iv.warnings.join(',') || iv.justification}`),
      outcome: 'DEFER', situation, card: null, reevaluateAt: aMinuit(plusJours(p.today, situation === 'PAST_DEADLINE' ? DEFER_UNCERTAIN_DAYS : DEFER_UNDATED_DAYS)) });
  }

  // Évaluation demandée mais non rendue ou rejetée (sortie hors contrat, bloc
  // vide) : sortie IA INVALIDE — prudence : aucune carte créée, une carte
  // existante n'est PAS retirée (aucun risque supprimé en silence), nouvelle
  // tentative le lendemain. Lot 76 (C3) : distinguée de l'incompatibilité.
  return res({ ...ia, aiStatus: 'ERROR', pertinence: 'UNDECIDED', reason: motif(`t4:assessment_missing:${d.reason}`), outcome: 'DEFER', situation, card: null,
    reevaluateAt: aMinuit(plusJours(p.today, 1)), technicalFailure: true, t4State: 'INVALID_OUTPUT' });
}

// ══════════════════════════════════════════════════════════════════════════
// LOT 75I (A) — OBLIGATION D'UNE ÉCHÉANCE CONNUE
// ══════════════════════════════════════════════════════════════════════════

/** Éléments d'une obligation sur une échéance DÉJÀ CONNUE (lot 75I, A). */
export interface KnownObligationInput extends Omit<RelevanceInput, 'candidates' | 'contradictory'> {
  /** Date connue (lue, saisie, écrite ou calculée) et sa provenance. */
  known: { iso: string; source: string };
  /** Clauses lues pertinentes (restitution, résiliation, reconduction…), où qu'elles soient dans le document. */
  clauses?: string[];
  /** Extrait associé à la date, s'il existe. */
  dateExcerpt?: string | null;
}

/**
 * Lot 75I (A) — une date CONNUE ferme la question de complétion, jamais
 * l'examen des obligations : COMPLÉTION et OBLIGATION sont découplées.
 * Décision AUTO_RESOLVED / NO_ACTION / DEFER / CREATE_ACTION sur la seule
 * question « une intervention réelle, actuelle ou à venir, est-elle établie ? »
 * — jamais une question sur la date :
 *
 *   CODE (déterministe, sans IA)
 *     · échéance à venir au-delà de l'horizon → DEFER jusqu'à l'approche ;
 *     · échéance passée, fin effective PROUVÉE sans reconduction ni
 *       obligation résiduelle → NO_ACTION ;
 *     · échéance passée ancienne, aucune clause d'obligation ni de
 *       reconduction lue → DEFER (l'âge n'est qu'un indice), sans IA ;
 *     · configuration T4 incompatible → DEFER prudent signalé (D) ;
 *     · mêmes preuves, même configuration → décision mémorisée (aucun appel) ;
 *   IA (T4 CLASSIFY_EVENT, `t4_output_v3`) — date connue et CLAUSES
 *     pertinentes transmises (même hors de l'extrait de la date) :
 *     intervention concrète prouvée → carte DOC-INTERVENTION ; aucune → NO_ACTION ;
 *     incertain, plus tard → DEFER ; « fournir la donnée » → NO_ACTION (elle est
 *     connue) ; panne, sortie hors contrat → DEFER technique (aucune fermeture).
 */
export async function assessKnownDeadlineObligation(p: KnownObligationInput): Promise<PertinenceResult> {
  const vide = { aiCalled: false, cached: false, aiStatus: null, aiTraceId: null, intervention: null, technicalFailure: false, incompatible: false, t4State: null } as const;
  const config: T4AssessmentConfig = p.config ?? { ref: 'unknown', interventionCapable: false };
  const { futureHorizonDays: horizon, historicalYears, deferUncertainDays, deferUndatedDays } = thresholdsOf(config);
  const key = p.rule.fieldKey ?? '';
  const cands: PertinenceCandidate[] = [{ iso: p.known.iso, source: p.known.source, excerpt: p.dateExcerpt ?? null }];
  const situation: RelevanceSituation = 'KNOWN_DEADLINE';
  const res = (r: Omit<PertinenceResult, 'contract' | 'situation' | keyof typeof vide> & Partial<Pick<PertinenceResult, keyof typeof vide>>): PertinenceResult => {
    const full = { ...vide, ...r, situation } as PertinenceResult;
    return { ...full, contract: decisionContractOf({ ...p, candidates: cands, config }, full) };
  };
  if (!isDeadlineRule(p.rule)) {
    return { ...vide, pertinence: 'NOT_EVALUATED', reason: 'rule_without_deadline', signature: null, outcome: null, situation: 'NOT_DEADLINE', card: null, reevaluateAt: null, contract: null };
  }
  const cycle = p.lifecycle ?? null;
  const clauses = [...new Set((p.clauses ?? cycle?.clauses ?? []).map((c) => c.replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean))].slice(0, MAX_OBLIGATION_CLAUSES);
  const futur = p.known.iso >= p.today;

  if (futur && joursEntre(p.today, p.known.iso) > horizon) {
    return res({ pertinence: 'FUTURE_DEFERRABLE', reason: `known_future_beyond_${horizon}d`, signature: null, outcome: 'DEFER', card: null,
      reevaluateAt: aMinuit(plusJours(p.known.iso, -horizon)) });
  }
  if (!futur) {
    if (cycle?.terminated && !cycle.residual && !cycle.renewal) {
      return res({ pertinence: 'CONTRACT_TERMINATED', reason: 'known_past:contract_end_evidenced', signature: null, outcome: 'NO_ACTION', card: null, reevaluateAt: null });
    }
    const ancien = p.known.iso < plusJours(p.today, -Math.round(historicalYears * 365.25));
    if (ancien && !cycle?.residual && !cycle?.renewal) {
      return res({ pertinence: 'KNOWN_HISTORICAL', reason: `known_past_older_than_${historicalYears}y_no_obligation_clause`, signature: null, outcome: 'DEFER', card: null,
        reevaluateAt: aMinuit(plusJours(p.today, deferUndatedDays)) });
    }
  }
  // Aucune clause d'obligation lue (ni clause, ni extrait de la date, ni titre) : aucune intervention
  // ne peut être PROUVÉE (la preuve doit être citée) — ni carte, ni appel IA.
  if (clauses.length === 0 && !mentionsObligation(p.dateExcerpt) && !mentionsObligation(p.documentTitle)) {
    return res({ pertinence: 'NO_OBLIGATION_EVIDENCE', reason: 'known:no_obligation_clause', signature: null, outcome: 'NO_ACTION', card: null, reevaluateAt: null });
  }
  if (config.unavailable) {
    // Lot 76 (C3) : configuration T4 illisible — indisponibilité technique, jamais une décision.
    return res({ pertinence: 'UNDECIDED', reason: 'known:t4_config_unavailable', signature: null, outcome: 'DEFER', card: null,
      reevaluateAt: new Date(Date.now() + RETRY_AFTER_FAILURE_MIN * 60_000).toISOString(), technicalFailure: true, t4State: 'UNAVAILABLE' });
  }
  if (!config.interventionCapable) {
    return res({ pertinence: 'T4_INCOMPATIBLE', reason: 'known:t4_contract_incompatible', signature: null, outcome: 'DEFER', card: null, reevaluateAt: null, incompatible: true, t4State: 'INCOMPATIBLE' });
  }

  // ── Décision mémorisée (mêmes preuves, mêmes clauses, même configuration) ──
  const signature = pertinenceSignature(key, p.documentType, cands, {
    situation, evidence: `${p.evidenceFingerprint ?? ''}|${sha(clauses, 12)}`, config: pertinenceConfigKey(config),
  });
  const m = p.remembered;
  if (m && m.signature === signature && m.outcome && m.pertinence && m.aiStatus !== 'ERROR') {
    return res({
      pertinence: m.pertinence as Pertinence, reason: 'remembered_decision', signature, cached: true, outcome: m.outcome,
      card: m.outcome === 'CREATE_ACTION' ? (m.card ?? 'INTERVENTION') : null, intervention: m.intervention ?? null,
      reevaluateAt: m.outcome === 'DEFER' ? (m.reevaluateAt ?? aMinuit(plusJours(p.today, deferUncertainDays))) : null, t4State: 'OK',
    });
  }

  // ── IA : T4 CLASSIFY_EVENT, date connue + clauses ─────────────────────────
  const def = getField(key);
  const request = {
    contractVersion: DECISION_CONTRACT_VERSION, situation: futur ? 'FUTURE_DEADLINE' : 'PAST_DEADLINE', dataKey: key, question: p.rule.question, today: p.today,
    candidates: [{ date: p.known.iso, source: p.known.source }],
    documentDates: (p.contextDates ?? []).slice(0, 10).map((d) => ({ key: d.key, date: d.iso })),
    documentTitle: p.documentTitle ?? null,
    knownDate: p.known.iso, clauses,
  };
  const description = [
    futur ? `Échéance à venir, date CONNUE : ${p.known.iso} (date du jour : ${p.today}).` : `Échéance passée, date CONNUE : ${p.known.iso} (date du jour : ${p.today}).`,
    // Aucun exemple d'obligation ici : la preuve doit venir des clauses lues, jamais de la consigne.
    'La date est déjà connue : ne pas la demander. Dire seulement si une obligation réelle de l’utilisateur reste attendue, d’après les clauses fournies.',
    p.documentTitle ? `Document : « ${p.documentTitle} ».` : '',
  ].filter(Boolean).join(' ');
  const excerpt = [...clauses, p.dateExcerpt ?? ''].filter(Boolean).join(' ').slice(0, 500) || undefined;
  const decide: DecideFn = p.decide ?? (await import('@/services/ai/agenda/master/classify-event')).decideAgendaEvent;
  const d = await decide(
    { title: def?.label ?? key, description, originType: 'qualified_document', originFieldKey: key, nature: 'DEADLINE', businessType: def?.agendaEffect?.businessType ?? null },
    { accountId: p.accountId, sourceFileId: p.fileId, date: p.known.iso, documentType: p.documentType, excerpt, recurrenceCandidate: null, toProcessAssessment: request },
  );
  const ia = { aiCalled: true, cached: false, aiTraceId: d.traceId ?? null, signature, t4State: 'OK' as const };
  if (d.outcome === 'technical_failure') {
    return res({ ...ia, aiStatus: 'ERROR', pertinence: 'UNDECIDED', reason: `t4_failure:${d.error?.code ?? 'UNKNOWN'}`, outcome: 'DEFER', card: null,
      reevaluateAt: new Date(Date.now() + RETRY_AFTER_FAILURE_MIN * 60_000).toISOString(), technicalFailure: true, t4State: 'UNAVAILABLE' });
  }
  const motif = (s: string) => s.slice(0, 300);
  const iv = checkInterventionCoherence(d.intervention, { requested: true, providedText: [description, excerpt ?? '', p.documentTitle ?? '', ...clauses].join(' ') });
  if (d.contractVersion !== 3 || !iv) {
    // Sortie hors contrat : prudence — aucune carte créée, aucune retirée ; nouvelle tentative le lendemain.
    return res({ ...ia, aiStatus: 'ERROR', pertinence: 'UNDECIDED', reason: motif(`t4:assessment_missing:${d.reason}`), outcome: 'DEFER', card: null,
      reevaluateAt: aMinuit(plusJours(p.today, 1)), technicalFailure: true, t4State: 'INVALID_OUTPUT' });
  }
  if (iv.needed === 'yes' && iv.kind === 'PROVIDE_INFORMATION') {
    // La donnée est connue : jamais une question de complétion.
    return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'NO_ACTION_NEEDED', reason: motif(`t4:known_data_not_requested:${iv.justification}`), outcome: 'NO_ACTION', card: null, reevaluateAt: null });
  }
  if (iv.needed === 'yes' && iv.timing === 'LATER') {
    const quand = iv.actBy ? plusJours(iv.actBy, -deferUncertainDays) : plusJours(p.today, deferUndatedDays);
    return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'ACTION_REQUIRED', reason: motif(`t4:obligation_later:${iv.justification}`), outcome: 'DEFER', card: null,
      reevaluateAt: aMinuit(quand > p.today ? quand : plusJours(p.today, 1)) });
  }
  if (iv.needed === 'yes') {
    return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'ACTION_REQUIRED', reason: motif(`t4:obligation:${iv.kind}:${iv.justification}`), outcome: 'CREATE_ACTION', card: 'INTERVENTION', reevaluateAt: null });
  }
  if (iv.needed === 'no' && !futur && cycle?.renewal && !cycle.terminated) {
    // Contrat reconductible : « aucune démarche » après l'échéance exige une preuve de fin.
    return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'UNDECIDED', reason: motif(`renewable_contract_requires_evidence:${iv.justification}`), outcome: 'DEFER', card: null,
      reevaluateAt: aMinuit(plusJours(p.today, deferUndatedDays)) });
  }
  if (iv.needed === 'no') {
    return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'NO_ACTION_NEEDED', reason: motif(`t4:no_obligation:${iv.justification}`), outcome: 'NO_ACTION', card: null, reevaluateAt: null });
  }
  return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'UNDECIDED', reason: motif(`t4:uncertain:${iv.warnings.join(',') || iv.justification}`), outcome: 'DEFER', card: null,
    reevaluateAt: aMinuit(plusJours(p.today, deferUncertainDays)) });
}

/** Contrat de décision interne (§5) — pur. */
export function decisionContractOf(p: Pick<RelevanceInput, 'rule' | 'fileId' | 'documentType' | 'today' | 'candidates'> & { config?: T4AssessmentConfig }, r: Omit<PertinenceResult, 'contract'>): DecisionContract {
  const iso = p.candidates.map((c) => c.iso).sort();
  const future = iso.filter((d) => d >= p.today)[0] ?? null;
  const sources = [...new Set(p.candidates.map((c) => c.source))];
  const fiables = p.candidates.filter((c) => c.source !== 'TITLE_ONLY' && c.source !== 'TITLE_CONFIRMED');
  return {
    version: DECISION_CONTRACT_VERSION, ruleCode: p.rule.code, dataKey: p.rule.fieldKey ?? p.rule.relationKey ?? '', fileId: p.fileId,
    documentType: p.documentType,
    problem: r.card === 'INTERVENTION' ? 'DEADLINE_INTERVENTION' : r.situation === 'KNOWN_DEADLINE' ? 'DEADLINE_OBLIGATION'
      : p.candidates.length ? 'UNCERTAIN_DATA' : 'MISSING_DATA',
    intervention: r.intervention && r.intervention.needed === 'yes' ? { kind: r.intervention.kind, action: r.intervention.action, actBy: r.intervention.actBy } : null,
    consequence: r.intervention?.consequence ?? null,
    autoResolution: r.situation === 'KNOWN_DEADLINE' ? 'date connue : aucune question sur la donnée, seule une obligation réelle justifierait une carte'
      : p.candidates.length ? 'valeurs incertaines ou contradictoires : aucune n’est assez fiable pour être écrite'
        : 'aucune valeur lue, consolidée ni calculable de façon fiable',
    temporal: { situation: r.situation, today: p.today, candidates: iso.slice(0, 10), nearestFuture: future, reevaluateAt: r.reevaluateAt,
      ...(r.situation === 'KNOWN_DEADLINE' ? { knownDate: iso[0] ?? null } : {}) },
    reliability: {
      level: fiables.length && fiables.every((c) => c.source === 'FACTS') ? 'HIGH' : fiables.length ? 'MEDIUM' : 'LOW',
      sources, evidence: r.intervention?.evidence ?? null,
    },
    decision: r.outcome, motive: r.reason,
    // Lot 63 : seuils utilisés pour cette décision (traçage, diagnostic BO).
    thresholds: thresholdsOf(p.config),
    // Lot 76 (C3) : état T4, configuration EFFECTIVE et modalité de reprise.
    t4: r.t4State ? {
      state: r.t4State, configRef: p.config?.ref ?? null, interventionCapable: p.config ? p.config.interventionCapable : null,
      resume: r.t4State === 'OK' ? null : T4_RESUME[r.t4State],
    } : null,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// CONFIGURATION IA ET RÉVISION DE LA CONNAISSANCE (écart 4)
// ══════════════════════════════════════════════════════════════════════════

let configCache: { at: number; value: T4AssessmentConfig } | null = null;

/**
 * Lot 63 — configuration complétée des seuils effectifs (pure) : `aiRef`
 * garde la référence IA, `ref` (écrite dans `config_ref`) y ajoute les seuils
 * modifiés — un réglage changé invalide les décisions NO_ACTION / DEFER
 * mémorisées (`documentsToReevaluate`).
 */
export function withThresholds(c: T4AssessmentConfig, thresholds: ToProcessThresholds): T4AssessmentConfig {
  const aiRef = c.aiRef ?? c.ref;
  return { ...c, aiRef, ref: composeConfigRef(aiRef, thresholds), thresholds };
}

/** Réservé aux tests : configuration T4 imposée (`null` : lecture réelle). */
let configOverride: T4AssessmentConfig | null = null;
export function __setT4AssessmentConfigForTests(c: T4AssessmentConfig | null): void { configOverride = c; configCache = null; }

/**
 * Configuration T4 effective (lue au plus toutes les 60 s) : version ACTIVE
 * du BO (numéro + contrat de sortie), sinon défaut du texte du dépôt. Une
 * activation dans le BO change la référence : les décisions mémorisées sont
 * réévaluées (écart 4, « changement pertinent de configuration IA »).
 */
export async function t4AssessmentConfig(): Promise<T4AssessmentConfig> {
  if (configOverride) return configOverride;
  if (configCache && Date.now() - configCache.at < 60_000) return configCache.value;
  let value: T4AssessmentConfig = { ref: 'unknown', interventionCapable: false };
  // Lot 63 : seuils « À traiter » effectifs (BO > environnement > défaut ; ne lève jamais).
  const thresholds = await loadToProcessThresholds();
  try {
    const [{ loadActiveMasterPrompts }, { getAiEnvironment }, { structuredSpecFor, normalizeExecutionConfig }] = await Promise.all([
      import('@/services/ai/master-prompts/master-prompt-runtime'), import('@/services/ai/config/environment'),
      import('@/services/ai/master-prompts/structured-context'),
    ]);
    const spec = structuredSpecFor('t4_master_v1');
    const active = (await loadActiveMasterPrompts(getAiEnvironment())).get('T4');
    const contrat = active
      ? normalizeExecutionConfig(active.execution ?? null).outputContractVersion
      : spec?.defaults.outputContractVersion ?? null;
    const n = contrat ? Number(/_v(\d+)$/.exec(contrat)?.[1] ?? 0) : 0;
    const base = active ? `bo:v${active.versionNumber}:${contrat ?? 'legacy'}` : `repo:${contrat ?? 'legacy'}`;
    // Lot 72 (C3) : révision sauvegardée de la version active (texte, modèle…) → référence changée.
    let entry: Record<string, unknown> | null = null;
    try {
      const { getRuntimeConfiguration } = await import('@/services/ai/config/config-version.repository');
      entry = ((await getRuntimeConfiguration())?.entries.find((x) => x.treatment === 'T4') ?? null) as Record<string, unknown> | null;
    } catch (e) { console.warn('[to-process] configuration T4 du BO illisible (prompt maître seul) :', errMsg(e)); }
    const contentHash = t4ContentHash({ master: active ? { content: active.content, execution: active.execution ?? null } : null, entry });
    const suivi = await withContentBaseline(base, contentHash);
    value = { ref: suivi.ref, interventionCapable: n >= 3, contentHash, revisionTracked: suivi.tracked };
  } catch (e) {
    console.warn('[to-process] configuration T4 illisible (décision prudente) :', errMsg(e));
    // Lot 76 (C3) : indisponibilité technique — distinguée d'un contrat incompatible.
    value = { ...value, unavailable: true };
  }
  value = withThresholds(value, thresholds);
  configCache = { at: Date.now(), value };
  return value;
}

let couches: { at: number; units: boolean } | null = null;

/** Colonnes d'un fait qui portent une information MÉTIER (lot 72, C3) — jamais ids, horodatages, modèle. */
const FACT_REV_COLS = ['fact_key', 'canonical_key', 'label', 'subject', 'attribute', 'value_text', 'value_number', 'value_unit', 'value_json',
  'normalized_value', 'period_start', 'period_end', 'confidence', 'excerpt', 'provenance', 'evidence_origin'];

/** Clés de référence de contrat (registre + alias), littéral SQL sûr. */
function contractRefKeysSql(): string {
  const cles = [...new Set(CONTRACT_REFERENCE_KEYS.flatMap((k) => [k, ...(getField(k)?.aliases ?? [])]))].filter((k) => /^[A-Za-z0-9_.:-]+$/.test(k));
  return `ARRAY[${cles.map((k) => `'${k}'`).join(', ')}]::text[]`;
}

/**
 * Expression SQL de la RÉVISION de la connaissance d'un document (alias `f`
 * = asset_files) : type, extraction, faits actifs, faits non intégrés,
 * unités source, valeurs retenues (dont celles de l'utilisateur),
 * fournisseur. Elle change à chaque modification T1 / T3 / utilisateur,
 * même sans changement de `asset_files.updated_at` (écart 4).
 *
 * Lot 72 (C3) — empreinte du CONTENU, plus le nombre et l'identifiant
 * maximal : une valeur, une clause, un statut, une confiance, une
 * provenance ou une donnée structurée modifiée SUR UNE LIGNE EXISTANTE
 * change la révision. Couvre aussi la nature des valeurs retenues
 * (`value_kind`) et les DÉPENDANCES : valeurs retenues des autres documents
 * du MÊME contrat (référence exacte, comme `gatherRelatedDocumentValues`) —
 * un nouveau document du contrat réévalue les documents qui en dépendent.
 * Horodatages, identifiants, modèle et version de prompt n'y entrent pas
 * (aucune réévaluation sans incidence métier).
 */
export async function knowledgeRevSql(alias = 'f'): Promise<string> {
  if (!couches || Date.now() - couches.at > 300_000) {
    let units = false;
    try {
      const [r] = (await pgClient.unsafe(
        `SELECT to_regclass('document_source_units') IS NOT NULL AND to_regclass('document_unresolved_facts') IS NOT NULL AS ok`,
      )) as unknown as Array<{ ok: boolean }>;
      units = r?.ok === true;
    } catch { units = false; }
    couches = { at: Date.now(), units };
  }
  const a = alias;
  const faitDe = (t: string) => `concat_ws('~', ${FACT_REV_COLS.map((c) => `to_jsonb(${t}) ->> '${c}'`).join(', ')})`;
  const fait = faitDe('x');
  const refs = contractRefKeysSql();
  const refNorm = (t: string) => `regexp_replace(upper(COALESCE(${t}.normalized_value, ${t}.value_text, '')), '[^A-Z0-9]', '', 'g')`;
  // Documents VIVANTS du même contrat (référence exacte — jamais le bien parent ni le fournisseur).
  const lies = `SELECT x2.file_id FROM document_facts x2
               JOIN asset_files f2 ON f2.id = x2.file_id AND f2.account_id = x2.account_id AND f2.deleted_at IS NULL AND f2.grouped_into_file_id IS NULL
              WHERE x2.account_id = ${a}.account_id AND x2.status = 'active' AND x2.file_id <> ${a}.id
                AND (to_jsonb(x2) ->> 'canonical_key' = ANY(${refs}) OR x2.fact_key = ANY(${refs}))
                AND length(${refNorm('x2')}) >= 5 AND ${refNorm('x2')} ~ '[0-9]'
                AND ${refNorm('x2')} IN (
                  SELECT ${refNorm('x1')} FROM document_facts x1
                   WHERE x1.file_id = ${a}.id AND x1.account_id = ${a}.account_id AND x1.status = 'active'
                     AND (to_jsonb(x1) ->> 'canonical_key' = ANY(${refs}) OR x1.fact_key = ANY(${refs})))`;
  return `md5(concat_ws('|', ${a}.document_type_code,
      -- Lot 75I (C) : CONTENU de l'extraction retenue (titre, type lu, texte intégral lu par l'indice du titre),
      -- plus seulement son identifiant — une extraction corrigée sur place change la révision.
      (SELECT e.id::text || ':' || md5(concat_ws('~', e.title, e.document_type_code, md5(left(COALESCE(e.full_text, ''), 200000))))
         FROM document_extractions e WHERE e.file_id = ${a}.id ORDER BY e.id DESC LIMIT 1),
      (SELECT count(*)::text || ':' || md5(COALESCE(string_agg(md5(${fait}), ',' ORDER BY md5(${fait})), ''))
         FROM document_facts x WHERE x.file_id = ${a}.id AND x.status = 'active'),
      ${couches.units ? `(SELECT count(*)::text || ':' || md5(COALESCE(string_agg(md5(concat_ws('~', u.canonical_key, u.raw_key, u.raw_value, u.reason, u.status)), ',' ORDER BY u.id), ''))
         FROM document_unresolved_facts u WHERE u.file_id = ${a}.id),
      (SELECT count(*)::text || ':' || COALESCE(max(s.updated_at)::text, '') || ':' || md5(COALESCE(string_agg(md5(concat_ws('~', s.kind, s.label, s.value_text, s.coverage_status, s.content_text)), ',' ORDER BY s.ordinal), ''))
         FROM document_source_units s WHERE s.file_id = ${a}.id),` : ''}
      (SELECT string_agg(v.field_key || '=' || COALESCE(v.value_text, '-') || ':' || v.user_validated::text || ':' || COALESCE(to_jsonb(v) ->> 'value_kind', ''), ',' ORDER BY v.field_key)
         FROM document_field_values v WHERE v.file_id = ${a}.id),
      -- Dépendances : évaluées seulement si le document porte une référence de contrat (CASE paresseux).
      -- Lot 76 (C4) : PREUVES des documents du même contrat (faits actifs, unités source, valeurs
      -- retenues avec leur nature) — une clause, un statut, une confiance ou une provenance modifiés
      -- dans un document lié, sans changement de valeur retenue, invalident aussi les décisions.
      CASE WHEN EXISTS (SELECT 1 FROM document_facts x0 WHERE x0.file_id = ${a}.id AND x0.account_id = ${a}.account_id AND x0.status = 'active'
                          AND (to_jsonb(x0) ->> 'canonical_key' = ANY(${refs}) OR x0.fact_key = ANY(${refs})))
      THEN (SELECT md5(COALESCE(string_agg(r.part, ',' ORDER BY r.part), '')) FROM (
          SELECT 'v' || v2.file_id::text || ':' || v2.field_key || '=' || COALESCE(v2.value_text, '-') || ':' || v2.user_validated::text
                 || ':' || COALESCE(to_jsonb(v2) ->> 'value_kind', '') AS part
            FROM document_field_values v2 WHERE v2.account_id = ${a}.account_id AND v2.value_text IS NOT NULL AND v2.file_id IN (${lies})
          UNION ALL
          SELECT 'f' || x3.file_id::text || ':' || md5(${faitDe('x3')})
            FROM document_facts x3 WHERE x3.account_id = ${a}.account_id AND x3.status = 'active' AND x3.file_id IN (${lies})
          ${couches.units ? `UNION ALL
          SELECT 'u' || s3.file_id::text || ':' || md5(concat_ws('~', s3.kind, s3.label, s3.value_text, s3.coverage_status, s3.content_text))
            FROM document_source_units s3 WHERE s3.account_id = ${a}.account_id AND s3.file_id IN (${lies})` : ''}) r) END,
      ${a}.supplier, COALESCE(${a}.user_edited_fields::text, ''),
      -- Lot 75I (C) : titres lus par l'indice du titre (nom du fichier, titre retenu).
      ${a}.original_filename, to_jsonb(${a}) ->> 'retained_title'))`;
}

/**
 * Lot 75I (D) — décisions dont la DERNIÈRE évaluation (par document et règle)
 * attend une configuration T4 compatible (diagnostic BO). Ne lève jamais.
 */
export async function countIncompatibleDecisions(): Promise<number> {
  try {
    if (!(await relevanceColumnsReady())) return 0;
    const [r] = (await pgClient.unsafe(
      `SELECT count(*)::int AS n FROM document_rule_evaluations e
        WHERE e.pertinence = 'T4_INCOMPATIBLE'
          AND e.id = (SELECT max(x.id) FROM document_rule_evaluations x WHERE x.account_id = e.account_id AND x.file_id = e.file_id AND x.rule_code = e.rule_code)`,
    )) as unknown as Array<{ n: number }>;
    return Number(r?.n ?? 0);
  } catch { return 0; }
}

/** Révision actuelle de la connaissance d'un document (même expression que le balayage). */
export async function currentKnowledgeRev(accountId: number, fileId: number): Promise<string | null> {
  const [r] = (await pgClient.unsafe(
    `SELECT ${await knowledgeRevSql('f')} AS rev FROM asset_files f WHERE f.id = $1 AND f.account_id = $2`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ rev: string | null }>;
  return r?.rev ?? null;
}

// ══════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC PAR RÈGLE (migrations 0418, 0444) — jamais bloquant
// ══════════════════════════════════════════════════════════════════════════

export type RuleTrigger = 'ANALYSIS' | 'SWEEP' | 'T3' | 'USER' | 'BACKFILL';
export type RuleDecision = 'WRITE' | 'CREATE' | 'UPDATE' | 'KEEP' | 'CLOSE' | 'NONE' | 'ERROR';
/** Lot 61 : issue centrale tracée (KEEP : carte maintenue sans nouvelle décision ; ERROR : panne). */
export type RuleOutcome = RelevanceOutcome | 'KEEP' | 'ERROR';

export interface RuleEvaluationRecord {
  accountId: number;
  fileId: number;
  ruleCode: string;
  fieldKey: string | null;
  trigger: RuleTrigger;
  runRef?: string | null;
  targetPresent: boolean | null;
  userValidated: boolean | null;
  sources?: Record<string, number>;
  missingSources?: string[];
  observations?: EvidenceObservation[];
  proposals?: Array<{ value: unknown; confidence: number }>;
  titleHint?: FieldEvidence['titleHint'];
  pertinence?: PertinenceResult | null;
  decision: RuleDecision;
  reasonCode: string;
  actionId?: number | null;
  writeVerified?: boolean | null;
  error?: string | null;
  failedStep?: string | null;
  // ── Lot 61 (0444) ─────────────────────────────────────────────────────────
  outcome?: RuleOutcome | null;
  reevaluateAt?: string | null;
  evidenceFingerprint?: string | null;
  knowledgeRev?: string | null;
  configRef?: string | null;
  derivation?: unknown;
  writeResult?: { attempted: boolean; confirmed: boolean | null; status: string; value?: unknown; valueKind?: string | null } | null;
  actionIds?: { created?: number[]; kept?: number[]; closed?: number[]; intervention?: number[] } | null;
  errorKind?: string | null;
  /** Lot 72 (C7) : nature de la décision (calculée par `decisionKindOf` si absente). */
  decisionKind?: DecisionKind | null;
}

/**
 * Lot 72 (C7) — nature d'une décision, pour expliquer une carte créée,
 * conservée, fermée ou NON créée : absence d'information, absence de
 * pertinence, report, résolution automatique, refus de l'utilisateur, échec
 * technique, donnée déjà connue, document non éligible.
 */
export type DecisionKind = 'CARD_CREATED' | 'CARD_KEPT' | 'CARD_CLOSED' | 'AUTO_RESOLVED' | 'NOT_RELEVANT' | 'MISSING_INFO_NOT_REQUIRED'
  | 'DEFERRED' | 'USER_REFUSED' | 'ALREADY_KNOWN' | 'NOT_ELIGIBLE' | 'TECHNICAL_FAILURE';

const MOTIFS_UTILISATEUR = ['USER_DECISION_RESPECTED', 'NOT_APPLICABLE_UNCHANGED', 'USER_DECISION_PROTECTED', 'USER_NOT_APPLICABLE_UNCHANGED', 'USER_CLEARED_VALUE'];
const MOTIFS_CONNUS = ['ALREADY_SATISFIED', 'COMPLETED_ELSEWHERE', 'CALCULATED_UNCHANGED', 'VALUE_CHANGED_SINCE_ARBITRATION'];

/** Nature d'une décision (pure). */
export function decisionKindOf(r: Pick<RuleEvaluationRecord, 'decision' | 'reasonCode' | 'outcome' | 'errorKind' | 'targetPresent'>): DecisionKind {
  if (r.decision === 'ERROR' || r.outcome === 'ERROR' || r.errorKind) return 'TECHNICAL_FAILURE';
  if (r.reasonCode && /TECHNICAL_FAILURE/.test(r.reasonCode)) return 'TECHNICAL_FAILURE';
  if (r.decision === 'WRITE' || r.outcome === 'AUTO_RESOLVED') return 'AUTO_RESOLVED';
  if (MOTIFS_UTILISATEUR.includes(r.reasonCode)) return 'USER_REFUSED';
  if (r.decision === 'CREATE') return 'CARD_CREATED';
  if (r.decision === 'UPDATE' || r.decision === 'KEEP' || r.outcome === 'KEEP') return 'CARD_KEPT';
  if (MOTIFS_CONNUS.includes(r.reasonCode)) return 'ALREADY_KNOWN';
  if (r.outcome === 'DEFER' || r.reasonCode === 'DEFERRED' || r.reasonCode === 'DEFERRED_TO_T3') return 'DEFERRED';
  if (r.decision === 'CLOSE') return 'CARD_CLOSED';
  if (r.reasonCode === 'NOT_ELIGIBLE') return 'NOT_ELIGIBLE';
  if (r.reasonCode === 'NO_ACTION_EXPECTED' && r.targetPresent === false) return 'MISSING_INFO_NOT_REQUIRED';
  return 'NOT_RELEVANT';
}

let tablePresente: boolean | null = null;
let tableVerifieeA = 0;
let colonnes61: boolean | null = null;
let colonnes72: boolean | null = null;

/** Table 0418 présente ? (relue au plus toutes les 5 minutes). Lot 61 : colonnes 0444 aussi. */
export async function ruleEvaluationsReady(): Promise<boolean> {
  if (tablePresente !== null && Date.now() - tableVerifieeA < 300_000) return tablePresente;
  try {
    const [r] = (await pgClient.unsafe(
      `SELECT to_regclass('document_rule_evaluations') IS NOT NULL AS ok,
              EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                       AND table_name = 'document_rule_evaluations' AND column_name = 'outcome') AS l61,
              EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                       AND table_name = 'document_rule_evaluations' AND column_name = 'decision_kind') AS l72`,
    )) as unknown as Array<{ ok: boolean; l61: boolean; l72: boolean }>;
    tablePresente = r?.ok === true;
    colonnes61 = r?.l61 === true;
    colonnes72 = r?.l72 === true;
  } catch { tablePresente = false; colonnes61 = false; colonnes72 = false; }
  tableVerifieeA = Date.now();
  return tablePresente;
}

/** Colonne de nature de décision du lot 72 (0516) présente ? */
export async function decisionKindColumnReady(): Promise<boolean> {
  await ruleEvaluationsReady();
  return colonnes72 === true;
}

/** Colonnes de décision du lot 61 (0444) présentes ? */
export async function relevanceColumnsReady(): Promise<boolean> {
  await ruleEvaluationsReady();
  return colonnes61 === true;
}

/** Décision mémorisée (dernière évaluation décisive d'une règle). */
export interface RememberedDecision {
  signature: string | null;
  pertinence: string | null;
  outcome?: RelevanceOutcome | null;
  card?: PertinenceResult['card'];
  intervention?: InterventionDecision | null;
  reevaluateAt?: string | null;
  aiStatus?: string | null;
}

/**
 * Dernière décision de pertinence mémorisée pour une règle d'un document.
 * Lot 61 (écart 5) : une lecture en échec est LEVÉE — jamais confondue avec
 * « aucune mémoire » (qui relancerait l'IA sans raison).
 */
export async function rememberedPertinence(accountId: number, fileId: number, ruleCode: string): Promise<RememberedDecision | null> {
  if (!(await ruleEvaluationsReady())) return null;
  const l61 = await relevanceColumnsReady();
  const [r] = (await pgClient.unsafe(
    `SELECT pertinence_signature AS signature, pertinence, ai_status AS "aiStatus"
            ${l61 ? `, outcome, decision_contract AS contract, reevaluate_at AS "reevaluateAt"` : ''}
       FROM document_rule_evaluations
      WHERE account_id = $1 AND file_id = $2 AND rule_code = $3 AND pertinence_signature IS NOT NULL
        AND ${l61 ? `outcome IN ('NO_ACTION', 'DEFER', 'CREATE_ACTION')` : `pertinence IN ('NO_ACTION_NEEDED', 'ACTION_REQUIRED')`}
      ORDER BY id DESC LIMIT 1`,
    [accountId, fileId, ruleCode] as never[],
  )) as unknown as Array<{ signature: string | null; pertinence: string | null; aiStatus: string | null; outcome?: RelevanceOutcome | null; contract?: unknown; reevaluateAt?: Date | string | null }>;
  if (!r) return null;
  const c = (typeof r.contract === 'string' ? JSON.parse(r.contract) : r.contract) as (DecisionContract & { card?: PertinenceResult['card']; interventionDetail?: InterventionDecision | null }) | null | undefined;
  return {
    signature: r.signature, pertinence: r.pertinence, aiStatus: r.aiStatus,
    // Ligne 58B (sans issue) : NO_ACTION_NEEDED → NO_ACTION ; ACTION_REQUIRED non réutilisée (non identifiée).
    outcome: r.outcome ?? (r.pertinence === 'NO_ACTION_NEEDED' ? 'NO_ACTION' : null),
    card: c?.card ?? null, intervention: c?.interventionDetail ?? null,
    reevaluateAt: r.reevaluateAt ? new Date(r.reevaluateAt).toISOString() : null,
  };
}

/** Signature d'une évaluation (hors déclencheur, référence d'exécution et date de réévaluation). Pure. */
export function evaluationSignature(r: RuleEvaluationRecord): string {
  return createHash('sha1').update(JSON.stringify([
    r.decision, r.reasonCode, r.targetPresent, r.userValidated, r.sources ?? {}, r.missingSources ?? [],
    (r.observations ?? []).map((o) => [o.source, o.normalized, o.status]), (r.proposals ?? []).map((p) => [p.value, p.confidence]),
    r.titleHint ?? null, r.pertinence?.pertinence ?? null, r.pertinence?.signature ?? null, r.actionId ?? null, r.error ?? null,
    // Lot 61 : issue, intervention, écriture et cartes — tout changement significatif crée une ligne.
    r.outcome ?? null, r.pertinence?.intervention ? [r.pertinence.intervention.needed, r.pertinence.intervention.kind, r.pertinence.intervention.action] : null,
    r.writeResult?.status ?? null, r.actionIds ?? null, r.errorKind ?? null, r.evidenceFingerprint ?? null, r.configRef ?? null,
  ])).digest('hex').slice(0, 24);
}

/** Nombre de passages conservés dans l'APERÇU `passages` d'une évaluation dédupliquée (tous : table 0560). */
const PASSAGES_MAX = 20;

/**
 * Journalise une évaluation. Une réévaluation identique (même signature que
 * la dernière ligne de la règle) ne fait que dater le constat — lot 61
 * (écart 6) : chaque passage est conservé (`passages`, aperçu ≤ 20 :
 * déclencheur, référence, date), la date de réévaluation et la révision de
 * connaissance sont mises à jour. Ne lève jamais : un diagnostic manqué ne
 * bloque pas la décision.
 *
 * Lot 75I (E) : chaque passage est AUSSI conservé durablement
 * (`to_process_evaluation_passages`, sans limite de nombre), dans la MÊME
 * instruction que l'évaluation. Rend l'ERREUR de journalisation (null :
 * tracée) — l'appelant la remonte au diagnostic technique.
 */
export async function recordRuleEvaluation(r: RuleEvaluationRecord, opts: { replay?: boolean; originalAt?: string } = {}): Promise<TraceFailure | null> {
  const echec = async (cause: string): Promise<TraceFailure> => {
    console.error(`[to-process] ${cause}`);
    // Lot 76 (C8) : décision appliquée NON tracée — conservée pour reprise (jamais lors d'une reprise : pas de doublon).
    if (opts.replay) return { cause, retryId: null };
    const { enqueueTraceRetry } = await import('./trace-retries');
    return enqueueTraceRetry({ source: 'DOCUMENT_RULE', accountId: r.accountId, ruleCode: r.ruleCode, targetType: 'DOCUMENT', targetId: r.fileId, payload: r, cause });
  };
  // Lot 76 (C8) : table de diagnostic indisponible — échec VISIBLE, jamais un succès silencieux.
  if (!(await ruleEvaluationsReady())) return echec(`diagnostic de la règle ${r.ruleCode} du document ${r.fileId} non écrit : table document_rule_evaluations indisponible`);
  const l61 = await relevanceColumnsReady();
  const signature = evaluationSignature(r);
  const passage = JSON.stringify([{ at: opts.originalAt ?? new Date().toISOString(), trigger: r.trigger, runRef: r.runRef ?? null, ...(opts.replay ? { replayed: true } : {}) }]);
  const { durablePassagesReady, withDurablePassage } = await import('./admissibility');
  const durable = await durablePassagesReady();
  try {
    const majSql = `UPDATE document_rule_evaluations SET last_seen_at = now(), seen_count = seen_count + 1, trigger_code = $5, run_ref = COALESCE($6, run_ref),
              -- Lot 72 : décision CONFIRMÉE par la version courante du moteur (campagne, valeurs calculées).
              engine_version = '${DOCUMENT_RULE_ENGINE_VERSION}'
              ${l61 ? `, passages = (SELECT COALESCE(jsonb_agg(z.p ORDER BY z.n), '[]'::jsonb) FROM (
                          SELECT p, n FROM jsonb_array_elements($7::jsonb || COALESCE(passages, '[]'::jsonb)) WITH ORDINALITY AS t(p, n)
                           ORDER BY n LIMIT ${PASSAGES_MAX}) z),
                 reevaluate_at = $8::timestamptz, knowledge_rev = COALESCE($9, knowledge_rev)` : ''}
        WHERE id = (SELECT id FROM document_rule_evaluations WHERE account_id = $1 AND file_id = $2 AND rule_code = $3 ORDER BY id DESC LIMIT 1)
          AND signature = $4
        RETURNING id, account_id`;
    const maj = (await pgClient.unsafe(
      durable && l61 ? withDurablePassage(majSql, { source: 'DOCUMENT_RULE', kind: 'REPEATED', triggerParam: '$5', runRefParam: '$6' }) : majSql,
      (l61
        ? [r.accountId, r.fileId, r.ruleCode, signature, r.trigger, r.runRef ?? null, passage, r.reevaluateAt ?? null, r.knowledgeRev ?? null]
        : [r.accountId, r.fileId, r.ruleCode, signature, r.trigger, r.runRef ?? null]) as never[],
    )) as unknown as Array<{ id: number }>;
    if (maj.length) return null;
    const j = (v: unknown) => JSON.stringify(v);
    const p = r.pertinence ?? null;
    const cols = ['account_id', 'file_id', 'rule_code', 'field_key', 'trigger_code', 'run_ref', 'engine_version',
      'target_present', 'user_validated', 'sources', 'missing_sources', 'observations', 'proposals', 'title_hint', 'pertinence', 'pertinence_reason',
      'ai_operation', 'ai_trace_id', 'ai_status', 'decision', 'reason_code', 'action_id', 'write_verified', 'error', 'failed_step', 'signature', 'pertinence_signature'];
    const vals: unknown[] = [
      r.accountId, r.fileId, r.ruleCode, r.fieldKey, r.trigger, r.runRef ?? null, DOCUMENT_RULE_ENGINE_VERSION,
      r.targetPresent, r.userValidated, j(r.sources ?? {}), j(r.missingSources ?? []), j((r.observations ?? []).slice(0, 30)),
      j((r.proposals ?? []).slice(0, 10).map((x) => ({ value: court(x.value), confidence: x.confidence }))), r.titleHint ? j(r.titleHint) : null,
      p?.pertinence ?? null, court(p?.reason, 300), p?.aiCalled ? 't4_classify_event' : null, court(p?.aiTraceId, 80), p?.aiStatus ?? null,
      r.decision, r.reasonCode, r.actionId ?? null, r.writeVerified ?? null, court(r.error, 300), r.failedStep ?? null, signature, p?.signature ?? null,
    ];
    const casts: Record<string, string> = { sources: '::jsonb', missing_sources: '::jsonb', observations: '::jsonb', proposals: '::jsonb', title_hint: '::jsonb' };
    if (l61) {
      const contrat = p?.contract ? { ...p.contract, card: p.card, interventionDetail: p.intervention } : null;
      cols.push('outcome', 'situation', 'decision_contract', 'reevaluate_at', 'evidence_fingerprint', 'knowledge_rev', 'config_ref',
        'derivation', 'write_result', 'action_ids', 'passages', 'error_kind');
      vals.push(r.outcome ?? null, p?.situation ?? null, contrat ? j(contrat) : null, r.reevaluateAt ?? null, r.evidenceFingerprint ?? null,
        r.knowledgeRev ?? null, r.configRef ?? null, r.derivation ? j(r.derivation) : null, r.writeResult ? j(r.writeResult) : null,
        r.actionIds ? j(r.actionIds) : null, passage, r.errorKind ?? null);
      Object.assign(casts, { decision_contract: '::jsonb', reevaluate_at: '::timestamptz', derivation: '::jsonb', write_result: '::jsonb', action_ids: '::jsonb', passages: '::jsonb' });
    }
    if (colonnes72) {
      cols.push('decision_kind');
      vals.push(r.decisionKind ?? decisionKindOf(r));
    }
    const insSql = `INSERT INTO document_rule_evaluations (${cols.join(', ')}) VALUES (${cols.map((c, i) => `$${i + 1}${casts[c] ?? ''}`).join(', ')}) RETURNING id, account_id`;
    await pgClient.unsafe(
      durable && l61 ? withDurablePassage(insSql, { source: 'DOCUMENT_RULE', kind: 'INSERTED', triggerParam: '$5', runRefParam: '$6' }) : insSql,
      vals as never[],
    );
    return null;
  } catch (e) {
    return echec(`diagnostic de la règle ${r.ruleCode} du document ${r.fileId} non écrit : ${(e as Error).message}`.slice(0, 260));
  }
}
