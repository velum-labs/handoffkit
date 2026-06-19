import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-24 text-center">
      <h1 className="text-3xl font-bold sm:text-5xl">real model fusion behind your coding agent</h1>
      <p className="max-w-2xl text-fd-muted-foreground">
        fusionkit spins up a panel of models, has each produce a real candidate, and lets a judge
        synthesize the answer your coding agent (Codex, Claude Code, or Cursor) actually runs — from
        one command.
      </p>
      <pre className="rounded-lg bg-fd-secondary px-4 py-3 text-sm">
        npm install -g @fusionkit/cli && fusionkit codex
      </pre>
      <div className="flex gap-3">
        <Link
          href="/docs"
          className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
        >
          Read the docs
        </Link>
        <Link
          href="/docs/quickstart"
          className="rounded-lg border px-4 py-2 text-sm font-medium"
        >
          Quickstart
        </Link>
      </div>
    </main>
  );
}
