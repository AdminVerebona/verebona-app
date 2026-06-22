/**
 * Service de rendu PDF pour les exports
 *
 * Hiérarchie de renderers (V1) :
 * 1. PDFMonkey — renderer opérationnel V1 pour tous les usages documentaires
 *    Si un pdfmonkeyTemplateId est configuré, PDFMonkey est utilisé.
 * 2. jsPDF — fallback de secours pour EXPORT_BRUT ou si PDFMonkey indisponible.
 *    Jamais renderer principal des dossiers documentaires métier.
 */

import type { ExportManifest } from './export-manifest.service';
import type { AssetSnapshot } from './export-snapshot.service';
import { PDF_PALETTE } from './pdf-palette';
import { db } from '@/db';
import { exportTemplates } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';

// ─── Helpers de formatage ──────────────────────────────────────────────────

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    return new Intl.DateTimeFormat('fr-FR').format(new Date(dateStr));
  } catch {
    return dateStr;
  }
}

function safeStr(v: unknown): string {
  if (v == null) return '—';
  return String(v);
}

function formatNum(v: number | string | null | undefined, unit?: string): string {
  if (v == null || v === '') return '—';
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (isNaN(n)) return String(v);
  const formatted = new Intl.NumberFormat('fr-FR').format(n);
  return unit ? `${formatted} ${unit}` : formatted;
}

// ─── Lookup du template PDFMonkey pour un export type ─────────────────────────

async function getPdfMonkeyTemplateId(exportType: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ pdfmonkeyTemplateId: exportTemplates.pdfmonkeyTemplateId })
      .from(exportTemplates)
      .where(and(
        eq(exportTemplates.code, exportType),
        eq(exportTemplates.isActive, true),
      ))
      .limit(1);
    return row?.pdfmonkeyTemplateId ?? null;
  } catch {
    return null;
  }
}

// ─── Renderer PDFMonkey ────────────────────────────────────────────────────────

async function renderViaPdfMonkey(
  templateId: string,
  manifest: ExportManifest,
  snapshot: AssetSnapshot,
): Promise<Buffer> {
  const { createPdfDocument, getDocumentCard, downloadPdf } = await import('@/lib/pdfmonkey-client');

  const payload = {
    asset: {
      id: snapshot.id,
      name: snapshot.name,
      category: snapshot.category,
      subtype: snapshot.subtype,
      status: snapshot.status,
      purchaseDate: snapshot.purchaseDate,
      purchasePriceCents: snapshot.purchasePriceCents,
      estimatedValueCents: snapshot.estimatedValueCents,
      generalCondition: snapshot.generalCondition,
      registrationNumber: snapshot.registrationNumber,
      address: snapshot.address,
      city: snapshot.city,
      postalCode: snapshot.postalCode,
      keyCharacteristics: snapshot.keyCharacteristics,
      detailSections: snapshot.detailSections,
    },
    manifest: {
      exportType: manifest.exportType,
      generatedAt: manifest.generatedAt,
      sections: manifest.sections,
      includedDocuments: manifest.includedDocuments.map(d => ({
        id: d.id,
        documentType: d.documentType,
        title: d.retainedTitle || d.originalFilename,
        documentDate: d.documentDate,
        description: d.description,
        retainedFunctionCode: d.retainedFunctionCode,
      })),
      normativeRubrics: manifest.normativeRubrics,
      missingRubricCount: manifest.missingRubricCount,
      unqualifiedDocCount: manifest.unqualifiedDocCount,
    },
    events: snapshot.events,
    equipments: snapshot.equipments,
    substructures: snapshot.substructures,
  };

  const { id: docId } = await createPdfDocument(templateId, payload);

  let downloadUrl: string | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(r => setTimeout(r, 3000));
    const card = await getDocumentCard(docId);
    if (card.status === 'success' && card.download_url) {
      downloadUrl = card.download_url;
      break;
    }
    if (card.status === 'failure') {
      throw new Error(`PDFMonkey generation failed: ${card.failure_cause}`);
    }
  }

  if (!downloadUrl) throw new Error('PDFMonkey: timeout waiting for document');
  return downloadPdf(downloadUrl);
}

// ─── Renderer jsPDF (fallback) ─────────────────────────────────────────────────

