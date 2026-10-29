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
import { parseRecurrenceFr, type RecurrenceEnd, type RecurrenceSpec } from '../../agenda/rules/recurrence';
import { CONTRACT_END_DATE_KEYS, resolveRecurrenceEnd, type ContractEndEvidence } from '../../agenda/rules/recurrence-end';
import {
  documentMayCreateEvent,
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
  today: string = todayParis(),
): AgendaCandidate[] {
  const candidates: AgendaCandidate[] = [];
  // Lot 99D : fin de récurrence QUALIFIÉE par l'état contractuel du document (calculée au besoin).
  let finDoc: RecurrenceEnd | null | undefined;
  const finDe = () => (finDoc === undefined ? (finDoc = resolveRecurrenceEnd(contractEndEvidenceOf(fields, null), { today })) : finDoc);

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
      recurrence: withEnd(recurrenceOf(field), finDe),
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

/** Date du jour à Paris (AAAA-MM-JJ). */
function todayParis(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Lot 99D : récurrence complétée de la fin qualifiée du document (aucune fin : inchangée). */
function withEnd(spec: RecurrenceSpec | undefined, finDe: () => RecurrenceEnd | null): RecurrenceSpec | undefined {
  if (!spec) return spec;
  const end = finDe();
  return end ? { ...spec, end } : spec;
}

/**
 * Lot 99D — état contractuel STRUCTURÉ d'un document (pure) : textes lus des
 * faits (extrait, valeur textuelle) avec leur confiance, et dates de fin
 * contractuelle du registre (`contractEndDate`, `leaseEndDate`, alias
 * contextuels compris). Observations visuelles exclues (une fin se LIT).
 */
export function contractEndEvidenceOf(fields: ExtractedField[], documentType: string | null): ContractEndEvidence {
  const texts: ContractEndEvidence['texts'] = [];
  const endDates: ContractEndEvidence['endDates'] = [];
  for (const f of fields) {
    if (f.provenance === 'VISUAL_ANALYSIS') continue;
    const confidence = typeof f.confidence === 'string' ? f.confidence : null;
    if (f.excerpt) texts.push({ text: f.excerpt, confidence, fieldKey: f.fieldKey });
    const v = typeof f.value === 'string' ? f.value.trim() : null;
    if (v && !ISO_DATE.test(v) && v.length >= 12) texts.push({ text: v, confidence, fieldKey: f.fieldKey });
    const key = cleCanonique(f, documentType);
    if (key && CONTRACT_END_DATE_KEYS.includes(key) && v && ISO_DATE.test(v)) {
      endDates.push({ date: v, fieldKey: key, confidence: confidence ?? 'probable', excerpt: f.excerpt ?? null });
    }
  }
  return { texts, endDates };
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
// (lot 14 ; seuls candidats retenus depuis le lot 16b-2, AI_T4_EFFECTS
// retiré — ceux de `buildAgendaCandidates` sont remplacés par le pipeline)
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
  /**
   * Capacités du compte : sans `equipments`, une cible ÉQUIPEMENT n'est jamais
   * un candidat — et elle n'est pas réattribuée au bien (garde-fou T4).
   */
  capabilities?: import('@/services/account-capabilities.service').AccountCapabilities;
  /** Lot 99D : date de référence (AAAA-MM-JJ, Paris) de la qualification d'une fin de récurrence. */
  today?: string;
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

/**
 * Clé canonique d'un champ : contrat enrichi, sinon clé historique résolue —
 * avec le type documentaire pour les alias contextuels (décision PO D-C,
 * lot 20 : `dateFinContrat` d'un bail ou d'une LOA/LLD → leaseEndDate).
 */
function cleCanonique(f: ExtractedField, documentType: string | null): string | null {
  if (f.canonicalKey !== undefined) return f.canonicalKey;
  if (getField(f.fieldKey)) return f.fieldKey;
  return resolveAlias(f.fieldKey, undefined, { documentType }) ?? null;
}

function semantique(f: ExtractedField, documentType: string | null): Semantique | null {
  const key = cleCanonique(f, documentType);
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
  const parChamp = (f: ExtractedField) => (semantique(f, documentType)?.originFieldKey ? 0 : 1);
  const ordonnes = [...fields].sort((a, b) => parChamp(a) - parChamp(b));
  const typesDates = new Set<string>();
  // Lot 99D : fin de récurrence QUALIFIÉE par l'état contractuel du document —
  // jamais en multi-biens (la clause peut viser le contrat d'un autre bien).
  let finDoc: RecurrenceEnd | null | undefined;
  const finDe = () => (finDoc === undefined
    ? (finDoc = ctx.multiAsset ? null : resolveRecurrenceEnd(contractEndEvidenceOf(fields, documentType), { today: ctx.today ?? todayParis(), sourceFileId: ctx.sourceFileId }))
    : finDoc);

  for (const field of ordonnes) {
    if (field.provenance === 'VISUAL_ANALYSIS' || !field.excerpt) continue;
    const sem = semantique(field, documentType);
    if (!sem) continue;

    // Cible : le bien du document, jamais un autre bien (U8) ni un équipement
    // rabattu sur son bien parent.
    const t = field.target;
    let cible: NonNullable<AgendaCandidate['target']> = { type: 'ASSET', id: ctx.documentAssetId };
    if (t) {
      if (t.targetType === 'EQUIPMENT') {
        // Équipements hors capacités du compte : aucun candidat, ni ciblé ni reporté sur le bien.
        if (ctx.capabilities && !ctx.capabilities.equipments) continue;
        // Corpus §15 E2E-17 (lot 17) : l'échéance d'un ÉQUIPEMENT (fin de
        // garantie d'une chaudière) devient un candidat CIBLÉ sur lui — la
        // persistance le lie à l'équipement (`agenda_equipment_links`). Elle
        // était ignorée. Document mono-bien seulement : l'équipement d'un
        // document multi-biens peut appartenir à un autre bien.
        if (t.targetEntityId === null || ctx.documentAssetId === null || ctx.multiAsset) continue;
        cible = { type: 'EQUIPMENT', id: t.targetEntityId };
      } else {
        if (t.targetType !== 'ASSET') continue;
        const surLeBien = ctx.documentAssetId !== null
          ? t.targetEntityId === ctx.documentAssetId
          : t.targetEntityId === null && !ctx.multiAsset;
        if (!surLeBien) continue;
      }
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
    const cle = `${cible.type}:${cible.id ?? '-'}|${sem.businessType}|${sem.originFieldKey ?? '-'}|${occurrence}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    typesDates.add(`${sem.businessType}|${sem.nature}`);

    const sujet = field.subject?.trim() || field.target?.targetEntityLabel?.trim() || ctx.documentTitle?.trim() || null;
    // Récurrence ÉNONCÉE (champ ou extrait) : T4 seul en tire des occurrences.
    const recurrence = withEnd(recurrenceOf(field), finDe);
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
      target: cible,
      occurrence,
      sourceFileId: ctx.sourceFileId,
      dateSource: valeur ? 'FIELD' : 'DOCUMENT_DATE',
      documentType,
      authority: entry?.authority ?? null,
      // T4-04, D-B : droit de création du type, restreint à sa portée
      // (`creationScope` : constat de sinistre → sinistre HISTORIQUE seul).
      mayCreateAgenda: entry ? documentMayCreateEvent(entry, sem) : null,
      sources: [{ fileId: ctx.sourceFileId, role: 'SOURCE' }],
    });
  }

  // D-B (lot 20) : un constat de sinistre crée l'événement HISTORIQUE
  // « sinistre » même si aucun fait ne le porte — daté du document, sur le
  // bien du document (mono-bien seulement). Le changement de statut du bien
  // reste PROPOSÉ (carte À traiter ASSET-STATUS, à la création de l'élément).
  if (entry?.code === 'CONSTAT_SINISTRE' && !out.some((c) => c.businessType === 'claim')
    && ctx.documentAssetId !== null && !ctx.multiAsset && ctx.documentDate && ISO_DATE.test(ctx.documentDate)) {
    const titre = HISTORICAL_TITLES.claim;
    out.push({
      title: ctx.documentTitle?.trim() ? `${titre} — ${ctx.documentTitle.trim()}` : titre,
      date: ctx.documentDate,
      suggestedCategory: 'information',
      confidence: 'certain',
      // Aucun extrait : jamais de citation fabriquée (la date vient du document).
      excerpt: '',
      nature: 'HISTORICAL',
      businessType: 'claim',
      target: { type: 'ASSET', id: ctx.documentAssetId },
      occurrence: ctx.documentDate,
      sourceFileId: ctx.sourceFileId,
      dateSource: 'DOCUMENT_DATE',
      documentType: entry.code,
      authority: entry.authority,
      mayCreateAgenda: documentMayCreateEvent(entry, { businessType: 'claim', nature: 'HISTORICAL' }),
      sources: [{ fileId: ctx.sourceFileId, role: 'SOURCE' }],
    });
  }
  return out;
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
