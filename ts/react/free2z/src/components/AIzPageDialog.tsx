import {
  Alert,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  FormControl,
  FormControlLabel,
  InputAdornment,
  IconButton,
  InputLabel,
  Link,
  MenuItem,
  Select,
  TextField,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { Delete } from "@mui/icons-material";
import { TextState, TextAreaTextApi } from "@uiw/react-md-editor";
import axios from "axios";
import { useCallback, useEffect, useRef, useState } from "react";
import { useGlobalState } from "../state/global";

type Props = {
  state?: TextState;
  ta?: TextAreaTextApi;
  title?: string;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

type CompletionChoice = {
  id: string;
  provider: string;
  model: string;
  display_name: string;
  destination: string;
  privacy_policy_url: string;
  availability: string;
  queue: string;
};

type PromptQuote = {
  choice: CompletionChoice;
  model: string;
  max_output_tokens: number;
  requested_output_tokens: number;
  max_charge_2z: number;
  quote_token: string;
  availability: string;
  queue: string;
};

type PendingPromptIntent = {
  key: string;
  attemptId?: string;
  body: {
    model: string;
    prompt: string;
    max_output_tokens: number;
    quote_token: string;
  };
  choice: CompletionChoice;
  quote: PromptQuote;
  completedAt?: number;
  completedResponse?: {
    response: string;
    display_name: string;
    provider: string;
    model: string;
    tuzis_charged: number;
  };
  insertionAttemptedAt?: number;
  insertedAt?: number;
};

type UnknownOutcomePrompt = {
  actor: string;
  identity: string;
  key: string;
};

const PENDING_PROMPT_PREFIX = "f2z:creator-ai-prompt:v1:";
const CREATOR_OUTPUT_TOKENS = 4096;
const MAX_COMPLETED_PROMPT_INTENTS = 12;
const MAX_COMPLETED_PROMPT_STORAGE_CHARS = 512 * 1024;
const MAX_UNKNOWN_PROMPT_ARCHIVES = 32;
const PROMPT_ACTOR_TIMEOUT_MS = 15_000;
// Keep the browser deadline inside nginx's 200s read window. Django's
// provider inactivity timeout and generation wall deadline can outlive a
// client connection, so a timeout is ambiguous: retain the same key/body for
// receipt recovery rather than creating a new paid attempt.
const PROMPT_GENERATION_TIMEOUT_MS = 180_000;
const PROMPT_SUBMISSION_TIMEOUT_MS = 200_000;

function withAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  message = "The request timed out or was cancelled. Its original retry key was kept."
) {
  if (signal.aborted) return Promise.reject(new Error(message));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(message));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function requestWithTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal: AbortSignal,
  message: string
) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (parentSignal.aborted) cancel();
  else parentSignal.addEventListener("abort", cancel, { once: true });
  const timer = window.setTimeout(cancel, timeoutMs);
  let pending: Promise<T>;
  try {
    pending = request(controller.signal);
  } catch (error) {
    window.clearTimeout(timer);
    parentSignal.removeEventListener("abort", cancel);
    return Promise.reject(error);
  }
  return withAbortSignal(pending, controller.signal, message).finally(() => {
    window.clearTimeout(timer);
    parentSignal.removeEventListener("abort", cancel);
  });
}

function pendingIntentKey(actor: string, identity: string) {
  return `${PENDING_PROMPT_PREFIX}${encodeURIComponent(
    actor
  )}:${encodeURIComponent(identity)}`;
}

function readPendingPromptIntent(actor: string, identity: string) {
  const stored = window.localStorage.getItem(pendingIntentKey(actor, identity));
  if (stored === null) return undefined;
  return parsePendingPromptIntent(stored);
}

function hasPendingPromptIntent(
  actor: string,
  identity: string,
  pending: Map<string, PendingPromptIntent>
) {
  if (pending.has(`${actor}\u0000${identity}`)) return true;
  try {
    return Boolean(readPendingPromptIntent(actor, identity));
  } catch {
    return false;
  }
}

function parsePendingPromptIntent(stored: string): PendingPromptIntent {
  const intent = JSON.parse(stored) as PendingPromptIntent;
  if (
    typeof intent?.key !== "string" ||
    typeof intent?.body?.model !== "string" ||
    typeof intent?.body?.prompt !== "string" ||
    typeof intent?.body?.quote_token !== "string" ||
    !intent.choice ||
    !intent.quote
  ) {
    throw new Error("The saved AI retry request is invalid");
  }
  if (
    intent.completedAt !== undefined &&
    (typeof intent.completedAt !== "number" ||
      (intent.insertedAt === undefined &&
        typeof intent.completedResponse?.response !== "string") ||
      (intent.insertedAt !== undefined &&
        typeof intent.insertedAt !== "number"))
  )
    throw new Error("The saved AI completion is invalid");
  return intent;
}