async function renderViaJsPdf(
  manifest: ExportManifest,
  snapshot: AssetSnapshot,
): Promise<Buffer> {
  const { jsPDF } = await import('jspdf');

  const isDcb = manifest.exportType === 'DOSSIER_COMPLET';

  if (isDcb) {
    return renderDossierCompletPdf(manifest, snapshot);
  }

  // ── Generic renderer for non-CIL exports ──────────────────────────────────
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  registerFonts(doc);
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 15;
  const contentWidth = pageWidth - 2 * margin;
  let y = margin;

  const addPage = () => { doc.addPage(); y = margin; };
  const checkY = (needed: number) => {
    if (y + needed > doc.internal.pageSize.getHeight() - margin) addPage();
  };

  const P = PDF_PALETTE;
  doc.setFillColor(...P.blueHeader);
  doc.rect(0, 0, pageWidth, 18, 'F');
  doc.setTextColor(...P.white);
  doc.setFontSize(14);
  doc.setFont('LiberationSans', 'bold');
  doc.text('VEREBONA', margin, 12);
  doc.setFontSize(9);
  doc.setFont('LiberationSans', 'normal');
  doc.text(manifest.exportType.replace(/_/g, ' '), pageWidth - margin, 12, { align: 'right' });
  y = 26;

  doc.setTextColor(...P.ink);
  doc.setFontSize(18);
  doc.setFont('LiberationSans', 'bold');
  doc.text(snapshot.name, margin, y);
  y += 7;
  doc.setFontSize(10);
  doc.setFont('LiberationSans', 'normal');
  doc.setTextColor(...P.rowLabel);
  doc.text(`${snapshot.category}${snapshot.subtype ? ' · ' + snapshot.subtype : ''} · Généré le ${formatDate(manifest.generatedAt)}`, margin, y);
  y += 10;

  const sectionMap = Object.fromEntries(manifest.sections.map(s => [s.key, s.include]));

  const drawSection = (title: string, pairs: [string, string][]) => {
    checkY(12 + pairs.length * 7);
    doc.setFillColor(...P.blueSection);
    doc.rect(margin, y, contentWidth, 7, 'F');
    doc.setTextColor(...P.blueSectionFg);
    doc.setFontSize(9);
    doc.setFont('LiberationSans', 'bold');
    doc.text(title.toUpperCase(), margin + 2, y + 5);
    y += 9;
    for (const [label, value] of pairs) {
      checkY(7);
      doc.setTextColor(...P.rowLabel);
      doc.setFont('LiberationSans', 'normal');
      doc.setFontSize(8);
      doc.text(label, margin + 2, y + 4);
      doc.setTextColor(...P.rowFg);
      doc.setFont('LiberationSans', 'bold');
      const lines = doc.splitTextToSize(value, contentWidth * 0.55);
      doc.text(lines, margin + contentWidth * 0.4, y + 4);
      y += Math.max(6, lines.length * 5);
      doc.setDrawColor(...P.rowDivider);
      doc.line(margin, y, margin + contentWidth, y);
    }
    y += 4;
  };

  if (sectionMap['identity']) {
    const ds = snapshot.detailSections;
    const pairs: [string, string][] = [
      ['Nom', snapshot.name],
      ['Catégorie', snapshot.category + (snapshot.subtype ? ' · ' + snapshot.subtype : '')],
      ['Statut', snapshot.status],
    ];
    if (snapshot.description) pairs.push(['Description', snapshot.description]);
    if (ds?.family === 'IMMOBILIER') {
      pairs.push(...((snapshot.address || snapshot.city) ? [['Localisation', [snapshot.address, snapshot.city, snapshot.postalCode].filter(Boolean).join(', ')] as [string, string]] : []));
      if (snapshot.registrationNumber) pairs.push(['N° d\'immatriculation / série', snapshot.registrationNumber]);
      if (snapshot.purchaseDate) pairs.push(["Date d'achat", formatDate(snapshot.purchaseDate)]);
    } else if (ds?.family === 'VEHICULE') {
      const vi = ds.vehicle_identification;
      const vu = ds.vehicle_usage;
      if (vi?.make || vi?.model) pairs.push(['Marque / Modèle', [vi?.make, vi?.model].filter(Boolean).join(' ')]);
      if (vi?.year)               pairs.push(['Année', String(vi.year)]);
      if (vi?.registrationNumber) pairs.push(['Immatriculation', vi.registrationNumber]);
      if (vi?.vin)                pairs.push(['VIN / N° série', vi.vin]);
      if (vu?.vehicleOwnershipStatus) pairs.push(['Statut de détention', vu.vehicleOwnershipStatus]);
    } else {
      const oi = ds?.object_identification;
      if (oi?.brand || oi?.modelName) pairs.push(['Marque / Modèle', [oi?.brand, oi?.modelName].filter(Boolean).join(' ')]);
      if (oi?.serialNumber)           pairs.push(['N° de série', oi.serialNumber]);
    }
    drawSection('Identité du bien', pairs);
  }

  if (sectionMap['characteristics']) {
    const ds = snapshot.detailSections;
    const pairs: [string, string][] = [];

    if (ds.family === 'IMMOBILIER') {
      const phys = ds.physical_characteristics;
      const perf = ds.performance_technical;
      const occ  = ds.occupancy_usage;
      if (phys?.livingArea)       pairs.push(['Surface habitable', formatNum(phys.livingArea, 'm²')]);
      if (phys?.landArea)         pairs.push(['Surface terrain', formatNum(phys.landArea, 'm²')]);
      if (phys?.roomCount)        pairs.push(['Nombre de pièces', formatNum(phys.roomCount)]);
      if (phys?.bedroomCount)     pairs.push(['Chambres', formatNum(phys.bedroomCount)]);
      if (phys?.levels)           pairs.push(['Niveaux', formatNum(phys.levels)]);
      if (phys?.constructionYear) pairs.push(['Année de construction', String(phys.constructionYear)]);
      if (phys?.generalCondition) pairs.push(['État général', phys.generalCondition]);
      if (perf?.heatingType)      pairs.push(['Type de chauffage', perf.heatingType]);
      if (perf?.mainEnergy)       pairs.push(['Énergie principale', perf.mainEnergy]);
      if (perf?.dpeClass)         pairs.push(['Classe DPE', perf.dpeClass + (perf.gesClass ? ` / GES ${perf.gesClass}` : '')]);
      if (perf?.dpeDate)          pairs.push(['Date DPE', formatDate(perf.dpeDate)]);
      if (occ?.occupancyUsage)    pairs.push(['Usage', occ.occupancyUsage]);
      if (occ?.occupancyStatus)   pairs.push(['Occupation', occ.occupancyStatus]);
      if (occ?.monthlyRent)       pairs.push(['Loyer mensuel', formatNum(occ.monthlyRent, '€')]);
    } else if (ds.family === 'VEHICULE') {
      const vi = ds.vehicle_identification;
      const vt = ds.vehicle_technical;
      const vu = ds.vehicle_usage;
      const vins = ds.vehicle_insurance;
      if (vi?.make || vi?.model)    pairs.push(['Marque / Modèle', [vi?.make, vi?.model].filter(Boolean).join(' ')]);
      if (vi?.year)                 pairs.push(['Année', String(vi.year)]);
      if (vi?.registrationNumber)   pairs.push(['Immatriculation', vi.registrationNumber]);
      if (vi?.vin)                  pairs.push(['VIN / N° série', vi.vin]);
      if (vt?.fuelType)             pairs.push(['Carburant', vt.fuelType]);
      if (vt?.powerKw)              pairs.push(['Puissance', formatNum(vt.powerKw, 'kW')]);
      if (vt?.engine)               pairs.push(['Moteur', vt.engine]);
      if (vt?.seats)                pairs.push(['Places', formatNum(vt.seats)]);
      if (vu?.mileage != null)      pairs.push(['Kilométrage', formatNum(vu.mileage, vu.mileageUnit ?? 'km')]);
      if (vu?.mileageDate)          pairs.push(['Au', formatDate(vu.mileageDate)]);
      if (vins?.insurer)            pairs.push(['Assureur', vins.insurer]);
      if (vins?.insuranceExpiry)    pairs.push(['Échéance assurance', formatDate(vins.insuranceExpiry)]);
      if (vins?.nextInspection)     pairs.push(['Prochain contrôle technique', formatDate(vins.nextInspection)]);
    } else {
      const oi = ds.object_identification;
      const oc = ds.object_condition;
      const op = ds.object_provenance;
      if (oi?.brand || oi?.modelName) pairs.push(['Marque / Modèle', [oi?.brand, oi?.modelName].filter(Boolean).join(' ')]);
      if (oi?.serialNumber)           pairs.push(['N° de série', oi.serialNumber]);
      if (oc?.condition)              pairs.push(['État', oc.condition]);
      if (oc?.dimensions)             pairs.push(['Dimensions', oc.dimensions]);
      if (oc?.weight)                 pairs.push(['Poids', oc.weight]);
      if (op?.acquisitionMode)        pairs.push(["Mode d'acquisition", op.acquisitionMode]);
      if (op?.provenance)             pairs.push(['Provenance', op.provenance]);
    }

    if (pairs.length === 0) {
      if (snapshot.generalCondition) pairs.push(['État général', snapshot.generalCondition]);
      if (snapshot.mileageOrHours != null) pairs.push(['Kilométrage / Heures', formatNum(snapshot.mileageOrHours)]);
      if (snapshot.warrantyEndDate) pairs.push(['Fin de garantie', formatDate(snapshot.warrantyEndDate)]);
      if (snapshot.lastMaintenanceDate) pairs.push(['Dernière maintenance', formatDate(snapshot.lastMaintenanceDate)]);
    }

    if (pairs.length > 0) drawSection('Caractéristiques techniques', pairs);
  }

  if (sectionMap['financial']) {
    drawSection('Valeur & informations financières', [
      ["Prix d'achat", formatCents(snapshot.purchasePriceCents)],
      ['Valeur estimée', formatCents(snapshot.estimatedValueCents)],
    ]);
  }

  if (sectionMap['maintenance'] && snapshot.events.length > 0) {
    const maintenanceEvents = snapshot.events
      .filter(e => ['entretien', 'reparation', 'maintenance'].some(k => e.categorie?.toLowerCase().includes(k)))
      .slice(0, 15);
    if (maintenanceEvents.length > 0) {
      checkY(12);
      doc.setFillColor(...P.blueSection);
      doc.rect(margin, y, contentWidth, 7, 'F');
      doc.setTextColor(...P.blueSectionFg);
      doc.setFontSize(9);
      doc.setFont('LiberationSans', 'bold');
      doc.text("HISTORIQUE D'ENTRETIEN", margin + 2, y + 5);
      y += 9;
      for (const evt of maintenanceEvents) {
        checkY(8);
        doc.setTextColor(...P.rowFg);
        doc.setFont('LiberationSans', 'bold');
        doc.setFontSize(8);
        doc.text(evt.title, margin + 2, y + 4);
        doc.setTextColor(...P.rowMeta);
        doc.setFont('LiberationSans', 'normal');
        const meta = [formatDate(evt.date), evt.provider, evt.costCents != null ? formatCents(evt.costCents) : null].filter(Boolean).join(' · ');
        doc.text(meta, margin + contentWidth - 2, y + 4, { align: 'right' });
        y += 6;
        doc.setDrawColor(...P.rowDivider);
        doc.line(margin, y, margin + contentWidth, y);
      }
      y += 4;
    }
  }

  if (sectionMap['documents'] && manifest.includedDocuments.length > 0) {
    checkY(12);
    doc.setFillColor(...P.blueSection);
    doc.rect(margin, y, contentWidth, 7, 'F');
    doc.setTextColor(...P.blueSectionFg);
    doc.setFontSize(9);
    doc.setFont('LiberationSans', 'bold');
    doc.text(`DOCUMENTS JOINTS (${manifest.includedDocuments.length})`, margin + 2, y + 5);
    y += 9;
    for (const docRef of manifest.includedDocuments) {
      checkY(6);
      doc.setTextColor(...P.rowFg);
      doc.setFontSize(8);
      doc.setFont('LiberationSans', 'normal');
      const title = docRef.retainedTitle || docRef.originalFilename || '—';
      doc.text(`• [${docRef.documentType}] ${title}`, margin + 2, y + 4);
      if (docRef.documentDate) {
        doc.setTextColor(...P.rowMeta);
        doc.text(formatDate(docRef.documentDate), margin + contentWidth - 2, y + 4, { align: 'right' });
      }
      y += 6;
    }
    y += 4;
  }

  if (snapshot.notes) {
    checkY(20);
    doc.setFillColor(...P.blueSection);
    doc.rect(margin, y, contentWidth, 7, 'F');
    doc.setTextColor(...P.blueSectionFg);
    doc.setFontSize(9);
    doc.setFont('LiberationSans', 'bold');
    doc.text('NOTES ET OBSERVATIONS', margin + 2, y + 5);
    y += 9;
    doc.setTextColor(...P.slate);
    doc.setFont('LiberationSans', 'normal');
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(snapshot.notes, contentWidth - 4);
    for (const line of lines) {
      checkY(5);
      doc.text(line, margin + 2, y + 4);
      y += 5;
    }
  }

  addFooters(doc, snapshot, manifest);

  const arrayBuffer = doc.output('arraybuffer');
  return Buffer.from(arrayBuffer);
}

// ─── Enum → human label helpers ───────────────────────────────────────────────

const CONDITION_LABELS: Record<string, string> = {
  BON: 'Bon état général', TRES_BON: 'Très bon état', MOYEN: 'État moyen',
  MAUVAIS: 'Mauvais état', NEUF: 'Neuf', A_RENOVER: 'À rénover',
};
const OCCUPANCY_LABELS: Record<string, string> = {
  RESIDENCE_PRINCIPALE: 'Résidence principale', RESIDENCE_SECONDAIRE: 'Résidence secondaire',
  LOCATIF: 'Bien locatif', VACANT: 'Vacant', AUTRE: 'Autre usage',
};
const OCCUPANCY_STATUS_LABELS: Record<string, string> = {
  OCCUPE: 'Occupé par le propriétaire', LOUE: 'Loué', VACANT: 'Vacant',
  OCCUPE_LOCATAIRE: 'Occupé par un locataire',
};

function humanLabel(value: string | null | undefined, map: Record<string, string>): string | null {
  if (!value) return null;
  return map[value] ?? value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatDateLong(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(dateStr));
  } catch {
    return dateStr;
  }
}

// ─── DOCUMENT_TYPE → human category label ─────────────────────────────────────

