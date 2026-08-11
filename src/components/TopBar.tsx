"use client"

import { useState, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Search, X, Package, FileText, Calendar,
  LayoutDashboard, User, LogOut, Shield, Sun, Moon, ChevronDown, Menu, Building2, Sparkles,
} from 'lucide-react'
import { Logo } from './Logo'
import { ConfirmLogoutDialog } from './ConfirmLogoutDialog'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { apiClient } from '@/lib/api-client'
import { getPlanTheme } from '@/lib/plan-theme'
import { NotificationBell } from './NotificationBell'
import { AnalysisBanner } from './AnalysisBanner'

/* ─── Types ─────────────────────────────────────────────── */

type Category = 'Navigation' | 'Bien' | 'Document' | 'Agenda' | 'Fournisseur'

interface SearchResult {
  id: string
  label: string
  sublabel?: string
  href: string
  icon: React.ElementType
  category: Category
  docId?: number
  mimeType?: string
  aiPowered?: boolean
}

interface IntelligentAnswer {
  responseMode: 'answer' | 'sources_only' | 'upgrade_hint' | 'blocked_offer' | 'blocked_ambiguous' | 'no_result'
  answerText: string | null
  sources: SearchResult[]
  upgradeHint: string | null
  trackingId: string
}

interface TopBarUser {
  firstName: string
  lastName: string
  username?: string | null
  email: string
  accountName?: string
  role?: string
  subscription: { plan: string }
  duoRole?: 'BILLING_OWNER' | 'MEMBER'
}

function getPlanLabel(plan: string, duoRole?: 'BILLING_OWNER' | 'MEMBER'): string {
  if (plan === 'PREMIUM_DUO') {
    return duoRole === 'MEMBER' ? 'Premium Duo (membre)' : 'Premium Duo'
  }
  const labels: Record<string, string> = {
    STANDARD: 'Standard',
    PREMIUM: 'Premium',
    PREMIUM_DUO: 'Premium Duo',
    PREMIUM_PRO: 'Premium Pro',
  }
  return labels[plan] ?? plan.toLowerCase()
}

interface TopBarProps {
  onMenuToggle: () => void
  sidebarCollapsed: boolean
  user: TopBarUser
  theme: string
  onToggleTheme: () => void
  onLogout: () => void
  isAdmin: boolean
}

/* ─── Constantes ─────────────────────────────────────────── */

const NAV_PAGES: SearchResult[] = [
  { id: 'accueil',   label: 'Accueil',              href: '/accueil',   icon: LayoutDashboard, category: 'Navigation' },
  { id: 'assets',    label: 'Mes biens',             href: '/assets',    icon: Package,         category: 'Navigation' },
  { id: 'documents', label: 'Mes documents',         href: '/documents', icon: FileText,        category: 'Navigation' },
  { id: 'agenda',    label: 'Agenda de mes biens',   href: '/agenda',    icon: Calendar,        category: 'Navigation' },
]

const CATEGORY_ICON: Record<Category, React.ElementType> = {
  Navigation:   LayoutDashboard,
  Bien:         Package,
  Document:     FileText,
  Agenda:       Calendar,
  Fournisseur:  Building2,
}

const ICON_COLOR: Record<Category, string> = {
  Navigation:   'text-[color:var(--text-muted)] bg-[color:var(--bg-page)]',
  Bien:         'text-blue-400 bg-blue-500/10',
  Document:     'text-emerald-400 bg-emerald-500/10',
  Agenda:       'text-amber-400 bg-amber-500/10',
  Fournisseur:  'text-violet-400 bg-violet-500/10',
}

const BADGE_COLOR: Record<Category, string> = {
  Navigation:   'bg-[color:var(--bg-page)] text-[color:var(--text-muted)]',
  Bien:         'bg-blue-500/15 text-blue-400',
  Document:     'bg-emerald-500/15 text-emerald-400',
  Agenda:       'bg-amber-500/15 text-amber-400',
  Fournisseur:  'bg-violet-500/15 text-violet-400',
}


/* ─── Composant ──────────────────────────────────────────── */

