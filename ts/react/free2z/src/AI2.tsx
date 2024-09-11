import { Helmet } from "react-helmet-async";
import { useEffect, useReducer, useRef, useState } from 'react';
import {
    AppBar, Box, IconButton, Toolbar, Stack, Tooltip,
} from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import Footer from "./components/Footer";
import axios from 'axios';
import { useParams } from 'react-router-dom';
import {
    AIConversationRenderer, CurrentResponseRenderer
} from './components/AIConversationRender';
import AIModelSelect from './components/AIModelSelect';
import AITextarea from './components/AITextarea';
import AIConversationListDrawer, { AIConversation } from './components/AIConversationListDrawer';
import { PlayArrow } from '@mui/icons-material';
import { useGlobalState } from './state/global';
import { useTransitionNavigate } from './hooks/useTransitionNavigate';
import SimpleNavRight from './components/SimpleNavRight';
import AIPersonalityDialogButton from "./components/AIPersonalityDialogButton";
import { PublicCreator } from "./CreatorDetail";
import AIPublicFeedButton from "./components/AIPublicFeedButton";
import NeedTuziDialog from "./components/NeedTuziDialog";


export interface AIPersonality {
    id: string;
    display_name: string;
    creator: string;
    system_message: string;
}


export interface AIModel {
    id: string;
    display_name: string;
    // input_cost, output_cost, markup
    // price: number;
}

export interface PromptResponse {
    id: string;
    user_input: string;
    response: string;
    created_at?: string;
    // can be used for both live response and API response
    personality?: AIPersonality;
    user?: PublicCreator;
    ai_model?: AIModel;
}

export interface PromptResponseAPI {
    count: number;
    next: string | null;
    previous: string | null;
    results: PromptResponse[];
}

export type AIState = {
    currentConversation: AIConversation;
    promptResponses: PromptResponse[];
    currentResponse: string;
    currentInput: string;
    selectedModel: string;
    selectedPersonality: string;
    websocket: WebSocket | null;
    autoScroll: boolean;
    textAreaHeight: number;
}


export type AIAction =
    // This adds a word
    | { type: 'addMessage', message: string }
    // This completes the response
    | { type: 'completeResponse' }
    | { type: 'clearPromptResponses' }
    // This loads an entire conversation
    | { type: 'loadConversation', promptResponses: PromptResponse[] }
    // This loads more prompt responses
    | { type: 'loadPromptResponses', promptResponses: PromptResponse[] }
    // | { type: 'updateCurrentInput', currentInput: string }
    | { type: 'storeCurrentInput', userInput: string }
    | { type: 'setSelectedModel', selectedModel: string }
    | { type: 'setSelectedPersonality', selectedPersonality: string }
    | { type: 'setConversation', conversation: AIConversation }
    | { type: 'startConversation' }
    | { type: 'setWebsocket', websocket: WebSocket | null }
    | { type: 'startAutoScroll' }
    | { type: 'stopAutoScroll' }
    | { type: 'setTextAreaHeight', textAreaHeight: number }
    | { type: 'clearCurrent' }


const reducer = (state: AIState, action: AIAction): AIState => {
    switch (action.type) {
        case 'addMessage':
            // console.log('addMessage', action.message, new Date().toISOString())
            return { ...state, currentResponse: state.currentResponse + action.message };
        // case 'updateCurrentInput':
        //     // console.log('updateCrruentInput')
        //     return { ...state, currentInput: action.currentInput }
        case 'clearPromptResponses':
            // console.log('clearPromptResponses')
            return { ...state, promptResponses: [] }
        case 'completeResponse':
            // console.log('completeResponse', new Date().toISOString())
            if (!state.currentInput || !state.currentResponse) {
                return state;
            }
            return {
                ...state,
                promptResponses: [
                    ...state.promptResponses, {
                        id: '',
                        user_input: state.currentInput,
                        response: state.currentResponse,
                    }],
                currentResponse: '',
                currentInput: '',
            };
        case 'loadConversation':
            // console.log('loadConversation')
            return {
                ...state,
                promptResponses: action.promptResponses,
                currentResponse: "",
            };
        case 'loadPromptResponses':
            // console.log('loadPromptResponses')
            return {
                ...state,
                promptResponses: [
                    ...state.promptResponses,
                    ...action.promptResponses,
                ],
            }
        case 'storeCurrentInput':
            // console.log('storeCurrentInput')
            return {
                ...state,
                currentInput: action.userInput,
            }
        case 'setSelectedModel':
            // console.log('setSelectedModel')
            return {
                ...state,
                selectedModel: action.selectedModel,
            }
        case 'setSelectedPersonality':
            // console.log('setSelectedPersonality')
            return {
                ...state,
                selectedPersonality: action.selectedPersonality,
            }
        case 'setConversation':
            // console.log('setConversation', action.conversation)
            return {
                ...state,
                currentConversation: action.conversation,
            }
        case 'startConversation':
            // console.log('startConversation')
            state.websocket &&
                state.websocket.readyState === WebSocket.OPEN &&
                state.websocket.close();
            return {
                promptResponses: [],
                currentResponse: '',
                currentInput: '',
                selectedModel: '',
                selectedPersonality: '',
                currentConversation: {} as AIConversation,
                websocket: null,
                autoScroll: true,
                textAreaHeight: 0,
            }
        case 'setWebsocket':
            return {
                ...state,
                websocket: action.websocket,
            }
        case 'startAutoScroll':
            // console.log('startAutoScroll')
            return {
                ...state,
                autoScroll: true,
            }
        case 'stopAutoScroll':
            // console.log('stopAutoScroll')
            return {
                ...state,
                autoScroll: false,
            }
        case 'setTextAreaHeight':
            return {
                ...state,
                textAreaHeight: action.textAreaHeight,
            }
        case 'clearCurrent':
            return {
                ...state,
                currentResponse: '',
                // currentInput: '',
            }
        default:
            throw new Error();
    }
}