const DOC_CATEGORY_LABELS: Record<string, string> = {
  DPE: 'Performance énergétique',
  AUDIT_ENERGETIQUE: 'Performance énergétique',
  PLAN_CONSTRUCTION: 'Plans de surface / Coupes',
  PLAN_CADASTRAL: 'Identification cadastrale',
  EXTRAIT_CADASTRAL: 'Identification cadastrale',
  CADASTRE: 'Identification cadastrale',
  DIAGNOSTIC: 'Diagnostic technique',
  SURFACE_CARREZ: 'Surface / Mesurage',
  EXPERTISE: 'Expertise / Estimation',
  CONTRAT: 'Contrat',
  MANUEL: 'Notice / Manuel',
  ATTESTATION_ASSURANCE: 'Assurance',
  CONSTAT_SINISTRE: 'Sinistre',
  DEVIS: 'Facture / Devis',
  RE2020: 'Réglementation environnementale',
  LABEL_CERTIFICATION: 'Label / Certification',
  ISOLATION_TOITURE: 'Isolation thermique',
  ISOLATION_MURS: 'Isolation thermique',
  ISOLATION_VITRAGE: 'Isolation thermique',
  ISOLATION_PLANCHERS: 'Isolation thermique',
  EQUIPEMENT_CHAUFFAGE: 'Équipements énergétiques',
  EQUIPEMENT_REFROIDISSEMENT: 'Équipements énergétiques',
  EQUIPEMENT_ECS: 'Équipements énergétiques',
  RESEAU_CHALEUR: 'Équipements énergétiques',
  EQUIPEMENT_VENTILATION: 'Équipements énergétiques',
  RESEAU_EAU: 'Réseaux',
  RESEAU_ELECTRICITE: 'Réseaux',
  RESEAU_GAZ: 'Réseaux',
  RESEAU_AERATION: 'Réseaux',
  AMIANTE: 'Diagnostic technique',
  PLOMB: 'Diagnostic technique',
  GAZ: 'Diagnostic technique',
  ELECTRICITE: 'Diagnostic technique',
  ASSAINISSEMENT: 'Diagnostic technique',
  ERNMT: 'Risques naturels',
  ACTE_TRANSACTION: 'Acte notarié',
  PERMIS_CONSTRUIRE: "Autorisation d'urbanisme",
  FACTURE: 'Facture / Devis',
  GARANTIE: 'Garantie',
  RAPPORT_ENTRETIEN: 'Entretien',
};

// ─── Status badge ─────────────────────────────────────────────────────────────

type BadgeStatus = 'available' | 'missing' | 'partial' | 'na' | 'verify';

// Legacy helper kept for generic renderer
function drawStatusBadge(doc: any, status: BadgeStatus, x: number, y: number): void {
  const P = PDF_PALETTE;
  const configs: Record<BadgeStatus, { label: string; bg: readonly [number,number,number]; fg: readonly [number,number,number] }> = {
    available: { label: 'Disponible',     bg: P.greenBg,  fg: P.green  },
    missing:   { label: 'Non renseigné',  bg: P.grayBg,   fg: P.gray   },
    partial:   { label: 'À compléter',    bg: P.orangeBg, fg: P.orange },
    verify:    { label: 'À vérifier',     bg: P.yellowBg, fg: P.yellow },
    na:        { label: 'Non applicable', bg: P.border,   fg: P.muted  },
  };
  const { label, bg, fg } = configs[status];
  const w = 26; const h = 5;
  doc.setFillColor(...bg);
  doc.roundedRect(x, y - 3.5, w, h, 1, 1, 'F');
  doc.setFontSize(6);
  doc.setFont('LiberationSans', 'bold');
  doc.setTextColor(...fg);
  doc.text(label, x + w / 2, y, { align: 'center' });
}

// ─── CIL PDF renderer ─────────────────────────────────────────────────────────

const ENERGY_EQUIPMENT_KEYWORDS = new Set([
  'chauffage', 'chaudiere', 'chaudière', 'pompe a chaleur', 'pompe à chaleur', 'pac',
  'radiateur', 'plancher chauffant', 'poele', 'poêle', 'insert', 'climatisation', 'clim',
  'refroidissement', 'eau chaude', 'ecs', 'chauffe-eau', 'thermodynamique', 'ballon',
  'ventilation', 'vmc', 'aeration', 'aération', 'vmr', 'double flux',
  "production d'energie", "production d'énergie", 'photovoltaique', 'photovoltaïque',
  'solaire', 'eolienne', 'éolienne', 'regulation', 'régulation', 'pilotage energetique',
  'pilotage énergétique', 'thermostat', 'reseau de chaleur', 'réseau de chaleur',
  'reseau de froid', 'réseau de froid',
]);

function isEnergyEquipment(eq: { name: string; category?: string | null; type?: string | null }): boolean {
  const haystack = [eq.name, eq.category ?? '', eq.type ?? ''].join(' ').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const kw of ENERGY_EQUIPMENT_KEYWORDS) {
    const kwNorm = kw.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (haystack.includes(kwNorm)) return true;
  }
  return false;
}

function rubricBadgeStatus(rubric: { code: string; section: string }): BadgeStatus {
  // "À vérifier" = équipement/document dont la présence est incertaine (peut-être non applicable)
  const verifySet = new Set([
    'RE2020', 'LABEL_CERTIFICATION',
    'ISOLATION_TOITURE', 'ISOLATION_MURS', 'ISOLATION_VITRAGE', 'ISOLATION_PLANCHERS',
    'AUDIT_ENERGETIQUE',
    'EQUIPEMENT_REFROIDISSEMENT', 'RESEAU_CHALEUR', 'RESEAU_FROID',
    'ASSAINISSEMENT',
  ]);
  return verifySet.has(rubric.code) ? 'verify' : 'partial';
}

// Load Verebona logo once (server-side, PNG 480×120)
let _verebonaLogoPngB64: string | null = null;
function getVerebonaLogoPng(): string | null {
  if (_verebonaLogoPngB64 !== null) return _verebonaLogoPngB64;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'public/brand/verebona-logo-email.png'));
    // File is stored as base64 text — use as-is; if binary, convert
    const str = raw.toString('utf8').trim();
    _verebonaLogoPngB64 = str.startsWith('iVBOR') ? str : raw.toString('base64');
  } catch {
    _verebonaLogoPngB64 = '';
  }
  return _verebonaLogoPngB64 || null;
}

// ─── LiberationSans font loader (cached) ──────────────────────────────────────
// LiberationSans is metric-compatible with Arial/Helvetica and supports full
// Latin accented characters (é, è, à, ê, ç, etc.), fixing the PDF text-extraction
// issue where Helvetica dropped accents in the copy-paste/extraction layer.

const _fontCache: Record<string, string> = {};

function getFontB64(variant: 'Regular' | 'Bold' | 'Italic' | 'BoldItalic'): string {
  if (_fontCache[variant]) return _fontCache[variant];
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), `public/fonts/LiberationSans-${variant}.ttf`));
    _fontCache[variant] = raw.toString('base64');
  } catch {
    _fontCache[variant] = '';
  }
  return _fontCache[variant];
}

function registerFonts(doc: any): void {
  const variants: Array<['Regular' | 'Bold' | 'Italic' | 'BoldItalic', string, string]> = [
    ['Regular',    'LiberationSans', 'normal'],
    ['Bold',       'LiberationSans', 'bold'],
    ['Italic',     'LiberationSans', 'italic'],
    ['BoldItalic', 'LiberationSans', 'bolditalic'],
  ];
  for (const [variant, fontName, fontStyle] of variants) {
    const b64 = getFontB64(variant);
    if (!b64) continue;
    const fileName = `LiberationSans-${variant}.ttf`;
    doc.addFileToVFS(fileName, b64);
    doc.addFont(fileName, fontName, fontStyle);
  }
  doc.setFont('LiberationSans', 'normal');
}

// DPE energy bar A→G — thresholds above, active segment extends DOWNWARD, arrow + label below
// Total vertical footprint: 28mm (y to y+28). Caller must reserve this space.
function drawDpeBar(doc: any, x: number, y: number, totalW: number, dpeClass: string | null | undefined): void {
  const classes    = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const thresholds = ['<=70', '<=110', '<=180', '<=250', '<=330', '<=420', ''];
  const colors: [number, number, number][] = [
    [0, 176, 80], [146, 208, 80], [255, 217, 102], [255, 192, 0],
    [255, 128, 0], [230, 50, 30], [160, 0, 0],
  ];
  const segW      = totalW / classes.length;
  const barTopY   = y + 6;   // threshold labels occupy y..barTopY
  const barH      = 8;       // normal segment height
  const activeExt = 5;       // extra mm added BELOW active segment only
  const gap       = 0.8;
  const activeIdx = dpeClass ? classes.indexOf(dpeClass.toUpperCase()) : -1;

  // Threshold labels centred above the right edge (gap) between segments
  doc.setFontSize(4.5); doc.setFont('LiberationSans', 'normal');
  doc.setTextColor(130, 130, 130);
  thresholds.forEach((t, i) => {
    if (!t) return;
    // Right border of segment i = x + (i+1)*segW - gap/2
    doc.text(t, x + (i + 1) * segW - gap / 2, barTopY - 1.5, { align: 'center' });
  });

  // Segments — all share same top edge (barTopY); active extends further down
  classes.forEach((cls, i) => {
    const sx      = x + i * segW;
    const isActive = i === activeIdx;
    const segH    = isActive ? barH + activeExt : barH;
    const [r, g, b] = colors[i];
    doc.setFillColor(
      isActive ? r : Math.min(255, r + Math.round((255 - r) * 0.52)),
      isActive ? g : Math.min(255, g + Math.round((255 - g) * 0.52)),
      isActive ? b : Math.min(255, b + Math.round((255 - b) * 0.52)),
    );
    doc.rect(sx, barTopY, segW - gap, segH, 'F');
    doc.setFontSize(isActive ? 7.5 : 6);
    doc.setFont('LiberationSans', isActive ? 'bold' : 'normal');
    doc.setTextColor(isActive ? 255 : 80, isActive ? 255 : 80, isActive ? 255 : 80);
    doc.text(cls, sx + (segW - gap) / 2, barTopY + segH - 2, { align: 'center' });
  });

  // Arrow + "Classe X" label below the active segment bottom
  if (activeIdx >= 0) {
    const [r, g, b] = colors[activeIdx];
    const cx       = x + activeIdx * segW + (segW - gap) / 2;
    const arrowTop = barTopY + barH + activeExt + 1.5;  // just below active bottom
    const aw = 4.5; const ah = 2.5;
    doc.setFillColor(r, g, b);
    doc.triangle(cx - aw / 2, arrowTop, cx + aw / 2, arrowTop, cx, arrowTop + ah, 'F');
    doc.setFontSize(6.5); doc.setFont('LiberationSans', 'bold');
    doc.setTextColor(r, g, b);
    doc.text(`Classe ${dpeClass!.toUpperCase()}`, cx, arrowTop + ah + 4.5, { align: 'center' });
  }
  // Total height used: barTopY + barH + activeExt + 1.5 + 2.5 + 4.5 + ~3 ≈ y + 28
}


