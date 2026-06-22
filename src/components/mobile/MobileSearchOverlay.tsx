"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Search, X, Package, FileText, Calendar, LayoutDashboard, Sparkles, Building2 } from 'lucide-react'
import { apiClient } from '@/lib/api-client'

type Category = 'Navigation' | 'Bien' | 'Document' | 'Agenda' | 'Fournisseur'

interface SearchResult {
  id: string
  docId?: number
  label: string
  sublabel?: string
  href: string
  category: Category
}

const NAV_PAGES: SearchResult[] = [
  { id: 'accueil',   label: 'Accueil',            href: '/accueil',   category: 'Navigation' },
  { id: 'assets',    label: 'Mes biens',           href: '/assets',    category: 'Navigation' },
  { id: 'documents', label: 'Mes documents',       href: '/documents', category: 'Navigation' },
  { id: 'agenda',    label: 'Agenda de mes biens', href: '/agenda',    category: 'Navigation' },
]

const CATEGORY_ICON: Record<Category, React.ElementType> = {
  Navigation:  LayoutDashboard,
  Bien:        Package,
  Document:    FileText,
  Agenda:      Calendar,
  Fournisseur: Building2,
}

const ICON_COLOR: Record<Category, string> = {
  Navigation:  'text-[color:var(--text-muted)] bg-[color:var(--bg-page)]',
  Bien:        'text-blue-400 bg-blue-500/10',
  Document:    'text-emerald-400 bg-emerald-500/10',
  Agenda:      'text-amber-400 bg-amber-500/10',
  Fournisseur: 'text-violet-400 bg-violet-500/10',
}

const CATEGORY_LABEL: Record<Category, string> = {
  Navigation:  'Navigation',
  Bien:        'Bien',
  Document:    'Document',
  Agenda:      'Agenda',
  Fournisseur: 'Fournisseur',
}

const BADGE_COLOR: Record<Category, string> = {
  Navigation:  'bg-[color:var(--bg-page)] text-[color:var(--text-muted)]',
  Bien:        'bg-blue-500/15 text-blue-400',
  Document:    'bg-emerald-500/15 text-emerald-400',
  Agenda:      'bg-amber-500/15 text-amber-400',
  Fournisseur: 'bg-violet-500/15 text-violet-400',
}

interface MobileSearchOverlayProps {
  open: boolean
  onClose: () => void
  isPaidPlan: boolean
  planCode?: string
}

