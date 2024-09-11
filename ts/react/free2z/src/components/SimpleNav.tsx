import {
    Box,
    Stack,
    AppBar,
    Toolbar,
    useTheme,
    useMediaQuery,
} from "@mui/material";
import HomeButton from "./HomeButton";
import FindButton from "./FindButton";
import SimpleNavRight from "./SimpleNavRight";
import { useGlobalState } from "../state/global";
import DarkMode from "./DarkMode";
import ConverseButton from "./ConverseButton";
import AIPublicFeedButton from "./AIPublicFeedButton";


export default function SimpleNav() {
    const [authStatus, setAuthStatus] = useGlobalState("authStatus")
    const theme = useTheme();
    const isSuperSmall = window.innerWidth < 325
    // const isSmall = useMediaQuery(theme.breakpoints.down('sm'));

    return (
        <AppBar
            sx={{
                backgroundColor: theme.palette.background.paper,
                position: 'fixed',
            }}
            elevation={2}
        >
            <Toolbar
                sx={{ display: "flex", justifyContent: "space-between" }}
                disableGutters={isSuperSmall}
            >
                <Box component="div" display="flex">
                    <Stack direction="row"
                        spacing={{
                            xs: isSuperSmall ? -1 : -0.75,
                            sm: 1,
                            md: 2,
                            lg: 4,
                            xl: 6,
                        }}
                    >
                        <HomeButton />
                        {authStatus === false &&
                            <DarkMode />
                        }
                        <FindButton />
                        <ConverseButton />
                        <AIPublicFeedButton />
                    </Stack>
                </Box>
                {/* <Divider orientation="vertical" flexItem sx={{ mx: 2, height: "70%" }} /> */}
                <SimpleNavRight />
            </Toolbar >
        </AppBar >
    );
}
