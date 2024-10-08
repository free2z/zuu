import React, { useState } from 'react';
import { Drawer, Box, Typography, TextField, Button } from '@mui/material';

interface ConfigurationDrawerProps {
    open: boolean;
    onClose: () => void;
    initialName: string;
    onChangeName: (name: string) => void;
    onStartDKG: () => void;
}

const ConfigurationDrawer: React.FC<ConfigurationDrawerProps> = ({ open, onClose, initialName, onChangeName, onStartDKG }) => {
    const [name, setName] = useState(initialName);

    const handleChangeName = () => {
        onChangeName(name);
        onClose();
    };

    return (
        <Drawer anchor="top" open={open} onClose={onClose}>
            <Box sx={{
                padding: 3

            }}
                component="div"
            >
                {/* <Typography variant="h6" gutterBottom>
                    Configuration
                </Typography> */}
                <Box sx={{ mb: 3 }}
                    component="div"
                >
                    <TextField
                        label="Display Name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        variant="outlined"
                        fullWidth
                    />
                    <Button
                        variant="contained"
                        color="primary"
                        sx={{ mt: 2 }}
                        onClick={handleChangeName}
                        disabled={!name.trim()}
                    >
                        Change Name
                    </Button>
                </Box>
                <Button
                    variant="contained"
                    color="secondary"
                    onClick={onStartDKG}
                    disabled
                >
                    Start FROST DKG (coming soon)
                </Button>
            </Box>
        </Drawer>
    );
};

export default ConfigurationDrawer;
