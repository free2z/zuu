import { Settings } from "@mui/icons-material";
import {
    FormControl, IconButton, InputLabel, MenuItem, Select,
    SelectChangeEvent, Stack, useMediaQuery,
} from "@mui/material";
import React, { Dispatch, useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import axios from 'axios';
import { AIAction, AIState } from "../AI2";
import { useQueryClient } from "react-query";
import ShareConversation from "./ShareCoversation";
import AIModelSelect from "./AIModelSelect";
import AIPersonalityDialogButton from "./AIPersonalityDialogButton";


export interface AIConversationFormValues {
    display_name: string;
    is_public: boolean;
    is_subscriber_only: boolean;
    ai_model?: string;
    personality?: string;
}

interface AIEditConversationProps {
    conversationId: string
    state: AIState
    dispatch: Dispatch<AIAction>
}


export default function AIEditConversation(props: AIEditConversationProps) {
    const { state, dispatch, conversationId } = props
    const queryClient = useQueryClient()
    const [open, setOpen] = useState(false);
    const [visibility, setVisibility] = useState(
        'private' as 'private' | 'public' | 'members');

    const [update, setUpdate] = useState(0);

    const [values, setValues] = useState<AIConversationFormValues>({
        display_name: "",
        is_public: false,
        is_subscriber_only: false,
        // ai_model: "",
        // personality: "",
    });

    const isXS = useMediaQuery('(max-width:399px)');

    const handleClickOpen = () => {
        setOpen(true);
    };

    const handleClose = () => {
        setOpen(false);
    };

    const handleSave = async () => {
        try {
            const res = await axios.patch(`/api/ai/conversations/${conversationId}/`, {
                ...values,
                ai_model: state.selectedModel,
                personality: state.selectedPersonality,
            });
            dispatch({
                type: "setConversation",
                conversation: res.data,
            });
            // setOpen(false);
        } catch (err) {
            console.error(err);
        }
    };

    const handleVisibilityChange = (event: SelectChangeEvent) => {
        setVisibility(event.target.value as 'private' | 'public' | 'members');

        switch (event.target.value) {
            case 'public':
                setValues({
                    ...values,
                    is_public: true,
                    is_subscriber_only: false,
                })
                break;
            case 'members':
                setValues({
                    ...values,
                    is_public: false,
                    is_subscriber_only: true,
                })
                break;
            default:
                setValues({
                    ...values,
                    is_public: false,
                    is_subscriber_only: false,
                })
                break;
        }
        setUpdate(update + 1)
    };

    // Save automatically dwhen values change
    useEffect(() => {
        if (update === 0) return
        handleSave()
    }, [update]);

    const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setValues({
            ...values,
            display_name: event.target.value,
        });
    };

    useEffect(() => {
        if (state.currentConversation) {
            const cc = state.currentConversation
            setValues({
                display_name: state.currentConversation.display_name,
                is_public: state.currentConversation.is_public,
                is_subscriber_only: state.currentConversation.is_subscriber_only,
            });
            if (cc.is_public) {
                setVisibility('public')
            } else if (cc.is_subscriber_only) {
                setVisibility('members')
            } else {
                setVisibility('private')
            }
        }
    }, [state.currentConversation])

    return (
        <>
            <IconButton onClick={handleClickOpen}>
                <Settings color="info" />
            </IconButton>
            <Dialog open={open} onClose={handleClose}
                maxWidth='md'
                fullWidth={true}
                fullScreen={isXS}
            >
                <DialogTitle>Conversation Settings</DialogTitle>
                <DialogContent>
                    <Stack direction="column" spacing={2}>
                        <TextField
                            autoFocus
                            style={{ marginTop: "1em" }}
                            // margin="dense"
                            name="display_name"
                            label="Display Name"
                            type="text"
                            fullWidth
                            value={values.display_name}
                            onChange={handleInputChange}
                        />
                        <Stack direction="row" spacing={3}>
                            <AIModelSelect
                                dispatch={dispatch}
                                selectedModel={state.selectedModel}
                            />
                            <AIPersonalityDialogButton
                                dispatch={dispatch}
                                selectedPersonality={state.selectedPersonality}
                            />
                        </Stack>
                        <FormControl fullWidth>
                            <InputLabel id="visibility-select-label">Visibility</InputLabel>
                            <Select
                                labelId="visibility-select-label"
                                id="visibility-select"
                                value={visibility}
                                onChange={handleVisibilityChange}
                                label="Visibility"
                            >
                                <MenuItem value={'private'}>Private (Only You Can See)</MenuItem>
                                <MenuItem value={'public'}>Public (Listed/Discoverable)</MenuItem>
                                {/* <MenuItem value={'members'}>Members Only</MenuItem> */}
                            </Select>
                        </FormControl>

                        {visibility !== 'private' && (
                            <Stack direction="row" spacing={2}>
                                {/* // Share to public view url */}
                                <ShareConversation
                                    conversationId={conversationId}
                                    title={values.display_name}
                                />
                            </Stack>
                        )}
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleClose}>Close</Button>
                    <Button onClick={() => {
                        handleSave()
                        setOpen(false)
                        queryClient.invalidateQueries('conversations')
                    }}>Save</Button>
                </DialogActions>
            </Dialog>
        </>
    );
};
