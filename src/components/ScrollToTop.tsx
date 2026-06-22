"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Determine visibility based on scroll position of main scrollable containers
    const checkScroll = () => {
      let isVisible = window.scrollY > 300 || document.documentElement.scrollTop > 300;

      if (!isVisible) {
        // Specifically check the container used in DashboardLayout
        const mainContainer = document.getElementById("main-scroll-container");
        if (mainContainer && mainContainer.scrollTop > 300) {
          isVisible = true;
        } else {
          // Check all potential scrollable containers if the main one isn't scrolled
          const containers = [
            document.querySelector("main"),
            ...Array.from(document.querySelectorAll(".overflow-y-auto, .overflow-auto, [class*='overflow-y-']"))
          ];

          for (const container of containers) {
            if (container && (container as HTMLElement).scrollTop > 300) {
              isVisible = true;
              break;
            }
          }
        }
      }

      setVisible(isVisible);
    };

    const onScroll = () => checkScroll();

    // Check scroll on any container scroll event
    const onContainerScroll = (e: Event) => {
      checkScroll();
    };

    window.addEventListener("scroll", onScroll, { passive: true });

    // Use capture phase to catch scroll events from any container, specifically targeting the div that scrolls
    window.addEventListener("scroll", onContainerScroll, { passive: true, capture: true });

    // Add specific listener to the main container when it exists
    const mainContainer = document.getElementById("main-scroll-container");
    if (mainContainer) {
      mainContainer.addEventListener("scroll", onContainerScroll, { passive: true });
    }

    // Initial check
    checkScroll();

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onContainerScroll, { capture: true });
      const mainContainer = document.getElementById("main-scroll-container");
      if (mainContainer) {
        mainContainer.removeEventListener("scroll", onContainerScroll);
      }
    };
  }, []);

  const scrollToTop = () => {
    // Scroll window
    window.scrollTo({ top: 0, behavior: "smooth" });
    document.documentElement.scrollTo({ top: 0, behavior: "smooth" });

    // Scroll specific containers
    document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" });
    document.getElementById("main-scroll-container")?.scrollTo({ top: 0, behavior: "smooth" });

    // Scroll all scrollable parents
    const scrollContainers = document.querySelectorAll(".overflow-y-auto, .overflow-auto, .h-screen, [style*='overflow']");
    scrollContainers.forEach(container => {
      if (container.scrollTop > 0) {
        container.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  };

  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <button
          onClick={scrollToTop}
          aria-label="Retour en haut"
          className={[
            "fixed z-40",
            "right-4 bottom-28",           // mobile: juste au-dessus de la bottom nav
            "md:right-6 md:bottom-6",      // desktop: coin bas-droit
            "w-10 h-10 rounded-full p-0",
            "bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)]",
            "shadow-relief-md hover:shadow-relief-lg",
            "flex items-center justify-center",
            "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]",
            "hover:-translate-y-px",
            "transition-all duration-200",
            visible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
          ].join(" ")}
        >
          <ArrowUp className="w-5 h-5" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="left"
        sideOffset={8}
        className="bg-[color:var(--bg-card)]/90 text-[color:var(--text-muted)] border border-[color:var(--border-subtle)] shadow-sm text-[11px] px-2 py-1 rounded-md [&>[data-radix-popper-arrow]]:hidden"
      >
        Retour en haut
      </TooltipContent>
    </Tooltip>
  );
}
