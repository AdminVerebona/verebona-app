"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    // La session est stockee cote client (contrainte iframe / localStorage)
    const token =
      typeof window !== "undefined"
        ? localStorage.getItem("bearer_token")
        : null;
    router.replace(token ? "/accueil" : "/login");
  }, [router]);

  // Loader plein ecran pendant la redirection (evite tout flash de page vide)
  return (
    <div className="min-h-screen flex items-center justify-center bg-[color:var(--bg-page)]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent text-[color:var(--text-muted)]" />
    </div>
  );
}
