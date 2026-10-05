/**
 * File de dépôt de documents — APP-PERF-25, APP-PERF-29, APP-PERF-30 (client).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA FILE NE VIT PLUS DANS LE PANNEAU
 *
 * L'état et l'`AbortController` du dépôt vivaient dans `UnifiedDocumentDialog` :
 * fermer le panneau annulait l'envoi, et le menu mobile démontait le
 * dialogue à la fermeture — la progression était perdue. La file est
 * désormais un module unique de l'application (singleton `fileDepot`) :
 *   · fermer le panneau ou changer de page (navigation interne) ne l'arrête
 *     pas ; la progression reste visible dans `UploadQueueIndicator` ;
 *   · l'annulation est une action EXPLICITE (lot ou fichier) ;
 *   · chaque fichier se reprend à la bonne étape : préparation, transfert
 *     (même opération ⇒ même document côté serveur) ou confirmation seule.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN FICHIER = UN CYCLE COMPLET, CONCURRENCE BORNÉE
 *
 * Chaque fichier suit empreinte → presign → PUT → confirm, avec SA
 * confirmation (jamais de confirmation groupée ni d'analyse fusionnant le
 * lot). Deux limites distinctes :
 *   · préparations (empreinte) : 1 à la fois — un seul pic de lecture ;
 *   · transferts (presign + PUT + confirm) : `concurrenceTransferts`,
 *     2 par défaut, réglable (`NEXT_PUBLIC_UPLOAD_CONCURRENCY`, 1 à 3).
 *     1 reste le repli : comportement séquentiel antérieur. Le défaut est à
 *     confirmer par la recette T-01 (mesures 1/2/3 sur mobile et ordinateur) ;
 *     aucun gain n'est annoncé sans mesure.
 * Une erreur propre à un fichier n'arrête pas les autres. Un refus de droits
 * (essai terminé) arrête le lot : tous les fichiers seraient refusés.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IDEMPOTENCE (APP-PERF-30)
 *
 * Un identifiant d'opération (UUID) est tiré par fichier et présenté à
 * presign et à confirm. Une confirmation dont la réponse est perdue
 * (coupure, 5xx) est rejouée à l'identique : le serveur rend le document
 * existant. Jamais de rejeu aveugle sans cette clé.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * REPRISE APRÈS FERMETURE (PWA / NAVIGATEUR)
 *
 * La continuité d'un transfert quand iOS suspend ou ferme une PWA N'EST PAS
 * démontrée : aucune promesse d'envoi en arrière-plan. Ce qui est garanti :
 *   · l'état des fichiers non terminés (identifiant d'opération, nom,
 *     taille, empreinte, étapes franchies, métadonnées) est conservé dans le
 *     stockage local du navigateur, par utilisateur, 24 h (délai de purge
 *     serveur des dépôts non confirmés) — JAMAIS de jeton ni d'URL signée ;
 *   · au retour, un fichier transféré mais non confirmé se confirme sans
 *     renvoi ; sinon l'utilisateur resélectionne le fichier et le transfert
 *     reprend sur la même opération (aucun doublon).
 * Après confirmation, l'analyse ne dépend plus du client (file serveur T1).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { computeFileSha256, normalizeMimeType } from '@/lib/file-validation';
import { fetchDepot, messageSelonStatut } from '@/lib/upload-http';
import { parseWriteBlocked, notifyWriteBlocked } from '@/lib/write-blocked';
import { registerReloadBlocker } from '@/lib/pwa/chunk-recovery';
import { onSessionTransition } from '@/lib/session/session-lifecycle';

// ─── Types ─────────────────────────────────────────────────────────────────

export type EtapeDepot =
  | 'attente'       // en file, empreinte à calculer
  | 'preparation'   // empreinte en cours
  | 'pret'          // empreinte calculée, en attente d'un créneau de transfert
  | 'transfert'     // presign + PUT
  | 'confirmation'  // confirm
  | 'termine'
  | 'echec'
  | 'annule'
  | 'interrompu';   // restauré après fermeture : le fichier n'est plus en mémoire

/** Étape à laquelle une reprise redémarre. */
export type PointReprise = 'preparation' | 'presign' | 'confirmation';

