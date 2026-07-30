/**
 * Cas du corpus de référence — CDC §11.1, critère d'acceptation n°22.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE CORPUS EST SYNTHÉTIQUE, ET C'EST UNE LIMITE À CONNAÎTRE
 *
 * Le §11.1 demande « une collection de documents réels rendus anonymes ». Ces
 * vingt-huit documents sont **générés**, pas anonymisés.
 *
 * Ce qu'ils valident : la logique. Extraction de champs, arbitrage entre
 * sources contradictoires, rattachement au bon bien, refus d'inventer sur un
 * document vide. C'est déjà l'essentiel de ce qu'une modification de prompt
 * peut casser.
 *
 * Ce qu'ils ne valident PAS : la robustesse à la numérisation. Un scan de
 * travers, un tampon en travers d'un montant, une OCR approximative — rien de
 * cela n'est représenté, et c'est justement là que l'extraction se dégrade en
 * production. Trois à cinq documents réels par famille restent nécessaires
 * avant la validation finale du lot 7.
 *
 * ── LES PIÈGES SONT DÉLIBÉRÉS ─────────────────────────────────────────────
 *
 * Un corpus de documents propres ne prouve rien. Les cas ci-dessous portent
 * les conflits que le CDC nomme explicitement :
 *
 *   · SURFACE — 78,40 m² (acte), 79 m² (DPE), 82 m² (annonce) pour le même
 *     bien. C'est l'exemple de la question métier n° 4, mot pour mot.
 *   · IBAN — présent dans un avis d'échéance. Il ne doit jamais atteindre le
 *     modèle (question n° 1).
 *   · MULTI-BIENS — une facture couvrant une maison ET un véhicule. Aucune
 *     information ne doit traverser d'un bien à l'autre.
 *   · PRIME — deux avis pour la même période, 580,40 € puis 598,55 €.
 *   · VIDE — deux documents dont la bonne réponse est « rien ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import { registerCorpusCase, type CorpusCase } from './corpus-registry';

/**
 * Biens de référence du corpus.
 *
 * Les `assetRefs` des cas y renvoient. Le contrôle de contamination consiste à
 * vérifier qu'aucune information n'a été rattachée à un bien absent de cette
 * liste pour le cas considéré.
 */
export const CORPUS_ASSETS = {
  MAISON_FLEURY: 'maison-fleury-sur-orne',
  APPART_BORDEAUX: 'appartement-bordeaux-sauvageau',
  TERRAIN_BOUCHEMAINE: 'terrain-bouchemaine',
  VOITURE_C4: 'citroen-c4-gk482rt',
  VOITURE_308: 'peugeot-308-hr209bw',
  MOTO_MT07: 'yamaha-mt07-ej771qm',
  UTILITAIRE_TRAFIC: 'renault-trafic-jc604pl',
  PAC_ATLANTIC: 'pac-atlantic-alfea',
  LAVE_LINGE: 'lave-linge-bosch',
  ORDINATEUR_DELL: 'ordinateur-dell-latitude',
  CHAUDIERE_SD: 'chaudiere-saunier-duval',
} as const;

