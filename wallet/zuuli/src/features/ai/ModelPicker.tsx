import { Check, ChevronsUpDown, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AIModel } from "@/lib/api/types";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PROVIDER_META, pricePerMessage, providerMeta, providerOf } from "./providers";
import type { Provider } from "./providers";

interface ModelPickerProps {
  models: AIModel[];
  value: AIModel | null;
  onChange: (model: AIModel) => void;
  disabled?: boolean;
}

/** Group models by provider, preserving each provider's first-seen order. */
function groupByProvider(models: AIModel[]): [Provider, AIModel[]][] {
  const groups = new Map<Provider, AIModel[]>();
  for (const model of models) {
    const key = providerOf(model);
    const bucket = groups.get(key);
    if (bucket) bucket.push(model);
    else groups.set(key, [model]);
  }
  return [...groups.entries()];
}

export function ModelPicker({ models, value, onChange, disabled }: ModelPickerProps) {
  const groups = groupByProvider(models);

  return (
    <div className="flex items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="h-10 min-w-0 max-w-full justify-start gap-2.5 pr-2"
            disabled={disabled || !value}
            aria-label="Select AI model"
          >
            {value ? <ModelGlyph model={value} /> : null}
            <span className="min-w-0 flex-1 truncate text-left font-medium">
              {value?.display_name ?? "Select a model"}
            </span>
            <ChevronsUpDown className="ml-auto text-muted-foreground" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[min(22rem,90vw)]">
          {groups.map(([provider, group], gi) => {
            const meta = PROVIDER_META[provider];
            const Icon = meta.icon;
            return (
              <div key={provider}>
                {gi > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel className="flex items-center gap-1.5">
                  <Icon className={cn("h-3.5 w-3.5", meta.color)} aria-hidden />
                  {meta.label}
                  {provider === "local" ? (
                    <span className="ml-auto text-[10px] font-normal text-primary">
                      anonymous · open source
                    </span>
                  ) : null}
                </DropdownMenuLabel>
                {group.map((model) => {
                  const selected = model.id === value?.id;
                  return (
                    <DropdownMenuItem
                      key={model.id}
                      onSelect={() => onChange(model)}
                      className={cn(
                        "items-start gap-2.5 py-2",
                        provider === "local" && "bg-primary/[0.04]",
                      )}
                    >
                      <ModelGlyph model={model} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">
                            {model.display_name}
                          </span>
                          {model.is_ga ? (
                            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                              GA
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                          {pricePerMessage(model)}
                        </div>
                      </div>
                      {selected ? (
                        <Check className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden />
                      ) : null}
                    </DropdownMenuItem>
                  );
                })}
              </div>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {value ? <ModelInfo model={value} /> : null}
    </div>
  );
}

function ModelGlyph({ model, className }: { model: AIModel; className?: string }) {
  const meta = providerMeta(model);
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "grid h-6 w-6 shrink-0 place-items-center rounded-md",
        meta.tint,
        className,
      )}
      aria-hidden
    >
      <Icon className={cn("h-3.5 w-3.5", meta.color)} />
    </span>
  );
}

/** Hover card explaining the selected model's system prompt, limits and pricing. */
function ModelInfo({ model }: { model: AIModel }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="hidden h-9 w-9 shrink-0 text-muted-foreground sm:inline-flex"
          aria-label={`About ${model.display_name}`}
        >
          <Info className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        className="max-w-xs space-y-2 p-3 text-left"
      >
        <div className="text-sm font-semibold text-foreground">
          {model.display_name}
        </div>
        <p className="text-xs italic leading-relaxed text-muted-foreground">
          &ldquo;{model.system_message}&rdquo;
        </p>
        <div className="grid grid-cols-2 gap-1 text-[11px] tabular-nums text-muted-foreground">
          <span>Max output</span>
          <span className="text-right text-foreground">
            {model.max_tokens.toLocaleString()} tok
          </span>
          <span>Input</span>
          <span className="text-right text-foreground">
            {formatUsd(Number(model.input_price) * 1000)}/1K
          </span>
          <span>Output</span>
          <span className="text-right text-foreground">
            {formatUsd(Number(model.output_price) * 1000)}/1K
          </span>
          <span>Markup</span>
          <span className="text-right text-foreground">
            {Number(model.markup).toFixed(2)}&times;
          </span>
        </div>
        <p className="border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
          Cost-plus billing: upstream cost &times; markup, rounded up to whole
          2Zs. The provider never sees you — only free2z.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
