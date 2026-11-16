'use client';

/**
 * Diagnostic des notifications — écran du BO (lot 115B, Trello #800).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN OUTIL D'EXPLOITATION, PAS UNE PAGE DE PLUS
 *
 * Devant un échec d'envoi, l'administrateur doit pouvoir dire OÙ la chaîne a
 * cassé — jeton d'appareil, canal, catalogue, fournisseur FCM, file, règle de
 * publication — sans accès à la base. D'où :
 *
 *   · des agrégats CLIQUABLES : un clic sur « failed · mobile_push_config »
 *     ouvre les livraisons correspondantes, filtres conservés, et le total de
 *     l'agrégat est celui du détail (#800 CA01) ;
 *   · un détail dépliable par livraison : étape, statut HTTP, code exact du
 *     fournisseur, appareil, horodatages Europe/Paris ET UTC ;
 *   · « Copier le diagnostic » et « Télécharger les résultats filtrés », qui
 *     reprennent le PÉRIMÈTRE ENTIER et non la page affichée (#800 CA05) ;
 *   · un bandeau de complétude : ce qui manque est écrit, jamais deviné.
 *
 * Le texte et les fichiers sont construits CÔTÉ SERVEUR (expurgation, audit) :
 * le navigateur ne fait que copier ou enregistrer. Un échec HTTP affiche son
 * code de diagnostic — jamais « aucun résultat » (#800 CA07).
 *
 * Ce composant ne déclenche AUCUN envoi : le test d'envoi (#756) et la
 * réémission (#757) restent des actions séparées et explicites (#800 CA09).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Loader2, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ExportFileButton } from '@/components/admin/ExportFileButton';
import { copyText } from '@/app/admin/ai-executions/_components/CopyJson';
import { EXPORT_MESSAGES } from '@/lib/files/export-delivery';

/** Textes nouveaux — À VALIDER PAR LE PO (lot 115B, #800). */
export const DIAGNOSTIC_NOTIFICATIONS_TEXTS = {
  titre: 'Notifications — diagnostic des échecs',
  intro: 'Pour chaque tentative : l’étape où la chaîne a cassé, le code exact du fournisseur, le statut HTTP et l’appareil visé. Ce qui n’a pas été enregistré est écrit « non enregistré » : aucune cause n’est reconstruite.',
  lectureSeule: 'Consultation seule : ouvrir ou exporter un diagnostic n’envoie aucune notification et ne réémet rien.',
  rechercher: 'Rechercher',
  reinitialiser: 'Réinitialiser les filtres',
  actualiser: 'Actualiser',
  copier: 'Copier le diagnostic',
  copie: 'Copié',
  telecharger: 'Télécharger le diagnostic',
  telechargerFiltre: 'Télécharger les résultats filtrés',
  copieFaite: 'Diagnostic copié : prêt à transmettre à l’équipe technique.',
  copieImpossible: 'Copie impossible dans ce navigateur : utilisez « Télécharger le diagnostic ».',
  pageSuivante: 'Afficher les livraisons suivantes',
  aucune: 'Aucune livraison dans ce périmètre (la recherche a bien abouti).',
  agregatsTitre: 'Causes par statut et code — cliquez une ligne pour ouvrir les livraisons',
  detailTitre: 'Livraisons — événement de référence, canal, appareil',
  configTitre: 'Configuration du push mobile (aucune valeur secrète)',
  fileTitre: 'File des événements de référence',
  completudeTitre: 'Complétude du diagnostic',
  nonVerifie: 'Les droits et l’API du fournisseur ne sont PAS vérifiés ici : le diagnostic n’appelle jamais FCM.',
  rechercheLibre: 'Identifiant, clé de déduplication, type d’événement ou code (recherche sans identifiant interne)',
  partiel: 'La page affichée ne contient qu’une partie du périmètre : le téléchargement reprend l’ensemble.',
} as const;

/* ── Types servis par la route ────────────────────────────────────────────── */

interface Instant { iso: string; paris: string }