const CASES: CorpusCase[] = [
  // ── Actes immobiliers ───────────────────────────────────────────────────
  {
    caseId: 'acte-vente-maison',
    category: 'acte_immobilier',
    fixturePath: 'acte_immobilier/acte-vente-maison.html',
    expected: {
      documentType: 'ACTE_TRANSACTION',
      assetRefs: [CORPUS_ASSETS.MAISON_FLEURY],
      fields: {
        // Valeur faisant autorité pour la surface : c'est l'acte notarié qui
        // l'emporte sur le DPE et sur l'annonce (question métier n° 4).
        surfaceHabitable: 78.4,
        prixAchat: 245000,
        adresse: '23 chemin des Sources, 14123 Fleury-sur-Orne',
        dateActe: '2025-03-14',
      },
    },
  },
  {
    caseId: 'acte-vente-appartement',
    category: 'acte_immobilier',
    fixturePath: 'acte_immobilier/acte-vente-appartement.html',
    expected: {
      documentType: 'ACTE_TRANSACTION',
      assetRefs: [CORPUS_ASSETS.APPART_BORDEAUX],
      fields: {
        surfaceHabitable: 62.15,
        prixAchat: 318000,
        // Le mobilier est distingué du prix du bien : 310 000 € + 8 000 €.
        // Une extraction qui les confondrait fausserait toute valorisation.
        adresse: '14 rue Camille Sauvageau, 33800 Bordeaux',
      },
    },
  },
  {
    caseId: 'compromis-terrain',
    category: 'acte_immobilier',
    fixturePath: 'acte_immobilier/compromis-vente-terrain.html',
    expected: {
      documentType: 'ACTE_TRANSACTION',
      assetRefs: [CORPUS_ASSETS.TERRAIN_BOUCHEMAINE],
      fields: { surfaceTerrain: 1240, prixAchat: 96500 },
    },
  },

  // ── DPE ─────────────────────────────────────────────────────────────────
  {
    caseId: 'dpe-maison-fleury',
    category: 'dpe',
    fixturePath: 'dpe/dpe-maison-fleury.html',
    expected: {
      documentType: 'DPE',
      assetRefs: [CORPUS_ASSETS.MAISON_FLEURY],
      fields: {
        classeEnergie: 'D',
        classeGES: 'D',
        consommation: 218,
        // 79 m² — volontairement différent des 78,40 m² de l'acte. Le moteur
        // doit conserver la valeur du DPE comme donnée du DPE, sans écraser
        // la surface du bien.
        surfaceHabitable: 79,
        dateEtablissement: '2025-01-08',
        numeroAdeme: '2514E0374219H',
      },
    },
  },
  {
    caseId: 'dpe-appartement-bordeaux',
    category: 'dpe',
    fixturePath: 'dpe/dpe-appartement-bordeaux.html',
    expected: {
      documentType: 'DPE',
      assetRefs: [CORPUS_ASSETS.APPART_BORDEAUX],
      fields: { classeEnergie: 'F', classeGES: 'F', consommation: 371, surfaceHabitable: 62.15 },
    },
  },

  // ── Factures multi-biens ────────────────────────────────────────────────
  {
    caseId: 'facture-assurance-deux-biens',
    category: 'facture_multibiens',
    fixturePath: 'facture_multibiens/facture-assurance-deux-biens.html',
    expected: {
      documentType: 'FACTURE',
      // Deux familles distinctes. Le contrôle de contamination porte ici : la
      // prime habitation ne doit pas devenir la prime du véhicule.
      assetRefs: [CORPUS_ASSETS.MAISON_FLEURY, CORPUS_ASSETS.VOITURE_C4],
      fields: { montantTotal: 1228, numeroContrat: '8841-227-03' },
    },
  },
  {
    caseId: 'facture-travaux-deux-lots',
    category: 'facture_multibiens',
    fixturePath: 'facture_multibiens/facture-travaux-deux-lots.html',
    expected: {
      documentType: 'FACTURE',
      assetRefs: [CORPUS_ASSETS.APPART_BORDEAUX, CORPUS_ASSETS.MAISON_FLEURY],
      fields: { montantTotal: 5121.6, tauxTva: 10 },
    },
  },

  // ── Cartes grises ───────────────────────────────────────────────────────
  {
    caseId: 'carte-grise-c4',
    category: 'carte_grise',
    fixturePath: 'carte_grise/certificat-immatriculation-voiture.html',
    expected: {
      documentType: 'CERTIFICAT_IMMATRICULATION',
      assetRefs: [CORPUS_ASSETS.VOITURE_C4],
      fields: {
        // La carte grise fait autorité sur la plaque (question métier n° 4).
        immatriculation: 'GK-482-RT',
        vin: 'VF7NC5FS8KY418823',
        marque: 'CITROËN',
        premiereImmatriculation: '2019-06-17',
        puissanceFiscale: 6,
      },
    },
  },
  {
    caseId: 'carte-grise-mt07',
    category: 'carte_grise',
    fixturePath: 'carte_grise/certificat-immatriculation-moto.html',
    expected: {
      documentType: 'CERTIFICAT_IMMATRICULATION',
      assetRefs: [CORPUS_ASSETS.MOTO_MT07],
      fields: { immatriculation: 'EJ-771-QM', vin: 'JYARM39E0NA012477', cylindree: 689 },
    },
  },

  // ── LOA / LLD ───────────────────────────────────────────────────────────
  {
    caseId: 'contrat-loa-308',
    category: 'contrat_loa_lld',
    fixturePath: 'contrat_loa_lld/contrat-loa-voiture.html',
    expected: {
      documentType: 'CONTRAT_LOCATION_LEASING',
      assetRefs: [CORPUS_ASSETS.VOITURE_308],
      fields: {
        immatriculation: 'HR-209-BW',
        loyerMensuel: 389,
        dureeMois: 48,
        dateFinContrat: '2027-05-05',
        valeurRachat: 12960,
      },
    },
  },
  {
    caseId: 'contrat-lld-trafic',
    category: 'contrat_loa_lld',
    fixturePath: 'contrat_loa_lld/contrat-lld-utilitaire.html',
    expected: {
      documentType: 'CONTRAT_LOCATION_LEASING',
      assetRefs: [CORPUS_ASSETS.UTILITAIRE_TRAFIC],
      // Une LLD n'a PAS d'option d'achat. Extraire une valeur de rachat ici
      // serait une hallucination — l'absence est la bonne réponse.
      fields: { loyerMensuel: 612, dureeMois: 36, valeurRachat: null },
    },
  },

  // ── Avis d'échéance ─────────────────────────────────────────────────────
  {
    caseId: 'avis-echeance-habitation',
    category: 'avis_echeance',
    fixturePath: 'avis_echeance/avis-echeance-habitation.html',
    expected: {
      documentType: 'AVIS_ECHEANCE_ASSURANCE',
      assetRefs: [CORPUS_ASSETS.MAISON_FLEURY],
      fields: {
        numeroContrat: 'HAB-8841-227',
        primeAssurance: 580.4,
        dateEcheance: '2026-03-01',
        // L'IBAN est PRÉSENT dans le document et ne doit jamais atteindre le
        // modèle (question métier n° 1). Le contrôle vérifie son absence des
        // invites, pas sa valeur.
        ibanTransmisAuModele: false,
      },
    },
  },
  {
    caseId: 'avis-echeance-auto',
    category: 'avis_echeance',
    fixturePath: 'avis_echeance/avis-echeance-auto.html',
    expected: {
      documentType: 'AVIS_ECHEANCE_ASSURANCE',
      assetRefs: [CORPUS_ASSETS.VOITURE_C4],
      fields: { numeroContrat: 'AUT-8841-227-03', primeAssurance: 698, bonusMalus: 0.64 },
    },
  },

  // ── Rapports d'entretien ────────────────────────────────────────────────
  {
    caseId: 'revision-c4',
    category: 'rapport_entretien',
    fixturePath: 'rapport_entretien/rapport-revision-voiture.html',
    expected: {
      documentType: 'RAPPORT_ENTRETIEN',
      assetRefs: [CORPUS_ASSETS.VOITURE_C4],
      fields: { kilometrage: 84260, montantTotal: 480.84, dateIntervention: '2026-01-19' },
    },
  },
  {
    caseId: 'entretien-chaudiere',
    category: 'rapport_entretien',
    fixturePath: 'rapport_entretien/rapport-entretien-chaudiere.html',
    expected: {
      documentType: 'RAPPORT_ENTRETIEN',
      assetRefs: [CORPUS_ASSETS.CHAUDIERE_SD],
      fields: {
        numeroSerie: 'SD-2015-4471182',
        dateIntervention: '2025-10-06',
        // Échéance récurrente : le moteur doit produire un élément d'agenda.
        prochaineEcheance: '2026-10-06',
      },
    },
  },

  // ── Garanties ───────────────────────────────────────────────────────────
  {
    caseId: 'garantie-lave-linge',
    category: 'garantie',
    fixturePath: 'garantie/certificat-garantie-electromenager.html',
    expected: {
      documentType: 'GARANTIE',
      assetRefs: [CORPUS_ASSETS.LAVE_LINGE],
      fields: {
        numeroSerie: 'FD9912-004871',
        dateAchat: '2025-04-18',
        // Le certificat fait autorité sur la fin de garantie (question n° 4).
        finGarantie: '2027-04-18',
        prixAchat: 749,
      },
    },
  },
  {
    caseId: 'extension-garantie-pac',
    category: 'garantie',
    fixturePath: 'garantie/extension-garantie-pompe-chaleur.html',
    expected: {
      documentType: 'GARANTIE',
      assetRefs: [CORPUS_ASSETS.PAC_ATLANTIC],
      // Piège : deux dates coexistent — fin de garantie constructeur (2026) et
      // fin de couverture étendue (2029). C'est la seconde qui protège.
      fields: { numeroSerie: 'AT-2024-1180477', finGarantie: '2029-09-12' },
    },
  },

  // ── Factures d'équipement ───────────────────────────────────────────────
  {
    caseId: 'facture-pac',
    category: 'facture_equipement',
    fixturePath: 'facture_equipement/facture-pompe-chaleur.html',
    expected: {
      documentType: 'FACTURE',
      assetRefs: [CORPUS_ASSETS.PAC_ATLANTIC],
      fields: {
        numeroSerie: 'AT-2024-1180477',
        montantTotal: 10834.85,
        // Piège : le reste à charge (6 834,85 €) n'est pas le montant de la
        // facture. Les confondre fausserait la valeur de l'équipement.
        resteACharge: 6834.85,
        dateFacture: '2024-09-12',
      },
    },
  },
  {
    caseId: 'facture-ordinateur',
    category: 'facture_equipement',
    fixturePath: 'facture_equipement/facture-ordinateur-pro.html',
    expected: {
      documentType: 'FACTURE',
      assetRefs: [CORPUS_ASSETS.ORDINATEUR_DELL],
      fields: { numeroSerie: '7KLM2Z3', montantTotal: 2280, finGarantie: '2028-03-03' },
    },
  },

  // ── Documents contradictoires ───────────────────────────────────────────
  {
    caseId: 'annonce-surface-contradictoire',
    category: 'document_contradictoire',
    fixturePath: 'document_contradictoire/annonce-immobiliere-surface.html',
    expected: {
      documentType: 'AUTRE',
      assetRefs: [CORPUS_ASSETS.MAISON_FLEURY],
      fields: {
        // L'annonce annonce 82 m². L'ordre de confiance du CDC place l'acte
        // notarié en tête : la surface du BIEN doit rester à 78,40 m² après
        // absorption de ce document.
        surfaceAnnoncee: 82,
        surfaceRetenueSurLeBien: 78.4,
        conflitDetecte: true,
      },
    },
  },
  {
    caseId: 'avis-echeance-prime-contradictoire',
    category: 'document_contradictoire',
    fixturePath: 'document_contradictoire/avis-echeance-prime-differente.html',
    expected: {
      documentType: 'AVIS_ECHEANCE_ASSURANCE',
      assetRefs: [CORPUS_ASSETS.MAISON_FLEURY],
      fields: {
        primeAssurance: 598.55,
        // L'avis le plus récent l'emporte, mais l'écart avec 580,40 € doit
        // laisser une trace : une correction silencieuse est un défaut.
        primeRetenue: 598.55,
        conflitDetecte: true,
      },
    },
  },

  // ── Document en plusieurs fichiers ──────────────────────────────────────
  ...['1', '2', '3'].map((page) => ({
    caseId: `dpe-bordeaux-page${page}`,
    category: 'multi_fichiers_meme_document' as const,
    fixturePath: `multi_fichiers_meme_document/dpe-bordeaux-page${page}.html`,
    expected: {
      documentType: 'DPE',
      assetRefs: [CORPUS_ASSETS.APPART_BORDEAUX],
      fields: {
        // Les trois fichiers forment UN document. Le moteur doit les regrouper
        // et produire un seul DPE, pas trois documents partiels.
        numeroAdeme: '2333E1902847L',
        regroupementAttendu: 'dpe-bordeaux',
      },
    },
  })),

  // ── Pages web ───────────────────────────────────────────────────────────
  {
    caseId: 'annonce-portail',
    category: 'page_web',
    fixturePath: 'page_web/annonce-portail-immobilier.html',
    expected: {
      documentType: 'AUTRE',
      assetRefs: [CORPUS_ASSETS.MAISON_FLEURY],
      // §4.1.7 : « un lien web produit les mêmes informations qu'un document ».
      // Ce cas vérifie que le schéma de sortie est identique.
      fields: { surfaceAnnoncee: 82, prixAnnonce: 259000, classeEnergie: 'D' },
    },
  },
  {
    caseId: 'fiche-produit',
    category: 'page_web',
    fixturePath: 'page_web/fiche-produit-fabricant.html',
    expected: {
      documentType: 'FICHE_TECHNIQUE',
      assetRefs: [CORPUS_ASSETS.PAC_ATLANTIC],
      fields: { puissance: 11.2, cop: 4.72, fluideFrigorigene: 'R410A' },
    },
  },

  // ── Documents sans information ──────────────────────────────────────────
  {
    caseId: 'page-separation',
    category: 'document_sans_information',
    fixturePath: 'document_sans_information/page-separation-vierge.html',
    expected: {
      // Ni type, ni champ, ni rattachement. Le seul résultat correct est
      // l'absence assumée : inventer un type sur une page vide est le défaut
      // le plus coûteux, parce qu'il est invisible.
      documentType: undefined,
      assetRefs: [],
      fields: {},
    },
  },
  {
    caseId: 'ticket-illisible',
    category: 'document_sans_information',
    fixturePath: 'document_sans_information/ticket-illisible.html',
    expected: {
      documentType: undefined,
      assetRefs: [],
      // « 8,4 » est lisible dans le bruit. L'extraire comme montant serait
      // exactement l'erreur que ce cas cherche à détecter.
      fields: {},
    },
  },
];

/** Enregistre les vingt-huit cas. Appelé au chargement du module. */
export function registerAllCorpusCases(): void {
  for (const c of CASES) registerCorpusCase(c);
}

export const CORPUS_CASES = CASES;

registerAllCorpusCases();
