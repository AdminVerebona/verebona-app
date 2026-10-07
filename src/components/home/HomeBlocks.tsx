"use client"
/**
 * Blocs de l'accueil Direction D v2 — Mes biens (§3.3, §4.2), Ce que j'ai
 * fait (§3.4), Documents récents (§3.5), et leurs états « compte vide »
 * (§12ter).
 */
import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, Download, FileText, Folder, House, Package } from 'lucide-react';
import { getAssetIcon, CATEGORY_LABELS } from '@/lib/asset-icons';
import { useThumbnailUrl } from '@/hooks/useThumbnailUrl';
import { openDrawer } from '@/lib/drawers';
import { pickBento } from '@/lib/home/recent-assets';
import { relativeAgo, type HomeRecentDocument, type HomeUpcomingItem, type VerebonaWorkItem } from '@/services/home/home-blocks';
import type { HomeAsset } from '@/services/home/HomeSummaryService';
import { MascotPose } from '@/components/verebona/space/MascotPose';

const SECTION_TITLE = 'font-display text-[19px] font-semibold tracking-[-.02em] text-[color:var(--text-primary)] md:text-[20px]';
const SECTION_LINK = 'ml-auto text-[12.5px] font-medium text-[color:var(--accent)] hover:text-[#60A5FA] focus-visible:outline-none focus-visible:underline';

// ── Carte de bien ───────────────────────────────────────────────────────────

/**
 * Carte photo (AssetCard du design system) : photo en fond, dégradé de
 * protection, nom en blanc, catégorie, nombre de documents, pastille si une
 * action est rattachée. Sans photo : tuile dégradée sombre avec icône.
 */
export function HomeAssetCard({ asset, className = '', priority = false }: { asset: HomeAsset; className?: string; priority?: boolean }) {
  const Icon = getAssetIcon(asset.category, asset.subtype ?? undefined, asset.name);
  const { signedUrl } = useThumbnailUrl(asset.signedThumbnailUrl ? null : asset.id, asset.signedThumbnailUrl ? null : asset.thumbnailUrl);
  const photo = asset.signedThumbnailUrl ?? signedUrl;
  const categorie = CATEGORY_LABELS[asset.category] ?? asset.category;
  return (
    <Link
      href={`/assets/${asset.id}`}
      className={`group relative block overflow-hidden rounded-[18px] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_20px_48px_rgba(0,0,0,.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] ${className}`}
    >
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- URL signée S3, dimension libre
        <img src={photo} alt="" loading={priority ? 'eager' : 'lazy'} className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'var(--tile-empty)' }}>
          <Icon className="h-9 w-9 text-white/25" aria-hidden />
        </div>
      )}
      <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(0,0,0,.85), rgba(0,0,0,.25) 55%, rgba(0,0,0,.1))' }} aria-hidden />
      <div className="absolute inset-0 z-[1] flex flex-col justify-between p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[9px] font-medium uppercase tracking-[.08em] text-white/80">
            {categorie}{asset.subtype ? ` · ${asset.subtype}` : ''}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-[14px] font-bold leading-tight text-white [text-shadow:0_2px_8px_rgba(0,0,0,.5)]">{asset.name}</h3>
          <div className="flex flex-wrap items-center gap-2">
            {asset.todoCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border px-2 py-px text-[9.5px] font-semibold" style={{ background: 'rgba(245,158,11,.25)', borderColor: 'var(--edge-amber)', color: '#FCD34D' }}>
                {asset.todoCount === 1 ? '1 action à faire' : `${asset.todoCount} actions à faire`}
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-[10px] text-white/60" aria-label={`${asset.documentCount} document${asset.documentCount > 1 ? 's' : ''}`}>
              <Folder className="h-2.5 w-2.5 text-[color:var(--vb-amber-500)]" aria-hidden />
              <span className="font-semibold text-white/80">{asset.documentCount}</span>
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}

// ── Mes biens ───────────────────────────────────────────────────────────────

