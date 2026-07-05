import Link from "next/link";

import DemoSection from "@/components/demo/demo-section";

const features = [
  {
    title: "Real model fusion",
    body: "A panel of models each produces a real candidate over your repo; a judge synthesizes the answer your agent runs."
  },
  {
    title: "Bring your own agent",
    body: "Back Codex, Claude Code, or Cursor unchanged. They speak their native protocol and never learn fusion happened."
  },
  {
    title: "Open-weight economics",
    body: "Use cheaper open-weight or local models in a panel, then verify quality and cost with the reproducible benchmark runbook."
  }
];

const sections = [
  { title: "Get Started", href: "/docs/getting-started/installation", body: "Install the CLI and run your first fused session." },
  { title: "CLI Reference", href: "/docs/cli/commands", body: "Every command, flag, and cost control." },
  { title: "Concepts", href: "/docs/concepts/overview", body: "Panels, judges, synthesizers, fused models, and passthrough models." },
  { title: "Privacy", href: "/docs/privacy", body: "Local storage, provider egress, and no-telemetry behavior." }
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="flex flex-col items-center gap-6 px-4 py-24 text-center">
        <span className="rounded-full border px-3 py-1 text-xs font-medium text-fd-muted-foreground">
          @fusionkit/cli
        </span>
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">
          Real model fusion behind your coding agent
        </h1>
        <p className="max-w-2xl text-lg text-fd-muted-foreground">
          fusionkit spins up a panel of models, has each produce a real candidate, and lets a judge
          synthesize the answer Codex, Claude Code, or Cursor actually runs - from one command.
        </p>
        <pre className="rounded-lg bg-fd-secondary px-4 py-3 text-sm">
          npm install -g @fusionkit/cli && fusionkit setup && fusionkit codex
        </pre>
        <div className="flex flex-wrap justify-center gap-3">
          <Link
            href="/docs"
            className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground"
          >
            Read the docs
          </Link>
          <Link
            href="/docs/getting-started/quickstart"
            className="rounded-lg border px-5 py-2.5 text-sm font-medium"
          >
            Quickstart
          </Link>
        </div>
      </section>

      <DemoSection />

      <section className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4 px-4 pb-12 sm:grid-cols-3">
        {features.map((feature) => (
          <div key={feature.title} className="rounded-xl border p-6">
            <h2 className="mb-2 text-lg font-semibold">{feature.title}</h2>
            <p className="text-sm text-fd-muted-foreground">{feature.body}</p>
          </div>
        ))}
      </section>

      <section className="mx-auto w-full max-w-5xl px-4 pb-24">
        <h2 className="mb-6 text-center text-2xl font-semibold">Explore the docs</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {sections.map((section) => (
            <Link
              key={section.href}
              href={section.href}
              className="rounded-xl border p-5 transition-colors hover:bg-fd-accent"
            >
              <h3 className="mb-1 font-medium">{section.title}</h3>
              <p className="text-sm text-fd-muted-foreground">{section.body}</p>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
