import axios from "axios"
import { useState } from "react"
import { useQueryClient } from "react-query";
import { IconButton, InputAdornment, Stack, TextField } from "@mui/material";

import type { AIAction, AIState } from "../aiState"
import { mintKey } from "../subscribeIdempotency";
import { useGlobalState } from "../state/global";
import { Send } from "@mui/icons-material";
import AIEditConversation from "./AIEditConversation";
import { useTransitionNavigate } from "../hooks/useTransitionNavigate";

const GENERIC_ERROR_MESSAGE = "There was a problem getting the response! Ensure you have at least 100 2Z and that your input is not too long. Sorry about that!"

// Statuses where the server deliberately writes copy meant for the reader.
// 402/403 on this endpoint are the "not enough 2Z for this request" family,
// and the 402 body names the exact number of 2Z this prompt on
// this model can use — which is the ONLY way a reader can tell "shorten the
// conversation or pick a lighter model" apart from "the service is down".
// Swallowing it into GENERIC_ERROR_MESSAGE turns an actionable refusal into an
// apparent outage the reader retries forever. Found by the codex adversarial
// review.
const READABLE_ERROR_STATUSES = [402, 403]
const MAX_SERVER_DETAIL_LENGTH = 300

type PendingGeneration = {
    input: string;
    key: string;
    attempt: number;
    accountId: string;
    conversationId?: string;
    storageKey?: string;
    modelId?: string;
};

// Never evict an ambiguous operation to make room. If a tab reaches this
// limit, fail closed until the user resolves one of its pending requests.
const MAX_PENDING_GENERATIONS = 32;
const pendingGenerations = new Map<string, PendingGeneration>();

const generationInputFingerprint = (input: string) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
        hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193);
    }
    return `${input.length}:${hash >>> 0}`;
};

const generationIdentity = (accountId: string, conversationId?: string) =>
    JSON.stringify([accountId, conversationId || ""]);

const generationKeyStorage = (accountId: string, conversationId: string) =>
    `f2z:ai-pending-generation:${accountId}:${conversationId}`;

function readStoredGeneration(storageKey?: string, accountId?: string): {
    input: string;
    key: string;
    prompt?: string;
    modelId?: string;
} | null {
    if (!storageKey) return null
    try {
        const stored = window.sessionStorage.getItem(storageKey)
        if (!stored) return null
        const pending = JSON.parse(stored)
        return pending.accountId === accountId
            && typeof pending.input === 'string'
            && typeof pending.key === 'string'
            ? pending
            : null
    } catch {
        // Storage can be disabled by browser policy. The module-level key
        // protects retries for this document, across component remounts.
        return null
    }
}

function storeGenerationKey(
    storageKey: string | undefined,
    accountId: string,
    input: string,
    key: string,
    modelId: string,
) {
    if (!storageKey) return
    try {
        window.sessionStorage.setItem(storageKey, JSON.stringify({
            accountId,
            input: generationInputFingerprint(input),
            key,
            modelId,
            // Keep the unresolved prompt only in this tab's session so a
            // reload can restore it before the user retries the same turn.
            prompt: input,
        }))
    } catch {
        // Persistence is best effort; never block a generation request on it.
    }
}

function removeGenerationKey(storageKey?: string) {
    if (!storageKey) return
    try {
        window.sessionStorage.removeItem(storageKey)
    } catch {
        // The request outcome is already known, so a stale key is harmless.
    }
}

// Deliberately duck-typed rather than `axios.isAxiosError`: this app pins
// axios ^0.26 and the helper's typing has moved between majors. A network
// failure has no `response` at all and falls through to the generic message.
function errorMessage(err: any): string {
    const response = err?.response
    if (!response) {
        return GENERIC_ERROR_MESSAGE
    }
    const detail = response.data?.detail
    if (typeof detail !== "string" || !detail.trim()) {
        return GENERIC_ERROR_MESSAGE
    }
    if ([409, 503].includes(response.status)
        && ["settled", "not_charged"].includes(
            response.data?.charge_status)) {
        return detail.trim().slice(0, MAX_SERVER_DETAIL_LENGTH)
    }
    if (!READABLE_ERROR_STATUSES.includes(response.status)) {
        return GENERIC_ERROR_MESSAGE
    }
    return detail.trim().slice(0, MAX_SERVER_DETAIL_LENGTH)
}

interface AITextareaProps {
    selectedModel: string;
    conversationId?: string;
    isCurrentGeneration: (
        conversationId: string,
        streamId: string,
    ) => boolean;
    connect: (
        conversationId: string,
        onopen: (() => any) | null,
    ) => void
    state: AIState,
    dispatch: React.Dispatch<AIAction>
}


