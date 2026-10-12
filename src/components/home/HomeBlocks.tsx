"use client"
/**
 * Blocs de l'accueil — Mes biens, Prochaines échéances, Ce que j'ai fait,
 * Documents récents, et leurs états « compte vide » (§12ter).
 *
 * ── LOT 36 (maquette « Accueil - Propositions », direction 2a/2b « Fil
 * encadré ») ─────────────────────────────────────────────────────────────────
 * Une seule colonne, chaque section dans une CARTE BORDÉE (`HomeSection`) :
 * titre en petites capitales espacées (h2) à gauche, lien à droite (libellé
 * court sur mobile). Mêmes composants sur desktop et mobile ; seules les
 * dimensions changent. Les listes horizontales (biens, documents) passent
 * par `HomeCarousel` : défilement tactile calé, flèches précédent/suivant sur
 * desktop quand le contenu déborde, navigation au clavier (flèches gauche /
 * droite sur la liste, Tab sur chaque carte). Couleurs : variables des deux
 * thèmes uniquement (sombre et beige).
 */
import Link from 'next/link';
import { Children, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Download, FileText, Folder, House, Package } from 'lucide-react';
import { getAssetIcon } from '@/lib/asset-icons';
import { useThumbnailUrl } from '@/hooks/useThumbnailUrl';
import { openDrawer } from '@/lib/drawers';
import { relativeAgo, type HomeRecentDocument, type HomeUpcomingItem, type VerebonaWorkItem } from '@/services/home/home-blocks';
import type { HomeAsset } from '@/services/home/HomeSummaryService';

/** Biens montrés dans le carrousel de l'accueil (au-delà : « Tous les biens »). */
export const HOME_ASSETS_MAX = 12;

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]';

// ── Carte de section ────────────────────────────────────────────────────────

/** Lien d'en-tête : libellé long sur desktop, court sur mobile. */
export interface SectionLink { href: string; label: string; short?: string }

/**
 * Carte bordée d'une section (maquette 2a) : fond carte, bordure, rayon
 * 14 px ; en-tête = titre h2 en petites capitales espacées + lien.
 */
