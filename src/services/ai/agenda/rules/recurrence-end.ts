/**
 * Lot 99D — FIN DE RÉCURRENCE QUALIFIÉE, à partir de l'état contractuel lu
 * dans les données structurées d'un document (faits T1 persistés ou en cours
 * d'analyse). Fonction PURE, déterministe, sans appel IA.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE CLAUSE DE RÉSILIATION N'ARRÊTE JAMAIS, À ELLE SEULE, UNE SÉRIE
 *
 * Avant le lot 99D, `parseRecurrenceFr` posait `ended = true` dès qu'un mot
 * apparaissait (« résiliation », « fin du contrat », « dernière échéance »,
 * « ne sera pas renouvelé ») : « reconduit tacitement, résiliation possible
 * avec deux mois de préavis » supprimait les échéances d'un contrat actif.
 *
 * Désormais la fin est qualifiée par la lecture EXISTANTE du cycle de vie du
 * contrat (`to-process/contract-lifecycle.ts`, lots 72 C2 et 76 C2 — la même
 * qui décide « contrat terminé » dans « À traiter ») : chaque phrase est
 * qualifiée (constat, fin prévue, négation, condition, faculté, autre
 * contrat, fiabilité de la preuve) ; aucune nouvelle liste de mots. Elle est
 * croisée avec les DATES de fin structurées (`contractEndDate`,
 * `leaseEndDate`, faits certains) :
 *
 *   CONFIRMED (borne la série — rien APRÈS la date d'effet) :
 *     TERMINATION_EFFECTIVE  fin constatée (preuve fiable), datée, passée ;
 *     TERMINATION_SCHEDULED  fin constatée à effet futur, datée ;
 *     NO_RENEWAL             sans reconduction / non-renouvellement (preuve
 *                            fiable, aucune reconduction lue), à une date de
 *                            fin établie (fait certain, sinon date unique lue) ;
 *   UNCERTAIN (tracée, JAMAIS appliquée) :
 *     TERMINATION_UNDATED, TERMINATION_UNPROVEN, NO_RENEWAL_UNDATED,
 *     RENEWAL_CONTRADICTION, END_DATE_RENEWAL_UNKNOWN ;
 *   null : contrat actif, reconductible, simple faculté ou condition de
 *     résiliation, préavis, intention ou demande non confirmée, négation.
 *
 * Les clauses de résiliation / préavis ne sont ni supprimées ni ignorées :
 * elles restent dans les faits T1 et dans l'extrait de la récurrence (calcul
 * des dates limites de résiliation : hors de ce lot).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { lifecycleSignalsOf } from '@/services/to-process/contract-lifecycle';
import type { RecurrenceEnd, RecurrenceEndReason, RecurrenceEndSource } from './recurrence';

/** Clés canoniques d'une DATE DE FIN contractuelle (registre). */
export const CONTRACT_END_DATE_KEYS: readonly string[] = ['contractEndDate', 'leaseEndDate'];

/** Texte lu d'un fait (extrait ou valeur textuelle) et sa fiabilité. */
export interface ContractStateText {
  text: string;
  /** Confiance du fait (`certain` seul est une preuve fiable). */
  confidence: string | null;
  fieldKey: string | null;
}

/** Date de fin contractuelle structurée (fait du registre). */
export interface ContractEndDateFact {
  date: string;
  fieldKey: string;
  confidence: string;
  excerpt: string | null;
}

