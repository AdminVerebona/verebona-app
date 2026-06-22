/**
 * Liste canonique des types de documents — source unique de vérité.
 * Utilisée par : composants, prompt IA, seed DB, export manifest CIL.
 * Toute modification ici doit être reflétée dans une migration DB.
 *
 * STRUCTURE :
 *  — Catégories fonctionnelles (affichées dans les pickers)
 *  — Diagnostics & certifications immobilières (affichés dans les pickers)
 *  — Codes format (PHOTO, VIDEO) — jamais dans les pickers, dérivés du MIME type
 *  — Codes CIL fins — jamais dans les pickers, gérés par l'IA uniquement
 */

export interface DocumentTypeOption {
  code: string;
  label: string;
  description: string;
  displayOrder: number;
  /** true = rubrique officielle du CIL Réglementaire (art. L.126-35-5 CCH) */
  isCilRubric?: boolean;
  /**
   * true = ne pas afficher dans les pickers de sélection manuelle.
   * Utilisé pour les codes de format (PHOTO, VIDEO) et les rubriques CIL
   * ultra-techniques qui sont gérées par l'IA uniquement.
   */
  hideFromPicker?: boolean;
}

export const DOCUMENT_TYPE_LIST: DocumentTypeOption[] = [

  // ── Courant ──────────────────────────────────────────────────────────────────
  { code: 'FACTURE',               label: 'Facture',                   description: "Facture d'achat, ticket de caisse, justificatif de paiement, facture de travaux",        displayOrder: 1 },
  { code: 'DEVIS',                 label: 'Devis',                     description: "Devis de prestation, estimation de travaux, offre de prix",                              displayOrder: 2 },
  { code: 'CONTRAT',               label: 'Contrat / Bail',            description: "Contrat de service, bail, mandat, abonnement, contrat d'entretien",                      displayOrder: 3 },
  { code: 'GARANTIE',              label: 'Garantie',                  description: "Certificat ou bon de garantie fabricant / constructeur",                                 displayOrder: 4 },
  { code: 'ATTESTATION_ASSURANCE', label: "Attestation d'assurance",   description: "Contrat, attestation ou avis d'échéance d'assurance habitation / sinistre",               displayOrder: 5 },
  { code: 'MANUEL',                label: 'Notice / Manuel',           description: "Manuel d'utilisation, notice de fonctionnement, guide technique, mode d'emploi",         displayOrder: 6 },
  { code: 'RAPPORT_ENTRETIEN',     label: "Rapport d'entretien",       description: "Compte-rendu d'entretien, intervention technique, constat d'état",                       displayOrder: 7 },

  // ── Immobilier ───────────────────────────────────────────────────────────────
  { code: 'ACTE_TRANSACTION',      label: 'Acte / Transaction',        description: "Titre de propriété, acte notarié, promesse de vente, compromis",                        displayOrder: 10 },
  { code: 'PERMIS_CONSTRUIRE',     label: 'Permis de construire',      description: "Permis de construire, déclaration de travaux, permis d'aménager",                       displayOrder: 11 },
  { code: 'SURFACE_CARREZ',        label: 'Certificat loi Carrez',     description: "Mesurage loi Carrez, attestation de surface habitable",                                  displayOrder: 12 },
  { code: 'EXPERTISE',             label: 'Expertise / Estimation',    description: "Rapport d'expertise immobilière, estimation de valeur par un professionnel",             displayOrder: 13 },
  { code: 'CONSTAT_SINISTRE',      label: 'Constat sinistre',          description: "Constat amiable, déclaration de sinistre, rapport d'expertise suite sinistre",           displayOrder: 14 },
  { code: 'DIAGNOSTIC',            label: 'Diagnostic technique',      description: "DPE, amiante, plomb, gaz, électricité, termites, assainissement, ERNMT et tout diagnostic immobilier", displayOrder: 15 },

  // ── Autre ────────────────────────────────────────────────────────────────────
  { code: 'AUTRE',                 label: 'Autre',                     description: "Document ne rentrant pas dans les catégories ci-dessus",                                 displayOrder: 50 },

  // ── Codes format — jamais dans les pickers ───────────────────────────────────
  // Ces codes sont dérivés du MIME type automatiquement, pas choisis manuellement.
  { code: 'PHOTO',  label: 'Photo',  description: "Photo ou image du bien immobilier / mobilier", displayOrder: 98, hideFromPicker: true },
  { code: 'VIDEO',  label: 'Vidéo',  description: "Vidéo du bien immobilier / mobilier ou d'une intervention", displayOrder: 99, hideFromPicker: true },

  // ── Rubriques CIL fines — gérées par l'IA, jamais dans les pickers ──────────
  { code: 'DPE',                      label: 'DPE',                           description: "Diagnostic de performance énergétique",                           displayOrder: 20, isCilRubric: true, hideFromPicker: true },
  { code: 'AUDIT_ENERGETIQUE',        label: 'Audit énergétique',             description: "Audit énergétique réglementaire ou volontaire",                  displayOrder: 21, isCilRubric: true, hideFromPicker: true },
  { code: 'AMIANTE',                  label: 'Diagnostic amiante',            description: "Diagnostic amiante (DTA, DAPP)",                                 displayOrder: 22, isCilRubric: true, hideFromPicker: true },
  { code: 'PLOMB',                    label: 'Diagnostic plomb (CREP)',       description: "Constat de risque d'exposition au plomb",                        displayOrder: 23, isCilRubric: true, hideFromPicker: true },
  { code: 'TERMITES',                 label: 'Diagnostic termites',           description: "État relatif à la présence de termites",                         displayOrder: 24, isCilRubric: true, hideFromPicker: true },
  { code: 'GAZ',                      label: 'Diagnostic gaz',                description: "Diagnostic de l'installation intérieure de gaz",                 displayOrder: 25, isCilRubric: true, hideFromPicker: true },
  { code: 'ELECTRICITE',              label: 'Diagnostic électricité',        description: "Diagnostic de l'installation électrique intérieure",              displayOrder: 26, isCilRubric: true, hideFromPicker: true },
  { code: 'ASSAINISSEMENT',           label: 'Diagnostic assainissement',     description: "Diagnostic assainissement non collectif",                        displayOrder: 27, isCilRubric: true, hideFromPicker: true },
  { code: 'ERNMT',                    label: 'État des risques (ERNMT)',      description: "État des risques naturels, miniers et technologiques",            displayOrder: 28, isCilRubric: true, hideFromPicker: true },
  { code: 'PLAN_CONSTRUCTION',        label: 'Plans de construction',         description: "Plans, coupes, schémas de construction",                         displayOrder: 30, isCilRubric: true, hideFromPicker: true },
  { code: 'PLAN_CADASTRAL',          label: 'Plan cadastral',                description: "Extrait de plan cadastral, situation parcellaire",                 displayOrder: 31, isCilRubric: false, hideFromPicker: true },
  { code: 'RE2020',                   label: 'Attestation RE2020',            description: "Attestation de prise en compte de la RE2020",                    displayOrder: 31, isCilRubric: true, hideFromPicker: true },
  { code: 'LABEL_CERTIFICATION',      label: 'Label / Certification bâtiment', description: "Label BBC, HQE, Passivhaus, NF Habitat",                       displayOrder: 32, isCilRubric: true, hideFromPicker: true },
  { code: 'ISOLATION_TOITURE',        label: 'Isolation toiture',             description: "Isolation thermique toiture / combles",                          displayOrder: 33, isCilRubric: true, hideFromPicker: true },
  { code: 'ISOLATION_MURS',           label: 'Isolation murs extérieurs',     description: "Isolation thermique murs extérieurs (ITE/ITI)",                  displayOrder: 34, isCilRubric: true, hideFromPicker: true },
  { code: 'ISOLATION_VITRAGE',        label: 'Isolation vitrages / portes',   description: "Parois vitrées et portes donnant sur l'extérieur",               displayOrder: 35, isCilRubric: true, hideFromPicker: true },
  { code: 'ISOLATION_PLANCHERS',      label: 'Isolation planchers bas',       description: "Isolation thermique des planchers bas",                          displayOrder: 36, isCilRubric: true, hideFromPicker: true },
  { code: 'EQUIPEMENT_CHAUFFAGE',     label: 'Équipement chauffage',          description: "Système de chauffage (chaudière, pompe à chaleur…)",             displayOrder: 37, isCilRubric: true, hideFromPicker: true },
  { code: 'EQUIPEMENT_REFROIDISSEMENT', label: 'Équipement refroidissement',  description: "Système de refroidissement / climatisation",                    displayOrder: 38, isCilRubric: true, hideFromPicker: true },
  { code: 'EQUIPEMENT_ECS',           label: 'Eau chaude sanitaire',          description: "Production d'eau chaude sanitaire",                              displayOrder: 39, isCilRubric: true, hideFromPicker: true },
  { code: 'RESEAU_CHALEUR',           label: 'Réseau de chaleur / froid',     description: "Réseau de chaleur ou de froid urbain",                           displayOrder: 40, isCilRubric: true, hideFromPicker: true },
  { code: 'EQUIPEMENT_VENTILATION',   label: 'Ventilation',                   description: "Système de ventilation (VMC simple/double flux, VNR)",           displayOrder: 41, isCilRubric: true, hideFromPicker: true },
];