interface Ligne {
  id: string;
  evenementId: string;
  evenementType: string;
  evenementStatut: string;
  evenementCategorie: string | null;
  evenementMotif: string | null;
  regroupeAvecId: string | null;
  cleDeduplication: string | null;
  tentativesEvenement: number;
  canal: string;
  statut: string;
  nature: string;
  natureLibelle: string;
  code: string | null;
  famille: string;
  familleLibelle: string;
  message: string | null;
  etape: string | null;
  etapeLibelle: string | null;
  categorieEchec: string | null;
  fournisseur: string | null;
  statutHttp: number | null;
  codeFournisseur: string | null;
  messageFournisseur: string | null;
  plateforme: string | null;
  versionApplication: string | null;
  build: string | null;
  appareilId: string | null;
  appareilEmpreinte: string | null;
  appareilStatut: string | null;
  appareilMotifStatut: string | null;
  appareilEnvironnement: string | null;
  appareilJetonPresent: boolean | null;
  utilisateurId: number;
  compteId: number | null;
  creeLe: Instant | null;
  tenteLe: Instant | null;
  envoyeLe: Instant | null;
  evenementCreeLe: Instant | null;
  evenementTraiteLe: Instant | null;
  evenementPrevuLe: Instant | null;
  remiseConfirmee: boolean | null;
  instrumentationStructuree: boolean;
}

interface Agregat {
  statut: string; code: string | null; famille: string; familleLibelle: string;
  nature: string; natureLibelle: string; canal: string;
  livraisons: number; evenementsDistincts: number; appareils: number;
}

interface Section { nom: string; statut: string; attendu: number | null; exporte: number | null; motif: string | null }

interface Rapport {
  perimetre: {
    identifiantDiagnostic: string;
    versionSchema: string;
    genereLe: Instant;
    instantane: Instant;
    fenetre: { depuis: Instant; jusqu: Instant; periode: string; libelle: string };
    environnement: string;
    build: { version: string; commit: string | null };
  };
  synthese: {
    livraisons: number; evenementsDistincts: number; tentativesEvenements: number; appareils: number;
    parNature: Record<string, number>;
  };
  agregats: Agregat[];
  lignes: Ligne[];
  curseurSuivant: string | null;
  total: number;
  configurationPush: Record<string, string | number | boolean | null>;
  file: Record<string, number | string | null>;
  sections: Section[];
  champsNonEnregistres: string[];
}

/* ── Filtres ──────────────────────────────────────────────────────────────── */

interface Filtres {
  periode: string;
  depuis: string;
  jusqu: string;
  canal: string;
  plateforme: string;
  environnement: string;
  statutLivraison: string;
  statutEvenement: string;
  code: string;
  codeFournisseur: string;
  famille: string;
  nature: string;
  evenement: string;
  utilisateurId: string;
  compteId: string;
  reference: string;
}

const FILTRES_VIDES: Filtres = {
  periode: '7j', depuis: '', jusqu: '', canal: '', plateforme: '', environnement: '',
  statutLivraison: '', statutEvenement: '', code: '', codeFournisseur: '', famille: '',
  nature: '', evenement: '', utilisateurId: '', compteId: '', reference: '',
};

const PERIODES: Array<[string, string]> = [['24h', '24 heures'], ['7j', '7 jours'], ['30j', '30 jours'], ['dates', 'Dates choisies']];
const CANAUX: Array<[string, string]> = [['', 'Tous les canaux'], ['push', 'Push mobile'], ['email', 'E-mail'], ['bell', 'Cloche']];
const PLATEFORMES: Array<[string, string]> = [['', 'Toutes les plateformes'], ['ios', 'iPhone'], ['android', 'Android']];
const ENVIRONNEMENTS: Array<[string, string]> = [['', 'Tous les environnements'], ['preprod', 'Préproduction'], ['production', 'Production'], ['local', 'Local']];
const NATURES: Array<[string, string]> = [
  ['', 'Toutes les natures'],
  ['echec_reel', 'Échec réel'],
  ['ignore_volontaire', 'Ignoré volontairement'],
  ['jeton_expire', 'Jeton expiré ou refusé'],
  ['accepte_par_prestataire', 'Accepté par le prestataire'],
  ['ecrit_localement', 'Écrit dans la cloche'],
  ['en_attente', 'En attente'],
];
const FAMILLES: Array<[string, string]> = [
  ['', 'Toutes les familles'],
  ['configuration', 'Configuration'],
  ['catalogue', 'Catalogue'],
  ['jeton_appareil', 'Jeton ou appareil'],
  ['deduplication', 'Déduplication'],
  ['canal', 'Canal'],
  ['fournisseur', 'Fournisseur'],
  ['reseau', 'Réseau'],
  ['destinataire', 'Destinataire'],
  ['interne', 'Écriture interne'],
  ['aucune', 'Aucune erreur'],
  ['inconnue', 'Famille non déterminée'],
];
const STATUTS_LIVRAISON: Array<[string, string]> = [
  ['', 'Tous les statuts de livraison'],
  ['failed', 'Échec'], ['sent', 'Envoyée'], ['expired', 'Jeton expiré'],
  ['skipped_unavailable', 'Ignorée (indisponible)'], ['skipped_preference', 'Ignorée (préférence)'], ['pending', 'En attente'],
];
const STATUTS_EVENEMENT: Array<[string, string]> = [
  ['', 'Tous les statuts d’événement'],
  ['failed', 'Échec'], ['partial', 'Envoi partiel'], ['sent', 'Envoyé'], ['skipped', 'Ignoré'],
  ['grouped', 'Regroupé'], ['pending', 'En attente'], ['processing', 'En cours'], ['reemitted', 'Réémis'], ['cancelled', 'Annulé'],
];

