import { DashboardLayout } from '@/components/DashboardLayout';
import { BreadcrumbProvider } from '@/contexts/BreadcrumbContext';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <BreadcrumbProvider>
      <DashboardLayout>{children}</DashboardLayout>
    </BreadcrumbProvider>
  );
}
