/**
 * Service d'assemblage ZIP pour les exports
 *
 * STANDARD — ZIP brut à plat :
 *   - Fichiers à la racine uniquement (pas de dossiers)
 *   - Aucun récapitulatif, aucun JSON
 *   - Collision de noms : suffixe numérique
 *
 * PREMIUM — ZIP structuré :
 *   - Dossiers par catégorie documentaire
 *   - recap_donnees.txt : résumé lisible des données du bien
 *   - Aucun JSON (interne uniquement)
 */

import JSZip from 'jszip';
import { s3Client, S3_BUCKET } from '@/lib/s3-client';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { ExportManifest } from './export-manifest.service';
import type { AssetSnapshot, DocumentRef } from './export-snapshot.service';

async function downloadFromS3(s3Key: string, bucket?: string | null): Promise<Buffer | null> {
  try {
    const command = new GetObjectCommand({
      Bucket: bucket || S3_BUCKET,
      Key: s3Key,
    });
    const response = await s3Client.send(command);
    if (!response.Body) return null;
    const chunks: Uint8Array[] = [];
    const stream = response.Body as AsyncIterable<Uint8Array>;
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (err) {
    console.error('[ExportZip] Failed to download from S3:', s3Key, err);
    return null;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\-àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ ]/g, '_').slice(0, 100);
}

function getFileExtension(doc: DocumentRef): string {
  if (doc.mimeType) {
    const parts = doc.mimeType.split('/');
    if (parts[1] && parts[1] !== 'octet-stream') return parts[1].replace('jpeg', 'jpg');
  }
  if (doc.originalFilename) {
    const ext = doc.originalFilename.split('.').pop();
    if (ext) return ext;
  }
  return 'bin';
}

// ─── Récapitulatif lisible (premium EXPORT_BRUT uniquement) ──────────────────

function fmtDate(s: string | null | undefined): string {
  if (!s) return '';
  try { return new Intl.DateTimeFormat('fr-FR').format(new Date(s)); } catch { return s; }
}

