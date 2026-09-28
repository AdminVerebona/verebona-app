/**
 * Mappeur « Dossier complet du bien » (CDC §9 ; `maquettes/dossier-complet/README.md`).
 *
 * DOSSIER_COMPLET-RULE-002 : la section financière n'est rendue que si
 * l'utilisateur l'a cochée (section `finance`, décochée par défaut) ; elle ne
 * contient que des montants SAISIS (prix d'achat, coûts d'événements), jamais
 * l'estimation Verebona (« valeur retenue » absente faute de saisie dédiée).
 * RULE-003 : historique (événements passés) et échéances (à venir) séparés.
 */

import { dot, fmt } from '../../html/components';
import type { DossierCompletData } from '../../types';
import { eventKind, type EventKind } from '../choices';
import {
  type MapInput, exportInfo, kc, kcNum, str, categoryName, categoryLabel, titleLines, cityLine, roomsLabel,
  heatingLabel, conditionLabel, statusLabel, familyInfoRows, toDocItem, sortedDocuments, toPhotoItem, plannedPhotos,
  selectedEvents, sectionOn,
} from './common';

export const EVENT_KIND_LABELS: Record<EventKind, string> = {
  ENTRETIEN: 'Entretien', TRAVAUX: 'Travaux', GARANTIE: 'Garantie', SINISTRE: 'Sinistre', AUTRE: 'Événement',
};

export function mapDossierComplet(m: MapInput): DossierCompletData {
  const s = m.source;
  const history = selectedEvents(m, (e) => !!e.date && e.date <= m.today);
  const deadlines = selectedEvents(m, (e) => !!e.date && e.date > m.today);

  const chips = [...new Set([...s.asset.equipmentList, ...s.equipments.map((e) => e.name)].map((x) => x.trim()).filter(Boolean))].slice(0, 10);

  // Garanties et contrats EN COURS, tels que saisis dans la fiche.
  const contracts: NonNullable<DossierCompletData['contracts']> = [];
  if (s.asset.warrantyEndDate && s.asset.warrantyEndDate >= m.today) {
    contracts.push({ id: 'warranty', title: 'Garantie', detail: `Jusqu'au ${fmt.date(s.asset.warrantyEndDate)}`, selected: true });
  }
  const insurer = kc(s, 'insurer');
  const insExpiry = kc(s, 'insuranceExpiry');
  if (insurer && (!insExpiry || insExpiry >= m.today)) {
    contracts.push({
      id: 'insurance',
      title: 'Assurance',
      detail: dot(insurer, kc(s, 'insuranceContractNumber') ? `Contrat n° ${kc(s, 'insuranceContractNumber')}` : '', insExpiry ? `échéance ${fmt.date(insExpiry)}` : '') || null,
      selected: true,
    });
  }

  // Section financière : seulement si cochée ; montants saisis uniquement.
  let finance: DossierCompletData['finance'] = null;
  if (sectionOn(m, 'finance')) {
    const costEvents = history.filter((e) => e.costCents != null && e.costCents > 0);
    finance = {
      enabled: true,
      acquisition: { priceCents: s.asset.purchasePriceCents, deedDate: s.asset.purchaseDate },
      lines: [
        ...(s.asset.purchasePriceCents != null ? [{ id: 'acq', label: 'Acquisition', date: s.asset.purchaseDate, amountCents: s.asset.purchasePriceCents, kind: 'acquisition', selected: true }] : []),
        ...costEvents.map((e) => ({ id: e.key, label: e.title, date: e.date, amountCents: e.costCents!, kind: eventKind(e) === 'TRAVAUX' ? 'works' : 'maintenance', selected: true })),
      ],
      charges: [],
    };
  }

  const docs = sortedDocuments(m).map((pd) => toDocItem(pd, 'docs', m));
  const photos = plannedPhotos(m).map((pp) => toPhotoItem(pp, m));

  return {
    export: exportInfo(m, 'DOSSIER_COMPLET'),
    asset: {
      id: s.asset.id,
      family: s.family,
      name: s.asset.name,
      titleLines: titleLines(s),
      categoryLabel: categoryLabel(s),
      ...(s.family === 'IMMOBILIER'
        ? {
          fields: {
            typeLabel: categoryName(s),
            livingAreaSqm: kcNum(s, 'livingArea'),
            address1: s.asset.address,
            roomsLabel: roomsLabel(s),
            postalCode: s.asset.postalCode,
            city: s.asset.city,
            floorLabel: kc(s, 'floor'),
            constructionYear: kcNum(s, 'constructionYear'),
            conditionLabel: conditionLabel(s),
            dpe: kc(s, 'dpeClass'),
            ges: kc(s, 'gesClass'),
            heatingLabel: heatingLabel(s),
            coproLabel: str(kc(s, 'coproLots')) ? `Oui · ${kc(s, 'coproLots')} lots` : null,
            equipmentSummary: null,
            equipmentChips: sectionOn(m, 'equipments') ? chips : [],
          },
        }
        : { infoRows: familyInfoRows(s), fields: { equipmentChips: chips } }),
    },
    summary: {
      asset: dot(categoryName(s) ?? s.asset.name, fmt.area(kcNum(s, 'livingArea')), s.family === 'IMMOBILIER' ? cityLine(s) : '') || s.asset.name,
      status: statusLabel(s),
      condition: conditionLabel(s),
    },
    finance,
    history: sectionOn(m, 'history')
      ? history.map((e) => ({ id: e.key, date: e.date, title: e.title, typeLabel: EVENT_KIND_LABELS[eventKind(e)], provider: str(e.provider), selected: true }))
      : [],
    deadlines: sectionOn(m, 'deadlines') ? deadlines.map((e) => ({ id: e.key, title: e.title, date: e.date!, selected: true })) : [],
    contracts: sectionOn(m, 'contracts') ? contracts : [],
    documents: docs,
    photos,
  };
}

