/**
 * Template « Kit de mise en vente » (CDC §10).
 * Famille graphique : marketing modéré, photo de couverture plein cadre.
 * Portage fidèle de `maquettes/vente/template.mjs` (design validé, maquetté sur
 * la famille véhicule).
 *
 * Extension : `asset.infoRows` (fourni par le mappeur pour un bien immobilier
 * ou un objet) remplace les douze lignes « véhicule » du design.
 */
import {
  esc, fmt, dot, counter,
  CoverMarketing, Section, SummaryCard, KeyValueGrid, PriceBlock, Cards, PhotoGallery,
  LongTable, DocumentList, AnnexIndex, References,
} from '../html/components';
import { planAttachments, selected, selectedPhotos } from '../html/selection';
import { assemble, coverPageLabel } from '../html/layout';
import type { VenteData, RenderContext, RenderedHtml } from '../types';

export const TEMPLATE_VERSION = 'vente-v1.0.0';
export const TEMPLATE_LABEL = 'vente · v1.0';

type FollowUp = NonNullable<VenteData['followUp']>[number];

export function render(c: VenteData, ctx: RenderContext): RenderedHtml {
  const { export: ex, asset, sale = {} } = c;
  const genDate = fmt.date(ex.generatedAt);
  const f = asset.fields ?? {};
  const plan = planAttachments(c.documents, ctx.pageMap);
  const photos = selectedPhotos(c.photos, (p) => ctx.asset(p));
  const coverPhoto = photos[0] ?? null; // première photo retenue en visuel principal (§7.3)
  const followUp = selected(c.followUp);
  const highlights = selected(c.highlights);
  const n = counter();

  // Prix : saisie manuelle uniquement, jamais inféré d'une estimation (VENTE-RULE-001).
  const price = sale.desiredPriceCents != null ? fmt.money(sale.desiredPriceCents) : '';
  const availability = sale.availabilityDate ? `À partir du ${fmt.date(sale.availabilityDate)}` : '';

  const cover = CoverMarketing({
    sys: ctx.sys,
    kind: 'Kit de mise en vente',
    kicker: asset.categoryLabel,
    titleLines: asset.titleLines ?? [asset.name],
    lead: [sale.pitch, price ? `Prix souhaité : ${price}.` : ''].filter(Boolean).join(' '),
    photo: coverPhoto,
    meta: [
      { label: 'Localisation', value: f.locationLabel },
      { label: 'Disponibilité', value: availability },
      { label: 'Dossier édité le', value: genDate },
    ],
    pageLabel: coverPageLabel(ctx),
  });

  const s01 = Section({ eyebrow: n(), title: 'Synthèse de mise en vente', first: true, body: SummaryCard({ paragraphs: c.summary }) });
  const s02 = Section({
    eyebrow: n(), title: 'Informations principales',
    body: KeyValueGrid(asset.infoRows ?? [
      { label: 'Marque · modèle', value: dot(f.brand, f.model) },
      { label: 'Kilométrage', value: dot(fmt.km(f.mileageKm), f.mileageDate ? `relevé ${fmt.date(f.mileageDate)}` : '') },
      { label: 'Année', value: f.modelYear },
      { label: 'Motorisation', value: f.motorLabel },
      { label: "Date d'achat", value: dot(fmt.date(f.purchaseDate), f.purchaseCondition) },
      { label: 'Batterie', value: f.batteryLabel },
      { label: 'N° de cadre', value: fmt.mask(f.frameNumber, { start: 5, end: 4, dots: 5 }) },
      { label: 'Transmission', value: f.transmissionLabel },
      { label: 'Couleur', value: f.color },
      { label: 'État déclaré', value: f.conditionLabel },
      { label: 'Marquage', value: f.markingLabel },
      { label: 'Stationnement', value: f.parkingLabel },
    ]),
  });
  const s03 = Section({
    eyebrow: n(), title: 'Conditions de vente',
    body: PriceBlock({
      price: price ? { label: 'Prix souhaité', value: price, sub: sale.newPriceCents ? `Prix d'achat neuf : ${fmt.money(sale.newPriceCents)}` : '' } : null,
      rows: [
        { label: 'Disponibilité', value: dot(availability, sale.availabilityComment) },
        { label: 'Accessoires inclus', value: sale.includedAccessories },
        { label: 'Conditions', value: sale.saleConditions },
        { label: 'Contact · visites', value: sale.contactInstructions },
      ],
    }),
  });

  const s04 = Section({
    eyebrow: n(), title: 'Mise en valeur du bien', first: true,
    lead: "Éléments documentés dans Verebona par une facture, un événement d'entretien ou une donnée saisie.",
    body: Cards(highlights.map((h) => ({ title: h.title, text: h.text }))),
  });
  const s05 = Section({ eyebrow: n(), title: 'Photos', gap: 'md', first: !s04, body: PhotoGallery(photos, { layout: 'feature' }) });

  const s06 = Section({
    eyebrow: n(), title: 'Éléments de suivi', first: true,
    body: LongTable<FollowUp>({
      airy: true,
      columns: [
        { label: 'Date', render: (e) => esc(fmt.date(e.date)), width: 92, className: 'muted' },
        { label: 'Événement', key: 'title', className: 'strong' },
        { label: 'Kilométrage', render: (e) => esc(fmt.km(e.mileageKm)), width: 110, className: 'muted nowrap' },
        { label: 'Intervenant', key: 'provider', width: 140, className: 'muted' },
      ],
      rows: followUp,
    }),
  });
  const docs = plan.inSection('docs');
  const s07 = Section({
    eyebrow: n(), title: 'Documents utiles à la vente', first: !s06,
    lead: esc(c.documentsNote ?? 'Documents sélectionnés par le vendeur.'),
    body: DocumentList(docs),
  });
  const index = Section({
    eyebrow: 'Annexes', title: 'Index des annexes intégrées', className: 'index', size: 'sm', first: !s06 && !s07,
    body: AnnexIndex(plan.annexes, { density: 'mid' }),
  });
  const zipNote = plan.zip.length && ex.zipName
    ? `<p class="zip-note">Joint au ZIP <span class="fname">${esc(ex.zipName)}</span> : ${plan.zip.map((z) => `/${esc(z.zipPath)} (${esc(fmt.bytes(z.sizeBytes))})`).join(', ')}.</p>`
    : '';

  const references = References({
    sys: ctx.sys,
    title: 'Sources et limites',
    exportInfo: ex,
    paragraphs: ["Le prix, les conditions et les accessoires inclus sont saisis par le vendeur. L'état, l'entretien et le kilométrage sont reproduits tels que documentés dans Verebona ; aucune qualité n'est déduite. Ce dossier n'engage pas contractuellement le vendeur et ne remplace pas un contrat de vente."],
  });

  return assemble({
    ctx,
    title: `Kit de vente — ${asset.name}`,
    headerLabel: `Kit de vente · ${asset.name} · ${genDate}`,
    cover,
    groups: [
      [s01, s02, s03].join('\n'),
      [s04, s05].join('\n'),
      [s06, s07, index ? index.replace('</section>', `${zipNote}</section>`) : zipNote].join('\n'),
    ],
    annexes: plan.annexes,
    references,
  });
}
