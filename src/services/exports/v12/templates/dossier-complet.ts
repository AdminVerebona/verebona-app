/**
 * Template « Dossier complet du bien » (CDC §9).
 * Famille graphique : documentaire premium, photo de couverture si retenue.
 * Portage fidèle de `maquettes/dossier-complet/template.mjs` (design validé).
 *
 * Extension : `asset.infoRows` (fourni par le mappeur pour un véhicule ou un
 * objet) remplace les douze lignes immobilières du design.
 */
import {
  esc, fmt, dot, counter,
  CoverDocumentary, Section, SummaryCard, KeyValueGrid, Chips, FigureCards, LongTable,
  DeadlineRows, Cards, DocumentList, PhotoGallery, ZipTable, AnnexIndex, References,
} from '../html/components';
import { planAttachments, selected, selectedPhotos } from '../html/selection';
import { assemble, coverPageLabel } from '../html/layout';
import type { DossierCompletData, RenderContext, RenderedHtml } from '../types';

export const TEMPLATE_VERSION = 'dossier_complet-v1.0.0';
export const TEMPLATE_LABEL = 'dossier_complet · v1.0';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

type FinanceLine = NonNullable<NonNullable<DossierCompletData['finance']>['lines']>[number];
type HistoryRow = NonNullable<DossierCompletData['history']>[number];

