/**
 * Mappeur « Assurance — sinistre / indemnisation » (CDC §13 ;
 * `maquettes/assurance-sinistre/README.md`).
 *
 * Lot 83D (CDC v5 §16, AC37, AC38 ; arbitrages V-Q1, V-Q2, V-Q8) : le dossier
 * est construit à partir de l'Opération CLAIM CONSOLIDÉE (`source.claimFile`),
 * plus jamais d'une sous-rubrique de saisie :
 *   · synthèse : données d'assurance sourcées (type, dates, références,
 *     police, avancement, circonstances, conséquences, mesures, estimation,
 *     indemnité) et Pièces / équipements concernés ;
 *   · chronologie (RULE-003) : élément principal et étapes de l'Opération
 *     (éléments d'Agenda), déclaration, puis les autres événements retenus ;
 *   · dommages (PDF-04) : dommages détaillés conservés, avec leurs photos
 *     (« P2 ») et justificatifs (« A3 ») RELIÉS — jamais dupliqués ;
 *   · documents : TOUS les documents de l'Opération (pré-cochés) ;
 *   · échanges (RULE-004) : les courriers de l'assureur ou de l'expert sont
 *     des DOCUMENTS (§18.2) ; résumé texte des échanges en repli.
 * Plus de section « Actions » (§18.1 : une étape est un élément d'Agenda).
 *
 * Les photos et pièces liées ne sont citées que si elles sont RETENUES dans
 * le dossier : une pièce sensible non cochée n'apparaît jamais, pas même par
 * sa référence. Montants : ceux des documents, ou l'estimation d'un dommage
 * (libellée comme telle) ; jamais calculés.
 */

import { dot, fmt } from '../../html/components';
import type { SinistreData } from '../../types';
import { CLAIM_STATUS_OPTIONS, CLAIM_TYPE_OPTIONS } from '@/lib/assets/additional-infos';
import { claimDate, eventKind } from '../choices';
import type { ExportSource, SourceDocument } from '../source';
import {
  type MapInput, exportInfo, kc, str, optionLabel, textLines, categoryLabel, cityLine, toDocItem,
  sortedDocuments, toPhotoItem, plannedPhotos, selectedEvents, sectionOn, docRef,
} from './common';

/** Nature d'une pièce du dossier sinistre (tableau « Devis, factures et rapports »). */
export function claimDocKind(d: SourceDocument): string {
  if (d.kind === 'DEVIS') return 'quote';
  if (d.kind === 'FACTURE') return 'invoice';
  if (d.kind === 'ECHANGE_ASSUREUR') return 'exchanges';
  if (d.kind === 'EXPERTISE' || /expert/i.test(d.title)) return 'expert-report';
  if (/fuite/i.test(d.title)) return 'leak-report';
  if (d.kind === 'SINISTRE') return 'statement';
  return 'report';
}

/** « 08/08 → 22/08/2026 » (même année) ou dates complètes. */
export function dateRangeLabel(from: string, to: string): string {
  if (from === to) return fmt.date(from);
  return from.slice(0, 4) === to.slice(0, 4) ? `${fmt.date(from).slice(0, 5)} → ${fmt.date(to)}` : `${fmt.date(from)} → ${fmt.date(to)}`;
}

/** Libellé « Salle de bain, Cuisine » ; null si vide. */
const liste = (v: readonly string[] | undefined): string | null => (v && v.length ? v.join(', ') : null);

