import React, { useState } from 'react';
import { Box, Typography, TextField, Button, Container } from '@mui/material';

interface NameSubmissionFormProps {
    onSubmit: (name: string) => void;
    initialName?: string;
}

const DKGNameSplash: React.FC<NameSubmissionFormProps> = ({ onSubmit, initialName = '' }) => {
    const [name, setName] = useState<string>(initialName);

    const handleSubmit = () => {
        if (name.trim() === '') return;
        onSubmit(name);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter') {
            handleSubmit();
        }
    };

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
                <Typography variant="h5" component="h1" gutterBottom>
                    Enter your display name to join the session
                </Typography>
                <TextField
                    label="Display Name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={handleKeyDown}
                    variant="outlined"
                    fullWidth
                    margin="normal"
                    required
                    autoFocus
                />
                <Button
                    variant="contained"
                    color="primary"
                    sx={{ mt: 3 }}
                    onClick={handleSubmit}
                    disabled={!name.trim()}
                >
                    Join Session
                </Button>
            </Box>
        </Container>
    );
};

export default DKGNameSplash;
