/**
 * Service de génération générique
 * Ne connaît pas le métier (vélo, immo, etc.)
 * Prend un templateId PDFMonkey, un payload, et renvoie un Buffer PDF
 */

import { createPdfDocument, getDocumentCard, downloadPdf } from '@/lib/pdfmonkey-client';

/**
 * Génère un PDF directement depuis un template ID PDFMonkey
 */
export async function generatePdfFromTemplate(
  pdfmonkeyTemplateId: string,
  payload: any,
  filenameContext: any
): Promise<Buffer> {
  
  if (!pdfmonkeyTemplateId) {
    throw new Error('PDFMonkey template ID is required');
  }

  // Construire le nom de fichier
  const filename = buildFilename(filenameContext);

  // Créer le document sur PDFMonkey
  const { id: documentId } = await createPdfDocument(
    pdfmonkeyTemplateId,
    payload,
    filename
  );


  // Polling pour attendre la génération
  const timeoutMs = 30000; // 30 secondes
  const intervalMs = 500; // 500ms entre chaque check
  const start = Date.now();

  while (true) {
    const card = await getDocumentCard(documentId);


    if (card.status === 'success' && card.download_url) {
      return await downloadPdf(card.download_url);
    }

    if (card.status === 'failure') {
      const cause = card.failure_cause ?? 'unknown cause';
      console.error('[PdfGenerationService] Generation failed:', cause);
      throw new Error(`PDFMonkey generation failed: ${cause}`);
    }

    if (Date.now() - start > timeoutMs) {
      console.error('[PdfGenerationService] Timeout after', timeoutMs, 'ms');
      throw new Error(`PDFMonkey generation timeout (id=${documentId})`);
    }

    // Attendre avant le prochain poll
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/**
 * Construit un nom de fichier approprié à partir du contexte
 */
function buildFilename(context: any): string {
  const { asset, template } = context || {};
  
  if (asset && template) {
    const assetName = asset.name || asset.brand || 'Asset';
    const templateName = template.label || 'Export';
    return `${assetName}_${templateName.replace(/[^a-zA-Z0-9-_]/g, '_')}.pdf`;
  }
  
  if (asset) {
    return `${asset.name || 'Asset'}_Export.pdf`;
  }
  
  return 'Export.pdf';
}