function versParams(f: Filtres): URLSearchParams {
  const sp = new URLSearchParams();
  sp.set('periode', f.periode);
  if (f.periode === 'dates') {
    if (f.depuis) sp.set('depuis', new Date(f.depuis).toISOString());
    if (f.jusqu) sp.set('jusqu', new Date(f.jusqu).toISOString());
  }
  const paires: Array<[string, string]> = [
    ['canal', f.canal], ['plateforme', f.plateforme], ['environnement', f.environnement],
    ['statutLivraison', f.statutLivraison], ['statutEvenement', f.statutEvenement],
    ['code', f.code], ['codeFournisseur', f.codeFournisseur], ['famille', f.famille],
    ['nature', f.nature], ['evenement', f.evenement], ['utilisateurId', f.utilisateurId],
    ['compteId', f.compteId], ['reference', f.reference],
  ];
  for (const [k, v] of paires) if (v.trim() !== '') sp.set(k, v.trim());
  return sp;
}

/* ── Pièces d'interface ───────────────────────────────────────────────────── */

function Tuile({ libelle, valeur, ton = 'neutre' }: { libelle: string; valeur: React.ReactNode; ton?: 'neutre' | 'alerte' | 'bon' }) {
  const couleur = ton === 'alerte' ? 'text-[color:var(--text-warning-soft)]' : ton === 'bon' ? 'text-[color:var(--text-success)]' : 'text-[color:var(--text-primary)]';
  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-3 py-2">
      <p className="text-[11px] leading-tight text-[color:var(--text-muted)]">{libelle}</p>
      <p className={`text-base font-medium tabular-nums ${couleur}`}>{valeur}</p>
    </div>
  );
}

