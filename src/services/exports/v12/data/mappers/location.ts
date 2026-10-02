/**
 * Mappeur « Dossier de mise en location » (CDC §11 ; `maquettes/location/README.md`).
 *
 * LOCATION-RULE-001 : loyer, charges et dépôt sont les seules saisies
 * `rental.*` (jamais d'estimation) ; RULE-002 : type de bail structuré ;
 * RULE-003 : la surface locative remplace la surface du bien dans CE PDF ;
 * RULE-004 : aucun coût d'entretien (le coût n'est jamais transmis).
 * Données d'occupant (bail, état des lieux, locataire) : jamais transmises.
 */

import { dot } from '../../html/components';
import type { LocationData } from '../../types';
import { LEASE_USAGE_OPTIONS } from '@/lib/assets/additional-infos';
import {
  type MapInput, exportInfo, kc, kcNum, str, info, infoCents, num, humanize, categoryLabel, titleLines, conditionLabel,
  roomsLabel, heatingLabel, factualSummary, toDocItem, sortedDocuments, toPhotoItem, plannedPhotos, selectedEvents, sectionOn,
  energyConsumptionLabel,
} from './common';

const optionLabel = (options: ReadonlyArray<{ value: string; label: string }>, v: string | null) =>
  (v ? options.find((o) => o.value === v)?.label ?? null : null);

export function mapLocation(m: MapInput): LocationData {
  const s = m.source;
  const r = s.additionalInfo.rental;
  const chargesMode = info(r, 'chargesMode');
  const usage = optionLabel(LEASE_USAGE_OPTIONS, info(r, 'leaseUsage'));
  const equipments = [...new Set([...s.asset.equipmentList, ...s.equipments.map((e) => e.name)].map((x) => x.trim()).filter(Boolean))].slice(0, 12);
  return {
    export: exportInfo(m, 'LOCATION'),
    asset: {
      id: s.asset.id,
      family: s.family,
      name: s.asset.name,
      shortName: s.asset.name,
      titleLines: titleLines(s),
      categoryLabel: categoryLabel(s),
      fields: {
        livingAreaSqm: kcNum(s, 'livingArea'),
        roomsLabel: roomsLabel(s),
        locationLabel: dot(s.asset.city, s.asset.postalCode) || null,
        floorLabel: kc(s, 'floor'),
        conditionLabel: conditionLabel(s),
        dpe: kc(s, 'dpeClass'),
        ges: kc(s, 'gesClass'),
        exposure: kc(s, 'exposure'),
        transport: kc(s, 'transport'),
      },
    },
    summary: factualSummary(s),
    rental: {
      pitch: info(r, 'rentalPitch'),
      monthlyRentCents: infoCents(r, 'monthlyRentCents'),
      monthlyChargesCents: infoCents(r, 'monthlyChargesCents'),
      chargesLabel: chargesMode === 'FORFAIT' ? 'forfait mensuel' : chargesMode === 'PROVISION' ? 'provision mensuelle' : null,
      depositCents: infoCents(r, 'depositCents'),
      leaseType: info(r, 'leaseType'),
      leaseDurationLabel: info(r, 'leaseDuration'),
      leaseUsageLabel: usage ? usage.charAt(0).toLowerCase() + usage.slice(1) : null,
      rentalAreaSqm: num(r?.rentalAreaSqm),
      availabilityDate: info(r, 'availabilityDate'),
      availabilityComment: info(r, 'availabilityComment'),
      rentalConditions: info(r, 'rentalConditions'),
      contactInstructions: info(r, 'contactInstructions'),
    },
    equipments: sectionOn(m, 'equipments') ? equipments : [],
    energy: sectionOn(m, 'equipments')
      ? {
        dpe: kc(s, 'dpeClass'),
        consumption: energyConsumptionLabel(s),
        ges: kc(s, 'gesClass'),
        heating: heatingLabel(s),
        hotWater: humanize(kc(s, 'hotWater')),
        ventilation: humanize(kc(s, 'ventilation')),
        parking: humanize(kc(s, 'parking')),
      }
      : {},
    // RULE-004 : jamais de coût.
    followUp: sectionOn(m, 'followUp')
      ? selectedEvents(m).map((e) => ({ id: e.key, date: e.date, title: e.title, provider: str(e.provider), selected: true }))
      : [],
    documents: sortedDocuments(m).map((pd) => toDocItem(pd, 'docs', m)),
    photos: plannedPhotos(m).map((pp) => toPhotoItem(pp, m)),
  };
}