export interface ContractEndEvidence {
  texts: ContractStateText[];
  endDates: ContractEndDateFact[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const court = (s: string | null | undefined) => (s ? s.replace(/\s+/g, ' ').trim().slice(0, 200) : null);
const fiable = (c: string | null) => !c || c === 'certain';
const plusTard = (dates: string[]) => [...dates].filter((d) => ISO.test(d)).sort().at(-1) ?? null;

/**
 * Fin qualifiée d'après l'état contractuel lu (pure). `today` : AAAA-MM-JJ
 * (une fin constatée n'est effective que si sa date est atteinte).
 */
export function resolveRecurrenceEnd(e: ContractEndEvidence, opts: { today: string; sourceFileId?: number | null }): RecurrenceEnd | null {
  const source = (t: { fieldKey: string | null; confidence: string | null; text: string | null }, dateFieldKey?: string | null): RecurrenceEndSource => ({
    kind: 'T1_FACT', fieldKey: t.fieldKey, confidence: t.confidence, excerpt: court(t.text),
    ...(dateFieldKey ? { dateFieldKey } : {}),
    ...(opts.sourceFileId != null ? { sourceFileId: opts.sourceFileId } : {}),
  });
  const fin = (status: RecurrenceEnd['status'], reason: RecurrenceEndReason, effectiveDate: string | null, src: RecurrenceEndSource): RecurrenceEnd =>
    ({ status, reason, effectiveDate, source: src });

  // Textes dédoublonnés, chacun qualifié SÉPARÉMENT (la preuve d'un arrêt est attribuable à un fait).
  const vus = new Set<string>();
  const lus = e.texts
    .filter((t) => t.text && t.text.trim())
    .filter((t) => { const k = t.text.replace(/\s+/g, ' ').trim().toLowerCase(); if (vus.has(k)) return false; vus.add(k); return true; })
    .map((t) => ({ t, s: lifecycleSignalsOf([{ text: t.text, confidence: t.confidence }], opts.today) }));

  // Date de fin STRUCTURÉE : faits certains seulement ; plusieurs valeurs → la plus tardive (aucune occurrence retirée à tort).
  const datesFin = e.endDates.filter((d) => d.confidence === 'certain' && ISO.test(d.date)).sort((a, b) => a.date.localeCompare(b.date));
  const finStructuree = datesFin.at(-1) ?? null;
  const reconduction = lus.filter((x) => x.s.renewal);

  // 1. Fin CONSTATÉE par une preuve fiable (résiliation effective, ou constat à effet futur).
  const constats = lus.filter((x) => x.s.terminated || (x.s.confirmedFutureEndDates?.length ?? 0) > 0);
  if (constats.length) {
    const dates = constats
      .map((x) => ({ x, date: plusTard([...(x.s.terminatedDates ?? []), ...(x.s.confirmedFutureEndDates ?? [])]) }))
      .filter((y): y is { x: typeof y.x; date: string } => !!y.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    const retenue = dates.at(-1);
    if (retenue) {
      return fin('CONFIRMED', retenue.date > opts.today ? 'TERMINATION_SCHEDULED' : 'TERMINATION_EFFECTIVE', retenue.date, source(retenue.x.t));
    }
    // Constat sans date : la date de fin structurée du contrat, si elle est établie.
    if (finStructuree) {
      return fin('CONFIRMED', finStructuree.date > opts.today ? 'TERMINATION_SCHEDULED' : 'TERMINATION_EFFECTIVE', finStructuree.date,
        source(constats[0].t, finStructuree.fieldKey));
    }
    return fin('UNCERTAIN', 'TERMINATION_UNDATED', null, source(constats[0].t));
  }

  // 2. Sans reconduction / non-renouvellement AFFIRMÉ (une proposition conditionnelle
  //    — « ne sera pas renouvelé si… » — n'établit rien).
  const sans = lus.filter((x) => (x.s.nonRenewalClauses ?? []).some((p) => !p.conditional));
  if (sans.length) {
    if (reconduction.length) return fin('UNCERTAIN', 'RENEWAL_CONTRADICTION', finStructuree?.date ?? null, source(sans[0].t));
    const sures = sans.filter((x) => fiable(x.t.confidence));
    if (!sures.length) return fin('UNCERTAIN', 'TERMINATION_UNPROVEN', finStructuree?.date ?? null, source(sans[0].t));
    if (finStructuree) return fin('CONFIRMED', 'NO_RENEWAL', finStructuree.date, source(sures[0].t, finStructuree.fieldKey));
    // À défaut de fait structuré : UNE seule date de fin lue (proposition de non-reconduction, puis fin prévue).
    const clause = [...new Set(sures.flatMap((x) => (x.s.nonRenewalClauses ?? []).filter((p) => !p.conditional).flatMap((p) => p.dates)))];
    const prevues = [...new Set(lus.flatMap((x) => x.s.scheduledEnd ?? []))];
    const unique = clause.length === 1 ? clause[0] : clause.length === 0 && prevues.length === 1 ? prevues[0] : null;
    if (unique) return fin('CONFIRMED', 'NO_RENEWAL', unique, source(sures[0].t));
    return fin('UNCERTAIN', 'NO_RENEWAL_UNDATED', null, source(sures[0].t));
  }

  // 3. Indice d'une fin (preuve peu fiable, fin prévue déjà passée) : jamais une preuve.
  const indice = lus.find((x) => x.s.terminationHint);
  if (indice) return fin('UNCERTAIN', 'TERMINATION_UNPROVEN', finStructuree?.date ?? null, source(indice.t));

  // 4. Date de fin seule, reconduction inconnue : peut être la fin de la période en cours.
  if (finStructuree && !reconduction.length) {
    return fin('UNCERTAIN', 'END_DATE_RENEWAL_UNKNOWN', finStructuree.date,
      source({ fieldKey: finStructuree.fieldKey, confidence: finStructuree.confidence, text: finStructuree.excerpt }));
  }
  // Contrat actif ou reconductible, simple faculté / condition / préavis, intention, négation : aucune fin.
  return null;
}

/**
 * Lot 99D — DÉTECTEUR de l'empreinte de l'ancienne règle (avant 99D), pour la
 * reprise des données seulement (contrôle COH-AGENDA-RECURRENCE-END) : vrai si
 * l'ancien `parseRecurrenceFr` aurait posé `ended = true` sur ce texte.
 * JAMAIS une décision de fin.
 */
export function legacyKeywordEndFlag(text: string | null | undefined): boolean {
  if (!text) return false;
  const m = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");
  return /\b(resili\w*|derniere echeance|fin du contrat|ne sera pas renouvel\w*)\b/.test(m);
}
