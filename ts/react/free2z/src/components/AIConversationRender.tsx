import { useMemo } from "react";
import MathMarkdown from "./MathMarkdown";
import { PromptResponse } from "../AI2";
import {
    Avatar, Box, Card, CardActions, CardHeader, Divider,
    IconButton, useMediaQuery, useTheme,
} from "@mui/material";
import { ForkLeft, Login } from "@mui/icons-material";
import axios from "axios";
import { useTransitionNavigate } from "../hooks/useTransitionNavigate";
import { useGlobalState } from "../state/global";
import { Creator } from "../Begin";
import moment from "moment";

interface AIConversationRendererProps {
    conversationId?: string;
    promptResponses: PromptResponse[];
}

interface CurrentResponseRendererProps {
    currentInput?: string;
    currentResponse?: string;
}

export function CurrentResponseRenderer(props: CurrentResponseRendererProps) {

    if (!props.currentResponse || props.currentResponse.length < 33) {
        return null;
    }
    if (!props.currentInput) {
        return null;
    }
    return (
        <Box
            component="div"
            sx={{
                width: '100%', maxWidth: '992px', margin: '0 auto',
                overflowWrap: 'break-word',
                p: 0.5,
                // mt: 1,
            }}
        >
            <MemoizedCard2
                promptResponse={{
                    user_input: props.currentInput,
                    response: props.currentResponse,
                } as PromptResponse}
            />
        </Box>
    )
}

export interface AIPersonality {
    display_name: string;
}


// This is for sharing ...
interface MemoizedCardProps2 {
    promptResponse: PromptResponse;
    creator?: Creator;
    conversationId?: string;
}

export function ForkAction(props: MemoizedCardProps2) {
    const [loginModal, setLoginModal] = useGlobalState("loginModal")

    const navigate = useTransitionNavigate()
    const { promptResponse } = props;

    if (!promptResponse.user) {
        return null;
    }
    if (!props.conversationId) {
        return null;
    }

    return (
        <CardActions
            // put to the far right
            sx={{
                display: 'flex',
                justifyContent: 'flex-end',
                alignItems: 'center',
                p: 0,
                mt: -3,
                mr: -1,
                mb: -1,
            }}
        >
            <IconButton
                onClick={() => {
                    if (!props.creator?.username) {
                        setLoginModal(true)
                    } else {
                        // use axios to POST to API and then redirect to the new conversation
                        axios.post(`/api/ai/conversations/fork/`, {
                            prompt_response: promptResponse?.id,
                            conversation: props.conversationId,
                        }).then(res => {
                            navigate(`/ai/${res.data.id}`)
                        }).catch(err => {
                            console.error(err);
                        })
                    }
                }}
            >
                {props.creator?.username ?
                    <ForkLeft
                        style={{ transform: 'rotate(180deg)' }}
                        color="primary"
                    />
                    : <Login />
                }
            </IconButton>
        </CardActions>
    )
}


export function MemoizedCard2(props: MemoizedCardProps2) {
    const theme = useTheme();
    const isSmallScreen = useMediaQuery(theme.breakpoints.down('sm'));
    const paddingSize = isSmallScreen ? 2 : 4;

    // De-structure the prompt response for ease of access
    const {
        user_input, response, user, ai_model, personality, created_at,
    } = props.promptResponse;
    const creator = props.creator;

    const cardHeader = user ? (
        <CardHeader
            // action={<ForkAction promptResponse={props.promptResponse} />}
            avatar={
                <Avatar
                    src={user?.avatar_image?.thumbnail}
                />
            }
            title={user?.username}
            subheader={`${ai_model?.display_name} | ${personality?.display_name} | ${moment(created_at).fromNow()}`}
        />
    ) : null;

    return useMemo(() => (
        <Card sx={{ py: 1, px: paddingSize, my: 1, mx: 0, pb: 2 }}>
            {cardHeader}
            <MathMarkdown content={user_input} />
            <Divider variant="fullWidth" />
            <MathMarkdown content={response} />
            <ForkAction
                promptResponse={props.promptResponse}
                creator={creator}
                conversationId={props.conversationId}
            />
        </Card>
    ), [user_input, response, cardHeader, creator]);
}


export function AIConversationRenderer(props: AIConversationRendererProps) {
    const [creator, setCreator] = useGlobalState("creator")

    return (
        <Box
            component="div"
            sx={{
                width: '100%',
                maxWidth: '1024px',
                margin: '0 auto',
                overflowWrap: 'break-word',
                p: 0.5,
                textAlign: 'left',
            }}
        >
            {props.promptResponses.map((response, index) => {
                if (response.user_input && response.response) {
                    return <MemoizedCard2
                        key={index}
                        promptResponse={response}
                        conversationId={props.conversationId}
                        creator={creator}
                    />
                }
            }
            )}
        </Box>
    )
}
