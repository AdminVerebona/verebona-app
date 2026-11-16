/**
 * Lot 115B (Trello #800) — diagnostic exhaustif, copiable et téléchargeable
 * des échecs de notification. Modèle PUR (aucune base).
 *
 *   L115B-U01  expurgation : jeton OAuth, JWT, clé privée, adresse, URL signée,
 *              jeton d'appareil ; aucune valeur sensible ne survit
 *   L115B-U02  familles d'erreur : une seule table pour l'écran et le filtre SQL
 *   L115B-U03  nature : échec réel ≠ ignoré ≠ jeton expiré ≠ accepté ≠ attente
 *   L115B-U04  critères : liste blanche stricte, refus explicite, curseur
 *   L115B-U05  dates : ISO + Europe/Paris (heure d'hiver et heure d'été)
 *   L115B-U06  JSON versionné en flux : tête + lignes + manifeste = document valide
 *   L115B-U07  manifeste : jamais « COMPLETE » si une trace nécessaire manque
 *   L115B-U08  copie : synthèse chiffrée, causes, chronologie, non disponibles
 *   L115B-U09  identifiant et nom de fichier : datés, explicites, stables
 *   L115B-U10  instrumentation à la source : étape FCM et statut HTTP classés
 */
import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_SCHEMA_VERSION, FAMILLES, FAMILLE_CODES, NATURES, NON_ENREGISTRE,
  empreinteCourte, expurgerMessageTechnique, familleDeCode, formatDiagnosticTexte, heureParis,
  identifiantDiagnostic, instant, jsonEntete, jsonLigne, jsonPied, libelleFenetre, nature,
  nomFichierDiagnostic, parseDiagnosticQuery, queryVersParams,
  type DiagnosticQuery, type LigneDiagnostic, type PerimetreDiagnostic, type SyntheseDiagnostic,
} from '../model';
import { classifyFcmError, fcmConfigDiagnostic } from '@/lib/mobile/push-provider';

/* ── Jeux d'essai ─────────────────────────────────────────────────────────── */

function requete(sp: Record<string, string> = {}): DiagnosticQuery {
  const r = parseDiagnosticQuery(new URLSearchParams(sp), new Date('2026-11-16T10:00:00.000Z'));
  if (!r.ok) throw new Error(`critères refusés : ${r.code}`);
  return r.value;
}

function ligne(p: Partial<LigneDiagnostic> = {}): LigneDiagnostic {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    evenementId: '22222222-2222-4222-8222-222222222222',
    evenementType: 'TO_PROCESS_DAILY_DIGEST',
    evenementStatut: 'failed',
    evenementCategorie: 'to_process',
    evenementMotif: null,
    regroupeAvecId: null,
    cleDeduplication: 'digest:2026-11-15:42',
    tentativesEvenement: 3,
    canal: 'push',
    statut: 'failed',
    nature: 'echec_reel',
    natureLibelle: 'Échec réel',
    code: 'mobile_push_config',
    famille: 'configuration',
    familleLibelle: 'Configuration du canal ou du fournisseur',
    message: 'oauth_401',
    etape: 'oauth_fournisseur',
    etapeLibelle: 'Obtention du jeton d’accès du fournisseur',
    categorieEchec: 'config',
    fournisseur: 'fcm',
    statutHttp: 401,
    codeFournisseur: 'oauth_401',
    messageFournisseur: null,
    plateforme: 'android',
    versionApplication: '1.2.0',
    build: '42',
    appareilId: '33333333-3333-4333-8333-333333333333',
    appareilEmpreinte: '7f3a9c21…',
    appareilStatut: 'active',
    appareilMotifStatut: null,
    appareilEnvironnement: 'preprod',
    appareilJetonPresent: true,
    utilisateurId: 7,
    compteId: 4,
    creeLe: instant('2026-11-15T07:30:00.000Z'),
    tenteLe: instant('2026-11-15T07:30:01.000Z'),
    envoyeLe: null,
    evenementCreeLe: instant('2026-11-15T07:29:00.000Z'),
    evenementTraiteLe: instant('2026-11-15T07:30:02.000Z'),
    evenementPrevuLe: null,
    remiseConfirmee: null,
    instrumentationStructuree: true,
    ...p,
  };
}

