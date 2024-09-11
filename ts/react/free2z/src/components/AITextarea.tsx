import axios from "axios"
import { useState } from "react"
import { useQueryClient } from "react-query";
import { IconButton, InputAdornment, Stack, TextField } from "@mui/material";

import { AIAction, AIState } from "../AI2"
import { useGlobalState } from "../state/global";
import { Send } from "@mui/icons-material";
import AIEditConversation from "./AIEditConversation";
import { useTransitionNavigate } from "../hooks/useTransitionNavigate";

const GENERIC_ERROR_MESSAGE = "There was a problem getting the response! Ensure you have at least 100 tuzi balance and that your input is not too long. Sorry about that!"

interface AITextareaProps {
    selectedModel: string;
    conversationId?: string;
    connect: (
        conversationId: string,
        onopen: (() => any) | null,
    ) => void
    state: AIState,
    dispatch: React.Dispatch<AIAction>
}


export default function AITextarea(props: AITextareaProps) {
    const queryClient = useQueryClient();
    const [userInput, setUserInput] = useState("");
    const [loading, setLoading] = useState(false);

    const [snack, setSnack] = useGlobalState("snackbar")
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
                    axios.post(`/api/ai/conversations/${res.data.id}/promptresponses/`, {
                        user_input: userInput,
                    }).then(res => {
                        // console.log("THEN")
                        props.dispatch({
                            type: 'loadConversation',
                            promptResponses: [res.data],
                        })
                        props.dispatch({ type: 'completeResponse' })
                        setUserInput("");
                        setLoading(false);
                        navigate(`/ai/${cId}`);
                    }).catch(err => {
                        console.error(err);
                        setSnack({
                            open: true,
                            severity: "error",
                            message: GENERIC_ERROR_MESSAGE,
                            duration: null,
                        })
                        setLoading(false);
                        navigate(`/ai/${cId}`);
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
                try {
                    props.dispatch({ type: 'clearCurrent' })
                    const res = await axios.post(`/api/ai/conversations/${props.conversationId}/promptresponses/`, {
                        user_input: userInput,
                        // Add other necessary parameters
                    });
                    setLoading(false);
                    setUserInput("");
                    // TODO: how to properly let the websocket finish?
                    // props.dispatch({ type: 'completeResponse' })
                    setTimeout(() => {
                        props.dispatch({ type: 'completeResponse' })
                    }, 3777)
                } catch (err) {
                    console.error(err);
                    setSnack({
                        open: true,
                        severity: "error",
                        message: GENERIC_ERROR_MESSAGE,
                        duration: null,
                    })
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
            //     // opacity: loading ? 0.5 : 1,
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
