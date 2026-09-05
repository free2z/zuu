// One conversation's transcript, plus the composer.

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Send, ShieldAlert } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Callout } from "../../components/ui/callout";
import { Skeleton } from "../../components/ui/skeleton";
import { messaging } from "../../lib/messaging/bridge";
import { listenMessaging } from "../../lib/messaging/events";
import {
  type Conversation,
  type DeliveryState,
  type Message,
} from "../../lib/messaging/types";

const PAGE_SIZE = 50;

/**
 * §6.2. Each state is evidence of exactly one thing, and the copy says which:
 * `queue-delivered` is a storage fact about the recipient's device, not a
 * reading fact, and `delivered` says nothing about being read.
 */
const DELIVERY_COPY: Record<DeliveryState, string> = {
  pending: "Held on this device.",
  accepted: "A relay took it. Nothing is known about the recipient.",
  "queue-delivered": "Their device stored it. Not necessarily opened.",
  "device-delivered": "One of their devices confirmed it.",
  delivered: "Every device they had when you sent it confirmed it.",
  failed: "Not sent.",
  expired: "It timed out at the relay before they fetched it.",
};

function clientRef(): string {
  return globalThis.crypto?.randomUUID?.() ?? `ref-${Date.now()}`;
}

function MessageRow({ message }: { message: Message }) {
  const outbound = message.direction === "outbound";

  if (message.body.kind !== "text") {
    // A hole is never rendered as nothing (§3.4).
    return (
      <li className="flex justify-center">
        <p className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          {message.body.kind === "unrecoverable"
            ? message.body.reason === "gap-unrecoverable"
              ? "A message was here and cannot be recovered."
              : "A message was here and has passed this device's retention window."
            : `This message uses a format this version cannot read (${message.body.typeTag}).`}
        </p>
      </li>
    );
  }

  return (
    <li className={outbound ? "flex justify-end" : "flex justify-start"}>
      <div className="max-w-[75%] space-y-1">
        <p
          data-user-content
          className={
            outbound
              ? "rounded-xl bg-primary/15 px-3 py-2 break-words text-foreground"
              : "rounded-xl border border-border bg-card px-3 py-2 break-words text-foreground"
          }
        >
          {message.body.text}
        </p>
        {outbound && (
          <p className="text-end text-xs text-muted-foreground">
            {DELIVERY_COPY[message.delivery.state]}
          </p>
        )}
      </div>
    </li>
  );
}

export function Transcript({ conversation }: { conversation: Conversation }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [hasGapBefore, setHasGapBefore] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    const page = await messaging.listMessages(
      conversation.conversationId,
      PAGE_SIZE,
    );
    setMessages(page.messages);
    setHasGapBefore(page.hasGapBefore);
  }, [conversation.conversationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Events say state changed; the store is the truth. Both handlers re-read
  // rather than mutating a local list (§5.2).
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const attach = (promise: Promise<() => void>) => {
      void promise.then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });
    };

    attach(
      listenMessaging("f2zmsg://message-received", (payload) => {
        if (payload.conversationId === conversation.conversationId) {
          void reload();
        }
      }),
    );
    attach(listenMessaging("f2zmsg://message-state", () => void reload()));

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [conversation.conversationId, reload]);

  // §7 and §9 rule 10: `list_messages` returns the page ALREADY in §7's order.
  // This component renders that sequence and does not sort it. An inbound
  // message can land mid-transcript, and one that fills a gap can reorder rows
  // already on screen, so the event handlers above re-read the window rather
  // than patching a position — which is also why nothing here maintains one.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      await messaging.sendMessage(
        conversation.conversationId,
        body,
        clientRef(),
      );
      setDraft("");
      await reload();
    } finally {
      setSending(false);
    }
  }, [conversation.conversationId, draft, reload]);

  return (
    <div className="flex h-full flex-col gap-4">
      {conversation.transportHealth === "compromised" && (
        <Callout
          tone="destructive"
          icon={ShieldAlert}
          title="This conversation's send queue is compromised"
        >
          The send side was already bound to another or unknown key. The result
          does not identify who bound it.
          {conversation.compromiseRelayUrl !== null && (
            <>
              {" "}The relay that returned the refusal was{" "}
              {conversation.compromiseRelayUrl}.
            </>
          )}{" "}
          Stop using this conversation and re-establish contact through a
          different relay.
        </Callout>
      )}

      {hasGapBefore && (
        <Callout
          tone="warning"
          icon={AlertTriangle}
          title="Part of this conversation is missing"
        >
          Messages that came before what is shown have not arrived. This is a
          hole, not the beginning of the conversation.
        </Callout>
      )}

      {messages === null ? (
        <Skeleton className="h-48 w-full" />
      ) : messages.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">
          Nothing here yet. Send the first message.
        </p>
      ) : (
        <ul className="flex-1 space-y-3 overflow-y-auto">
          {messages.map((message) => (
            <MessageRow key={message.msgId} message={message} />
          ))}
          <div ref={endRef} />
        </ul>
      )}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="sr-only" htmlFor="message-body">
          Message
        </label>
        <textarea
          id="message-body"
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Message @${conversation.peerHandle}`}
          className="min-h-[44px] flex-1 resize-y rounded-xl border border-border bg-card px-3 py-2 text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        />
        <Button
          type="submit"
          disabled={sending || draft.trim().length === 0}
          aria-label="Send message"
          className="min-tap"
        >
          <Send className="rtl:-scale-x-100 size-4" aria-hidden />
          Send
        </Button>
      </form>
    </div>
  );
}
