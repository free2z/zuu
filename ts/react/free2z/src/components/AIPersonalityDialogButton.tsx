import { useState, useEffect } from "react";
import {
    Dialog,
    DialogTitle,
    DialogContent,
    FormControl,
    InputLabel,
    Select,
    MenuItem,
    SelectChangeEvent,
    IconButton,
    Button,
    DialogActions,
    useMediaQuery,
    useTheme,
    List,
    ListItem,
    ListItemText,
    ListItemSecondaryAction,
    Collapse,
    TextField,
    Box,
} from "@mui/material";
import { AIAction, AIPersonality } from "../AI2";
import axios from "axios";
import {
    Psychology,
    ExpandLess,
    ExpandMore
} from "@mui/icons-material";

import TabContext from '@mui/lab/TabContext';
import TabList from '@mui/lab/TabList';
import TabPanel from '@mui/lab/TabPanel';
// import Tab from "@mui/material";
import Tab from '@mui/material/Tab';


import { useGlobalState } from "../state/global";
import AIPersonalityManage from "./AIPersonalityManage";

interface AIPersonalityDialogButtonProps {
    dispatch: React.Dispatch<AIAction>;
    selectedPersonality: string;
}

// interface Personality {
//     id: string;
//     display_name: string;
//     creator: string | null // Assuming creator is a string or null
// }

interface SelectPersonalityDialogProps {
    open: boolean;
    handleClose: () => void;
    personalities: AIPersonality[];
    setPersonalities: React.Dispatch<React.SetStateAction<AIPersonality[]>>;
    selectedPersonality: string;
    handlePersonalityChange: (event: SelectChangeEvent) => void;
    // handleDeletePersonality: (id: string) => void;
    // currentUser: string;
    dispatch: React.Dispatch<AIAction>;
}