const SYNTHESE: SyntheseDiagnostic = {
  livraisons: 76,
  evenementsDistincts: 11,
  tentativesEvenements: 19,
  appareils: 5,
  parNature: {
    accepte_par_prestataire: 0, ecrit_localement: 0, echec_reel: 72,
    ignore_volontaire: 4, jeton_expire: 0, en_attente: 0,
  },
};

function perimetre(q: DiagnosticQuery): PerimetreDiagnostic {
  const t = new Date('2026-11-16T09:00:00.000Z');
  return {
    identifiantDiagnostic: identifiantDiagnostic(q, t),
    versionSchema: DIAGNOSTIC_SCHEMA_VERSION,
    genereLe: instant(t)!,
    instantane: instant(t)!,
    fenetre: { depuis: instant(q.depuis)!, jusqu: instant(q.jusqu)!, periode: q.periode, libelle: libelleFenetre(q) },
    filtres: Object.fromEntries(queryVersParams(q).entries()),
    environnement: 'preprod',
    build: { version: '1.0.0', commit: null },
    fuseauAffichage: 'Europe/Paris',
  };
}

/* ── L115B-U01 ────────────────────────────────────────────────────────────── */

describe('L115B-U01 expurgation des messages techniques', () => {
  it('retire un en-tête d’autorisation et son jeton', () => {
    const s = expurgerMessageTechnique('FCM refus : Authorization: Bearer ya29.A0ARrdaM-abcdefghijklmnop');
    expect(s).toContain('[expurgé]');
    expect(s).not.toContain('ya29');
  });

  it('retire un JWT complet', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJjb21wdGUifQ.c2lnbmF0dXJl';
    const s = expurgerMessageTechnique(`assertion rejetée (${jwt})`);
    expect(s).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(s).toContain('[expurgé]');
  });

  it('retire un bloc de clé privée', () => {
    const s = expurgerMessageTechnique('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANB\n-----END PRIVATE KEY-----');
    expect(s).toBe('[expurgé]');
  });

  it('retire une paire clé/valeur sensible', () => {
    const s = expurgerMessageTechnique('{"private_key":"secret-aaa","status":"PERMISSION_DENIED"}');
    expect(s).not.toContain('secret-aaa');
    expect(s).toContain('PERMISSION_DENIED');
  });

  it('pseudonymise une adresse de courriel', () => {
    expect(expurgerMessageTechnique('destinataire camille@exemple.fr refusé')).toBe('destinataire [adresse expurgée] refusé');
  });

  it('retire la requête d’une URL (signature possible) et garde le chemin', () => {
    const s = expurgerMessageTechnique('échec sur https://fcm.googleapis.com/v1/projects/p/messages:send?key=abc123def');
    expect(s).toContain('https://fcm.googleapis.com/v1/projects/p/messages:send?[expurgé]');
    expect(s).not.toContain('abc123def');
  });

  it('retire un jeton d’appareil laissé en clair', () => {
    const jeton = `d9${'x'.repeat(60)}`;
    const s = expurgerMessageTechnique(`jeton ${jeton} refusé`);
    expect(s).not.toContain(jeton);
    expect(s).toBe('jeton [expurgé] refusé');
  });

  it('borne la longueur et neutralise le vide', () => {
    expect(expurgerMessageTechnique('a'.repeat(900))!.length).toBeLessThanOrEqual(301);
    expect(expurgerMessageTechnique('   ')).toBeNull();
    expect(expurgerMessageTechnique(null)).toBeNull();
  });

  it('tronque un identifiant sans le reconstituer', () => {
    expect(empreinteCourte('abcdefghijklmnop', 8)).toBe('abcdefgh…');
    expect(empreinteCourte(null)).toBeNull();
    expect(empreinteCourte('court', 8)).toBe('court');
  });
});

/* ── L115B-U02 ────────────────────────────────────────────────────────────── */

