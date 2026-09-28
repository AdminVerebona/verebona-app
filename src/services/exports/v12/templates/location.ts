/**
 * Template « Dossier de mise en location » (CDC §11).
 * Famille graphique : marketing modéré immobilier, photo de couverture plein cadre.
 * Portage fidèle de `maquettes/location/template.mjs` (design validé).
 */
import {
  esc, fmt, dot, isEmpty, counter,
  CoverMarketing, Section, SummaryCard, KeyValueGrid, FigureCards, Chips, PhotoGallery,
  LineRows, DocumentList, AnnexIndex, References,
} from '../html/components';
import { planAttachments, selected, selectedPhotos } from '../html/selection';
import { assemble, coverPageLabel } from '../html/layout';
import type { LocationData, RenderContext, RenderedHtml } from '../types';

export const TEMPLATE_VERSION = 'location-v1.0.0';
export const TEMPLATE_LABEL = 'location · v1.0';

export const LEASE_LABELS: Record<string, string> = { NON_MEUBLE: 'Non meublé', MEUBLE: 'Meublé', MOBILITE: 'Bail mobilité', ETUDIANT: 'Bail étudiant', SAISONNIER: 'Saisonnier', AUTRE: 'Autre' };

export function render(c: LocationData, ctx: RenderContext): RenderedHtml {
  const { export: ex, asset, rental = {} } = c;
  const genDate = fmt.date(ex.generatedAt);
  const f = asset.fields ?? {};
  const plan = planAttachments(c.documents, ctx.pageMap);
  const photos = selectedPhotos(c.photos, (p) => ctx.asset(p));
  const followUp = selected(c.followUp).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const n = counter();

  // Montants manuels uniquement (LOCATION-RULE-001) ; surface locative prioritaire dans ce PDF seulement (RULE-003).
  const area = fmt.area(rental.rentalAreaSqm ?? f.livingAreaSqm);
  const rent = rental.monthlyRentCents != null ? fmt.money(rental.monthlyRentCents) : '';
  const charges = rental.monthlyChargesCents != null ? fmt.money(rental.monthlyChargesCents) : '';
  const deposit = rental.depositCents != null ? fmt.money(rental.depositCents) : '';
  const months = rental.monthlyRentCents ? (rental.depositCents ?? NaN) / rental.monthlyRentCents : null;
  const depositSub = months === 1 ? 'un mois de loyer' : months === 2 ? 'deux mois de loyer' : '';
  const lease = dot(LEASE_LABELS[String(rental.leaseType ?? '')], rental.leaseDurationLabel);
  const available = rental.availabilityDate ? fmt.date(rental.availabilityDate) : '';

  const cover = CoverMarketing({
    sys: ctx.sys,
    kind: 'Dossier de mise en location',
    kicker: dot(asset.categoryLabel, area),
    titleLines: asset.titleLines ?? [asset.name],
    lead: [rental.pitch, rent ? `Loyer ${rent} hors charges.` : '', available ? `Disponible le ${available}.` : ''].filter(Boolean).join(' '),
    photo: photos[0] ?? null,
    meta: [
      { label: 'Loyer', value: rent ? `${rent}${charges ? ` + ${charges} de charges` : ''}` : '' },
      { label: 'Bail', value: lease },
      { label: 'Dossier édité le', value: genDate },
    ],
    pageLabel: coverPageLabel(ctx),
  });

  const s01 = Section({ eyebrow: n(), title: 'Synthèse locative', first: true, body: SummaryCard({ paragraphs: c.summary }) });
  const s02 = Section({
    eyebrow: n(), title: 'Informations principales', gap: 'md',
    body: KeyValueGrid([
      { label: 'Surface habitable', value: area },
      { label: 'Pièces', value: f.roomsLabel },
      { label: 'Localisation', value: f.locationLabel },
      { label: 'Étage', value: f.floorLabel },
      { label: 'État', value: f.conditionLabel },
      { label: 'Énergie', value: dot(f.dpe && `DPE ${f.dpe}`, f.ges && `GES ${f.ges}`) },
      { label: 'Exposition', value: f.exposure },
      { label: 'Transports', value: f.transport },
    ]),
  });
  const s03 = Section({
    eyebrow: n(), title: 'Conditions de location', gap: 'md',
    body: [
      FigureCards([
        { label: 'Loyer mensuel', value: rent, sub: 'hors charges', primary: true },
        { label: 'Charges', value: charges, sub: rental.chargesLabel ?? 'provision mensuelle' },
        { label: 'Dépôt de garantie', value: deposit, sub: depositSub },
      ], { tight: true, large: true }),
      KeyValueGrid([
        { label: 'Type de bail', value: [lease, rental.leaseUsageLabel].filter((x) => !isEmpty(x)).join(', ') },
        { label: 'Disponibilité', value: dot(available, rental.availabilityComment) },
        { label: 'Conditions', value: rental.rentalConditions },
        { label: 'Contact · visites', value: rental.contactInstructions },
      ], { variant: 'stack' }),
    ].filter(Boolean).join('\n'),
  });

  // Équipements et diagnostics utiles : filtre strict (LOCATION-PDF-05).
  const e = c.energy ?? {};
  const energyGrid = KeyValueGrid([
    { label: 'DPE · GES', value: dot(e.dpe && `${e.dpe}${e.consumption ? ` (${e.consumption})` : ''}`, e.ges) },
    { label: 'Chauffage', value: e.heating },
    { label: 'Eau chaude', value: e.hotWater },
    { label: 'Ventilation', value: e.ventilation },
    { label: 'Stationnement', value: e.parking },
  ], { variant: 'one' });
  const chips = Chips(c.equipments, { large: true });
  const s04 = Section({
    eyebrow: n(), title: 'Équipements et diagnostics utiles', first: true,
    body: chips || energyGrid
      ? `<div class="cols2">${chips ? `<div><div class="eyebrow">Équipements inclus</div>${chips}</div>` : ''}${energyGrid ? `<div><div class="eyebrow">Énergie et confort</div>${energyGrid}</div>` : ''}</div>`
      : '',
  });
  const s05 = Section({ eyebrow: n(), title: 'Photos', gap: 'md', first: !s04, body: PhotoGallery(photos, { layout: 'hero' }) });

  // Suivi rassurant sans coûts (LOCATION-RULE-004) ; données d'occupant jamais rendues (selected()).
  const s06 = Section({
    eyebrow: n(), title: 'Éléments de suivi', first: true,
    lead: 'Entretien récent et diagnostics, sans détail de coûts.', leadGap: 'sm',
    body: LineRows(followUp.map((ev) => ({ date: ev.date, title: ev.title, aside: ev.provider }))),
  });
  const s07 = Section({ eyebrow: n(), title: 'Documents utiles à la location', gap: 'md', first: !s06, body: DocumentList(plan.inSection('docs')) });
  const zipNote = plan.zip.length && ex.zipName
    ? `<p class="zip-note">Joint au ZIP <span class="fname">${esc(ex.zipName)}</span> : ${plan.zip.map((z) => `/${esc(z.zipPath)} (${esc(fmt.bytes(z.sizeBytes))})`).join(', ')}.</p>`
    : '';
  const index = plan.annexes.length || zipNote ? Section({
    eyebrow: 'Archive et annexes', title: plan.annexes.length ? 'Index des annexes intégrées' : 'Documents joints au ZIP', size: 'sm', gap: 'md', className: 'index', first: !s06 && !s07,
    body: [AnnexIndex(plan.annexes, { density: 'tight', meta: (a) => fmt.pages(a.pageCount) }), zipNote].filter(Boolean).join('\n'),
  }) : '';

  const references = References({
    sys: ctx.sys,
    title: 'Sources et limites',
    exportInfo: ex,
    paragraphs: ["Loyer, charges, dépôt et conditions sont saisis par le bailleur. Ce dossier présente le logement ; il ne vaut ni offre de location, ni bail, ni engagement juridique. Les diagnostics reproduits en annexe restent les seuls documents de référence."],
  });

  return assemble({
    ctx,
    title: `Mise en location — ${asset.name}`,
    headerLabel: `Mise en location · ${asset.shortName ?? asset.name} · ${genDate}`,
    cover,
    groups: [[s01, s02, s03].join('\n'), [s04, s05].join('\n'), [s06, s07, index].join('\n')],
    annexes: plan.annexes,
    references,
  });
}
