"use client";

import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A small icon button that copies the given text and briefly confirms. */
export function CopyButton({
  value,
  className,
  label = "Copy"
}: {
  value: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => setCopied(false));
  }, [value]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={onCopy}
      aria-label={copied ? "Copied" : label}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    >
      {copied ? <Check className="text-(--status-success)" /> : <Copy />}
    </Button>
  );
}
