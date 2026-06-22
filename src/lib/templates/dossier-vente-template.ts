interface AssetData {
  id: number;
  name: string;
  category: string;
  subtype?: string;
  purchaseDate?: string;
  purchasePriceCents?: number;
  status: string;
  notes?: string;
  generalCondition?: string;
  estimatedValueCents?: number;
  mileageOrHours?: number;
  purchaseLocation?: string;
  warrantyEndDate?: string;
  dimensions?: string; // JSON
  engineInfo?: string; // JSON
  equipmentList?: string; // JSON array
  keyCharacteristics?: string; // JSON array
  lastMaintenanceDate?: string;
  thumbnailUrl?: string;
}

interface MaintenanceEvent {
  id: number;
  eventType: string;
  title: string;
  date: string;
  provider?: string;
  costCents?: number;
  notes?: string;
}

interface DocumentItem {
  name: string;
  type: string;
  description?: string;
  date?: string;
  format: string;
}

interface PhotoItem {
  url: string;
  caption?: string;
}

interface DossierVenteData {
  asset: AssetData;
  photos: PhotoItem[];
  maintenanceEvents: MaintenanceEvent[];
  documents: DocumentItem[];
  exportDate: string;
}

const BRAND_COLOR = '#3B82F6'; // Bleu Verebona
const BRAND_COLOR_SOFT = 'rgba(59, 130, 246, 0.1)';