/** Sous-ensemble affiché dans les pickers de sélection manuelle */
export const PICKER_DOCUMENT_TYPES = DOCUMENT_TYPE_LIST.filter(t => !t.hideFromPicker);

/** Map code → label (accès rapide) */
export const DOCUMENT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  DOCUMENT_TYPE_LIST.map(t => [t.code, t.label]),
);

/** Codes valides (pour validation) */
export const VALID_DOCUMENT_TYPE_CODES = new Set(DOCUMENT_TYPE_LIST.map(t => t.code));

/** Codes des rubriques officielles du CIL Réglementaire */
export const CIL_RUBRIC_CODES = new Set(
  DOCUMENT_TYPE_LIST.filter(t => t.isCilRubric).map(t => t.code),
);

/** Résout un code IA ou legacy vers un code DB valide */
export function resolveDocumentTypeCode(code: string | null | undefined): string {
  if (!code) return 'AUTRE';
  // Alias legacy
  if (code === 'PHOTO_BIEN')            return 'PHOTO';
  if (code === 'ASSURANCE')             return 'ATTESTATION_ASSURANCE';
  if (code === 'CERTIFICAT')            return 'DIAGNOSTIC';
  if (code === 'FACTURE_TRAVAUX')       return 'FACTURE';
  if (code === 'FACTURE_ACHAT')         return 'FACTURE';
  if (code === 'CONTRAT_ACHAT')         return 'ACTE_TRANSACTION';
  if (code === 'REGLEMENT_COPROPRIETE') return 'CONTRAT';
  if (code === 'CHARGES_COPROPRIETE')   return 'CONTRAT';
  if (code === 'TAXE_FONCIERE')         return 'ACTE_TRANSACTION';
  if (code === 'TITRE_PROPRIETE')       return 'ACTE_TRANSACTION';
  if (code === 'PEB')                   return 'DPE';
  if (code === 'SURFACE_LHABITALLE')    return 'SURFACE_CARREZ';
  if (code === 'EXTRAIT_CADASTRAL')     return 'PLAN_CADASTRAL';
  if (code === 'CADASTRE')              return 'PLAN_CADASTRAL';
  // DIAGNOSTIC est un code picker manuel valide en DB mais ne doit jamais sortir de l'IA
  // (l'IA doit utiliser les codes fins : DPE, AMIANTE, PLOMB, GAZ, ELECTRICITE, ASSAINISSEMENT, ERNMT)
  // On le laisse passer tel quel s'il vient d'une saisie manuelle existante.
  // Les codes CIL fins (DPE, AMIANTE…) restent valides en DB — on ne les remplace pas
  return VALID_DOCUMENT_TYPE_CODES.has(code) ? code : 'AUTRE';
}
