/**
 * Mappeur « Dossier complet du bien » (CDC §9 ; `maquettes/dossier-complet/README.md`).
 *
 * DOSSIER_COMPLET-RULE-002 : la section financière n'est rendue que si
 * l'utilisateur l'a cochée (section `finance`, décochée par défaut) ; elle ne
 * contient que des montants SAISIS (prix d'achat, frais d'acquisition, coûts
 * d'événements, sous-rubrique « Valeur et charges » de la fiche : valeur
 * retenue, charges et taxes), jamais l'estimation Verebona.
 * RULE-003 : historique (événements passés) et échéances (à venir) séparés.
 */

import { dot, fmt } from '../../html/components';
import type { DossierCompletData } from '../../types';
import { eventKind, isUnconfirmedPastDeadline, type EventKind } from '../choices';
import { CHARGE_KIND_OPTIONS, CHARGE_PERIOD_OPTIONS, RETAINED_VALUE_SOURCE_OPTIONS } from '@/lib/assets/additional-infos';
import {
  type MapInput, exportInfo, kc, kcNum, str, info, infoCents, infoList, optionLabel, categoryName, categoryLabel, titleLines, cityLine, roomsLabel,
  heatingLabel, conditionLabel, statusLabel, familyInfoRows, toDocItem, sortedDocuments, toPhotoItem, plannedPhotos,
  selectedEvents, sectionOn,
} from './common';

export const EVENT_KIND_LABELS: Record<EventKind, string> = {
  ENTRETIEN: 'Entretien', TRAVAUX: 'Travaux', GARANTIE: 'Garantie', SINISTRE: 'Sinistre', AUTRE: 'Événement',
};

export function mapDossierComplet(m: MapInput): DossierCompletData {
  const s = m.source;
  // Échéances passées non confirmées (source canonique) : rubrique « à
  // confirmer », jamais présentées comme historique réalisé.
  const toConfirm = selectedEvents(m, (e) => isUnconfirmedPastDeadline(e, m.today));
  const history = selectedEvents(m, (e) => !!e.date && e.date <= m.today && !isUnconfirmedPastDeadline(e, m.today));
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
    const f = s.additionalInfo.finance;
    const costEvents = history.filter((e) => e.costCents != null && e.costCents > 0);
    const retained = infoCents(f, 'retainedValueCents');
    const fees = infoCents(f, 'acquisitionFeesCents');
    finance = {
      enabled: true,
      acquisition: { priceCents: s.asset.purchasePriceCents, deedDate: s.asset.purchaseDate },
      // « Valeur retenue » : saisie de l'utilisateur, avec son origine — jamais l'estimation Verebona.
      retainedValue: retained != null
        ? { amountCents: retained, sourceLabel: optionLabel(RETAINED_VALUE_SOURCE_OPTIONS, info(f, 'retainedValueSource')) ?? 'Saisie utilisateur', date: info(f, 'retainedValueDate') }
        : undefined,
      lines: [
        ...(s.asset.purchasePriceCents != null ? [{ id: 'acq', label: "Prix d'achat", date: s.asset.purchaseDate, amountCents: s.asset.purchasePriceCents, kind: 'acquisition', selected: true }] : []),
        ...(fees != null && fees > 0 ? [{ id: 'acq-fees', label: "Frais d'acquisition", date: s.asset.purchaseDate, amountCents: fees, kind: 'acquisition', selected: true }] : []),
        ...costEvents.map((e) => ({ id: e.key, label: e.title, date: e.date, amountCents: e.costCents!, kind: eventKind(e) === 'TRAVAUX' ? 'works' : 'maintenance', selected: true })),
      ],
      // Charges et taxes déclarées : « 2 160 € / an ».
      charges: infoList(f, 'charges')
        .filter((ch) => typeof ch.amountCents === 'number')
        .map((ch) => {
          const label = str(ch.label) ?? optionLabel(CHARGE_KIND_OPTIONS, ch.kind) ?? 'Charge';
          return {
            label: typeof ch.year === 'number' ? `${label} (${ch.year})` : label,
            amountCents: ch.amountCents as number,
            period: (optionLabel(CHARGE_PERIOD_OPTIONS, ch.period) ?? 'par an').replace(/^par /, ''),
          };
        }),
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
    ...(toConfirm.length && sectionOn(m, 'deadlines') ? { toConfirm: toConfirm.map((e) => ({ id: e.key, title: e.title, date: e.date!, selected: true })) } : {}),
    contracts: sectionOn(m, 'contracts') ? contracts : [],
    documents: docs,
    photos,
  };
}