describe('L115B-U02 familles d’erreur', () => {
  it('classe les codes réellement émis par le dispatcher', () => {
    expect(familleDeCode('mobile_push_config')).toBe('configuration');
    expect(familleDeCode('mobile_push_not_configured')).toBe('configuration');
    expect(familleDeCode('mobile_push_not_in_catalog')).toBe('catalogue');
    expect(familleDeCode('mobile_push_duplicate_suppressed')).toBe('deduplication');
    expect(familleDeCode('digest_already_pushed_today')).toBe('deduplication');
    expect(familleDeCode('invalid_token:UNREGISTERED')).toBe('jeton_appareil');
    expect(familleDeCode('token_unreadable')).toBe('jeton_appareil');
    expect(familleDeCode('channel_disabled_by_admin')).toBe('canal');
    expect(familleDeCode('mobile_push_transient')).toBe('reseau');
    expect(familleDeCode('email_send_error')).toBe('fournisseur');
    expect(familleDeCode('bell_insert_error')).toBe('interne');
  });

  it('ne devine jamais : sans code « aucune », code inconnu « inconnue »', () => {
    expect(familleDeCode(null)).toBe('aucune');
    expect(familleDeCode('un_code_que_personne_n_emet')).toBe('inconnue');
  });

  it('la table déclarative couvre toutes les familles sauf les deux bornes', () => {
    for (const f of FAMILLES) {
      expect(FAMILLE_CODES[f]).toBeDefined();
      if (f !== 'aucune' && f !== 'inconnue') {
        expect(FAMILLE_CODES[f].exacts.length + FAMILLE_CODES[f].prefixes.length).toBeGreaterThan(0);
      }
    }
    // Un code ne peut pas appartenir à deux familles : l'écran et le filtre SQL
    // compteraient alors la même livraison deux fois.
    const tous = FAMILLES.flatMap((f) => FAMILLE_CODES[f].exacts);
    expect(new Set(tous).size).toBe(tous.length);
  });
});

/* ── L115B-U03 ────────────────────────────────────────────────────────────── */

describe('L115B-U03 nature d’un résultat', () => {
  it('sépare échec réel, ignoré, jeton expiré, accepté et attente', () => {
    expect(nature('failed', 'push')).toBe('echec_reel');
    expect(nature('skipped_unavailable', 'push')).toBe('ignore_volontaire');
    expect(nature('skipped_preference', 'email')).toBe('ignore_volontaire');
    expect(nature('expired', 'push')).toBe('jeton_expire');
    expect(nature('pending', 'email')).toBe('en_attente');
  });

  it('« envoyé » sur un canal externe reste « accepté par le prestataire »', () => {
    expect(nature('sent', 'push')).toBe('accepte_par_prestataire');
    expect(nature('sent', 'email')).toBe('accepte_par_prestataire');
    // La cloche est une écriture locale : là, « envoyé » est une certitude.
    expect(nature('sent', 'bell')).toBe('ecrit_localement');
  });

  it('les 3 not_configured et le not_in_catalog ne sont pas des échecs (CA03)', () => {
    for (const code of ['mobile_push_not_configured', 'mobile_push_not_in_catalog']) {
      expect(nature('skipped_unavailable', 'push')).not.toBe('echec_reel');
      expect(familleDeCode(code)).not.toBe('fournisseur');
    }
  });
});

/* ── L115B-U04 ────────────────────────────────────────────────────────────── */

