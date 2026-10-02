/**
 * Template CIL — Carnet d'information du logement (CDC §8, §20).
 * Famille graphique : documentaire réglementaire, couverture sans photo.
 * Portage fidèle de `maquettes/cil/template.mjs` (design validé).
 */
import {
  esc, fmt, dot, isEmpty,
  CoverDocumentary, Section, BlockHeader, StatusPill, StatusCounters, KeyValueGrid,
  LongTable, cellTS, DocumentList, EnergyTiles, Note, ZipTable, AnnexIndex, References,
  type PlannedDoc,
} from '../html/components';
import { planAttachments } from '../html/selection';
import { assemble, coverPageLabel } from '../html/layout';
import type { CilData, RenderContext, RenderedHtml, ToneLabel } from '../types';

export const TEMPLATE_VERSION = 'cil-v1.0.0';
export const TEMPLATE_LABEL = 'cil · v1.0';

const BLOCKS: Record<string, string> = {
  B1: 'Identification du logement',
  B2: 'Contexte de constitution du CIL',
  B3: 'Plans et coupes',
  B4: 'Réseaux',
  B5: 'Matériaux à incidence énergétique',
  B6: 'Équipements à incidence énergétique',
  B7: 'Travaux de rénovation énergétique',
  B8: 'DPE / performance énergétique',
  B9: 'Documents annexes',
};
/** Titres de bloc dans les sections quand ils diffèrent du libellé de l'état (maquette). */
const SECTION_TITLES: Record<string, string> = { B8: 'Performance énergétique' };
const BLOCKING = ['B1', 'B3', 'B8']; // CIL-RULE-002
const UNKNOWN_TEXT = 'Aucune donnée ni aucun document dans Verebona pour ce bloc à la date de génération.';

type Block = CilData['cil']['blocks'][number];

