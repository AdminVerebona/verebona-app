/**
 * Étape 11 — production des candidats agenda.
 *
 * DÉTERMINISTE : aucun appel modèle. Les dates ont déjà été extraites avec leur
 * preuve par `extract_source` ; il ne reste qu'à reconnaître celles qui portent
 * une échéance. La classification action / information et la déduplication
 * relèvent de l'usage 4 (CDC §4.4.3), pas de l'analyse.
 *
 * Cette séparation supprime le double appel constaté dans l'existant, où
 * `extract_agenda_v1` puis `agenda_detect_v1` traitaient la même information.
 */
import type { ExtractedField, AgendaCandidate } from '../types';
import { parseRecurrenceFr, type RecurrenceSpec } from '../../agenda/rules/recurrence';
import {
  getEventEntry,
  getField,
  resolveAlias,
  resolveDocumentType,
  type AgendaNature,
} from '@/services/canonical/registry';

/** Champs de date porteurs d'échéance, avec le libellé d'événement associé. */
const DEADLINE_FIELDS: Record<string, string> = {
  insuranceExpiry: "Fin de période d'assurance",
  nextInspection: 'Contrôle technique',
  warrantyEndDate: 'Fin de garantie',
  contractEndDate: 'Fin de contrat',
  dpeDate: 'Échéance DPE',
  leaseEndDate: 'Fin de bail',
  maintenanceDueDate: 'Entretien à prévoir',
  registrationExpiry: "Fin de validité d'immatriculation",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function buildAgendaCandidates(
  fields: ExtractedField[],
  documentTitle?: string,
): AgendaCandidate[] {
  const candidates: AgendaCandidate[] = [];

  for (const field of fields) {
    const label = DEADLINE_FIELDS[field.fieldKey];
    if (!label) continue;
    // Une échéance se LIT : une date « observée » sans texte n'en crée aucune.
    if (field.provenance === 'VISUAL_ANALYSIS' || !field.excerpt) continue;

    const value = typeof field.value === 'string' ? field.value : null;
    if (!value || !ISO_DATE.test(value)) continue;

    candidates.push({
      title: documentTitle ? `${label} — ${documentTitle}` : label,
      date: value,
      confidence: field.confidence,
      excerpt: field.excerpt,
      originFieldKey: field.fieldKey,
      // Aucune catégorie suggérée : c'est la responsabilité de l'usage 4.
      recurrence: recurrenceOf(field),
    });
  }

  return dedupeByDateAndField(candidates);
}

/**
 * Récurrence EXPLICITE : fournie par l'extraction, ou lue dans l'extrait de
 * preuve (« renouvellement annuel », « tous les 12 mois »). Jamais supposée
 * d'après le type d'échéance.
 */
export function recurrenceOf(field: ExtractedField): RecurrenceSpec | undefined {
  const r = field.recurrence;
  if (r) {
    return {
      mode: 'EXPLICIT_SOURCE', frequency: r.frequency, interval: r.interval ?? 1,
      startDate: r.startDate ?? null, endDate: r.endDate ?? null, occurrenceCount: r.occurrenceCount ?? null,
      dates: r.dates ?? null, excerpt: r.excerpt ?? field.excerpt,
    };
  }
  return parseRecurrenceFr(field.excerpt ?? '') ?? undefined;
}

/** Deux champs différents portant la même date ne créent qu'un candidat. */
function dedupeByDateAndField(candidates: AgendaCandidate[]): AgendaCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.date}:${c.originFieldKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ══════════════════════════════════════════════════════════════════════════
// CANDIDATS T4 PILOTÉS PAR LE REGISTRE — CDC 15 T4-01, T4-03, T4-04, §13
// (lot 14, derrière AI_T4_EFFECTS)
//
// Plus de liste fermée : un champ produit un candidat si le registre lui
// donne un `agendaEffect` (nature HISTORICAL ou DEADLINE, type métier). Les
// événements réalisés (achat, entretien réalisé, contrôle réalisé, DPE
// réalisé) deviennent des éléments HISTORICAL ; les échéances explicites des
// DEADLINE. `dpeDate` est un « DPE réalisé », jamais une échéance ; seule une
// `dpeExpiryDate` explicite l'est (T4-03).
//
// Les événements sans champ de date (réparation, sinistre, vente — §13)
// viennent des faits T1 portant un `semanticEvent` HISTORICAL : daté du
// document, un par type et par document.
//
// Chaque candidat transporte ce que T4 (A) et la primitive agenda (B)
// attendent : nature, type métier, champ d'origine, cible, occurrence et
// document source (clé fonctionnelle T4-08), type documentaire, autorité et
// droit de création automatique (T4-04).
// ══════════════════════════════════════════════════════════════════════════

export interface T4CandidateContext {
  /** Document source (lead) — clé fonctionnelle, liens document ↔ agenda. */
  sourceFileId: number;
  /** Bien du document : connu, rattaché, ou unique candidat certain. */
  documentAssetId: number | null;
  /** Le document concerne plusieurs biens (U8) : seuls ses faits ciblés comptent. */
  multiAsset: boolean;
  documentTitle?: string | null;
  /** Date du document (AAAA-MM-JJ) : date des événements sans champ de date. */
  documentDate?: string | null;
  /** Type documentaire canonique (V1 / DOCUMENT_CATALOG) ou type V2. */
  documentType?: string | null;
  documentTypeCode?: string | null;
}

/** Libellé d'un événement réalisé, par type métier (§13). */
const HISTORICAL_TITLES: Readonly<Record<string, string>> = {
  purchase: 'Achat',
  maintenance: 'Entretien réalisé',
  repair: 'Réparation',
  inspection: 'Contrôle réalisé',
  dpe: 'DPE réalisé',
  claim: 'Sinistre',
  sale: 'Vente',
  insurance: 'Assurance',
};

type Semantique = { nature: AgendaNature; businessType: string; originFieldKey: string | null; title: string };

/** Clé canonique d'un champ : contrat enrichi, sinon clé historique résolue. */
function cleCanonique(f: ExtractedField): string | null {
  if (f.canonicalKey !== undefined) return f.canonicalKey;
  if (getField(f.fieldKey)) return f.fieldKey;
  return resolveAlias(f.fieldKey) ?? null;
}

function semantique(f: ExtractedField): Semantique | null {
  const key = cleCanonique(f);
  const def = key ? getField(key) : undefined;
  if (def?.agendaEffect) {
    const { nature, businessType } = def.agendaEffect;
    const title = nature === 'HISTORICAL' ? (HISTORICAL_TITLES[businessType] ?? def.label) : def.label;
    return { nature, businessType, originFieldKey: def.key, title };
  }
  // Fait T1 sans clé d'agenda mais portant un événement du catalogue (§13 :
  // réparation, sinistre, vente…).
  const ev = f.semanticEvent;
  if (!ev || ev.nature === 'FACT_ONLY') return null;
  const entry = getEventEntry(ev.type);
  if (!entry || !entry.natures.includes(ev.nature)) return null;
  const title = ev.nature === 'HISTORICAL' ? (HISTORICAL_TITLES[entry.businessType] ?? entry.titleTemplate) : entry.titleTemplate;
  return { nature: ev.nature, businessType: entry.businessType, originFieldKey: null, title };
}

/**
 * Candidats T4 d'un document (fonction PURE). Mêmes garde-fous que le chemin
 * historique : une date se LIT (pas d'observation visuelle, extrait
 * obligatoire), ISO stricte ; en multi-biens, seuls les faits ciblés sur le
 * bien du document (U8).
 */
export function buildAgendaCandidatesT4(fields: ExtractedField[], ctx: T4CandidateContext): AgendaCandidate[] {
  const entry = resolveDocumentType(ctx.documentType) ?? resolveDocumentType(ctx.documentTypeCode);
  const documentType = entry?.code ?? ctx.documentType ?? ctx.documentTypeCode ?? null;
  const out: AgendaCandidate[] = [];
  const vus = new Set<string>();
  // Champs d'agenda du registre d'abord, puis les événements sans champ de
  // date : un « Achat » porté par acquisitionDate n'est pas doublé par
  // l'événement purchase du prix ou de la ligne d'article.
  const parChamp = (f: ExtractedField) => (semantique(f)?.originFieldKey ? 0 : 1);
  const ordonnes = [...fields].sort((a, b) => parChamp(a) - parChamp(b));
  const typesDates = new Set<string>();

  for (const field of ordonnes) {
    if (field.provenance === 'VISUAL_ANALYSIS' || !field.excerpt) continue;
    const sem = semantique(field);
    if (!sem) continue;

    // Cible : le bien du document, jamais un autre bien (U8) ni un équipement
    // rabattu sur son bien parent.
    const t = field.target;
    if (t) {
      if (t.targetType !== 'ASSET') continue;
      const surLeBien = ctx.documentAssetId !== null
        ? t.targetEntityId === ctx.documentAssetId
        : t.targetEntityId === null && !ctx.multiAsset;
      if (!surLeBien) continue;
    } else if (ctx.multiAsset) {
      continue;
    }

    // Date : celle du champ ; à défaut (événement sans champ de date), celle du document.
    const valeur = typeof field.value === 'string' && ISO_DATE.test(field.value) ? field.value : null;
    const date = valeur ?? (sem.originFieldKey === null && sem.nature === 'HISTORICAL' ? ctx.documentDate ?? null : null);
    if (!date || !ISO_DATE.test(date)) continue;

    // Événement sans champ de date déjà couvert par un champ du registre.
    if (!sem.originFieldKey && typesDates.has(`${sem.businessType}|${sem.nature}`)) continue;
    const occurrence = sem.originFieldKey ? 'single' : date;
    const cle = `${sem.businessType}|${sem.originFieldKey ?? '-'}|${occurrence}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    typesDates.add(`${sem.businessType}|${sem.nature}`);

    const sujet = field.subject?.trim() || field.target?.targetEntityLabel?.trim() || ctx.documentTitle?.trim() || null;
    // Récurrence ÉNONCÉE (champ ou extrait) : T4 seul en tire des occurrences.
    const recurrence = recurrenceOf(field);
    // T4-02 côté candidat : catégorie du REGISTRE (EVENT_CATALOG.homeCategory
    // de la nature) — un contrôle ou un entretien futur est une ACTION, un
    // fait réalisé une INFORMATION ; « selon l'événement » : laissé à T4.
    const categorie = getEventEntry(sem.businessType)?.homeCategory[sem.nature];
    out.push({
      title: sujet ? `${sem.title} — ${sujet}` : sem.title,
      date,
      ...(categorie === 'action' || categorie === 'information' ? { suggestedCategory: categorie } : {}),
      confidence: field.confidence,
      excerpt: field.excerpt,
      ...(sem.originFieldKey ? { originFieldKey: sem.originFieldKey } : {}),
      ...(recurrence ? { recurrence } : {}),
      nature: sem.nature,
      businessType: sem.businessType,
      target: { type: 'ASSET', id: ctx.documentAssetId },
      occurrence,
      sourceFileId: ctx.sourceFileId,
      dateSource: valeur ? 'FIELD' : 'DOCUMENT_DATE',
      documentType,
      authority: entry?.authority ?? null,
      mayCreateAgenda: entry ? entry.mayCreateAgenda : null,
      sources: [{ fileId: ctx.sourceFileId, role: 'SOURCE' }],
    });
  }
  return out;
}

/**
 * Candidats retenus selon `AI_T4_EFFECTS` (lot 14) :
 *   · legacy  : candidats historiques, STRICTEMENT inchangés ;
 *   · shadow  : candidats du registre calculés et journalisés (résumé, sans
 *               valeur), candidats historiques retenus — aucun effet ;
 *   · enabled : candidats du registre.
 */
export function selectAgendaCandidates(
  legacy: AgendaCandidate[],
  fields: ExtractedField[],
  ctx: T4CandidateContext,
  mode: 'legacy' | 'shadow' | 'enabled',
): AgendaCandidate[] {
  if (mode === 'legacy') return legacy;
  const t4 = buildAgendaCandidatesT4(fields, ctx);
  if (mode === 'enabled') return t4;
  const resume = (cs: AgendaCandidate[]) => cs.map((c) => `${c.businessType ?? c.originFieldKey ?? '?'}:${c.nature ?? '?'}`).sort();
  console.info('[t4-shadow] candidats agenda', JSON.stringify({
    sourceFileId: ctx.sourceFileId, legacy: resume(legacy), t4: resume(t4),
    historical: t4.filter((c) => c.nature === 'HISTORICAL').length,
    deadline: t4.filter((c) => c.nature === 'DEADLINE').length,
  }));
  return legacy;
}

/**
 * Complète la source des candidats avec la PREUVE écrite pour leur champ
 * d'origine (`field_evidence.id`), une fois les preuves persistées.
 * `evidenceIds` : clé canonique (ou clé de champ) → identifiant de preuve.
 */
export function attachEvidenceToCandidates(candidates: AgendaCandidate[], evidenceIds: ReadonlyMap<string, number>): void {
  for (const c of candidates) {
    if (!c.sources || !c.originFieldKey) continue;
    const id = evidenceIds.get(c.originFieldKey);
    if (id === undefined) continue;
    c.sources = c.sources.map((s) => (s.role === 'SOURCE' ? { ...s, evidenceId: id } : s));
  }
}
