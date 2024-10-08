import { Backdrop } from "@mui/material"
import { useTheme } from "@mui/material/styles"
import { useLocation } from "react-router-dom";
import { getRandom } from "../Constants"
import { useGlobalState } from "../state/global"
import LoadingAnimation from "./LoadingAnimation";
import './LoadingBackdrop.css'


export default function LoadingBackdrop() {
    const theme = useTheme();
    const [loading, setLoading] = useGlobalState("loading")

    const location = useLocation();
    if (location.pathname === "/secretbackdrop") {
        setLoading(true)
    }
    return (
        <Backdrop
            color="primary"
            open={loading}
            sx={{
                position: "fixed",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "rgba(0,0,0,0.5)",
                // zIndex: (theme) => theme.zIndex.drawer + 1,
                // zIndex: 1301,
                zIndex: theme.zIndex.modal + 1,
                // animation: 'fadeIn 5s ease-in-out',
                opacity: 0.1,
            }}
        >
            <LoadingAnimation />
            <div
                // ref={divRef}
                style={{
                    textAlign: 'center',
                    color: 'text',
                    opacity: 0.1,
                    fontSize: '2.25em',
                    textShadow: '1px 1px 1px #fff, -1px -1px 1px #fff, -1px 1px 1px #fff, 1px -1px 1px #fff',
                    // animation: 'zanyMove 10s linear infinite',
                    // animation: 'shimmer 5s ease-in-out infinite',
                    animation: 'zanyMove 3s linear infinite, shimmer 2s ease-in-out infinite',
                    position: 'absolute',
                    // transform: 'rotateX(0deg) rotateY(0deg) rotateZ(0deg) scale3d(50,50,50)',
                    // transformStyle: 'preserve-3d'
                }}
            >
                {getRandom()}
            </div>
        </Backdrop>
    )
}
