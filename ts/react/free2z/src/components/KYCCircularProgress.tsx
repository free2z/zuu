import { Box, CircularProgress } from "@mui/material";

export default function KYCCircularProgress() {
    return (
        <Box
            component="div"
            sx={{
                width: '100%',
                minHeight: '160px',
                position: 'relative',
            }}
        >
            <CircularProgress
                sx={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    marginTop: '-20px',
                    marginLeft: '-20px',
                }}
            />;
        </Box>
    )
}