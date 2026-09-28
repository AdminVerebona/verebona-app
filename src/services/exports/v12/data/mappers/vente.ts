/**
 * Mappeur « Kit de mise en vente » (CDC §10 ; `maquettes/vente/README.md`).
 *
 * VENTE-RULE-001 : le prix est la seule saisie `commercial.desiredSalePriceCents`
 * — jamais une estimation. Le design est maquetté sur un véhicule : pour un
 * bien immobilier ou un objet, `asset.infoRows` porte les lignes de la famille.
 * Points forts (VENTE-PDF-05) : faits documentés uniquement (entretiens
 * réalisés, garantie en cours, travaux datés, factures conservées), sans
 * aucun qualificatif ajouté (PDF-TXT-001/004).
 */

import { dot, fmt } from '../../html/components';
import type { VenteData } from '../../types';
import { eventKind, isPastEvent } from '../choices';
import {
  type MapInput, exportInfo, kc, kcNum, str, info, infoCents, humanize, categoryLabel, titleLines, conditionLabel,
  familyInfoRows, factualSummary, toDocItem, sortedDocuments, toPhotoItem, plannedPhotos, selectedEvents, sectionOn,
} from './common';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

/** Points forts factuels, déduits des seules données présentes (4 au plus, maquette). */
export function saleHighlights(m: MapInput): NonNullable<VenteData['highlights']> {
  const s = m.source;
  const out: NonNullable<VenteData['highlights']> = [];
  const past = s.events.filter((e) => isPastEvent(e, m.today));
  const maintenance = past.filter((e) => eventKind(e) === 'ENTRETIEN').sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (maintenance.length) {
    const last = maintenance[0];
    out.push({
      id: 'h-maintenance',
      title: 'Entretien documenté',
      text: `${plural(maintenance.length, 'intervention documentée', 'interventions documentées')}, la dernière le ${fmt.date(last.date)}${last.provider ? ` (${last.provider})` : ''}.`,
      selected: true,
    });
  }
  if (s.asset.warrantyEndDate && s.asset.warrantyEndDate >= m.today) {
    out.push({ id: 'h-warranty', title: 'Garantie en cours', text: `Jusqu'au ${fmt.date(s.asset.warrantyEndDate)}.`, selected: true });
  }
  const works = past.filter((e) => eventKind(e) === 'TRAVAUX').sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (works.length) {
    out.push({ id: 'h-works', title: works[0].title, text: `Réalisé le ${fmt.date(works[0].date)}${works[0].provider ? ` par ${works[0].provider}` : ''}.`, selected: true });
  }
  const invoices = s.documents.filter((d) => d.kind === 'FACTURE' && !d.sensitive);
  if (invoices.length) {
    out.push({ id: 'h-invoices', title: 'Factures conservées', text: `${plural(invoices.length, 'facture')} dans le dossier du bien.`, selected: true });
  }
  return out.slice(0, 4);
}

export function mapVente(m: MapInput): VenteData {
  const s = m.source;
  const c = s.additionalInfo.commercial;
  const isVehicle = s.family === 'VEHICULE';
  const locationLabel = s.family === 'IMMOBILIER' ? dot(s.asset.city, s.asset.postalCode) || null : s.asset.city ?? null;
  return {
    export: exportInfo(m, 'VENTE'),
    asset: {
      id: s.asset.id,
      family: s.family,
      name: s.asset.name,
      titleLines: titleLines(s),
      categoryLabel: categoryLabel(s),
      fields: isVehicle
        ? {
          brand: kc(s, 'make'),
          model: kc(s, 'model'),
          modelYear: kcNum(s, 'year'),
          purchaseDate: s.asset.purchaseDate,
          purchaseCondition: humanize(kc(s, 'purchaseCondition')),
          frameNumber: kc(s, 'vin'), // masqué au rendu (fmt.mask, design)
          color: kc(s, 'color'),
          markingLabel: kc(s, 'marking'),
          mileageKm: kcNum(s, 'mileage') ?? s.asset.mileageOrHours,
          mileageDate: kc(s, 'mileageDate'),
          motorLabel: dot(kc(s, 'engine') ?? s.asset.engineInfo, humanize(kc(s, 'fuelType'))) || null,
          batteryLabel: kc(s, 'battery'),
          transmissionLabel: kc(s, 'transmission'),
          conditionLabel: conditionLabel(s),
          parkingLabel: kc(s, 'parking'),
          locationLabel,
        }
        : { locationLabel },
      ...(isVehicle ? {} : { infoRows: familyInfoRows(s) }),
    },
    summary: factualSummary(s),
    sale: {
      pitch: info(c, 'salePitch'),
      desiredPriceCents: infoCents(c, 'desiredSalePriceCents'),
      newPriceCents: infoCents(c, 'newPriceCents'),
      availabilityDate: info(c, 'availabilityDate'),
      availabilityComment: info(c, 'availabilityComment'),
      includedAccessories: info(c, 'includedAccessories'),
      saleConditions: info(c, 'saleConditions'),
      contactInstructions: info(c, 'contactInstructions'),
    },
    highlights: sectionOn(m, 'highlights') ? saleHighlights(m) : [],
    followUp: sectionOn(m, 'followUp')
      ? selectedEvents(m).map((e) => ({ id: e.key, date: e.date, title: e.title, provider: str(e.provider), selected: true }))
      : [],
    documents: sortedDocuments(m).map((pd) => toDocItem(pd, 'docs', m)),
    photos: plannedPhotos(m).map((pp) => toPhotoItem(pp, m)),
  };
}