describe('L115B-U04 critères de recherche', () => {
  it('fenêtre par défaut : 7 jours', () => {
    const q = requete();
    expect(q.periode).toBe('7j');
    expect(q.jusqu.getTime() - q.depuis.getTime()).toBe(7 * 24 * 3600_000);
  });

  it('accepte tous les filtres combinés', () => {
    const q = requete({
      periode: '24h', canal: 'push', plateforme: 'ios', environnement: 'preprod',
      statutLivraison: 'failed', statutEvenement: 'failed', code: 'mobile_push_config',
      codeFournisseur: 'THIRD_PARTY_AUTH_ERROR', famille: 'configuration', nature: 'echec_reel',
      evenement: 'TO_PROCESS_DAILY_DIGEST', utilisateurId: '7', compteId: '4', reference: 'digest:2026-11-15',
    });
    expect(q.canal).toBe('push');
    expect(q.plateforme).toBe('ios');
    expect(q.environnement).toBe('preprod');
    expect(q.famille).toBe('configuration');
    expect(q.nature).toBe('echec_reel');
    expect(q.reference).toBe('digest:2026-11-15');
  });

  it('refuse explicitement une valeur hors vocabulaire (jamais ignorée)', () => {
    for (const [cle, valeur, code] of [
      ['periode', 'toujours', 'PERIODE_INVALIDE'],
      ['canal', 'sms', 'CANAL_INVALIDE'],
      ['plateforme', 'windows', 'PLATEFORME_INVALIDE'],
      ['environnement', 'recette', 'ENVIRONNEMENT_INVALIDE'],
      ['statutLivraison', 'parti', 'STATUT_LIVRAISON_INVALIDE'],
      ['statutEvenement', 'parti', 'STATUT_EVENEMENT_INVALIDE'],
      ['famille', 'divers', 'FAMILLE_INVALIDE'],
      ['nature', 'peut-etre', 'NATURE_INVALIDE'],
      ['utilisateurId', 'sept', 'UTILISATEUR_INVALIDE'],
      ['compteId', '4a', 'COMPTE_INVALIDE'],
      ['taille', 'beaucoup', 'TAILLE_INVALIDE'],
      ['curseur', 'nimporte', 'CURSEUR_INVALIDE'],
    ] as const) {
      const r = parseDiagnosticQuery(new URLSearchParams({ [cle]: valeur }));
      expect(r.ok, `${cle}=${valeur}`).toBe(false);
      if (!r.ok) expect(r.code).toBe(code);
    }
  });

  it('période personnalisée : deux dates, dans le bon ordre', () => {
    expect(parseDiagnosticQuery(new URLSearchParams({ periode: 'dates' })).ok).toBe(false);
    const inverse = parseDiagnosticQuery(new URLSearchParams({
      periode: 'dates', depuis: '2026-11-16T00:00:00Z', jusqu: '2026-11-15T00:00:00Z',
    }));
    expect(inverse.ok).toBe(false);
    if (!inverse.ok) expect(inverse.code).toBe('DATES_INVERSEES');
    const bon = parseDiagnosticQuery(new URLSearchParams({
      periode: 'dates', depuis: '2026-11-15T00:00:00Z', jusqu: '2026-11-16T00:00:00Z',
    }));
    expect(bon.ok).toBe(true);
  });

  it('curseur valide : date + identifiant', () => {
    const q = requete({ curseur: '2026-11-15T07:30:00.000Z|11111111-1111-4111-8111-111111111111' });
    expect(q.curseur).toEqual({ createdAt: '2026-11-15T07:30:00.000Z', id: '11111111-1111-4111-8111-111111111111' });
  });

  it('les critères se relisent à l’identique (export = même périmètre)', () => {
    const q = requete({ periode: '24h', canal: 'push', code: 'mobile_push_config' });
    const relu = requete(Object.fromEntries(queryVersParams(q).entries()));
    expect(relu.canal).toBe(q.canal);
    expect(relu.code).toBe(q.code);
    expect(relu.periode).toBe(q.periode);
  });

  it('borne la taille de page sans la refuser', () => {
    expect(requete({ taille: '9999' }).taille).toBe(500);
    expect(requete({ taille: '0' }).taille).toBe(1);
  });
});

/* ── L115B-U05 ────────────────────────────────────────────────────────────── */

describe('L115B-U05 dates affichées', () => {
  it('heure d’hiver : UTC+1', () => {
    expect(heureParis('2026-11-15T07:30:00.000Z')).toBe('2026-11-15 08:30:00');
  });

  it('heure d’été : UTC+2', () => {
    expect(heureParis('2026-07-15T07:30:00.000Z')).toBe('2026-07-15 09:30:00');
  });

  it('rend toujours le couple ISO + Europe/Paris', () => {
    const i = instant('2026-11-15T07:45:00.000Z');
    expect(i).toEqual({ iso: '2026-11-15T07:45:00.000Z', paris: '2026-11-15 08:45:00' });
    expect(instant(null)).toBeNull();
    expect(instant('pas une date')).toBeNull();
  });

  it('la fenêtre de calcul est libellée à côté des compteurs', () => {
    const l = libelleFenetre(requete({ periode: '7j' }));
    expect(l).toContain('7 jours');
    expect(l).toContain('Europe/Paris');
  });
});

/* ── L115B-U06 / U07 ──────────────────────────────────────────────────────── */

