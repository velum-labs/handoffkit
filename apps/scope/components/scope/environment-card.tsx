import { Boxes, Cpu, FolderGit2, Gavel, Network } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { EnvironmentView } from "@/lib/sessions";

function Field({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="text-muted-foreground mt-0.5">{icon}</div>
      <div className="min-w-0">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="mono truncate text-sm">{value}</div>
      </div>
    </div>
  );
}

export function EnvironmentCard({ environment }: { environment: EnvironmentView | undefined }) {
  if (environment === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Environment</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          No environment snapshot was captured for this session.
        </CardContent>
      </Card>
    );
  }

  const models = environment.models ?? [];
  const endpoints = environment.modelEndpoints ?? {};

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Environment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field icon={<FolderGit2 className="size-4" />} label="Repo" value={environment.repo ?? "—"} />
          <Field
            icon={<Gavel className="size-4" />}
            label="Judge model"
            value={environment.judgeModel ?? "—"}
          />
          <Field
            icon={<Boxes className="size-4" />}
            label="Harness"
            value={
              environment.harnesses && environment.harnesses.length > 0 ? environment.harnesses.join(", ") : "—"
            }
          />
          <Field
            icon={<Network className="size-4" />}
            label="Synthesis backend"
            value={environment.fusionBackendUrl ?? "—"}
          />
        </div>

        {models.length > 0 ? (
          <>
            <Separator />
            <div>
              <div className="text-muted-foreground mb-2 text-xs">Panel models</div>
              <div className="space-y-2">
                {models.map((model) => (
                  <div
                    key={model.id}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Cpu className="text-muted-foreground size-4 shrink-0" />
                      <Badge variant="secondary" className="font-normal">
                        {model.id}
                      </Badge>
                      <span className="mono text-muted-foreground truncate text-xs">{model.model}</span>
                    </div>
                    <span className="mono text-muted-foreground hidden truncate text-xs sm:block">
                      {endpoints[model.id] ?? model.endpoint_id ?? ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
