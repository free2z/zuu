import { CircularProgress } from "@mui/material";


export default function LoadingAnimation() {
    return (
        <>
            <CircularProgress
                color="primary"
                size={150}
                thickness={1}
                variant="indeterminate"
                sx={{
                    opacity: 1,
                    position: 'absolute',
                    animationDuration: "0.5s",
                }}
            />
            <CircularProgress
                color="secondary"
                size={200}
                thickness={5}
                variant="indeterminate"
                sx={{
                    opacity: 0.35,
                    position: 'absolute',
                    animationDuration: "7s",
                }}
            />
            <CircularProgress
                color="info"
                size={300}
                thickness={12}
                variant="indeterminate"
                sx={{
                    opacity: 0.05,
                    position: 'absolute',
                    animationDuration: "50s",
                }}
            />
            <CircularProgress
                color="warning"
                size={230}
                // rotation={180}
                thickness={1}
                variant="indeterminate"
                sx={{
                    opacity: 0.35,
                    position: 'absolute',
                    animationDuration: "8s",
                    // transform: "rotate(180deg)",
                    animationDirection: "reverse",
                }}
            />
            <CircularProgress
                color="error"
                size={310}
                thickness={1}
                variant="indeterminate"
                sx={{
                    opacity: 0.15,
                    position: 'absolute',
                    animationDuration: "12s",
                    // animationDirection: "reverse",
                    animationDirection: "reverse",
                }}
            />
            <CircularProgress
                color="success"
                size={223}
                thickness={3}
                variant="indeterminate"
                sx={{
                    opacity: 0.15,
                    position: 'absolute',
                    animationDuration: "15s",
                }}
            />
        </>
    )
}