function AllAssetsTile({ className = '' }: { className?: string }) {
  return (
    <Link
      href="/assets"
      className={`flex flex-col justify-between rounded-[18px] border border-dashed border-[color:var(--border)] px-[18px] py-4 text-[color:var(--text-primary)] transition-all duration-150 hover:border-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] ${className}`}
    >
      <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-[color:var(--accent-soft)] text-[color:var(--accent)]">
        <Package className="h-4 w-4" aria-hidden />
      </span>
      <span className="flex items-center justify-between text-[14px] font-semibold">
        Tous les biens
        <ArrowRight className="h-4 w-4 text-[color:var(--accent)]" strokeWidth={2.2} aria-hidden />
      </span>
    </Link>
  );
}

const EMPTY_ASSET_KINDS = [
  { key: 'logement', label: 'Une maison ou un appartement', short: 'Logement', icon: House },
  { key: 'vehicule', label: 'Un véhicule', short: 'Véhicule', icon: Package },
  { key: 'objet', label: 'Un objet de valeur', short: 'Objet', icon: Folder },
];

export function HomeAssets({ assets, onAddAsset, className = '' }: { assets: HomeAsset[]; onAddAsset: () => void; className?: string }) {
  const empty = assets.length === 0;
  const { big, small } = pickBento(assets);

  return (
    <section aria-labelledby="home-biens" className={`flex min-w-0 flex-col gap-2.5 md:gap-3 ${className}`}>
      <div className="flex items-center gap-2.5">
        <h2 id="home-biens" className={`m-0 ${SECTION_TITLE}`}>Mes biens</h2>
        {!empty && <span className="hidden text-[12.5px] text-[color:var(--text-muted)] md:inline">Récemment consultés</span>}
        {!empty && <Link href="/assets" className={`${SECTION_LINK} md:hidden`}>Tous les biens</Link>}
      </div>

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
                className="flex min-h-[104px] flex-col items-start justify-between gap-2.5 rounded-[18px] border border-dashed border-[color:var(--border)] p-3 text-left text-[color:var(--text-primary)] transition-all duration-150 hover:border-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] md:min-h-[132px] md:px-[18px] md:py-4"
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
        <>
          {/* Desktop : grille bento 3 × 2 rangées de 132 px */}
          <div className="hidden grid-cols-3 gap-3 md:grid" style={{ gridAutoRows: '132px' }}>
            {big && <HomeAssetCard asset={big} priority className="row-span-2" />}
            {small.map((a) => <HomeAssetCard key={a.id} asset={a} />)}
            <AllAssetsTile />
          </div>
          {/* Mobile : carrousel de cartes 220 × 140 calées au défilement */}
          <div className="-mx-4 flex snap-x snap-mandatory scroll-pl-4 gap-2.5 overflow-x-auto px-4 pb-1 vb-no-scrollbar md:hidden">
            {[...(big ? [big] : []), ...small].map((a) => (
              <HomeAssetCard key={a.id} asset={a} className="h-[140px] w-[220px] flex-shrink-0 snap-start" />
            ))}
          </div>
        </>
      )}
    </section>
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