export interface MetaConfirmation {
  assetId: number | null;
  substructureId: number | null;
  equipmentId: number | null;
  documentType: string | null;
  documentDate: string | null;
  description: string | null;
  supplier: string | null;
  amountCents: number | null;
}

export interface ElementDepot {
  operationId: string;
  lotId: string;
  nom: string;
  taille: number;
  mimeType: string;
  derniereModif: number;
  etape: EtapeDepot;
  /** Avancement de l'étape en cours (préparation ou transfert), 0 → 1. */
  progression: number;
  fileId: number | null;
  sha256: string | null;
  /** PUT terminé (ou serveur déjà COMPLETED). */
  transfere: boolean;
  /** `null` : non reprenable (refus définitif). */
  reprise: PointReprise | null;
  erreur: string | null;
  meta: MetaConfirmation;
  creeLe: number;
  /** Le `File` est en mémoire (faux après restauration). */
  fichierDisponible: boolean;
}

export interface BilanLot {
  lotId: string;
  /** Identifiants des documents confirmés (dans l'ordre du lot). */
  fileIds: number[];
  echecs: Array<{ nom: string; erreur: string }>;
  annules: number;
  ecritureBloquee: boolean;
  /** Confirmation tardive d'un fichier repris après la fin du lot. */
  tardif: boolean;
}

export interface InstantaneDepot {
  elements: ElementDepot[];
  /** Fichiers non terminés (attente → confirmation). */
  enCours: number;
}

/** Erreur d'un fichier, avec son point de reprise. */
export class ErreurDepot extends Error {
  constructor(message: string, readonly reprise: PointReprise | null, readonly ecritureBloquee = false) {
    super(message);
    this.name = 'ErreurDepot';
  }
}