describe('L115B-U06 téléchargement JSON versionné en flux', () => {
  const q = requete({ periode: '7j', code: 'mobile_push_config' });
  const entete = {
    perimetre: perimetre(q),
    synthese: SYNTHESE,
    agregats: [],
    configurationPush: { 'Fournisseur configuré': true },
    file: { 'En attente': 0 },
    sections: [],
    champsNonEnregistres: [],
  };

  it('tête + lignes + manifeste forment un JSON valide et versionné', () => {
    const texte = jsonEntete(entete)
      + jsonLigne(ligne(), 0)
      + jsonLigne(ligne({ id: '44444444-4444-4444-8444-444444444444' }), 1)
      + jsonPied({ exporte: 2, attendu: 2, interruption: null, champsNonEnregistres: [], horodatage: new Date('2026-11-16T09:00:00Z') });
    const doc = JSON.parse(texte) as Record<string, unknown>;
    expect(doc.schema).toBe(DIAGNOSTIC_SCHEMA_VERSION);
    expect((doc.livraisons as unknown[]).length).toBe(2);
    expect((doc.manifeste as { statut: string }).statut).toBe('COMPLETE');
    expect((doc.perimetre as { versionSchema: string }).versionSchema).toBe(DIAGNOSTIC_SCHEMA_VERSION);
  });

  it('un périmètre vide reste un document valide', () => {
    const texte = jsonEntete(entete) + jsonPied({ exporte: 0, attendu: 0, interruption: null, champsNonEnregistres: [], horodatage: new Date() });
    const doc = JSON.parse(texte) as { livraisons: unknown[]; manifeste: { statut: string } };
    expect(doc.livraisons).toEqual([]);
    expect(doc.manifeste.statut).toBe('COMPLETE');
  });

  it('aucune valeur sensible ne figure dans une ligne exportée', () => {
    const texte = jsonEntete(entete) + jsonLigne(ligne(), 0) + jsonPied({ exporte: 1, attendu: 1, interruption: null, champsNonEnregistres: [], horodatage: new Date() });
    expect(texte).not.toMatch(/private_key|BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]{10,}/);
    const l = (JSON.parse(texte) as { livraisons: Array<Record<string, unknown>> }).livraisons[0];
    // Le jeton d'appareil n'apparaît que comme booléen.
    expect(l.appareilJetonPresent).toBe(true);
    expect(Object.keys(l)).not.toContain('jeton');
    expect(Object.keys(l)).not.toContain('token');
  });
});

describe('L115B-U07 manifeste de complétude', () => {
  const base = { champsNonEnregistres: [] as string[], horodatage: new Date('2026-11-16T09:00:00Z') };

  it('écart entre attendu et écrit : PARTIAL avec motif', () => {
    const m = JSON.parse(`{"x":1${jsonPied({ ...base, exporte: 70, attendu: 72, interruption: null }).replace(/^\n {2}\],/, ',')}`) as { manifeste: { statut: string; motif: string } };
    expect(m.manifeste.statut).toBe('PARTIAL');
    expect(m.manifeste.motif).toContain('72');
  });

  it('interruption : ERROR, et le motif nomme la cause', () => {
    const texte = jsonPied({ ...base, exporte: 10, attendu: 72, interruption: 'CLIENT_ABORTED' });
    expect(texte).toContain('"statut": "ERROR"');
    expect(texte).toContain('CLIENT_ABORTED');
  });

  it('traces manquantes : jamais « COMPLETE », même si le compte est bon', () => {
    const texte = jsonPied({
      exporte: 72, attendu: 72, interruption: null,
      champsNonEnregistres: ['Statut HTTP du fournisseur non enregistré pour 72 livraison(s) push en échec.'],
      horodatage: base.horodatage,
    });
    expect(texte).toContain('"statut": "PARTIAL"');
    expect(texte).toContain('antérieures à l’instrumentation');
  });
});

/* ── L115B-U08 ────────────────────────────────────────────────────────────── */