export function render(c: CilData, ctx: RenderContext): RenderedHtml {
  const { export: ex, asset, cil } = c;
  const plan = planAttachments(c.documents, ctx.pageMap);
  for (const a of plan.annexes) a.bannerExtra = a.section; // bannière : « Plan de construction · B3 · 15/09/2023 »
  const genDate = fmt.date(ex.generatedAt);
  const loc = asset.location ?? {};
  const cityLine = dot(`${loc.postalCode ?? ''} ${loc.city ?? ''}`.trim());

  // ── Blocs affichés : B9 masqué s'il n'a ni document ni statut utile (CIL-PDF-11).
  const blockOf: Record<string, Block> = Object.fromEntries(cil.blocks.map((b) => [b.code, b]));
  const hasDocs = (code: string) => plan.inSection(code).length > 0;
  const shown = cil.blocks.filter((b) => b.code !== 'B9' || hasDocs('B9') || (b.status !== 'unknown' && !isEmpty(b.source)));
  const count = (s: string) => shown.filter((b) => b.status === s).length;
  const nOk = count('complete');
  const nTodo = count('unknown') + count('invalid');
  const nNa = count('not_applicable');
  const nBlocking = shown.filter((b) => BLOCKING.includes(b.code) && b.status === 'missing').length;
  const blocksSummary = dot(
    `${nOk} sur ${shown.length}`,
    nTodo ? `${nTodo} à compléter` : '',
    nBlocking ? `${nBlocking} manquant${nBlocking > 1 ? 's' : ''}` : '',
    nNa ? `${nNa} non applicable${nNa > 1 ? 's' : ''}` : '',
  );

  // ── Couverture (CIL-PDF-01) : jamais « document réglementaire certifié ».
  const cover = CoverDocumentary({
    sys: ctx.sys,
    variant: 'regulatory',
    kind: "Carnet d'information du logement",
    kicker: dot(asset.categoryLabel, 'CIL'),
    titleLines: asset.titleLines ?? [asset.name],
    address: [loc.address1, cityLine].filter((x): x is string => !isEmpty(x)),
    note: {
      label: 'Nature du document',
      text: `État des informations et documents disponibles dans Verebona à la date du ${genDate}, organisés selon les blocs du carnet d'information du logement. Ce document n'est pas un carnet certifié ni une validation réglementaire.`,
    },
    meta: [
      { label: 'Date de génération', value: genDate },
      { label: 'Blocs renseignés', value: blocksSummary },
      { label: 'Référence', value: ex.reference },
    ],
    pageLabel: coverPageLabel(ctx),
  });

  // ── 01 · État des informations disponibles (CIL-PDF-02).
  const overview = Section({
    eyebrow: '01',
    title: 'État des informations disponibles',
    lead: 'Statut de chaque bloc du carnet, établi à partir des données et documents présents dans Verebona. Les blocs non applicables ne sont pas comptés comme manquants.',
    leadGap: 'lg',
    first: true,
    body: [
      StatusCounters([
        { value: nOk, label: 'Blocs renseignés', tone: 'ok' },
        { value: nTodo, label: 'À compléter', tone: 'warn' },
        { value: nBlocking, label: 'Bloquants manquants', tone: 'bad' },
        { value: nNa, label: 'Non applicable', tone: '' },
      ]),
      LongTable<Block>({
        airy: true,
        columns: [
          { label: 'Bloc', key: 'code', width: 44, className: 'code' },
          { label: 'Libellé', render: (b) => esc(b.label ?? BLOCKS[b.code]), className: 'strong' },
          { label: 'Source dans Verebona', key: 'source', width: 190, className: 'muted' },
          { label: 'Statut', render: (b) => StatusPill(b.status), width: 120, align: 'r' },
        ],
        rows: shown,
      }),
      Note(esc("« À compléter » signale un bloc sans donnée ni document dans Verebona ; il ne préjuge pas de l'existence réelle de ces éléments. Les blocs B1, B3 et B8 conditionnent la génération."), { after: true }),
    ].join('\n'),
  });

  // ── Blocs B1 à B9.
  const block = (code: string, body: string, { first = false }: { first?: boolean } = {}) => {
    const b = blockOf[code];
    if (!b || !shown.includes(b)) return '';
    const na = b.status === 'not_applicable';
    const hasContent = !isEmpty(body);
    // B9 non applicable mais porteur de documents : en-tête sans pastille (maquette).
    const pill = na && hasContent ? null : b.status;
    let content: string | undefined = body;
    if (!hasContent) {
      if (na) content = `<p class="blk-note">${esc(b.resolution ?? 'Bloc déclaré non applicable par l’utilisateur.')}</p>`;
      else if (b.status === 'unknown' || b.status === 'missing' || b.status === 'invalid') content = `<p class="blk-note">${esc(UNKNOWN_TEXT)}</p>`;
    }
    return `<section class="blk ${first ? 'first' : ''}">${BlockHeader({ code, title: SECTION_TITLES[code] ?? b.label ?? BLOCKS[code], status: pill })}<div class="blk-body">${content ?? ''}</div></section>`;
  };

  const b1 = KeyValueGrid([
    { label: 'Adresse', value: loc.address1 },
    { label: 'Type', value: asset.typeLabel },
    { label: 'Code postal · ville', value: cityLine },
    { label: 'Surface habitable', value: fmt.area(asset.livingAreaSqm) },
    { label: 'Étage · lot', value: asset.floorLotLabel },
    { label: 'Année de construction', value: asset.constructionYear },
  ]);
  const p = cil.profile ?? {};
  const b2 = KeyValueGrid([
    { label: 'Déclencheur', value: p.triggerLabel },
    { label: 'Date', value: fmt.date(p.triggerDate) },
    { label: 'Autorisation', value: p.authorization },
    { label: 'Motif', value: p.reason },
  ]);
  const b3 = DocumentList(plan.inSection('B3'));

  const withRef = (text: unknown, docId: unknown) => {
    const ref = docId ? plan.ref(String(docId)) : '';
    return esc(ref ? `${text} (annexe ${ref})` : text);
  };
  type Network = NonNullable<CilData['cil']['networks']>[number];
  const b4 = LongTable<Network>({
    columns: [
      { label: 'Réseau', key: 'network', className: 'strong' },
      { label: 'Élément disponible', render: (r) => withRef(r.element, r.docId), className: 'muted' },
      { label: 'Statut', render: (r) => StatusPill(r.status), width: 120, align: 'r' },
    ],
    rows: cil.networks,
  });
  type Material = NonNullable<CilData['cil']['materials']>[number];
  const b5 = LongTable<Material>({
    columns: [
      { label: 'Poste', key: 'post', className: 'strong' },
      { label: 'Matériau', key: 'material', className: 'muted' },
      { label: 'Caractéristique', key: 'spec', className: 'muted' },
      { label: 'Source', key: 'source', width: 110, className: 'muted' },
    ],
    rows: cil.materials,
  });
  const dash = (v: unknown) => esc(isEmpty(v) ? '—' : v);
  type Equipment = NonNullable<CilData['cil']['equipments']>[number];
  const b6 = LongTable<Equipment>({
    columns: [
      { label: 'Usage', key: 'usage', className: 'strong' },
      // D-N : caractéristiques sous le nom (cellule titre + sous-titre existante).
      { label: 'Équipement', render: (r) => (isEmpty(r.specs) ? esc(r.equipment ?? '') : cellTS(r.equipment, r.specs)), className: 'muted' },
      { label: 'Marque · modèle', render: (r) => dash(r.model), className: 'muted' },
      { label: 'Installation', render: (r) => dash(fmt.date(r.installed)), width: 110, className: 'muted' },
    ],
    rows: cil.equipments,
  });
  // B7 : un travail sans date est signalé « Date manquante » (CIL-PDF-09).
  type Work = NonNullable<CilData['cil']['works']>[number];
  const b7 = LongTable<Work>({
    columns: [
      { label: 'Date', render: (r) => (isEmpty(r.date) ? 'Sans date' : esc(fmt.date(r.date))), width: 92, className: (r) => (isEmpty(r.date) ? 'warn-text nowrap' : 'muted nowrap') },
      { label: 'Travaux', render: (r) => cellTS(r.title, r.description) },
      { label: 'Entreprise', render: (r) => esc(r.company ?? 'Non renseignée'), className: 'muted' },
      { label: 'Statut', render: (r) => StatusPill(isEmpty(r.date) ? { label: 'Date manquante', tone: 'warn' } : r.status ?? ({ label: 'Complet', tone: 'ok' } as ToneLabel)), width: 120, align: 'r' },
    ],
    rows: cil.works,
  });
  const e = cil.energy ?? {};
  const b8 = [
    EnergyTiles({
      dpe: e.dpe, ges: e.ges,
      rows: [
        { label: 'Consommation', value: e.consumption },
        { label: 'Émissions', value: e.emissions },
        { label: 'Date du DPE', value: fmt.date(e.date) },
        { label: 'Validité', value: fmt.date(e.validUntil) },
      ],
    }),
    DocumentList(plan.inSection('B8')),
  ].filter(Boolean).join('\n');
  const b9 = DocumentList(plan.inSection('B9'));

  // ── Archive ZIP + index des annexes (§7.1 ordres 6 et 7, ANN-PDF-001).
  const zipSection = Section({
    eyebrow: 'Archive',
    title: 'Documents joints au ZIP',
    lead: `Fichiers livrés dans <span class="fname">${esc(ex.zipName)}</span>, non reproduits dans ce PDF.`,
    first: true,
    body: plan.zip.length ? ZipTable(plan.zip, { secondColumn: { label: 'Bloc', render: (d: PlannedDoc) => esc(d.section) } }) : '',
  });
  const indexSection = Section({
    eyebrow: 'Annexes',
    title: 'Index des annexes intégrées', className: 'index',
    lead: "Documents reproduits en totalité dans les pages suivantes, chacun précédé d'une bannière de rappel.",
    gap: 'xl',
    first: !zipSection,
    body: AnnexIndex(plan.annexes, { meta: (a) => dot(a.section, fmt.pages(a.pageCount)) }),
  });

  // ── Références, méthode et limites (CIL-PDF-12).
  const naBlocks = shown.filter((b) => b.status === 'not_applicable');
  const references = References({
    sys: ctx.sys,
    title: 'Références, méthode et limites',
    exportInfo: ex,
    paragraphs: [
      { lead: 'Méthode.', text: "Chaque bloc est établi à partir des données de la fiche bien, des équipements, des travaux et des documents importés. Le statut « Renseigné » signifie qu'au moins un élément exploitable existe dans Verebona pour ce bloc." },
      { lead: 'Limites.', text: "Ce document présente l'état des informations disponibles dans Verebona à la date de génération. Il ne certifie pas la conformité réglementaire du logement et ne constitue pas le carnet d'information du logement au sens légal. Il ne contient aucun conseil juridique." },
      ...(naBlocks.length ? [{ lead: 'Blocs non applicables.', text: `Un bloc marqué non applicable a été explicitement confirmé comme tel par l'utilisateur${isEmpty(cil.notApplicableNote) ? '.' : ` (ici : ${cil.notApplicableNote}).`}` }] : []),
    ],
  });

  // Blocs vides de contenu mais au statut à afficher : note explicite (PDF-TXT-002, exception CIL).
  return assemble({
    ctx,
    title: `CIL — ${asset.name}`,
    headerLabel: `CIL · ${asset.name} · ${genDate}`,
    cover,
    groups: [
      overview,
      [block('B1', b1, { first: true }), block('B2', b2), block('B3', b3)].join('\n'),
      [block('B4', b4, { first: true }), block('B5', b5), block('B6', b6)].join('\n'),
      [block('B7', b7, { first: true }), block('B8', b8), block('B9', b9)].join('\n'),
      [zipSection, indexSection].join('\n'),
    ],
    annexes: plan.annexes,
    references,
  });
}
