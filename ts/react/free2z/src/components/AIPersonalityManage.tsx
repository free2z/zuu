import { Delete, Save } from "@mui/icons-material";
import { IconButton, TextField, Box } from "@mui/material";
import { useGlobalState } from "../state/global";
import { AIAction, AIPersonality } from "../AI2";
import axios from "axios";
import { useState } from "react";


interface AIPersonalityManageProps {
    handleClose: () => void;
    personality: AIPersonality;
    dispatch: React.Dispatch<AIAction>;
    // setPersonality: React.Dispatch<React.SetStateAction<AIPersonality>>;
    setPersonalities: React.Dispatch<React.SetStateAction<AIPersonality[]>>;
    // handleDeletePersonality: (id: string) => void;
    // currentUser: string;
}


export default function AIPersonalityManage({
    personality,
    setPersonalities,
    dispatch,
    handleClose,
}: AIPersonalityManageProps) {
    // const [currentUser,] = useGlobalState('creator');
    const [, setSnackbar] = useGlobalState('snackbar');
    const [systemMessage, setSystemMessage] = useState(personality.system_message);
    const [updatedPersonality, setUpdatedPersonality] = useState(personality.display_name);
    // const [, personalityName] = useState(personality.display_name);

    // const [confirmDelete, setConfirmDelete] = useState(false);
    // const [editPersonality, setEditPersonality] = useState(false);
    const handleDeletePersonality = async (id: string) => {
        // TODO: confirm first (another layer of dialog?)
        try {
            await axios.delete(`/api/ai/personalities/${id}/`);
            setPersonalities((prevPersonalities) => {
                const n = prevPersonalities.filter((personality) => personality.id !== id)
                // setPersonality(n[0])
                dispatch({
                    type: 'setSelectedPersonality',
                    selectedPersonality: n[0]?.id || '',
                })
                return n
            })
            // setPersonality(personalities[0]);
        } catch (error) {
            if (axios.isAxiosError(error) && error.response) {
                setSnackbar({
                    open: true,
                    message: error.response.data.detail || 'An error occurred while deleting the personality.',
                    severity: 'error',
                    duration: 6000,
                });
            } else {
                setSnackbar({
                    open: true,
                    message: 'An unexpected error occurred.',
                    severity: 'error',
                    duration: 6000,
                });
            }
        }
    };

    const handleEditPersonality = async (id: string) => {
        try {
            const response = await axios.patch(`/api/ai/personalities/${id}/`, {
                display_name: updatedPersonality,
                system_message: systemMessage,
            });
            const editedPersonality = response.data;
            dispatch({
                type: 'setSelectedPersonality',
                selectedPersonality: editedPersonality.id,
            });
            // handleClose();
            setPersonalities((prevPersonalities) => {
                const n = prevPersonalities.map((personality) => {
                    if (personality.id === editedPersonality.id) {
                        return editedPersonality;
                    }
                    return personality;
                });
                return n;
            });
        } catch (error) {
            if (axios.isAxiosError(error) && error.response) {
                setSnackbar({
                    open: true,
                    message: error.response.data.detail || 'An error occurred while creating the personality.',
                    severity: 'error',
                    duration: 6000,
                });
            } else {
                setSnackbar({
                    open: true,
                    message: 'An unexpected error occurred.',
                    severity: 'error',
                    duration: 6000,
                });
            }
        }
    };

    const handleSystemMessageChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        setSystemMessage(event.target.value);
    }

    const handlePersonalityNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setUpdatedPersonality(event.target.value);
    }

    return (
        <>
            <Box component="div">
                {/* TODO: style form */}

                <TextField
                    fullWidth
                    // variant="outlined"
                    label="Edit Personality Name"
                    value={updatedPersonality}
                    onChange={handlePersonalityNameChange}
                    style={{ marginTop: '0.75rem' }}
                />
                <TextField
                    fullWidth
                    // color="secondary"
                    variant="outlined"
                    label="Edit System Message"
                    value={systemMessage}
                    onChange={handleSystemMessageChange}
                    style={{ marginTop: '.75rem' }}
                    multiline
                    minRows={3}
                    maxRows={8}
                />

                <IconButton
                    color="warning"
                    onClick={() => handleDeletePersonality(personality.id)}
                >
                    <Delete />
                </IconButton>
                <IconButton
                    color="success"
                    onClick={() => handleEditPersonality(personality.id)}
                >
                    <Save />
                </IconButton>
            </Box>

        </>
    )
}