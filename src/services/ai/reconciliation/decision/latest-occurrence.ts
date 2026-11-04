/**
 * Lot 109J — champs « DERNIÈRE OCCURRENCE » d'un événement (dernier entretien,
 * dernier contrôle technique, date du dernier DPE…) : audit des
 * SOURCE_CONFLICT de l'exécution T3:6033.
 *
 * DÉFAUT DÉMONTRÉ (tests `l109j-conflits-occurrences`) : pour ces champs, deux
 * justificatifs d'interventions SUCCESSIVES (entretien 2024, entretien 2025)
 * portent deux dates différentes de même autorité ; le moteur les traitait
 * comme une contradiction (`NO_AUTHORITY_RULE` / `EQUAL_AUTHORITY_DIVERGENCE`)
 * — et un justificatif ANCIEN face à une valeur plus récente en place
 * produisait aussi une carte « À arbitrer », voire une mise à jour vers la
 * date ancienne quand la valeur en place n'avait pas de date de source.
 *
 * RÈGLE (générale, dérivée du registre canonique — aucune liste en dur) :
 * champ de type date dont l'effet agenda est HISTORIQUE et dont l'événement
 * est récurrent (le catalogue lui connaît aussi une échéance). Pour ces champs :
 *   · une preuve dont la date est ANTÉRIEURE OU ÉGALE à la valeur en place est
 *     un événement passé, pas une contradiction : valeur conservée
 *     (`OLDER_OCCURRENCE`) — y compris une valeur USER / ADMIN, jamais touchée ;
 *   · parmi des preuves PLUS RÉCENTES, portées par des DOCUMENTS DISTINCTS, la
 *     plus récente seule est décidée (règles ordinaires : protection
 *     utilisateur, champ critique, autorité) ;
 *   · deux dates différentes lues dans le MÊME document restent une vraie
 *     contradiction (règles ordinaires, conflit conservé).
 * Pure.
 */
import { EVENT_CATALOG, getField, resolveAlias } from '@/services/canonical/registry';
import type { CurrentValue, EvidenceCandidate } from '../types';

const defOf = (fieldKey: string) => getField(fieldKey) ?? getField(resolveAlias(fieldKey) ?? '');

/**
 * Le champ désigne-t-il la date de la DERNIÈRE occurrence d'un événement
 * RÉCURRENT ? Date à effet agenda HISTORIQUE dont le type d'événement du
 * catalogue a aussi une ÉCHÉANCE (entretien, contrôle, DPE : un dernier et un
 * prochain). Un événement unique (achat, vente) n'en est pas un : deux dates
 * d'achat différentes restent une contradiction.
 */
export function isLatestOccurrenceField(fieldKey: string): boolean {
  const def = defOf(fieldKey);
  if (!def || def.valueType !== 'date' || def.agendaEffect?.nature !== 'HISTORICAL') return false;
  const ev = EVENT_CATALOG.find((e) => e.businessType === def.agendaEffect!.businessType);
  return !!ev && ev.natures.includes('HISTORICAL') && ev.natures.includes('DEADLINE');
}

/**
 * Échéance RÉCURRENTE annuelle (échéance d'assurance…) : des échéances au
 * même jour de l'année, lues dans des documents distincts, sont des
 * RENOUVELLEMENTS successifs (avis 2025 puis avis 2026), pas une
 * contradiction. Des échéances à des jours différents peuvent relever de
 * contrats distincts : règles ordinaires, conflit conservé.
 */
export function isYearlyRecurringDeadline(fieldKey: string): boolean {
  const def = defOf(fieldKey);
  return !!def && def.valueType === 'date' && def.agendaEffect?.nature === 'DEADLINE' && def.agendaEffect.recurrence === 'FREQ=YEARLY';
}

const jour = (normalized: string | null | undefined): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(normalized ?? ''));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
};

export type LatestOccurrencePlan =
  | { kind: 'KEEP_CURRENT'; olderEvidenceIds: number[] }
  | { kind: 'DECIDE'; candidates: EvidenceCandidate[]; supersededEvidenceIds: number[] }
  | { kind: 'ORDINARY' };

/**
 * Plan de décision d'un champ « dernière occurrence » (pure). `ORDINARY` :
 * règles ordinaires (dates illisibles, contradiction dans un même document).
 */
export function planLatestOccurrence(
  current: CurrentValue | null, usable: readonly EvidenceCandidate[], opts: { yearlyAligned?: boolean } = {},
): LatestOccurrencePlan {
  const dates = usable.map((c) => ({ c, t: jour(c.normalized) }));
  if (!dates.length || dates.some((d) => d.t === null)) return { kind: 'ORDINARY' };
  const enPlace = current ? jour(current.normalized) : null;
  if (current && current.normalized && enPlace === null) return { kind: 'ORDINARY' };
  // Échéance annuelle : renouvellements seulement si TOUTES les dates (en place comprise) tombent le même jour de l'année.
  if (opts.yearlyAligned) {
    const md = (t: number) => new Date(t).toISOString().slice(5, 10);
    const jours = new Set([...dates.map((d) => md(d.t!)), ...(enPlace !== null ? [md(enPlace)] : [])]);
    if (jours.size !== 1) return { kind: 'ORDINARY' };
  }
  const plusRecentes = enPlace === null ? dates : dates.filter((d) => d.t! > enPlace);
  if (!plusRecentes.length) {
    // Toutes les preuves décrivent un événement antérieur ou égal : rien à contredire.
    const anciennes = dates.filter((d) => d.t! < enPlace!).map((d) => d.c.evidenceId);
    return anciennes.length ? { kind: 'KEEP_CURRENT', olderEvidenceIds: anciennes } : { kind: 'ORDINARY' };
  }
  const max = Math.max(...plusRecentes.map((d) => d.t!));
  const dernieres = plusRecentes.filter((d) => d.t === max).map((d) => d.c);
  const autres = dates.filter((d) => d.t !== max).map((d) => d.c);
  // Une date différente lue dans un document qui porte aussi la plus récente : vraie contradiction.
  const sourcesDernieres = new Set(dernieres.map((c) => c.sourceId));
  if (autres.some((c) => sourcesDernieres.has(c.sourceId))) return { kind: 'ORDINARY' };
  if (!autres.length) return { kind: 'ORDINARY' };
  return { kind: 'DECIDE', candidates: dernieres, supersededEvidenceIds: autres.map((c) => c.evidenceId) };
}
