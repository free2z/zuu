import * as React from 'react';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import { Backdrop } from '@mui/material';

export default function LinearBuffer() {
    const [progress, setProgress] = React.useState(0);
    const [buffer, setBuffer] = React.useState(10);

    const progressRef = React.useRef(() => { });
    React.useEffect(() => {
        progressRef.current = () => {
            if (progress > 100) {
                setProgress(0);
                setBuffer(10);
            } else {
                const diff = Math.random() * 10;
                const diff2 = Math.random() * 10;
                setProgress(progress + diff);
                setBuffer(progress + diff + diff2);
            }
        };
    });

    React.useEffect(() => {
        const timer = setInterval(() => {
            progressRef.current();
        }, 500);

        return () => {
            clearInterval(timer);
        };
    }, []);

    return (
        <Backdrop
            color="primary"
            open={!!progress}
            sx={{
                zIndex: (theme) => theme.zIndex.drawer + 1
            }}
        >
            <Box component="div" sx={{ width: '90%' }}>
                <LinearProgress
                    color="secondary"
                    sx={{
                        height: 3,
                    }}
                />
                <LinearProgress
                    sx={{
                        height: 15,
                        // borderRadius: 5,
                    }}
                    variant="determinate"
                    value={progress} valueBuffer={buffer} />
            </Box>
        </Backdrop>
    );
}