/**
 * Template « Assurance — sinistre / indemnisation » (CDC §13).
 * Famille graphique : administratif probatoire, couverture à bandeau sans photo,
 * chronologie centrale (RULE-003).
 * Portage fidèle de `maquettes/assurance-sinistre/template.mjs` (design validé).
 */
import {
  esc, fmt, dot, counter,
  CoverDocumentary, Section, SummaryCard, KeyValueGrid, Note, Timeline, LongTable, PhotoGallery,
  Cards, LineRows, AnnexIndex, References, destinationPill, type PlannedDoc,
} from '../html/components';
import { planAttachments, selected, selectedPhotos } from '../html/selection';
import { assemble, coverPageLabel } from '../html/layout';
import type { SinistreData, RenderContext, RenderedHtml } from '../types';

export const TEMPLATE_VERSION = 'assurance_sinistre-v1.0.0';
export const TEMPLATE_LABEL = 'assurance_sinistre · v1.0';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

type Damage = NonNullable<SinistreData['damages']>[number];

export function render(c: SinistreData, ctx: RenderContext): RenderedHtml {
  const { export: ex, asset, claim = {} } = c;
  const genDate = fmt.date(ex.generatedAt);
  const plan = planAttachments(c.documents, ctx.pageMap);
  const photos = selectedPhotos(c.photos, (p) => ctx.asset(p));
  const events = selected(c.timeline);
  const damages = selected(c.damages);
  const actions = selected(c.actions);
  // Échanges retenus seulement s'ils sont clairement liés au sinistre (RULE-004).
  const exchanges = selected(c.exchanges).filter((x) => x.linkedToClaim !== false);
  const n = counter();

  const docs = plan.inSection('claim-docs');
  const quotes = docs.filter((d) => d.kind === 'quote').length;
  const leakReports = docs.filter((d) => d.kind === 'leak-report').length;
  const expertReports = docs.filter((d) => d.kind === 'expert-report').length;
  const zones = new Set(damages.map((d) => d.zone)).size;
  const contents = dot(
    events.length ? `chronologie de ${plural(events.length, 'événement')}` : '',
    zones ? plural(zones, 'zone endommagée', 'zones endommagées') : '',
    photos.length ? plural(photos.length, 'photo datée', 'photos datées') : '',
    quotes ? plural(quotes, 'devis', 'devis') : '',
    leakReports ? `${plural(leakReports, 'rapport')} de recherche de fuite` : '',
    expertReports ? `${plural(expertReports, 'rapport')} d'expertise` : '',
    exchanges.length ? `${plural(exchanges.length, 'échange')} avec l'assureur` : '',
  ).replace(/ · /g, ', ');

  const cover = CoverDocumentary({
    sys: ctx.sys,
    variant: 'band',
    kind: 'Assurance · sinistre / indemnisation',
    kicker: dot(asset.categoryLabel, claim.typeLabel),
    titleLines: ['Dossier de sinistre', asset.name],
    lead: `Dossier de preuves : chronologie, dommages constatés, photos datées, devis et échanges avec l'assureur.${claim.date ? ` Sinistre survenu le ${fmt.date(claim.date)}.` : ''}`,
    sheet: [
      KeyValueGrid([
        { label: 'Type de sinistre', value: claim.typeLabel },
        { label: 'Date du sinistre', value: fmt.date(claim.date) },
        { label: 'Bien', value: asset.addressLabel },
        { label: 'Déclaré le', value: fmt.date(claim.declaredAt) },
        { label: 'Contrat', value: claim.contractLabel },
        { label: 'Référence assureur', value: claim.insurerRef },
        { label: `Statut au ${genDate}`, value: claim.statusLabel },
        { label: 'Référence dossier', value: ex.reference },
      ]),
      contents ? Note(esc(`Contenu : ${contents}. Les éléments sont reproduits tels que documentés ; aucune cause ni responsabilité n'est déduite.`), { large: true }) : '',
    ].join('\n'),
    pageLabel: coverPageLabel(ctx),
  });

  const s01 = Section({
    eyebrow: n(), title: 'Synthèse du sinistre', first: true,
    body: SummaryCard({
      labelWidth: 120,
      rows: [
        { label: 'Circonstances', value: claim.circumstances, strong: false },
        { label: 'Conséquences', value: claim.consequences, strong: false },
        { label: 'Mesures prises', value: claim.measures, strong: false },
        { label: 'Statut', value: claim.statusDetail },
      ],
    }),
  });
  const s02 = Section({ eyebrow: n(), title: 'Chronologie', gap: 'md', body: Timeline(events) });

  const s03 = Section({
    eyebrow: n(), title: 'Dommages et éléments concernés', first: true,
    body: LongTable<Damage>({
      columns: [
        { label: 'Zone', key: 'zone', className: 'strong nowrap' },
        { label: 'Élément', key: 'element', className: 'muted' },
        { label: 'Constat', key: 'finding', className: 'muted' },
        { label: 'Photos', key: 'photoRefs', width: 90, className: 'muted' },
      ],
      rows: damages,
    }),
  });
  const main = photos.filter((p) => p.phase !== 'after');
  const after = photos.filter((p) => p.phase === 'after');
  const photoNo = photos.length ? n() : null;
  const s04 = main.length ? Section({
    eyebrow: photoNo, title: 'Photos du sinistre', gap: 'md', first: !s03,
    lead: 'Photos liées au sinistre, horodatées par l’appareil, non retouchées. Ordre chronologique.', leadGap: 'sm',
    body: PhotoGallery(main, { layout: 'grid3', height: 150, dim: true }),
  }) : '';

  const s05 = Section({ eyebrow: n(), title: 'Actions déjà réalisées', first: true, body: Cards(actions.map((a) => ({ when: a.whenLabel ?? fmt.date(a.date), title: a.title, text: a.text })), { small: true }) });
  const s06 = Section({
    eyebrow: n(), title: 'Devis, factures et rapports', gap: 'sm', first: !s05, size: '',
    body: LongTable<PlannedDoc>({
      columns: [
        { label: 'Document', key: 'title', className: 'strong' },
        { label: 'Émetteur', key: 'issuer', className: 'muted' },
        { label: 'Date', render: (d) => esc(fmt.date(d.date)), width: 86, className: 'muted nowrap' },
        { label: 'Montant', render: (d) => esc(d.amountCents != null ? fmt.money(d.amountCents, { decimals: true }) : '—'), width: 90, className: (d) => (d.amountCents != null ? 'strong nowrap' : 'muted'), align: 'r' },
        { label: 'Mode', render: (d) => destinationPill(d, { short: true }), width: 120, align: 'r' },
      ],
      rows: docs.filter((d) => d.kind !== 'exchanges'),
    }),
  });
  const s07 = Section({
    eyebrow: n(), title: "Échanges avec l'assureur et l'expert", gap: 'sm', first: !s05 && !s06,
    body: LineRows(exchanges.map((x) => ({ date: x.date, title: x.title, aside: dot(x.channel, x.docId ? plan.ref(x.docId) : '') }))),
  });

  const suite = after.length ? Section({
    eyebrow: `${photoNo} · suite`, title: 'Photos après séchage', size: 'sm', first: true,
    body: PhotoGallery(after, { layout: 'grid2', height: 220, dim: true }),
  }) : '';
  const hdZip = plan.zip.find((z) => z.section === 'photos-hd');
  const otherZip = plan.zip.filter((z) => z.section !== 'photos-hd');
  const leadIndex = [
    otherZip.length ? '' : 'Toutes les pièces retenues sont intégrées à ce PDF.',
    hdZip ? `Les photos haute définition (${esc(hdZip.count ?? photos.length)}) sont jointes dans <span class="fname">${esc(ex.zipName)}</span>, dossier /photos.` : '',
    otherZip.length ? `Joint au ZIP <span class="fname">${esc(ex.zipName)}</span> : ${otherZip.map((z) => `/${esc(z.zipPath)}`).join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  const index = Section({
    eyebrow: 'Annexes', title: 'Index des annexes intégrées', className: 'index', first: !suite,
    lead: leadIndex, leadGap: 'sm',
    body: AnnexIndex(plan.annexes, { density: 'tight', meta: (a) => dot(a.dateLabel ?? fmt.date(a.date), fmt.pages(a.pageCount)) }),
  });

  const references = References({
    sys: ctx.sys,
    title: 'Sources et limites',
    exportInfo: ex,
    paragraphs: ["La chronologie reprend les événements saisis dans l'agenda du bien et les dates des documents importés. Les photos sont reproduites avec leur horodatage d'origine. Les montants sont ceux des devis et factures joints. Ce dossier ne se prononce ni sur la cause, ni sur la responsabilité, ni sur le montant de l'indemnisation."],
  });

  return assemble({
    ctx,
    title: `Sinistre — ${asset.name}`,
    headerLabel: dot(claim.insurerRef ? `Sinistre ${claim.insurerRef}` : 'Sinistre', asset.name, genDate),
    cover,
    groups: [[s01, s02].join('\n'), [s03, s04].join('\n'), [s05, s06, s07].join('\n'), [suite, index].join('\n')],
    annexes: plan.annexes,
    references,
  });
}
