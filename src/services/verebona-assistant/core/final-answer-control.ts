/**
 * Lot 111K — CONTRÔLE FINAL COMMUN question ↔ réponse (ticket « T2 :
 * pertinence des preuves », §3.5 et §3.6). Module PUR et DÉTERMINISTE,
 * appliqué au dernier moment par l'orchestrateur (`finalize`) quel que soit
 * le parcours — réponse déterministe, lecture canonique, faits extraits,
 * lecture documentaire, génération par le modèle — et rejoué par le corpus
 * (`governance/master-corpus/evaluators.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EXISTAIT, ET CE QUI MANQUAIT
 *
 * Existant (conservé, inchangé) : chaque affirmation cite des `sourceIds`
 * fournis (`generation.adapter`), ce qu'elle affirme figure dans la source
 * (`claim-support`, T2-31), fidélité au champ demandé (`requested-facts-guard`,
 * lot 53). Ces contrôles disent « la valeur est dans la source » ; aucun ne
 * dit « elle RÉPOND à la question ». Ce module ajoute, par affirmation :
 *
 *   SETTLEMENT_UNPROVEN   un règlement (« payé », « réglé », « acquitté »)
 *                         affirmé sans source qui le démontre — un coût
 *                         documenté ne prouve pas un règlement (CA-07) ;
 *   PARASITIC_RESERVE     une absence de preuve sur une information NON
 *                         demandée (« aucune preuve de paiement » pour une
 *                         question de montant) : retirée, elle ne limite pas
 *                         la réponse principale (§3.5) ;
 *   VALUE_NATURE_MISMATCH une valeur d'une autre nature que celle demandée
 *                         (un montant pour « quand ? ») ;
 *   OFF_TOPIC             une valeur correcte, présente dans la source, mais
 *                         qui ne porte pas sur la propriété demandée.
 *
 * Aucune affirmation admissible : état d'INSUFFISANCE, jamais une réponse
 * artificiellement étayée. Les règles sémantiques (nature, hors sujet)
 * s'appliquent aux réponses RÉDIGÉES (le modèle peut dériver) et aux
 * demandes d'une information précise ; les réponses produites par le code
 * sont construites depuis des candidats déjà admissibles
 * (`evidence-adequacy`) et ne sont contrôlées que sur le règlement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getField } from '@/services/canonical/registry';
import type { Claim } from '../types/sources';
import { registryLabelRoots, sameRoot, termRoot, type QuestionFocus } from './question-focus';

export type FinalControlReason = 'SETTLEMENT_UNPROVEN' | 'PARASITIC_RESERVE' | 'VALUE_NATURE_MISMATCH' | 'OFF_TOPIC' | 'NO_ADMISSIBLE_CLAIM';
export type FinalControlVerdict = 'PASS' | 'PARTIAL' | 'REJECTED' | 'NOT_APPLICABLE';
/** Parcours de production de la réponse (trace). */
export type ProductionPath = 'deterministic' | 'generation';

export interface FinalControlSource { id: string; type: string; title?: string | null; content?: string | null }

export interface FinalControlResult {
  verdict: FinalControlVerdict;
  path: ProductionPath;
  reasons: FinalControlReason[];
  rejected: Array<{ claimKey: string; reason: FinalControlReason }>;
  kept: Claim[];
  /** Réponse reconstruite (génération) ; `null` : réponse inchangée. */
  answer: string | null;
  /** Propriétés demandées sans affirmation admissible (demande composite). */
  missing: string[];
}

/** Message d'insuffisance du contrôle final (aucune donnée périphérique). */
export const FINAL_CONTROL_INSUFFICIENT_MESSAGE =
  'Je n’ai pas trouvé, dans vos documents et vos fiches, d’information qui réponde précisément à cette question.';

