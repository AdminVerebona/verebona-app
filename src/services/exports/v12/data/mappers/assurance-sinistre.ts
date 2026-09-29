/**
 * Mappeur « Assurance — sinistre / indemnisation » (CDC §13 ;
 * `maquettes/assurance-sinistre/README.md`).
 *
 * RULE-001/002 : le sinistre est idéalement un événement de l'agenda, lié
 * dans la fiche (`claim.claimEventKey`) ; à défaut, la sous-rubrique
 * « Sinistre » des informations complémentaires sert de saisie temporaire
 * (non bloquante).
 * RULE-003 : chronologie centrale, triée ; le sinistre (pastille rouge), la
 * déclaration et les événements retenus y figurent.
 * RULE-004 : échanges retenus seulement s'ils sont liés au sinistre (saisis
 * dans la sous-rubrique sinistre, pièces « correspondance sinistre » retenues).
 *
 * Listes structurées (schéma v2) — dommages, actions, échanges — prioritaires ;
 * texte libre en repli (mesures ligne à ligne, résumé des échanges). Les
 * photos et pièces liées ne sont citées (« P2 », « A3 ») que si elles sont
 * RETENUES dans le dossier : une pièce sensible non cochée n'apparaît jamais,
 * pas même par sa référence.
 * Montants : ceux des devis et factures importés, ou l'estimation SAISIE d'un
 * dommage (libellée comme telle) ; jamais calculés.
 */

