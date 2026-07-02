import { FieldList } from "@/components/scope/field-list";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";

export type EnvironmentModel = {
  id: string;
  model: string;
  provider?: string;
  endpoint?: string;
};

/**
 * Flat environment detail shared by the session page and the Environments
 * page: a definition list of the stack fields plus a full panel-model table.
 */
export function EnvironmentDetail({
  repo,
  judgeModel,
  harnesses,
  fusionBackendUrl,
  models
}: {
  repo?: string;
  judgeModel?: string | null;
  harnesses?: string[];
  fusionBackendUrl?: string;
  models: EnvironmentModel[];
}) {
  return (
    <div className="space-y-4">
      <FieldList
        fields={[
          { label: "Repo", value: repo, mono: true },
          { label: "Judge model", value: judgeModel ?? undefined, mono: true },
          {
            label: "Harness",
            value: harnesses !== undefined && harnesses.length > 0 ? harnesses.join(", ") : undefined,
            mono: true
          },
          { label: "Synthesis backend", value: fusionBackendUrl, mono: true }
        ]}
      />

      {models.length > 0 ? (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Panel models ({models.length})</div>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Id</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Endpoint</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model) => (
                <TableRow key={model.id}>
                  <TableCell className="font-medium">{model.id}</TableCell>
                  <TableCell className="mono text-xs">{model.model}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {model.provider ?? "—"}
                  </TableCell>
                  <TableCell className="mono text-muted-foreground max-w-[240px] truncate text-xs">
                    {model.endpoint ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}