function readPendingPromptIntents(actor: string) {
  const actorPrefix = `${PENDING_PROMPT_PREFIX}${encodeURIComponent(actor)}:`;
  const pending: { identity: string; intent: PendingPromptIntent }[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(actorPrefix)) continue;
    const identity = decodeURIComponent(key.slice(actorPrefix.length));
    const stored = window.localStorage.getItem(key);
    if (stored !== null)
      pending.push({ identity, intent: parsePendingPromptIntent(stored) });
  }
  return pending;
}

function persistPendingPromptIntent(
  actor: string,
  identity: string,
  intent: PendingPromptIntent
) {
  window.localStorage.setItem(
    pendingIntentKey(actor, identity),
    JSON.stringify(intent)
  );
}

function clearPendingPromptIntent(
  actor: string,
  identity: string,
  expectedKey?: string,
  expectedAttemptId?: string
) {
  const storageKey = pendingIntentKey(actor, identity);
  if (expectedKey !== undefined) {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return false;
    const intent = parsePendingPromptIntent(stored);
    if (
      intent.key !== expectedKey ||
      (expectedAttemptId !== undefined &&
        intent.attemptId !== expectedAttemptId)
    )
      return false;
  }
  window.localStorage.removeItem(storageKey);
  return true;
}

function archiveUnknownPromptIntent(
  actor: string,
  identity: string,
  expectedKey: string
) {
  const activeKey = pendingIntentKey(actor, identity);
  const stored = window.localStorage.getItem(activeKey);
  if (stored === null) throw new Error("The unresolved request key is missing");
  const intent = parsePendingPromptIntent(stored);
  if (intent.key !== expectedKey)
    throw new Error(
      "The active paid request changed after this outcome was reported"
    );
  const archiveKey = `${PENDING_PROMPT_PREFIX}unknown:${encodeURIComponent(
    actor
  )}:${intent.key}`;
  const archiveValue = JSON.stringify({
    key: intent.key,
    archivedAt: Date.now(),
  });
  const actorArchivePrefix = `${PENDING_PROMPT_PREFIX}unknown:${encodeURIComponent(
    actor
  )}:`;
  const archives = Array.from(
    { length: window.localStorage.length },
    (_, index) => window.localStorage.key(index)
  ).filter(
    (key): key is string =>
      key !== null && key.startsWith(actorArchivePrefix) && key !== archiveKey
  );
  while (archives.length >= MAX_UNKNOWN_PROMPT_ARCHIVES) {
    const oldest = archives.shift();
    if (oldest) window.localStorage.removeItem(oldest);
  }
  window.localStorage.setItem(archiveKey, archiveValue);
  if (window.localStorage.getItem(archiveKey) !== archiveValue)
    throw new Error("The unresolved request could not be archived");
  window.localStorage.removeItem(activeKey);
  if (window.localStorage.getItem(activeKey) !== null)
    throw new Error("The unresolved request could not be released");
}

async function pruneCompletedPromptIntents(
  actor: string,
  preserveIdentity: string,
  locks: LockManager
) {
  try {
    const activeLocks = await locks.query();
    const protectedNames = new Set(
      [...(activeLocks.held ?? []), ...(activeLocks.pending ?? [])]
        .map((lock) => lock.name)
        .filter((name): name is string => Boolean(name))
    );
    const completed = readPendingPromptIntents(actor)
      .filter(
        ({ identity, intent }) =>
          Boolean(intent.insertedAt) && identity !== preserveIdentity
      )
      .sort(
        (left, right) =>
          (left.intent.insertedAt ?? 0) - (right.intent.insertedAt ?? 0)
      );
    let remaining = readPendingPromptIntents(actor).filter(({ intent }) =>
      Boolean(intent.insertedAt)
    );
    let storedChars = remaining.reduce((total, { identity }) => {
      const stored = window.localStorage.getItem(
        pendingIntentKey(actor, identity)
      );
      return total + (stored?.length ?? 0);
    }, 0);
    const removeCompletedIfUnlocked = async (
      identity: string,
      name: string
    ) => {
      await locks.request(name, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        const stored = window.localStorage.getItem(name);
        if (stored === null) return;
        let latest: PendingPromptIntent;
        try {
          latest = parsePendingPromptIntent(stored);
        } catch {
          return;
        }
        if (!latest.insertedAt) return;
        window.localStorage.removeItem(name);
        if (window.localStorage.getItem(name) !== null) return;
        remaining = remaining.filter((item) => item.identity !== identity);
        storedChars -= stored.length;
      });
    };
    for (const { identity } of completed) {
      if (
        remaining.length <= MAX_COMPLETED_PROMPT_INTENTS &&
        storedChars <= MAX_COMPLETED_PROMPT_STORAGE_CHARS
      )
        break;
      const name = pendingIntentKey(actor, identity);
      if (protectedNames.has(name)) continue;
      await removeCompletedIfUnlocked(identity, name);
    }
  } catch {
    // Cleanup is opportunistic; unresolved entries are never pruned.
  }
}

