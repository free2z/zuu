import { Backdrop, Box, LinearProgress } from "@mui/material";

type Props = {
    progress: number
}


export default function LinearProgressBackdrop(props: Props) {
    const { progress } = props
    return (
        <Backdrop
            color="primary"
            open={!!progress}
            sx={{
                zIndex: (theme) => theme.zIndex.drawer + 2
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
                    color="primary"
                    variant="determinate"
                    value={progress - 3}
                    // valueBuffer={prog + (Math.random() * 10)}
                    sx={{
                        // width: "80%",
                        height: 15,
                        // borderRadius: 5,
                    }}
                />
            </Box>
        </Backdrop>
    )
}