function buildRecapTxt(snapshot: AssetSnapshot): string {
  const lines: string[] = [];
  const sep = '─'.repeat(60);
  const ds = snapshot.detailSections;

  lines.push('EXPORT DONNÉES BRUTES — VEREBONA');
  lines.push(sep);
  lines.push('');
  lines.push(`BIEN : ${snapshot.name}`);
  if (snapshot.category) lines.push(`Catégorie : ${snapshot.category}`);
  if (snapshot.subtype)  lines.push(`Sous-type : ${snapshot.subtype}`);
  if (snapshot.status)   lines.push(`Statut : ${snapshot.status}`);

  // ── Sections structurées selon la famille ──────────────────────────────────
  if (ds.family === 'IMMOBILIER') {
    const loc  = ds.location_identification;
    const phys = ds.physical_characteristics;
    const perf = ds.performance_technical;
    const occ  = ds.occupancy_usage;
    const val  = ds.valuation;

    if (loc?.address1 || loc?.city) {
      const addr = [loc.address1, loc.address2, loc.postalCode, loc.city, loc.country].filter(Boolean).join(', ');
      lines.push(`Adresse : ${addr}`);
    }
    if (loc?.cadastralRef)  lines.push(`Référence cadastrale : ${loc.cadastralRef}`);
    if (loc?.lotNumber)     lines.push(`N° de lot : ${loc.lotNumber}`);
    if (loc?.floor)         lines.push(`Étage : ${loc.floor}`);
    lines.push('');
    lines.push('CARACTÉRISTIQUES PHYSIQUES');
    if (phys?.livingArea)       lines.push(`  Surface habitable : ${phys.livingArea} m²`);
    if (phys?.landArea)         lines.push(`  Surface terrain : ${phys.landArea} m²`);
    if (phys?.roomCount)        lines.push(`  Pièces : ${phys.roomCount}`);
    if (phys?.bedroomCount)     lines.push(`  Chambres : ${phys.bedroomCount}`);
    if (phys?.levels)           lines.push(`  Niveaux : ${phys.levels}`);
    if (phys?.constructionYear) lines.push(`  Année de construction : ${phys.constructionYear}`);
    if (phys?.generalCondition) lines.push(`  État général : ${phys.generalCondition}`);
    lines.push('');
    lines.push('PERFORMANCE ÉNERGÉTIQUE');
    if (perf?.heatingType)   lines.push(`  Type de chauffage : ${perf.heatingType}`);
    if (perf?.mainEnergy)    lines.push(`  Énergie principale : ${perf.mainEnergy}`);
    if (perf?.dpeClass)      lines.push(`  Classe DPE : ${perf.dpeClass}`);
    if (perf?.dpeDate)       lines.push(`  Date DPE : ${fmtDate(perf.dpeDate)}`);
    if (perf?.gesClass)      lines.push(`  Classe GES : ${perf.gesClass}`);
    if (perf?.networks?.length) lines.push(`  Réseaux : ${perf.networks.join(', ')}`);
    if (occ?.occupancyUsage)  lines.push('');
    if (occ?.occupancyUsage)  lines.push('OCCUPATION');
    if (occ?.occupancyUsage)  lines.push(`  Usage : ${occ.occupancyUsage}`);
    if (occ?.occupancyStatus) lines.push(`  Statut : ${occ.occupancyStatus}`);
    if (occ?.monthlyRent)     lines.push(`  Loyer mensuel : ${occ.monthlyRent} €`);
    if (occ?.charges)         lines.push(`  Charges : ${occ.charges} €`);
    if (val?.valuationLow || val?.valuationHigh) {
      lines.push('');
      lines.push('VALORISATION');
      if (val.valuationLow)    lines.push(`  Estimation basse : ${val.valuationLow} €`);
      if (val.valuationHigh)   lines.push(`  Estimation haute : ${val.valuationHigh} €`);
      if (val.valuationSource) lines.push(`  Source : ${val.valuationSource}`);
      if (val.valuationDate)   lines.push(`  Date : ${fmtDate(val.valuationDate)}`);
    }

  } else if (ds.family === 'VEHICULE') {
    const vi   = ds.vehicle_identification;
    const vt   = ds.vehicle_technical;
    const vu   = ds.vehicle_usage;
    const vins = ds.vehicle_insurance;
    const val  = ds.valuation;

    lines.push('');
    lines.push('IDENTIFICATION DU VÉHICULE');
    if (vi?.make)                lines.push(`  Marque : ${vi.make}`);
    if (vi?.model)               lines.push(`  Modèle : ${vi.model}`);
    if (vi?.year)                lines.push(`  Année : ${vi.year}`);
    if (vi?.registrationNumber)  lines.push(`  Immatriculation : ${vi.registrationNumber}`);
    if (vi?.vin)                 lines.push(`  VIN / N° série : ${vi.vin}`);
    lines.push('');
    lines.push('TECHNIQUE');
    if (vt?.fuelType)            lines.push(`  Carburant : ${vt.fuelType}`);
    if (vt?.engine)              lines.push(`  Moteur : ${vt.engine}`);
    if (vt?.powerKw)             lines.push(`  Puissance : ${vt.powerKw} kW`);
    if (vt?.seats)               lines.push(`  Places : ${vt.seats}`);
    if (vt?.firstRegistrationDate) lines.push(`  1ère mise en circulation : ${fmtDate(vt.firstRegistrationDate)}`);
    if (vu?.mileage != null)     lines.push(`  Kilométrage : ${vu.mileage} ${vu.mileageUnit ?? 'km'}${vu.mileageDate ? ` (au ${fmtDate(vu.mileageDate)})` : ''}`);
    if (vins?.insurer || vins?.insuranceExpiry) {
      lines.push('');
      lines.push('ASSURANCE');
      if (vins?.insurer)            lines.push(`  Assureur : ${vins.insurer}`);
      if (vins?.insuranceExpiry)    lines.push(`  Échéance : ${fmtDate(vins.insuranceExpiry)}`);
      if (vins?.nextInspection)     lines.push(`  Prochain CT : ${fmtDate(vins.nextInspection)}`);
    }
    if (val?.valuationLow || val?.valuationHigh) {
      lines.push('');
      lines.push('VALORISATION');
      if (val.valuationLow)  lines.push(`  Estimation basse : ${val.valuationLow} €`);
      if (val.valuationHigh) lines.push(`  Estimation haute : ${val.valuationHigh} €`);
    }

  } else {
    const oi  = ds.object_identification;
    const oc  = ds.object_condition;
    const op  = ds.object_provenance;
    const val = ds.valuation;

    lines.push('');
    lines.push('IDENTIFICATION');
    if (oi?.objectCategory) lines.push(`  Catégorie objet : ${oi.objectCategory}`);
    if (oi?.brand)          lines.push(`  Marque : ${oi.brand}`);
    if (oi?.modelName)      lines.push(`  Modèle : ${oi.modelName}`);
    if (oi?.serialNumber)   lines.push(`  N° de série : ${oi.serialNumber}`);
    if (oc?.condition)      lines.push(`  État : ${oc.condition}`);
    if (oc?.dimensions)     lines.push(`  Dimensions : ${oc.dimensions}`);
    if (oc?.weight)         lines.push(`  Poids : ${oc.weight}`);
    if (op?.acquisitionMode) lines.push(`  Mode d'acquisition : ${op.acquisitionMode}`);
    if (op?.provenance)     lines.push(`  Provenance : ${op.provenance}`);
    if (val?.valuationLow || val?.valuationHigh) {
      lines.push('');
      lines.push('VALORISATION');
      if (val.valuationLow)  lines.push(`  Estimation basse : ${val.valuationLow} €`);
      if (val.valuationHigh) lines.push(`  Estimation haute : ${val.valuationHigh} €`);
    }
  }

  // ── Valeurs financières communes ──────────────────────────────────────────
  lines.push('');
  if (snapshot.purchasePriceCents != null) {
    lines.push(`Prix d'achat : ${(snapshot.purchasePriceCents / 100).toFixed(2)} €`);
  }
  if (snapshot.estimatedValueCents != null) {
    lines.push(`Valeur estimée : ${(snapshot.estimatedValueCents / 100).toFixed(2)} €`);
  }
  if (snapshot.purchaseDate)         lines.push(`Date d'achat : ${fmtDate(snapshot.purchaseDate)}`);
  if (snapshot.warrantyEndDate)      lines.push(`Fin de garantie : ${fmtDate(snapshot.warrantyEndDate)}`);
  if (snapshot.lastMaintenanceDate)  lines.push(`Dernière maintenance : ${fmtDate(snapshot.lastMaintenanceDate)}`);
  if (snapshot.notes)                lines.push(`Notes : ${snapshot.notes}`);

  // Documents
  const realDocs = snapshot.documents.filter(d => !d.isWebLink);
  lines.push('');
  lines.push(`DOCUMENTS (${realDocs.length} fichier${realDocs.length > 1 ? 's' : ''})`);
  if (realDocs.length === 0) {
    lines.push('  (aucun document)');
  } else {
    for (const d of realDocs) {
      const title = d.retainedTitle || d.originalFilename || '—';
      const parts = [`  - ${title}`, d.documentType, d.documentDate].filter(Boolean);
      lines.push(parts.join(' — '));
    }
  }

  // Web links
  const webLinks = snapshot.documents.filter(d => d.isWebLink);
  if (webLinks.length > 0) {
    lines.push('');
    lines.push(`LIENS WEB (${webLinks.length})`);
    for (const w of webLinks) {
      lines.push(`  - ${w.webLinkTitle || w.webLinkUrl} : ${w.webLinkUrl}`);
    }
  }

  // Équipements
  lines.push('');
  lines.push(`ÉQUIPEMENTS (${snapshot.equipments.length})`);
  if (snapshot.equipments.length === 0) {
    lines.push('  (aucun équipement)');
  } else {
    for (const e of snapshot.equipments) {
      const parts = [`  - ${e.name}`, e.category, e.type, e.status].filter(Boolean);
      lines.push(parts.join(' — '));
    }
  }

  // Photos
  lines.push('');
  lines.push(`PHOTOS (${snapshot.photos.length})`);
  if (snapshot.photos.length === 0) {
    lines.push('  (aucune photo)');
  }

  // Événements
  lines.push('');
  lines.push(`AGENDA / ÉVÉNEMENTS (${snapshot.events.length})`);
  if (snapshot.events.length === 0) {
    lines.push('  (aucun événement)');
  } else {
    for (const e of snapshot.events) {
      const parts = [`  - ${e.title}`, e.date, e.categorie].filter(Boolean);
      lines.push(parts.join(' — '));
    }
  }

  lines.push('');
  lines.push(sep);
  lines.push(`Export généré le ${new Date().toLocaleDateString('fr-FR')} via Verebona`);
  lines.push('');

  return lines.join('\n');
}