export interface TransportDepot {
  hacher(file: File, signal: AbortSignal, onProgress: (f: number) => void): Promise<string>;
  presign(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  envoyer(url: string, file: File, mimeType: string, signal: AbortSignal, onProgress: (f: number) => void): Promise<void>;
  confirmer(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  attendre(ms: number, signal: AbortSignal): Promise<void>;
}

export interface StockageDepot {
  charger(): ElementPersiste[];
  enregistrer(elements: ElementPersiste[]): void;
}

export type ElementPersiste = Omit<ElementDepot, 'progression' | 'fichierDisponible' | 'erreur'>;

const ETAPES_ACTIVES: EtapeDepot[] = ['attente', 'preparation', 'pret', 'transfert', 'confirmation'];
const ETAPES_FINALES: EtapeDepot[] = ['termine', 'echec', 'annule', 'interrompu'];
/** Conservation de l'état local : délai de purge serveur des dépôts PENDING. */
export const DUREE_REPRISE_MS = 24 * 60 * 60 * 1000;

export function estActif(e: ElementDepot): boolean {
  return ETAPES_ACTIVES.includes(e.etape);
}

export function concurrenceTransfertsParDefaut(): number {
  const v = Number(process.env.NEXT_PUBLIC_UPLOAD_CONCURRENCY);
  return Number.isInteger(v) && v >= 1 ? Math.min(3, v) : 2;
}

export function nouvelIdentifiantOperation(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const o = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(o);
  else for (let i = 0; i < 16; i++) o[i] = Math.floor(Math.random() * 256);
  o[6] = (o[6] & 0x0f) | 0x40;
  o[8] = (o[8] & 0x3f) | 0x80;
  const h = Array.from(o, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const estAnnulation = (e: unknown) => (e as Error)?.name === 'AbortError';

function erreurAnnulation(): Error {
  const e = new Error('Upload annulé');
  e.name = 'AbortError';
  return e;
}

/** Lit le corps d'erreur ; un refus de droits ouvre la fenêtre de fin d'essai. */
async function erreurDeReponse(
  res: Response, repli: string, reprise: PointReprise | null,
): Promise<ErreurDepot> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string; code?: string };
  const refus = parseWriteBlocked(body);
  if (refus) {
    notifyWriteBlocked(refus);
    return new ErreurDepot(refus.message ?? 'Ajout de documents non autorisé.', null, true);
  }
  const msg = body.message || (typeof body.error === 'string' && !/^[A-Z_]+$/.test(body.error) ? body.error : '')
    || messageSelonStatut(res.status, repli);
  return new ErreurDepot(msg, reprise);
}

/** Réponse dont le résultat est INCONNU (le serveur a pu appliquer la demande). */
const resultatInconnu = (status: number) => status >= 500 || status === 408;

// ─── File ──────────────────────────────────────────────────────────────────

interface Lot {
  id: string;
  ids: string[];
  surFin?: (bilan: BilanLot) => void;
  notifie: boolean;
  ecritureBloquee: boolean;
}

export interface OptionsFile {
  transport: TransportDepot;
  concurrenceTransferts?: number;
  concurrencePreparations?: number;
  /** Tentatives de confirmation quand le résultat est inconnu. */
  tentativesConfirmation?: number;
}

export class FileDepot {
  private readonly transport: TransportDepot;
  readonly concurrenceTransferts: number;
  readonly concurrencePreparations: number;
  private readonly tentativesConfirmation: number;
  private stockage: StockageDepot | null = null;

  private ordre: string[] = [];
  private elements = new Map<string, ElementDepot>();
  private fichiers = new Map<string, File>();
  private controleurs = new Map<string, AbortController>();
  private lots = new Map<string, Lot>();
  private preparationsActives = 0;
  private transfertsActifs = 0;
  /** Pic observé (mesures de recette et tests). */
  picTransferts = 0;
  picPreparations = 0;

  private abonnes = new Set<() => void>();
  private instantane: InstantaneDepot = { elements: [], enCours: 0 };

  constructor(opts: OptionsFile) {
    this.transport = opts.transport;
    this.concurrenceTransferts = Math.max(1, opts.concurrenceTransferts ?? concurrenceTransfertsParDefaut());
    this.concurrencePreparations = Math.max(1, opts.concurrencePreparations ?? 1);
    this.tentativesConfirmation = Math.max(1, opts.tentativesConfirmation ?? 3);
  }

  // ── Abonnement (useSyncExternalStore) ──────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.abonnes.add(fn);
    return () => { this.abonnes.delete(fn); };
  };

  getSnapshot = (): InstantaneDepot => this.instantane;

  private publier(persister = true): void {
    const elements = this.ordre.map((id) => ({ ...this.elements.get(id)! }));
    this.instantane = { elements, enCours: elements.filter(estActif).length };
    if (persister) this.persister();
    for (const fn of this.abonnes) fn();
  }

  // ── Persistance (APP-PERF-29) ──────────────────────────────────────────

  /**
   * Associe la file au stockage d'un utilisateur et restaure ses dépôts non
   * terminés (étape « interrompu »). `null` : aucun stockage.
   */
  utiliserStockage(stockage: StockageDepot | null): void {
    this.stockage = stockage;
    if (!stockage) return;
    const maintenant = Date.now();
    let restaures = 0;
    for (const p of stockage.charger()) {
      if (!p?.operationId || this.elements.has(p.operationId)) continue;
      if (maintenant - (p.creeLe ?? 0) > DUREE_REPRISE_MS) continue;
      const reprise: PointReprise = p.transfere && p.fileId ? 'confirmation' : 'preparation';
      this.elements.set(p.operationId, {
        ...p,
        etape: 'interrompu',
        progression: 0,
        reprise,
        erreur: reprise === 'confirmation'
          ? 'Envoi interrompu avant son enregistrement.'
          : 'Envoi interrompu. Resélectionnez le fichier pour le reprendre.',
        fichierDisponible: false,
      });
      this.ordre.push(p.operationId);
      restaures += 1;
    }
    if (restaures > 0) this.publier(false);
  }

  private persister(): void {
    if (!this.stockage) return;
    const aGarder = this.ordre
      .map((id) => this.elements.get(id)!)
      .filter((e) => estActif(e) || e.etape === 'interrompu' || (e.etape === 'echec' && e.reprise !== null))
      .map(({ progression: _p, fichierDisponible: _f, erreur: _e, ...reste }) => reste);
    try { this.stockage.enregistrer(aGarder); } catch { /* stockage plein ou interdit : sans effet */ }
  }

  /**
   * Fin du contexte de session (déconnexion, session refusée, connexion,
   * changement de compte) — APP-PERF-21 CA-02, lot 24 #25.
   *
   * Rien de l'utilisateur précédent ne doit rester dans la file : ni
   * éléments affichés, ni fichiers en mémoire, ni bilans de lot à venir (qui
   * rattacheraient des documents sous la NOUVELLE session), ni transfert en
   * cours qui continuerait avec les cookies d'un autre compte.
   *
   * Le stockage est détaché AVANT l'annulation : l'état reprenable déjà
   * enregistré pour l'ancien utilisateur (`verebona:depots:<id>`) n'est pas
   * écrasé par « annulé » ; il sera proposé « interrompu » à SA prochaine
   * connexion — contrat explicite et isolé par utilisateur (aucun jeton,
   * aucune URL signée). Les tâches annulées qui se terminent ensuite
   * n'agissent que sur des objets détachés.
   */
  purger(): void {
    this.stockage = null;
    const controleurs = [...this.controleurs.values()];
    this.ordre = [];
    this.elements = new Map();
    this.fichiers = new Map();
    this.lots = new Map();
    this.controleurs = new Map();
    for (const c of controleurs) c.abort();
    this.publier(false);
  }

  // ── Commandes ──────────────────────────────────────────────────────────

  /** Ajoute un lot ; chaque fichier devient une opération indépendante. */
  ajouterLot(fichiers: File[], meta: MetaConfirmation, opts: { surFin?: (b: BilanLot) => void } = {}): string {
    const lotId = nouvelIdentifiantOperation();
    const ids: string[] = [];
    const seul = fichiers.length === 1;
    for (const file of fichiers) {
      const operationId = nouvelIdentifiantOperation();
      ids.push(operationId);
      this.fichiers.set(operationId, file);
      this.elements.set(operationId, {
        operationId, lotId,
        nom: file.name, taille: file.size, mimeType: normalizeMimeType(file), derniereModif: file.lastModified,
        etape: 'attente', progression: 0, fileId: null, sha256: null, transfere: false,
        reprise: null, erreur: null,
        // Titre, fournisseur et montant saisis ne valent que pour un dépôt
        // d'un seul fichier : sur plusieurs documents, ils seraient faux pour
        // tous sauf un. L'analyse les renseigne document par document.
        meta: seul ? meta : { ...meta, description: null, supplier: null, amountCents: null },
        creeLe: Date.now(),
        fichierDisponible: true,
      });
      this.ordre.push(operationId);
    }
    this.lots.set(lotId, { id: lotId, ids, surFin: opts.surFin, notifie: false, ecritureBloquee: false });
    this.publier();
    this.pomper();
    return lotId;
  }

  /** Annulation explicite d'un lot : en cours interrompus, aucun nouveau lancé. */
  annulerLot(lotId: string): void {
    const lot = this.lots.get(lotId);
    if (!lot) return;
    for (const id of lot.ids) this.annulerInterne(id);
    this.publier();
    this.verifierLots();
  }

  annuler(operationId: string): void {
    this.annulerInterne(operationId);
    this.publier();
    this.verifierLots();
  }

  private annulerInterne(operationId: string): void {
    const e = this.elements.get(operationId);
    if (!e || (!estActif(e) && e.etape !== 'echec' && e.etape !== 'interrompu')) return;
    this.controleurs.get(operationId)?.abort();
    e.etape = 'annule';
    e.reprise = null;
    e.erreur = null;
  }

  /** Retire un élément terminé, annulé, en échec ou abandonné. */
  retirer(operationId: string): void {
    const e = this.elements.get(operationId);
    if (!e || estActif(e)) return;
    this.elements.delete(operationId);
    this.fichiers.delete(operationId);
    this.ordre = this.ordre.filter((id) => id !== operationId);
    this.publier();
  }

  /** Retire tous les éléments terminés ou annulés. */
  retirerTermines(): void {
    for (const id of [...this.ordre]) {
      const e = this.elements.get(id)!;
      if (e.etape === 'termine' || e.etape === 'annule') {
        this.elements.delete(id);
        this.fichiers.delete(id);
      }
    }
    this.ordre = this.ordre.filter((id) => this.elements.has(id));
    this.publier();
  }

  /**
   * Reprend un fichier à son point de reprise. `fichier` : le fichier
   * resélectionné après une fermeture — il doit correspondre (nom, taille,
   * date) ; son empreinte est recalculée, et le serveur refuse l'opération
   * si le contenu a changé.
   */
  reprendre(operationId: string, fichier?: File): void {
    const e = this.elements.get(operationId);
    if (!e || e.reprise === null || estActif(e)) return;
    if (fichier) {
      if (fichier.name !== e.nom || fichier.size !== e.taille) {
        throw new ErreurDepot(`Ce n'est pas le même fichier (attendu : ${e.nom}).`, e.reprise);
      }
      this.fichiers.set(operationId, fichier);
      e.fichierDisponible = true;
      // Contenu à reprouver : nouvelle empreinte, même opération.
      if (e.reprise !== 'confirmation') { e.reprise = 'preparation'; e.sha256 = null; }
    }
    if (e.reprise !== 'confirmation' && !this.fichiers.has(operationId)) {
      throw new ErreurDepot('Resélectionnez le fichier pour reprendre son envoi.', e.reprise);
    }
    if (e.reprise === 'preparation') { e.etape = 'attente'; e.sha256 = null; e.transfere = false; }
    else if (e.reprise === 'presign') { e.etape = 'pret'; e.transfere = false; }
    else { e.etape = 'pret'; }
    e.erreur = null;
    e.progression = 0;
    this.publier();
    this.pomper();
  }

  // ── Ordonnancement ─────────────────────────────────────────────────────

  private pomper(): void {
    for (const id of this.ordre) {
      const e = this.elements.get(id)!;
      if (e.etape === 'attente' && this.preparationsActives < this.concurrencePreparations) {
        void this.preparer(e);
      }
    }
    for (const id of this.ordre) {
      const e = this.elements.get(id)!;
      if (e.etape === 'pret' && this.transfertsActifs < this.concurrenceTransferts) {
        void this.transferer(e);
      }
    }
  }

  private controleur(e: ElementDepot): AbortController {
    const c = new AbortController();
    this.controleurs.set(e.operationId, c);
    return c;
  }

  private progression(e: ElementDepot, f: number): void {
    const v = Math.max(0, Math.min(1, f));
    if (v - e.progression >= 0.01 || (v === 1 && e.progression !== 1)) {
      e.progression = v;
      this.publier(false);
    }
  }

  private async preparer(e: ElementDepot): Promise<void> {
    const file = this.fichiers.get(e.operationId);
    if (!file) { this.echouer(e, new ErreurDepot('Resélectionnez le fichier pour reprendre son envoi.', 'preparation')); return; }
    this.preparationsActives += 1;
    this.picPreparations = Math.max(this.picPreparations, this.preparationsActives);
    e.etape = 'preparation';
    e.progression = 0;
    this.publier(false);
    const c = this.controleur(e);
    try {
      const sha = await this.transport.hacher(file, c.signal, (f) => this.progression(e, f));
      if (c.signal.aborted) throw erreurAnnulation();
      e.sha256 = sha;
      e.etape = 'pret';
      e.progression = 0;
    } catch (err) {
      if (estAnnulation(err) || c.signal.aborted) e.etape = 'annule';
      else this.echouer(e, new ErreurDepot((err as Error)?.message || "Impossible de calculer l'empreinte du fichier.", 'preparation'), false);
    } finally {
      this.preparationsActives -= 1;
      this.publier();
      this.verifierLots();
      this.pomper();
    }
  }

  private async transferer(e: ElementDepot): Promise<void> {
    this.transfertsActifs += 1;
    this.picTransferts = Math.max(this.picTransferts, this.transfertsActifs);
    const c = this.controleur(e);
    try {
      await this.cycle(e, c.signal);
      e.etape = 'termine';
      e.reprise = null;
      e.erreur = null;
      e.progression = 1;
      this.fichiers.delete(e.operationId);
    } catch (err) {
      if (estAnnulation(err) || c.signal.aborted) {
        e.etape = 'annule';
      } else {
        const ed = err instanceof ErreurDepot ? err : new ErreurDepot((err as Error)?.message || "Erreur lors de l'ajout du document", 'presign');
        this.echouer(e, ed, false);
        if (ed.ecritureBloquee) {
          // Tous les fichiers du lot seraient refusés : on n'en lance plus.
          const lot = this.lots.get(e.lotId);
          if (lot) lot.ecritureBloquee = true;
          for (const id of lot?.ids ?? []) if (id !== e.operationId) this.annulerInterne(id);
        }
      }
    } finally {
      this.transfertsActifs -= 1;
      this.controleurs.delete(e.operationId);
      this.publier();
      const lot = this.lots.get(e.lotId);
      if (lot?.notifie && e.etape === 'termine' && e.fileId !== null) {
        // Reprise après la fin du lot : bilan tardif pour ce seul fichier.
        lot.surFin?.({ lotId: lot.id, fileIds: [e.fileId], echecs: [], annules: 0, ecritureBloquee: false, tardif: true });
      }
      this.verifierLots();
      this.pomper();
    }
  }

  /** presign → PUT → confirm, à partir de l'étape déjà franchie. */
  private async cycle(e: ElementDepot, signal: AbortSignal): Promise<void> {
    let relances = 0;
    for (;;) {
      if (!e.transfere) {
        const file = this.fichiers.get(e.operationId);
        if (!file || !e.sha256) throw new ErreurDepot('Resélectionnez le fichier pour reprendre son envoi.', 'preparation');
        e.etape = 'transfert';
        e.progression = 0;
        this.publier();
        const pre = await this.presign(e, signal);
        e.fileId = pre.fileId;
        this.publier(); // identifiant conservé avant le transfert (reprise)
        if (pre.uploadStatus !== 'COMPLETED') {
          if (!pre.uploadUrl) throw new ErreurDepot('Réponse de préparation incomplète.', 'presign');
          try {
            await this.transport.envoyer(pre.uploadUrl, file, e.mimeType, signal, (f) => this.progression(e, f));
          } catch (err) {
            if (estAnnulation(err) || signal.aborted) throw erreurAnnulation();
            throw err instanceof ErreurDepot ? err : new ErreurDepot(`${e.nom} : ${(err as Error)?.message}`, 'presign');
          }
        }
        e.transfere = true;
        this.publier();
      }
      e.etape = 'confirmation';
      this.publier();
      try {
        await this.confirmer(e, signal);
        return;
      } catch (err) {
        // Objet absent du stockage : le transfert est rejoué une fois sur la
        // même opération (nouvelle URL, même document).
        if (err instanceof ErreurObjetAbsent && relances === 0 && this.fichiers.has(e.operationId)) {
          relances += 1;
          e.transfere = false;
          continue;
        }
        throw err instanceof ErreurObjetAbsent ? new ErreurDepot(err.message, 'presign') : err;
      }
    }
  }

  private async presign(e: ElementDepot, signal: AbortSignal): Promise<{ fileId: number; uploadUrl?: string; uploadStatus?: string }> {
    const body = {
      filename: e.nom,
      mimeType: e.mimeType,
      size: e.taille,
      sha256Hash: e.sha256,
      assetId: e.meta.assetId,
      operationId: e.operationId,
    };
    // Débit de préparation limité côté serveur (429) : attente de la fenêtre
    // suivante puis nouvelle tentative — sûre, la demande est idempotente.
    for (let essai = 0; ; essai++) {
      const res = await this.transport.presign(body, signal);
      if (res.ok) return res.json();
      if (res.status === 429 && essai < 2) {
        const b = (await res.json().catch(() => ({}))) as { resetAt?: number };
        const attente = Math.min(60_000, Math.max(1_000, (Number(b.resetAt) || Date.now() + 5_000) - Date.now()));
        await this.transport.attendre(attente, signal);
        continue;
      }
      const reprenable = res.status === 429 || res.status === 401 || res.status >= 500;
      throw await erreurDeReponse(res, `${e.nom} : échec de la préparation du téléchargement`, reprenable ? 'presign' : null);
    }
  }

  private async confirmer(e: ElementDepot, signal: AbortSignal): Promise<void> {
    const body = {
      fileId: e.fileId,
      operationId: e.operationId,
      assetId: e.meta.assetId,
      substructureId: e.meta.substructureId,
      equipmentId: e.meta.equipmentId,
      documentType: e.meta.documentType,
      documentDate: e.meta.documentDate,
      description: e.meta.description,
      supplier: e.meta.supplier,
      amountCents: e.meta.amountCents,
    };
    let derniere = '';
    for (let essai = 0; essai < this.tentativesConfirmation; essai++) {
      if (essai > 0) await this.transport.attendre(1_000 * 2 ** (essai - 1), signal);
      let res: Response;
      try {
        res = await this.transport.confirmer(body, signal);
      } catch (err) {
        if (estAnnulation(err) || signal.aborted) throw erreurAnnulation();
        // Coupure : le serveur a pu confirmer. Rejeu idempotent (même clé).
        derniere = (err as Error)?.message ?? '';
        continue;
      }
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { file?: { id?: number } };
        if (data.file?.id) e.fileId = data.file.id;
        return;
      }
      if (resultatInconnu(res.status)) {
        derniere = messageSelonStatut(res.status, `${e.nom} : échec de l'enregistrement`);
        continue;
      }
      if (res.status === 409) {
        const b = (await res.clone().json().catch(() => ({}))) as { code?: string; error?: string };
        if (b.code === 'OBJECT_MISSING') throw new ErreurObjetAbsent(b.error || `${e.nom} : le fichier n’a pas été reçu par le stockage.`);
      }
      throw await erreurDeReponse(res, `${e.nom} : échec de l'enregistrement`, res.status === 401 ? 'confirmation' : null);
    }
    throw new ErreurDepot(
      `${e.nom} : enregistrement non confirmé (${derniere || 'réponse perdue'}). « Reprendre » vérifie l'état sans renvoyer le fichier.`,
      'confirmation',
    );
  }

