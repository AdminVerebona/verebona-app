"use client"

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ChevronLeft, ChevronRight, FileText, Lock, Clock, Rocket, Search } from 'lucide-react';
import { HELP_ARTICLES, HELP_CATS, type HelpArticle, type HelpCatId, type HelpPara } from '@/services/help/help-content';
import { toast } from 'sonner';

const CAT_ICON: Record<HelpCatId, { icon: React.ElementType; cls: string }> = {
  start: { icon: Rocket, cls: 'text-blue-400 bg-blue-500/15 border-blue-500/30' },
  docs: { icon: FileText, cls: 'text-violet-400 bg-violet-500/15 border-violet-500/30' },
  echeances: { icon: Clock, cls: 'text-amber-400 bg-amber-500/15 border-amber-500/30' },
  compte: { icon: Lock, cls: 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30' },
};

const POPULAR = ['premier-bien', 'import-analyse', 'rappels', 'duo', 'dossier-vente'];

function askVerebona() {
  window.dispatchEvent(new CustomEvent('verebona:open', { detail: {} }));
}

/** Centre d'aide — /aide : accueil (thèmes + populaires), catégorie, article. */
export default function AidePage() {
  const [cat, setCat] = useState<HelpCatId | null>(null);
  const [articleId, setArticleId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const article = articleId ? HELP_ARTICLES.find((a: HelpArticle) => a.id === articleId) ?? null : null;
  const openArticle = (a: HelpArticle) => { setArticleId(a.id); setCat(a.cat); };
  const results = query.trim()
    ? HELP_ARTICLES.filter((a: HelpArticle) => (a.title + ' ' + a.excerpt).toLowerCase().includes(query.toLowerCase()))
    : null;

  return (
    <div className="w-full pb-24">
      {/* Fil d'Ariane — au-dessus du titre (règle projet) */}
      <nav className="flex items-center gap-1.5 text-xs text-[color:var(--text-muted)] mb-1.5">
        <Link href="/accueil" className="hover:text-[color:var(--text-primary)] transition-colors">Accueil</Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-[color:var(--text-primary)]">Centre d'aide</span>
      </nav>
      <h1 className="text-[21px] font-semibold tracking-tight text-[color:var(--text-primary)]">Centre d'aide</h1>
      <p className="text-[12.5px] text-[color:var(--text-muted)] mb-5">Guides et réponses pour bien utiliser Verebona</p>

      {article ? (
        /* ── Article ── */
        <>
          <button onClick={() => setArticleId(null)} className="flex items-center gap-1.5 text-[12.5px] font-medium text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors mb-3.5">
            <ChevronLeft className="w-3.5 h-3.5" />{HELP_CATS[article.cat]}
          </button>
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,720px)_300px] gap-6 items-start">
            <div className="rounded-2xl bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] px-7 py-6">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--accent)] mb-1.5">{HELP_CATS[article.cat]}</p>
              <h2 className="text-[19px] font-semibold tracking-tight text-[color:var(--text-primary)] mb-1">{article.title}</h2>
              <p className="text-[11.5px] text-[color:var(--text-muted)] mb-4.5">Mis à jour {article.updated}</p>
              {article.paras.map((p: HelpPara, i: number) => p.step ? (
                <div key={i} className="flex gap-3 mb-3">
                  <span className="w-[22px] h-[22px] flex-shrink-0 rounded-full bg-[color:var(--accent-soft)] border border-blue-500/30 flex items-center justify-center text-[11px] font-bold text-[color:var(--accent)]">{p.step}</span>
                  <span className="text-[13.5px] leading-relaxed text-[color:var(--text-primary)]">{p.text}</span>
                </div>
              ) : (
                <p key={i} className="text-[13.5px] leading-relaxed text-[color:var(--text-primary)] mb-3.5">{p.text}</p>
              ))}
              <div className="flex items-center gap-3 mt-5 pt-4 border-t border-[color:var(--border-subtle)]">
                <span className="text-xs text-[color:var(--text-muted)]">Cet article vous a-t-il aidé ?</span>
                <button onClick={() => toast.success('Merci pour votre retour !')} className="px-3.5 py-1.5 rounded-full border border-[color:var(--border-subtle)] text-xs hover:border-emerald-500/50 hover:text-emerald-400 transition-colors">Oui</button>
                <button onClick={() => { toast('Merci — posez votre question à Verebona pour aller plus loin'); askVerebona(); }} className="px-3.5 py-1.5 rounded-full border border-[color:var(--border-subtle)] text-xs hover:border-red-500/50 hover:text-red-400 transition-colors">Non</button>
              </div>
            </div>
            <div className="space-y-4">
              <div className="rounded-2xl bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] px-4.5 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] mb-2.5">Dans la même catégorie</p>
                {HELP_ARTICLES.filter((a: HelpArticle) => a.cat === article.cat && a.id !== article.id).map((a: HelpArticle) => (
                  <button key={a.id} onClick={() => openArticle(a)} className="w-full flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-lg text-left text-[12.5px] text-[color:var(--text-primary)] hover:bg-[color:var(--accent-soft)] transition-colors">
                    <FileText className="w-3 h-3 text-[color:var(--text-muted)] flex-shrink-0" />{a.title}
                  </button>
                ))}
              </div>
              <div className="rounded-2xl bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] px-4.5 py-4 text-center">
                <Image src="/mascot/dialogue-bubble.webp" alt="" width={56} height={56} className="mx-auto mb-2" />
                <p className="text-[12.5px] text-[color:var(--text-muted)] mb-2.5">Vous ne trouvez pas la réponse ?</p>
                <button onClick={askVerebona} className="w-full h-[34px] rounded-full bg-[color:var(--accent)] text-white text-xs font-semibold hover:-translate-y-px transition-all">Demander à Verebona</button>
              </div>
            </div>
          </div>
        </>
      ) : cat ? (
        /* ── Catégorie ── */
        <>
          <button onClick={() => setCat(null)} className="flex items-center gap-1.5 text-[12.5px] font-medium text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors mb-3.5">
            <ChevronLeft className="w-3.5 h-3.5" />Centre d'aide
          </button>
          <h2 className="text-base font-semibold text-[color:var(--text-primary)] mb-3">{HELP_CATS[cat]}</h2>
          <div className="max-w-3xl rounded-2xl bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] overflow-hidden">
            {HELP_ARTICLES.filter((a: HelpArticle) => a.cat === cat).map((a: HelpArticle, i: number) => (
              <button key={a.id} onClick={() => openArticle(a)} className={`w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-white/[.02] transition-colors ${i > 0 ? 'border-t border-[color:var(--border-subtle)]' : ''}`}>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13.5px] font-medium text-[color:var(--text-primary)]">{a.title}</span>
                  <span className="block text-[11.5px] text-[color:var(--text-muted)] mt-0.5">{a.excerpt}</span>
                </span>
                <ChevronRight className="w-3.5 h-3.5 text-[color:var(--text-muted)] flex-shrink-0" />
              </button>
            ))}
          </div>
        </>
      ) : (
        /* ── Accueil du centre d'aide ── */
        <>
          <div className="flex items-center gap-2.5 max-w-xl h-11 px-4 rounded-full bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] mb-4">
            <Search className="w-4 h-4 text-[color:var(--text-muted)]" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Rechercher un article… (ex. : ajouter un document)" className="flex-1 bg-transparent outline-none text-[13.5px] text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)]" />
          </div>
          {results ? (
            <div className="max-w-3xl rounded-2xl bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] overflow-hidden mb-6">
              {results.length === 0 ? (
                <p className="px-5 py-5 text-center text-sm text-[color:var(--text-muted)]">Aucun article pour «&nbsp;{query}&nbsp;». Posez la question à Verebona.</p>
              ) : results.map((a: HelpArticle, i: number) => (
                <button key={a.id} onClick={() => openArticle(a)} className={`w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-white/[.02] transition-colors ${i > 0 ? 'border-t border-[color:var(--border-subtle)]' : ''}`}>
                  <span className="flex-1 min-w-0 text-[13.5px] font-medium text-[color:var(--text-primary)]">{a.title}</span>
                  <span className="text-[11.5px] text-[color:var(--text-muted)]">{HELP_CATS[a.cat]}</span>
                  <ChevronRight className="w-3.5 h-3.5 text-[color:var(--text-muted)]" />
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-5 rounded-2xl bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] px-6 py-4.5 mb-7">
                <Image src="/mascot/dialogue-bubble.webp" alt="" width={72} height={72} className="animate-[vb-float_6s_ease-in-out_infinite]" />
                <div className="flex-1 min-w-0">
                  <p className="text-[14.5px] font-semibold text-[color:var(--text-primary)] mb-0.5">Une question précise ?</p>
                  <p className="text-[12.5px] text-[color:var(--text-muted)] leading-relaxed">Verebona connaît vos biens, vos documents et le centre d'aide. Posez votre question, la réponse cite ses sources.</p>
                </div>
                <button onClick={askVerebona} className="flex-shrink-0 h-10 px-4.5 rounded-full bg-[color:var(--accent)] text-white text-[13px] font-semibold hover:-translate-y-px transition-all">Demander à Verebona</button>
              </div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] mb-3">Parcourir par thème</p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-7">
                {(Object.keys(HELP_CATS) as HelpCatId[]).map(c => {
                  const { icon: Icon, cls } = CAT_ICON[c];
                  const count = HELP_ARTICLES.filter((a: HelpArticle) => a.cat === c).length;
                  return (
                    <button key={c} onClick={() => setCat(c)} className="flex flex-col items-start gap-3 p-5 rounded-2xl bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] text-left hover:border-[color:var(--text-muted)] hover:-translate-y-0.5 hover:shadow-relief-md transition-all">
                      <span className={`w-[42px] h-[42px] rounded-xl border flex items-center justify-center ${cls}`}><Icon className="w-[18px] h-[18px]" /></span>
                      <span>
                        <span className="block text-[13.5px] font-semibold text-[color:var(--text-primary)]">{HELP_CATS[c]}</span>
                        <span className="block text-[11.5px] text-[color:var(--text-muted)] mt-0.5">{count} article{count > 1 ? 's' : ''}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] mb-3">Articles populaires</p>
              <div className="max-w-3xl rounded-2xl bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] overflow-hidden">
                {POPULAR.map((id, i) => {
                  const a = HELP_ARTICLES.find((x: HelpArticle) => x.id === id)!;
                  return (
                    <button key={id} onClick={() => openArticle(a)} className={`w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-white/[.02] transition-colors ${i > 0 ? 'border-t border-[color:var(--border-subtle)]' : ''}`}>
                      <span className="flex-1 min-w-0 text-[13.5px] font-medium text-[color:var(--text-primary)]">{a.title}</span>
                      <span className="text-[11.5px] text-[color:var(--text-muted)]">{HELP_CATS[a.cat]}</span>
                      <ChevronRight className="w-3.5 h-3.5 text-[color:var(--text-muted)]" />
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
