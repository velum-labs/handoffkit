"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTheme } from "next-themes";

/**
 * Render a Mermaid diagram on the client. The `remarkMdxMermaid` plugin converts
 * ```mermaid code blocks into <Mermaid chart="..." />; rendering is client-only
 * to avoid hydration mismatches and to pick up the active light/dark theme.
 */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId();
  const [svg, setSvg] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;

    async function renderChart() {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        fontFamily: "inherit",
        themeCSS: "margin: 1.5rem auto 0;",
        theme: resolvedTheme === "dark" ? "dark" : "default"
      });

      try {
        const { svg: rendered, bindFunctions } = await mermaid.render(
          // `useId()` can contain `:` which is invalid for a DOM id.
          `mermaid-${id.replaceAll(":", "")}`,
          chart.replaceAll("\\n", "\n")
        );
        if (cancelled) return;
        setSvg(rendered);
        if (containerRef.current) bindFunctions?.(containerRef.current);
      } catch (error) {
        console.error("failed to render mermaid diagram", error);
      }
    }

    void renderChart();
    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  return <div ref={containerRef} dangerouslySetInnerHTML={{ __html: svg }} />;
}