async function renderDossierCompletPdf(manifest: ExportManifest, snapshot: AssetSnapshot): Promise<Buffer> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  registerFonts(doc);

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 16;
  const cW = pageW - 2 * M;
  let y = M;
  let _runningHeader = '';
  let _runningHeaderRef = '';

  // ── Colour palette ──────────────────────────────────────────────────────────
  const C = PDF_PALETTE;
  const rgb  = (c: readonly [number,number,number]) => doc.setTextColor(c[0], c[1], c[2]);
  const fill = (c: readonly [number,number,number]) => doc.setFillColor(c[0], c[1], c[2]);
  const stroke = (c: readonly [number,number,number]) => doc.setDrawColor(c[0], c[1], c[2]);

  const needY = (needed: number) => {
    if (y + needed > pageH - 12) {
      doc.addPage();
      y = M;
      drawRunningHeader(_runningHeader, undefined, true);
    }
  };

  // ── Running header ──────────────────────────────────────────────────────────
  const RH = 24;
  const RL_H = 14; const RL_W = 56;
  const RL_Y = RH / 2 - RL_H * 0.28;

  const drawRunningHeader = (rightLabel: string, sectionRef?: string, reuseRef = false) => {
    _runningHeader = rightLabel;
    if (!reuseRef && sectionRef !== undefined) _runningHeaderRef = sectionRef;
    fill(C.pageBg); doc.rect(0, 0, pageW, pageH, 'F');
    stroke(C.border); doc.setLineWidth(0.3);
    doc.line(0, RH, pageW, RH);
    const headerLogo = getVerebonaLogoPng();
    if (headerLogo) {
      doc.addImage(headerLogo, 'PNG', M, RL_Y, RL_W, RL_H);
    } else {
      doc.setFontSize(9); doc.setFont('LiberationSans', 'bold'); rgb(C.navy);
      doc.text('Verebona', M, RH / 2 + 3);
    }
    const ref = reuseRef ? _runningHeaderRef : (sectionRef ?? _runningHeaderRef);
    const midY = RH / 2;
    if (ref) {
      doc.setFontSize(6); doc.setFont('LiberationSans', 'bold'); rgb(C.muted);
      doc.text(ref, pageW - M, midY - 1.5, { align: 'right' });
      doc.setFontSize(8); doc.setFont('LiberationSans', 'normal'); rgb(C.slate);
      doc.text(rightLabel, pageW - M, midY + 5, { align: 'right' });
    } else {
      doc.setFontSize(8); doc.setFont('LiberationSans', 'normal'); rgb(C.slate);
      doc.text(rightLabel, pageW - M, midY + 3, { align: 'right' });
    }
    y = RH + 6;
  };

  const startSection = (rightLabel: string, sectionRef: string) => {
    doc.addPage();
    drawRunningHeader(rightLabel, sectionRef);
  };

  // ── Section helpers ─────────────────────────────────────────────────────────
  let sectionNum = 0;

  const drawSectionTitle = (title: string) => {
    needY(50);
    sectionNum++;
    const numStr = String(sectionNum).padStart(2, '0');
    doc.setFontSize(8); doc.setFont('LiberationSans', 'bold'); rgb(C.primary);
    doc.text(numStr, M, y + 7);
    doc.setFontSize(13); doc.setFont('LiberationSans', 'bold'); rgb(C.ink);
    doc.text(title, M + 10, y + 7);
    y += 16;
  };

  const drawSubTitle = (label: string) => {
    needY(45);
    doc.setFontSize(7.5); doc.setFont('LiberationSans', 'bold'); rgb(C.primary);
    doc.text(label.toUpperCase(), M, y + 5);
    y += 10;
  };

  const drawField = (label: string, value: string | null | undefined) => {
    if (value == null || value === '' || value === '—') return;
    needY(9);
    doc.setFontSize(8.5); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
    doc.text(label, M, y + 5);
    doc.setFont('LiberationSans', 'bold'); rgb(C.ink);
    const lines = doc.splitTextToSize(value, cW * 0.53);
    doc.text(lines, M + (cW / 2) * 0.44, y + 5);
    y += Math.max(8, lines.length * 6);
    stroke(C.border); doc.line(M, y, M + cW, y);
  };

  // ── Status badge ────────────────────────────────────────────────────────────
  type BadgeStatus = 'available' | 'missing' | 'partial' | 'na' | 'verify';
  const STATUS_CFG: Record<BadgeStatus, { label: string; bg: readonly [number,number,number]; fg: readonly [number,number,number]; dot: readonly [number,number,number] }> = {
    available: { label: 'Disponible',     bg: C.greenBg,  fg: C.green,  dot: C.green  },
    partial:   { label: 'À compléter',    bg: C.orangeBg, fg: C.orange, dot: C.orange },
    verify:    { label: 'À vérifier',     bg: C.yellowBg, fg: C.yellow, dot: C.yellow },
    missing:   { label: 'Non renseigné',  bg: C.grayBg,   fg: C.gray,   dot: C.gray   },
    na:        { label: 'Non applicable', bg: C.grayBg,   fg: C.muted,  dot: C.muted  },
  };
  const drawBadge = (status: BadgeStatus, bx: number, by: number) => {
    const cfg = STATUS_CFG[status];
    const bw = 30; const bh = 6;
    fill(cfg.bg); doc.roundedRect(bx, by - 4, bw, bh, 1.2, 1.2, 'F');
    fill(cfg.dot); doc.circle(bx + 4, by - 1, 1.2, 'F');
    doc.setFontSize(6.5); doc.setFont('LiberationSans', 'bold'); rgb(cfg.fg);
    doc.text(cfg.label, bx + bw / 2 + 2, by, { align: 'center' });
  };

  // ── 2-column field row ──────────────────────────────────────────────────────
  const drawFieldRow = (fields: Array<[string, string | null | undefined]>) => {
    const valid = fields.filter(([, v]) => v != null && v !== '' && v !== '—');
    if (valid.length === 0) return;
    needY(9);
    const half = cW / 2;
    valid.forEach(([label, value], i) => {
      const ox = M + i * half;
      doc.setFontSize(8.5); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
      doc.text(label, ox, y + 5);
      doc.setFont('LiberationSans', 'bold'); rgb(C.ink);
      const lines = doc.splitTextToSize(String(value), half * 0.52);
      doc.text(lines, ox + half * 0.44, y + 5);
    });
    y += 8;
    stroke(C.border); doc.line(M, y, M + cW, y);
  };

  // ── Document table ──────────────────────────────────────────────────────────
  const drawDocHeader = () => {
    const c1 = cW * 0.40; const c2 = cW * 0.22;
    doc.setFontSize(7.5); doc.setFont('LiberationSans', 'bold'); rgb(C.muted);
    doc.text('Document',  M,            y + 5);
    doc.text('Catégorie', M + c1,       y + 5);
    doc.text('Date',      M + c1 + c2,  y + 5);
    doc.text('Statut',    M + cW - 30,  y + 5);
    y += 8;
    stroke(C.borderMid); doc.line(M, y, M + cW, y); y += 2;
  };

  const drawDocRow = (title: string, category: string, date: string | null | undefined, status: BadgeStatus) => {
    const [mainTitle, subTitle] = title.split('\n');
    const rowMin = subTitle ? 14 : 10;
    needY(rowMin);
    const c1 = cW * 0.40; const c2 = cW * 0.22;
    doc.setFontSize(8.5); doc.setFont('LiberationSans', status === 'available' ? 'bold' : 'normal');
    rgb(status === 'available' ? C.ink : C.muted);
    const tLines = doc.splitTextToSize(mainTitle, c1 - 2);
    doc.text(tLines, M, y + 5);
    if (subTitle) {
      doc.setFontSize(7); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
      doc.text(subTitle, M, y + 5 + tLines.length * 5.5);
    }
    doc.setFontSize(8); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
    const cLines = doc.splitTextToSize(category, c2 - 2);
    doc.text(cLines, M + c1, y + 5);
    if (date) doc.text(formatDateLong(date), M + c1 + c2, y + 5);
    drawBadge(status, M + cW - 30, y + 5);
    const rowH = Math.max(rowMin, (tLines.length + (subTitle ? 1 : 0)) * 6, cLines.length * 6);
    y += rowH;
    stroke(C.border); doc.line(M, y, M + cW, y);
  };

  // ── Derived data ────────────────────────────────────────────────────────────
  const ds = snapshot.detailSections;
  const sectionMap = Object.fromEntries(manifest.sections.map(s => [s.key, s.include]));
  const incDocCount = manifest.includedDocuments.length;
  const generatedAt = formatDateLong(manifest.generatedAt);

  // Build status per section
  const hasData = (field: unknown): boolean => field != null && field !== '' && field !== '—';

  // Identity status — category-aware
  let identityComplete = false;
  if (ds.family === 'IMMOBILIER') {
    identityComplete = hasData(snapshot.name) && (hasData(snapshot.address) || hasData(snapshot.city));
  } else if (ds.family === 'VEHICULE') {
    identityComplete = hasData(snapshot.name) && (hasData(ds.vehicle_identification?.make) || hasData(ds.vehicle_identification?.registrationNumber));
  } else {
    identityComplete = hasData(snapshot.name) && (hasData(ds.object_identification?.brand) || hasData(ds.object_identification?.serialNumber));
  }

  // Characteristics status — check detail sections
  let charsComplete = false;
  if (ds.family === 'IMMOBILIER') {
    charsComplete = hasData(ds.physical_characteristics?.livingArea) || hasData(ds.physical_characteristics?.roomCount);
  } else if (ds.family === 'VEHICULE') {
    charsComplete = hasData(ds.vehicle_identification?.make) || hasData(ds.vehicle_identification?.registrationNumber);
  } else {
    charsComplete = hasData(ds.object_identification?.brand) || hasData(ds.object_identification?.serialNumber) || hasData(ds.object_condition?.condition);
  }

  // Financial status
  const financialComplete = hasData(snapshot.purchasePriceCents) || hasData(snapshot.estimatedValueCents);

  // Maintenance status
  const maintenanceComplete = snapshot.events.length > 0;

  // Equipments status
  const equipsComplete = snapshot.equipments.length > 0;

  // Rooms status
  const roomsComplete = snapshot.substructures.length > 0;

  // Insurance status
  let insuranceComplete = false;
  if (ds.family === 'IMMOBILIER') {
    const ins = ds.insurance;
    insuranceComplete = hasData(ins?.isInsured) || hasData(ins?.insurer);
  } else if (ds.family === 'VEHICULE') {
    const vins = ds.vehicle_insurance;
    insuranceComplete = hasData(vins?.isInsured) || hasData(vins?.insurer);
  } else {
    const ou = ds.object_usage;
    insuranceComplete = hasData(ou?.isInsured);
  }

  // Helper: section badge
  const sectionBadge = (include: boolean, hasContent: boolean): BadgeStatus =>
    !include ? 'na' : hasContent ? 'available' : 'missing';

  const synthRows = [
    { label: '01 · Identité du bien',          status: sectionBadge(sectionMap['identity'] ?? false, identityComplete) },
    { label: '02 · Caractéristiques techniques', status: sectionBadge(sectionMap['characteristics'] ?? false, charsComplete) },
    { label: '03 · Valeur & informations financières', status: sectionBadge(sectionMap['financial'] ?? false, financialComplete) },
    { label: '04 · Historique d\'entretien',    status: sectionBadge(sectionMap['maintenance'] ?? false, maintenanceComplete),
      valueOverride: maintenanceComplete ? `${snapshot.events.length} événement${snapshot.events.length > 1 ? 's' : ''}` : undefined },
    { label: '05 · Documents associés',        status: incDocCount > 0 ? 'available' : 'missing',
      valueOverride: incDocCount > 0 ? `${incDocCount} document${incDocCount > 1 ? 's' : ''}` : undefined },
    { label: '06 · Photos',                    status: sectionBadge(sectionMap['photos'] ?? false, snapshot.photos.length > 0),
      valueOverride: snapshot.photos.length > 0 ? `${snapshot.photos.length} photo${snapshot.photos.length > 1 ? 's' : ''}` : undefined },
    { label: '07 · Équipements',              status: sectionBadge(sectionMap['equipments'] ?? false, equipsComplete),
      valueOverride: equipsComplete ? `${snapshot.equipments.length} équipement${snapshot.equipments.length > 1 ? 's' : ''}` : undefined },
    { label: '08 · Pièces / sous-structures', status: sectionBadge(sectionMap['rooms'] ?? false, roomsComplete),
      valueOverride: roomsComplete ? `${snapshot.substructures.length} pièce${snapshot.substructures.length > 1 ? 's' : ''}` : undefined },
    { label: '09 · Assurance',                status: sectionBadge(sectionMap['insurance'] ?? false, insuranceComplete) },
  ].filter(r => r.status !== 'na');

  // Count statuses
  const availableSections = synthRows.filter(r => r.status === 'available').length;
  const partialSections = synthRows.filter(r => r.status === 'partial' || r.status === 'verify').length;
  const missingSections = synthRows.filter(r => r.status === 'missing').length;
  const totalSections = synthRows.length;

  // ── Dossier status ──────────────────────────────────────────────────────────
  type DossierStatus = 'complet' | 'partiel' | 'tres_incomplet';
  const dossierStatus: DossierStatus =
    missingSections === 0 && partialSections === 0 ? 'complet'
    : availableSections > 0 ? 'partiel'
    : 'tres_incomplet';

  const STATUS_LABEL: Record<DossierStatus, string> = {
    complet:        'Dossier complet',
    partiel:        'Dossier partiel',
    tres_incomplet: 'Dossier très incomplet',
  };
  const STATUS_COLOR: Record<DossierStatus, readonly [number,number,number]> = {
    complet:        C.green,
    partiel:        C.orange,
    tres_incomplet: C.orange,
  };
  const STATUS_BG: Record<DossierStatus, readonly [number,number,number]> = {
    complet:        C.greenBg,
    partiel:        C.orangeBg,
    tres_incomplet: C.orangeBg,
  };

  // Build DCB reference — use relevant identifier per category
  let identRef = String(snapshot.id ?? 0).padStart(5, '0');
  if (ds.family === 'IMMOBILIER') {
    identRef = snapshot.postalCode || identRef;
  } else if (ds.family === 'VEHICULE') {
    identRef = ds.vehicle_identification?.registrationNumber || identRef;
  } else {
    identRef = ds.object_identification?.serialNumber || identRef;
  }
  const dcbRef = `DOSSIER_COMPLET-${new Date(manifest.generatedAt).toISOString().slice(0, 10)}-${identRef}`;

  // ════════════════════════════════════════════════════════════════════════════
  // PAGE 1 — COVER
  // ════════════════════════════════════════════════════════════════════════════

  // ── Cover header band ─────────────────────────────────────────────────────
  const logoH = 13; const logoW = 52;
  const headerH = logoH + 8;
  fill(C.pageBg); doc.rect(0, 0, pageW, pageH, 'F');
  stroke(C.border); doc.setLineWidth(0.3);
  doc.line(0, headerH, pageW, headerH);

  const coverLogoY = headerH / 2 - logoH * 0.28;
  const coverLogo = getVerebonaLogoPng();
  if (coverLogo) {
    doc.addImage(coverLogo, 'PNG', M, coverLogoY, logoW, logoH);
  } else {
    doc.setFontSize(11); doc.setFont('LiberationSans', 'bold'); rgb(C.navy);
    doc.text('Verebona', M, headerH / 2 + 3);
  }

  const coverTextY = headerH / 2 + 2.5;
  doc.setFontSize(8); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
  doc.text('DCB · Dossier Complet du Bien', pageW - M, coverTextY, { align: 'right' });

  y = headerH + 7;

  // ── Title block ──────────────────────────────────────────────────────────
  doc.setFontSize(8); doc.setFont('LiberationSans', 'bold'); rgb(C.ink);
  doc.text('DCB — Dossier Complet du Bien', M, y);
  doc.setFontSize(6.5); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
  doc.text(dcbRef, pageW - M, y, { align: 'right' });
  y += 5;
  doc.setFontSize(6); doc.setFont('LiberationSans', 'italic'); rgb(C.muted);
  doc.text('Document récapitulatif des informations et documents disponibles dans Verebona.', M, y);
  y += 10;

  // 2. Main title
  doc.setFontSize(26); doc.setFont('LiberationSans', 'bold'); rgb(C.ink);
  doc.text('Dossier Complet', M, y); y += 10;
  doc.setFontSize(26); doc.setFont('LiberationSans', 'bold'); rgb(C.primary);
  doc.text('du Bien', M, y); y += 9;

  // 3. Subtitle
  doc.setFontSize(8); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
  doc.text('État des informations et documents disponibles dans Verebona à la date de génération.', M, y);
  y += 10;

  // ── Property card ─────────────────────────────────────────────────────────
  fill(C.bg); stroke(C.border);
  doc.roundedRect(M, y, cW, 22, 2, 2, 'FD');
  const iconX = M + 5; const iconY = y + 5;
  fill(C.navyLight); doc.roundedRect(iconX, iconY, 10, 10, 1, 1, 'F');
  fill(C.navy);
  if (ds.family === 'IMMOBILIER') {
    // House icon
    doc.triangle(iconX + 1, iconY + 5, iconX + 9, iconY + 5, iconX + 5, iconY + 1, 'F');
    doc.rect(iconX + 2.5, iconY + 5, 5, 4.5, 'F');
    fill(C.navyLight); doc.rect(iconX + 4, iconY + 7.5, 2, 2, 'F');
  } else {
    // Generic asset icon (rounded rect)
    doc.roundedRect(iconX + 2, iconY + 1, 6, 8, 1, 1, 'F');
  }
  const cardX = M + 18;
  doc.setFontSize(6.5); doc.setFont('LiberationSans', 'bold'); rgb(C.muted);
  const subtypeLabel = snapshot.subtype
    ? snapshot.subtype.replace(/_/g, ' ').toUpperCase()
    : snapshot.category.toUpperCase();
  doc.text(`BIEN — ${subtypeLabel}`, cardX, y + 5.5);
  doc.setFontSize(10); doc.setFont('LiberationSans', 'bold'); rgb(C.ink);
  const cardPrimary = snapshot.name;
  const nameLines = doc.splitTextToSize(cardPrimary, cW - 55);
  doc.text(nameLines, cardX, y + 12);
  doc.setFontSize(7); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
  let cardSubLine = '';
  if (ds.family === 'IMMOBILIER') {
    cardSubLine = [snapshot.address, [snapshot.postalCode, snapshot.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  } else if (ds.family === 'VEHICULE') {
    const vi = ds.vehicle_identification;
    cardSubLine = [vi?.make, vi?.model].filter(Boolean).join(' ');
    if (vi?.registrationNumber) cardSubLine += (cardSubLine ? ' · ' : '') + vi.registrationNumber;
  } else {
    const oi = ds.object_identification;
    cardSubLine = [oi?.brand, oi?.modelName].filter(Boolean).join(' ');
    if (oi?.serialNumber) cardSubLine += (cardSubLine ? ' · ' : '') + ('N° ' + oi.serialNumber);
  }
  if (cardSubLine) doc.text(cardSubLine, cardX, y + 19);
  y += 27;

  // ── Dossier status pill ───────────────────────────────────────────────────
  const statusColor = STATUS_COLOR[dossierStatus];
  const statusBg = STATUS_BG[dossierStatus];
  const statusLabel = STATUS_LABEL[dossierStatus];
  doc.setFontSize(9); doc.setFont('LiberationSans', 'bold');
  const slW = doc.getTextWidth(statusLabel) + 10;
  fill(statusBg); doc.roundedRect(M, y + 1, slW, 9, 2, 2, 'F');
  fill(statusColor); doc.circle(M + 4.5, y + 5.5, 1.5, 'F');
  rgb(statusColor); doc.text(statusLabel, M + 7.5, y + 7);
  y += 14;

  // ── Stat cards ────────────────────────────────────────────────────────────
  if (totalSections === 0) {
    doc.setFontSize(8.5); doc.setFont('LiberationSans', 'italic'); rgb(C.muted);
    doc.text('Aucune section évaluée', M, y + 5);
    y += 12;
  } else {
    type StatCard = { count: number; label: string; color: readonly [number,number,number]; bg: readonly [number,number,number] };
    const cards: StatCard[] = [];
    if (availableSections > 0) cards.push({ count: availableSections, label: 'Sections disponibles', color: C.green, bg: C.greenBg });
    if (partialSections > 0) cards.push({ count: partialSections, label: 'Sections à compléter', color: C.orange, bg: C.orangeBg });
    if (missingSections > 0) cards.push({ count: missingSections, label: 'Sections non renseignées', color: C.muted, bg: C.grayBg });
    const cardH = 18;
    const cardGap = 3;
    const cardW = (cW - cardGap * (cards.length - 1)) / cards.length;
    for (let ci = 0; ci < cards.length; ci++) {
      const card = cards[ci];
      const cx = M + ci * (cardW + cardGap);
      fill(C.bg); stroke(C.border);
      doc.roundedRect(cx, y, cardW, cardH, 1.5, 1.5, 'FD');
      doc.setFillColor(...card.color);
      doc.roundedRect(cx, y, cardW, 3, 1.5, 1.5, 'F');
      doc.rect(cx, y + 1.5, cardW, 1.5, 'F');
      doc.setFontSize(14); doc.setFont('LiberationSans', 'bold'); rgb(card.color);
      doc.text(String(card.count), cx + cardW / 2, y + 11, { align: 'center' });
      doc.setFontSize(6); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
      doc.text(card.label, cx + cardW / 2, y + 16, { align: 'center' });
    }
    y += cardH + 4;
  }
  y += 3;

  // ── Synthesis table ───────────────────────────────────────────────────────
  const synthHeaderH = 10;
  const synthRowHeights = synthRows.map(row => {
    if (row.valueOverride) {
      const valueX = M + cW * 0.52;
      const maxValueW = (M + cW - 31) - valueX - 4;
      const lines = doc.splitTextToSize(row.valueOverride, maxValueW);
      return lines.length > 1 ? 6 + lines.length * 5 : 10;
    }
    return 10;
  });
  const synthTableH = synthHeaderH + 2 + synthRowHeights.reduce((a, b) => a + b, 0) + 4;
  needY(synthTableH);

  fill(C.bg); stroke(C.border);
  doc.roundedRect(M, y, cW, synthTableH, 1.2, 1.2, 'FD');

  doc.setFontSize(8); doc.setFont('LiberationSans', 'bold'); rgb(C.muted);
  doc.text('SYNTHÈSE DU DOSSIER', M + 5, y + 6.5);
  doc.setFontSize(8); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
  doc.text(`Généré le ${generatedAt}`, M + cW - 5, y + 6.5, { align: 'right' });
  y += synthHeaderH + 2;

  for (let ri = 0; ri < synthRows.length; ri++) {
    const row = synthRows[ri];
    const rowH = synthRowHeights[ri];
    doc.setFontSize(9); doc.setFont('LiberationSans', 'normal'); rgb(C.ink);
    doc.text(row.label, M + 5, y + 6);
    if (row.valueOverride) {
      doc.setFontSize(8); rgb(C.muted);
      const valueX = M + cW * 0.52;
      const maxValueW = (M + cW - 31) - valueX - 4;
      const valueLines = doc.splitTextToSize(row.valueOverride, maxValueW);
      doc.text(valueLines, valueX, y + 6);
    }
    drawBadge(row.status as BadgeStatus, M + cW - 31, y + 6);
    y += rowH;
    if (ri < synthRows.length - 1) {
      stroke(C.border); doc.line(M + 2, y, M + cW - 2, y);
    }
  }
  y += 4;

  // ── Warning box ───────────────────────────────────────────────────────────
  doc.setFontSize(8); doc.setFont('LiberationSans', 'normal');
  const warnText = "Ce document regroupe les informations et documents associés au bien disponibles dans Verebona à la date de génération. Il ne garantit pas l'exhaustivité du dossier si certaines informations ou pièces justificatives ne sont pas renseignées.";
  const warnLines = doc.splitTextToSize(warnText, cW - 10);
  const warnBoxH = 8 + warnLines.length * 5 + 4;
  const footerZone = 12;
  const warnY = Math.max(y + 4, pageH - footerZone - warnBoxH - 4);
  fill(C.bg); stroke(C.border);
  doc.roundedRect(M, warnY, cW, warnBoxH, 1.5, 1.5, 'FD');
  doc.setFontSize(8); doc.setFont('LiberationSans', 'bold'); rgb(C.slate);
  doc.text('Avertissement.', M + 5, warnY + 6);
  doc.setFont('LiberationSans', 'normal'); rgb(C.slate);
  warnLines.forEach((line: string, li: number) => doc.text(line, M + 5, warnY + 12 + li * 5));

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION 01 — IDENTITÉ DU BIEN
  // ════════════════════════════════════════════════════════════════════════════
  if (sectionMap['identity']) {
    startSection('Identité du bien', '01');
    drawSectionTitle('Identité du bien');
    drawField('Nom du bien', snapshot.name);
    drawField('Catégorie', snapshot.category + (snapshot.subtype ? ' · ' + snapshot.subtype : ''));
    if (snapshot.description) drawField('Description', snapshot.description);

    if (ds.family === 'IMMOBILIER') {
      const loc = ds.location_identification;
      drawField('Adresse', loc?.address1 ?? snapshot.address);
      drawFieldRow([
        ['Code postal', loc?.postalCode ?? snapshot.postalCode],
        ['Ville', loc?.city ?? snapshot.city],
      ]);
      drawField('Réf. cadastrale', loc?.cadastralRef ?? null);
      drawField('Statut', snapshot.status?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) ?? null);
      drawField("Date d'achat", formatDate(snapshot.purchaseDate));
      drawField("N° d'immatriculation / série", snapshot.registrationNumber);
      drawField('État général', snapshot.generalCondition);
      drawField('N° de lot', loc?.lotNumber ?? null);
      drawField('Étage', loc?.floor ?? null);
      drawField('Coordonnées GPS', loc?.gpsCoords ?? null);
    } else if (ds.family === 'VEHICULE') {
      const vi = ds.vehicle_identification;
      const vu = ds.vehicle_usage;
      drawField('Marque / Modèle', [vi?.make, vi?.model].filter(Boolean).join(' '));
      drawFieldRow([
        ['Année', vi?.year ? String(vi.year) : null],
        ['Immatriculation', vi?.registrationNumber],
      ]);
      drawField('VIN / N° série', vi?.vin);
      drawField('Statut de détention', vu?.vehicleOwnershipStatus);
    } else {
      const oi = ds.object_identification;
      drawField('Marque / Modèle', [oi?.brand, oi?.modelName].filter(Boolean).join(' '));
      drawField('N° de série', oi?.serialNumber);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION 02 — CARACTÉRISTIQUES TECHNIQUES
  // ════════════════════════════════════════════════════════════════════════════
  if (sectionMap['characteristics']) {
    startSection('Caractéristiques techniques', '02');
    drawSectionTitle('Caractéristiques techniques');

    if (ds.family === 'IMMOBILIER') {
      const phys = ds.physical_characteristics;
      const perf = ds.performance_technical;
      const occ  = ds.occupancy_usage;
      if (phys?.livingArea)     drawField('Surface habitable', formatNum(phys.livingArea, 'm²'));
      if (phys?.landArea)       drawField('Surface terrain', formatNum(phys.landArea, 'm²'));
      if (phys?.roomCount)      drawField('Nombre de pièces', formatNum(phys.roomCount));
      if (phys?.bedroomCount)   drawField('Chambres', formatNum(phys.bedroomCount));
      if (phys?.levels)         drawField('Niveaux', formatNum(phys.levels));
      if (phys?.constructionYear) drawField('Année de construction', String(phys.constructionYear));
      drawFieldRow([
        ['État général', phys?.generalCondition],
        ['Type de chauffage', perf?.heatingType],
      ]);
      drawFieldRow([
        ['Énergie principale', perf?.mainEnergy],
        ['DPE', perf?.dpeClass ? `Classe ${perf.dpeClass}` : null],
      ]);
      if (perf?.gesClass) drawField('GES', `Classe ${perf.gesClass}`);
      if (perf?.dpeDate) drawField('Date DPE', formatDate(perf.dpeDate));
      drawFieldRow([
        ['Usage', occ?.occupancyUsage],
        ['Occupation', occ?.occupancyStatus],
      ]);
      if (occ?.monthlyRent) drawField('Loyer mensuel', formatNum(occ.monthlyRent, '€'));
      if (occ?.charges) drawField('Charges', formatNum(occ.charges, '€'));
      if (occ?.occupancyNotes) drawField('Notes occupation', occ.occupancyNotes);
      if (perf?.networks && perf.networks.length > 0) drawField('Réseaux', perf.networks.join(', '));
    } else if (ds.family === 'VEHICULE') {
      const vt = ds.vehicle_technical;
      const vu = ds.vehicle_usage;
      drawFieldRow([
        ['Carburant', vt?.fuelType],
        ['Puissance', vt?.powerKw ? formatNum(vt.powerKw, 'kW') : null],
      ]);
      drawFieldRow([
        ['Moteur', vt?.engine],
        ['Puiss. fiscale', vt?.fiscalHp ? formatNum(vt.fiscalHp, 'CV') : null],
      ]);
      drawFieldRow([
        ['Places', vt?.seats ? formatNum(vt.seats) : null],
        ['PTAC', vt?.ptac ? formatNum(vt.ptac, 'kg') : null],
      ]);
      if (vt?.firstRegistrationDate) drawField('1re mise en circulation', formatDate(vt.firstRegistrationDate));
      drawFieldRow([
        ['Kilométrage', vu?.mileage != null ? formatNum(vu.mileage, vu.mileageUnit ?? 'km') : null],
        ['Relevé au', formatDate(vu?.mileageDate)],
      ]);
      if (vu?.primaryUse) drawField('Usage principal', vu.primaryUse);
    } else {
      const oc = ds.object_condition;
      const op = ds.object_provenance;
      const ou = ds.object_usage;
      drawField('État', oc?.condition);
      drawFieldRow([
        ['Dimensions', oc?.dimensions],
        ['Poids', oc?.weight ? formatNum(oc.weight, 'kg') : null],
      ]);
      if (ou?.accessories) drawField('Accessoires', ou.accessories);
      drawField("Mode d'acquisition", op?.acquisitionMode);
      drawField('Provenance', op?.provenance);
      if (ou?.storageLocation) drawField('Lieu de stockage', ou.storageLocation);
      if (ou?.lastRevision) drawField('Dernière révision', formatDate(ou.lastRevision));
    }

    // Fallback for generic fields
    if (snapshot.mileageOrHours != null) drawField('Kilométrage / Heures', formatNum(snapshot.mileageOrHours));
    if (snapshot.warrantyEndDate) drawField('Fin de garantie', formatDate(snapshot.warrantyEndDate));
    if (snapshot.lastMaintenanceDate) drawField('Dernière maintenance', formatDate(snapshot.lastMaintenanceDate));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION 03 — VALEUR & INFORMATIONS FINANCIÈRES
  // ════════════════════════════════════════════════════════════════════════════
  if (sectionMap['financial']) {
    startSection('Valeur & informations financières', '03');
    drawSectionTitle('Valeur & informations financières');
    drawFieldRow([
      ["Prix d'achat", formatCents(snapshot.purchasePriceCents)],
      ['Valeur estimée', formatCents(snapshot.estimatedValueCents)],
    ]);
    const val = ds.valuation;
    drawField('Source de valorisation', val?.valuationSource ?? null);
    drawField('Date de valorisation', formatDate(val?.valuationDate));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION 04 — HISTORIQUE D'ENTRETIEN
  // ════════════════════════════════════════════════════════════════════════════
  if (sectionMap['maintenance'] && snapshot.events.length > 0) {
    startSection("Historique d'entretien", '04');
    drawSectionTitle("Historique d'entretien");

    const maintenanceEvents = snapshot.events
      .filter(e => ['entretien', 'reparation', 'maintenance'].some(k => e.categorie?.toLowerCase().includes(k)))
      .slice(0, 30);

    if (maintenanceEvents.length > 0) {
      drawSubTitle('Événements d\'entretien et réparation');
      for (const evt of maintenanceEvents) {
        needY(8);
        doc.setFontSize(8.5); doc.setFont('LiberationSans', 'bold'); rgb(C.ink);
        doc.text(evt.title, M + 2, y + 5);
        doc.setFontSize(7.5); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
        const meta = [formatDate(evt.date), evt.provider, evt.costCents != null ? formatCents(evt.costCents) : null].filter(Boolean).join(' · ');
        doc.text(meta, M + cW - 2, y + 5, { align: 'right' });
        y += 7;
        stroke(C.border); doc.line(M, y, M + cW, y);
      }
      y += 3;
    } else {
      doc.setFontSize(8); doc.setFont('LiberationSans', 'italic'); rgb(C.muted);
      doc.text('Aucun événement d\'entretien ou réparation.', M, y + 5);
      y += 10;
    }

    // Also show other events
    const otherEvents = snapshot.events.filter(e =>
      !['entretien', 'reparation', 'maintenance'].some(k => e.categorie?.toLowerCase().includes(k))
    ).slice(0, 15);
    if (otherEvents.length > 0) {
      drawSubTitle('Autres événements');
      for (const evt of otherEvents) {
        needY(8);
        doc.setFontSize(8.5); doc.setFont('LiberationSans', 'bold'); rgb(C.ink);
        doc.text(evt.title, M + 2, y + 5);
        doc.setFontSize(7.5); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
        const meta = [formatDate(evt.date), evt.categorie].filter(Boolean).join(' · ');
        doc.text(meta, M + cW - 2, y + 5, { align: 'right' });
        y += 7;
        stroke(C.border); doc.line(M, y, M + cW, y);
      }
      y += 3;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION 05 — DOCUMENTS ASSOCIÉS
  // ════════════════════════════════════════════════════════════════════════════
  if (sectionMap['documents'] && manifest.includedDocuments.length > 0) {
    startSection('Documents associés', '05');
    drawSectionTitle('Documents associés');

    // Group by category
    const grouped: Record<string, typeof manifest.includedDocuments> = {};
    for (const doc of manifest.includedDocuments) {
      const cat = DOC_CATEGORY_LABELS[doc.documentType ?? ''] ?? doc.documentType ?? 'Autres';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(doc);
    }

    const catOrder = Object.keys(grouped).sort();
    for (const cat of catOrder) {
      const catDocs = grouped[cat];
      drawSubTitle(cat);
      drawDocHeader();
      for (const d of catDocs) {
        const title = d.retainedTitle || d.originalFilename || '—';
        const catLabel = DOC_CATEGORY_LABELS[d.documentType ?? ''] ?? d.documentType ?? '—';
        drawDocRow(title, catLabel, d.documentDate, 'available');
      }
      y += 2;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION 06 — ÉQUIPEMENTS
  // ════════════════════════════════════════════════════════════════════════════
  if (sectionMap['equipments'] && snapshot.equipments.length > 0) {
    startSection('Équipements', '06');
    drawSectionTitle('Équipements');

    const sortedEquips = [...snapshot.equipments].sort((a, b) => (a.category ?? '').localeCompare(b.category ?? ''));
    for (const eq of sortedEquips) {
      needY(8);
      doc.setFontSize(8.5); doc.setFont('LiberationSans', 'bold'); rgb(C.ink);
      doc.text(eq.name, M + 2, y + 5);
      doc.setFontSize(7.5); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
      const meta = [eq.category, eq.type, eq.isMobilier ? 'Mobilier' : null].filter(Boolean).join(' · ');
      if (meta) doc.text(meta, M + cW - 2, y + 5, { align: 'right' });
      y += 7;
      stroke(C.border); doc.line(M, y, M + cW, y);
    }
    y += 3;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION 07 — PIÈCES / SOUS-STRUCTURES
  // ════════════════════════════════════════════════════════════════════════════
  if (sectionMap['rooms'] && snapshot.substructures.length > 0) {
    startSection('Pièces / sous-structures', '07');
    drawSectionTitle('Pièces / sous-structures');

    for (const sub of snapshot.substructures) {
      needY(8);
      doc.setFontSize(8.5); doc.setFont('LiberationSans', 'bold'); rgb(C.ink);
      doc.text(sub.name, M + 2, y + 5);
      y += 7;
      stroke(C.border); doc.line(M, y, M + cW, y);
    }
    y += 3;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION 08 — PHOTOS
  // ════════════════════════════════════════════════════════════════════════════
  if (sectionMap['photos'] && snapshot.photos.length > 0) {
    startSection('Photos', '08');
    drawSectionTitle('Photos');

    doc.setFontSize(8); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
    doc.text(`${snapshot.photos.length} photo${snapshot.photos.length > 1 ? 's' : ''} associée${snapshot.photos.length > 1 ? 's' : ''} au bien.`, M, y + 5);
    y += 10;

    for (const ph of snapshot.photos) {
      needY(8);
      doc.setFontSize(8); doc.setFont('LiberationSans', 'normal'); rgb(C.ink);
      doc.text(`• ${ph.originalFilename || ph.caption || `Photo ${ph.id}`}`, M + 2, y + 5);
      y += 7;
    }
    y += 3;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION 09 — ASSURANCE
  // ════════════════════════════════════════════════════════════════════════════
  if (sectionMap['insurance']) {
    startSection('Assurance', '09');
    drawSectionTitle('Assurance');

    if (ds.family === 'IMMOBILIER') {
      const ins = ds.insurance;
      if (ins?.isInsured) drawField('Assuré', ins.isInsured ? 'Oui' : 'Non');
      drawField('Assureur', ins?.insurer ?? null);
      drawField('N° de contrat', ins?.insuranceContractNumber ?? null);
      drawField('N° de client', ins?.insuranceClientNumber ?? null);
      drawField('Date d\'échéance', formatDate(ins?.insuranceExpiry));
      drawField('Prime annuelle', ins?.insurancePremium != null ? String(ins.insurancePremium) + ' €' : null);
    } else if (ds.family === 'VEHICULE') {
      const vins = ds.vehicle_insurance;
      if (vins?.isInsured) drawField('Assuré', vins.isInsured ? 'Oui' : 'Non');
      drawField('Assureur', vins?.insurer ?? null);
      drawField('N° de contrat', vins?.insuranceContractNumber ?? null);
      drawField('N° de client', vins?.insuranceClientNumber ?? null);
      drawField('Date d\'échéance', formatDate(vins?.insuranceExpiry));
      drawField('Prime annuelle', vins?.insurancePremium != null ? String(vins.insurancePremium) + ' €' : null);
      drawField('Prochain contrôle technique', formatDate(vins?.nextInspection));
    } else {
      const ou = ds.object_usage;
      if (ou?.isInsured) drawField('Assuré', ou.isInsured ? 'Oui' : 'Non');
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // End-of-document block
  // ════════════════════════════════════════════════════════════════════════════
  const genDate = (manifest.generatedAt ?? new Date().toISOString()).slice(0, 10);
  const shaStr = `SHA · ${snapshot.id.toString(16).padStart(4, '0')}-${(manifest.generatedAt ?? '').slice(0, 10).replace(/-/g, '').slice(-4)}`;
  doc.setFontSize(8); doc.setFont('LiberationSans', 'normal');
  const legalText = `Généré automatiquement par Verebona à partir des données saisies. Ne remplace pas un document établi par un professionnel qualifié et ne garantit pas la conformité réglementaire. Mise à jour recommandée à chaque évolution du bien.`;
  const legalLines = doc.splitTextToSize(legalText, cW - 10);
  const eodBoxH = 6 + 7 + 5 + legalLines.length * 4.5 + 6;
  needY(eodBoxH);
  fill(C.navyLight); stroke(C.border);
  doc.roundedRect(M, y, cW, eodBoxH, 2, 2, 'FD');
  doc.setFontSize(8.5); doc.setFont('LiberationSans', 'bold'); rgb(C.ink);
  doc.text('Fin du document', M + 5, y + 8);
  doc.setFontSize(7); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
  doc.text(`${genDate} · ${shaStr}`, M + cW - 5, y + 8, { align: 'right' });
  stroke(C.border); doc.setLineWidth(0.2);
  doc.line(M + 5, y + 11, M + cW - 5, y + 11);
  doc.setLineWidth(0.3);
  doc.setFontSize(7); doc.setFont('LiberationSans', 'normal'); rgb(C.muted);
  legalLines.forEach((line: string, li: number) => doc.text(line, M + 5, y + 16 + li * 4.5));

  // Footers on all pages
  addFooters(doc, snapshot, manifest);

  return Buffer.from(doc.output('arraybuffer'));
}

// ─── Footer helper ─────────────────────────────────────────────────────────────

function addFooters(doc: any, snapshot: AssetSnapshot, manifest: ExportManifest): void {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 16;
  const totalPages = doc.internal.getNumberOfPages();
  const P = PDF_PALETTE;

  // Footer: 12mm tall zone — sign icon only (no text/tagline), separator at top of zone
  const footerH = 12;
  const footerTop = pageH - footerH;

  // Draw the Verebona sign matching the official SVG:
  // – 8 dark squares in an L-shaped 3×3 grid (top-right cell is empty)
  // – 1 blue square at top-right, slightly raised and rotated +18°
  const drawVerebonaSign = (cx: number, cy: number, signSize: number) => {
    // SVG grid: 3 cols × 3 rows, each cell 24px, gap 6px → total 84px wide/tall
    const scale = signSize / 84;
    const cell = 24 * scale;
    const gap  = 6  * scale;
    const r    = 4  * scale; // rx from SVG
    const originX = cx - (3 * cell + 2 * gap) / 2;
    const originY = cy - (3 * cell + 2 * gap) / 2;

    // SVG cell positions (x, y in SVG units, then scaled)
    const darkCells: [number, number][] = [
      [0, 0], [30, 0],           // row 1: col 0, col 1 (col 2 is blue, empty here)
      [0, 30], [30, 30], [60, 30], // row 2: all 3
      [0, 60], [30, 60], [60, 60], // row 3: all 3
    ];
    doc.setFillColor(...P.ink);
    for (const [svgX, svgY] of darkCells) {
      doc.roundedRect(originX + svgX * scale, originY + svgY * scale, cell, cell, r, r, 'F');
    }

    // Blue square — SVG: x=60 y=-4, rotated 18° around its own centre (72, 8) in local coords
    // Centre in PDF: originX + 72*scale, originY + 8*scale  (y=8 = -4 + half cell 12, above row-1 centre)
    const blueCx = originX + 72 * scale;
    const blueCy = originY + 8 * scale;
    const angleRad = (18 * Math.PI) / 180;
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);
    const hw = cell / 2;
    const corners: [number, number][] = [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]];
    const rot = corners.map(([dx, dy]) => [blueCx + dx * cosA - dy * sinA, blueCy + dx * sinA + dy * cosA] as [number, number]);
    doc.setFillColor(...P.primary);
    doc.triangle(rot[0][0], rot[0][1], rot[1][0], rot[1][1], rot[2][0], rot[2][1], 'F');
    doc.triangle(rot[0][0], rot[0][1], rot[2][0], rot[2][1], rot[3][0], rot[3][1], 'F');
  };

  const exportLabel = (() => {
    if (manifest.exportType === 'CIL_REGLEMENTAIRE') return "CIL — Carnet d'Information du Logement";
    if (manifest.exportType === 'DOSSIER_COMPLET') return 'DCB — Dossier Complet du Bien';
    return manifest.exportType.replace(/_/g, ' ');
  })();

  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    // Left brand bar — full height on all pages
    doc.setFillColor(...P.primary);
    doc.rect(0, 0, 1.5, pageH, 'F');

    // Footer separator line — top of footer zone
    doc.setDrawColor(...P.borderMid);
    doc.setLineWidth(0.3);
    doc.line(margin, footerTop, pageW - margin, footerTop);

    // Set font before any width calculations
    doc.setFontSize(7); doc.setFont('LiberationSans', 'normal');
    doc.setTextColor(...P.muted);

    // Baseline aligned on sign centre: signCy + half cap-height for 7pt (~1mm)
    const textY = footerTop + footerH / 2 + 1;

    // Sign icon — vertically centred in footer zone (small, ~half header logo size)
    const signSize = 4; // overall bounding box in mm
    const signCx = margin + signSize / 2;
    const signCy = footerTop + footerH / 2;
    drawVerebonaSign(signCx, signCy, signSize);
    // Restore text color after sign drawing
    doc.setTextColor(...P.muted);

    // "verebona.fr" immediately to the right of the sign, vertically centred
    const siteStr = 'verebona.fr';
    doc.text(siteStr, signCx + signSize / 2 + 2, textY);

    // Centre: asset name · export type
    doc.text(`${snapshot.name} · ${exportLabel}`, pageW / 2, textY, { align: 'center' });

    // Right: page number only
    const pageStr = `${String(i).padStart(2, '0')} / ${String(totalPages).padStart(2, '0')}`;
    doc.text(pageStr, pageW - margin, textY, { align: 'right' });
  }
}

// ─── Export principal ──────────────────────────────────────────────────────────

export async function renderExportToPdf(
  manifest: ExportManifest,
  snapshot: AssetSnapshot,
): Promise<Buffer> {
  if (manifest.exportType === 'EXPORT_BRUT') {
    return renderViaJsPdf(manifest, snapshot);
  }

  const pdfMonkeyTemplateId = await getPdfMonkeyTemplateId(manifest.exportType);

  if (pdfMonkeyTemplateId) {
    try {
      return await renderViaPdfMonkey(pdfMonkeyTemplateId, manifest, snapshot);
    } catch (err) {
      console.error(`[PdfRenderer] PDFMonkey failed for ${manifest.exportType}, falling back to jsPDF:`, err);
    }
  } else {
    console.warn(`[PdfRenderer] No PDFMonkey template for ${manifest.exportType}, using jsPDF fallback`);
  }

  return renderViaJsPdf(manifest, snapshot);
}

// Kept for backward compat
export { renderViaJsPdf as buildExportHtml };
