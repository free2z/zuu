import { Box, Stack, Typography, useTheme } from '@mui/material';
import { useState, useEffect, useRef, memo, useCallback } from 'react';
import "./CustomImage.css"

const imgStyle = {
    width: 'auto',
    maxWidth: '100%',
    display: 'block',
    marginLeft: 'auto',
    marginRight: 'auto',
    cursor: 'pointer',
};

const lightboxImgStyle = {
    maxWidth: '100%',
    maxHeight: 'calc(100vh - 60px)',
};

const captionStyle = {
    color: "white",
};

interface LightboxImageProps {
    src?: string
    alt?: string
    hideCaption?: boolean
}

function LightboxImage({ src, alt, hideCaption }: LightboxImageProps) {
    const [open, setOpen] = useState(false);
    const theme = useTheme();
    const contentElementRef = useRef<HTMLDivElement>(null);

    const handleClickOpen = useCallback(() => {
        setOpen(true);
    }, []);

    const handleClose = useCallback(() => {
        const contentElement = contentElementRef.current;
        if (contentElement) {
            contentElement.classList.add('closing');
        }
        setTimeout(() => {
            setOpen(false);
            if (contentElement) {
                contentElement.classList.remove('closing');
            }
        }, 333);
    }, []);

    const handleKeyDown = useCallback((event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            handleClose();
        }
    }, [handleClose]);

    useEffect(() => {
        if (open) {
            document.addEventListener('keydown', handleKeyDown);
        } else {
            document.removeEventListener('keydown', handleKeyDown);
        }

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [open, handleKeyDown]);

    return (
        <>
            <Box component="div">
                <Stack
                    direction="column"
                    textAlign="center"
                    justifyContent="center"
                    alignItems="center"
                    spacing={1}
                >
                    <img
                        src={src}
                        alt={alt}
                        onClick={handleClickOpen}
                        style={imgStyle}
                    />
                    {!hideCaption && <Typography variant="caption">{alt}</Typography>}
                </Stack>
            </Box>
            <Box
                component="div"
                onClick={handleClose}
                className={open ? 'lightbox open' : 'lightbox'}
                style={{
                    zIndex: theme.zIndex.modal + 1 + 100000,
                }}
            >
                <Stack
                    direction="column"
                    textAlign="center"
                    justifyContent="center"
                    alignItems="center"
                    spacing={1}
                    padding="0.5em"
                    className={`lightbox-content ${open ? 'open' : ''}`}
                    ref={contentElementRef}
                >
                    <img
                        src={src}
                        alt={alt}
                        style={lightboxImgStyle}
                    />
                    <Typography variant="caption" style={captionStyle}>{alt}</Typography>
                </Stack>
            </Box>
        </>
    );
}

export default memo(LightboxImage);
