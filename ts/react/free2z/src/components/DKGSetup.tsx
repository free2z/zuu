import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, TextField, Container, Typography, Box } from '@mui/material';
import { v4 as uuidv4 } from 'uuid';

const DKGSetup = () => {
    const [displayName, setDisplayName] = useState<string>('');
    const navigate = useNavigate();

    const handleSubmit = () => {
        const uuid = uuidv4();
        navigate(`/tools/dkg/${uuid}`, { state: displayName });
    };

    // Handle Enter key for form submission
    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && displayName.trim() !== '') {
            e.preventDefault();
            handleSubmit();
        }
    };

    useEffect(() => {
        // Autofocus the input field when the component mounts
        const input = document.getElementById('display-name-input');
        input?.focus();
    }, []);

    return (
        <Container maxWidth="sm">
            <Box
                sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    mt: 4,
                    mb: 4,
                }}
                component="div"
            >
                <Typography variant="h4" component="h1" gutterBottom>
                    Decentralized Key Generation
                </Typography>
                <Box
                    component="form"
                    sx={{
                        width: '100%',
                        mt: 1,
                    }}
                    noValidate
                    autoComplete="off"
                    onKeyPress={handleKeyPress}  // Add keypress handler here
                >
                    <TextField
                        id="display-name-input"
                        label="Your Display Name"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        fullWidth
                        margin="normal"
                        required
                    />
                    <Button
                        variant="contained"
                        color="primary"
                        sx={{ mt: 3 }}
                        disabled={displayName.trim() === ''}
                        onClick={handleSubmit}
                    >
                        Start Session
                    </Button>
                </Box>
            </Box>
        </Container>
    );
};

export default DKGSetup;
