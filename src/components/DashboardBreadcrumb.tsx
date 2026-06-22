"use client"
import Link from 'next/link'
import { useThemeToggle } from '@/components/ThemeToggle'
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'

interface BreadcrumbItemType {
  label: string
  href?: string
}

interface DashboardBreadcrumbProps {
  items: BreadcrumbItemType[]
}

export function DashboardBreadcrumb({ items }: DashboardBreadcrumbProps) {
  const { theme, mounted } = useThemeToggle()
  if (!mounted) return null
  if (items.length === 0) return null
  const textColor = theme === 'blue' ? 'text-gray-400' : 'text-gray-500'
  const mutedColor = theme === 'blue' ? 'text-gray-600' : 'text-gray-400'
  const allItems = [{ label: 'Accueil', href: '/accueil' }, ...items]
  return (
    <Breadcrumb className='hidden md:flex px-6 py-2 border-b border-[color:var(--border-subtle)]'>
      <BreadcrumbList className={`gap-1.5 text-xs ${textColor}`}>
        {allItems.map((item, index) => (
          <BreadcrumbItem key={index}>
            {index > 0 && <BreadcrumbSeparator className={`${mutedColor} mx-0.5`} />}
            {item.href ? (
              <BreadcrumbLink asChild>
                <Link href={item.href} className={`${textColor} hover:text-[color:var(--text-primary)] transition-colors`}>
                  {item.label}
                </Link>
              </BreadcrumbLink>
            ) : (
              <BreadcrumbPage className={`font-medium ${textColor}`}>
                {item.label}
              </BreadcrumbPage>
            )}
          </BreadcrumbItem>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