export default function AI() {
    const { conversationId } = useParams();
    const [open, setOpen] = useState(false)
    const [user, setUser] = useGlobalState('creator')
    const [authStatus, setAuthStatus] = useGlobalState('authStatus')
    const [loginModal, setLoginModal] = useGlobalState("loginModal")
    const navigate = useTransitionNavigate()
    const bottomRef = useRef<HTMLDivElement>(null);
    const outerBoxRef = useRef<HTMLDivElement>(null);

    const ws = useRef<WebSocket | null>(null);
    const [state, dispatch] = useReducer(reducer, {
        promptResponses: [],
        currentResponse: '',
        currentInput: '',
        selectedModel: '',
        selectedPersonality: '',
        currentConversation: {} as AIConversation,
        websocket: null,
        autoScroll: true,
        textAreaHeight: 0,
    })

    const loadPromptResponses = (url: string) => {
        axios.get<PromptResponseAPI>(url)
            .then(res => {
                dispatch({
                    type: 'loadPromptResponses',
                    promptResponses: res.data.results,
                });
                // If there's a next page, load it
                if (res.data.next) {
                    loadPromptResponses(res.data.next);
                }
            })
            .catch(err => {
                console.error(err);
            });
    }

    function connect(
        conversationId: string,
        onopen: (() => any) | null,
    ) {
        // Start a websocket for the conversation
        // console.log("CALLED CONNECT", conversationId)
        let wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let domain = window.location.hostname;
        let port = window.location.port ? `:${window.location.port}` : '';
        let wsUrl = `${wsProtocol}//${domain}${port}/ws/conversations/${conversationId}/`;
        if (wsProtocol === 'ws:') {
            wsUrl = `ws://${domain}:8000/ws/conversations/${conversationId}/`;
        }

        // Close the existing websocket connection if there is one
        if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
            // console.log("Closing existing websocket connection");
            state.websocket.close();
        }

        ws.current = new WebSocket(wsUrl);
        ws.current.onopen = () => {
            // console.log("ONOPEN")
            onopen && onopen()
        }
        ws.current.onmessage = (event) => {
            const data = JSON.parse(event.data);
            // console.log("MESSAGE", data)
            dispatch({ type: 'addMessage', message: data.message });
        };
        ws.current.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
        ws.current.onclose = (event) => {
            console.log('WebSocket is closed now.', event);
        };

        console.log("DISPATCHING WEBSOCKET", ws.current)
        dispatch({ type: 'setWebsocket', websocket: ws.current });
        return ws.current;
    }

    useEffect(() => {
        // console.log("USER", user)
        // console.log(conversationId, state.currentConversation.id, "!!!")
        // console.log("AI2 AUTH STATUS", authStatus)
        if (authStatus === false) {
            // console.log("setting login modal")
            setLoginModal(true)
            return
        }
        if (user.username === "") {
            // console.log("USER USERNAME EMPTY", user, "USER")
            return
        }
        // console.log("remove login modal")
        setLoginModal(false)
        // If we have a conversation ID, get the data and update state
        if (conversationId && !(state.currentConversation.id === conversationId)) {
            axios.get(`/api/ai/conversations/${conversationId}/`)
                .then(response => {
                    // Update the current conversation state
                    // console.log(response.data)
                    dispatch({ type: 'setConversation', conversation: response.data })
                    dispatch({ type: 'setSelectedModel', selectedModel: response.data.ai_model })
                    dispatch({ type: 'setSelectedPersonality', selectedPersonality: response.data.personality })
                    // Connect to the websocket
                    // console.log("CONNECTING fresh page", conversationId)
                    connect(conversationId, null);
                    dispatch({ type: 'clearPromptResponses' });
                    loadPromptResponses(
                        `/api/ai/conversations/${conversationId}/promptresponses/`
                    );
                })
                .catch(error => {
                    // Handle the error here
                    console.error(error);
                });
        } else if (!conversationId && state.currentConversation.id) {
            dispatch({ type: 'startConversation' })
        }
    }, [user, conversationId, authStatus]);

    useEffect(() => {
        if (outerBoxRef.current && state.autoScroll) {
            outerBoxRef.current.scrollTop = outerBoxRef.current.scrollHeight;
        }
    }, [state.currentResponse, state.autoScroll]);

    // Stop the auto scroll when the user scrolls
    useEffect(() => {
        const observer = new IntersectionObserver(
            entries => {
                if (!entries[0].isIntersecting) {
                    // console.log("STOPPING")
                    dispatch({ type: 'stopAutoScroll' });
                } else {
                    // console.log("STARTING")
                    dispatch({ type: 'startAutoScroll' });
                }
            },
            { threshold: 0.5 }
        );

        if (bottomRef.current) {
            observer.observe(bottomRef.current);
        }

        return () => {
            if (bottomRef.current) {
                observer.unobserve(bottomRef.current);
            }
        };
    }, []);

    if (Number(user.tuzis) < 150) {
        return <NeedTuziDialog goBackOnClose />
    }

    return (
        <>
            <Helmet>
                <title>Chat2Z - Free2Z</title>
            </Helmet>
            <AppBar
                sx={{
                    backgroundColor: 'background.paper',
                    position: 'fixed',
                    width: '100%',
                    zIndex: (theme) => theme.zIndex.drawer + 1,
                }}
                elevation={2}
            >
                <Toolbar>
                    <Box
                        component="div"
                        sx={{ display: 'flex', flexGrow: 1 }}
                    >
                        <Stack direction="row" spacing={1}>
                            <Tooltip title="Conversation History">
                                <IconButton color="primary" onClick={() => setOpen(!open)}>
                                    {open ? <ChevronLeftIcon /> : <ChevronRightIcon />}
                                </IconButton>
                            </Tooltip>
                            <AIPublicFeedButton />
                            {conversationId && (
                                <Tooltip title="Start a new conversation">
                                    <IconButton
                                        color="success"
                                        onClick={() => {
                                            navigate(`/ai`)
                                            dispatch({ type: 'startConversation' })
                                            setOpen(false)
                                        }}
                                    >
                                        <PlayArrow />
                                    </IconButton>
                                </Tooltip>
                            )}
                        </Stack>
                    </Box>
                    <SimpleNavRight />
                </Toolbar>
            </AppBar>
            <AIConversationListDrawer open={open} setOpen={setOpen} />
            <Box
                component="div"
                sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100vh', // full height
                    // height: 'calc(100vh - 54px)',
                    pt: {
                        xs: 7,
                        sm: 8, // 64px
                    },
                    // mt: 1,
                    alignItems: 'center',
                    justifyContent: 'space-between',
                }}
            >
                <Box
                    sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        width: '100%',
                        maxWidth: '992px',
                        flexGrow: 1,
                        overflow: 'auto',
                        // pt: 1,
                    }}
                    component="main"
                >
                    {/* Selectors */}
                    {!state.currentConversation.id && (
                        <Box
                            component="div"
                            sx={{
                                p: 2,
                                display: 'flex',
                                flexDirection: 'row',
                                justifyContent: 'space-between', // Added for equal spacing
                                alignItems: 'center',
                                width: '100%',
                                maxWidth: 600,
                            }}
                        >
                            {/* Select Model */}
                            <AIModelSelect
                                dispatch={dispatch}
                                selectedModel={state.selectedModel}
                            />
                            {/* Select Personality */}
                            <AIPersonalityDialogButton
                                dispatch={dispatch}
                                selectedPersonality={state.selectedPersonality}
                            />
                        </Box>
                    )}

                    <Box
                        id="ai-conversation-renderer-box"
                        component="div"
                        ref={outerBoxRef}
                        sx={{
                            width: '99%',
                            overflowY: 'auto',
                            px: 0,
                            pt: 1,
                            // account for fixed elements
                            // mb: 17,
                            mb: 17,
                            '&::-webkit-scrollbar': {
                                width: 0,
                                background: 'transparent'
                            },
                            '&::-moz-scrollbar': {
                                width: 0,
                                background: 'transparent'
                            },
                            scrollbarWidth: 'none',
                        }}
                    >
                        <AIConversationRenderer
                            promptResponses={state.promptResponses}
                        // conversationId={conversationId}
                        />
                        <CurrentResponseRenderer
                            currentResponse={state.currentResponse}
                            currentInput={state.currentInput}
                        />
                        <div ref={bottomRef} style={{
                            marginTop: "-1em",
                            marginBottom: "1em"
                        }} />
                    </Box>

                    {/* Textarea */}
                    <Box
                        component="div"
                        sx={{
                            position: 'fixed',
                            bottom: 33,
                            width: '100%',
                            maxWidth: '990px',
                            zIndex: 1000,
                            backgroundColor: 'background.paper',
                            px: 1,
                        }}
                    >
                        <AITextarea
                            connect={connect}
                            state={state}
                            dispatch={dispatch}
                            selectedModel={state.selectedModel}
                            conversationId={conversationId}
                        />
                    </Box>
                </Box>
            </Box>

            <Box
                component="div"
                sx={{
                    position: 'fixed',
                    bottom: -9,
                    width: '100%',
                    zIndex: (theme) => theme.zIndex.drawer - 1,
                }}
            >
                <Footer />
            </Box>
        </>
    );
}
