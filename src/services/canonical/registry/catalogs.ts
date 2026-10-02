/**
 * Catalogues métier, en données (R6) :
 *   - EVENT_CATALOG : types d'événements agenda, natures HISTORICAL / DEADLINE
 *     et champs qui les produisent (T4-01, matrice §13) ;
 *   - DOCUMENT_CATALOG : types documentaires, autorité, droit de créer un
 *     événement automatique (T4-04) et formes de preuve d'exécution (T4-13).
 *
 * Un type documentaire inconnu du catalogue n'est JAMAIS autoritaire :
 * `resolveDocumentType` renvoie `undefined` et l'appelant propose au lieu de
 * créer.
 */
import type { AssetFamily, DocumentCatalogEntry, EventBusinessType, EventCatalogEntry } from './types';

const ALL: AssetFamily[] = ['IMMOBILIER', 'VEHICULE', 'OBJECT'];

export const EVENT_CATALOG: readonly EventCatalogEntry[] = [
  {
    businessType: 'purchase', label: 'Achat', titleTemplate: 'Achat',
    natures: ['HISTORICAL'], homeCategory: { HISTORICAL: 'information' }, notifiable: { HISTORICAL: false },
    fieldKeys: ['acquisitionDate'], families: ALL, aliases: ['ACHAT'],
    note: 'D-13 : la recopie vers acquisitionDate est réservée à un événement manuel réalisé, champ vide.',
  },
  {
    businessType: 'maintenance', label: 'Entretien', titleTemplate: 'Entretien',
    natures: ['HISTORICAL', 'DEADLINE'],
    homeCategory: { HISTORICAL: 'information', DEADLINE: 'action' },
    notifiable: { HISTORICAL: false, DEADLINE: true },
    fieldKeys: ['lastRevision', 'maintenanceDueDate'], families: ALL, aliases: ['ENTRETIEN', 'REVISION'],
  },
  {
    businessType: 'repair', label: 'Réparation', titleTemplate: 'Réparation',
    natures: ['HISTORICAL'], homeCategory: { HISTORICAL: 'information' }, notifiable: { HISTORICAL: false },
    fieldKeys: [], families: ALL, aliases: ['REPARATION'],
    note: 'Matrice §13 : aucun impact sur acquisitionPrice.',
  },
  {
    businessType: 'inspection', label: 'Contrôle', titleTemplate: 'Contrôle technique',
    natures: ['HISTORICAL', 'DEADLINE'],
    homeCategory: { HISTORICAL: 'information', DEADLINE: 'action' },
    notifiable: { HISTORICAL: false, DEADLINE: true },
    fieldKeys: ['lastInspectionDate', 'nextInspection'], families: ALL, aliases: ['CONTROLE_TECHNIQUE', 'CONTROLE'],
  },
  {
    businessType: 'insurance', label: 'Assurance', titleTemplate: "Échéance d'assurance",
    natures: ['HISTORICAL', 'DEADLINE'],
    // T4-11 : classer l'événement réel, pas le type de contrat.
    homeCategory: { HISTORICAL: 'information', DEADLINE: 'selon_evenement' },
    notifiable: { HISTORICAL: false, DEADLINE: true },
    fieldKeys: ['insuranceExpiry'], families: ALL, aliases: ['ASSURANCE'],
  },
  {
    businessType: 'warranty', label: 'Garantie', titleTemplate: 'Fin de garantie',
    natures: ['DEADLINE'], homeCategory: { DEADLINE: 'information' }, notifiable: { DEADLINE: true },
    fieldKeys: ['warrantyEndDate'], families: ALL, aliases: ['GARANTIE'],
  },
  {
    businessType: 'contract', label: 'Contrat', titleTemplate: 'Fin de contrat',
    natures: ['DEADLINE'], homeCategory: { DEADLINE: 'selon_evenement' }, notifiable: { DEADLINE: true },
    fieldKeys: ['contractEndDate'], families: ALL,
  },
  {
    businessType: 'lease', label: 'Bail / location', titleTemplate: 'Fin de bail',
    natures: ['DEADLINE'], homeCategory: { DEADLINE: 'selon_evenement' }, notifiable: { DEADLINE: true },
    fieldKeys: ['leaseEndDate'], families: ['IMMOBILIER', 'VEHICULE'],
  },
  {
    businessType: 'dpe', label: 'DPE', titleTemplate: 'DPE',
    natures: ['HISTORICAL', 'DEADLINE'],
    // T4-03 : DPE réalisé = information ; expiration explicite = selon besoin (§13).
    homeCategory: { HISTORICAL: 'information', DEADLINE: 'selon_evenement' },
    notifiable: { HISTORICAL: false, DEADLINE: true },
    fieldKeys: ['dpeDate', 'dpeExpiryDate'], families: ['IMMOBILIER'],
  },
  {
    businessType: 'registration', label: 'Immatriculation', titleTemplate: "Fin de validité d'immatriculation",
    natures: ['DEADLINE'], homeCategory: { DEADLINE: 'action' }, notifiable: { DEADLINE: true },
    fieldKeys: ['registrationExpiry'], families: ['VEHICULE'], aliases: ['ADMINISTRATIF'],
  },
  {
    businessType: 'claim', label: 'Sinistre', titleTemplate: 'Sinistre',
    natures: ['HISTORICAL'], homeCategory: { HISTORICAL: 'information' }, notifiable: { HISTORICAL: false },
    fieldKeys: [], families: ALL, aliases: ['SINISTRE', 'INCIDENT'],
    note: 'D-15 : événement historique seul ; changement de statut proposé via À traiter.',
  },
  {
    businessType: 'sale', label: 'Vente / transmission', titleTemplate: 'Vente',
    natures: ['HISTORICAL'], homeCategory: { HISTORICAL: 'information' }, notifiable: { HISTORICAL: false },
    fieldKeys: [], families: ALL, aliases: ['VENTE', 'TRANSMISSION'],
    note: 'D-15 : événement historique seul ; statut VENDU/TRANSMIS proposé via À traiter.',
  },
];