export function VerebonaWork({ items, onNavigate, className = '' }: { items: VerebonaWorkItem[]; onNavigate: (href: string) => void; className?: string }) {
  const now = new Date();
  return (
    <section aria-labelledby="home-fait" className={`flex min-w-0 flex-col gap-2.5 md:gap-3 ${className}`}>
      <div className="flex items-center gap-2 md:gap-2.5">
        <MascotPose pose="document-analysis-pdf" size={26} still className="hidden md:block" />
        <MascotPose pose="document-analysis-pdf" size={24} still className="md:hidden" />
        <h2 id="home-fait" className={`m-0 ${SECTION_TITLE}`}>Ce que j’ai fait</h2>
        <Link href="/mon-compte/enrichissements" className={SECTION_LINK}>
          <span className="md:hidden">Tout voir</span><span className="hidden md:inline">Toute l’activité</span>
        </Link>
      </div>
      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[color:var(--border)] px-4 py-3.5 text-[13px] leading-normal text-[color:var(--muted-foreground)] md:rounded-[18px] md:px-[18px] md:py-4 md:text-[13.5px]">
          Rien pour l’instant. Dès votre premier document, je vous montrerai ici ce que j’ai lu, complété et rattaché à vos biens.
        </div>
      ) : (
        <ol className="m-0 flex list-none flex-col p-0 pl-1 md:pl-1.5 md:pt-1.5">
          {items.slice(0, 3).map((w, i) => (
            // Toute la ligne ouvre l'élément (document, échéance, fiche du
            // bien) : plus de bouton « Ouvrir… » sous le texte (2 oct. 2026).
            // Le libellé d'action reste annoncé aux lecteurs d'écran. Bouton
            // natif : atteint au clavier (Tab), activé par Entrée / Espace,
            // focus visible (fond + anneau accent).
            <li key={w.id} className={i >= 2 ? 'hidden md:block' : 'block'}>
              <button
                type="button"
                onClick={() => openWork(w, onNavigate)}
                aria-label={`${w.text} — ${w.cta}`}
                className="group -mx-2 flex w-[calc(100%+1rem)] gap-3 rounded-xl px-2 text-left transition-colors hover:bg-[color:var(--accent-soft)] focus-visible:bg-[color:var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] md:gap-3.5"
              >
                <span className="flex w-3 flex-shrink-0 flex-col items-center self-stretch" aria-hidden>
                  <span
                    className="mt-[5px] h-2.5 w-2.5 rounded-full"
                    style={{ background: WORK_DOTS[w.tone], boxShadow: `0 0 0 4px color-mix(in srgb, ${WORK_DOTS[w.tone]} 18%, transparent)` }}
                  />
                  <span className="mt-1.5 w-0.5 flex-1 rounded-sm bg-[color:var(--border-subtle)]" />
                </span>
                <span className="block min-w-0 flex-1 pb-4 md:pb-[18px]">
                  <span className="block text-[13.5px] leading-[1.45] text-[color:var(--text-primary)] [text-wrap:pretty] group-hover:text-[color:var(--accent)] md:leading-normal">{w.text}</span>
                  <span className="mt-1 block text-[12px] text-[color:var(--text-muted)] md:mt-[5px]">{relativeAgo(w.at, now)}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
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
    <span className="whitespace-nowrap rounded-full border px-2 py-[3px] text-[10px] font-semibold" style={{ background: 'var(--wash-amber)', color: 'var(--on-amber)', borderColor: 'var(--edge-amber)' }}>
      {label}
    </span>
  );
}

/**
 * Aperçu d'un document récent (lot 26, point 16) — mêmes conventions que les
 * vignettes de « Mes documents » (`DocumentsByRubric`) : miniature SERVEUR
 * (jamais l'original), chargement paresseux, décodage asynchrone, repli sur
 * l'icône. L'URL vient du résumé (signée, stable pendant l'heure, mise en
 * cache par le navigateur) : aucune requête par carte vers l'application.
 * Si elle n'est plus lisible (onglet resté ouvert au-delà de sa validité),
 * un essai par la route autorisée `/api/files/:id/thumbnail` (re-signature),
 * puis l'icône. Pas de rendu PDF dans le navigateur ici : sans miniature
 * prête, l'icône (la génération est demandée par le serveur).
 */
export function RecentDocPreview({ doc, variant }: { doc: HomeRecentDocument; variant: 'tile' | 'row' }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const tone = DOC_TONES[doc.tone];
  const src = !doc.previewUrl ? null : step === 0 ? doc.previewUrl : step === 1 ? `/api/files/${doc.id}/thumbnail` : null;
  const icon = (
    <span className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-xl" style={{ background: tone.bg, color: tone.fg }}>
      <FileText className="h-4 w-4" aria-hidden />
    </span>
  );
  if (variant === 'row') {
    if (!src) return icon;
    return (
      <span className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center">
        <span className="relative h-[38px] w-[30px] overflow-hidden rounded bg-white shadow-[0_1px_3px_rgba(0,0,0,.5)]">
          {/* eslint-disable-next-line @next/next/no-img-element -- miniature autorisée (APP-PERF-06), icône si absente */}
          <img src={src} alt="" loading="lazy" decoding="async" onError={() => setStep((x) => (x === 0 ? 1 : 2))} className="block h-full w-full object-cover object-top" />
        </span>
      </span>
    );
  }
  return (
    <span className="relative flex h-[104px] w-full items-end justify-center overflow-hidden rounded-xl border border-[rgba(148,163,184,.3)] bg-[color:var(--bg-card)] px-[18px] pt-3 [.theme-beige_&]:bg-[#F1F5F9]">
      {src ? (
        <span className="relative block h-full w-full overflow-hidden rounded-t bg-white shadow-[0_-2px_12px_rgba(0,0,0,.4)]">
          {/* eslint-disable-next-line @next/next/no-img-element -- miniature autorisée (APP-PERF-06), icône si absente */}
          <img src={src} alt="" loading="lazy" decoding="async" onError={() => setStep((x) => (x === 0 ? 1 : 2))} className="absolute inset-0 h-full w-full object-cover object-top" />
        </span>
      ) : (
        <span className="flex h-full w-full items-center justify-center pb-3">{icon}</span>
      )}
      {doc.status && <span className="absolute right-2 top-2"><StatusBadge label={doc.status} /></span>}
    </span>
  );
}

export function RecentDocuments({ docs, onUpload, className = '' }: { docs: HomeRecentDocument[]; onUpload: () => void; className?: string }) {
  const open = (d: HomeRecentDocument) => openDrawer({ kind: 'document', id: d.id });
  return (
    <section aria-labelledby="home-docs" className={`flex min-w-0 flex-col gap-2.5 md:gap-3 ${className}`}>
      <div className="flex items-center gap-2.5">
        <h2 id="home-docs" className={`m-0 ${SECTION_TITLE}`}>Documents récents</h2>
        {docs.length > 0 && (
          <Link href="/documents" className={SECTION_LINK}><span className="md:hidden">Tous</span><span className="hidden md:inline">Tous les documents</span></Link>
        )}
      </div>

      {docs.length === 0 ? (
        <>
          <div className="hidden items-center gap-5 rounded-[20px] border-[1.5px] border-dashed border-[color:var(--border)] px-6 py-[22px] md:flex" style={{ background: 'color-mix(in srgb, var(--accent) 4%, transparent)' }}>
            <span className="flex h-[52px] w-[52px] flex-shrink-0 items-center justify-center rounded-2xl bg-[color:var(--accent-soft)] text-[color:var(--accent)]">
              <Download className="h-[22px] w-[22px]" aria-hidden />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[15px] font-semibold text-[color:var(--text-primary)]">Déposez une facture, un contrat, une garantie ou une notice</span>
              <span className="text-[13px] text-[color:var(--muted-foreground)]">Je la lis, j’en extrais les informations utiles et je la rattache au bon bien.</span>
            </div>
            <button type="button" onClick={onUpload} className="h-9 whitespace-nowrap rounded-full bg-[color:var(--accent)] px-4 text-[13px] font-semibold text-white hover:bg-[#2563EB]">
              Déposer un document
            </button>
          </div>
          <button
            type="button"
            onClick={onUpload}
            className="flex min-h-[76px] items-center gap-3.5 rounded-[18px] border-[1.5px] border-dashed border-[color:var(--border)] px-4 py-3.5 text-left text-[color:var(--text-primary)] md:hidden"
            style={{ background: 'color-mix(in srgb, var(--accent) 4%, transparent)' }}
          >
            <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[14px] bg-[color:var(--accent-soft)] text-[color:var(--accent)]">
              <Download className="h-5 w-5" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[14px] font-semibold">Déposer un premier document</span>
              <span className="text-[12px] text-[color:var(--muted-foreground)]">Photo, PDF, facture, contrat…</span>
            </span>
          </button>
        </>
      ) : (
        <>
          {/* Desktop : 4 tuiles côte à côte, s'élèvent au survol */}
          <div className="hidden grid-cols-4 gap-3 md:grid">
            {docs.slice(0, 4).map((d) => {
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => open(d)}
                  className="flex min-w-0 flex-col gap-3.5 rounded-[18px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-[color:var(--border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
                >
                  <RecentDocPreview doc={d} variant="tile" />
                  <span className="flex min-w-0 flex-col gap-[3px]">
                    <span className="truncate text-[14px] font-semibold text-[color:var(--text-primary)]">{d.title}</span>
                    <span className="truncate text-[12.5px] text-[color:var(--muted-foreground)]">{d.assetName ?? 'Sans bien rattaché'}</span>
                    <span className="truncate text-[12px] text-[color:var(--text-muted)]">{[d.typeLabel, formatDay(d.date)].filter(Boolean).join(' · ')}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {/* Mobile : 3 lignes-cartes */}
          <div className="flex flex-col gap-2 md:hidden">
            {docs.slice(0, 3).map((d) => {
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => open(d)}
                  className="flex min-h-[60px] items-center gap-3 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-3 py-2.5 text-left"
                >
                  <RecentDocPreview doc={d} variant="row" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold text-[color:var(--text-primary)]">{d.title}</span>
                    <span className="block truncate text-[12px] text-[color:var(--muted-foreground)]">{[d.assetName, formatDay(d.date)].filter(Boolean).join(' · ')}</span>
                  </span>
                  {d.status && <StatusBadge label={d.status} />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}


// ── Prochaines échéances (prototype D v2, décision produit) ─────────────────

const UPCOMING_TONES: Record<HomeUpcomingItem['tone'], { bg: string; fg: string }> = {
  red: { bg: 'var(--wash-red)', fg: 'var(--on-red)' },
  amber: { bg: 'var(--wash-amber)', fg: 'var(--on-amber)' },
  green: { bg: 'var(--wash-green)', fg: 'var(--on-green)' },
};

/**
 * Lignes d'échéance : pastille de date colorée (rouge en retard, amber
 * proche, vert plus tard), titre, bien, délai. Un clic ouvre la fiche de
 * l'échéance en tiroir. Desktop : 3 lignes ; mobile : 2.
 */
export function UpcomingEvents({ items, className = '' }: { items: HomeUpcomingItem[]; className?: string }) {
  return (
    <section aria-labelledby="home-echeances" className={`flex min-w-0 flex-col gap-2.5 md:gap-3 ${className}`}>
      <div className="flex items-center gap-2.5">
        <h2 id="home-echeances" className={`m-0 ${SECTION_TITLE}`}>Prochaines échéances</h2>
        <Link href="/agenda" className={SECTION_LINK}>Mon agenda</Link>
      </div>
      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[color:var(--border)] px-4 py-3.5 text-[13px] leading-normal text-[color:var(--muted-foreground)] md:rounded-[18px] md:px-[18px] md:py-4 md:text-[13.5px]">
          Aucune échéance pour l’instant. Elles apparaîtront ici dès que je les aurai lues dans vos documents.
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.slice(0, 3).map((e, i) => {
            const tone = UPCOMING_TONES[e.tone];
            return (
              <li key={e.id} className={i >= 2 ? 'hidden md:block' : ''}>
                <button
                  type="button"
                  onClick={() => openDrawer({ kind: 'echeance', id: e.id })}
                  className="flex min-h-[60px] w-full items-center gap-3 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-3 py-2.5 text-left transition-all duration-150 hover:border-[color:var(--border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] md:min-h-14 md:px-2.5 md:py-2"
                >
                  <span className="flex h-11 w-11 flex-shrink-0 flex-col items-center justify-center rounded-xl leading-none" style={{ background: tone.bg, color: tone.fg }} aria-hidden>
                    <span className="text-[16px] font-bold">{e.day}</span>
                    <span className="text-[9.5px] font-semibold uppercase tracking-[.04em]">{e.month}</span>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[14px] font-semibold text-[color:var(--text-primary)]">{e.title}</span>
                    {e.assetName && <span className="truncate text-[12px] text-[color:var(--muted-foreground)]">{e.assetName}</span>}
                  </span>
                  <span className="whitespace-nowrap text-[12px] font-semibold" style={{ color: tone.fg }}>{e.rel}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