  private echouer(e: ElementDepot, err: ErreurDepot, publier = true): void {
    e.etape = 'echec';
    e.reprise = err.reprise;
    e.erreur = err.message;
    if (publier) this.publier();
  }

  /** Bilan d'un lot quand tous ses fichiers sont terminés (une fois). */
  private verifierLots(): void {
    for (const lot of this.lots.values()) {
      if (lot.notifie) continue;
      const els = lot.ids.map((id) => this.elements.get(id)).filter((x): x is ElementDepot => !!x);
      if (els.some((x) => !ETAPES_FINALES.includes(x.etape))) continue;
      lot.notifie = true;
      lot.surFin?.({
        lotId: lot.id,
        fileIds: els.filter((x) => x.etape === 'termine' && x.fileId !== null).map((x) => x.fileId as number),
        echecs: els.filter((x) => x.etape === 'echec').map((x) => ({ nom: x.nom, erreur: x.erreur ?? '' })),
        annules: els.filter((x) => x.etape === 'annule').length,
        ecritureBloquee: lot.ecritureBloquee,
        tardif: false,
      });
    }
  }

  /** Éléments d'un lot (dialogue : progression du dépôt qu'il a lancé). */
  elementsDuLot(lotId: string): ElementDepot[] {
    return this.instantane.elements.filter((e) => e.lotId === lotId);
  }
}