const plat = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’`]/g, "'");
const racines = (s: string) => plat(s).replace(/'/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length >= 2).map(termRoot);

const VERBE_REGLEMENT = '(paye|payee|payes|payees|regle|reglee|regles|reglees|acquitte|acquittee|acquittes|acquittees|verse|versee|verses|versees|solde|soldee)';
/** Affirmation POSITIVE d'un règlement. */
const REGLEMENT_AFFIRME = new RegExp(`\\b(vous avez|j'ai|on a|a ete|ont ete|est|sont|deja|bien|entierement|integralement|totalement)\\s+(?:(?:deja|bien|entierement|integralement|totalement|ete)\\s+)*${VERBE_REGLEMENT}\\b|\\breglement (confirme|effectue|recu|realise)\\b|\\b${VERBE_REGLEMENT} (le|en totalite|integralement)\\b`);
const NEGATION = /\b(ne|n'|pas|aucun|aucune|non|sans|jamais|ni)\b/;
/** Une source qui DÉMONTRE un règlement (preuve, mention de paiement lue dans le document). */
const PREUVE_REGLEMENT = /preuve de paiement|preuve de reglement|montant regle|regle le|paye le|payee le|acquitt|virement|recu de paiement|reglement (effectue|recu|du)|paiement (effectue|recu|valide|du)|payment/;
/** Constat d'ABSENCE (« je n'ai pas trouvé », « aucune preuve », « n'est pas confirmé »). */
const ABSENCE = /\b(je n'ai (pas|aucun|rien)|aucune? (preuve|information|donnee|document|justificatif|mention)|pas de (preuve|justificatif|mention|information)|n'est pas (confirme|demontre|prouve|indique|precise|renseigne|connu)|non (confirme|renseigne|precise|demontre)|ne (prouve|permet|confirme) pas|ne peux pas (confirmer|dire|indiquer))\b/;
const ABSENCE_REGLEMENT = /\b(paiement|reglement|regle|paye|acquitt|verse)\w*/;

const NATURE_MONTANT = /\d\s?(€|eur\b|euros?\b)|\b\d+[,.]\d{2}\b/;
const NATURE_DATE = /\b\d{1,2}(er)? (janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b(19|20)\d{2}\b/;
const NATURE_DUREE = /\b\d+\s?(mois|ans?|annees?|jours?|semaines?|heures?)\b/;

function porteNature(texte: string, n: QuestionFocus['valueNature']): boolean | null {
  const t = plat(texte);
  if (n === 'AMOUNT') return NATURE_MONTANT.test(t);
  if (n === 'DATE') return NATURE_DATE.test(t);
  if (n === 'DURATION') return NATURE_DUREE.test(t);
  return null;
}

/** La demande porte sur UNE information précise (contrôles sémantiques applicables). */
function demandePrecise(f: QuestionFocus): boolean {
  return f.registryKeys.length > 0 || f.valueNature === 'AMOUNT' || f.valueNature === 'DATE' || f.valueNature === 'DURATION' || f.valueNature === 'QUANTITY'
    // « Quelle est la capacité du ballon ? » : une propriété désignée, une valeur attendue.
    || (Boolean(f.headTerm) && !f.yesNo && f.valueNature !== 'STATUS');
}

/** Racines désignant la propriété demandée : tête, sujets UNDERSTAND, libellés du registre. */
function racinesDemandees(f: QuestionFocus): string[] {
  return [...new Set([f.headTerm, ...f.topics, ...f.registryKeys.flatMap(registryLabelRoots)].filter((x): x is string => !!x))];
}

/**
 * Racines admises pour une affirmation : la propriété demandée ; si sa tête
 * (hors registre) n'apparaît dans AUCUNE source citée — question exprimée
 * indirectement (« jusqu'à quand suis-je couvert ? ») — les autres termes de
 * la demande aussi. Une propriété du registre garde sa seule désignation.
 */
function racinesAdmises(f: QuestionFocus, principales: string[], sources: readonly FinalControlSource[]): string[] {
  if (f.registryKeys.length || !principales.length) return principales;
  const presente = sources.some((s) => designe(`${s.title ?? ''} ${s.content ?? ''}`, principales));
  return presente ? principales : [...new Set([...principales, ...f.propertyTerms])];
}

const designe = (texte: string, cibles: readonly string[]) => {
  const r = racines(texte);
  return cibles.some((c) => r.some((x) => sameRoot(x, c)));
};

/** Segments d'une source où figure une valeur de l'affirmation (descripteur proche de la valeur). */
function segmentsPortant(source: FinalControlSource, claimText: string): string[] {
  const nombres = (plat(claimText).match(/\d+(?:[ ,.]\d+)*/g) ?? []).map((n) => n.replace(/[ ]/g, ''));
  if (!nombres.length) return [String(source.content ?? '')];
  return String(source.content ?? '').split(/\n|·|;| — /).filter((seg) => nombres.some((n) => plat(seg).replace(/[ ]/g, '').includes(n)));
}

/**
 * Contrôle final d'une réponse (pur, testé). `rebuild` : la réponse est la
 * suite des affirmations (génération) — elle est alors reconstruite sur les
 * affirmations admissibles.
 */
export function controlFinalAnswer(p: {
  focus: QuestionFocus | null;
  path: ProductionPath;
  answer: string;
  claims: readonly Claim[];
  sources: readonly FinalControlSource[];
  rebuild?: boolean;
  /**
   * Demande de synthèse, comparaison, chronologie, explication : plusieurs
   * informations sont attendues — seul le contrôle du règlement s'applique.
   */
  synthesis?: boolean;
}): FinalControlResult {
  const vide: FinalControlResult = { verdict: 'NOT_APPLICABLE', path: p.path, reasons: [], rejected: [], kept: [...p.claims], answer: null, missing: [] };
  if (!p.claims.length) return vide;
  const parId = new Map(p.sources.map((s) => [s.id, s]));
  const generation = p.path === 'generation';
  const precise = p.focus && !p.synthesis ? demandePrecise(p.focus) : false;
  const cibles = p.focus ? racinesDemandees(p.focus) : [];
  const rejected: FinalControlResult['rejected'] = [];

  const motif = (c: Claim, autresFactuelles: number): FinalControlReason | null => {
    const t = plat(c.text);
    const sources = c.sourceIds.map((id) => parId.get(id)).filter((s): s is FinalControlSource => !!s);
    // 1. Règlement affirmé sans preuve (tous parcours).
    if (affirmsSettlement(c.text)) {
      const prouve = sources.some((s) => s.type === 'asset_field' || PREUVE_REGLEMENT.test(plat(`${s.title ?? ''} ${s.content ?? ''}`)));
      if (!prouve) return 'SETTLEMENT_UNPROVEN';
    }
    if (!p.focus || !generation || !precise) return null;
    // 2. Réserve parasite : absence de preuve sur une information non demandée.
    if (ABSENCE.test(t) && autresFactuelles > 0) {
      if (!p.focus.asksSettlement && ABSENCE_REGLEMENT.test(t)) return 'PARASITIC_RESERVE';
      if (cibles.length && !designe(c.text, cibles)) return 'PARASITIC_RESERVE';
      return null;
    }
    if (ABSENCE.test(t)) return null;
    // 3. Nature de la valeur.
    const nature = porteNature(c.text, p.focus.valueNature);
    if (nature === false && /\d/.test(t)) return 'VALUE_NATURE_MISMATCH';
    // 4. Hors sujet : ni l'affirmation, ni le passage de la source qui porte sa
    // valeur ne désignent la propriété demandée.
    const admises = racinesAdmises(p.focus, cibles, sources);
    if (admises.length && !designe(c.text, admises)) {
      const documentaires = sources.filter((s) => s.type === 'document' || s.type === 'document_extraction');
      // Le passage qui porte la valeur peut venir d'une autre source fournie
      // (total d'un thème qui la désigne) : toutes les sources sont lues.
      if (documentaires.length === sources.length && sources.length > 0
        && !p.sources.some((s) => segmentsPortant(s, c.text).some((seg) => designe(seg, admises)))) return 'OFF_TOPIC';
    }
    return null;
  };

  const factuelles = p.claims.filter((c) => c.sourceIds.length > 0 || /\d/.test(c.text));
  const kept: Claim[] = [];
  for (const c of p.claims) {
    const autres = factuelles.filter((x) => x !== c && !ABSENCE.test(plat(x.text))).length;
    const m = factuelles.includes(c) ? motif(c, autres) : null;
    if (m) rejected.push({ claimKey: c.claimKey, reason: m });
    else kept.push(c);
  }
  // Une réserve parasite n'est retirée que s'il reste une réponse principale.
  const restantes = kept.filter((c) => factuelles.includes(c) && !ABSENCE.test(plat(c.text)));
  if (!restantes.length) {
    for (const r of rejected.filter((x) => x.reason === 'PARASITIC_RESERVE')) {
      const c = p.claims.find((x) => x.claimKey === r.claimKey)!;
      kept.push(c);
    }
    for (let i = rejected.length - 1; i >= 0; i -= 1) if (rejected[i].reason === 'PARASITIC_RESERVE') rejected.splice(i, 1);
  }
  const reasons = [...new Set(rejected.map((r) => r.reason))];
  const admissibles = kept.filter((c) => factuelles.includes(c));
  // Demande composite : propriétés du registre sans affirmation admissible
  // (désignées par les mots non génériques de leur libellé).
  const GENERIQUES = new Set(['date', 'fin', 'debut', 'numero', 'prix', 'montant', 'nom', 'type']);
  const designation = (k: string) => { const r = registryLabelRoots(k); const s = r.filter((x) => !GENERIQUES.has(x)); return s.length ? s : r; };
  const missing = generation && p.focus && p.focus.registryKeys.length > 1
    ? p.focus.registryKeys.filter((k) => !admissibles.some((c) => designe(c.text, designation(k)))).map((k) => getField(k)?.label ?? k)
    : [];
  const substantiels = rejected.filter((r) => r.reason !== 'PARASITIC_RESERVE');
  const texte = p.rebuild ? kept.map((c) => c.text.trim()).join(' ') : null;
  if (!rejected.length && !missing.length) return { ...vide, verdict: 'PASS', kept };
  // Réserve parasite seule : retirée, la réponse reste complète (pas « partielle »).
  if (!substantiels.length && !missing.length) return { verdict: 'PASS', path: p.path, reasons, rejected, kept, answer: texte, missing };
  // Aucune affirmation admissible — ou réponse du code (une affirmation, jamais
  // découpée) dont l'affirmation est rejetée : INSUFFISANCE.
  if (!admissibles.length || (!generation && substantiels.length)) {
    return { verdict: 'REJECTED', path: p.path, reasons: [...reasons, 'NO_ADMISSIBLE_CLAIM'], rejected, kept: [], answer: FINAL_CONTROL_INSUFFICIENT_MESSAGE, missing };
  }
  const manque = missing.length ? ` Information non trouvée dans vos documents : ${missing.map((x) => x.toLowerCase()).join(', ')}.` : '';
  return { verdict: 'PARTIAL', path: p.path, reasons, rejected, kept, answer: texte !== null ? `${texte}${manque}` : manque ? `${p.answer}${manque}` : null, missing };
}

/** Le texte affirme-t-il POSITIVEMENT un règlement (pure, testée) ? */
export function affirmsSettlement(text: string): boolean {
  return plat(text).split(/[.;:]|, (?:mais|car|donc)\b/).some((cl) => REGLEMENT_AFFIRME.test(cl) && !NEGATION.test(cl));
}

const CONFLIT = /\b(valeurs? differentes|contradictoires?|se contredisent|ne concordent pas|en desaccord|divergent(es)?|incompatibles?)\b/;

/** Le texte présente-t-il une contradiction entre sources (pure, testée) ? */
export function answerStatesConflict(text: string): boolean {
  return CONFLIT.test(plat(text));
}

/** Intentions qui attendent PLUSIEURS informations (synthèse, comparaison, chronologie). */
export const SYNTHESIS_INTENTS: ReadonlySet<string> = new Set(['ACCOUNT_SUMMARY', 'ACCOUNT_COMPARISON', 'ACCOUNT_TIMELINE']);