/* ── Formes de preuve (T4-13) ─────────────────────────────────────────────── */

const FACTURE_ACQUITTEE = {
  code: 'FACTURE_ACQUITTEE_PRESTATION_DATEE',
  description: 'Facture acquittée (mention « payée », « acquittée » ou règlement constaté) décrivant la prestation effectuée et sa date.',
  establishes: 'completed' as const,
  businessTypes: ['maintenance', 'repair', 'inspection'] as EventBusinessType[],
};
const FACTURE_ACHAT = {
  code: 'FACTURE_ACHAT',
  description: 'Facture ou ticket d’achat du bien, daté : établit l’achat.',
  establishes: 'completed' as const,
  businessTypes: ['purchase'] as EventBusinessType[],
};
const FACTURE_SIMPLE = {
  code: 'FACTURE_SIMPLE',
  description: 'Facture sans mention d’exécution ni d’acquittement : la prestation est facturée, pas prouvée réalisée.',
  establishes: 'not_proven' as const,
};
const RAPPORT_INTERVENTION = {
  code: 'RAPPORT_INTERVENTION',
  description: 'Rapport, fiche ou carnet d’intervention daté, signé ou tamponné par l’intervenant.',
  establishes: 'completed' as const,
};
const ATTESTATION_ENTRETIEN = {
  code: 'ATTESTATION_ENTRETIEN',
  description: 'Attestation d’entretien réglementaire (chaudière, climatisation…) datée.',
  establishes: 'completed' as const,
  businessTypes: ['maintenance'] as EventBusinessType[],
};
const PV_FAVORABLE = {
  code: 'PV_CONTROLE_FAVORABLE',
  description: 'Procès-verbal de contrôle technique favorable, daté.',
  establishes: 'completed' as const,
  businessTypes: ['inspection'] as EventBusinessType[],
};
const PV_CONTRE_VISITE = {
  code: 'PV_CONTRE_VISITE',
  description: 'Procès-verbal défavorable soumis à contre-visite : le contrôle n’est pas satisfait.',
  establishes: 'not_proven' as const,
  businessTypes: ['inspection'] as EventBusinessType[],
};
const RAPPORT_DIAGNOSTIC = {
  code: 'RAPPORT_DIAGNOSTIC',
  description: 'Rapport de diagnostic daté, avec identification du diagnostiqueur.',
  establishes: 'completed' as const,
};
const ACTE_SIGNE = {
  code: 'ACTE_SIGNE',
  description: 'Acte authentique signé (date de signature, parties, prix).',
  establishes: 'completed' as const,
  businessTypes: ['purchase', 'sale'] as EventBusinessType[],
};
const ATTESTATION_NOUVELLE_PERIODE = {
  code: 'ATTESTATION_NOUVELLE_PERIODE',
  description: 'Attestation ou conditions particulières couvrant explicitement la nouvelle période : renouvellement établi.',
  establishes: 'completed' as const,
  businessTypes: ['insurance'] as EventBusinessType[],
};
const SANS_PREUVE = (code: string, description: string) => ({ code, description, establishes: 'not_proven' as const });