// ─── Export brut STANDARD : ZIP à plat (fichiers seuls) ───────────────────────

async function buildFlatZip(snapshot: AssetSnapshot): Promise<Buffer> {
  const zip = new JSZip();
  const usedNames = new Map<string, number>();

  const addFile = async (doc: DocumentRef) => {
    if (!doc.s3Key || doc.isWebLink) return;
    const buf = await downloadFromS3(doc.s3Key, doc.s3Bucket);
    if (!buf) return;
    const base = sanitizeFilename(doc.retainedTitle || doc.originalFilename || `fichier_${doc.id}`);
    const ext = getFileExtension(doc);
    let filename = `${base}.${ext}`;
    // Collision: suffixe numérique
    const key = filename.toLowerCase();
    const count = usedNames.get(key) ?? 0;
    if (count > 0) filename = `${base}_${count}.${ext}`;
    usedNames.set(key, count + 1);
    zip.file(filename, buf);
  };

  for (const doc of snapshot.documents) {
    await addFile(doc);
  }

  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// ─── Export brut PREMIUM : ZIP structuré + recap_donnees.txt ──────────────────

async function buildStructuredZip(manifest: ExportManifest, snapshot: AssetSnapshot): Promise<Buffer> {
  const zip = new JSZip();

  // recap_donnees.txt en racine
  zip.file('recap_donnees.txt', buildRecapTxt(snapshot));

  // Documents par catégorie (dossier par documentType)
  const realDocs = snapshot.documents.filter(d => !d.isWebLink && d.s3Key);
  if (realDocs.length > 0) {
    const grouped: Record<string, DocumentRef[]> = {};
    for (const doc of realDocs) {
      const folder = sanitizeFilename(doc.documentType || 'AUTRE');
      if (!grouped[folder]) grouped[folder] = [];
      grouped[folder].push(doc);
    }
    for (const [folderName, docs] of Object.entries(grouped)) {
      const folder = zip.folder(`documents/${folderName}`)!;
      for (const doc of docs) {
        if (!doc.s3Key) continue;
        const buf = await downloadFromS3(doc.s3Key, doc.s3Bucket);
        if (!buf) continue;
        const base = sanitizeFilename(doc.retainedTitle || doc.originalFilename || `fichier_${doc.id}`);
        const ext = getFileExtension(doc);
        folder.file(`${base}.${ext}`, buf);
      }
    }
  }

  // Photos dans un dossier dédié
  if (snapshot.photos.length > 0) {
    const photosFolder = zip.folder('photos')!;
    const sorted = [...snapshot.photos].sort((a, b) =>
      (a.isPrimary ? 0 : 1) - (b.isPrimary ? 0 : 1) || a.displayOrder - b.displayOrder
    );
    let idx = 1;
    for (const photo of sorted) {
      if (!photo.s3Key) continue;
      const buf = await downloadFromS3(photo.s3Key, photo.s3Bucket);
      if (!buf) continue;
      const filename = `photo_${idx++}${photo.isPrimary ? '_principale' : ''}.jpg`;
      photosFolder.file(filename, buf);
    }
  }

  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// ─── Fonction principale ──────────────────────────────────────────────────────

export async function buildExportZip(
  manifest: ExportManifest,
  snapshot: AssetSnapshot,
  pdfBuffer: Buffer | null,
  isPremium: boolean,
): Promise<Buffer> {
  if (manifest.exportType === 'EXPORT_BRUT') {
    if (isPremium) {
      return buildStructuredZip(manifest, snapshot);
    } else {
      return buildFlatZip(snapshot);
    }
  }

  // Autres usages documentaires : ZIP contient le PDF + documents joints
  const zip = new JSZip();
  const rootName = sanitizeFilename(`${snapshot.name}_${manifest.exportType}`);
  const root = zip.folder(rootName)!;

  if (pdfBuffer) {
    root.file(`${sanitizeFilename(snapshot.name)}_${manifest.exportType}.pdf`, pdfBuffer);
  }

  if (isPremium && manifest.includedDocuments.length > 0) {
    const docsFolder = root.folder('documents')!;
    const grouped: Record<string, DocumentRef[]> = {};
    for (const doc of manifest.includedDocuments) {
      const folder = sanitizeFilename(doc.documentType || 'AUTRE');
      if (!grouped[folder]) grouped[folder] = [];
      grouped[folder].push(doc);
    }
    for (const [folderName, docs] of Object.entries(grouped)) {
      const folder = docsFolder.folder(folderName)!;
      for (const doc of docs) {
        if (!doc.s3Key) continue;
        const buf = await downloadFromS3(doc.s3Key, doc.s3Bucket);
        if (!buf) continue;
        const base = sanitizeFilename(doc.retainedTitle || doc.originalFilename || `doc_${doc.id}`);
        const ext = getFileExtension(doc);
        folder.file(`${base}.${ext}`, buf);
      }
    }
  }

  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
