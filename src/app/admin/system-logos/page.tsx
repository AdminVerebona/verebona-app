import { SystemLogosClient } from "./_components/system-logos-client";

export default function SystemLogosPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Logos Système</h1>
        <p className="text-sm text-[color:var(--text-muted)] mt-1">
          Gérez les logos du système et prévisualisez-les sans débordements.
        </p>
      </div>

      <SystemLogosClient />
    </div>
  );
}