export default function AIzPageDialog(props: Props) {
  const { state, ta, open, setOpen } = props;
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useGlobalState("loading");
  const [, setSnackbar] = useGlobalState("snackbar");
  const [currentUser] = useGlobalState("creator");
  const actor = currentUser?.id > 0 ? String(currentUser.id) : "";
  const currentActorRef = useRef(actor);
  currentActorRef.current = actor;
  const [choices, setChoices] = useState<CompletionChoice[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [choicesLoading, setChoicesLoading] = useState(false);
  const [quote, setQuote] = useState<PromptQuote | null>(null);
  const [quotedFor, setQuotedFor] = useState("");
  const [quoteError, setQuoteError] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [unknownOutcome, setUnknownOutcome] =
    useState<UnknownOutcomePrompt | null>(null);
  const unknownOutcomeRef = useRef(unknownOutcome);
  unknownOutcomeRef.current = unknownOutcome;
  const [openSessionStartedAt, setOpenSessionStartedAt] = useState(Date.now());
  const isXS = useMediaQuery("(max-width:399px)");
  const pendingIntents = useRef(new Map<string, PendingPromptIntent>());
  const activeSubmission = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const hasChosenModel = useRef(false);
  const previousDisclosure = useRef("");
  const previousQuoteToken = useRef("");
  const previousPrompt = useRef(prompt);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const selectedChoice = choices.find((choice) => choice.id === selectedModel);
  const quoteIdentity = `${selectedModel}\u0000${prompt}\u0000${CREATOR_OUTPUT_TOKENS}`;
  const pendingIdentity = actor ? `${actor}\u0000${quoteIdentity}` : "";
  let pendingIntent: PendingPromptIntent | undefined;
  let pendingStorageReadFailed = false;
  let pendingRecoveries: { identity: string; intent: PendingPromptIntent }[] =
    [];
  if (actor) {
    try {
      pendingIntent =
        pendingIntents.current.get(pendingIdentity) ??
        readPendingPromptIntent(actor, quoteIdentity);
      if (
        pendingIntent?.completedAt &&
        pendingIntent.insertedAt &&
        pendingIntent.completedAt <= openSessionStartedAt
      )
        pendingIntent = undefined;
      pendingRecoveries = readPendingPromptIntents(actor).filter(
        ({ identity, intent }) =>
          Boolean(
            intent.completedAt && !intent.insertedAt && intent.completedResponse
          ) ||
          (identity !== quoteIdentity &&
            (!intent.completedAt || intent.completedAt >= openSessionStartedAt))
      );
    } catch {
      pendingStorageReadFailed = true;
    }
  }
  const disclosureChoice =
    pendingIntent?.choice ?? quote?.choice ?? selectedChoice;
  const displayedQuote = pendingIntent?.quote ?? quote;
  const displayedQuoteSignature = JSON.stringify(displayedQuote);
  useEffect(() => {
    setAcceptedTerms(false);
  }, [displayedQuoteSignature]);
  const quoteIsCurrent = Boolean(
    quote && quotedFor === quoteIdentity && prompt.trim()
  );

  const disclosureSignature = disclosureChoice
    ? JSON.stringify([
        disclosureChoice.id,
        disclosureChoice.provider,
        disclosureChoice.model,
        disclosureChoice.display_name,
        disclosureChoice.destination,
        disclosureChoice.privacy_policy_url,
      ])
    : "";
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeSubmission.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (
      previousDisclosure.current &&
      disclosureSignature !== previousDisclosure.current
    ) {
      setAcceptedTerms(false);
    }
    previousDisclosure.current = disclosureSignature;
  }, [disclosureSignature]);
  useEffect(() => {
    if (previousPrompt.current !== prompt) setAcceptedTerms(false);
    previousPrompt.current = prompt;
  }, [prompt]);

  useEffect(() => {
    if (!state) return;
    let textToUse = "";
    if (state.selectedText !== "") {
      textToUse = state.selectedText;
    } else {
      const words = state.text.substring(0, state.selection.start).split(/\s+/);
      const startIndex = Math.max(0, words.length - 100);
      textToUse = words.slice(startIndex).join(" ");
    }
    setPrompt(textToUse);
  }, [state]);

  const loadChoices = useCallback(async () => {
    setChoicesLoading(true);
    try {
      const response = await axios.get("/api/ai/creator-options/");
      const next: CompletionChoice[] = Array.isArray(response.data?.completion)
        ? response.data.completion
        : [];
      setChoices(next);
      setSelectedModel((current) => {
        if (current && next.some((choice) => choice.id === current))
          return current;
        if (
          current &&
          hasPendingPromptIntent(
            actor,
            `${current}\u0000${promptRef.current}\u0000${CREATOR_OUTPUT_TOKENS}`,
            pendingIntents.current
          )
        )
          return current;
        if (hasChosenModel.current) return "";
        hasChosenModel.current = true;
        return next[0]?.id ?? "";
      });
    } catch {
      setChoices([]);
      setSelectedModel((current) =>
        current &&
        hasPendingPromptIntent(
          actor,
          `${current}\u0000${promptRef.current}\u0000${CREATOR_OUTPUT_TOKENS}`,
          pendingIntents.current
        )
          ? current
          : ""
      );
    } finally {
      setChoicesLoading(false);
    }
  }, [actor]);

  useEffect(() => {
    if (!open) return;
    setOpenSessionStartedAt(Date.now());
    void loadChoices();
    const timer = window.setInterval(() => void loadChoices(), 60_000);
    return () => window.clearInterval(timer);
  }, [open, loadChoices]);

  useEffect(() => {
    if (!open || !selectedChoice || !prompt.trim()) {
      setQuote(null);
      setQuotedFor("");
      setQuoteError("");
      return;
    }
    let cancelled = false;
    setQuote(null);
    setQuotedFor("");
    setQuoteError("");
    setQuoteLoading(true);
    const timer = window.setTimeout(() => {
      axios
        .post("/api/ai/creator-options/", {
          model: selectedChoice.id,
          prompt,
          max_output_tokens: CREATOR_OUTPUT_TOKENS,
        })
        .then((response) => {
          if (!cancelled) {
            const nextQuote = response.data as PromptQuote;
            if (!nextQuote.choice || nextQuote.choice.id !== selectedChoice.id)
              throw new Error(
                "The quote did not include its provider disclosure"
              );
            if (
              previousQuoteToken.current &&
              nextQuote.quote_token !== previousQuoteToken.current
            ) {
              setAcceptedTerms(false);
            }
            previousQuoteToken.current = nextQuote.quote_token;
            setQuote(nextQuote);
            setQuotedFor(
              `${selectedChoice.id}\u0000${prompt}\u0000${CREATOR_OUTPUT_TOKENS}`
            );
          }
        })
        .catch(() => {
          if (!cancelled)
            setQuoteError(
              "Could not price this prompt for the selected model. No prompt was sent."
            );
        })
        .finally(() => {
          if (!cancelled) setQuoteLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, selectedChoice, prompt]);

  const insertStoredPromptReply = (
    identity: string,
    intent: PendingPromptIntent
  ) => {
    if (!ta || !actor) return;
    if (currentActorRef.current !== actor)
      throw new Error(
        "Your signed-in account changed. Return to the original account before restoring this saved AI reply."
      );
    const memoryIntent = pendingIntents.current.get(
      `${actor}\u0000${identity}`
    );
    const currentIntent =
      readPendingPromptIntent(actor, identity) ??
      (memoryIntent?.key === intent.key ? memoryIntent : undefined);
    if (!currentIntent || currentIntent.key !== intent.key)
      throw new Error(
        "The saved AI request changed before its reply was restored"
      );
    const intentToInsert = { ...currentIntent, ...intent };
    const response = intentToInsert.completedResponse;
    if (!response) throw new Error("The saved AI reply is no longer available");
    const insertionAttemptedAt = Date.now();
    intentToInsert.insertionAttemptedAt = insertionAttemptedAt;
    try {
      persistPendingPromptIntent(actor, identity, intentToInsert);
    } catch {
      delete intentToInsert.insertionAttemptedAt;
      throw new Error(
        "The saved reply was not inserted because browser storage could not prepare safe recovery. Restore storage before trying again."
      );
    }
    if (typeof response.response === "string" && response.response.trim())
      ta.replaceSelection(response.response);
    intentToInsert.insertedAt = Date.now();
    delete intentToInsert.completedResponse;
    delete intentToInsert.insertionAttemptedAt;
    try {
      persistPendingPromptIntent(actor, identity, intentToInsert);
      pendingIntents.current.delete(`${actor}\u0000${identity}`);
    } catch {
      delete intentToInsert.insertedAt;
      intentToInsert.completedResponse = response;
      intentToInsert.insertionAttemptedAt = insertionAttemptedAt;
      pendingIntents.current.set(`${actor}\u0000${identity}`, intentToInsert);
      throw new Error(
        "This reply may already be in your draft. Browser storage could not confirm insertion; review the draft before restoring it again."
      );
    }
    setOpenSessionStartedAt(Date.now());
    setSnackbar({
      message: `Free2Z AI · ${response.display_name} (${response.provider} / ${response.model}) · charged ${response.tuzis_charged} 2Z`,
      severity: "success",
      open: true,
      duration: null,
    });
  };

  const verifyAuthenticatedActor = async (
    expectedActor: string,
    action: string,
    signal: AbortSignal = new AbortController().signal
  ) => {
    const authenticated = await requestWithTimeout(
      (requestSignal) =>
        axios.get("/api/auth/user/", {
          timeout: PROMPT_ACTOR_TIMEOUT_MS,
          signal: requestSignal,
        }),
      PROMPT_ACTOR_TIMEOUT_MS,
      signal,
      "Account verification timed out. Your original retry key was kept."
    );
    if (
      currentActorRef.current !== expectedActor ||
      String(authenticated.data?.id ?? "") !== expectedActor
    )
      throw new Error(
        `Your signed-in account changed. Return to the original account before ${action}.`
      );
  };

  const handleSubmit = async () => {
    const submitStartedAt = Date.now();
    let retryIntent = pendingIntent;
    let retryAttemptId: string | undefined;
    if (
      !ta ||
      !actor ||
      pendingStorageReadFailed ||
      (!selectedChoice && !retryIntent) ||
      (!retryIntent && !quoteIsCurrent) ||
      !acceptedTerms ||
      loading
    )
      return;
    setLoading(true);
    const submissionController = new AbortController();
    activeSubmission.current = submissionController;
    const submissionTimeout = window.setTimeout(
      () => submissionController.abort(),
      PROMPT_SUBMISSION_TIMEOUT_MS
    );
    try {
      const retryWasAlreadyPending = Boolean(retryIntent);
      const lockManager = (navigator as Navigator & { locks?: LockManager })
        .locks;
      if (!lockManager)
        throw new Error(
          "This browser cannot safely coordinate paid AI requests across tabs. Update your browser before submitting."
        );
      await withAbortSignal(
        lockManager.request(
          pendingIntentKey(actor, quoteIdentity),
          { signal: submissionController.signal },
          async () => {
            if (submissionController.signal.aborted)
              throw new Error(
                "The request was cancelled. Its original retry key was kept."
              );
            await pruneCompletedPromptIntents(
              actor,
              quoteIdentity,
              lockManager
            );
            const verifyActor = () =>
              verifyAuthenticatedActor(
                actor,
                "retrying this saved AI request",
                submissionController.signal
              );
            retryIntent =
              readPendingPromptIntent(actor, quoteIdentity) ?? retryIntent;
            if (retryIntent?.completedAt) {
              if (
                retryWasAlreadyPending ||
                retryIntent.completedAt >= submitStartedAt ||
                !retryIntent.insertedAt
              ) {
                if (retryIntent.completedResponse) {
                  await verifyActor();
                  insertStoredPromptReply(quoteIdentity, retryIntent);
                } else {
                  await verifyActor();
                  retryAttemptId = crypto.randomUUID();
                  retryIntent.attemptId = retryAttemptId;
                  persistPendingPromptIntent(actor, quoteIdentity, retryIntent);
                  const replayIntent = retryIntent;
                  const replay = await requestWithTimeout(
                    (requestSignal) =>
                      axios.post("/api/ai/prompt/", replayIntent.body, {
                        timeout: PROMPT_GENERATION_TIMEOUT_MS,
                        signal: requestSignal,
                        headers: {
                          "Idempotency-Key": replayIntent.key,
                          "X-Expected-Actor": actor,
                        },
                      }),
                    PROMPT_GENERATION_TIMEOUT_MS,
                    submissionController.signal,
                    "The AI request timed out. Its original retry key was kept."
                  );
                  if (submissionController.signal.aborted)
                    throw new Error(
                      "The request timed out. Its original retry key was kept."
                    );
                  if (currentActorRef.current !== actor)
                    throw new Error(
                      "Your signed-in account changed while recovering this AI reply. Return to the original account to restore it."
                    );
                  retryIntent.completedResponse = replay.data;
                  insertStoredPromptReply(quoteIdentity, retryIntent);
                }
                setOpenSessionStartedAt(Date.now());
                setOpen(false);
                return;
              }
              clearPendingPromptIntent(actor, quoteIdentity);
              pendingIntents.current.delete(pendingIdentity);
              retryIntent = undefined;
            }
            if (
              retryIntent &&
              (JSON.stringify(retryIntent.choice) !==
                JSON.stringify(disclosureChoice) ||
                retryIntent.quote.quote_token !== displayedQuote?.quote_token ||
                retryIntent.quote.max_charge_2z !==
                  displayedQuote?.max_charge_2z)
            ) {
              pendingIntents.current.set(pendingIdentity, retryIntent);
              setAcceptedTerms(false);
              throw new Error(
                "The saved request has different provider or pricing terms. Review them and agree before retrying."
              );
            }
            if (!retryIntent) {
              if (!selectedChoice || !quote) return;
              retryIntent = {
                key: crypto.randomUUID(),
                body: {
                  model: selectedChoice.id,
                  prompt,
                  max_output_tokens: quote.requested_output_tokens,
                  quote_token: quote.quote_token,
                },
                choice: { ...disclosureChoice! },
                quote: { ...quote },
              };
              persistPendingPromptIntent(actor, quoteIdentity, retryIntent);
              pendingIntents.current.set(pendingIdentity, retryIntent);
            }
            await verifyActor();
            retryAttemptId = crypto.randomUUID();
            retryIntent.attemptId = retryAttemptId;
            persistPendingPromptIntent(actor, quoteIdentity, retryIntent);
            const requestIntent = retryIntent;
            const response = await requestWithTimeout(
              (requestSignal) =>
                axios.post("/api/ai/prompt/", requestIntent.body, {
                  timeout: PROMPT_GENERATION_TIMEOUT_MS,
                  signal: requestSignal,
                  headers: {
                    "Idempotency-Key": requestIntent.key,
                    "X-Expected-Actor": actor,
                  },
                }),
              PROMPT_GENERATION_TIMEOUT_MS,
              submissionController.signal,
              "The AI request timed out. Its original retry key was kept."
            );
            if (submissionController.signal.aborted)
              throw new Error(
                "The request timed out. Its original retry key was kept."
              );
            if (currentActorRef.current !== actor)
              throw new Error(
                "Your signed-in account changed while generating this AI reply. Return to the original account to restore it."
              );
            retryIntent.completedAt = Date.now();
            retryIntent.completedResponse = response.data;
            let completionSaved = true;
            try {
              persistPendingPromptIntent(actor, quoteIdentity, retryIntent);
            } catch {
              completionSaved = false;
            }
            const hasVisibleReply =
              typeof response.data.response === "string" &&
              response.data.response.trim().length > 0;
            let insertionAcknowledged = false;
            const insertionAttemptedAt = Date.now();
            if (hasVisibleReply && completionSaved) {
              retryIntent.insertionAttemptedAt = insertionAttemptedAt;
              try {
                persistPendingPromptIntent(actor, quoteIdentity, retryIntent);
              } catch {
                delete retryIntent.insertionAttemptedAt;
                throw new Error(
                  "The paid reply was saved but not inserted because browser storage could not prepare safe recovery. Restore storage before trying again."
                );
              }
            }
            if (hasVisibleReply) ta.replaceSelection(response.data.response);
            if (completionSaved) {
              retryIntent.insertedAt = Date.now();
              delete retryIntent.completedResponse;
              delete retryIntent.insertionAttemptedAt;
              try {
                persistPendingPromptIntent(actor, quoteIdentity, retryIntent);
                pendingIntents.current.delete(pendingIdentity);
                insertionAcknowledged = true;
              } catch {
                delete retryIntent.insertedAt;
                retryIntent.completedResponse = response.data;
                retryIntent.insertionAttemptedAt = insertionAttemptedAt;
                pendingIntents.current.set(pendingIdentity, retryIntent);
              }
            } else {
              pendingIntents.current.set(pendingIdentity, retryIntent);
            }
            setSnackbar({
              message: !hasVisibleReply
                ? `The selected model returned no visible text. The request cost ${response.data.tuzis_charged} 2Z; choose another model before retrying.`
                : completionSaved && insertionAcknowledged
                ? `Free2Z AI · ${response.data.display_name} (${response.data.provider} / ${response.data.model}) · charged ${response.data.tuzis_charged} 2Z`
                : completionSaved
                ? `Your Free2Z AI reply was inserted and charged ${response.data.tuzis_charged} 2Z, but browser storage could not confirm insertion. It may already be in the draft; save it and review before restoring again.`
                : `Your Free2Z AI reply was inserted and charged ${response.data.tuzis_charged} 2Z, but browser storage could not save recovery. Save the draft now.`,
              severity:
                completionSaved && insertionAcknowledged && hasVisibleReply
                  ? "success"
                  : "warning",
              open: true,
              duration: null,
            });
            setOpenSessionStartedAt(Date.now());
            setOpen(false);
          }
        ),
        submissionController.signal
      );
    } catch (error: any) {
      const responseStatus = error?.response?.status;
      const errorCode = error?.response?.data?.code;
      // A completed interruption has a terminal server receipt and no reply
      // to restore. Starting another generation needs a fresh key and consent.
      // Unstructured transport failures keep their exact body and retry key.
      const resolvedInterruption =
        responseStatus === 503 &&
        error?.response?.data?.charge_status === "settled" &&
        Number.isSafeInteger(error?.response?.data?.tuzis_charged) &&
        error.response.data.tuzis_charged >= 0 &&
        error?.response?.data?.response_saved === false;
      const authenticationOrActorMismatch =
        responseStatus === 401 ||
        responseStatus === 403 ||
        errorCode === "account_changed";
      if (
        responseStatus &&
        (responseStatus < 500 || resolvedInterruption) &&
        !authenticationOrActorMismatch &&
        !(
          responseStatus === 409 &&
          [
            "idempotency_mismatch",
            "request_in_progress",
            "provider_outcome_unknown",
          ].includes(errorCode)
        )
      ) {
        setAcceptedTerms(false);
        pendingIntents.current.delete(pendingIdentity);
        try {
          const lockManager = (navigator as Navigator & { locks?: LockManager })
            .locks;
          if (lockManager && retryIntent && retryAttemptId) {
            await lockManager.request(
              pendingIntentKey(actor, quoteIdentity),
              () =>
                clearPendingPromptIntent(
                  actor,
                  quoteIdentity,
                  retryIntent?.key,
                  retryAttemptId
                )
            );
          }
        } catch {
          // A retained key is safe and cannot create another charge.
        }
      }
      if (
        mounted.current &&
        responseStatus === 409 &&
        errorCode === "provider_outcome_unknown"
      )
        if (retryIntent)
          setUnknownOutcome({
            actor,
            identity: quoteIdentity,
            key: retryIntent.key,
          });
      if (mounted.current)
        setSnackbar({
          message:
            error?.response?.data?.detail ||
            error?.message ||
            "Text generation failed. The selected model was not changed; review its availability and retry or choose another model.",
          severity: "error",
          open: true,
          duration: null,
        });
    } finally {
      window.clearTimeout(submissionTimeout);
      if (activeSubmission.current === submissionController)
        activeSubmission.current = null;
      setLoading(false);
    }
  };

  const handleClose = () => {
    activeSubmission.current?.abort();
    setOpen(false);
  };

  const acknowledgeUnknownOutcome = async () => {
    const acknowledged = unknownOutcome;
    if (!acknowledged || actor !== acknowledged.actor) return;
    const lockManager = (navigator as Navigator & { locks?: LockManager })
      .locks;
    if (!lockManager) return;
    try {
      await lockManager.request(
        pendingIntentKey(acknowledged.actor, acknowledged.identity),
        () => {
          archiveUnknownPromptIntent(
            acknowledged.actor,
            acknowledged.identity,
            acknowledged.key
          );
          pendingIntents.current.delete(
            `${acknowledged.actor}\u0000${acknowledged.identity}`
          );
        }
      );
      if (unknownOutcomeRef.current?.key === acknowledged.key) {
        setUnknownOutcome(null);
        setAcceptedTerms(false);
        setSnackbar({
          message:
            "The unresolved request key was preserved. Review the balance and confirm the provider terms again before a new paid attempt.",
          severity: "warning",
          open: true,
          duration: null,
        });
      }
    } catch {
      if (unknownOutcomeRef.current?.key === acknowledged.key) {
        setSnackbar({
          message:
            "The unresolved request could not be preserved in browser storage. No new request was sent.",
          severity: "error",
          open: true,
          duration: null,
        });
      }
    }
  };

  if (!state || !ta) return null;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      fullWidth
      maxWidth="md"
      fullScreen={isXS}
    >
      <DialogContent sx={{ display: "grid", gap: 2 }}>
        <TextField
          autoFocus
          fullWidth
          label="Prompt"
          multiline
          minRows={3}
          maxRows={18}
          variant="outlined"
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            setAcceptedTerms(false);
          }}
          helperText="Your prompt is sent only after you review the destination and price."
          InputProps={{
            endAdornment: prompt && (
              <InputAdornment position="start">
                <IconButton
                  aria-label="Clear prompt"
                  onClick={() => {
                    setPrompt("");
                    setAcceptedTerms(false);
                  }}
                >
                  <Delete />
                </IconButton>
              </InputAdornment>
            ),
          }}
        />
        {pendingRecoveries.map(({ identity, intent }) => (
          <Alert
            key={identity}
            severity="warning"
            action={
              <Button
                color="inherit"
                size="small"
                onClick={() => {
                  if (
                    intent.completedAt &&
                    !intent.insertedAt &&
                    intent.completedResponse
                  ) {
                    const lockManager = (
                      navigator as Navigator & { locks?: LockManager }
                    ).locks;
                    if (!lockManager || !actor) {
                      setSnackbar({
                        message:
                          "This browser cannot safely restore the saved AI reply. Update your browser before continuing.",
                        severity: "error",
                        open: true,
                        duration: null,
                      });
                      return;
                    }
                    void lockManager
                      .request(pendingIntentKey(actor, identity), async () => {
                        await verifyAuthenticatedActor(
                          actor,
                          "restoring this saved AI reply"
                        );
                        if (currentActorRef.current !== actor)
                          throw new Error(
                            "Your signed-in account changed before this saved AI reply was restored"
                          );
                        const currentIntent = readPendingPromptIntent(
                          actor,
                          identity
                        );
                        if (!currentIntent || currentIntent.key !== intent.key)
                          throw new Error(
                            "The saved AI request changed before its reply was restored"
                          );
                        insertStoredPromptReply(identity, currentIntent);
                      })
                      .catch((error: any) => {
                        setSnackbar({
                          message: error?.message?.includes(
                            "may already be in your draft"
                          )
                            ? error.message
                            : "The saved AI request changed in another tab. Reload the dialog before restoring a reply.",
                          severity: "warning",
                          open: true,
                          duration: null,
                        });
                      });
                    return;
                  }
                  hasChosenModel.current = true;
                  setSelectedModel(intent.body.model);
                  setPrompt(intent.body.prompt);
                  setAcceptedTerms(false);
                }}
              >
                {intent.completedAt &&
                !intent.insertedAt &&
                intent.completedResponse
                  ? intent.insertionAttemptedAt
                    ? "Restore reply (may duplicate)"
                    : "Restore completed reply"
                  : "Restore original request"}
              </Button>
            }
          >
            {intent.completedAt &&
            !intent.insertedAt &&
            intent.completedResponse
              ? intent.insertionAttemptedAt
                ? `The ${intent.choice.display_name} reply may already be in your draft. Restoring it can insert a duplicate; check the draft before continuing.`
                : `A completed ${intent.choice.display_name} reply is saved. Restore it to the editor before starting another paid request.`
              : `An unfinished request for ${intent.choice.display_name} is saved, including its original prompt and retry key. Restore it to check the original outcome before starting another paid request.`}
          </Alert>
        ))}
        {choicesLoading && choices.length === 0 ? (
          <Typography role="status">Checking available models…</Typography>
        ) : choices.length > 0 || pendingIntent ? (
          <>
            <FormControl fullWidth>
              <InputLabel id="creator-ai-model-label">Text model</InputLabel>
              <Select
                labelId="creator-ai-model-label"
                id="creator-ai-model"
                value={selectedModel}
                label="Text model"
                onChange={(event) => {
                  hasChosenModel.current = true;
                  setSelectedModel(event.target.value);
                  setAcceptedTerms(false);
                }}
              >
                {!selectedModel && (
                  <MenuItem value="" disabled>
                    Select a model
                  </MenuItem>
                )}
                {choices.map((choice) => (
                  <MenuItem key={choice.id} value={choice.id}>
                    {choice.id === disclosureChoice?.id
                      ? `${disclosureChoice.display_name} · ${disclosureChoice.provider}`
                      : `${choice.display_name} · ${choice.provider}`}
                  </MenuItem>
                ))}
                {pendingIntent &&
                  !choices.some(
                    (choice) => choice.id === pendingIntent?.choice.id
                  ) && (
                    <MenuItem value={pendingIntent.choice.id} disabled>
                      {pendingIntent.choice.display_name} · unavailable; retry
                      original request
                    </MenuItem>
                  )}
              </Select>
            </FormControl>
            {disclosureChoice ? (
              <Alert severity="info" aria-live="polite">
                <Typography variant="body2">
                  Free2Z AI · Prompt sent to {disclosureChoice.destination} ·{" "}
                  {disclosureChoice.provider} / {disclosureChoice.model}
                </Typography>
                <Typography variant="body2">
                  {pendingIntent
                    ? `Retrying the original quote: maximum hold ${
                        displayedQuote!.max_charge_2z
                      } 2Z.`
                    : quoteLoading
                    ? "Calculating maximum hold…"
                    : quoteIsCurrent
                    ? `Maximum hold: ${
                        quote!.max_charge_2z
                      } 2Z; final charge may be lower and is shown after generation.`
                    : "A maximum hold is calculated for this exact prompt before submission."}
                </Typography>
                <Typography variant="body2">
                  Availability: {disclosureChoice.availability}
                </Typography>
                <Typography variant="body2">
                  {disclosureChoice.queue}
                </Typography>
                <Typography variant="body2">
                  Provider retention follows its published policy; Free2Z does
                  not control provider retention settings.{" "}
                  <Link
                    href={disclosureChoice.privacy_policy_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Provider privacy policy
                  </Link>
                  {" · "}
                  <Link href="/docs/legal/privacy-policy/">
                    Free2Z privacy policy
                  </Link>
                </Typography>
              </Alert>
            ) : (
              <Alert severity="warning" role="status">
                The previous model is no longer available. Select another model
                to continue.
              </Alert>
            )}
            {selectedChoice && quoteError && !pendingIntent && (
              <Alert severity="error" role="alert">
                {quoteError}
              </Alert>
            )}
            {pendingStorageReadFailed && (
              <Alert severity="error" role="alert">
                A saved AI request could not be read safely. Restore browser
                storage before retrying; no new request was sent.
              </Alert>
            )}
            {unknownOutcome?.actor === actor && (
              <Alert
                severity="warning"
                role="alert"
                action={
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => void acknowledgeUnknownOutcome()}
                  >
                    I checked my balance; allow a new paid attempt
                  </Button>
                }
              >
                The previous provider outcome is unknown. Its original retry key
                remains saved. Check your balance before authorizing another
                request.
              </Alert>
            )}
            {!actor && (
              <Alert severity="warning" role="status">
                Sign in before submitting a paid AI request.
              </Alert>
            )}
            {disclosureChoice && (
              <FormControlLabel
                control={
                  <Checkbox
                    checked={acceptedTerms}
                    onChange={(event) => setAcceptedTerms(event.target.checked)}
                  />
                }
                label={`I agree to send this prompt to ${disclosureChoice.destination} under the displayed pricing and provider policy.`}
              />
            )}
          </>
        ) : (
          <Alert severity="warning" role="status">
            No text models are currently available. No prompt was sent.
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button color="warning" onClick={handleClose}>
          Close
        </Button>
        <Button
          onClick={() => void handleSubmit()}
          disabled={
            loading ||
            !actor ||
            pendingStorageReadFailed ||
            choicesLoading ||
            (!selectedChoice && !pendingIntent) ||
            (!pendingIntent && !quoteIsCurrent) ||
            (!pendingIntent && quoteLoading) ||
            (!pendingIntent && Boolean(quoteError)) ||
            !acceptedTerms
          }
          startIcon={loading ? <CircularProgress size={16} /> : undefined}
        >
          {pendingIntent ? "Retry original request" : "Get AI Text"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
