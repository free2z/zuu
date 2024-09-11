import React, { useState, useRef, DragEvent, ChangeEvent } from 'react';
import { Button, Box, Typography, useTheme, Backdrop, CircularProgress } from '@mui/material';

type DragDropFileUploadProps = {
    onFileSelect: (file: File) => void;
    disabled: boolean;
    instructions?: string;
};

const DragDropFileUpload: React.FC<DragDropFileUploadProps> = ({ onFileSelect, disabled, instructions }) => {
    const [dragActive, setDragActive] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const theme = useTheme(); // Using the theme context

    const handleDrag = (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(e.type === 'dragenter' || e.type === 'dragover');
    };

    const handleDrop = (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            onFileSelect(e.dataTransfer.files[0]);
        }
    };

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        if (e.target.files && e.target.files[0]) {
            onFileSelect(e.target.files[0]);
        }
    };

    const onButtonClick = () => {
        inputRef.current?.click();
    };

    return (
        <Box
            component="div"
            onDragEnter={handleDrag}
            onDragOver={handleDrag}
            onDragLeave={handleDrag}
            onDrop={handleDrop}
            sx={{
                border: `1px dashed ${theme.palette.mode === 'dark' ? theme.palette.grey[600] : theme.palette.grey[400]}`,
                p: 3,
                mt: 2,
                backgroundColor: dragActive ? (theme.palette.mode === 'dark' ? theme.palette.grey[800] : theme.palette.grey[300]) : 'transparent',
                transition: 'background-color 0.3s ease, border-color 0.3s ease',
                position: 'relative',
            }}
        >
            {/* Backdrop covering only the upload component */}
            {disabled && (
                <Backdrop
                    sx={{
                        position: 'absolute', // Ensure backdrop covers only this component
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: theme.palette.mode === 'dark' ? 'rgba(0, 0, 0, 0.5)' : 'rgba(255, 255, 255, 0.7)',
                        zIndex: (theme) => theme.zIndex.drawer + 1, // Ensure it's above other elements inside the box
                    }}
                    open
                >
                    <CircularProgress color="primary" />
                </Backdrop>
            )}
            <input
                ref={inputRef}
                type="file"
                onChange={handleChange}
                style={{ display: 'none' }}
            />
            <Box component="div" sx={{ textAlign: 'center' }}>
                <Typography>{instructions || "Drag and drop your file here, or click to select a file."}</Typography>
                <Button variant="contained" onClick={onButtonClick} sx={{ mt: 2 }}>
                    Select File
                </Button>
            </Box>
        </Box>
    );
};

export default DragDropFileUpload;