export function mapSinistre(m: MapInput): SinistreData {
  const s: ExportSource = m.source;
  const f = s.claimFile ?? null;
  const d0 = claimDate(s);
  const typeLabel = optionLabel(CLAIM_TYPE_OPTIONS, f?.claimType);
  const declaredOn = str(f?.declaredOn);
  // Ancre de la chronologie (RULE-001) : élément principal de l'Opération, sinon événement de l'historique désigné (lot 44).
  const anchor = f?.principalKey ?? f?.historyEventKey ?? null;
  const anchorEvent = anchor ? s.events.find((e) => e.key === anchor && e.status !== 'annule') ?? null : null;
  // Titre / description de l'ancre repris seulement s'il est RETENU dans le dossier (SEL-GEN-001).
  const anchorRetained = !!anchorEvent && m.plan.events.has(anchorEvent.key) && sectionOn(m, 'timeline');

  // Références citables : photos retenues au PDF (P1…), pièces retenues (annexe).
  const photosPlanned = plannedPhotos(m);
  const photoRefOf = new Map(photosPlanned.map((pp, i) => [pp.photo.id, `P${i + 1}`]));
  const plannedDocIds = new Set(m.plan.documents.map((pd) => pd.doc.id));
  const docLink = (id: number): string | null => (plannedDocIds.has(id) ? docRef(id) : null);

  // ── Chronologie : éléments de l'Opération (principal, étapes), déclaration, événements retenus.
  const timeline: NonNullable<SinistreData['timeline']> = [];
  if (sectionOn(m, 'timeline')) {
    const events = selectedEvents(m);
    const vus = new Set(events.map((e) => e.key));
    const deLOperation = new Set(f?.agendaKeys ?? []);
    // Étapes de l'Opération non rattachées au bien (absentes des événements proposés) : toujours imprimées.
    for (const a of f?.agenda ?? []) {
      if (vus.has(a.key) || s.events.some((e) => e.key === a.key)) continue;
      timeline.push({ id: a.key, date: a.date, tone: a.principal ? 'key' : null, title: a.title, text: null, selected: true });
    }
    const principalShown = !!anchor && (events.some((e) => e.key === anchor) || timeline.some((t) => t.id === anchor));
    if (d0 && !principalShown) {
      timeline.push({
        id: 'claim', date: d0, tone: 'key',
        title: typeLabel ? `Sinistre : ${typeLabel.toLowerCase()}` : (anchorRetained ? anchorEvent!.title : null) ?? 'Survenue du sinistre',
        text: str(f?.circumstances)?.split(/\n/)[0] ?? null, selected: true,
      });
    }
    if (declaredOn) timeline.push({ id: 'declared', date: declaredOn, title: "Déclaration à l'assureur", text: f?.insurerClaimRef ? `Référence ${f.insurerClaimRef}` : null, selected: true });
    for (const e of events) {
      const isClaim = anchor ? e.key === anchor : eventKind(e) === 'SINISTRE' && e.date === d0;
      const tone = isClaim ? 'key' : deLOperation.has(e.key) ? null : d0 && e.date && e.date < d0 ? 'past' : e.date && e.date > m.today ? 'open' : null;
      timeline.push({ id: e.key, date: e.date, tone, title: e.title, text: dot(str(e.provider)) || null, selected: true });
    }
    timeline.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
  }

  const docs = sortedDocuments(m);
  const docItems = docs.map((pd) => toDocItem(pd, 'claim-docs', m, {
    kind: claimDocKind(pd.doc),
    issuer: str(pd.doc.supplier),
    amountCents: pd.doc.amountCents,
  }));

  // ── Photos P1… : avant / sinistre selon la date du sinistre.
  const photos = photosPlanned.map((pp, i) => toPhotoItem(pp, m, {
    ref: `P${i + 1}`,
    caption: dot(pp.photo.date ? pp.photo.date.split('-').reverse().join('/') : '', str(pp.photo.caption)) || null,
    phase: d0 && pp.photo.date && pp.photo.date < d0 ? 'before' : 'claim',
  }));

  // ── Dommages (PDF-04) : dommages détaillés du sinistre — jamais extrapolés d'un texte.
  const damages: NonNullable<SinistreData['damages']> = sectionOn(m, 'damages')
    ? (f?.damages ?? []).map((d) => ({
      id: `dm-${d.key}`,
      zone: str(d.zone),
      element: str(d.element),
      finding: [str(d.finding), d.estimatedAmountCents != null ? `Montant estimé : ${fmt.money(d.estimatedAmountCents)}` : ''].filter(Boolean).join(' · ') || null,
      photoRefs: d.photoIds.map((id) => photoRefOf.get(id)).filter(Boolean).join(', ') || null,
      docIds: d.documentIds.map(docLink).filter((x): x is string => !!x),
      selected: true,
    })).filter((d) => d.zone)
    : [];

  // ── Échanges (RULE-004, §18.2) : courriers de l'assureur / de l'expert RETENUS ; repli texte libre.
  const exchanges: NonNullable<SinistreData['exchanges']> = [];
  if (sectionOn(m, 'exchanges')) {
    for (const pd of docs.filter((x) => x.doc.kind === 'ECHANGE_ASSUREUR')) {
      exchanges.push({ id: `x${pd.doc.id}`, date: pd.doc.date, title: pd.doc.title, channel: dot(str(pd.doc.supplier), 'Courrier') || null, docId: docRef(pd.doc.id), linkedToClaim: true, selected: true });
    }
    exchanges.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
    if (!exchanges.length) {
      textLines(f?.exchangesSummary).forEach((t, i) => exchanges.push({ id: `xs${i}`, title: t, linkedToClaim: true, selected: true }));
    }
  }

  const insurer = kc(s, 'insurer');
  const contractNo = kc(s, 'insuranceContractNumber');

  return {
    export: exportInfo(m, 'ASSURANCE_SINISTRE'),
    asset: {
      id: s.asset.id,
      family: s.family,
      name: s.asset.name,
      categoryLabel: categoryLabel(s),
      addressLabel: s.family === 'IMMOBILIER' ? dot(s.asset.address, cityLine(s)) || null : s.asset.name,
    },
    claim: {
      typeLabel,
      date: d0,
      declaredAt: declaredOn,
      contractLabel: str(f?.policyReference) ?? (dot(insurer, contractNo ? `n° ${contractNo}` : '') || null),
      insurerRef: str(f?.insurerClaimRef),
      statusLabel: optionLabel(CLAIM_STATUS_OPTIONS, f?.status),
      // Circonstances : celles du sinistre, sinon la description de l'événement d'ancrage RETENU (SEL-GEN-001).
      circumstances: str(f?.circumstances) ?? (anchorRetained ? str(anchorEvent!.description) : null),
      consequences: str(f?.consequences),
      measures: str(f?.measures),
      statusDetail: str(f?.statusDetail),
      // Montants connus, imprimés seulement s'ils sont présents (jamais calculés).
      estimatedDamage: typeof f?.estimatedDamageCents === 'number' ? fmt.money(f.estimatedDamageCents) : null,
      compensation: typeof f?.compensationCents === 'number' ? fmt.money(f.compensationCents) : null,
      rooms: liste(f?.rooms),
      equipments: liste(f?.equipments),
    },
    scope: { rooms: [...(f?.rooms ?? [])], equipments: [...(f?.equipments ?? [])] },
    timeline,
    damages,
    exchanges,
    documents: docItems,
    photos,
  };
}
