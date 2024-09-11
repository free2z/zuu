import React, { useState } from 'react';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import ReactPlayer from 'react-player';

// const config = {
//     file: {
//         hlsURL: '/script/hls.js',
//     },
// };

export default function VideoPlayerTest() {
    const [url, setUrl] = useState<string>("");

    const handleUrlChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setUrl(event.target.value);
    };

    return (
        <Box component="div" style={{ marginTop: "3em" }}>
            <TextField
                label="URL"
                value={url}
                onChange={handleUrlChange}
                fullWidth
            />
            <Box component="div" mt={2}>
                <ReactPlayer
                    url={url}
                    controls={true}
                />
            </Box>
        </Box>
    );
};
