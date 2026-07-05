"use client";

import dynamic from "next/dynamic";

/**
 * Client-only wrapper: wterm loads a WASM terminal core, so it must never run
 * during SSR/prerender.
 */
const FusionTerminal = dynamic(() => import("./fusion-terminal"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[26rem] items-center justify-center rounded-xl border bg-[#0d1117]">
      <span className="font-mono text-xs text-white/40">loading terminal…</span>
    </div>
  )
});

export default function DemoSection() {
  return (
    <section className="mx-auto w-full max-w-4xl px-4 pb-16">
      <h2 className="mb-2 text-center text-2xl font-semibold">Watch fusion drive a coding agent</h2>
      <p className="mx-auto mb-6 max-w-2xl text-center text-sm text-fd-muted-foreground">
        A real <code>fusionkit codex</code> session in a Vercel Sandbox microVM: Codex works a small
        repo while a panel of OpenRouter free models produces, judges, and fuses every answer.
      </p>
      <FusionTerminal />
    </section>
  );
}