export function render(c: DossierCompletData, ctx: RenderContext): RenderedHtml {
  const { export: ex, asset } = c;
  const genDate = fmt.date(ex.generatedAt);
  const plan = planAttachments(c.documents, ctx.pageMap);
  const photos = selectedPhotos(c.photos, (f) => ctx.asset(f));
  const coverPhoto = photos.find((p) => p.cover) ?? photos[0] ?? null;
  const galleryPhotos = photos;
  const events = selected(c.history);
  const deadlines = selected(c.deadlines);
  const contracts = selected(c.contracts);
  const fin = c.finance?.enabled ? c.finance : null; // DOSSIER_COMPLET-RULE-002 : non inclus par défaut
  const keyDocs = plan.inSection('docs');
  const f = asset.fields ?? {};
  const n = counter();

  // ── Sections (numérotation continue des sections affichées).
  const infoRows = asset.infoRows ?? [
    { label: 'Type', value: f.typeLabel },
    { label: 'Surface habitable', value: fmt.area(f.livingAreaSqm) },
    { label: 'Adresse', value: f.address1 },
    { label: 'Pièces', value: f.roomsLabel },
    { label: 'Ville', value: dot(`${f.postalCode ?? ''} ${f.city ?? ''}`.trim()) },
    { label: 'Étage', value: f.floorLabel },
    { label: 'Année de construction', value: f.constructionYear },
    { label: 'État', value: f.conditionLabel },
    { label: 'DPE / GES', value: dot(f.dpe, f.ges) },
    { label: 'Chauffage', value: f.heatingLabel },
    { label: 'Copropriété', value: f.coproLabel },
    { label: 'Équipements', value: f.equipmentSummary },
  ];
  const included = dot(
    'Informations principales',
    events.length ? `historique d'entretien (${plural(events.length, 'événement')})` : '',
    keyDocs.length ? `${plural(keyDocs.length, 'document clé', 'documents clés')}` : '',
    galleryPhotos.length ? plural(galleryPhotos.length, 'photo') : '',
    contracts.length ? `${plural(contracts.length, 'garantie en cours', 'garanties en cours')}` : '',
  ).replace(/ · /g, ', ');

  const s01 = Section({
    eyebrow: n(), title: 'Synthèse du dossier', first: true,
    body: SummaryCard({
      rows: [
        { label: 'Bien', value: c.summary?.asset },
        { label: 'Statut', value: c.summary?.status },
        { label: 'État déclaré', value: c.summary?.condition },
        { label: 'Contenu inclus', value: included, strong: false },
        { label: 'Source', value: `Données saisies et documents importés dans Verebona, à la date du ${genDate}`, strong: false },
      ],
    }),
  });
  const s02 = Section({ eyebrow: n(), title: 'Informations principales', body: [KeyValueGrid(infoRows), Chips(f.equipmentChips)].filter(Boolean).join('\n') });

  const works = selected(fin?.lines);
  const workTotal = works.filter((l) => l.kind === 'works').reduce((s, l) => s + l.amountCents, 0);
  const workYears = [...new Set(works.filter((l) => l.kind === 'works').map((l) => String(l.date).slice(0, 4)))].sort();
  const s03 = fin ? Section({
    eyebrow: n(), title: 'Valeur, acquisition et informations financières',
    lead: "Section incluse à la demande de l'utilisateur. Montants tels que saisis dans Verebona.", leadGap: 'lg', first: true,
    body: [
      FigureCards([
        { label: "Prix d'acquisition", value: fmt.money(fin.acquisition?.priceCents), sub: fin.acquisition?.deedDate ? `Acte du ${fmt.date(fin.acquisition.deedDate)}` : '' },
        { label: 'Valeur retenue', value: fmt.money(fin.retainedValue?.amountCents), sub: dot(fin.retainedValue?.sourceLabel, fmt.date(fin.retainedValue?.date)) },
        ...(workTotal ? [{ label: 'Travaux cumulés', value: fmt.money(workTotal), sub: dot(plural(works.filter((l) => l.kind === 'works').length, 'opération'), workYears.length > 1 ? `${workYears[0]}–${workYears.at(-1)}` : workYears[0]) }] : []),
      ], { className: 'fin' }),
      LongTable<FinanceLine>({
        columns: [
          { label: 'Poste', key: 'label', className: 'strong' },
          { label: 'Date', render: (l) => esc(fmt.date(l.date)), className: 'muted' },
          { label: 'Montant', render: (l) => esc(fmt.money(l.amountCents, { decimals: true })), className: 'strong nowrap', align: 'r' },
        ],
        rows: works,
      }),
      fin.charges?.length ? `<div class="eyebrow sub-eyebrow">Charges et taxes déclarées</div>${KeyValueGrid(fin.charges.map((ch) => ({ label: ch.label, value: ch.amountCents != null ? `${fmt.money(ch.amountCents)} / ${ch.period ?? 'an'}` : '' })), { className: 'after-eyebrow' })}` : '',
    ].filter(Boolean).join('\n'),
  }) : '';

  const s04 = Section({
    eyebrow: n(), title: "Calendrier et historique d'entretien", first: true,
    body: [
      LongTable<HistoryRow>({
        airy: true,
        columns: [
          { label: 'Date', render: (e) => esc(fmt.date(e.date)), width: 92, className: 'muted num' },
          { label: 'Événement', key: 'title', className: 'strong' },
          { label: 'Type', key: 'typeLabel', width: 130, className: 'muted' },
          { label: 'Intervenant', key: 'provider', width: 150, className: 'muted' },
        ],
        rows: events.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))),
      }),
      deadlines.length ? `<div class="eyebrow sub-eyebrow due-eyebrow">Échéances à venir</div>${DeadlineRows(deadlines, { refDate: ex.generatedAt })}` : '',
    ].filter(Boolean).join('\n'),
  });
  const s05 = Section({
    eyebrow: n(), title: 'Garanties et contrats utiles', size: 'sm', gap: 'lg', first: !s04,
    body: Cards(contracts.map((k) => ({ title: k.title, text: k.detail })), { small: true }),
  });

  const s06 = Section({
    eyebrow: n(), title: 'Documents clés', first: true,
    lead: 'Seuls les documents retenus lors de la préparation figurent ici. « Intégré » : reproduit en annexe de ce PDF. « Joint » : fourni dans l’archive ZIP.', leadGap: 'md',
    body: DocumentList(keyDocs),
  });
  // Photos : 2 sous les documents, puis pages « suite » de 4 photos (maquette).
  const photoNo = galleryPhotos.length ? n() : null;
  const s07 = photoNo ? Section({
    eyebrow: photoNo, title: 'Photos du bien', first: !s06,
    body: PhotoGallery(galleryPhotos.slice(0, 2), { layout: 'grid2', height: 190 }),
  }) : '';
  const suites: string[] = [];
  for (let i = 2; i < galleryPhotos.length; i += 4) {
    suites.push(Section({
      eyebrow: `${photoNo} · suite`, title: 'Photos du bien', size: 'sm', first: true,
      body: PhotoGallery(galleryPhotos.slice(i, i + 4), { layout: 'grid2', height: 280 }),
    }));
  }

  const s08 = plan.zip.length ? Section({
    eyebrow: n(), title: 'Documents joints au ZIP', first: true,
    lead: `Fichiers livrés dans l'archive <span class="fname">${esc(ex.zipName)}</span>, non reproduits dans ce PDF.`,
    body: ZipTable(plan.zip),
  }) : '';
  const index = Section({
    eyebrow: 'Annexes', title: 'Index des annexes intégrées', className: 'index', gap: 'xl', first: !s08,
    lead: 'Les documents ci-dessous sont reproduits en totalité dans les pages qui suivent. Chaque page porte une bannière rappelant le document source.',
    body: AnnexIndex(plan.annexes),
  });

  const sectionsCount = [s01, s02, s03, s04, s05, s06, s07, s08].filter(Boolean).length;
  const cover = CoverDocumentary({
    sys: ctx.sys,
    variant: 'premium',
    kind: 'Dossier complet du bien',
    kicker: asset.categoryLabel,
    titleLines: asset.titleLines ?? [asset.name],
    lead: "Dossier patrimonial général : synthèse, informations principales, historique d'entretien, documents et photos du bien.",
    photo: coverPhoto,
    meta: [
      { label: 'Date de génération', value: genDate },
      { label: 'Contenu', value: dot(plural(sectionsCount, 'section'), keyDocs.length ? plural(keyDocs.length, 'document') : '', galleryPhotos.length ? plural(galleryPhotos.length, 'photo') : '') },
      { label: 'Référence', value: ex.reference },
    ],
    pageLabel: coverPageLabel(ctx),
  });

  const references = References({
    sys: ctx.sys,
    title: 'Méthode, sources et limites',
    exportInfo: ex,
    paragraphs: ["Les informations de ce dossier proviennent des données saisies et des documents importés par l'utilisateur dans Verebona. Les documents décochés lors de la préparation n'y figurent pas. Les valeurs et montants sont reproduits tels que saisis, sans estimation ni inférence."],
  });

  return assemble({
    ctx,
    title: `Dossier complet — ${asset.name}`,
    headerLabel: `Dossier complet · ${asset.name} · ${genDate}`,
    cover,
    groups: [
      [s01, s02].join('\n'),
      s03,
      [s04, s05].join('\n'),
      [s06, s07].join('\n'),
      ...suites,
      [s08, index].join('\n'),
    ],
    annexes: plan.annexes,
    references,
  });
}