export default function AITextarea(props: AITextareaProps) {
    const [creator] = useGlobalState("creator")
    const accountId = String(creator?.id ?? "")

    const generationKeyFor = (
        input: string,
        conversationId?: string,
        modelId = props.selectedModel,
    ) => {
        const identity = generationIdentity(accountId, conversationId)
        const storageKey = conversationId
            ? generationKeyStorage(accountId, conversationId)
            : undefined
        const current = pendingGenerations.get(identity)
        const stored = current ? null : readStoredGeneration(storageKey, accountId)
        const existing = current || (stored ? {
            input: stored.prompt || input,
            key: stored.key,
            attempt: 0,
            accountId,
            conversationId,
            storageKey,
            modelId: stored.modelId || modelId,
        } : null)

        // Never discard an unresolved operation when a different prompt is
        // submitted. Resolve it with the same prompt first; otherwise a lost
        // successful response could be charged a second time.
        if (existing && (existing.input !== input
            || (stored && stored.input !== generationInputFingerprint(input)))) {
            pendingGenerations.set(identity, existing)
            return null
        }

        if (existing) {
            const pending = { ...existing, attempt: existing.attempt + 1 }
            pendingGenerations.set(identity, pending)
            return { key: pending.key, attempt: pending.attempt }
        }

        if (pendingGenerations.size >= MAX_PENDING_GENERATIONS) {
            return null
        }
        const pending: PendingGeneration = {
            input,
            key: mintKey(),
            attempt: 1,
            accountId,
            conversationId,
            storageKey,
            modelId,
        }
        pendingGenerations.set(identity, pending)
        storeGenerationKey(storageKey, accountId, input, pending.key, modelId)
        return { key: pending.key, attempt: pending.attempt }
    }

    const finishGenerationKey = (
        generation: { key: string; attempt: number },
        err?: any,
    ) => {
        const response = err?.response
        const chargeStatus = response?.data?.charge_status
        const outcomeKnown = chargeStatus === "settled"
            || (chargeStatus === "not_charged")
        // A refusal (429, auth failure, etc.) only describes this retry. The
        // earlier request may still have committed, so retain its key until a
        // successful response or an explicit charge outcome resolves it.
        if (!err || outcomeKnown) {
            let resolvedIdentity: string | undefined
            pendingGenerations.forEach((pending, identity) => {
                // A stale no-charge response can arrive after a newer attempt
                // reused this key. That newer attempt may have charged and
                // lost its response, so only its own no-charge result clears it.
                const currentAttempt = pending.attempt === generation.attempt
                if (pending.key === generation.key
                    && (chargeStatus !== "not_charged" || currentAttempt)) {
                    removeGenerationKey(pending.storageKey)
                    resolvedIdentity = identity
                }
            })
            if (resolvedIdentity !== undefined) {
                pendingGenerations.delete(resolvedIdentity)
                return true
            }
        }
        return false
    }

    const modelForGenerationKey = (key: string) => {
        let modelId = props.selectedModel
        pendingGenerations.forEach((pending) => {
            if (pending.key === key) modelId = pending.modelId || modelId
        })
        return modelId
    }

    const queryClient = useQueryClient();
    const [userInput, setUserInput] = useState("");
    const [loading, setLoading] = useState(false);

    const [, setSnack] = useGlobalState("snackbar")
    const navigate = useTransitionNavigate()

    const handleUserInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setUserInput(event.target.value);
    };

    const handleUserInputSubmit = async () => {
        // We have no conversationId,
        // so we need to create a new conversation
        setLoading(true);
        props.dispatch({
            type: 'storeCurrentInput',
            userInput: userInput,
        })
        props.dispatch({ type: 'startAutoScroll' })
        if (!props.conversationId && userInput.length > 0) {
            // console.log("No conversationId");
            // Create a new conversation
            try {
                const res = await axios.post('/api/ai/conversations/', {
                    ai_model: props.selectedModel,
                    personality: props.state.selectedPersonality,
                    display_name: userInput.length > 190 ?
                        `${userInput.substring(0, 190)}...` : userInput,
                });
                props.dispatch({
                    type: 'setConversation',
                    conversation: res.data,
                })
                queryClient.invalidateQueries('conversations');

                let cId = res.data.id;

                // window.history.pushState(null, '', `/ai/${res.data.id}`);
                // CONNECT TO SOCKET and then create prompt response
                props.connect(res.data.id, () => {
                    console.log("OPEN WEBSOCKET")
                    props.dispatch({ type: 'clearCurrent' })
                    const conversationId = res.data.id
                    const generation = generationKeyFor(
                        userInput, conversationId)
                    if (!generation) {
                        setLoading(false)
                        setSnack({
                            open: true,
                            severity: "error",
                            message: "A previous AI request has an unknown outcome. Retry that exact prompt before starting another turn.",
                            duration: null,
                        })
                        return
                    }
                    const idempotencyKey = generation.key
                    props.dispatch({ type: 'beginGeneration', streamId: idempotencyKey })
                    // The key is stored by generationKeyFor above. Put the new
                    // conversation id in browser history before starting the
                    // billable POST, so reload recovery can find that key.
                    navigate(`/ai/${cId}`);
                    axios.post(`/api/ai/conversations/${res.data.id}/promptresponses/`, {
                        user_input: userInput,
                    }, { headers: {
                        "Idempotency-Key": idempotencyKey,
                        "X-AI-Generation-Model": modelForGenerationKey(idempotencyKey),
                    } }).then(promptResponse => {
                        const resolved = finishGenerationKey(generation)
                        if (resolved && props.isCurrentGeneration(cId, idempotencyKey)) {
                            props.dispatch({
                                type: 'loadConversation',
                                conversationId: cId,
                                streamId: idempotencyKey,
                                promptResponses: [promptResponse.data],
                            })
                            props.dispatch({ type: 'completeResponse' })
                            setUserInput("");
                        }
                        setLoading(false);
                    }).catch(err => {
                        finishGenerationKey(generation, err)
                        console.error(err);
                        if (props.isCurrentGeneration(cId, idempotencyKey)) {
                            setSnack({
                                open: true,
                                severity: "error",
                                message: errorMessage(err),
                                duration: null,
                            })
                        }
                        setLoading(false);
                    });
                })
            } catch (err) {
                console.error(err);
            }
        } else {
            // console.log("HAS conversationId", props.conversationId);

            // Post the user input to the prompt responses endpoint
            // for the conversation
            try {
                setLoading(true);
                const conversationId = props.conversationId
                if (!conversationId) {
                    setLoading(false)
                    return
                }
                const generation = generationKeyFor(
                    userInput, conversationId)
                if (!generation) {
                    const unresolvedInput = pendingGenerations.get(
                        generationIdentity(accountId, conversationId),
                    )?.input
                    if (unresolvedInput) setUserInput(unresolvedInput)
                    setLoading(false)
                    setSnack({
                        open: true,
                        severity: "error",
                        message: "A previous AI request has an unknown outcome. Retry that exact prompt before starting another turn.",
                        duration: null,
                    })
                    return
                }
                const idempotencyKey = generation.key
                try {
                    props.dispatch({ type: 'clearCurrent' })
                    props.dispatch({ type: 'beginGeneration', streamId: idempotencyKey })
                    const promptResponse = await axios.post(`/api/ai/conversations/${props.conversationId}/promptresponses/`, {
                        user_input: userInput,
                        // Add other necessary parameters
                    }, { headers: {
                        "Idempotency-Key": idempotencyKey,
                        "X-AI-Generation-Model": modelForGenerationKey(idempotencyKey),
                    } });
                    const resolved = finishGenerationKey(generation)
                    if (resolved && props.isCurrentGeneration(
                        conversationId, idempotencyKey,
                    )) {
                        props.dispatch({
                            type: 'settlePromptResponse',
                            conversationId,
                            streamId: idempotencyKey,
                            promptResponse: promptResponse.data,
                        })
                        setUserInput("");
                    }
                    setLoading(false);
                } catch (err) {
                    finishGenerationKey(generation, err)
                    console.error(err);
                    if (props.isCurrentGeneration(
                        conversationId, idempotencyKey,
                    )) {
                        setSnack({
                            open: true,
                            severity: "error",
                            message: errorMessage(err),
                            duration: null,
                        })
                    }
                    setLoading(false);
                }
            } catch (err) {
                console.error(err);
            }
        }
    };

    return (
        <TextField
            // ref={textAreaRef}
            fullWidth
            multiline
            // sx={{
            //     // opacity: loading ? 0.5: 1,
            //     // opacity: 0.5,
            // }}
            // rows={3}
            maxRows={loading ? 3 : 16}
            minRows={3}
            placeholder="Prompt the AI"
            variant="outlined"
            value={userInput}
            onChange={handleUserInputChange}
            onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    handleUserInputSubmit();
                }
            }}
            disabled={loading}
            InputProps={{
                endAdornment: (
                    <InputAdornment position="end">
                        <Stack direction="column">
                            {props.conversationId && (
                                <AIEditConversation
                                    conversationId={props.conversationId}
                                    state={props.state}
                                    dispatch={props.dispatch}
                                />
                            )}
                            <IconButton
                                onClick={handleUserInputSubmit}
                                disabled={loading}
                            >
                                <Send color={loading ? "disabled" : "success"} />
                            </IconButton>
                        </Stack>
                    </InputAdornment>
                )
            }}
        />
    )
}
