"use client"
import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'

interface BreadcrumbItem {
  label: string
  href?: string
}

interface BreadcrumbContextType {
  items: BreadcrumbItem[]
  setBreadcrumbs: (items: BreadcrumbItem[]) => void
}

const BreadcrumbContext = createContext<BreadcrumbContextType | undefined>(undefined)

/**
 * ══════════════════════════════════════════════════════════════════════════
 * LE FIL D'ARIANE EST RATTACHÉ À LA PAGE QUI L'A POSÉ
 *
 * Onze pages appellent `setBreadcrumbs(...)` depuis un effet de montage.
 * Les autres — « Mon compte › Informations », par exemple — n'appellent
 * rien : elles héritaient donc du fil de la page précédente, et le
 * conservaient jusqu'à la prochaine qui en pose un.
 *
 * Ce n'était pas visible tant que rien n'affichait le fil. Ça le devient
 * dès qu'on le rend.
 *
 * Une remise à zéro sur changement de chemin, dans un effet du fournisseur,
 * ne fonctionnerait pas : React exécute les effets des enfants AVANT ceux du
 * parent. Le fil posé par la nouvelle page serait effacé juste après avoir
 * été posé.
 *
 * On mémorise donc le chemin AU MOMENT où le fil est posé, et on ne le rend
 * que tant qu'on est sur ce chemin. Aucune synchronisation, aucun ordre
 * d'effets à respecter.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function BreadcrumbProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  // Lu par `setBreadcrumbs` sans le faire dépendre du chemin : la fonction
  // reste stable, et les effets des pages qui la mettent en dépendance ne se
  // rejouent pas à chaque navigation.
  const pathnameRef = useRef(pathname)
  pathnameRef.current = pathname

  const [state, setState] = useState<{ path: string | null; items: BreadcrumbItem[] }>({
    path: null,
    items: [],
  })

  const setBreadcrumbs = useCallback((items: BreadcrumbItem[]) => {
    setState({ path: pathnameRef.current, items })
  }, [])

  const items = state.path === pathname ? state.items : []

  return (
    <BreadcrumbContext.Provider value={{ items, setBreadcrumbs }}>
      {children}
    </BreadcrumbContext.Provider>
  )
}

export function useBreadcrumb() {
  const context = useContext(BreadcrumbContext)
  if (!context) {
    throw new Error('useBreadcrumb must be used within BreadcrumbProvider')
  }
  return context
}
