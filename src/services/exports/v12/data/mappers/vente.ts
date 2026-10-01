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

// ─── Annonces hors PDF (VENTE-RULE-002, lot 19) ─────────────────────────────

/** Longueurs maximales des annonces (caractères). */
export const SALE_AD_LIMITS = { short: 280, detailed: 2000 } as const;

export interface SaleAds {
  /** Annonce courte : une phrase, faits principaux, prix si saisi. */
  short: string;
  /** Annonce détaillée : présentation, caractéristiques, points forts, conditions. */
  detailed: string;
  /** Aucun prix saisi : l'annonce n'en affiche pas (VENTE-RULE-001). */
  priceMissing: boolean;
  /** Composition sans appel modèle, à partir des données du dossier. */
  generatedBy: 'deterministic';
}

/**
 * LISTE BLANCHE des lignes publiables par famille (relecture lot 19) : une
 * ligne de `familyInfoRows` absente d'ici n'entre JAMAIS dans une annonce —
 * un champ ajouté plus tard à la fiche ne fuit pas par défaut. Exclus en
 * particulier : adresse, immatriculation, VIN, numéro de série, lieu de
 * conservation, provenance, date d'achat d'un véhicule, et tout identifiant.
 */
export const AD_PUBLISHABLE_ROWS: Readonly<Record<'IMMOBILIER' | 'VEHICULE' | 'OBJET', ReadonlySet<string>>> = {
  IMMOBILIER: new Set([
    'Type', 'Surface habitable', 'Pièces', 'Ville', 'Étage', 'Année de construction', 'État',
    'DPE / GES', 'Chauffage', 'Surface du terrain', 'Niveaux',
  ]),
  VEHICULE: new Set([
    'Marque · modèle', 'Kilométrage', 'Année', 'Motorisation', 'Puissance', 'Première mise en circulation',
    'État déclaré', 'Places',
  ]),
  OBJET: new Set(['Catégorie', 'Marque · modèle', "Date d'achat", 'Dimensions', 'Poids', 'État', 'Accessoires']),
};

/** Équipements notables repris dans une annonce (noms, 6 au plus). */
const AD_MAX_EQUIPMENTS = 6;

const espaces = (t: string) => t.replace(/[  ]/g, ' ').replace(/[ \t]+/g, ' ').trim();
const borne = (t: string, max: number) => (t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…`);

/**
 * Annonces courte et détaillée du « Kit de mise en vente », affichées dans
 * l'interface de préparation, HORS PDF (CDC 16 VENTE-RULE-002).
 *
 * Composition DÉTERMINISTE (aucun appel modèle) à partir des seules données
 * du dossier — mêmes sources que le PDF : faits de la fiche (lignes de la
 * famille, sans identifiant ni adresse précise), description ou synthèse
 * factuelle, argumentaire saisi, points forts choisis (à défaut : faits
 * documentés), conditions de vente saisies. Lignes de la fiche : LISTE
 * BLANCHE par famille (`AD_PUBLISHABLE_ROWS`), équipements par leur nom.
 *   · prix : UNIQUEMENT `commercial.desiredSalePriceCents`, jamais estimé
 *     (VENTE-RULE-001) ; absent → aucune mention de prix ;
 *   · ton : marketing modéré, sans superlatif ni promesse non prouvée
 *     (§10, VENTE-PDF-02) — aucun qualificatif n'est ajouté aux faits ;
 *   · longueur : courte ≤ 280 caractères, détaillée ≤ 2 000.
 */
export function saleAds(s: ExportSource, today: string): SaleAds {
  const c = s.additionalInfo.commercial;
  const priceCents = infoCents(c, 'desiredSalePriceCents');
  const prix = priceCents != null ? fmt.money(priceCents) : null;
  const publiables = AD_PUBLISHABLE_ROWS[s.family as keyof typeof AD_PUBLISHABLE_ROWS] ?? new Set<string>();
  const rows = familyInfoRows(s)
    .filter((r) => publiables.has(r.label) && r.value !== null && r.value !== undefined && String(r.value).trim() !== '')
    .map((r) => ({ label: r.label, value: espaces(String(r.value)) }));
  const equipements = [...new Set([...s.asset.equipmentList, ...s.equipments.map((e) => e.name)]
    .map((x) => espaces(String(x ?? ''))).filter(Boolean))].slice(0, AD_MAX_EQUIPMENTS);
  if (equipements.length) rows.push({ label: 'Équipements', value: equipements.join(', ') });

  // ── Courte ──
  const titre = espaces(s.asset.name);
  const faits = rows.filter((r) => r.label !== 'Type' && r.label !== 'État' && r.label !== 'État déclaré').slice(0, 3).map((r) => r.value);
  const court = espaces(`${titre}${faits.length ? ` : ${faits.join(', ')}` : ''}.${prix ? ` Prix : ${prix}.` : ''}`);

  // ── Détaillée ──
  const blocs: string[] = [];
  const presentation = factualSummary(s);
  if (presentation) blocs.push(espaces(presentation));
  const argumentaire = info(c, 'salePitch');
  if (argumentaire) blocs.push(espaces(argumentaire));
  if (rows.length) blocs.push(['Caractéristiques :', ...rows.map((r) => `- ${r.label} : ${r.value}`)].join('\n'));
  const choisis = infoList(c, 'highlights')
    .map((h) => ({ title: str(h.title), text: str(h.text) }))
    .filter((h): h is { title: string; text: string | null } => !!h.title)
    .slice(0, MAX_SALE_HIGHLIGHTS);
  const points = choisis.length ? choisis : highlightSuggestions(s, today).slice(0, MAX_SALE_HIGHLIGHTS);
  if (points.length) blocs.push(['Points forts :', ...points.map((h) => `- ${espaces(h.text ? `${h.title} : ${h.text}` : h.title)}`)].join('\n'));
  const conditions = [
    prix ? `Prix : ${prix}` : null,
    info(c, 'availabilityDate') ? `Disponible à partir du ${fmt.date(info(c, 'availabilityDate'))}` : null,
    info(c, 'availabilityComment'),
    info(c, 'includedAccessories') ? `Inclus : ${info(c, 'includedAccessories')}` : null,
    info(c, 'saleConditions'),
    info(c, 'contactInstructions') ? `Contact : ${info(c, 'contactInstructions')}` : null,
  ].filter((x): x is string => !!x).map((x) => `- ${espaces(x)}`);
  if (conditions.length) blocs.push(['Conditions de vente :', ...conditions].join('\n'));

  return {
    short: borne(court, SALE_AD_LIMITS.short),
    detailed: borne(blocs.join('\n\n'), SALE_AD_LIMITS.detailed),
    priceMissing: priceCents == null,
    generatedBy: 'deterministic',
  };
}
