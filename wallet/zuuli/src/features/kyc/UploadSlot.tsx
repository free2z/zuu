import { useRef } from "react";
import { FileCheck2, Loader2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * One file-upload slot shared by the identity-documents and tax-form steps.
 * Shows a dashed dropzone-style button when empty, or a "view / remove" row
 * once a file is on file (the KYC endpoints return a plain URL per slot).
 */
export function UploadSlot({
  label,
  description,
  required,
  url,
  accept,
  uploading,
  onSelect,
  onDelete,
}: {
  label: string;
  description?: string;
  required?: boolean;
  url?: string | null;
  accept?: string;
  uploading: boolean;
  onSelect: (file: File) => void;
  onDelete: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">
          {label}
          {required ? (
            <span className="ml-1 text-primary">*</span>
          ) : (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              (optional)
            </span>
          )}
        </span>
      </div>
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}

      {url ? (
        <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/40 px-3 py-2.5">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 text-sm text-primary hover:underline"
          >
            <FileCheck2 className="h-4 w-4" aria-hidden />
            View uploaded file
          </a>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onDelete}
            aria-label={`Remove ${label}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "min-tap flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card/30 px-3 py-3 text-sm text-muted-foreground transition-colors hover:bg-secondary/40 disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Upload className="h-4 w-4" aria-hidden />
          )}
          {uploading ? "Uploading…" : "Choose file to upload"}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onSelect(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