class ErreurObjetAbsent extends Error {}

// ─── Transport navigateur ──────────────────────────────────────────────────

/** Délai sans progression avant d'abandonner un transfert (pas de plafond total). */
const INACTIVITE_TRANSFERT_MS = 60_000;

/**
 * PUT vers l'URL signée par XHR : seule API navigateur qui donne la
 * progression d'un envoi. Le corps est le `File` lui-même (lu en flux par
 * le navigateur, aucune copie en mémoire JavaScript).
 */
export function envoyerXhr(
  url: string, file: File, mimeType: string, signal: AbortSignal, onProgress: (f: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(erreurAnnulation()); return; }
    const xhr = new XMLHttpRequest();
    let minuterie: ReturnType<typeof setTimeout> | undefined;
    const armer = () => {
      if (minuterie) clearTimeout(minuterie);
      minuterie = setTimeout(() => {
        xhr.abort();
        nettoyer();
        reject(new ErreurDepot(`${file.name} : transfert interrompu (aucune progression depuis une minute).`, 'presign'));
      }, INACTIVITE_TRANSFERT_MS);
    };
    const surAnnulation = () => { xhr.abort(); nettoyer(); reject(erreurAnnulation()); };
    const nettoyer = () => { if (minuterie) clearTimeout(minuterie); signal.removeEventListener('abort', surAnnulation); };
    signal.addEventListener('abort', surAnnulation);
    xhr.upload.onprogress = (ev) => { armer(); if (ev.lengthComputable && ev.total > 0) onProgress(ev.loaded / ev.total); };
    xhr.onload = () => {
      nettoyer();
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(1); resolve(); return; }
      reject(new ErreurDepot(
        `${file.name} : le stockage a refusé le fichier (${xhr.status}).` + (xhr.status === 403 ? ' Réessayez.' : ''),
        'presign',
      ));
    };
    // Une erreur réseau nue sur le stockage signale une coupure ou une
    // origine non autorisée sur le bucket (CORS).
    xhr.onerror = () => { nettoyer(); reject(new ErreurDepot(`${file.name} : le stockage a refusé le fichier (réseau ou CORS).`, 'presign')); };
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', mimeType);
    armer();
    xhr.send(file);
  });
}