export function MobileSearchOverlay({ open, onClose, isPaidPlan, planCode = '' }: MobileSearchOverlayProps) {
  const isIntelligentSearchPlan = planCode === 'PREMIUM' || planCode === 'PREMIUM_DUO' || planCode === 'PREMIUM_PRO'
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [query,    setQuery]    = useState('')
  const [results,  setResults]  = useState<SearchResult[]>(NAV_PAGES.slice(0, 4))
  const [loading,  setLoading]  = useState(false)
  const [aiPowered, setAiPowered] = useState(false)
  const [intelligentAnswer, setIntelligentAnswer] = useState<{
    answerText: string; sources: SearchResult[]
  } | null>(null)
  const [intelligentLoading, setIntelligentLoading] = useState(false)
  const intelligentDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* Focus input when overlay opens */
  useEffect(() => {
    if (open) {
      setQuery('')
      setResults(NAV_PAGES.slice(0, 4))
      setAiPowered(false)
      setIntelligentAnswer(null)
      setTimeout(() => inputRef.current?.focus(), 80)
    }
  }, [open])

  /* Prevent body scroll while open */
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults(NAV_PAGES.slice(0, 4))
      setAiPowered(false)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const data = await apiClient.get<{ results: any[]; aiPowered?: boolean }>(
        `/api/search?q=${encodeURIComponent(q)}`
      )
      const isAI = data.aiPowered === true
      setAiPowered(isAI)
      const apiResults: SearchResult[] = (data.results || []).map((r: any) => ({
        id: r.id,
        label: r.label,
        sublabel: r.sublabel,
        href: r.href,
        category: r.category as Category,
      }))
      if (!isAI) {
        const navMatches = NAV_PAGES.filter(n =>
          n.label.toLowerCase().includes(q.toLowerCase())
        )
        setResults([...navMatches, ...apiResults].slice(0, 10))
      } else {
        setResults(apiResults.slice(0, 10))
      }
    } catch {
      setAiPowered(false)
      setResults(NAV_PAGES.filter(n => n.label.toLowerCase().includes(q.toLowerCase())))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(query), 400)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, runSearch])

  /* — Recherche intelligente mobile — */
  const runIntelligentSearch = useCallback(async (q: string) => {
    if (!q.trim() || q.length < 10 || !isIntelligentSearchPlan) {
      setIntelligentAnswer(null)
      setIntelligentLoading(false)
      return
    }
    setIntelligentLoading(true)
    try {
      const data = await apiClient.post<any>('/api/search/intelligent', { query: q })
      if (data.responseMode === 'answer' && data.answerText) {
        const sources: SearchResult[] = (data.sources ?? []).map((s: any) => ({
          id: s.id,
          label: s.label,
          sublabel: s.sublabel,
          href: s.href,
          category: s.category as Category,
          docId: s.docId,
        }))
        setIntelligentAnswer({ answerText: data.answerText, sources })
      } else {
        setIntelligentAnswer(null)
      }
    } catch {
      setIntelligentAnswer(null)
    } finally {
      setIntelligentLoading(false)
    }
  }, [isIntelligentSearchPlan])

  useEffect(() => {
    if (intelligentDebounceRef.current) clearTimeout(intelligentDebounceRef.current)
    intelligentDebounceRef.current = setTimeout(() => runIntelligentSearch(query), 500)
    return () => { if (intelligentDebounceRef.current) clearTimeout(intelligentDebounceRef.current) }
  }, [query, runIntelligentSearch])

  const handleSelect = (r: SearchResult) => {
    onClose()
    if (r.category === 'Document' && r.docId) {
      window.dispatchEvent(new CustomEvent('open-document-drawer', { detail: { docId: r.docId } }))
    } else {
      router.push(r.href)
    }
  }

  if (!open) return null

  /* Group by category */
  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    (acc[r.category] = acc[r.category] || []).push(r)
    return acc
  }, {})

  return (
    <div className="fixed inset-0 z-[60] md:hidden flex flex-col bg-[color:var(--bg-page)]">

      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 pt-[calc(env(safe-area-inset-top)+12px)] pb-3 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-page)]">
        <div className={`flex-1 flex items-center gap-2 rounded-xl px-3 h-11 border transition-all bg-[color:var(--bg-card)] border-[color:var(--accent)] shadow-[0_0_0_3px_rgba(59,130,246,0.12)]`}>
          {loading && isPaidPlan ? (
            <Sparkles className="w-4 h-4 flex-shrink-0 text-violet-400 animate-pulse" />
          ) : (
            <Search className="w-4 h-4 flex-shrink-0 text-[color:var(--accent)]" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={isIntelligentSearchPlan ? 'Recherche intelligente…' : 'Rechercher un bien, un document…'}
            className="flex-1 bg-transparent text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] outline-none min-w-0"
          />
          {aiPowered && query.trim() && !loading && (
            <span className="flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-400 flex-shrink-0">
              <Sparkles className="w-2.5 h-2.5" />IA
            </span>
          )}
          {query && (
            <button onClick={() => setQuery('')} className="text-[color:var(--text-muted)]">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <button
          onClick={onClose}
          className="flex-shrink-0 px-3 h-11 rounded-xl text-sm font-medium text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors"
        >
          Annuler
        </button>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">

        {/* ── Réponse intelligente IA (Premium) ── */}
        {isIntelligentSearchPlan && query.trim().length >= 10 && (intelligentLoading || intelligentAnswer) && (
          <div className="border-b border-[color:var(--border-subtle)] mx-4 mt-3 mb-1">
            {intelligentLoading ? (
              <div className="flex items-center gap-2 pb-3 text-xs text-violet-400">
                <Sparkles className="w-3.5 h-3.5 animate-pulse" />
                <span>Analyse en cours…</span>
              </div>
            ) : intelligentAnswer?.answerText ? (
              <div className="pb-3 space-y-2">
                <p className="text-sm text-[color:var(--text-primary)] leading-relaxed">
                  {intelligentAnswer.answerText}
                </p>
                {intelligentAnswer.sources.length > 0 && (
                  <div className="space-y-1 mt-1">
                    {intelligentAnswer.sources.slice(0, 3).map(s => {
                      const Icon = CATEGORY_ICON[s.category] ?? FileText
                      return (
                        <button key={s.id} onClick={() => handleSelect(s)}
                          className="w-full flex items-center gap-2.5 py-1.5 active:bg-[color:var(--accent-soft)] transition-colors text-left">
                          <span className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${ICON_COLOR[s.category]}`}>
                            <Icon className="w-3.5 h-3.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <span className="text-sm font-medium text-[color:var(--text-primary)] truncate block">{s.label}</span>
                            {s.sublabel && <span className="text-xs text-[color:var(--text-muted)] truncate block">{s.sublabel}</span>}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-[color:var(--text-muted)]">
            <span>Recherche en cours…</span>
          </div>
        ) : results.length === 0 && query.trim() ? (
          !intelligentAnswer?.answerText && (
          <div className="py-12 text-center text-sm text-[color:var(--text-muted)]">
            Aucun résultat pour «&nbsp;{query}&nbsp;»
          </div>
          )
        ) : (
          <div className="py-2">
            {/* AI header */}
            {aiPowered && query.trim() && (
              <div className="px-4 py-2 flex items-center gap-1.5 border-b border-[color:var(--border-subtle)] mb-1">
                <Sparkles className="w-3 h-3 text-violet-400" />
                <span className="text-[11px] font-medium text-violet-400">Résultats par IA Gemini</span>
              </div>
            )}
            {!query.trim() && (
              <p className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">
                Navigation rapide
              </p>
            )}
            {Object.entries(grouped).map(([cat, items]) => (
              <div key={cat}>
                {query.trim() && !aiPowered && (
                  <p className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">
                    {CATEGORY_LABEL[cat as Category] ?? cat}
                  </p>
                )}
                {query.trim() && aiPowered && cat !== 'Navigation' && (
                  <p className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">
                    {CATEGORY_LABEL[cat as Category] ?? cat}
                  </p>
                )}
                {items.map(r => {
                  const Icon = CATEGORY_ICON[r.category] ?? FileText
                  return (
                    <button
                      key={r.id}
                      onClick={() => handleSelect(r)}
                      className="w-full flex items-center gap-3 px-4 py-3 active:bg-[color:var(--accent-soft)] transition-colors"
                    >
                      <span className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${ICON_COLOR[r.category]}`}>
                        <Icon className="w-4 h-4" />
                      </span>
                      <div className="flex flex-col items-start min-w-0 flex-1">
                        <span className="font-medium text-sm text-[color:var(--text-primary)] truncate w-full text-left">
                          {r.label}
                        </span>
                        {r.sublabel && (
                          <span className="text-xs text-[color:var(--text-muted)] truncate w-full text-left">{r.sublabel}</span>
                        )}
                      </div>
                      {!query.trim() && (
                        <span className={`ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 ${BADGE_COLOR[r.category]}`}>
                          {CATEGORY_LABEL[r.category]}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