export const DOCUMENT_CATALOG: readonly DocumentCatalogEntry[] = [
  {
    code: 'ACTE_AUTHENTIQUE', label: 'Acte authentique', authority: 'AUTHORITATIVE',
    // Décision PO D-A (01/10/2026) : autorisé à créer des événements (achat ou
    // vente réalisés, HISTORICAL), prouvés par l'acte signé.
    mayCreateAgenda: true, businessTypes: ['purchase', 'sale'], completionProofs: [ACTE_SIGNE], families: ALL,
    aliases: ['ACTE_NOTARIE', 'PROPERTY_TITLE', 'TRANSACTION_ACT', 'TRANSFER_CERTIFICATE', 'TITRE_PROPRIETE', 'ACTE_TRANSACTION', 'CONTRAT_ACHAT'],
  },
  {
    code: 'COMPROMIS_VENTE', label: 'Compromis de vente', authority: 'AUTHORITATIVE',
    mayCreateAgenda: false, businessTypes: ['purchase', 'sale'],
    completionProofs: [SANS_PREUVE('COMPROMIS', 'Un compromis engage, il ne réalise pas la vente.')], families: ['IMMOBILIER'],
  },
  {
    code: 'CERTIFICAT_IMMATRICULATION', label: "Certificat d'immatriculation", authority: 'AUTHORITATIVE',
    mayCreateAgenda: true, businessTypes: ['registration'], completionProofs: [], families: ['VEHICULE'],
    aliases: ['CARTE_GRISE', 'REGISTRATION_CERTIFICATE', 'ADMIN_STATUS_CERTIFICATE'],
  },
  {
    code: 'CONTROLE_TECHNIQUE', label: 'Procès-verbal de contrôle technique', authority: 'AUTHORITATIVE',
    // Décision PO D-A (01/10/2026) : autorisé à créer des événements (contrôle
    // réalisé, prochain contrôle) ; PV favorable = réalisé, contre-visite = non prouvé.
    mayCreateAgenda: true, businessTypes: ['inspection'], completionProofs: [PV_FAVORABLE, PV_CONTRE_VISITE], families: ['VEHICULE'],
    aliases: ['VEHICLE_TECHNICAL_INSPECTION', 'PV_CONTROLE_TECHNIQUE'],
  },
  {
    code: 'CONTRAT_ASSURANCE', label: "Contrat d'assurance", authority: 'AUTHORITATIVE',
    mayCreateAgenda: true, businessTypes: ['insurance'], completionProofs: [ATTESTATION_NOUVELLE_PERIODE], families: ALL,
    aliases: ['INSURANCE_POLICY', 'INSURANCE_CERTIFICATE', 'ATTESTATION_ASSURANCE'],
  },
  {
    code: 'AVIS_ECHEANCE', label: "Avis d'échéance", authority: 'AUTHORITATIVE',
    mayCreateAgenda: true, businessTypes: ['insurance'],
    completionProofs: [SANS_PREUVE('APPEL_DE_PRIME', 'Un avis d’échéance appelle un paiement, il ne prouve pas le renouvellement.')],
    families: ALL, aliases: ['INSURANCE_DUE_NOTICE'],
  },
  {
    code: 'CERTIFICAT_GARANTIE', label: 'Certificat de garantie', authority: 'AUTHORITATIVE',
    mayCreateAgenda: true, businessTypes: ['warranty'], completionProofs: [], families: ALL,
    aliases: ['WARRANTY_CERTIFICATE', 'EXTENDED_WARRANTY', 'GARANTIE'],
  },
  {
    code: 'CONTRAT_LOA', label: 'Contrat de LOA', authority: 'AUTHORITATIVE',
    mayCreateAgenda: true, businessTypes: ['lease', 'contract'], completionProofs: [], families: ['VEHICULE'],
  },
  {
    code: 'CONTRAT_LLD', label: 'Contrat de LLD', authority: 'AUTHORITATIVE',
    mayCreateAgenda: true, businessTypes: ['lease', 'contract'], completionProofs: [], families: ['VEHICULE'],
    aliases: ['LEASING_FINANCING_CONTRACT'],
  },
  {
    code: 'DPE', label: 'Diagnostic de performance énergétique', authority: 'AUTHORITATIVE',
    mayCreateAgenda: true, businessTypes: ['dpe'], completionProofs: [{ ...RAPPORT_DIAGNOSTIC, businessTypes: ['dpe'] }],
    families: ['IMMOBILIER'], aliases: ['PEB'],
  },
  {
    code: 'DIAGNOSTIC', label: 'Diagnostic', authority: 'AUTHORITATIVE',
    mayCreateAgenda: true, businessTypes: ['inspection'], completionProofs: [RAPPORT_DIAGNOSTIC], families: ['IMMOBILIER'],
    aliases: [
      'ASBESTOS_DIAGNOSTIC', 'LEAD_DIAGNOSTIC', 'TERMITE_DIAGNOSTIC', 'GAS_DIAGNOSTIC', 'ELECTRICITY_DIAGNOSTIC',
      'SANITATION_DIAGNOSTIC', 'RISK_STATEMENT', 'ENERGY_AUDIT', 'AMIANTE', 'PLOMB', 'TERMITES', 'GAZ', 'ELECTRICITE',
      'ASSAINISSEMENT', 'ERNMT', 'AUDIT_ENERGETIQUE',
    ],
  },
  {
    code: 'RAPPORT_ENTRETIEN', label: "Rapport d'entretien / d'intervention", authority: 'SUPPORTING',
    mayCreateAgenda: true, businessTypes: ['maintenance', 'repair', 'inspection'],
    completionProofs: [RAPPORT_INTERVENTION, ATTESTATION_ENTRETIEN], families: ALL,
    aliases: [
      'MAINTENANCE_REPORT', 'INTERVENTION_REPORT', 'MAINTENANCE_LOG', 'INSTALLATION_REPORT', 'SAFETY_CONTROL_REPORT',
      'COMPLIANCE_CERTIFICATE', 'CALIBRATION_CERTIFICATE', 'GENERAL_TECHNICAL_DIAGNOSTIC',
    ],
  },
  {
    code: 'FACTURE', label: 'Facture', authority: 'SUPPORTING',
    mayCreateAgenda: true, businessTypes: ['purchase', 'maintenance', 'repair', 'inspection'],
    completionProofs: [FACTURE_ACHAT, FACTURE_ACQUITTEE, FACTURE_SIMPLE], families: ALL,
    aliases: ['ACQUISITION_INVOICE', 'MAINTENANCE_INVOICE', 'REPAIR_INVOICE', 'WORKS_INVOICE', 'SUBSCRIPTION_INVOICE', 'TICKET_CAISSE'],
  },
  {
    code: 'BON_COMMANDE', label: 'Bon de commande', authority: 'SUPPORTING',
    mayCreateAgenda: false, businessTypes: ['purchase', 'warranty'],
    completionProofs: [SANS_PREUVE('COMMANDE', 'Une commande n’établit ni la livraison ni l’exécution.')], families: ALL,
    aliases: ['ACQUISITION_ORDER', 'WORKS_PURCHASE_ORDER'],
  },
  {
    code: 'DEVIS', label: 'Devis', authority: 'WEAK',
    mayCreateAgenda: false, businessTypes: ['maintenance', 'repair'],
    completionProofs: [SANS_PREUVE('DEVIS', 'Un devis propose une prestation, il ne la réalise pas.')], families: ALL,
    aliases: ['MAINTENANCE_QUOTE', 'REPAIR_QUOTE', 'WORKS_QUOTE'],
  },
  {
    code: 'CONSTAT_SINISTRE', label: 'Constat / rapport de sinistre', authority: 'SUPPORTING',
    // Décision PO D-B (01/10/2026) : crée l'événement HISTORIQUE « sinistre »
    // (et lui seul : `creationScope`) ; le statut du bien reste PROPOSÉ via la
    // carte À traiter ASSET-STATUS (D-15), jamais appliqué automatiquement.
    mayCreateAgenda: true, businessTypes: ['claim'], completionProofs: [], families: ALL,
    creationScope: { businessTypes: ['claim'], natures: ['HISTORICAL'] },
    aliases: ['CLAIM_DECLARATION', 'CLAIM_REPORT', 'CLAIM_APPRAISAL', 'SINISTRE'],
  },
  {
    code: 'MESURAGE_LEGAL', label: 'Mesurage officiel', authority: 'AUTHORITATIVE',
    mayCreateAgenda: false, businessTypes: [], completionProofs: [], families: ['IMMOBILIER'],
    aliases: ['CARREZ_CERTIFICATE', 'SURFACE_CARREZ'],
  },
  {
    code: 'ANNONCE_COMMERCIALE', label: 'Annonce commerciale', authority: 'WEAK',
    mayCreateAgenda: false, businessTypes: [], completionProofs: [], families: ALL,
  },
  {
    code: 'PHOTO', label: 'Photo', authority: 'WEAK',
    mayCreateAgenda: false, businessTypes: [], completionProofs: [], families: ALL,
  },
  {
    code: 'AUTRE', label: 'Autre document', authority: 'WEAK',
    mayCreateAgenda: false, businessTypes: [], completionProofs: [], families: ALL,
  },
];

