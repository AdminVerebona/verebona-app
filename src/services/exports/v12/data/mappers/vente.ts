/**
 * Mappeur « Kit de mise en vente » (CDC §10 ; `maquettes/vente/README.md`).
 *
 * VENTE-RULE-001 : le prix est la seule saisie `commercial.desiredSalePriceCents`
 * — jamais une estimation. Le design est maquetté sur un véhicule : pour un
 * bien immobilier ou un objet, `asset.infoRows` porte les lignes de la famille.
 * Points forts (VENTE-PDF-05) : ceux CHOISIS par l'utilisateur dans la fiche
 * (`commercial.highlights`, 4 au plus, dans son ordre) ; à défaut, les faits
 * documentés (entretiens réalisés, garantie en cours, travaux datés,
 * factures conservées), sans aucun qualificatif ajouté (PDF-TXT-001/004). Les
 * mêmes faits sont proposés comme suggestions dans le formulaire
 * (`highlightSuggestions`) : l'utilisateur les accepte, les modifie ou non.
 */

import { dot, fmt } from '../../html/components';
import type { VenteData } from '../../types';
import { eventKind, isPastEvent } from '../choices';
import type { ExportSource } from '../source';
import { MAX_SALE_HIGHLIGHTS, type HighlightSuggestion } from '@/lib/assets/additional-infos';
import {
  type MapInput, exportInfo, kc, kcNum, str, info, infoCents, infoList, humanize, categoryLabel, titleLines, conditionLabel,
  familyInfoRows, factualSummary, toDocItem, sortedDocuments, toPhotoItem, plannedPhotos, selectedEvents, sectionOn,
} from './common';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

export type { HighlightSuggestion };

/**
 * Faits documentés du bien, dans l'ordre de pertinence : entretiens
 * réalisés, garantie en cours, travaux datés, factures conservées, puis
 * stationnement et état déclarés. Jamais de qualificatif ajouté.
 */
export function highlightSuggestions(s: ExportSource, today: string): HighlightSuggestion[] {
  const out: HighlightSuggestion[] = [];
  const past = s.events.filter((e) => isPastEvent(e, today));
  const maintenance = past.filter((e) => eventKind(e) === 'ENTRETIEN').sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (maintenance.length) {
    const last = maintenance[0];
    out.push({
      key: 'maintenance',
      title: 'Entretien documenté',
      text: `${plural(maintenance.length, 'intervention documentée', 'interventions documentées')}, la dernière le ${fmt.date(last.date)}${last.provider ? ` (${last.provider})` : ''}.`,
    });
  }
  if (s.asset.warrantyEndDate && s.asset.warrantyEndDate >= today) {
    out.push({ key: 'warranty', title: 'Garantie en cours', text: `Jusqu'au ${fmt.date(s.asset.warrantyEndDate)}.` });
  }
  const works = past.filter((e) => eventKind(e) === 'TRAVAUX').sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (works.length) {
    out.push({ key: `works:${works[0].key}`, title: works[0].title, text: `Réalisé le ${fmt.date(works[0].date)}${works[0].provider ? ` par ${works[0].provider}` : ''}.` });
  }
  const invoices = s.documents.filter((d) => d.kind === 'FACTURE' && !d.sensitive && !d.occupantData);
  if (invoices.length) {
    out.push({ key: 'invoices', title: 'Factures conservées', text: `${plural(invoices.length, 'facture')} dans le dossier du bien.` });
  }
  const parking = str(s.asset.characteristics.parking);
  if (parking) out.push({ key: 'parking', title: 'Stationnement déclaré', text: `${humanize(parking)}.` });
  const cond = conditionLabel(s);
  if (cond) out.push({ key: 'condition', title: 'État déclaré', text: `${cond}.` });
  return out;
}

/** Points forts factuels déduits (repli sans choix de l'utilisateur, 4 au plus, maquette). */
export function saleHighlights(m: MapInput): NonNullable<VenteData['highlights']> {
  return highlightSuggestions(m.source, m.today)
    .filter((h) => h.key !== 'parking' && h.key !== 'condition') // repli historique : faits datés seulement
    .slice(0, MAX_SALE_HIGHLIGHTS)
    .map((h) => ({ id: `h-${h.key.split(':')[0]}`, title: h.title, text: h.text, selected: true }));
}

/** Points forts choisis par l'utilisateur (fiche bien), dans son ordre ; `null` si aucun. */
export function chosenHighlights(m: MapInput): NonNullable<VenteData['highlights']> | null {
  const rows = infoList(m.source.additionalInfo.commercial, 'highlights')
    .map((h, i) => ({ id: str(h.id) ?? `h${i + 1}`, title: str(h.title), text: str(h.text) }))
    .filter((h): h is { id: string; title: string; text: string | null } => !!h.title)
    .slice(0, MAX_SALE_HIGHLIGHTS);
  return rows.length ? rows.map((h) => ({ ...h, selected: true })) : null;
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
    highlights: sectionOn(m, 'highlights') ? chosenHighlights(m) ?? saleHighlights(m) : [],
    followUp: sectionOn(m, 'followUp')
      ? selectedEvents(m).map((e) => ({ id: e.key, date: e.date, title: e.title, provider: str(e.provider), selected: true }))
      : [],
    documents: sortedDocuments(m).map((pd) => toDocItem(pd, 'docs', m)),
    photos: plannedPhotos(m).map((pp) => toPhotoItem(pp, m)),
  };
}
