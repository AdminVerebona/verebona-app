/**
 * Inventaire des opérations IA de T3 et de leur protection anti-redondance —
 * carte #811 (écart P1-B du ticket #596).
 *
 * Une entrée par opération `DATA_RECONCILIATION` du registre qui appelle un
 * fournisseur. Un test (`c811-inventaire-t3.test.ts`) compare cet inventaire
 * au registre : ajouter une opération T3 sans dire comment elle évite de
 * rappeler le fournisseur à contexte identique fait échouer la suite.
 *
 * `provenBy` cite les tests EXÉCUTÉS qui démontrent le non-rappel à contexte
 * stable. `none` : aucune preuve dédiée — c'est dit, jamais supposé.
 *
 * Toutes les opérations passent par `AiGateway.execute` : elles bénéficient en
 * plus du cache TEMPORAIRE des réponses (clé = compte, opération, sources,
 * variables du prompt, version du prompt maître ; 1 h ; réservation
 * multi-instances, bail renouvelé) — protection commune, non répétée ci-dessous.
 */

export interface T3RedundancyEntry {
  /** Où l'appel est émis. */
  callSites: string[];
  /** Ce qui déclenche l'examen. */
  triggers: string[];
  /** Protection métier DURABLE (au-delà du cache d'une heure). */
  protection: string;
  /** Clé de la protection. */
  key: string;
  /** Durée de validité. */
  duration: string;
  /** Ce qui l'invalide (réexamens légitimes). */
  invalidation: string;
  /** Tests exécutés qui prouvent le non-rappel à contexte stable ; `[]` : non démontré par un test dédié. */
  provenBy: string[];
}

