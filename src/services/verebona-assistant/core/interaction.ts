/**
 * Nature du message comprise par T2 — lot 54E (#419 §15, écarts 3 à 5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T2 DIT CE QUE L'UTILISATEUR FAIT ; LE SERVEUR DÉCIDE CE QUI EST POSSIBLE
 *
 * « La date de fin de LLD de la Cupra est le 21/05/2027 » n'est pas une
 * question : l'utilisateur APPORTE une information. Aucun verbe de commande
 * (« mets », « modifie »…) n'est exigé, et aucune règle « phrase affirmative
 * = mise à jour » n'est codée : c'est T2 qui lit la nature du message
 * (`interactionMode`) et le rôle de chaque information apportée
 * (`suppliedFacts[].role`).
 *
 *   UPDATE_PROPOSAL / ACTION_REQUEST  → proposition : le SERVEUR résout la
 *       cible, la capacité d'écriture, les droits, la valeur actuelle, puis
 *       prépare un plan PENDING_CONFIRMATION (CommandPlan existant) —
 *       JAMAIS d'écriture avant confirmation explicite ;
 *   AMBIGUOUS + information à enregistrer → même proposition (la
 *       confirmation EST la question) ;
 *   CONTEXT_ONLY → accusé de lecture, rien n'est enregistré ;
 *   QUERY / MIXED → la question suit son cours ; une information de
 *       contexte sert à comprendre, jamais à écrire.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { RouteInteraction, SuppliedFact } from '../types/contracts';
import { getField } from '@/services/canonical/registry';
import { parseDateFr } from '../commands/parser';
import { remainingCountUnit, remainingPeriods, type PeriodUnit } from './semantic-scope';

export type InteractionHandling = 'proposal' | 'context_only' | 'context_calculation' | null;

/** Informations à proposer à l'enregistrement (pure, testée). */
export function updateFactsOf(i: RouteInteraction | undefined | null): SuppliedFact[] {
  if (!i) return [];
  const avecValeur = i.suppliedFacts.filter((f) => (f.normalizedValue ?? f.value ?? '').trim() !== '');
  if (i.mode === 'UPDATE_PROPOSAL' || i.mode === 'ACTION_REQUEST') return avecValeur.filter((f) => f.role !== 'context');
  if (i.mode === 'AMBIGUOUS') return avecValeur.filter((f) => f.role === 'update');
  return [];
}

/**
 * Informations de CONTEXTE (pure, testée) — lot 59 (#419 R07) : rôle
 * `context` (ou toute information d'un message MIXED / QUERY) portant une
 * valeur. Elles servent à répondre à CETTE demande, jamais à écrire.
 */
export function contextFactsOf(i: RouteInteraction | undefined | null): SuppliedFact[] {
  if (!i || i.mode === 'CONTEXT_ONLY') return [];
  const avecValeur = i.suppliedFacts.filter((f) => (f.normalizedValue ?? f.value ?? '').trim() !== '');
  if (i.mode === 'MIXED' || i.mode === 'QUERY') return avecValeur.filter((f) => f.role !== 'update');
  return avecValeur.filter((f) => f.role === 'context');
}

/**
 * Traitement de la nature du message (pure, testée) ; `null` : la question
 * suit son cours. Lot 59 (#419 R07) : `context_calculation` — question de
 * décompte (« combien de mensualités me reste-t-il ? ») accompagnée d'une
 * information de contexte : le SERVEUR calcule avec elle, sans l'enregistrer.
 */
export function interactionHandling(i: RouteInteraction | undefined | null, message?: string): InteractionHandling {
  if (!i) return null;
  if (updateFactsOf(i).length) return 'proposal';
  if (i.mode === 'CONTEXT_ONLY') return 'context_only';
  if (message != null && contextFactsOf(i).length && remainingCountUnit(message)) return 'context_calculation';
  return null;
}

/** Information de contexte RELUE et typée par le serveur (jamais crue sur parole). */
export interface ValidatedContextFact {
  fieldKey: string;
  label: string;
  /** Date de fin (registre : échéance / fin) en AAAA-MM-JJ. */
  endDate: string | null;
  value: string;
}

/**
 * Validation SERVEUR des informations de contexte (pure, testée) : clé du
 * registre connue, valeur relue dans le message (le modèle ne peut pas
 * introduire une valeur que l'utilisateur n'a pas donnée), date réelle.
 */