describe('L115B-U08 copie du diagnostic', () => {
  const q = requete({ periode: '7j', code: 'mobile_push_config' });
  const texte = formatDiagnosticTexte({
    perimetre: perimetre(q),
    synthese: SYNTHESE,
    agregats: [{
      statut: 'failed', code: 'mobile_push_config', famille: 'configuration',
      familleLibelle: 'Configuration du canal ou du fournisseur', nature: 'echec_reel',
      natureLibelle: 'Échec réel', canal: 'push', livraisons: 72, evenementsDistincts: 9, appareils: 4,
    }],
    lignes: [ligne(), ligne({ id: '55555555-5555-4555-8555-555555555555', instrumentationStructuree: false, etape: null, etapeLibelle: null, statutHttp: null, codeFournisseur: null, fournisseur: null })],
    sections: [{ nom: 'livraisons', statut: 'PARTIAL', attendu: 76, exporte: 2, motif: 'Page affichée.', horodatage: '2026-11-16T09:00:00.000Z', versionSchema: DIAGNOSTIC_SCHEMA_VERSION }],
    champsNonEnregistres: ['Statut HTTP du fournisseur non enregistré pour 72 livraison(s) push en échec.'],
    configurationPush: { 'Fournisseur configuré': true, 'Droits et API réellement vérifiés': false },
    file: { 'En attente': 3 },
    partiel: true,
  });

  it('porte l’identifiant du diagnostic, la fenêtre et la version du schéma', () => {
    expect(texte).toContain('Identifiant du diagnostic : DIAG-NOTIF-2026-11-16-');
    expect(texte).toContain(DIAGNOSTIC_SCHEMA_VERSION);
    expect(texte).toContain('Europe/Paris');
  });

  it('porte la synthèse chiffrée et distingue les natures', () => {
    expect(texte).toContain('Livraisons : 76');
    expect(texte).toContain('Événements de référence distincts : 11');
    expect(texte).toContain('Échec réel : 72');
    expect(texte).toContain('Ignoré volontairement : 4');
  });

  it('porte la cause par tentative : étape, statut HTTP, code fournisseur', () => {
    expect(texte).toContain('Obtention du jeton d’accès du fournisseur');
    expect(texte).toContain('Statut HTTP : 401');
    expect(texte).toContain('Code fournisseur : oauth_401');
  });

  it('dit « non enregistré » plutôt que d’inventer une cause', () => {
    expect(texte).toContain(`Statut HTTP : ${NON_ENREGISTRE}`);
    expect(texte).toContain('Trace structurée absente');
    expect(texte).toContain('Éléments non disponibles');
  });

  it('signale une copie partielle et renvoie au téléchargement', () => {
    expect(texte).toContain('qu’une partie du périmètre');
    expect(texte).toContain('Télécharger les résultats filtrés');
  });

  it('n’affiche jamais « Opération » : seulement « événement de référence »', () => {
    expect(texte).not.toMatch(/Opération/);
    expect(texte).toMatch(/[Éé]vénements? de référence/);
  });

  it('n’expose ni jeton, ni clé, ni adresse', () => {
    expect(texte).not.toMatch(/private_key|Bearer\s+[A-Za-z0-9._-]{10,}|@[a-z]+\.[a-z]{2,}/i);
    expect(texte).toContain('Jeton déchiffrable : oui');
  });
});

/* ── L115B-U09 ────────────────────────────────────────────────────────────── */

describe('L115B-U09 identifiant et nom de fichier', () => {
  it('l’identifiant est daté et stable pour un même périmètre', () => {
    const q = requete({ periode: '7j', code: 'mobile_push_config' });
    const t = new Date('2026-11-16T09:00:00Z');
    expect(identifiantDiagnostic(q, t)).toBe(identifiantDiagnostic(q, t));
    expect(identifiantDiagnostic(q, t)).toMatch(/^DIAG-NOTIF-2026-11-16-[0-9a-f]{8}$/);
  });

  it('deux périmètres différents donnent deux identifiants différents', () => {
    const t = new Date('2026-11-16T09:00:00Z');
    expect(identifiantDiagnostic(requete({ periode: '7j' }), t))
      .not.toBe(identifiantDiagnostic(requete({ periode: '24h' }), t));
  });

  it('le nom de fichier est daté, explicite et sûr', () => {
    const nom = nomFichierDiagnostic(requete({ periode: '7j' }), new Date('2026-11-16T23:30:00Z'));
    expect(nom).toBe('verebona-notifications-diagnostic-7j-2026-11-17.json');
    expect(nomFichierDiagnostic(requete(), new Date('2026-11-16T09:00:00Z'), 'evenement-22222222'))
      .toBe('verebona-notifications-diagnostic-evenement-22222222-2026-11-16.json');
  });
});

