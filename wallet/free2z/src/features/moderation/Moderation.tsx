import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { MESSAGE_KEYS } from "@/i18n/messages";
import { getTokenSnapshot } from "@/lib/api/http";
import {
  moderation,
  type ReportKind,
  type ReportReason,
} from "@/lib/api/moderation";
import { useModeration } from "@/store/moderation";
import { useSession } from "@/store/session";

const reasons: [ReportReason, string][] = [
  ["csae", MESSAGE_KEYS.moderationCsae],
  ["harassment", MESSAGE_KEYS.moderationHarassment],
  ["hate", MESSAGE_KEYS.moderationHate],
  ["sexual", MESSAGE_KEYS.moderationSexual],
  ["violence", MESSAGE_KEYS.moderationViolence],
  ["spam", MESSAGE_KEYS.moderationSpam],
  ["other", MESSAGE_KEYS.moderationOther],
];

export function BlockedContent({
  username,
  children,
}: {
  username: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const names = useModeration((s) => s.names);
  const owner = useModeration((s) => s.owner);
  const user = useSession((s) => s.user);
  const token = getTokenSnapshot();
  const active =
    owner &&
    user &&
    owner.username === user.username.toLowerCase() &&
    owner.token.generation === token.generation &&
    owner.token.token === token.token;
  if (
    active &&
    names.some((name) => name.toLowerCase() === username.toLowerCase())
  )
    return (
      <p role="status" className="rounded-lg border border-border p-4 text-sm">
        {t(MESSAGE_KEYS.moderationHidden)}
      </p>
    );
  return <>{children}</>;
}

export function ModerationControls({
  username,
  kind,
  targetId,
}: {
  username: string;
  kind: ReportKind;
  targetId: string;
}) {
  const { t } = useTranslation();
  const user = useSession((s) => s.user);
  const names = useModeration((s) => s.names);
  const status = useModeration((s) => s.status);
  const toggle = useModeration((s) => s.toggle);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>("csae");
  const [details, setDetails] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const token = getTokenSnapshot();
  const actor = user?.username ?? "";
  useEffect(() => {
    setOpen(false);
    setPending(false);
    setMessage("");
    setDetails("");
  }, [actor, token.generation]);
  if (!user || user.username.toLowerCase() === username.toLowerCase())
    return null;
  const blocked = names.some(
    (name) => name.toLowerCase() === username.toLowerCase()
  );
  const current = () => {
    const now = getTokenSnapshot();
    return (
      now.generation === token.generation &&
      now.token === token.token &&
      useSession.getState().user?.username === actor
    );
  };
  async function block() {
    setPending(true);
    setMessage("");
    try {
      await toggle(username, !blocked);
    } catch {
      if (current()) setMessage(t(MESSAGE_KEYS.moderationRequesterror));
    } finally {
      if (current()) setPending(false);
    }
  }
  async function report() {
    setPending(true);
    setMessage("");
    try {
      await moderation.report(kind, targetId, reason, details, token, actor);
      if (current()) {
        setOpen(false);
        setMessage(t(MESSAGE_KEYS.moderationSent));
      }
    } catch {
      if (current()) setMessage(t(MESSAGE_KEYS.moderationRequesterror));
    } finally {
      if (current()) setPending(false);
    }
  }
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
          disabled={pending}
        >
          {t(MESSAGE_KEYS.moderationReport)}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={block}
          disabled={pending || status !== "ready"}
        >
          {t(
            blocked
              ? MESSAGE_KEYS.moderationUnblock
              : MESSAGE_KEYS.moderationBlock
          )}
        </Button>
      </div>
      {message && !open ? <p role="status">{message}</p> : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>{t(MESSAGE_KEYS.moderationReport)}</DialogTitle>
          <DialogDescription>
            {t(MESSAGE_KEYS.moderationReason)}
          </DialogDescription>
          {message && <p role="alert">{message}</p>}
          <label className="block space-y-2">
            {t(MESSAGE_KEYS.moderationReason)}
            <select
              className="w-full cursor-pointer rounded border bg-background p-2"
              value={reason}
              onChange={(e) => setReason(e.target.value as ReportReason)}
            >
              {reasons.map(([value, key]) => (
                <option key={value} value={value}>
                  {t(key)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-2">
            {t(MESSAGE_KEYS.moderationDetails)}
            <textarea
              className="w-full rounded border bg-background p-2"
              maxLength={2000}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
            />
          </label>
          <Button type="button" onClick={report} disabled={pending}>
            {t(MESSAGE_KEYS.moderationSend)}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function BlockManagement() {
  const { t } = useTranslation();
  const names = useModeration((s) => s.names);
  const status = useModeration((s) => s.status);
  const load = useModeration((s) => s.load);
  const toggle = useModeration((s) => s.toggle);
  const user = useSession((s) => s.user);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState(false);
  const snapshot = getTokenSnapshot();
  const actor = user?.username;
  useEffect(() => {
    setOpen(false);
    setPending("");
    setError(false);
  }, [actor, snapshot.generation]);
  async function unblock(name: string) {
    setPending(name);
    setError(false);
    try {
      await toggle(name, false);
    } catch {
      if (
        getTokenSnapshot().generation === snapshot.generation &&
        useSession.getState().user?.username === actor
      )
        setError(true);
    } finally {
      if (
        getTokenSnapshot().generation === snapshot.generation &&
        useSession.getState().user?.username === actor
      )
        setPending("");
    }
  }
  if (!user) return null;
  return (
    <>
      <Button type="button" variant="ghost" onClick={() => setOpen(true)}>
        {t(MESSAGE_KEYS.moderationBlocks)}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>{t(MESSAGE_KEYS.moderationBlocks)}</DialogTitle>
          <DialogDescription>
            {t(MESSAGE_KEYS.moderationBlocks)}
          </DialogDescription>
          {status === "loading" || status === "idle" ? (
            <p>{t(MESSAGE_KEYS.commonLoading)}</p>
          ) : null}
          {status === "error" ? (
            <div role="alert">
              {t(MESSAGE_KEYS.moderationLoaderror)}{" "}
              <Button type="button" onClick={() => void load()}>
                {t(MESSAGE_KEYS.commonRetry)}
              </Button>
            </div>
          ) : null}
          {error ? (
            <p role="alert">{t(MESSAGE_KEYS.moderationRequesterror)}</p>
          ) : null}
          {status === "ready" && names.length === 0 ? (
            <p>{t(MESSAGE_KEYS.moderationEmpty)}</p>
          ) : null}
          {status === "ready"
            ? names.map((name) => (
                <div
                  key={name}
                  className="flex items-center justify-between gap-2"
                >
                  <span>@{name}</span>
                  <Button
                    type="button"
                    disabled={!!pending}
                    onClick={() => void unblock(name)}
                  >
                    {t(MESSAGE_KEYS.moderationUnblock)}
                  </Button>
                </div>
              ))
            : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
