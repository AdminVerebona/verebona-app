/**
 * Route API générique : Génération PDF via PDFMonkey
 * Fonctionne avec n'importe quel template configuré dans export_templates
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { assets, exportTemplates } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { generatePdfFromTemplate } from '@/services/pdfGenerationService';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ✅ Client S3 pour générer des URLs signées
const s3Client = new S3Client({
  region: process.env.OVH_S3_REGION || 'gra',
  endpoint: process.env.OVH_S3_ENDPOINT || 'https://s3.gra.io.cloud.ovh.net',
  credentials: {
    accessKeyId: process.env.OVH_S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.OVH_S3_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: false,
});

/**
 * ✅ Génère une URL signée pour une photo stockée sur S3
 */
async function generateSignedPhotoUrl(photoUrl: string): Promise<string | null> {
  try {
    const s3Bucket = process.env.OVH_S3_BUCKET || 'owntrack';
    
    // Parse URL to extract S3 key
    const url = new URL(photoUrl);
    const pathname = url.pathname;
    const pathWithoutSlash = pathname.startsWith('/') ? pathname.substring(1) : pathname;
    const firstSlashIndex = pathWithoutSlash.indexOf('/');
    
    if (firstSlashIndex === -1) {
      console.error('Invalid S3 path format:', photoUrl);
      return null;
    }
    
    // Extract key (everything after bucket name)
    const s3Key = pathWithoutSlash.substring(firstSlashIndex + 1);
    
    
    // Generate signed URL valid for 2 hours (enough for PDF generation)
    const command = new GetObjectCommand({
      Bucket: s3Bucket,
      Key: s3Key,
      ResponseContentDisposition: 'inline',
    });
    
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 7200 });
    return signedUrl;
  } catch (error) {
    console.error('[PDF Export] Failed to generate signed URL:', error);
    return null;
  }
}

/**
 * Charge les données d'un asset depuis la BDD
 */
async function loadAssetData(assetId: number, userId: number) {
  const results = await db
    .select()
    .from(assets)
    .where(and(
      eq(assets.id, assetId),
      eq(assets.userId, userId)
    ))
    .limit(1);

  if (results.length === 0) {
    return null;
  }

  const asset = results[0];

  // Parser keyCharacteristics si c'est du JSON
  let keyChars: any = {};
  if (asset.keyCharacteristics) {
    try {
      keyChars = JSON.parse(asset.keyCharacteristics);
    } catch {
      // Ignorer si pas du JSON
    }
  }

  // Parser equipmentList
  let equipments: string[] = [];
  if (asset.equipmentList) {
    try {
      equipments = JSON.parse(asset.equipmentList);
    } catch {
      equipments = asset.equipmentList.split(',').map(e => e.trim()).filter(Boolean);
    }
  }

  // ✅ Déterminer quelle photo utiliser (mainPhotoUrl ou thumbnailUrl comme fallback)
  let photoUrl: string | null = keyChars.mainPhotoUrl || asset.thumbnailUrl || null;
  
  // ✅ Générer une URL signée pour que PDFMonkey puisse accéder à la photo
  let signedPhotoUrl: string | null = null;
  if (photoUrl) {
    signedPhotoUrl = await generateSignedPhotoUrl(photoUrl);
  }

  return {
    id: asset.id,
    name: asset.name,
    category: asset.category,
    userId: asset.userId,
    brand: keyChars.brand || asset.subtype,
    model: keyChars.model,
    reference: asset.notes,
    city: keyChars.city || asset.purchaseLocation,
    mainPhotoUrl: signedPhotoUrl, // ✅ URL signée prête pour PDFMonkey
    thumbnailUrl: asset.thumbnailUrl, // ✅ Garder l'originale pour référence
    bikeCategory: keyChars.bikeCategory,
    isElectric: keyChars.isElectric,
    color: keyChars.color,
    description: asset.notes,
    purchaseDate: asset.purchaseDate,
    purchasePriceCents: asset.purchasePriceCents,
    frameSize: keyChars.frameSize,
    bikeTypeLabel: keyChars.bikeTypeLabel || keyChars.bikeCategory,
    generalCondition: asset.generalCondition,
    usageLabel: keyChars.usageLabel,
    transmissionLabel: keyChars.transmissionLabel,
    brakesLabel: keyChars.brakesLabel,
    frameMaterialLabel: keyChars.frameMaterialLabel,
    weightKg: keyChars.weightKg,
    equipments,
    lastMaintenanceDate: asset.lastMaintenanceDate,
    maintenanceNotes: keyChars.maintenanceNotes || keyChars.maintenance,
    serialNumber: keyChars.serialNumber,
    registrationLabel: keyChars.registrationLabel,
    hasPurchaseInvoice: keyChars.hasPurchaseInvoice,
    isFirstOwner: keyChars.isFirstOwner,
    keyCharacteristics: keyChars,
  };
}