export function HomeSection({ id, title, link, children, className = '', bodyClassName = '' }: {
  id: string; title: string; link?: SectionLink | null; children: ReactNode; className?: string; bodyClassName?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      data-home-section={id}
      className={`flex min-w-0 flex-col rounded-[14px] border border-[color:var(--border)] bg-[color:var(--bg-card)] p-4 md:px-6 md:pb-6 md:pt-5 ${className}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="m-0 text-[11px] font-semibold uppercase tracking-[.05em] text-[color:var(--text-muted)]">{title}</h2>
        {link && (
          <Link href={link.href} className={`flex-shrink-0 rounded text-[13px] font-medium text-[color:var(--accent)] hover:underline underline-offset-2 ${FOCUS_RING}`}>
            {link.short && link.short !== link.label
              ? <><span className="md:hidden">{link.short}</span><span className="hidden md:inline">{link.label}</span></>
              : link.label}
          </Link>
        )}
      </div>
      <div className={`flex min-w-0 flex-col ${bodyClassName}`}>{children}</div>
    </section>
  );
}

// ── Carrousel ───────────────────────────────────────────────────────────────

/**
 * Liste horizontale calée au défilement. Flèches (desktop) visibles seulement
 * quand le contenu déborde, désactivées en bout de course ; la liste elle-même
 * est focalisable et répond aux flèches gauche / droite. Les éléments sont
 * des `<li>` fournis par l'appelant.
 */
export function HomeCarousel({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ prev: false, next: false });
  const count = Children.count(children);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const prev = el.scrollLeft > 4;
    const next = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setEdges((e) => (e.prev === prev && e.next === next ? e : { prev, next }));
  }, []);

  useEffect(() => {
    update();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update, count]);

  const scroll = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.8, 160), behavior: reduced ? 'auto' : 'smooth' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); scroll(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); scroll(-1); }
  };

  const overflow = edges.prev || edges.next;
  const arrow = `absolute top-1/2 z-[2] hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-[color:var(--border)] bg-[color:var(--bg-card)] text-[color:var(--text-primary)] shadow-relief-md backdrop-blur-sm transition-opacity disabled:pointer-events-none disabled:opacity-0 ${FOCUS_RING} ${overflow ? 'md:flex' : ''}`;

  return (
    <div className={`relative ${className}`} data-carousel={label}>
      <button type="button" aria-label={`${label} : précédents`} disabled={!edges.prev} onClick={() => scroll(-1)} className={`${arrow} left-1`}>
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </button>
      <button type="button" aria-label={`${label} : suivants`} disabled={!edges.next} onClick={() => scroll(1)} className={`${arrow} right-1`}>
        <ChevronRight className="h-4 w-4" aria-hidden />
      </button>
      {/* Liste défilante focalisable : défilement au clavier (flèches). */}
      <ul
        ref={ref}
        aria-label={label}
        tabIndex={0}
        onScroll={update}
        onKeyDown={onKeyDown}
        className={`m-0 flex list-none snap-x snap-mandatory gap-2.5 overflow-x-auto rounded-xl p-0 vb-no-scrollbar md:gap-3 ${FOCUS_RING}`}
      >
        {children}
      </ul>
    </div>
  );
}

// ── Carte de bien ───────────────────────────────────────────────────────────

/**
 * Carte image (maquette 2a) : photo plein cadre, dégradé de protection, nom
 * en blanc et nombre de documents (desktop). Sans photo : tuile dégradée
 * avec l'icône de la catégorie. 204 × 140 desktop, 150 × 104 mobile.
 */
export function HomeAssetCard({ asset, className = '', priority = false }: { asset: HomeAsset; className?: string; priority?: boolean }) {
  const Icon = getAssetIcon(asset.category, asset.subtype ?? undefined, asset.name);
  const { signedUrl } = useThumbnailUrl(asset.signedThumbnailUrl ? null : asset.id, asset.signedThumbnailUrl ? null : asset.thumbnailUrl);
  const photo = asset.signedThumbnailUrl ?? signedUrl;
  const docs = `${asset.documentCount} document${asset.documentCount > 1 ? 's' : ''}`;
  return (
    <Link
      href={`/assets/${asset.id}`}
      aria-label={`${asset.name}, ${docs}`}
      className={`group relative block overflow-hidden rounded-xl border border-[color:var(--border-subtle)] transition-shadow duration-200 hover:shadow-relief-lg ${FOCUS_RING} ${className}`}
      style={{ background: 'var(--tile-empty)' }}
    >
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- URL signée S3, dimension libre
        <img src={photo} alt="" loading={priority ? 'eager' : 'lazy'} className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center pb-6">
          <Icon className="h-8 w-8 text-white/25" aria-hidden />
        </span>
      )}
      <span className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(0,0,0,.85), rgba(0,0,0,.25) 50%, rgba(0,0,0,.1))' }} aria-hidden />
      {/* Lot 32 (L32-10) : plus de pastille « N actions à faire » — les
          actions vivent dans « À traiter ». */}
      <span className="absolute inset-x-3 bottom-2.5 flex items-baseline justify-between gap-2 md:inset-x-3.5 md:bottom-3" aria-hidden>
        <span className="min-w-0 truncate text-[13px] font-semibold text-white md:text-[15px]">{asset.name}</span>
        <span className="hidden flex-shrink-0 text-[11px] text-white/75 md:inline">{asset.documentCount} doc.</span>
      </span>
    </Link>
  );
}

// ── Mes biens ───────────────────────────────────────────────────────────────

const EMPTY_ASSET_KINDS = [
  { key: 'logement', label: 'Une maison ou un appartement', short: 'Logement', icon: House },
  { key: 'vehicule', label: 'Un véhicule', short: 'Véhicule', icon: Package },
  { key: 'objet', label: 'Un objet de valeur', short: 'Objet', icon: Folder },
];

/** Mes biens : carrousel dans l'ordre « récemment consultés » reçu. */
export function HomeAssets({ assets, onAddAsset, className = '' }: { assets: HomeAsset[]; onAddAsset: () => void; className?: string }) {
  const empty = assets.length === 0;
  return (
    <HomeSection
      id="home-biens"
      title="Mes biens"
      link={empty ? null : { href: '/assets', label: 'Tous les biens', short: 'Tous' }}
      className={className}
      bodyClassName="mt-3 md:mt-4"
    >
      {empty ? (
        <div className="flex flex-col gap-2 md:gap-3">
          <p className="m-0 max-w-[620px] text-[13px] leading-normal text-[color:var(--muted-foreground)] md:text-[14px]">
            <span className="md:hidden">Aucun bien pour l’instant. Que voulez-vous suivre en premier ?</span>
            <span className="hidden md:inline">Aucun bien pour l’instant. Commencez par ce qui compte le plus : je créerai la fiche et vous indiquerai les documents utiles à rassembler.</span>
          </p>
          <div className="grid grid-cols-3 gap-2 md:gap-3">
            {EMPTY_ASSET_KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                onClick={onAddAsset}
                className={`flex min-h-[104px] flex-col items-start justify-between gap-2.5 rounded-xl border border-dashed border-[color:var(--border)] p-3 text-left text-[color:var(--text-primary)] transition-colors duration-150 hover:border-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] md:min-h-[124px] md:px-4 md:py-3.5 ${FOCUS_RING}`}
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[color:var(--accent-soft)] text-[color:var(--accent)]">
                  <k.icon className="h-[17px] w-[17px]" aria-hidden />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-[14px] font-semibold"><span className="md:hidden">{k.short}</span><span className="hidden md:inline">{k.label}</span></span>
                  <span className="text-[12.5px] font-medium text-[color:var(--accent)]">Ajouter</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <HomeCarousel label="Mes biens">
          {assets.slice(0, HOME_ASSETS_MAX).map((a, i) => (
            <li key={a.id} className="flex-shrink-0 snap-start">
              <HomeAssetCard asset={a} priority={i === 0} className="h-[104px] w-[150px] md:h-[140px] md:w-[204px]" />
            </li>
          ))}
        </HomeCarousel>
      )}
    </HomeSection>
  );
}

// ── Prochaines échéances ────────────────────────────────────────────────────

/** Urgence (calculée par le résumé) : rouge en retard, amber proche, vert plus tard. */
const UPCOMING_TONES: Record<HomeUpcomingItem['tone'], { bg: string; fg: string; edge: string }> = {
  red: { bg: 'var(--wash-red)', fg: 'var(--on-red)', edge: 'color-mix(in srgb, var(--vb-red-500) 30%, transparent)' },
  amber: { bg: 'var(--wash-amber)', fg: 'var(--on-amber)', edge: 'var(--edge-amber)' },
  green: { bg: 'var(--wash-green)', fg: 'var(--on-green)', edge: 'color-mix(in srgb, var(--vb-green-500) 30%, transparent)' },
};

/**
 * Lignes d'échéance : pastille de date (jour + mois abrégé, couleur
 * d'urgence), titre en gras, bien dessous, délai à droite. Un clic ouvre la
 * fiche de l'échéance en tiroir. Desktop : 3 lignes ; mobile : 2.
 */
export function UpcomingEvents({ items, className = '' }: { items: HomeUpcomingItem[]; className?: string }) {
  return (
    <HomeSection id="home-echeances" title="Prochaines échéances" link={{ href: '/agenda', label: 'Mon agenda', short: 'Agenda' }} className={className} bodyClassName="mt-1.5 md:mt-2">
      {items.length === 0 ? (
        <p className="m-0 py-2 text-[13px] leading-normal text-[color:var(--muted-foreground)] md:text-[13.5px]">
          Aucune échéance pour l’instant. Elles apparaîtront ici dès que je les aurai lues dans vos documents.
        </p>
      ) : (
        <ul className="m-0 -mx-2 flex list-none flex-col p-0">
          {items.slice(0, 3).map((e, i) => {
            const tone = UPCOMING_TONES[e.tone];
            return (
              <li key={e.id} className={i >= 2 ? 'hidden md:block' : ''}>
                <button
                  type="button"
                  onClick={() => openDrawer({ kind: 'echeance', id: e.id })}
                  className={`flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors duration-150 hover:bg-[color:var(--accent-soft)] md:gap-3.5 md:py-2 ${FOCUS_RING}`}
                >
                  <span
                    className="flex h-11 w-11 flex-shrink-0 flex-col items-center justify-center rounded-[10px] border leading-none md:h-12 md:w-12"
                    style={{ background: tone.bg, color: tone.fg, borderColor: tone.edge }}
                    aria-hidden
                  >
                    <span className="text-[15px] font-bold md:text-[17px]">{e.day}</span>
                    <span className="mt-[3px] text-[9px] font-bold uppercase tracking-[.05em]">{e.month}</span>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="line-clamp-2 text-[13px] font-semibold leading-[1.35] text-[color:var(--text-primary)] md:text-[14px]">{e.title}</span>
                    {e.assetName && <span className="truncate text-[12px] text-[color:var(--text-muted)]">{e.assetName}</span>}
                  </span>
                  <span className="flex-shrink-0 whitespace-nowrap text-[12px] font-semibold" style={{ color: tone.fg }}>{e.rel}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </HomeSection>
  );
}

// ── Ce que j'ai fait ────────────────────────────────────────────────────────

const WORK_DOTS: Record<VerebonaWorkItem['tone'], string> = {
  blue: 'var(--vb-blue-500)',
  green: 'var(--vb-green-500)',
  violet: 'var(--vb-violet-500)',
  amber: 'var(--vb-amber-500)',
};

function openWork(w: VerebonaWorkItem, push: (href: string) => void) {
  const t = w.target;
  if (t.kind === 'agenda') openDrawer({ kind: 'echeance', id: t.id });
  else if (t.kind === 'document') openDrawer({ kind: 'document', id: t.id });
  else if (t.tab) push(`/assets/${t.assetId}?tab=${t.tab}`);
  else push(`/assets/${t.assetId}?tab=details${t.fieldKey ? `&highlight=${encodeURIComponent(t.fieldKey)}` : ''}`);
}

/**
 * Ce que j'ai fait : libellé du jour (« Aujourd'hui », « Hier »…) puis une
 * liste à puces ; un nouveau libellé à chaque changement de jour. Toute la
 * ligne ouvre l'élément (document, échéance, fiche du bien).
 */
export function VerebonaWork({ items, onNavigate, className = '' }: { items: VerebonaWorkItem[]; onNavigate: (href: string) => void; className?: string }) {
  const now = new Date();
  const shown = items.slice(0, 3);
  return (
    <HomeSection
      id="home-fait"
      title="Ce que j’ai fait"
      link={{ href: '/mon-compte/enrichissements', label: 'Toute l’activité', short: 'Tout' }}
      className={className}
      bodyClassName="mt-1"
    >
      {shown.length === 0 ? (
        <p className="m-0 py-2 text-[13px] leading-normal text-[color:var(--muted-foreground)] md:text-[13.5px]">
          Rien pour l’instant. Dès votre premier document, je vous montrerai ici ce que j’ai lu, complété et rattaché à vos biens.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {shown.map((w, i) => {
            const day = relativeAgo(w.at, now);
            const newDay = i === 0 || relativeAgo(shown[i - 1].at, now) !== day;
            return (
              <li key={w.id} className="block">
                {newDay && <span className="block pb-1 pt-2 text-[12px] font-medium text-[color:var(--text-muted)]">{day}</span>}
                {/* Bouton natif : atteint au clavier (Tab), activé par Entrée /
                    Espace ; le libellé d'action est annoncé aux lecteurs d'écran. */}
                <button
                  type="button"
                  onClick={() => openWork(w, onNavigate)}
                  aria-label={`${w.text} — ${w.cta}`}
                  className={`group -mx-2 flex w-[calc(100%+1rem)] gap-3 rounded-lg px-2 py-1 text-left transition-colors hover:bg-[color:var(--accent-soft)] focus-visible:bg-[color:var(--accent-soft)] ${FOCUS_RING}`}
                >
                  <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full" style={{ background: WORK_DOTS[w.tone] }} aria-hidden />
                  <span className="min-w-0 flex-1 text-[13px] leading-normal text-[color:var(--text-primary)] [text-wrap:pretty] group-hover:text-[color:var(--accent)]">{w.text}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </HomeSection>
  );
}

// ── Documents récents ───────────────────────────────────────────────────────

const DOC_TONES: Record<HomeRecentDocument['tone'], { bg: string; fg: string }> = {
  slate: { bg: 'var(--wash-slate)', fg: 'var(--text-muted)' },
  green: { bg: 'var(--wash-green)', fg: 'var(--on-green)' },
  blue: { bg: 'var(--wash-blue)', fg: 'var(--on-blue)' },
  violet: { bg: 'var(--wash-violet)', fg: 'var(--on-violet)' },
  amber: { bg: 'var(--wash-amber)', fg: 'var(--on-amber)' },
};

const formatDay = (iso: string | null) => {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
};

function StatusBadge({ label }: { label: string }) {
  return (
    // Fond opaque (lavis amber sur le fond de page) : lisible sur une miniature.
    <span className="whitespace-nowrap rounded-full border px-2 py-[3px] text-[10px] font-semibold" style={{ background: 'color-mix(in srgb, var(--vb-amber-500) 16%, var(--bg-page))', color: 'var(--on-amber)', borderColor: 'var(--edge-amber)' }}>
      {label}
    </span>
  );
}

/**
 * Aperçu d'un document récent (lot 26, point 16) — mêmes conventions que les
 * vignettes de « Mes documents » : miniature SERVEUR (jamais l'original),
 * chargement paresseux, décodage asynchrone, repli sur l'icône. L'URL vient
 * du résumé (signée, stable pendant l'heure) : aucune requête par carte vers
 * l'application. Si elle n'est plus lisible, un essai par la route autorisée
 * `/api/files/:id/thumbnail` (re-signature), puis l'icône. Pas de rendu PDF
 * dans le navigateur ici.
 *
 * Lot 36 : une seule vignette par document (desktop et mobile), plein cadre,
 * dans le carrousel ; `loading="lazy"` : les cartes hors champ ne sont
 * chargées qu'à l'approche.
 */
export function RecentDocPreview({ doc }: { doc: HomeRecentDocument }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const tone = DOC_TONES[doc.tone];
  const src = !doc.previewUrl ? null : step === 0 ? doc.previewUrl : step === 1 ? `/api/files/${doc.id}/thumbnail` : null;
  return (
    <span className="absolute inset-0 flex items-start justify-center" style={{ background: src ? '#fff' : tone.bg }}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- miniature autorisée (APP-PERF-06), icône si absente
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setStep((x) => (x === 0 ? 1 : 2))} className="absolute inset-0 h-full w-full object-cover object-top" />
      ) : (
        <span className="mt-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[color:var(--bg-card)] md:mt-5" style={{ color: tone.fg }}>
          <FileText className="h-[18px] w-[18px]" aria-hidden />
        </span>
      )}
    </span>
  );
}

/**
 * Documents récents : carrousel de vignettes (nom, bien · date). Desktop :
 * 4 vignettes sur la largeur de la carte ; mobile : 3 visibles, la suite au
 * défilement. Vide : la zone de dépôt (ajout de document conservé).
 */
export function RecentDocuments({ docs, onUpload, className = '' }: { docs: HomeRecentDocument[]; onUpload: () => void; className?: string }) {
  const open = (d: HomeRecentDocument) => openDrawer({ kind: 'document', id: d.id });
  return (
    <HomeSection
      id="home-docs"
      title="Documents récents"
      link={docs.length > 0 ? { href: '/documents', label: 'Tous' } : null}
      className={className}
      bodyClassName="mt-3"
    >
      {docs.length === 0 ? (
        <button
          type="button"
          onClick={onUpload}
          className={`flex min-h-[76px] items-center gap-3.5 rounded-xl border-[1.5px] border-dashed border-[color:var(--border)] px-4 py-3.5 text-left text-[color:var(--text-primary)] transition-colors hover:border-[color:var(--accent)] md:gap-5 md:px-5 md:py-[18px] ${FOCUS_RING}`}
          style={{ background: 'color-mix(in srgb, var(--accent) 4%, transparent)' }}
        >
          <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[14px] bg-[color:var(--accent-soft)] text-[color:var(--accent)] md:h-[52px] md:w-[52px] md:rounded-2xl">
            <Download className="h-5 w-5 md:h-[22px] md:w-[22px]" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:gap-1">
            <span className="text-[14px] font-semibold md:text-[15px]">
              <span className="md:hidden">Déposer un premier document</span>
              <span className="hidden md:inline">Déposez une facture, un contrat, une garantie ou une notice</span>
            </span>
            <span className="text-[12px] text-[color:var(--muted-foreground)] md:text-[13px]">
              <span className="md:hidden">Photo, PDF, facture, contrat…</span>
              <span className="hidden md:inline">Je la lis, j’en extrais les informations utiles et je la rattache au bon bien.</span>
            </span>
          </span>
          <span className="hidden h-9 items-center whitespace-nowrap rounded-full bg-[color:var(--accent)] px-4 text-[13px] font-semibold text-white md:inline-flex">
            Déposer un document
          </span>
        </button>
      ) : (
        <HomeCarousel label="Documents récents">
          {/* Lot 49A : jusqu'à six documents — 3 visibles en mobile, 4 en
              desktop, 6 sur très grand écran (largeur de l'accueil élargie). */}
          {docs.slice(0, 6).map((d) => {
            const meta = [d.assetName, formatDay(d.date)].filter(Boolean).join(' · ') || d.typeLabel;
            return (
              <li key={d.id} className="w-[calc((100%-20px)/3)] flex-shrink-0 snap-start md:w-[calc((100%-36px)/4)] 2xl:w-[calc((100%-60px)/6)]">
                <button
                  type="button"
                  onClick={() => open(d)}
                  aria-label={`${d.title}${d.assetName ? ` — ${d.assetName}` : ''}`}
                  title={[d.title, d.typeLabel].filter(Boolean).join(' · ')}
                  className={`relative block h-[104px] w-full overflow-hidden rounded-xl border border-[color:var(--border-subtle)] text-left transition-shadow hover:shadow-relief-lg md:h-[120px] ${FOCUS_RING}`}
                >
                  <RecentDocPreview doc={d} />
                  <span className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,.1), rgba(0,0,0,.25) 50%, rgba(0,0,0,.85))' }} aria-hidden />
                  {d.status && <span className="absolute left-2 top-2"><StatusBadge label={d.status} /></span>}
                  <span className="absolute inset-x-2.5 bottom-2 flex min-w-0 flex-col gap-0.5 md:inset-x-3 md:bottom-2.5">
                    <span className="truncate text-[12px] font-semibold text-white md:text-[13px]">{d.title}</span>
                    <span className="truncate text-[11px] text-white/75">{meta}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </HomeCarousel>
      )}
    </HomeSection>
  );
}