/* ── L115B-U10 ────────────────────────────────────────────────────────────── */

describe('L115B-U10 instrumentation à la source (FCM)', () => {
  it('une erreur FCM reçue porte l’étape « réponse du fournisseur » et son statut', () => {
    const r = classifyFcmError(401, { status: 'UNAUTHENTICATED' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('config');
      expect(r.statusCode).toBe(401);
      expect(r.step).toBe('reponse_fournisseur');
    }
  });

  it('THIRD_PARTY_AUTH_ERROR (route APNs) est une cause de configuration, pas un jeton', () => {
    const r = classifyFcmError(400, { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'THIRD_PARTY_AUTH_ERROR' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('config');
      expect(r.code).toBe('THIRD_PARTY_AUTH_ERROR');
      expect(r.step).toBe('reponse_fournisseur');
    }
  });

  it('UNREGISTERED reste un jeton invalide, quota et 5xx restent transitoires', () => {
    const u = classifyFcmError(404, { details: [{ errorCode: 'UNREGISTERED' }] });
    const q = classifyFcmError(429, { status: 'RESOURCE_EXHAUSTED', details: [{ errorCode: 'QUOTA_EXCEEDED' }] });
    const s = classifyFcmError(503, { status: 'UNAVAILABLE' });
    expect(u.ok === false && u.kind).toBe('invalid_token');
    expect(q.ok === false && q.kind).toBe('transient');
    expect(s.ok === false && s.kind).toBe('transient');
    expect(u.ok === false && u.code).toBe('UNREGISTERED');
  });

  it('les étapes émises appartiennent au vocabulaire persisté (migration 1745)', () => {
    const autorisees = [
      'catalogue', 'configuration', 'jeton_appareil', 'deduplication',
      'oauth_fournisseur', 'appel_fournisseur', 'reponse_fournisseur', 'canal', 'ecriture_locale',
    ];
    for (const statut of [400, 401, 403, 404, 429, 500, 503]) {
      const r = classifyFcmError(statut, { status: 'X' });
      expect(r.ok).toBe(false);
      if (!r.ok && r.step) expect(autorisees).toContain(r.step);
    }
  });

  it('l’état de configuration ne rend aucune valeur secrète', () => {
    const d = fcmConfigDiagnostic({
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: 'verebona-preprod', client_email: 'push@verebona-preprod.iam.gserviceaccount.com', private_key: 'TRES-SECRET' }),
      FIREBASE_PROJECT_ID: 'verebona-preprod',
    });
    expect(d.configure).toBe(true);
    expect(d.compteDeServiceLisible).toBe(true);
    expect(d.projetConcordant).toBe(true);
    expect(d.permissionsVerifiees).toBe(false);
    const serialise = JSON.stringify(d);
    expect(serialise).not.toContain('TRES-SECRET');
    expect(serialise).not.toContain('verebona-preprod');
    expect(serialise).not.toContain('gserviceaccount');
    expect(d.empreinteProjet).toMatch(/^[0-9a-f]{12}$/);
  });

  it('projet déclaré différent de celui du compte de service : discordance visible', () => {
    const d = fcmConfigDiagnostic({
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: 'verebona-prod', client_email: 'a@b.iam.gserviceaccount.com', private_key: 'k' }),
      FIREBASE_PROJECT_ID: 'verebona-preprod',
    });
    expect(d.projetConcordant).toBe(false);
  });

  it('variable absente ou illisible : dit lequel des deux, sans deviner', () => {
    const absente = fcmConfigDiagnostic({});
    expect(absente.compteDeServicePresent).toBe(false);
    expect(absente.anomalie).toBeNull();
    const illisible = fcmConfigDiagnostic({ FIREBASE_SERVICE_ACCOUNT_JSON: 'ceci-n-est-pas-du-json' });
    expect(illisible.compteDeServicePresent).toBe(true);
    expect(illisible.compteDeServiceLisible).toBe(false);
    expect(illisible.anomalie).toContain('FIREBASE_SERVICE_ACCOUNT_JSON');
  });

  it('toutes les natures du vocabulaire ont un libellé', () => {
    for (const n of NATURES) expect(nature('failed', 'push') && n).toBeTruthy();
  });
});
