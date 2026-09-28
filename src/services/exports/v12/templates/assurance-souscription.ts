/**
 * Template « Assurance — souscription / mise à jour » (CDC §12).
 * Famille graphique : administratif clair, couverture à bandeau marine sans photo.
 * Portage fidèle de `maquettes/assurance-souscription/template.mjs` (design
 * validé, maquetté sur la famille objet).
 *
 * Extension : `asset.infoRows` (fourni par le mappeur pour un bien immobilier
 * ou un véhicule) remplace les dix lignes « objet » du design.
 */
import {
  esc, fmt, dot, counter,
  CoverDocumentary, Section, SummaryCard, KeyValueGrid, FigureCards, LongTable, Cards,
  LineRows, DocumentList, PhotoGallery, AnnexIndex, References,
} from '../html/components';
import { planAttachments, selected, selectedPhotos } from '../html/selection';
import { assemble, coverPageLabel } from '../html/layout';
import type { SouscriptionData, RenderContext, RenderedHtml } from '../types';

export const TEMPLATE_VERSION = 'assurance_souscription-v1.0.0';
export const TEMPLATE_LABEL = 'assurance_souscription · v1.0';

type Item = NonNullable<SouscriptionData['items']>[number];

export function render(c: SouscriptionData, ctx: RenderContext): RenderedHtml {
  const { export: ex, asset, insurance = {} } = c;
  const genDate = fmt.date(ex.generatedAt);
  const f = asset.fields ?? {};
  const plan = planAttachments(c.documents, ctx.pageMap);
  const photos = selectedPhotos(c.photos, (p) => ctx.asset(p));
  const items = selected(c.items);
  const protections = selected(c.protections); // section décochable (RULE-004)
  const condition = selected(c.condition);
  const n = counter();

  // ── Couverture : objectif recommandé non bloquant (RULE-001) ; montants manuels uniquement.
  const desired = insurance.desiredInsuredAmountCents != null ? fmt.money(insurance.desiredInsuredAmountCents) : '';
  const obj = insurance.objective;
  const request = obj
    ? `<div class="eyebrow">Objet de la demande</div><div class="cover-request"><strong>${esc(obj.headline)}</strong>${obj.detail ? ` ${esc(obj.detail)}` : ''}${desired ? ` Montant assuré souhaité : ${esc(desired)}.` : ''}</div>`
    : '';
  const cover = CoverDocumentary({
    sys: ctx.sys,
    variant: 'band',
    kind: 'Assurance · souscription / mise à jour',
    kicker: asset.categoryLabel,
    titleLines: asset.titleLines ?? [asset.name],
    lead: "Dossier factuel destiné à l'assureur : identification, valeur à assurer, conditions de conservation et justificatifs.",
    leadWidth: 480,
    sheet: request + KeyValueGrid([
      { label: 'Assuré', value: insurance.insuredName },
      { label: 'Contrat concerné', value: insurance.contractLabel },
      { label: 'Date de génération', value: genDate },
      { label: 'Référence dossier', value: ex.reference },
    ]),
    pageLabel: coverPageLabel(ctx),
  });

  const s01 = Section({
    eyebrow: n(), title: 'Synthèse assurance', first: true,
    body: SummaryCard({ labelWidth: 130, rows: (c.summary ?? []).map((r) => ({ label: r.label, value: r.value, strong: r.strong !== false })) }),
  });
  const s02 = Section({
    eyebrow: n(), title: 'Informations principales', gap: 'md',
    body: KeyValueGrid(asset.infoRows ?? [
      { label: 'Catégorie', value: f.categoryLabel },
      { label: 'Numéro de série', value: fmt.mask(f.serialNumber, { start: 12, end: 3, dots: 3 }) },
      { label: 'Marque · modèle', value: dot(f.brand, f.model) },
      { label: "Date d'achat", value: dot(fmt.date(f.purchaseDate), f.purchaseCondition) },
      { label: 'Dimensions', value: f.dimensions },
      { label: 'Vendeur', value: f.seller },
      { label: 'Usage', value: f.usageLabel },
      { label: 'Lieu de conservation', value: f.storageLabel },
      { label: 'État', value: f.conditionLabel },
      { label: 'Transport', value: f.transportLabel },
    ]),
  });

  const main = items.find((i) => i.kind === 'main');
  const accessories = items.filter((i) => i.kind === 'accessory');
  const accTotal = accessories.reduce((s, i) => s + (i.valueCents ?? 0), 0);
  const justif = (i: Item) => {
    const ref = i.docId ? plan.ref(i.docId) : '';
    return esc(ref ? `${i.proofLabel ?? 'Facture'} · annexe ${ref}` : i.proofLabel ?? 'Déclaratif · sans facture');
  };
  const s03 = Section({
    eyebrow: n(), title: 'Valeur et éléments à assurer', gap: 'md',
    body: [
      FigureCards([
        ...(main ? [{ label: "Prix d'achat", value: fmt.money(main.valueCents), sub: main.proofDate ? `Facture du ${fmt.date(main.proofDate)}` : '' }] : []),
        ...(accTotal ? [{ label: 'Accessoires', value: fmt.money(accTotal), sub: insurance.accessoriesLabel }] : []),
        ...(desired ? [{ label: 'Montant assuré souhaité', value: desired, sub: "Déclaré par l'assuré", primary: true }] : []),
      ], { tight: true }),
      LongTable<Item>({
        columns: [
          { label: 'Élément', key: 'label', className: 'strong' },
          { label: 'Justificatif', render: justif, className: 'muted' },
          { label: 'Valeur', render: (i) => esc(fmt.money(i.valueCents, { decimals: true })), className: 'strong nowrap', align: 'r' },
        ],
        rows: items,
      }),
    ].filter(Boolean).join('\n'),
  });

  const s04 = Section({ eyebrow: n(), title: 'Équipements et protections', size: '', first: true, body: Cards(protections.map((p) => ({ title: p.title, text: p.text })), { small: true }) });
  const s05 = Section({ eyebrow: n(), title: 'État et entretien utile', gap: 'sm', first: !s04, body: LineRows(condition.map((e) => ({ date: e.date, title: e.title, aside: e.aside }))) });
  const s06 = Section({ eyebrow: n(), title: 'Justificatifs de valeur', gap: 'sm', first: !s04 && !s05, body: DocumentList(plan.inSection('proofs')) });
  const photoBlock = photos.length
    ? `<section class="sec gap-sm keep ${s04 || s05 || s06 ? '' : 'first'}"><div class="eyebrow">Photos d'identification</div>${PhotoGallery(photos, { layout: 'grid4', height: 120 })}</section>`
    : '';

  const index = Section({
    eyebrow: 'Annexes', title: 'Index des annexes intégrées', className: 'index', first: true,
    lead: `Documents reproduits en totalité dans les pages suivantes.${plan.zip.length ? '' : ' Aucun fichier ZIP : toutes les pièces retenues sont intégrées à ce PDF.'}`,
    body: AnnexIndex(plan.annexes),
  });
  const zip = plan.zip.length ? `<p class="zip-note">Joint au ZIP <span class="fname">${esc(ex.zipName)}</span> : ${plan.zip.map((z) => `/${esc(z.zipPath)} (${esc(fmt.bytes(z.sizeBytes))})`).join(', ')}.</p>` : '';

  const references = References({
    sys: ctx.sys,
    title: 'Sources et limites',
    exportInfo: ex,
    paragraphs: ["Les valeurs sont celles des factures jointes ou déclarées par l'assuré ; Verebona ne procède à aucune estimation. L'état et les protections sont déclaratifs et illustrés par les photos datées. Ce dossier ne vaut ni expertise, ni attestation de valeur, ni engagement de l'assureur."],
  });

  return assemble({
    ctx,
    title: `Assurance souscription — ${asset.name}`,
    headerLabel: `Assurance souscription · ${asset.shortName ?? asset.name} · ${genDate}`,
    cover,
    groups: [[s01, s02, s03].join('\n'), [s04, s05, s06, photoBlock].join('\n'), index ? index.replace(/<\/section>$/, `${zip}</section>`) : zip],
    annexes: plan.annexes,
    references,
  });
}