export function TopBar({
  onMenuToggle,
  sidebarCollapsed,
  user,
  theme,
  onToggleTheme,
  onLogout,
  isAdmin,
}: TopBarProps) {
  const router = useRouter()

  const [logoutConfirm, setLogoutConfirm] = useState(false)
  const [query,            setQuery]            = useState('')
  const [isFocused,        setIsFocused]        = useState(false)
  const [results,          setResults]          = useState<SearchResult[]>([])
  const [selectedIndex,    setSelectedIndex]    = useState(-1)
  const [loading,          setLoading]          = useState(false)
  const [intelligentAnswer, setIntelligentAnswer] = useState<IntelligentAnswer | null>(null)
  const [intelligentLoading, setIntelligentLoading] = useState(false)
  const intelligentDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, setAiPowered] = useState(false)

  const inputRef     = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null)

  const displayName = user.username || `${user.firstName} ${user.lastName.charAt(0)}.`
  const initials    = `${user.firstName.charAt(0)}${user.lastName.charAt(0)}`.toUpperCase()

  const plan = (user.subscription.plan || 'STANDARD').toUpperCase()
  const isIntelligentSearchPlan = plan === 'PREMIUM' || plan === 'PREMIUM_DUO' || plan === 'PREMIUM_PRO'

  /* — Recherche serveur avec debounce ————————— */
  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults(NAV_PAGES.slice(0, 6))
      setAiPowered(false)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const data = await apiClient.get<{ results: any[]; aiPowered?: boolean }>(`/api/search?q=${encodeURIComponent(q)}`)
      const isAI = data.aiPowered === true
      setAiPowered(isAI)
      const apiResults: SearchResult[] = (data.results || []).map((r: any) => ({
        id: r.id,
        label: r.label,
        sublabel: r.sublabel,
        href: r.href,
        icon: CATEGORY_ICON[r.category as Category] ?? FileText,
        category: r.category as Category,
        docId: r.docId,
        mimeType: r.mimeType,
      }))
      // Prepend nav suggestions that match (only for non-AI results to keep AI results clean)
      if (!isAI) {
        const navMatches = NAV_PAGES.filter(n =>
          n.label.toLowerCase().includes(q.toLowerCase())
        )
        setResults([...navMatches, ...apiResults].slice(0, 12))
      } else {
        setResults(apiResults.slice(0, 12))
      }
    } catch {
      setAiPowered(false)
      setResults(NAV_PAGES.filter(n => n.label.toLowerCase().includes(q.toLowerCase())))
    } finally {
      setLoading(false)
    }
  }, [])

  const debounceMs = isIntelligentSearchPlan ? 400 : 200

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(query), debounceMs)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, runSearch, debounceMs])

  /* — Recherche intelligente (Premium uniquement, debounce plus long) — */
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
        // Mapper sources en SearchResult
        const sources: SearchResult[] = (data.sources ?? []).map((s: any) => ({
          id: s.id,
          label: s.label,
          sublabel: s.sublabel,
          href: s.href,
          icon: CATEGORY_ICON[s.category as Category] ?? FileText,
          category: s.category as Category,
          docId: s.docId,
          mimeType: s.mimeType,
        }))
        setIntelligentAnswer({
          responseMode: data.responseMode,
          answerText: data.answerText,
          sources,
          upgradeHint: data.upgradeHint,
          trackingId: data.trackingId,
        })
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

  /* — Init: afficher suggestions nav au focus — */
  const handleFocus = () => {
    setIsFocused(true)
    if (!query.trim()) { setResults(NAV_PAGES.slice(0, 6)); setIntelligentAnswer(null) }
  }

  /* — Fermer en cliquant ailleurs — */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsFocused(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  /* — Raccourci / — */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, -1)) }
    else if (e.key === 'Enter' && selectedIndex >= 0) {
      const r = results[selectedIndex];
      if (r) { handleSelect(r); inputRef.current?.blur(); }
    } else if (e.key === 'Escape') {
      setQuery(''); setIsFocused(false); inputRef.current?.blur()
    }
  }

  const handleSelect = (r: SearchResult) => {
    setQuery(''); setIsFocused(false)
    if (r.category === 'Document' && r.docId) {
      // Open the global drawer directly — no page navigation needed
      window.dispatchEvent(new CustomEvent('open-document-drawer', { detail: { docId: Number(r.docId) } }))
    } else {
      router.push(r.href)
    }
  }

  /* — Grouper par catégorie — */
  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    (acc[r.category] = acc[r.category] || []).push(r)
    return acc
  }, {})

  /* ─── Rendu ─── */
  return (
    <header className="hidden md:flex items-center h-14 border-b border-[color:var(--border-subtle)] bg-[color:var(--sidebar)] flex-shrink-0 sticky top-0 z-30">

      {/* ① Bouton hamburger toggle sidebar — tout à gauche */}
      <div className="flex items-center px-3 flex-shrink-0">
        <button
          onClick={onMenuToggle}
          aria-label={sidebarCollapsed ? 'Ouvrir le menu' : 'Réduire le menu'}
          className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-[color:var(--accent-soft)] text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-all"
        >
          <Menu className="w-5 h-5" />
        </button>
      </div>

      {/* Logo + libellé */}
      <div className="flex items-center pl-2 pr-2 ml-2 flex-shrink-0">
        <Link href="/accueil" className="select-none">
          <Logo size={32} withText={true} withBaseline={false} />
        </Link>
      </div>

      {/* Séparateur vertical */}
      <div className="w-px h-5 bg-[color:var(--border-subtle)] flex-shrink-0" />

      {/* Zone contenu */}
      <div className="flex items-center gap-3 flex-1 px-4 min-w-0">

      {/* ③ Barre de recherche */}
      <div ref={containerRef} className="relative flex-1 max-w-xl">
        <div className={`flex items-center gap-2 rounded-lg px-3 h-9 transition-all border ${
          isFocused
            ? 'bg-[color:var(--bg-page)] border-[color:var(--accent)] shadow-[0_0_0_3px_rgba(59,130,246,0.12)]'
            : 'bg-[color:var(--bg-card)] border-[color:var(--border-subtle)] hover:border-[color:var(--text-muted)]'
        }`}>
          <Search className={`w-4 h-4 flex-shrink-0 transition-colors ${isFocused ? 'text-[color:var(--accent)]' : 'text-[color:var(--text-muted)]'}`} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onFocus={handleFocus}
            onKeyDown={handleKeyDown}
            placeholder={isIntelligentSearchPlan ? 'Recherche intelligente…' : 'Rechercher un bien, un document…'}
            className="flex-1 bg-transparent text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] outline-none min-w-0"
            data-guide="search"
          />
          {query && (
            <button onClick={() => { setQuery(''); setAiPowered(false); setIntelligentAnswer(null); inputRef.current?.focus() }}
              className="text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors flex-shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Dropdown résultats */}
        {isFocused && (
          <div className="absolute top-full left-0 right-0 mt-1.5 bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] rounded-xl shadow-relief-xl overflow-hidden z-50 max-h-[480px] overflow-y-auto">

            {/* ── Réponse intelligente IA (Premium) ── */}
            {isIntelligentSearchPlan && query.trim().length >= 10 && (intelligentLoading || intelligentAnswer) && (
              <div className="border-b border-[color:var(--border-subtle)]">
                {intelligentLoading ? (
                  <div className="flex items-center gap-2 px-4 py-3 text-xs text-violet-400">
                    <Sparkles className="w-3.5 h-3.5 animate-pulse" />
                    <span>Analyse en cours…</span>
                  </div>
                ) : intelligentAnswer?.responseMode === 'answer' && intelligentAnswer.answerText ? (
                  <div className="px-4 py-3 space-y-2.5">
                    {/* Réponse */}
                    <p className="text-sm text-[color:var(--text-primary)] leading-relaxed">
                      {intelligentAnswer.answerText}
                    </p>
                    {/* Sources */}
                    {intelligentAnswer.sources.length > 0 && (
                      <div className="space-y-0.5">
                        {intelligentAnswer.sources.slice(0, 3).map(s => {
                          const Icon = s.icon
                          return (
                            <button
                              key={s.id}
                              onClick={() => handleSelect(s)}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[color:var(--accent-soft)]/50 transition-colors text-left"
                            >
                              <span className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 ${ICON_COLOR[s.category as Category] ?? ICON_COLOR.Navigation}`}>
                                <Icon className="w-3 h-3" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <span className="text-xs font-medium text-[color:var(--text-primary)] truncate block">{s.label}</span>
                                {s.sublabel && <span className="text-[10px] text-[color:var(--text-muted)] truncate block">{s.sublabel}</span>}
                              </div>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${BADGE_COLOR[s.category as Category]}`}>
                                {s.category}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}

            {/* ── Résultats classiques ── */}
            {loading ? (
              <div className="px-4 py-5 text-center text-sm text-[color:var(--text-muted)] flex items-center justify-center gap-2">
                <span>Recherche en cours…</span>
              </div>
            ) : results.length === 0 && query.trim() ? (
              !intelligentAnswer?.answerText && (
                <div className="px-4 py-6 text-center text-sm text-[color:var(--text-muted)]">
                  Aucun résultat pour «&nbsp;{query}&nbsp;»
                </div>
              )
            ) : (
              <div className="py-1.5">
                {!query.trim() && (
                  <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">
                    Navigation rapide
                  </p>
                )}
                {Object.entries(grouped).map(([cat, items]) => (
                  <div key={cat}>
                    {query.trim() && cat !== 'Navigation' && (
                      <p className="px-3 pt-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">
                        {cat}
                      </p>
                    )}
                    <ul>
                      {items.map(r => {
                        const idx = results.indexOf(r)
                        const active = selectedIndex === idx
                        return (
                          <li key={r.id}>
                            <button
                              onMouseEnter={() => setSelectedIndex(idx)}
                              onClick={() => handleSelect(r)}
                              className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors ${
                                active ? 'bg-[color:var(--accent-soft)]' : 'hover:bg-[color:var(--accent-soft)]/50'
                              }`}
                            >
                              <span className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${ICON_COLOR[r.category as Category] ?? ICON_COLOR.Navigation}`}>
                                <r.icon className="w-4 h-4" />
                              </span>
                              <div className="flex flex-col items-start min-w-0 flex-1">
                                <span className={`font-medium truncate ${active ? 'text-[color:var(--accent)]' : 'text-[color:var(--text-primary)]'}`}>
                                  {r.label}
                                </span>
                                {r.sublabel && (
                                  <span className="text-xs text-[color:var(--text-muted)] truncate">{r.sublabel}</span>
                                )}
                              </div>
                              {!query.trim() && (
                                <span className={`ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 ${BADGE_COLOR[r.category as Category]}`}>
                                  {r.category}
                                </span>
                              )}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bandeau analyse en cours */}
      <AnalysisBanner />

      {/* Notifications */}
      <NotificationBell />

      {/* ④ Avatar utilisateur + dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-[color:var(--accent-soft)] transition-all group">
            <div className="hidden lg:flex flex-col items-end">
              <span className="text-sm font-medium text-[color:var(--text-primary)] leading-none group-hover:text-[color:var(--accent)] transition-colors">
                {displayName}
              </span>
              <span className={`text-[11px] ${getPlanTheme(plan).colors.text} font-medium mt-0.5`}>
                {getPlanLabel(plan, user.duoRole)}
              </span>
            </div>
            <Avatar className="w-8 h-8 shadow-relief-sm flex-shrink-0">
              <AvatarFallback className={`${getPlanTheme(plan).colors.badge || 'bg-slate-600'} text-white text-sm font-semibold`}>
                {initials}
              </AvatarFallback>
            </Avatar>
            <ChevronDown className="w-3.5 h-3.5 text-[color:var(--text-muted)] hidden lg:block" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60 shadow-relief-lg">
          <div className="px-3 py-2.5 flex items-center gap-3">
            <Avatar className="w-9 h-9 flex-shrink-0">
              <AvatarFallback className={`${getPlanTheme(plan).colors.badge || 'bg-slate-600'} text-white text-sm font-semibold`}>
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{displayName}</p>
              <p className="text-xs text-[color:var(--text-muted)] truncate">{user.email}</p>
              <p className={`text-xs ${getPlanTheme(plan).colors.text} font-medium mt-0.5`}>
                Plan {getPlanLabel(plan, user.duoRole)}
              </p>
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/mon-compte" className="cursor-pointer flex items-center">
              <User className="mr-2 h-4 w-4" /><span>Mon compte</span>
            </Link>
          </DropdownMenuItem>
          {isAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/admin" className="cursor-pointer flex items-center">
                  <Shield className="mr-2 h-4 w-4" /><span>Administration</span>
                </Link>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onToggleTheme} className="cursor-pointer">
            {theme === 'blue' ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}
            <span>Thème {theme === 'blue' ? 'clair' : 'sombre'}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setLogoutConfirm(true)} className="cursor-pointer text-red-500 focus:text-red-500">
            <LogOut className="mr-2 h-4 w-4" /><span>Se déconnecter</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmLogoutDialog open={logoutConfirm} onOpenChange={setLogoutConfirm} onConfirm={onLogout} />
      </div>{/* fin Zone contenu */}
    </header>
  )
}