import { dot, fmt } from '../../html/components';
import type { SinistreData } from '../../types';
import {
  CLAIM_STATUS_OPTIONS, CLAIM_TYPE_OPTIONS, EXCHANGE_CHANNEL_OPTIONS, EXCHANGE_PARTY_OPTIONS,
} from '@/lib/assets/additional-infos';
import { claimDate, eventKind } from '../choices';
import type { ExportSource, SourceDocument, SourceEvent } from '../source';
import {
  type MapInput, exportInfo, kc, str, info, infoList, cellIds, optionLabel, textLines, categoryLabel, cityLine, toDocItem,
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

/** Événement sinistre de l'agenda (ou de l'historique) lié dans la fiche (RULE-001). */
export function linkedClaimEvent(s: ExportSource): SourceEvent | null {
  const key = info(s.additionalInfo.claim, 'claimEventKey');
  return key ? s.events.find((e) => e.key === key && e.status !== 'annule') ?? null : null;
}

/** « 08/08 → 22/08/2026 » (même année) ou dates complètes. */
export function dateRangeLabel(from: string, to: string): string {
  if (from === to) return fmt.date(from);
  return from.slice(0, 4) === to.slice(0, 4) ? `${fmt.date(from).slice(0, 5)} → ${fmt.date(to)}` : `${fmt.date(from)} → ${fmt.date(to)}`;
}

/** Colonne « quand » d'une action structurée. */
function actionWhen(a: { date: string | null; endDate: string | null; status: string | null }): { date: string | null; whenLabel: string | null } {
  if (a.status === 'A_REALISER') return { date: null, whenLabel: a.date ? `Prévu le ${fmt.date(a.date)}` : 'Non réalisé' };
  if (a.date && a.endDate) return { date: null, whenLabel: dateRangeLabel(a.date, a.endDate) };
  if (a.status === 'EN_COURS') return { date: null, whenLabel: a.date ? `Depuis le ${fmt.date(a.date)}` : 'En cours' };
  return { date: a.date, whenLabel: null };
}

const CHANNEL_DIRECTION: Record<string, { RECU: string; ENVOYE: string }> = {
  EMAIL: { RECU: 'E-mail reçu', ENVOYE: 'E-mail envoyé' },
  COURRIER: { RECU: 'Courrier reçu', ENVOYE: 'Courrier envoyé' },
  TELEPHONE: { RECU: 'Appel reçu', ENVOYE: 'Appel passé' },
};

/** Canal d'un échange : « Expert · Courrier reçu ». */
export function exchangeChannelLabel(x: Record<string, unknown>): string | null {
  const channel = str(x.channel);
  const direction = str(x.direction);
  const dir = channel && (direction === 'RECU' || direction === 'ENVOYE') ? CHANNEL_DIRECTION[channel]?.[direction] : undefined;
  const channelLabel = dir ?? (channel && channel !== 'AUTRE' ? optionLabel(EXCHANGE_CHANNEL_OPTIONS, channel) : null)
    ?? (direction === 'RECU' ? 'Reçu' : direction === 'ENVOYE' ? 'Envoyé' : null);
  const party = str(x.party);
  return dot(party ? optionLabel(EXCHANGE_PARTY_OPTIONS, party) : '', channelLabel) || null;
}

export function mapSinistre(m: MapInput): SinistreData {
  const s = m.source;
  const c = s.additionalInfo.claim;
  const linked = linkedClaimEvent(s);
  const d0 = claimDate(s) ?? linked?.date ?? null;
  // Titre et description de l'événement lié : repris seulement s'il est RETENU
  // dans le dossier (SEL-GEN-001) ; sinon, seuls les champs saisis sont imprimés.
  const linkedRetained = !!linked && m.plan.events.has(linked.key) && sectionOn(m, 'timeline');
  const typeLabel = optionLabel(CLAIM_TYPE_OPTIONS, info(c, 'claimType'));
  const declaredOn = info(c, 'declaredOn');

  // Références citables : photos retenues au PDF (P1…), pièces retenues (annexe).
  const photosPlanned = plannedPhotos(m);
  const photoRefOf = new Map(photosPlanned.map((pp, i) => [pp.photo.id, `P${i + 1}`]));
  const plannedDocIds = new Set(m.plan.documents.map((pd) => pd.doc.id));
  const docLink = (id: number): string | null => (plannedDocIds.has(id) ? docRef(id) : null);

  // ── Chronologie : sinistre (événement lié, sinon saisie) et déclaration + événements retenus.
  const timeline: NonNullable<SinistreData['timeline']> = [];
  if (sectionOn(m, 'timeline')) {
    const events = selectedEvents(m);
    const linkedShown = !!linked && events.some((e) => e.key === linked.key);
    if (d0 && !linkedShown) {
      timeline.push({
        id: 'claim', date: d0, tone: 'key',
        title: typeLabel ? `Sinistre : ${typeLabel.toLowerCase()}` : (linkedRetained ? linked!.title : null) ?? 'Survenue du sinistre',
        text: str(info(c, 'circumstances'))?.split(/\n/)[0] ?? null, selected: true,
      });
    }
    if (declaredOn) timeline.push({ id: 'declared', date: declaredOn, title: "Déclaration à l'assureur", text: info(c, 'insurerClaimRef') ? `Référence ${info(c, 'insurerClaimRef')}` : null, selected: true });
    for (const e of events) {
      const k = eventKind(e);
      const isClaim = linked ? e.key === linked.key : k === 'SINISTRE' && e.date === d0;
      const tone = isClaim ? 'key' : d0 && e.date && e.date < d0 ? 'past' : e.date && e.date > m.today ? 'open' : null;
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

  // ── Dommages (PDF-04) : saisie structurée uniquement — jamais extrapolés d'un texte.
  const damages: NonNullable<SinistreData['damages']> = sectionOn(m, 'damages')
    ? infoList(c, 'damages').map((d, i) => {
      const amount = typeof d.estimatedAmountCents === 'number' ? d.estimatedAmountCents : null;
      return {
        id: `dm-${str(d.id) ?? i + 1}`,
        zone: str(d.zone),
        element: str(d.element),
        finding: [str(d.finding), amount != null ? `Montant estimé : ${fmt.money(amount)}` : ''].filter(Boolean).join(' · ') || null,
        photoRefs: cellIds(d.photoIds).map((id) => photoRefOf.get(id)).filter(Boolean).join(', ') || null,
        docIds: cellIds(d.documentIds).map(docLink).filter((x): x is string => !!x),
        selected: true,
      };
    }).filter((d) => d.zone)
    : [];

  // ── Actions (PDF-06) : liste structurée, sinon mesures saisies ligne à ligne.
  const structuredActions = infoList(c, 'actions');
  let actions: NonNullable<SinistreData['actions']> = [];
  if (sectionOn(m, 'actions')) {
    if (structuredActions.length) {
      actions = structuredActions.map((a, i) => {
        const performedBy = str(a.performedBy);
        return {
          id: `ac-${str(a.id) ?? i + 1}`,
          ...actionWhen({ date: str(a.date), endDate: str(a.endDate), status: str(a.status) }),
          title: str(a.title) ?? '',
          text: [str(a.detail), performedBy ? `Intervenant : ${performedBy}` : ''].filter(Boolean).join(' · ') || null,
          docId: cellIds(a.invoiceDocumentId).map(docLink).find(Boolean) ?? null,
          selected: true,
        };
      }).filter((a) => a.title);
    } else if (textLines(c?.measures).length > 1) {
      actions = textLines(c?.measures).map((t, i) => ({ id: `a${i}`, title: t, selected: true }));
    }
  }

  // ── Échanges (RULE-004) : liste structurée + correspondances retenues non déjà citées ; repli texte libre.
  const exchanges: NonNullable<SinistreData['exchanges']> = [];
  if (sectionOn(m, 'exchanges')) {
    const structured = infoList(c, 'exchanges');
    const cited = new Set(structured.flatMap((x) => cellIds(x.documentId)));
    for (const x of structured) {
      const summary = str(x.summary);
      if (!summary) continue;
      exchanges.push({
        id: `xe-${str(x.id) ?? exchanges.length + 1}`, date: str(x.date), title: summary, channel: exchangeChannelLabel(x),
        docId: cellIds(x.documentId).map(docLink).find(Boolean) ?? null, linkedToClaim: true, selected: true,
      });
    }
    for (const pd of docs.filter((x) => x.doc.kind === 'ECHANGE_ASSUREUR' && !cited.has(x.doc.id))) {
      exchanges.push({ id: `x${pd.doc.id}`, date: pd.doc.date, title: pd.doc.title, channel: 'Courrier', docId: docRef(pd.doc.id), linkedToClaim: true, selected: true });
    }
    exchanges.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
    if (!structured.length) {
      textLines(c?.exchangesSummary).forEach((t, i) => exchanges.push({ id: `xs${i}`, title: t, linkedToClaim: true, selected: true }));
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
      contractLabel: info(c, 'policyReference') ?? (dot(insurer, contractNo ? `n° ${contractNo}` : '') || null),
      insurerRef: info(c, 'insurerClaimRef'),
      statusLabel: optionLabel(CLAIM_STATUS_OPTIONS, info(c, 'status')),
      circumstances: info(c, 'circumstances') ?? (linkedRetained ? str(linked!.description) : null),
      consequences: info(c, 'consequences'),
      // Mesures saisies ligne à ligne et sans liste structurée : les cartes « Actions » les portent déjà.
      measures: !structuredActions.length && actions.length ? null : info(c, 'measures'),
      statusDetail: info(c, 'statusDetail'),
    },
    timeline,
    damages,
    actions,
    exchanges,
    documents: docItems,
    photos,
  };
}