function SelectPersonalityDialog({
    open,
    handleClose,
    personalities,
    setPersonalities,
    selectedPersonality,
    handlePersonalityChange,
    dispatch,
    // handleDeletePersonality,
    // currentUser,
}: SelectPersonalityDialogProps) {
    const theme = useTheme();
    const [openList, setOpenList] = useState<string | null>(null);
    // console.log(personalities)

    const [systemMessage, setSystemMessage] = useState('');
    const [personalityName, setPersonalityName] = useState('');
    const [snackbar, setSnackbar] = useGlobalState("snackbar");

    // if we have personalites that we own, show the manage tab

    const [showManage, setShowManage] = useState(personalities.some(p => p.creator));

    const handleListClick = (id: string) => {
        setOpenList((prevId) => (prevId === id ? null : id));
    };

    const [value, setValue] = useState("1");

    const handleChange = (event: React.SyntheticEvent, newValue: string) => {
        setValue(newValue);
    };

    const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));

    const handleSystemMessageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setSystemMessage(event.target.value);
    }

    const handlePersonalityNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setPersonalityName(event.target.value);
    }

    const handleCreate = async () => {
        try {
            const response = await axios.post('/api/ai/personalities/', {
                display_name: personalityName,
                system_message: systemMessage,
            });
            const newPersonality = response.data;
            console.log("New Personality:", newPersonality);
            setPersonalities([...personalities, newPersonality]);
            dispatch({
                type: 'setSelectedPersonality',
                selectedPersonality: newPersonality.id,
            });
            handleClose();
            // FOUC!!!
            setTimeout(() => {
                // setShowManage(true);
                setPersonalityName('');
                setSystemMessage('');
                setValue("1");
            }, 300);
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

    useEffect(() => {
        setShowManage(personalities.some(p => p.creator));
    }, [personalities]);

    return (
        <Dialog onClose={handleClose} open={open} maxWidth="sm" fullWidth fullScreen={fullScreen}>
            <DialogTitle>Personalities</DialogTitle>
            <DialogContent>
                <TabContext value={value}>
                    <Box sx={{ borderBottom: 1, borderColor: 'divider' }} component="div">

                        <TabList onChange={handleChange} aria-label="simple tabs example" centered>
                            <Tab label="Select" value="1" />
                            <Tab label="Manage" value="2" />
                            <Tab label="Create" value="3" />
                        </TabList>
                    </Box>

                    <TabPanel
                        value="1"
                    >
                        <FormControl fullWidth variant="outlined"
                            style={{ marginTop: '0.5rem' }}
                        >
                            <InputLabel id="personality-select-label">Personality</InputLabel>
                            <Select
                                labelId="personality-select-label"
                                id="personality-select"
                                value={selectedPersonality}
                                onChange={handlePersonalityChange}
                                label="Personality"
                            >
                                {personalities.map((personality) => (
                                    <MenuItem key={personality.id} value={personality.id}>
                                        {personality.display_name}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                    </TabPanel>
                    <TabPanel value="2">

                        {showManage ? (
                            <List>
                                {personalities.map((personality) => {
                                    return personality.creator && (
                                        <Box
                                            component="div"
                                            key={personality.id}
                                        >
                                            <ListItem
                                                selected={openList === personality.id}
                                                // fullwidth

                                                onClick={() => handleListClick(personality.id)}
                                                sx={{
                                                    // backgroundColor: openList === personality.id ? theme.palette.action.selected : 'transparent',
                                                    '&&:hover': {
                                                        cursor: 'pointer',
                                                    },
                                                    // roun corners a bit
                                                    borderRadius: 2,
                                                }}
                                            >
                                                <ListItemText primary={personality.display_name} />
                                                <ListItemSecondaryAction>
                                                    <IconButton edge="end" onClick={() => handleListClick(personality.id)}>
                                                        {openList === personality.id ? <ExpandLess /> : <ExpandMore />}
                                                    </IconButton>
                                                </ListItemSecondaryAction>
                                            </ListItem>
                                            <Collapse
                                                in={openList === personality.id} timeout="auto" unmountOnExit
                                            >
                                                <AIPersonalityManage
                                                    personality={personality}
                                                    setPersonalities={setPersonalities}
                                                    dispatch={dispatch}
                                                    handleClose={handleClose}
                                                />
                                            </Collapse>
                                            {/* <Divider variant="middle" /> */}

                                        </Box>
                                    )
                                })}
                            </List>
                        ) : (
                            <Box component="div"
                                // center in the tab panel
                                display="flex"
                                flexDirection="column"
                                justifyContent="center"
                                alignItems="center"

                            >
                                <Button
                                    variant="outlined"
                                    color="success"
                                    onClick={() => setValue("3")}
                                >Create a Personality</Button>
                            </Box>
                        )}
                    </TabPanel>
                    <TabPanel value="3">
                        <TextField
                            fullWidth
                            variant="outlined"
                            label="Personality Name"
                            value={personalityName}
                            onChange={handlePersonalityNameChange}
                            style={{ marginTop: '0.5rem' }}
                        />
                        <TextField
                            fullWidth
                            variant="outlined"
                            label="System Message"
                            value={systemMessage}
                            onChange={handleSystemMessageChange}
                            style={{ marginTop: '0.5rem' }}
                            multiline
                            minRows={3}
                            maxRows={8}
                        />
                        <Button
                            variant="outlined"
                            color="success"
                            onClick={handleCreate}
                            style={{ marginTop: '0.5rem' }}
                        >Create</Button>
                    </TabPanel>
                </TabContext>
            </DialogContent>
            <DialogActions>
                <Button onClick={handleClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
}



export default function AIPersonalityDialogButton(props: AIPersonalityDialogButtonProps) {
    const [personalities, setPersonalities] = useState<AIPersonality[]>([]);
    const [open, setOpen] = useState(false);

    const isXS = useMediaQuery('(max-width:399px)');
    const [creator, _] = useGlobalState("creator");

    const handlePersonalityChange = (event: SelectChangeEvent) => {
        props.dispatch({
            type: 'setSelectedPersonality',
            selectedPersonality: event.target.value as string,
        });
        handleClose();
    }


    const handleOpen = () => {
        setOpen(true);
    }

    const handleClose = () => {
        setOpen(false);
    }

    // const handleToggle = () => {
    //     setView(view === "select" ? "input" : "select");
    // }


    useEffect(() => {
        console.log("Fetching Personalities...");
        axios.get('/api/ai/personalities/')
            .then(res => {
                setPersonalities(res.data.results);
                if (!props.selectedPersonality && res.data.results.length > 0) {
                    props.dispatch({
                        type: 'setSelectedPersonality',
                        selectedPersonality: res.data.results[0].id,
                    });
                }
            })
            .catch(err => {
                console.error(err);
            });
    }, []);

    return (
        <>
            <IconButton onClick={handleOpen} size="large">
                <Psychology color="primary" />
            </IconButton>

            <SelectPersonalityDialog
                // currentUser={creator.username}
                open={open}
                handleClose={handleClose}
                personalities={personalities}
                setPersonalities={setPersonalities}
                selectedPersonality={props.selectedPersonality}
                dispatch={props.dispatch}
                handlePersonalityChange={handlePersonalityChange}
            // handleToggle={handleToggle}
            // handleDeletePersonality={handleDeletePersonality}
            />
        </>
    );
}