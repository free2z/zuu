import { useState } from "react";
import { Loader2, Pencil, Plus, Trash2, UserRound, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ai } from "@/lib/api/free2z";
import type { Personality } from "@/lib/api/types";

const NAME_MAX = 200;
const MESSAGE_MAX = 4000;

interface PersonalityManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personalities: Personality[];
  ownUsername?: string;
  isAuthed: boolean;
  /** Called after a successful create/update/delete so the caller can refresh. */
  onChanged: (next: {
    created?: Personality;
    updated?: Personality;
    deletedId?: string;
  }) => void;
}

type View = { kind: "list" } | { kind: "edit"; personality: Personality | null };

/**
 * Full CRUD over `/api/ai/personalities/`: list your own + public
 * personalities, create/edit yours (display name + system message + public
 * toggle), delete yours. Read-only for personalities you don't own.
 */
export function PersonalityManager({
  open,
  onOpenChange,
  personalities,
  ownUsername,
  isAuthed,
  onChanged,
}: PersonalityManagerProps) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Armed by a first click on the trash icon; a second click on "Confirm"
  // actually deletes. Avoids a blocking `window.confirm()`, which freezes
  // the page (and is untheme-able) — an inline step keeps it in-app.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  function close(next: boolean) {
    if (!next) {
      setView({ kind: "list" });
      setConfirmingId(null);
    }
    onOpenChange(next);
  }

  async function handleDelete(p: Personality) {
    setConfirmingId(null);
    setDeletingId(p.id);
    try {
      await ai.personalities.delete(p.id);
      onChanged({ deletedId: p.id });
      toast.success("Personality deleted");
    } catch {
      toast.error("Couldn't delete that personality.");
    } finally {
      setDeletingId(null);
    }
  }

  const mine = personalities.filter((p) => p.creator === ownUsername);
  const others = personalities.filter((p) => p.creator !== ownUsername);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        {view.kind === "list" ? (
          <>
            <DialogHeader>
              <DialogTitle>Personalities</DialogTitle>
              <DialogDescription>
                A personality is a custom system message that primes the AI —
                pick one in chat to change how every model in this thread
                answers.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {!isAuthed ? (
                <p className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
                  Sign in with Zcash to create your own personalities. You can
                  still use public ones below.
                </p>
              ) : (
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setView({ kind: "edit", personality: null })}
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  New personality
                </Button>
              )}

              {mine.length > 0 ? (
                <Section title="Mine" icon={UserRound}>
                  {mine.map((p) => (
                    <PersonalityRow
                      key={p.id}
                      personality={p}
                      editable
                      deleting={deletingId === p.id}
                      confirming={confirmingId === p.id}
                      onEdit={() => setView({ kind: "edit", personality: p })}
                      onRequestDelete={() => setConfirmingId(p.id)}
                      onCancelDelete={() => setConfirmingId(null)}
                      onConfirmDelete={() => void handleDelete(p)}
                    />
                  ))}
                </Section>
              ) : null}

              <Section title="Public" icon={Users}>
                {others.length === 0 ? (
                  <p className="px-1 text-xs text-muted-foreground">
                    No public personalities yet.
                  </p>
                ) : (
                  others.map((p) => (
                    <PersonalityRow key={p.id} personality={p} editable={false} />
                  ))
                )}
              </Section>

              {personalities.length === 0 ? (
                <EmptyState
                  icon={UserRound}
                  title="No personalities yet"
                  description="Create one to give the AI a custom voice and instructions."
                />
              ) : null}
            </div>
          </>
        ) : (
          <PersonalityForm
            personality={view.personality}
            onCancel={() => setView({ kind: "list" })}
            onSaved={(saved, wasCreate) => {
              onChanged(wasCreate ? { created: saved } : { updated: saved });
              setView({ kind: "list" });
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof UserRound;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function PersonalityRow({
  personality,
  editable,
  deleting,
  confirming,
  onEdit,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  personality: Personality;
  editable: boolean;
  deleting?: boolean;
  confirming?: boolean;
  onEdit?: () => void;
  onRequestDelete?: () => void;
  onCancelDelete?: () => void;
  onConfirmDelete?: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-card/50 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{personality.display_name}</span>
          {personality.is_public ? (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              public
            </Badge>
          ) : null}
        </div>
        {confirming ? (
          <p className="mt-0.5 text-xs text-destructive">
            Delete this personality? This can&rsquo;t be undone.
          </p>
        ) : (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {personality.system_message}
          </p>
        )}
      </div>
      {editable ? (
        confirming ? (
          <div className="flex shrink-0 gap-1.5">
            <Button variant="outline" size="sm" onClick={onCancelDelete}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={onConfirmDelete}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                "Delete"
              )}
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              aria-label={`Edit ${personality.display_name}`}
              onClick={onEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive"
              aria-label={`Delete ${personality.display_name}`}
              onClick={onRequestDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

function PersonalityForm({
  personality,
  onCancel,
  onSaved,
}: {
  personality: Personality | null;
  onCancel: () => void;
  onSaved: (saved: Personality, wasCreate: boolean) => void;
}) {
  const [displayName, setDisplayName] = useState(personality?.display_name ?? "");
  const [systemMessage, setSystemMessage] = useState(
    personality?.system_message ?? "",
  );
  const [isPublic, setIsPublic] = useState(personality?.is_public ?? false);
  const [saving, setSaving] = useState(false);

  const canSave =
    displayName.trim().length > 0 && systemMessage.trim().length > 0 && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const input = {
        display_name: displayName.trim(),
        system_message: systemMessage.trim(),
        is_public: isPublic,
      };
      const saved = personality
        ? await ai.personalities.update(personality.id, input)
        : await ai.personalities.create(input);
      toast.success(personality ? "Personality updated" : "Personality created");
      onSaved(saved, !personality);
    } catch {
      toast.error("Couldn't save that personality. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {personality ? "Edit personality" : "New personality"}
        </DialogTitle>
        <DialogDescription>
          The system message is sent to the model before every reply in a
          conversation using this personality.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="personality-name">Name</Label>
          <Input
            id="personality-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value.slice(0, NAME_MAX))}
            placeholder="e.g. Patient Zcash tutor"
            maxLength={NAME_MAX}
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="personality-message">System message</Label>
          <Textarea
            id="personality-message"
            value={systemMessage}
            onChange={(e) =>
              setSystemMessage(e.target.value.slice(0, MESSAGE_MAX))
            }
            placeholder="You are..."
            className="min-h-[140px] resize-y"
          />
          <p className="text-xs tabular-nums text-muted-foreground">
            {systemMessage.length} / {MESSAGE_MAX}
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border bg-card/50 px-3 py-2.5">
          <div>
            <Label htmlFor="personality-public">Public</Label>
            <p className="text-xs text-muted-foreground">
              Anyone can discover and use this personality (they can't edit or
              delete it).
            </p>
          </div>
          <Switch
            id="personality-public"
            checked={isPublic}
            onCheckedChange={setIsPublic}
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={!canSave}>
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Saving
            </>
          ) : (
            "Save"
          )}
        </Button>
      </DialogFooter>
    </>
  );
}
