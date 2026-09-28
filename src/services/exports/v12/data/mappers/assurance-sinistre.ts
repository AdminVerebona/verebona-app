/**
 * Mappeur « Assurance — sinistre / indemnisation » (CDC §13 ;
 * `maquettes/assurance-sinistre/README.md`).
 *
 * RULE-001/002 : le sinistre vient de la sous-rubrique « Sinistre » des
 * informations complémentaires (saisie non bloquante) et des événements liés.
 * RULE-003 : chronologie centrale, triée ; le sinistre (pastille rouge), la
 * déclaration et les événements retenus y figurent.
 * RULE-004 : échanges retenus seulement s'ils sont liés au sinistre (pièces
 * « correspondance sinistre » retenues, résumé saisi).
 * Montants : ceux des devis et factures importés, jamais estimés.
 */

import { dot } from '../../html/components';
import type { SinistreData } from '../../types';
import { CLAIM_STATUS_OPTIONS, CLAIM_TYPE_OPTIONS } from '@/lib/assets/additional-infos';
import { claimDate, eventKind } from '../choices';
import type { SourceDocument } from '../source';
import {
  type MapInput, exportInfo, kc, str, info, textLines, humanize, categoryLabel, cityLine, toDocItem, sortedDocuments,
  toPhotoItem, plannedPhotos, selectedEvents, sectionOn, docRef,
} from './common';

const optionLabel = (options: ReadonlyArray<{ value: string; label: string }>, v: string | null) =>
  (v ? options.find((o) => o.value === v)?.label ?? humanize(v) : null);

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

export function mapSinistre(m: MapInput): SinistreData {
  const s = m.source;
  const c = s.additionalInfo.claim;
  const d0 = claimDate(s);
  const typeLabel = optionLabel(CLAIM_TYPE_OPTIONS, info(c, 'claimType'));
  const declaredOn = info(c, 'declaredOn');

  // ── Chronologie : sinistre et déclaration saisis + événements retenus.
  const timeline: NonNullable<SinistreData['timeline']> = [];
  if (sectionOn(m, 'timeline')) {
    if (d0) timeline.push({ id: 'claim', date: d0, tone: 'key', title: typeLabel ? `Sinistre : ${typeLabel.toLowerCase()}` : 'Survenue du sinistre', text: str(info(c, 'circumstances'))?.split(/\n/)[0] ?? null, selected: true });
    if (declaredOn) timeline.push({ id: 'declared', date: declaredOn, title: "Déclaration à l'assureur", text: info(c, 'insurerClaimRef') ? `Référence ${info(c, 'insurerClaimRef')}` : null, selected: true });
    for (const e of selectedEvents(m)) {
      const k = eventKind(e);
      const tone = d0 && e.date && e.date < d0 ? 'past' : e.date && e.date > m.today ? 'open' : k === 'SINISTRE' && e.date === d0 ? 'key' : null;
      timeline.push({ id: e.key, date: e.date, tone, title: e.title, text: dot(str(e.provider)) || null, selected: true });
    }
  }

  const docs = sortedDocuments(m);
  const docItems = docs.map((pd) => toDocItem(pd, 'claim-docs', m, {
    kind: claimDocKind(pd.doc),
    issuer: str(pd.doc.supplier),
    amountCents: pd.doc.amountCents,
  }));

  // ── Photos P1… : avant / sinistre selon la date du sinistre.
  const photos = plannedPhotos(m).map((pp, i) => toPhotoItem(pp, m, {
    ref: `P${i + 1}`,
    caption: dot(pp.photo.date ? pp.photo.date.split('-').reverse().join('/') : '', str(pp.photo.caption)) || null,
    phase: d0 && pp.photo.date && pp.photo.date < d0 ? 'before' : 'claim',
  }));

  // ── Échanges (RULE-004) : correspondances retenues + résumé saisi.
  const exchanges: NonNullable<SinistreData['exchanges']> = [];
  if (sectionOn(m, 'exchanges')) {
    for (const pd of docs.filter((x) => x.doc.kind === 'ECHANGE_ASSUREUR')) {
      exchanges.push({ id: `x${pd.doc.id}`, date: pd.doc.date, title: pd.doc.title, channel: 'Courrier', docId: docRef(pd.doc.id), linkedToClaim: true, selected: true });
    }
    textLines(c?.exchangesSummary).forEach((t, i) => exchanges.push({ id: `xs${i}`, title: t, linkedToClaim: true, selected: true }));
  }

  const actions = sectionOn(m, 'actions')
    ? textLines(c?.measures).length > 1 ? textLines(c?.measures).map((t, i) => ({ id: `a${i}`, title: t, selected: true })) : []
    : [];

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
      contractLabel: info(c, 'policyReference') ?? (dot(insurer, contractNo ? `n° ${contractNo}` : '') || null),
      insurerRef: info(c, 'insurerClaimRef'),
      statusLabel: optionLabel(CLAIM_STATUS_OPTIONS, info(c, 'status')),
      circumstances: info(c, 'circumstances'),
      consequences: info(c, 'consequences'),
      // Plusieurs mesures saisies ligne à ligne : cartes « Actions déjà réalisées » ; sinon ligne de synthèse.
      measures: actions.length ? null : info(c, 'measures'),
      statusDetail: info(c, 'statusDetail'),
    },
    timeline,
    // Dommages structurés (zone / élément / constat) : saisie prévue avec l'écran de préparation.
    damages: [],
    actions,
    exchanges,
    documents: docItems,
    photos,
  };
}