function Bloc({ titre, children, actions }: { titre: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3 sm:p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-[color:var(--text-primary)]">{titre}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Choix({ label, valeur, options, onChange }: { label: string; valeur: string; options: Array<[string, string]>; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[color:var(--text-muted)]">
      <span className="sr-only sm:not-sr-only">{label}</span>
      <select
        aria-label={label}
        value={valeur}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-[color:var(--input)] bg-[color:var(--bg-input)] px-2 text-sm text-[color:var(--text-primary)]"
      >
        {options.map(([v, l]) => <option key={v || 'tous'} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

/** Valeur affichée : `null` devient « non enregistré », jamais une supposition. */
function val(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined || v === '') return 'non enregistré';
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  return String(v);
}

function DetailLigne({ l }: { l: Ligne }) {
  const champs: Array<[string, string]> = [
    ['Livraison', l.id],
    ['Événement de référence', l.evenementId],
    ['Type d’événement', l.evenementType],
    ['Statut de l’événement', `${l.evenementStatut}${l.evenementMotif ? ` (${l.evenementMotif})` : ''}`],
    ['Catégorie', val(l.evenementCategorie)],
    ['Tentatives de l’événement', String(l.tentativesEvenement)],
    ['Clé de déduplication (tronquée)', val(l.cleDeduplication)],
    ['Regroupé avec', val(l.regroupeAvecId)],
    ['Canal', l.canal],
    ['Résultat', l.natureLibelle],
    ['Code interne', val(l.code)],
    ['Famille', l.familleLibelle],
    ['Étape fautive', val(l.etapeLibelle)],
    ['Catégorie de cause', val(l.categorieEchec)],
    ['Fournisseur', val(l.fournisseur)],
    ['Statut HTTP', val(l.statutHttp)],
    ['Code exact du fournisseur', val(l.codeFournisseur)],
    ['Message technique (expurgé)', val(l.message)],
    ['Identifiant de message du fournisseur', val(l.messageFournisseur)],
    ['Mise en file', l.evenementCreeLe ? `${l.evenementCreeLe.paris} · ${l.evenementCreeLe.iso}` : 'non enregistré'],
    ['Heure prévue', l.evenementPrevuLe ? `${l.evenementPrevuLe.paris} · ${l.evenementPrevuLe.iso}` : 'non enregistré'],
    ['Tentative', l.tenteLe ? `${l.tenteLe.paris} · ${l.tenteLe.iso}` : 'non enregistré'],
    ['Acceptation', l.envoyeLe ? `${l.envoyeLe.paris} · ${l.envoyeLe.iso}` : 'non enregistré'],
    ['Événement traité', l.evenementTraiteLe ? `${l.evenementTraiteLe.paris} · ${l.evenementTraiteLe.iso}` : 'non enregistré'],
    ['Destinataire (utilisateur)', String(l.utilisateurId)],
    ['Compte', val(l.compteId)],
  ];
  if (l.canal === 'push') {
    champs.push(
      ['Appareil (empreinte)', val(l.appareilEmpreinte)],
      ['Appareil (identifiant interne)', val(l.appareilId)],
      ['Plateforme', val(l.plateforme)],
      ['Version / build', `${val(l.versionApplication)} / ${val(l.build)}`],
      ['Statut de l’appareil', `${val(l.appareilStatut)}${l.appareilMotifStatut ? ` (${l.appareilMotifStatut})` : ''}`],
      ['Environnement de l’appareil', val(l.appareilEnvironnement)],
      ['Jeton déchiffrable présent', val(l.appareilJetonPresent)],
    );
  }
  if (l.canal === 'email') {
    champs.push(['Remise confirmée par le prestataire', val(l.remiseConfirmee)]);
  }
  return (
    <div className="space-y-2 bg-[color:var(--bg-subtle)] px-3 py-2">
      {!l.instrumentationStructuree && (
        <p className="text-xs text-[color:var(--text-warning-soft)]">
          Trace structurée absente : cette livraison est antérieure à l’instrumentation. L’étape, le statut HTTP et le code du
          fournisseur n’ont pas été enregistrés — aucune cause n’est reconstruite.
        </p>
      )}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        {champs.map(([k, v]) => (
          <div key={k} className="flex flex-wrap gap-x-2 text-xs">
            <dt className="text-[color:var(--text-muted)]">{k} :</dt>
            <dd className="font-mono break-all text-[color:var(--text-secondary)]">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-start gap-1.5 pt-1">
        <BoutonCopie url={`/api/admin/notifications/diagnostic/${encodeURIComponent(l.evenementId)}?format=texte`} testId={`diag-copier-${l.evenementId}`} />
        <ExportFileButton
          url={`/api/admin/notifications/diagnostic/${encodeURIComponent(l.evenementId)}?download=1`}
          kind="json"
          label={DIAGNOSTIC_NOTIFICATIONS_TEXTS.telecharger}
          fallbackName={`verebona-notifications-diagnostic-evenement-${l.evenementId.slice(0, 8)}.json`}
          testId={`diag-telecharger-${l.evenementId}`}
        />
      </div>
    </div>
  );
}

/** Copie d'un texte construit par le serveur (expurgation et audit côté serveur). */
function BoutonCopie({ url, testId }: { url: string; testId: string }) {
  const [busy, setBusy] = useState(false);
  const [fait, setFait] = useState(false);
  const lancer = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(url, { credentials: 'include', cache: 'no-store', headers: { Accept: 'text/plain' } });
      if (!res.ok) {
        const corps = await res.json().catch(() => null) as { error?: string; code?: string } | null;
        toast.error(corps?.code ? `${corps.error ?? EXPORT_MESSAGES.SERVER_ERROR} (code ${corps.code})` : EXPORT_MESSAGES.SERVER_ERROR);
        return;
      }
      if (await copyText(await res.text())) {
        setFait(true);
        setTimeout(() => setFait(false), 2000);
        toast.success(DIAGNOSTIC_NOTIFICATIONS_TEXTS.copieFaite);
      } else {
        toast.error(DIAGNOSTIC_NOTIFICATIONS_TEXTS.copieImpossible);
      }
    } catch {
      toast.error(EXPORT_MESSAGES.NETWORK);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="outline" type="button" onClick={() => void lancer()} disabled={busy} aria-busy={busy} data-testid={testId}>
      {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
        : fait ? <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          : <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
      {fait ? DIAGNOSTIC_NOTIFICATIONS_TEXTS.copie : DIAGNOSTIC_NOTIFICATIONS_TEXTS.copier}
    </Button>
  );
}

/* ── Écran ────────────────────────────────────────────────────────────────── */

export function NotificationsDiagnostic({ filtresInitiaux }: { filtresInitiaux?: Partial<Filtres> } = {}) {
  // Les filtres de départ dépendent de l'écran d'accueil (« Push mobile — 7
  // derniers jours » arrive avec `canal=push`). Figés par leur contenu, pas
  // par l'identité de l'objet : une nouvelle référence à chaque rendu du
  // parent ne doit pas relancer la lecture en boucle.
  const cleInitiale = JSON.stringify(filtresInitiaux ?? {});
  const depart = useMemo<Filtres>(() => ({ ...FILTRES_VIDES, ...(JSON.parse(cleInitiale) as Partial<Filtres>) }), [cleInitiale]);
  const [filtres, setFiltres] = useState<Filtres>(depart);
  const [rapport, setRapport] = useState<Rapport | null>(null);
  const [suite, setSuite] = useState<Ligne[]>([]);
  const [curseur, setCurseur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState<{ message: string; code: string } | null>(null);
  const [ouvertes, setOuvertes] = useState<Set<string>>(new Set());

  const charger = useCallback(async (f: Filtres) => {
    setChargement(true);
    setErreur(null);
    try {
      const res = await fetch(`/api/admin/notifications/diagnostic?${versParams(f).toString()}`, { credentials: 'include', cache: 'no-store' });
      const corps = await res.json().catch(() => null) as (Rapport & { error?: string; code?: string }) | null;
      if (!res.ok || !corps || corps.error) {
        // CA07 : l'écran montre le code de diagnostic et l'erreur. Jamais
        // « aucun résultat » pour un échec de recherche.
        setRapport(null);
        setErreur({ message: corps?.error ?? 'Diagnostic indisponible.', code: corps?.code ?? `HTTP_${res.status}` });
        return;
      }
      setRapport(corps);
      setSuite([]);
      setCurseur(corps.curseurSuivant);
      setOuvertes(new Set());
    } catch {
      setRapport(null);
      setErreur({ message: EXPORT_MESSAGES.NETWORK, code: 'RESEAU' });
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => { setFiltres(depart); void charger(depart); }, [charger, depart]);

  const pageSuivante = async () => {
    if (!curseur) return;
    setChargement(true);
    try {
      const sp = versParams(filtres);
      sp.set('curseur', curseur);
      const res = await fetch(`/api/admin/notifications/diagnostic?${sp.toString()}`, { credentials: 'include', cache: 'no-store' });
      const corps = await res.json().catch(() => null) as (Rapport & { error?: string; code?: string }) | null;
      if (!res.ok || !corps || corps.error) {
        setErreur({ message: corps?.error ?? 'Page suivante indisponible.', code: corps?.code ?? `HTTP_${res.status}` });
        return;
      }
      setSuite((s) => [...s, ...corps.lignes]);
      setCurseur(corps.curseurSuivant);
    } catch {
      setErreur({ message: EXPORT_MESSAGES.NETWORK, code: 'RESEAU' });
    } finally {
      setChargement(false);
    }
  };

  /** Clic sur un agrégat : les mêmes filtres, plus ce statut, ce code et ce canal. */
  const ouvrirAgregat = (a: Agregat) => {
    const suivants: Filtres = { ...filtres, statutLivraison: a.statut, canal: a.canal, code: a.code ?? '', famille: a.code === null ? 'aucune' : '' };
    setFiltres(suivants);
    void charger(suivants);
  };

  const lignes = useMemo(() => (rapport ? [...rapport.lignes, ...suite] : []), [rapport, suite]);
  const paramsExport = useMemo(() => versParams(filtres).toString(), [filtres]);
  const partiel = !!rapport && lignes.length < rapport.total;

  return (
    <div className="space-y-3" data-testid="notifications-diagnostic">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="max-w-3xl space-y-1">
          <h2 className="vb-app-section">{DIAGNOSTIC_NOTIFICATIONS_TEXTS.titre}</h2>
          <p className="text-xs text-[color:var(--text-muted)]">{DIAGNOSTIC_NOTIFICATIONS_TEXTS.intro}</p>
          <p className="text-xs text-[color:var(--text-muted)]">{DIAGNOSTIC_NOTIFICATIONS_TEXTS.lectureSeule}</p>
        </div>
        <div className="flex flex-wrap items-start gap-1.5">
          <BoutonCopie url={`/api/admin/notifications/diagnostic?${paramsExport}&format=texte`} testId="diag-copier-recherche" />
          <ExportFileButton
            url={`/api/admin/notifications/diagnostic/export?${paramsExport}`}
            kind="json"
            label={rapport ? `${DIAGNOSTIC_NOTIFICATIONS_TEXTS.telechargerFiltre} (${rapport.total})` : DIAGNOSTIC_NOTIFICATIONS_TEXTS.telechargerFiltre}
            fallbackName="verebona-notifications-diagnostic.json"
            testId="diag-telecharger-filtre"
          />
          <Button size="sm" variant="ghost" type="button" onClick={() => void charger(filtres)} disabled={chargement} aria-label={DIAGNOSTIC_NOTIFICATIONS_TEXTS.actualiser}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      {/* Filtres combinables (#800 §3.2) */}
      <Bloc titre="Filtres">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Choix label="Période" valeur={filtres.periode} options={PERIODES} onChange={(v) => setFiltres((f) => ({ ...f, periode: v }))} />
          {filtres.periode === 'dates' && (
            <>
              <label className="flex flex-col gap-1 text-xs text-[color:var(--text-muted)]">
                <span>Du</span>
                <Input type="datetime-local" aria-label="Date de début" value={filtres.depuis} onChange={(e) => setFiltres((f) => ({ ...f, depuis: e.target.value }))} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[color:var(--text-muted)]">
                <span>Au</span>
                <Input type="datetime-local" aria-label="Date de fin" value={filtres.jusqu} onChange={(e) => setFiltres((f) => ({ ...f, jusqu: e.target.value }))} />
              </label>
            </>
          )}
          <Choix label="Canal" valeur={filtres.canal} options={CANAUX} onChange={(v) => setFiltres((f) => ({ ...f, canal: v }))} />
          <Choix label="Plateforme" valeur={filtres.plateforme} options={PLATEFORMES} onChange={(v) => setFiltres((f) => ({ ...f, plateforme: v }))} />
          <Choix label="Environnement" valeur={filtres.environnement} options={ENVIRONNEMENTS} onChange={(v) => setFiltres((f) => ({ ...f, environnement: v }))} />
          <Choix label="Nature du résultat" valeur={filtres.nature} options={NATURES} onChange={(v) => setFiltres((f) => ({ ...f, nature: v }))} />
          <Choix label="Famille d’erreur" valeur={filtres.famille} options={FAMILLES} onChange={(v) => setFiltres((f) => ({ ...f, famille: v }))} />
          <Choix label="Statut de livraison" valeur={filtres.statutLivraison} options={STATUTS_LIVRAISON} onChange={(v) => setFiltres((f) => ({ ...f, statutLivraison: v }))} />
          <Choix label="Statut de l’événement" valeur={filtres.statutEvenement} options={STATUTS_EVENEMENT} onChange={(v) => setFiltres((f) => ({ ...f, statutEvenement: v }))} />
          <Input aria-label="Code d’erreur exact" placeholder="Code d’erreur exact" value={filtres.code} onChange={(e) => setFiltres((f) => ({ ...f, code: e.target.value }))} />
          <Input aria-label="Code du fournisseur" placeholder="Code du fournisseur (UNREGISTERED…)" value={filtres.codeFournisseur} onChange={(e) => setFiltres((f) => ({ ...f, codeFournisseur: e.target.value }))} />
          <Input aria-label="Type d’événement" placeholder="Type d’événement" value={filtres.evenement} onChange={(e) => setFiltres((f) => ({ ...f, evenement: e.target.value }))} />
          <Input aria-label="Utilisateur (n°)" placeholder="Utilisateur (n°)" value={filtres.utilisateurId} onChange={(e) => setFiltres((f) => ({ ...f, utilisateurId: e.target.value }))} />
          <Input aria-label="Compte (n°)" placeholder="Compte (n°)" value={filtres.compteId} onChange={(e) => setFiltres((f) => ({ ...f, compteId: e.target.value }))} />
          <Input
            className="lg:col-span-2"
            aria-label={DIAGNOSTIC_NOTIFICATIONS_TEXTS.rechercheLibre}
            placeholder={DIAGNOSTIC_NOTIFICATIONS_TEXTS.rechercheLibre}
            value={filtres.reference}
            onChange={(e) => setFiltres((f) => ({ ...f, reference: e.target.value }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="outline" type="button" onClick={() => void charger(filtres)} disabled={chargement} data-testid="diag-rechercher">
            {chargement ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Search className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
            {DIAGNOSTIC_NOTIFICATIONS_TEXTS.rechercher}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => { setFiltres(FILTRES_VIDES); void charger(FILTRES_VIDES); }} disabled={chargement}>
            {DIAGNOSTIC_NOTIFICATIONS_TEXTS.reinitialiser}
          </Button>
          <span className="text-xs text-[color:var(--text-muted)]">Consultation journalisée.</span>
        </div>
      </Bloc>

      {erreur && (
        <p
          role="alert"
          data-testid="diag-erreur"
          className="rounded-lg border border-[color:var(--border-danger)] bg-[color:var(--bg-danger)] px-3 py-2 text-sm text-[color:var(--text-danger)]"
        >
          {erreur.message} <span className="font-mono text-xs">(code de diagnostic : {erreur.code})</span>
        </p>
      )}

      {rapport && (
        <>
          <p className="text-xs text-[color:var(--text-muted)]">
            {rapport.perimetre.fenetre.libelle} · diagnostic {rapport.perimetre.identifiantDiagnostic} · schéma {rapport.perimetre.versionSchema} ·
            instantané du {rapport.perimetre.instantane.paris} · environnement {rapport.perimetre.environnement} · version {rapport.perimetre.build.version}
          </p>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tuile libelle="Livraisons" valeur={rapport.synthese.livraisons} />
            <Tuile libelle="Événements de référence distincts" valeur={rapport.synthese.evenementsDistincts} />
            <Tuile libelle="Tentatives cumulées" valeur={rapport.synthese.tentativesEvenements} />
            <Tuile libelle="Appareils concernés" valeur={rapport.synthese.appareils} />
            <Tuile libelle="Échecs réels" valeur={rapport.synthese.parNature.echec_reel ?? 0} ton={(rapport.synthese.parNature.echec_reel ?? 0) > 0 ? 'alerte' : 'bon'} />
            <Tuile libelle="Ignorés volontairement" valeur={rapport.synthese.parNature.ignore_volontaire ?? 0} />
            <Tuile libelle="Jetons expirés" valeur={rapport.synthese.parNature.jeton_expire ?? 0} />
            <Tuile libelle="Acceptés par le prestataire" valeur={rapport.synthese.parNature.accepte_par_prestataire ?? 0} />
          </div>

          <Bloc titre={DIAGNOSTIC_NOTIFICATIONS_TEXTS.agregatsTitre}>
            {rapport.agregats.length === 0 ? (
              <p className="text-sm text-[color:var(--text-muted)]">{DIAGNOSTIC_NOTIFICATIONS_TEXTS.aucune}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-[color:var(--text-muted)]">
                      <th className="px-2 py-1 font-medium">Statut</th>
                      <th className="px-2 py-1 font-medium">Code</th>
                      <th className="px-2 py-1 font-medium">Canal</th>
                      <th className="px-2 py-1 font-medium">Résultat</th>
                      <th className="px-2 py-1 font-medium">Famille</th>
                      <th className="px-2 py-1 text-right font-medium">Livraisons</th>
                      <th className="px-2 py-1 text-right font-medium">Événements</th>
                      <th className="px-2 py-1 text-right font-medium">Appareils</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rapport.agregats.map((a) => (
                      <tr
                        key={`${a.statut}-${a.code ?? 'sans'}-${a.canal}`}
                        className="cursor-pointer border-t border-[color:var(--border-subtle)] hover:bg-[color:var(--bg-hover)]"
                        onClick={() => ouvrirAgregat(a)}
                      >
                        <td className="px-2 py-1">
                          <button type="button" className="text-left underline decoration-dotted" data-testid={`diag-agregat-${a.statut}-${a.code ?? 'sans'}`}>
                            {a.statut}
                          </button>
                        </td>
                        <td className="px-2 py-1 font-mono text-xs">{a.code ?? 'sans code'}</td>
                        <td className="px-2 py-1">{a.canal}</td>
                        <td className="px-2 py-1 text-xs">{a.natureLibelle}</td>
                        <td className="px-2 py-1 text-xs">{a.familleLibelle}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{a.livraisons}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{a.evenementsDistincts}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{a.appareils}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Bloc>

          <Bloc titre={`${DIAGNOSTIC_NOTIFICATIONS_TEXTS.detailTitre} — ${lignes.length} affichée(s) sur ${rapport.total}`}>
            {partiel && <p className="text-xs text-[color:var(--text-warning-soft)]">{DIAGNOSTIC_NOTIFICATIONS_TEXTS.partiel}</p>}
            {lignes.length === 0 ? (
              <p className="text-sm text-[color:var(--text-muted)]">{DIAGNOSTIC_NOTIFICATIONS_TEXTS.aucune}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-[color:var(--text-muted)]">
                      <th className="px-2 py-1 font-medium" />
                      <th className="px-2 py-1 font-medium">Date (Europe/Paris)</th>
                      <th className="px-2 py-1 font-medium">Événement de référence</th>
                      <th className="px-2 py-1 font-medium">Canal</th>
                      <th className="px-2 py-1 font-medium">Résultat</th>
                      <th className="px-2 py-1 font-medium">Étape</th>
                      <th className="px-2 py-1 font-medium">HTTP</th>
                      <th className="px-2 py-1 font-medium">Code fournisseur</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lignes.map((l) => {
                      const ouverte = ouvertes.has(l.id);
                      return (
                        <Fragment key={l.id}>
                          <tr className="border-t border-[color:var(--border-subtle)]">
                            <td className="px-1 py-1">
                              <button
                                type="button"
                                aria-expanded={ouverte}
                                aria-label={ouverte ? 'Replier le détail' : 'Déplier le détail'}
                                data-testid={`diag-detail-${l.id}`}
                                onClick={() => setOuvertes((s) => {
                                  const n = new Set(s);
                                  if (n.has(l.id)) n.delete(l.id); else n.add(l.id);
                                  return n;
                                })}
                                className="inline-flex h-6 w-6 items-center justify-center rounded text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)]"
                              >
                                {ouverte ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                              </button>
                            </td>
                            <td className="px-2 py-1 text-xs">{l.creeLe?.paris ?? 'non enregistré'}</td>
                            <td className="px-2 py-1 text-xs">
                              <span className="font-mono">{l.evenementId.slice(0, 8)}…</span> {l.evenementType}
                            </td>
                            <td className="px-2 py-1">{l.canal}</td>
                            <td className="px-2 py-1 text-xs">{l.natureLibelle}</td>
                            <td className="px-2 py-1 text-xs">{val(l.etapeLibelle)}</td>
                            <td className="px-2 py-1 text-xs tabular-nums">{val(l.statutHttp)}</td>
                            <td className="px-2 py-1 font-mono text-xs break-all">{val(l.codeFournisseur ?? l.code)}</td>
                          </tr>
                          {ouverte && (
                            <tr>
                              <td colSpan={8} className="p-0"><DetailLigne l={l} /></td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {curseur && (
              <Button size="sm" variant="outline" type="button" onClick={() => void pageSuivante()} disabled={chargement} data-testid="diag-page-suivante">
                {chargement && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
                {DIAGNOSTIC_NOTIFICATIONS_TEXTS.pageSuivante}
              </Button>
            )}
          </Bloc>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Bloc titre={DIAGNOSTIC_NOTIFICATIONS_TEXTS.configTitre}>
              <dl className="space-y-1">
                {Object.entries(rapport.configurationPush).map(([k, v]) => (
                  <div key={k} className="flex flex-wrap justify-between gap-2 text-xs">
                    <dt className="text-[color:var(--text-muted)]">{k}</dt>
                    <dd className="font-mono text-[color:var(--text-secondary)]">{val(v)}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-[color:var(--text-warning-soft)]">{DIAGNOSTIC_NOTIFICATIONS_TEXTS.nonVerifie}</p>
            </Bloc>

            <Bloc titre={DIAGNOSTIC_NOTIFICATIONS_TEXTS.fileTitre}>
              <dl className="space-y-1">
                {Object.entries(rapport.file).map(([k, v]) => (
                  <div key={k} className="flex flex-wrap justify-between gap-2 text-xs">
                    <dt className="text-[color:var(--text-muted)]">{k}</dt>
                    <dd className="font-mono text-[color:var(--text-secondary)]">{val(v)}</dd>
                  </div>
                ))}
              </dl>
            </Bloc>
          </div>

          <Bloc titre={DIAGNOSTIC_NOTIFICATIONS_TEXTS.completudeTitre}>
            <ul className="space-y-1 text-xs">
              {rapport.sections.map((s) => (
                <li key={s.nom} className="flex flex-wrap gap-2">
                  <span className="font-mono text-[color:var(--text-secondary)]">{s.nom}</span>
                  <span className={s.statut === 'COMPLETE' ? 'text-[color:var(--text-success)]' : s.statut === 'ERROR' ? 'text-[color:var(--text-danger)]' : 'text-[color:var(--text-warning-soft)]'}>
                    {s.statut}
                  </span>
                  {s.attendu !== null && <span className="text-[color:var(--text-muted)]">attendu {s.attendu}, obtenu {s.exporte ?? 0}</span>}
                  {s.motif && <span className="text-[color:var(--text-muted)]">— {s.motif}</span>}
                </li>
              ))}
            </ul>
            {rapport.champsNonEnregistres.length > 0 && (
              <>
                <p className="pt-1 text-xs text-[color:var(--text-muted)]">Éléments non disponibles (jamais reconstruits) :</p>
                <ul className="list-disc pl-5 text-xs text-[color:var(--text-warning-soft)]">
                  {rapport.champsNonEnregistres.map((c) => <li key={c}>{c}</li>)}
                </ul>
              </>
            )}
          </Bloc>
        </>
      )}

      {!rapport && !erreur && chargement && (
        <p className="text-sm text-[color:var(--text-muted)]">Lecture du diagnostic…</p>
      )}
    </div>
  );
}
