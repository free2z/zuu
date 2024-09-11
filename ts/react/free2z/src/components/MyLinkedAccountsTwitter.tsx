import { CheckCircleOutline, Twitter } from "@mui/icons-material";
import {
    Grid, IconButton, Stack, Tooltip, Typography,
} from "@mui/material";
import TwitterIsPublicSwitch from "./TwitterIsPublicSwitch";
import TwitterLoginButton from "./TwitterLoginButton";
import { useGlobalState } from "../state/global";
import TwitterDeleteButton from "./TwitterDeleteButton";


export function MyLinkedAccountsTwitter() {
    const [creator, setCreator] = useGlobalState("creator")
    return (
        <>
            <Grid
                container
                spacing={{ xs: 1, sm: 3 }}
                alignItems="center"
                justifyContent={{ xs: 'center', sm: 'space-around' }}
            >
                {creator.twitter && (
                    <Grid item xs={12} sm={3}>

                        <Stack direction="row" spacing={1}
                            alignItems="center"
                            justifyContent="center"
                            // overflow break word
                            sx={{ wordBreak: "break-word" }}
                        >
                            <CheckCircleOutline color="success" />
                            <Typography>Twitter</Typography>
                        </Stack>
                    </Grid>
                )}
                <Grid item xs={12} sm={6}>
                    <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={1}
                        alignItems="center"
                        justifyContent="left"
                    >
                        {!creator.twitter && (
                            <>
                                <Typography variant="caption">Click here to link X account:</Typography>
                                <Tooltip
                                    title="Link Twitter account"
                                    placement="top"
                                >
                                    <span>
                                        <TwitterLoginButton />
                                    </span>
                                </Tooltip>
                            </>
                        )}
                        {/* Show linked */}
                        {creator.twitter && (
                            <>
                                <Twitter color="primary" />
                                <Typography variant="caption">{creator.twitter.username}</Typography>
                            </>
                        )}
                    </Stack>
                </Grid>
                {creator.twitter && (
                    <Grid item xs={12} sm={2}>
                        <TwitterIsPublicSwitch />
                    </Grid>
                )}
                {creator.twitter && (
                    <Grid item xs={12} sm={1}>
                        <TwitterDeleteButton />
                    </Grid>
                )}
                {/* </Grid> */}
            </Grid>
        </>
    )
}