export function validateContextFacts(facts: readonly SuppliedFact[], message: string, today: string): { valid: ValidatedContextFact[]; ignored: number } {
  const valid: ValidatedContextFact[] = [];
  let ignored = 0;
  for (const f of facts) {
    const def = f.fieldKey ? getField(f.fieldKey) : null;
    const brut = (f.normalizedValue ?? f.value ?? '').trim();
    if (!def || !brut) { ignored += 1; continue; }
    if (def.valueType === 'date') {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(brut) && !Number.isNaN(Date.parse(`${brut}T00:00:00Z`))
        && new Date(`${brut}T00:00:00Z`).toISOString().slice(0, 10) === brut
        && (message.includes(brut) || parseDateFr(message, today) === brut);
      if (!ok) { ignored += 1; continue; }
      valid.push({ fieldKey: def.key, label: def.label, value: brut, endDate: def.agendaEffect?.nature === 'DEADLINE' ? brut : null });
      continue;
    }
    if (!message.toLowerCase().includes(brut.toLowerCase())) { ignored += 1; continue; }
    valid.push({ fieldKey: def.key, label: def.label, value: brut, endDate: null });
  }
  return { valid, ignored };
}

const UNITES: Record<PeriodUnit, [string, string]> = { month: ['mois', 'mois'], quarter: ['trimestre', 'trimestres'], year: ['année', 'années'], week: ['semaine', 'semaines'] };
const frDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/**
 * Réponse SERVEUR d'un décompte avec information de contexte (pure, testée)
 * — lot 59 (#419 R07). Aucune donnée n'est enregistrée ; la contradiction
 * avec une donnée du compte est SIGNALÉE (jamais tranchée) ; sans date de
 * fin fiable, ce qui manque est dit (aucun calcul).
 */
export function contextCalculationAnswer(p: {
  message: string; today: string; facts: readonly ValidatedContextFact[];
  /** Valeurs ENREGISTRÉES de mêmes clés du registre sur la cible (lecture serveur). */
  stored: ReadonlyArray<{ fieldKey: string; value: string; display: string }>;
  assetName: string | null;
}): { text: string; calculation: string; contradiction: boolean; used: string[] } {
  const unit = remainingCountUnit(p.message) ?? 'month';
  const fin = p.facts.find((f) => f.endDate);
  const pour = p.assetName ? ` pour ${p.assetName}` : '';
  if (!fin) {
    return {
      text: `Pour calculer ce qui reste${pour}, il me manque une date de fin fiable : je n’ai pas pu relire de date de fin dans votre message. Indiquez-la, par exemple « se termine le 21/05/2027 ». Rien n’a été modifié.`,
      calculation: 'remaining_periods:missing', contradiction: false, used: [],
    };
  }
  const enregistre = p.stored.find((s) => s.fieldKey === fin.fieldKey && s.value.slice(0, 10) !== fin.endDate);
  if (enregistre) {
    return {
      text: `Votre message indique une fin le ${frDate(fin.endDate!)}, mais vos données indiquent « ${fin.label} »${pour} : ${enregistre.display}. `
        + 'Je ne tranche pas entre les deux : précisez la bonne date (et corrigez la fiche si besoin). Rien n’a été modifié.',
      calculation: 'remaining_periods:contradiction', contradiction: true, used: [fin.fieldKey],
    };
  }
  const n = remainingPeriods(p.today, fin.endDate!, unit);
  const [un, plusieurs] = UNITES[unit];
  const texte = n === 0
    ? `D’après la date que vous indiquez (${frDate(fin.endDate!)}), il ne reste aucun ${un} entier à courir${pour}.`
    : `D’après la date que vous indiquez (${frDate(fin.endDate!)}), il reste ${n} ${n > 1 ? plusieurs : un} entier${n > 1 ? 's' : ''}${pour} à compter d’aujourd’hui (${frDate(p.today)}), soit ${n} échéance${n > 1 ? 's' : ''} si elles sont dues chaque ${un}. `
      + 'Le nombre exact dépend du jour d’échéance.';
  return {
    text: `${texte} Cette date sert uniquement à ce calcul : elle n’a pas été enregistrée.`,
    calculation: 'remaining_periods', contradiction: false, used: [fin.fieldKey],
  };
}

/** Réponse à une information donnée pour le seul contexte (aucune écriture). */
export const CONTEXT_ONLY_MESSAGE = 'Merci pour cette précision. Je n’ai rien modifié dans vos données. '
  + 'Si vous souhaitez l’enregistrer, dites-le-moi et je vous proposerai la modification à confirmer.';

/** Proposition impossible faute de capacité d'écriture côté assistant. */
export const UPDATE_DISABLED_MESSAGE = 'Merci pour cette information. Les modifications depuis l’assistant ne sont pas disponibles actuellement : rien n’a été modifié.';

/** Compte en lecture seule (fin d'essai). */
export const UPDATE_READ_ONLY_MESSAGE = 'Votre compte est en lecture seule : je ne peux pas proposer de modification. Rien n’a été modifié.';