function formatPrice(cents?: number): string {
  if (!cents) return 'Non renseigné';
  return `${(cents / 100).toLocaleString('fr-FR')} €`;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return 'Non renseignée';
  return new Date(dateStr).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function getConditionLabel(condition?: string): string {
  const labels: Record<string, string> = {
    EXCELLENT: 'Excellent',
    BON: 'Bon',
    MOYEN: 'Moyen',
    PASSABLE: 'Passable',
    MAUVAIS: 'Mauvais',
  };
  return condition ? labels[condition] || condition : 'Non renseigné';
}

function getConditionColor(condition?: string): string {
  const colors: Record<string, string> = {
    EXCELLENT: '#10B981',
    BON: '#3B82F6',
    MOYEN: '#F59E0B',
    PASSABLE: '#EF4444',
    MAUVAIS: '#DC2626',
  };
  return condition ? colors[condition] || '#6B7280' : '#6B7280';
}

export function renderDossierVenteHTML(data: DossierVenteData): string {
  const { asset, photos, maintenanceEvents, documents, exportDate } = data;

  // Parse JSON fields
  let equipment: string[] = [];
  let characteristics: string[] = [];
  let dimensions: any = null;
  let engineInfo: any = null;

  try {
    if (asset.equipmentList) equipment = JSON.parse(asset.equipmentList);
  } catch {}
  try {
    if (asset.keyCharacteristics) characteristics = JSON.parse(asset.keyCharacteristics);
  } catch {}
  try {
    if (asset.dimensions) dimensions = JSON.parse(asset.dimensions);
  } catch {}
  try {
    if (asset.engineInfo) engineInfo = JSON.parse(asset.engineInfo);
  } catch {}

  // Section 1: Couverture
  const coverSection = `
    <div class="cover-page">
      ${
        asset.thumbnailUrl || photos[0]?.url
          ? `
        <div class="cover-image">
          <img src="${asset.thumbnailUrl || photos[0]?.url}" alt="${asset.name}" />
        </div>
      `
          : `
        <div class="cover-placeholder">
          <div class="logo-placeholder">
            <svg width="80" height="80" viewBox="0 0 100 100" fill="none">
              <rect width="100" height="100" rx="10" fill="${BRAND_COLOR}" opacity="0.1"/>
              <path d="M50 30 L70 45 L70 70 L30 70 L30 45 Z" fill="${BRAND_COLOR}"/>
            </svg>
          </div>
        </div>
      `
      }
      
      <div class="cover-content">
        <div class="cover-logo">
          <svg width="180" height="40" viewBox="0 0 180 40" fill="none" xmlns="http://www.w3.org/2000/svg">
            <!-- V icon -->
            <rect x="0" y="8" width="32" height="32" rx="6" fill="${BRAND_COLOR}" opacity="0.1"/>
            <path d="M8 14 L16 30 L24 14" stroke="${BRAND_COLOR}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
            <!-- Verebona text -->
            <text x="40" y="28" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="700" fill="#111827" letter-spacing="-0.5">Verebona</text>
          </svg>
        </div>
        <h1 class="cover-title">Dossier de vente du bien</h1>
        <h2 class="cover-subtitle">${asset.name}</h2>
        <p class="cover-date">Généré le : ${formatDate(exportDate)}</p>
      </div>
    </div>
  `;

  // Section 2: Résumé "At a glance"
  const summaryCards = [
    {
      icon: '📅',
      label: "Date d'achat",
      value: formatDate(asset.purchaseDate),
    },
    {
      icon: '💰',
      label: "Prix d'achat",
      value: formatPrice(asset.purchasePriceCents),
    },
    {
      icon: '⭐',
      label: 'État général',
      value: getConditionLabel(asset.generalCondition),
      color: getConditionColor(asset.generalCondition),
    },
    {
      icon: '🔧',
      label: 'Dernier entretien',
      value: formatDate(asset.lastMaintenanceDate),
    },
    asset.mileageOrHours
      ? {
          icon: '📊',
          label: 'Kilométrage / Heures',
          value: `${asset.mileageOrHours.toLocaleString('fr-FR')}`,
        }
      : null,
    {
      icon: '📄',
      label: 'Documents',
      value: `${documents.length} document${documents.length > 1 ? 's' : ''}`,
    },
    asset.estimatedValueCents
      ? {
          icon: '💎',
          label: 'Valeur estimée',
          value: formatPrice(asset.estimatedValueCents),
        }
      : null,
  ].filter(Boolean);

  const summarySection = `
    <div class="summary-section">
      <h2 class="section-title">Résumé du bien</h2>
      <p class="section-subtitle">Vue d'ensemble en un coup d'œil</p>
      <div class="summary-grid">
        ${summaryCards
          .map(
            (card: any) => `
          <div class="summary-card">
            <div class="card-icon">${card.icon}</div>
            <div class="card-label">${card.label}</div>
            <div class="card-value" ${card.color ? `style="color: ${card.color};"` : ''}>
              ${card.value}
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;

  // Section 3: Galerie photos
  const gallerySection =
    photos.length > 0
      ? `
    <div class="gallery-section">
      <h2 class="section-title">Galerie photos</h2>
      <div class="gallery-grid">
        ${photos
          .slice(0, 6)
          .map(
            (photo) => `
          <div class="gallery-item">
            <img src="${photo.url}" alt="${photo.caption || asset.name}" />
            ${photo.caption ? `<p class="gallery-caption">${photo.caption}</p>` : ''}
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `
      : '';

  // Section 4: Fiche complète
  const detailRows = [
    { label: 'Nom du bien', value: asset.name },
    { label: 'Type', value: asset.category },
    { label: 'Catégorie', value: asset.subtype || '—' },
    { label: 'Marque', value: '—' },
    { label: 'Modèle', value: '—' },
    { label: 'Numéro de série', value: '—' },
    { label: "Date d'achat", value: formatDate(asset.purchaseDate) },
    { label: "Prix d'achat", value: formatPrice(asset.purchasePriceCents) },
    asset.purchaseLocation ? { label: "Lieu d'achat", value: asset.purchaseLocation } : null,
    dimensions
      ? {
          label: 'Dimensions',
          value: `${dimensions.length} x ${dimensions.width} x ${dimensions.height} ${dimensions.unit}`,
        }
      : null,
    engineInfo
      ? {
          label: 'Motorisation',
          value: `${engineInfo.power} ch - ${engineInfo.displacement} cc - ${engineInfo.fuelType}`,
        }
      : null,
    asset.warrantyEndDate ? { label: 'Garantie jusqu\'au', value: formatDate(asset.warrantyEndDate) } : null,
    asset.notes ? { label: 'Notes du propriétaire', value: asset.notes } : null,
  ].filter(Boolean);

  const detailsSection = `
    <div class="details-section">
      <h2 class="section-title">Informations détaillées</h2>
      <table class="details-table">
        ${detailRows
          .map(
            (row: any) => `
          <tr>
            <td class="detail-label">${row.label}</td>
            <td class="detail-value">${row.value}</td>
          </tr>
        `
          )
          .join('')}
      </table>
    </div>
  `;

  // Section 5: Historique d'entretien
  const maintenanceSection =
    maintenanceEvents.length > 0
      ? `
    <div class="maintenance-section">
      <h2 class="section-title">Historique d'entretien</h2>
      <p class="section-subtitle">Un bien entretenu inspire confiance</p>
      <table class="maintenance-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Type d'intervention</th>
            <th>Détails</th>
            <th>Réalisé par</th>
            <th>Montant</th>
          </tr>
        </thead>
        <tbody>
          ${maintenanceEvents
            .map(
              (event) => `
            <tr>
              <td>${formatDate(event.date)}</td>
              <td><span class="event-type">${event.eventType}</span></td>
              <td>${event.title}</td>
              <td>${event.provider || '—'}</td>
              <td>${formatPrice(event.costCents)}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
      ${
        maintenanceEvents.length >= 3
          ? `
        <div class="maintenance-badge">
          <span class="badge-icon">✓</span>
          <span class="badge-text">Entretien régulier</span>
        </div>
      `
          : ''
      }
    </div>
  `
      : `
    <div class="maintenance-section">
      <h2 class="section-title">Historique d'entretien</h2>
      <div class="empty-state">
        <p>Aucun entretien enregistré à ce jour.</p>
      </div>
    </div>
  `;

  // Section 6: Équipements et caractéristiques
  const featuresSection =
    equipment.length > 0 || characteristics.length > 0
      ? `
    <div class="features-section">
      <h2 class="section-title">Caractéristiques et équipements</h2>
      <div class="features-list">
        ${[...equipment, ...characteristics]
          .map(
            (item) => `
          <div class="feature-item">
            <span class="feature-bullet">•</span>
            <span class="feature-text">${item}</span>
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `
      : '';

  // Section 7: Documents inclus
  const documentsSection =
    documents.length > 0
      ? `
    <div class="documents-section">
      <h2 class="section-title">Documents inclus dans ce dossier</h2>
      <table class="documents-table">
        <thead>
          <tr>
            <th>Nom du document</th>
            <th>Type</th>
            <th>Description</th>
            <th>Date</th>
            <th>Format</th>
          </tr>
        </thead>
        <tbody>
          ${documents
            .map(
              (doc) => `
            <tr>
              <td>${doc.name}</td>
              <td>${doc.type}</td>
              <td>${doc.description || '—'}</td>
              <td>${formatDate(doc.date)}</td>
              <td><span class="format-badge">${doc.format}</span></td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `
      : '';

  // Assemble complete HTML
  return `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Dossier de vente - ${asset.name}</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: #1F2937;
          line-height: 1.6;
          background: white;
        }

        /* Cover Page */
        .cover-page {
          height: 100vh;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          position: relative;
          page-break-after: always;
        }

        .cover-image {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 60%;
          overflow: hidden;
        }

        .cover-image img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          border-radius: 0 0 30px 30px;
        }

        .cover-placeholder {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 60%;
          background: linear-gradient(135deg, ${BRAND_COLOR} 0%, #2563EB 100%);
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 0 0 30px 30px;
        }

        .cover-content {
          position: absolute;
          bottom: 15%;
          left: 50%;
          transform: translateX(-50%);
          text-align: center;
          width: 80%;
        }

        .cover-logo {
          position: absolute;
          top: 40px;
          right: 40px;
        }

        .logo-text {
          font-size: 24px;
          font-weight: 700;
          color: ${BRAND_COLOR};
          letter-spacing: -0.5px;
        }

        .cover-title {
          font-size: 48px;
          font-weight: 700;
          color: #111827;
          margin-bottom: 20px;
          letter-spacing: -1px;
        }

        .cover-subtitle {
          font-size: 32px;
          font-weight: 600;
          color: ${BRAND_COLOR};
          margin-bottom: 30px;
        }

        .cover-date {
          font-size: 16px;
          color: #6B7280;
          font-weight: 500;
        }

        /* Sections */
        .summary-section,
        .gallery-section,
        .details-section,
        .maintenance-section,
        .features-section,
        .documents-section {
          padding: 60px 50px;
          page-break-inside: avoid;
        }

        .section-title {
          font-size: 32px;
          font-weight: 700;
          color: #111827;
          margin-bottom: 10px;
        }

        .section-subtitle {
          font-size: 16px;
          color: #6B7280;
          margin-bottom: 40px;
        }

        /* Summary Cards */
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 25px;
          margin-top: 30px;
        }

        .summary-card {
          background: white;
          border: 1px solid #E5E7EB;
          border-radius: 16px;
          padding: 30px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
          transition: all 0.2s;
        }

        .card-icon {
          font-size: 36px;
          margin-bottom: 15px;
        }

        .card-label {
          font-size: 13px;
          font-weight: 600;
          color: #6B7280;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
        }

        .card-value {
          font-size: 20px;
          font-weight: 700;
          color: #111827;
        }

        /* Gallery */
        .gallery-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 20px;
        }

        .gallery-item {
          border-radius: 12px;
          overflow: hidden;
          background: #F3F4F6;
        }

        .gallery-item img {
          width: 100%;
          height: 250px;
          object-fit: cover;
          display: block;
        }

        .gallery-caption {
          padding: 12px;
          font-size: 13px;
          color: #6B7280;
          text-align: center;
        }

        /* Details Table */
        .details-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 30px;
        }

        .details-table tr {
          border-bottom: 1px solid #E5E7EB;
        }

        .details-table tr:last-child {
          border-bottom: none;
        }

        .detail-label {
          padding: 20px 0;
          font-weight: 600;
          color: #6B7280;
          width: 40%;
          font-size: 14px;
        }

        .detail-value {
          padding: 20px 0;
          color: #111827;
          font-weight: 500;
          font-size: 15px;
        }

        /* Maintenance Table */
        .maintenance-table,
        .documents-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 30px;
        }

        .maintenance-table thead,
        .documents-table thead {
          background: ${BRAND_COLOR_SOFT};
        }

        .maintenance-table th,
        .documents-table th {
          padding: 15px;
          text-align: left;
          font-size: 13px;
          font-weight: 600;
          color: #374151;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .maintenance-table td,
        .documents-table td {
          padding: 18px 15px;
          border-bottom: 1px solid #E5E7EB;
          font-size: 14px;
          color: #4B5563;
        }

        .event-type {
          display: inline-block;
          padding: 4px 12px;
          background: ${BRAND_COLOR_SOFT};
          color: ${BRAND_COLOR};
          border-radius: 6px;
          font-size: 12px;
          font-weight: 600;
        }

        .format-badge {
          display: inline-block;
          padding: 4px 10px;
          background: #F3F4F6;
          color: #6B7280;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
        }

        .maintenance-badge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 12px 20px;
          background: #10B981;
          color: white;
          border-radius: 10px;
          font-weight: 600;
          margin-top: 20px;
          font-size: 14px;
        }

        .badge-icon {
          font-size: 18px;
        }

        /* Features */
        .features-list {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 15px;
          margin-top: 30px;
        }

        .feature-item {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 15px 20px;
          background: #F9FAFB;
          border-radius: 10px;
          border-left: 4px solid ${BRAND_COLOR};
        }

        .feature-bullet {
          color: ${BRAND_COLOR};
          font-size: 20px;
          font-weight: 700;
          line-height: 1;
        }

        .feature-text {
          font-size: 14px;
          color: #374151;
          font-weight: 500;
        }

        /* Empty State */
        .empty-state {
          padding: 60px;
          text-align: center;
          background: #F9FAFB;
          border-radius: 12px;
          margin-top: 30px;
        }

        .empty-state p {
          color: #6B7280;
          font-size: 15px;
        }

        /* Footer */
        @page {
          margin: 0;
          @bottom-left {
            content: "Dossier généré avec Verebona — https://verebona.com";
            font-size: 10px;
            color: #9CA3AF;
          }
          @bottom-right {
            content: "Page " counter(page) " / " counter(pages);
            font-size: 10px;
            color: #9CA3AF;
          }
        }

        /* Page breaks */
        .page-break {
          page-break-after: always;
        }
      </style>
    </head>
    <body>
      ${coverSection}
      ${summarySection}
      <div class="page-break"></div>
      ${gallerySection}
      ${detailsSection}
      <div class="page-break"></div>
      ${maintenanceSection}
      ${featuresSection}
      ${documentsSection}
    </body>
    </html>
  `;
}