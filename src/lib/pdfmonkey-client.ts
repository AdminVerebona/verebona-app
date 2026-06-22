/**
 * Client PDFMonkey générique
 * Ne connaît aucun métier (ni vélo, ni immo)
 * Fait juste : POST, GET, téléchargement
 */

const PDFMONKEY_API_KEY = process.env.PDFMONKEY_API_KEY;
const PDFMONKEY_BASE_URL = process.env.PDFMONKEY_BASE_URL || 'https://api.pdfmonkey.io/api/v1';

if (!PDFMONKEY_API_KEY) {
  console.warn('⚠️ PDFMONKEY_API_KEY is not set in environment variables');
}

export interface PdfMonkeyDocument {
  id: string;
  status: 'pending' | 'generating' | 'success' | 'failure' | string;
  download_url: string | null;
  failure_cause: string | null;
  filename: string | null;
}

export interface CreateDocumentResponse {
  id: string;
}

/**
 * Crée un document PDF sur PDFMonkey
 */
export async function createPdfDocument(
  templateId: string,
  payload: any,
  filename?: string
): Promise<CreateDocumentResponse> {
  if (!PDFMONKEY_API_KEY) {
    throw new Error('PDFMONKEY_API_KEY is not configured');
  }

  const body: any = {
    document: {
      document_template_id: templateId,
      payload,
      status: 'pending',
    }
  };

  if (filename) {
    body.document.filename = filename;
  }

  // ✅ LOG COMPLET DU PAYLOAD pour debugging

  const response = await fetch(`${PDFMONKEY_BASE_URL}/documents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PDFMONKEY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[PDFMonkey] Create document failed:', {
      status: response.status,
      statusText: response.statusText,
      body: errorText,
    });
    throw new Error(`PDFMonkey API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  return {
    id: data.document.id,
  };
}

/**
 * Récupère l'état d'un document
 */
export async function getDocumentCard(id: string): Promise<PdfMonkeyDocument> {
  if (!PDFMONKEY_API_KEY) {
    throw new Error('PDFMONKEY_API_KEY is not configured');
  }

  const response = await fetch(`${PDFMONKEY_BASE_URL}/document_cards/${id}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${PDFMONKEY_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PDFMonkey API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  
  // ✅ FIX: PDFMonkey's /document_cards/:id endpoint returns { document_card: {...} }
  // not { document: {...} }
  const doc = data.document_card || data.document;

  if (!doc) {
    console.error('[PDFMonkey] Unexpected response format:', JSON.stringify(data));
    throw new Error('Invalid response from PDFMonkey: document object missing');
  }

  return {
    id: doc.id,
    status: doc.status,
    download_url: doc.download_url || null,
    failure_cause: doc.failure_cause || null,
    filename: doc.filename || null,
  };
}

/**
 * Télécharge le PDF depuis l'URL de téléchargement
 */
export async function downloadPdf(downloadUrl: string): Promise<Buffer> {

  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(`Failed to download PDF (${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}