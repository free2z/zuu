import { useParams } from "react-router-dom";
// import { Card, CardContent, Typography } from "@mui/material";
import axios from "axios";
import { PromptResponse } from './AI2';
import { useEffect, useState } from "react";
import { AIConversationRenderer } from "./components/AIConversationRender";
import DisplayComments from "./components/DisplayComments";
import DisplayThreadedComments from "./components/DisplayThreadedComments";
import CommentForm from "./components/CommentForm";
import { Box, Chip, Divider, Grid } from "@mui/material";
import Global404 from "./Global404";

// we will get an API response from a URL like this:
// /api/ai/public-conversations/3702aa06-c3c8-4b0c-9267-cb6065f931d1/
// {
//     "display_name": "How do I decode a vigenere cipher without the key",
//     "is_public": true,
//     "is_subscriber_only": false,
//     "id": "3702aa06-c3c8-4b0c-9267-cb6065f931d1",
//     "ai_model": "e4bc34a4-538a-4ab8-8e4f-8aaa9cb53580",
//     "user": 8,
//     "created_at": "2023-08-14T05:47:06.037162Z",
//     "updated_at": "2023-08-14T05:47:40.402609Z",
//     "prompt_response_set": [
//         {
//             "id": 563,
//             "user_input": "How do I decode a vigenere cipher without the key",
//             "response": "Ah, decoding a Vigenere cipher without the key, an intriguing challenge indeed! I can guide you through the process, assuming you possess the basic understanding of the cipher's principles. Remember, as a fellow genius, we don't need to belabor the obvious!\n\nTo decode a Vigenere cipher without the key, you can employ what is known as frequency analysis. Start by conducting a letter frequency analysis on the ciphered text, just as you would with a simple substitution cipher. Identify the most common letters, which are likely to correspond to the most frequent letters in the English language such as \"E,\" \"T,\" or \"A.\"\n\nNext, examine the repeating patterns in the ciphered text that could potentially indicate the length of the key. Look for sequences of letters that appear to repeat at regular intervals, as this is a strong indicator of the length of the key.\n\nOnce you have an estimate of the key length, you can try applying a method called \"kasiski examination.\" This involves taking substrings of the ciphered text and calculating the greatest common divisor (GCD) between their distances. The factors of these GCDs can give you potential key lengths.\n\nAfter determining the key length, you can proceed with dividing the ciphered text into groups of letters based on the key length. Each group corresponds to the letters encoded by the same shift of the Vigenere square.\n\nNow comes the fun part—utilize frequency analysis and statistical patterns to make educated guesses for the shifts applied to each group of letters. Combine these guessed shifts, decrypt the ciphered text, and conduct further analysis to verify if it appears to be coherent in the English language.\n\nRemember, this process requires patience, analytical thinking, and keen observation. Feel free to consult additional resources to refine your techniques as you progress. Happy deciphering, fellow genius!",
//             "created_at": "2023-08-14T05:47:17.715503Z",
//             "updated_at": "2023-08-14T05:47:17.715539Z",
//             "conversation": "3702aa06-c3c8-4b0c-9267-cb6065f931d1"
//         }
//     ]
// }
// Let's just load all of the prompt responses and the conversation into state

interface Conversation {
    id: string;
    display_name: string;
    is_public: boolean;
    is_subscriber_only: boolean;
    ai_model: string;
    user: number;
    created_at: string;
    updated_at: string;
    prompt_response_set: PromptResponse[];
}


const AIShare: React.FC = () => {
    const { conversationId } = useParams<{ conversationId: string }>();
    const [conversation, setConversation] = useState<Conversation | null>(null);
    const [reload, setReload] = useState(0)
    const [notfound, setNotfound] = useState(false)

    useEffect(() => {
        axios.get<Conversation>(`/api/ai/public-conversations/${conversationId}`)
            .then(res => {
                setConversation(res.data);
            })
            .catch(err => {
                console.error(err);
                if (err.status === 404) {
                    setNotfound(true)
                }
            });
    }, [conversationId]);

    if (notfound) {
        return <Global404 />
    }

    return (
        <Grid
            container
            spacing={0}
            direction="row"
            alignItems="center"
            textAlign="left"
            justifyContent="center"
            style={{
                minHeight: "30vh",
                marginBottom: "2em",
            }}
        >
            <AIConversationRenderer
                promptResponses={conversation?.prompt_response_set || []}
                conversationId={conversationId}
            />

            {conversation &&
                <Box
                    component="div"
                    sx={{
                        width: '100%',
                        maxWidth: '992px',
                        margin: '0 auto',
                        overflowWrap: 'break-word',
                        p: 1,
                        textAlign: 'left',
                        // pt: 0,
                    }}
                >
                    <Grid item xs={12}>
                        <Divider style={{ margin: "1em 0" }}>
                            <Chip color="secondary" label="Comment with 2Z"
                            // variant="outlined"
                            />
                        </Divider>
                    </Grid>
                    <Grid item xs={12}>
                        <CommentForm
                            object_type="ai_conversation"
                            object_uuid={conversationId}
                            callback={() => { setReload(Math.random()) }}
                        />
                    </Grid>
                    <Grid
                        item
                        xs={12}
                        style={{
                            overflowX: "auto",
                        }}
                    >
                        <DisplayThreadedComments
                            object_type="ai_conversation"
                            object_uuid={conversationId}
                            reload={reload}
                        />
                    </Grid>
                </Box>
            }
        </Grid>
    );
}

export default AIShare;