const EVENT_BY_TYPE = new Map(EVENT_CATALOG.map((e) => [e.businessType, e]));
const EVENT_BY_ALIAS = new Map<string, EventCatalogEntry>();
for (const e of EVENT_CATALOG) {
  EVENT_BY_ALIAS.set(e.businessType.toUpperCase(), e);
  for (const a of e.aliases ?? []) EVENT_BY_ALIAS.set(a.toUpperCase(), e);
}

const DOC_BY_CODE = new Map<string, DocumentCatalogEntry>();
for (const d of DOCUMENT_CATALOG) {
  DOC_BY_CODE.set(d.code, d);
  for (const a of d.aliases ?? []) DOC_BY_CODE.set(a, d);
}

/** Entrée du catalogue d'événements par type métier ou code historique (`ENTRETIEN`, `ACHAT`…). */
export function getEventEntry(typeOrAlias: string): EventCatalogEntry | undefined {
  return EVENT_BY_TYPE.get(typeOrAlias as EventBusinessType) ?? EVENT_BY_ALIAS.get(typeOrAlias.toUpperCase());
}

/** Entrée du catalogue documentaire pour un code (V1, V2 ou alias). Inconnu → undefined (non autoritaire). */
export function resolveDocumentType(code: string | null | undefined): DocumentCatalogEntry | undefined {
  if (!code) return undefined;
  return DOC_BY_CODE.get(code.trim().toUpperCase());
}

/** Alias de `resolveDocumentType`, pour la symétrie avec `getEventEntry`. */
export const getDocumentEntry = resolveDocumentType;

/**
 * Ce type documentaire peut-il CRÉER automatiquement cet événement (T4-04) ?
 * `mayCreateAgenda`, restreint par `creationScope` quand il est déclaré
 * (D-B : constat de sinistre → sinistre HISTORIQUE seulement). Type inconnu :
 * jamais. Type ou nature d'événement absents avec une portée : jamais.
 */
export function documentMayCreateEvent(
  entry: DocumentCatalogEntry | undefined,
  event: { businessType?: string | null; nature?: string | null } = {},
): boolean {
  if (!entry?.mayCreateAgenda) return false;
  const scope = entry.creationScope;
  if (!scope) return true;
  return !!event.businessType && (scope.businessTypes as readonly string[]).includes(event.businessType)
    && !!event.nature && (scope.natures as readonly string[]).includes(event.nature);
}