/**
 * Construit le payload JSON pour PDFMonkey
 * Format standard qui fonctionne pour tous les templates
 */
function buildPdfPayload(asset: any, optionalFields?: { prixVente?: number | null; kmCompteur?: number | null }) {
  const basePayload: any = {
    asset: {
      brand: asset.brand,
      model: asset.model,
      reference: asset.reference,
      city: asset.city,
      mainPhotoUrl: asset.mainPhotoUrl, // ✅ URL signée

      keyCharacteristics: {
        bikeCategory: asset.bikeCategory,
        isElectric: asset.isElectric,
        color: asset.color,
        ...asset.keyCharacteristics
      },

      notes: asset.description,
      purchaseDate: asset.purchaseDate,
      purchasePriceCents: asset.purchasePriceCents,
      frameSize: asset.frameSize,
      bikeTypeLabel: asset.bikeTypeLabel,
      conditionLabel: asset.generalCondition,
      usageLabel: asset.usageLabel,
      transmissionLabel: asset.transmissionLabel,
      brakesLabel: asset.brakesLabel,
      frameMaterialLabel: asset.frameMaterialLabel,
      weightKg: asset.weightKg,
      equipments: asset.equipments ?? [],
      lastMaintenanceDate: asset.lastMaintenanceDate,
      maintenance: asset.maintenanceNotes,
      serialNumber: asset.serialNumber,
      registrationLabel: asset.registrationLabel,
      hasPurchaseInvoice: asset.hasPurchaseInvoice,
      isFirstOwner: asset.isFirstOwner,
    }
  };

  // ✅ Ajouter prixVente SEULEMENT si complété (non null)
  if (optionalFields?.prixVente !== null && optionalFields?.prixVente !== undefined) {
    basePayload.asset.prixVente = optionalFields.prixVente;
  }

  // ✅ Ajouter kmCompteur SEULEMENT si complété (non null)
  if (optionalFields?.kmCompteur !== null && optionalFields?.kmCompteur !== undefined) {
    basePayload.asset.kmCompteur = optionalFields.kmCompteur;
  }

  return basePayload;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; templateId: string }> }
) {
  try {
    // Vérifier l'authentification
    const session = await SessionService.getSession(request);
    if (!session) {
      return NextResponse.json(
        { error: 'Non authentifié' },
        { status: 401 }
      );
    }

    // ✅ FIXED: Await params (Next.js 15 requirement)
    const resolvedParams = await params;
    const assetId = parseInt(resolvedParams.id);
    const templateId = parseInt(resolvedParams.templateId);

    if (isNaN(assetId) || isNaN(templateId)) {
      return NextResponse.json(
        { error: 'ID invalide' },
        { status: 400 }
      );
    }

    // ✅ NEW: Parse optional fields from request body
    let optionalFields: { prixVente?: number | null; kmCompteur?: number | null } = {};
    try {
      const body = await request.json();
      optionalFields = {
        prixVente: body.prixVente ?? null,
        kmCompteur: body.kmCompteur ?? null,
      };
      
    } catch (error) {
      // Body is optional, continue without it
    }

    // Charger le template
    const templateResults = await db
      .select()
      .from(exportTemplates)
      .where(eq(exportTemplates.id, templateId))
      .limit(1);

    if (templateResults.length === 0) {
      return NextResponse.json(
        { error: 'Template non trouvé' },
        { status: 404 }
      );
    }

    const template = templateResults[0];

    if (!template.isActive) {
      return NextResponse.json(
        { error: 'Template désactivé' },
        { status: 403 }
      );
    }

    if (!template.pdfmonkeyTemplateId) {
      return NextResponse.json(
        { error: 'Template PDFMonkey non configuré' },
        { status: 400 }
      );
    }

    // Charger l'asset
    const asset = await loadAssetData(assetId, session.userId);

    if (!asset) {
      return NextResponse.json(
        { error: 'Bien non trouvé' },
        { status: 404 }
      );
    }

    // Construire le payload avec les champs optionnels
    const payload = buildPdfPayload(asset, optionalFields);

    // ✅ FIXED: Passer directement l'ID PDFMonkey au lieu d'une clé
    const pdfBuffer = await generatePdfFromTemplate(
      template.pdfmonkeyTemplateId,
      payload,
      { asset, template }
    );

    // Retourner le PDF
    const filename = `${asset.name}_${template.label.replace(/[^a-zA-Z0-9-_]/g, '_')}.pdf`;

    return new NextResponse(pdfBuffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': pdfBuffer.length.toString(),
      },
    });
  } catch (error) {
    console.error('[PDF Export API] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Erreur lors de la génération du PDF' },
      { status: 500 }
    );
  }
}