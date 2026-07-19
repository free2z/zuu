import { Check, ChevronsUpDown, Settings2, UserRound, Users } from "lucide-react";
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
import type { Personality } from "@/lib/api/types";
import { cn } from "@/lib/utils";

interface PersonalityPickerProps {
  personalities: Personality[];
  value: Personality | null;
  onChange: (personality: Personality | null) => void;
  onManage: () => void;
  ownUsername?: string;
  disabled?: boolean;
}

/**
 * Lets the user prime the AI with a custom system message. "Default" (no
 * personality) falls back to the selected model's own system message —
 * exactly what the backend does when a conversation's `personality` is null.
 */
export function PersonalityPicker({
  personalities,
  value,
  onChange,
  onManage,
  ownUsername,
  disabled,
}: PersonalityPickerProps) {
  const mine = personalities.filter((p) => p.creator === ownUsername);
  const others = personalities.filter((p) => p.creator !== ownUsername);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-10 min-w-0 max-w-full justify-start gap-2.5 pr-2"
          disabled={disabled}
          aria-label="Select AI personality"
        >
          <UserRound className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left font-medium">
            {value?.display_name ?? "Default persona"}
          </span>
          <ChevronsUpDown className="ml-auto text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(22rem,90vw)]">
        <DropdownMenuItem
          onSelect={() => onChange(null)}
          className="items-start gap-2.5 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium">Default persona</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Use the selected model's built-in system message.
            </p>
          </div>
          {value === null ? (
            <Check className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden />
          ) : null}
        </DropdownMenuItem>

        {mine.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <UserRound className="h-3.5 w-3.5" aria-hidden />
              Mine
            </DropdownMenuLabel>
            {mine.map((p) => (
              <PersonalityItem
                key={p.id}
                personality={p}
                selected={p.id === value?.id}
                onSelect={() => onChange(p)}
              />
            ))}
          </>
        ) : null}

        {others.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" aria-hidden />
              Public
            </DropdownMenuLabel>
            {others.map((p) => (
              <PersonalityItem
                key={p.id}
                personality={p}
                selected={p.id === value?.id}
                onSelect={() => onChange(p)}
              />
            ))}
          </>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onManage} className="gap-2.5">
          <Settings2 className="h-4 w-4 text-muted-foreground" aria-hidden />
          Manage personalities…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PersonalityItem({
  personality,
  selected,
  onSelect,
}: {
  personality: Personality;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="items-start gap-2.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{personality.display_name}</span>
          {personality.is_public ? (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              public
            </Badge>
          ) : null}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="mt-0.5 line-clamp-1 text-left text-xs text-muted-foreground">
              {personality.system_message}
            </p>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="start"
            className={cn("max-w-xs text-left")}
          >
            {personality.system_message}
          </TooltipContent>
        </Tooltip>
      </div>
      {selected ? (
        <Check className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden />
      ) : null}
    </DropdownMenuItem>
  );
}
