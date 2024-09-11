import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
    Box,
    Button,
    CircularProgress,
    Tab,
    Tabs,
    Typography,
    List,
    ListItem,
    ListItemText,
} from '@mui/material';

// Define types for poll data
interface PollData {
    id: string;
    question: string;
    options: string[];
    hasVoted: boolean;
    isEligible: boolean;
    totals: number[];
}

// Define props for the PollComponent
interface PollComponentProps {
    pollId: string;
}

const PollComponent: React.FC<PollComponentProps> = ({ pollId }) => {
    const [pollData, setPollData] = useState<PollData | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [tabIndex, setTabIndex] = useState<number>(0);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);

    useEffect(() => {
        // Fetch poll data
        const fetchPollData = async () => {
            try {
                const response = await axios.get<PollData>(`/api/polls/${pollId}`);
                setPollData(response.data);
            } catch (err) {
                setError('Failed to fetch poll data');
            } finally {
                setLoading(false);
            }
        };

        fetchPollData();
    }, [pollId]);

    const handleVote = async () => {
        if (selectedOption !== null) {
            try {
                await axios.post(`/api/polls/${pollId}/vote`, { option: selectedOption });
                // Fetch updated poll data after voting
                const response = await axios.get<PollData>(`/api/polls/${pollId}`);
                setPollData(response.data);
            } catch (err) {
                setError('Failed to submit vote');
            }
        }
    };

    const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
        setTabIndex(newValue);
    };

    if (loading) {
        return <CircularProgress />;
    }

    if (error) {
        return <Typography color="error">{error}</Typography>;
    }

    if (!pollData) {
        return null;
    }

    return (
        <Box component="div">
            <Tabs value={tabIndex} onChange={handleTabChange}>
                <Tab label="Vote" />
                <Tab label="Results" />
            </Tabs>

            {tabIndex === 0 && (
                <Box component="div">
                    <Typography variant="h5">{pollData.question}</Typography>
                    <List>
                        {pollData.options.map((option, index) => (
                            <ListItem button selected={selectedOption === index} onClick={() => setSelectedOption(index)} key={index}>
                                <ListItemText primary={option} />
                            </ListItem>
                        ))}
                    </List>
                    <Button variant="contained" color="primary" onClick={handleVote} disabled={!pollData.isEligible || selectedOption === null}>
                        Vote
                    </Button>
                    {!pollData.isEligible && <Typography color="error">You are not eligible to vote in this poll.</Typography>}
                </Box>
            )}

            {tabIndex === 1 && (
                <Box component="div">
                    <Typography variant="h5">{pollData.question}</Typography>
                    <List>
                        {pollData.options.map((option, index) => (
                            <ListItem key={index}>
                                <ListItemText primary={`${option}: ${pollData.totals[index]} votes`} />
                            </ListItem>
                        ))}
                    </List>
                </Box>
            )}
        </Box>
    );
};

export default PollComponent;