function attendre(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(erreurAnnulation()); return; }
    const t = setTimeout(() => { signal.removeEventListener('abort', annuler); resolve(); }, ms);
    const annuler = () => { clearTimeout(t); reject(erreurAnnulation()); };
    signal.addEventListener('abort', annuler, { once: true });
  });
}

const json = (body: Record<string, unknown>, signal: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal,
});

export const transportNavigateur: TransportDepot = {
  hacher: (file, signal, onProgress) => computeFileSha256(file, { signal, onProgress }),
  presign: (body, signal) => fetchDepot('/api/files/presign', json(body, signal)),
  envoyer: envoyerXhr,
  confirmer: (body, signal) => fetchDepot('/api/files/confirm', json(body, signal)),
  attendre,
};

/** Stockage local par utilisateur (aucun jeton, aucune URL signée). */
export function stockageLocal(userId: number | string): StockageDepot {
  const cle = `verebona:depots:${userId}`;
  return {
    charger() {
      try {
        const brut = globalThis.localStorage?.getItem(cle);
        const v = brut ? JSON.parse(brut) : [];
        return Array.isArray(v) ? v : [];
      } catch { return []; }
    },
    enregistrer(elements) {
      try {
        if (elements.length === 0) globalThis.localStorage?.removeItem(cle);
        else globalThis.localStorage?.setItem(cle, JSON.stringify(elements));
      } catch { /* stockage indisponible (navigation privée) : sans reprise */ }
    },
  };
}

/** Nom de la garde de rechargement déclarée par la file (APP-PERF-10/29). */
export const GARDE_RECHARGEMENT_DEPOT = 'envoi';

/**
 * Déclare la file comme garde contre le rechargement AUTOMATIQUE de la
 * reprise PWA (`lib/pwa/chunk-recovery`) : tant qu'un fichier est actif
 * (préparation → confirmation), une erreur de chunk ou une nouvelle version
 * ne recharge pas la page — la reprise est PROPOSÉE avec l'avertissement
 * « un envoi est en cours ». Un fichier interrompu ou en échec ne bloque
 * pas : son état est déjà conservé (stockage local) et reprenable.
 * Retourne la fonction de retrait.
 */
export function declarerGardeRechargement(file: FileDepot): () => void {
  return registerReloadBlocker(GARDE_RECHARGEMENT_DEPOT, () => file.getSnapshot().enCours > 0);
}

/** File unique de l'application (navigateur). */
export const fileDepot = new FileDepot({ transport: transportNavigateur });
declarerGardeRechargement(fileDepot);
// Toute transition de session vide la file (voir `purger`) ; l'indicateur
// rattache ensuite le stockage du nouvel utilisateur (`utiliserStockage`).
onSessionTransition(() => fileDepot.purger());