export const T3_REDUNDANCY_INVENTORY: Record<string, T3RedundancyEntry> = {
  t3_value_conflict: {
    callSites: ['reconciliation/master/value-conflict.ts (via decision-memory/index.ts, moteur des biens)'],
    triggers: ['analyse de source (bien)', 'cycle de vie d’un document', 'passage du compte : événement, planifié, manuel', 'relance forcée (manuel)'],
    protection: 'Mémoire durable des décisions (table t3_decision_memory, 0856), consultée AVANT l’appel ; arbitrage utilisateur déjà rendu ; valeur USER / ADMIN jamais soumise',
    key: 'compte + objet + champ ; empreinte du contexte (preuves, valeur en place, résolution utilisateur, règles, configuration IA effective)',
    duration: 'Sans expiration ; un échec IA mémorisé est retenté après T3_DECISION_MEMORY_FAILURE_RETRY_MINUTES',
    invalidation: 'Toute composante de l’empreinte modifiée (motif tracé), relance forcée tracée, signature de configuration non résolue (ni réutilisation ni enregistrement)',
    provenBy: ['C811-B01', 'C811-B03', 'C811-E04', 'L99A-T01', 'L99A-T02', 'L99A-T03', 'L99A-T06', 'L99A-M01 à M08 (unitaires)'],
  },
  t3_link_ambiguity: {
    callSites: [
      'reconciliation/document-asset/resolve-document-asset.service.ts (rattachement document ↔ bien, recherche sémantique)',
      'reconciliation/document-asset/attachment-review/service.ts (revue d’un rattachement existant)',
      'reconciliation/master/link-ambiguity.ts via link-reconciler.ts (liens document / agenda / fournisseur d’un objet)',
    ],
    triggers: ['analyse de source', 'carte « À traiter » LINK-ASSET ouverte (passage du compte)', 'rattrapage planifié des documents sans bien', 'connaissance du compte modifiée', 'lancement manuel'],
    protection: 'Résolution durable du document (document_asset_resolutions : empreinte du contexte, décision ouverte inchangée non réexaminée) ; mémoire de la décision IA ; mémoire de la revue (clé du contexte pertinent) ; budget de réarbitrage ; délai après échec technique',
    key: 'document + empreinte du contexte + chemin (structuré / sémantique) + signature de configuration IA',
    duration: 'Sans expiration tant que le contexte est inchangé',
    invalidation: 'Empreinte modifiée (connaissance, candidats, indices), relance manuelle ou forcée, réexamen d’une carte née d’une panne, signature non résolue',
    provenBy: ['L113L R2', 'L113L R9', 'T3DOC-06 / T3DOC-10 (L31B)', 'C811-E04 (règle de la signature non résolue : unitaires de la mémoire)'],
  },
  t3_operation_match: {
    callSites: ['business-operations/consolidation/m3.ts (via reconciliation/master/operation-match.ts)'],
    triggers: ['candidat d’opération T1 ambigu', 'consolidation ciblée d’un document', 'phase « À traiter » du passage du compte', 'reprise après report daté'],
    protection: 'État durable du candidat (document_operation_candidates.t3_detail.m3 : statut, empreinte, version du prompt, reprise datée) ; plafonds par passage et par jour',
    key: 'candidat + empreinte du contexte + version du prompt',
    duration: 'Sans expiration ; DEFERRED / ERROR repris à la date de reprise',
    invalidation: 'Empreinte ou version du prompt modifiée, décision utilisateur, reprise échue',
    provenBy: ['L110D-E2E-01', 'L110D-E2E-07'],
  },
  t3_document_naming: {
    callSites: ['reconciliation/document-naming/model.ts (phase.ts, period-representation.ts)'],
    triggers: ['phase DOCUMENT_NAMING du passage du compte', 'document nouveau ou modifié, fait T1, opération, rattachement', 'relecture de sécurité (T3_NAMING_VERIFY_HOURS)', 'reprise d’écriture ou de lot différé'],
    protection: 'État durable des lots (document_naming_groups / members : DONE, DEFERRED, WRITE_PENDING, UPGRADE_REVIEW, empreinte du lot) ; préfiltre déterministe des titres conformes ; plafonds par passage et par jour ; reprises datées',
    key: 'compte + lot + empreinte du contexte du lot (version du contexte)',
    duration: 'Sans expiration ; relecture de sécurité SANS appel si rien n’a changé',
    invalidation: 'Empreinte du lot modifiée, nouveau document, prompt changé, décision non sauvegardée, réexamen « contexte enrichi »',
    provenBy: ['C811-B05', 'L72B-E3-01', 'L72B-E6-02', 'L76B-C4-02', 'L76B-C2-02', 'L109J-E2E-01', 'T3-NOM-11'],
  },
  t3_knowledge_query: {
    callSites: ['reconciliation/knowledge-query/model.ts (service.ts ; propriétés manquantes, cartes « À traiter »)'],
    triggers: ['carte « À traiter » ouverte dont la réponse peut être dans la connaissance T1', 'contrôle de cohérence', 'passage du compte'],
    protection: 'Mémoire durable des interprétations (t3_knowledge_queries) ; tentatives bornées ; budget ; reprise datée',
    key: 'compte + document + champ + empreinte de la question + empreinte du contexte + version du prompt',
    duration: 'Sans expiration',
    invalidation: 'Contexte (connaissance T1) ou question modifiés, version du prompt changée',
    provenBy: ['L85F-E2E-14', 'L85F-E2E-COH-02'],
  },
  t3_operation_identity: {
    callSites: ['business-operations/semantic/identity-decider.ts (identity-phase.ts)'],
    triggers: ['réévaluation sémantique demandée par la consolidation d’une opération'],
    protection: 'Demandes durables de réévaluation (operation_semantic_reevaluations : une demande par contexte, close une fois décidée ou couverte)',
    key: 'opération + empreinte du contexte',
    duration: 'Sans expiration',
    invalidation: 'Nouvelle demande posée par la consolidation (contexte différent)',
    provenBy: ['L97A-E2E-02 (rejoué : aucun appel)'],
  },
  t3_period_relation: {
    callSites: ['documents/business-periods/relation-decider.ts (relation-review.ts)'],
    triggers: ['conflit ou incertitude de période entre documents, demandé par la résolution des périodes ; exécuté par le passage du compte'],
    protection: 'Mémoire durable des examens (une ligne par empreinte et par compte ; tentatives bornées ; budget)',
    key: 'compte + empreinte de la relation',
    duration: 'Sans expiration',
    invalidation: 'Empreinte modifiée ; échec réarmable',
    provenBy: ['L113AD-E2E-STOCK (jamais renvoyée)'],
  },
  t3_attribute_arbitration: {
    callSites: ['business-operations/consolidation/attribute-arbitration/decider.ts (review.ts)'],
    triggers: ['contradiction réelle d’attribut constatée par la consolidation ; exécuté par le passage du compte'],
    protection: 'Mémoire durable des arbitrages (business_operation_attribute_arbitrations : une ligne par empreinte et par compte, jamais renvoyée une fois examinée) ; tentatives bornées ; budget',
    key: 'compte + opération + empreinte de la ligne (valeurs présentées, preuves)',
    duration: 'Sans expiration',
    invalidation: 'Valeurs présentées ou preuves modifiées (nouvelle empreinte) ; décision de l’utilisateur prioritaire',
    provenBy: ['L114T-E2E-02', 'L114T-E2E-05'],
  },
  t3_economic_qualification: {
    callSites: ['business-operations/tco/semantic-qualification/decider.ts (review.ts)'],
    triggers: ['montant à qualifier pour le coût de possession, demandé par le calcul ; exécuté par le passage du compte'],
    protection: 'Mémoire durable des qualifications (une ligne par empreinte ; reprise datée ; attente technique)',
    key: 'compte + empreinte de la ligne à qualifier',
    duration: 'Sans expiration ; reprise après retryAfterHours',
    invalidation: 'Empreinte modifiée',
    provenBy: ['L113AL-E2E-ACCEPTATION (idempotence : aucun nouvel appel)', 'L113AL-E2E-CAS'],
  },
};
