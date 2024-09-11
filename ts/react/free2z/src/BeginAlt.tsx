// Present buttons to login with 3rd parties
import { Button, Divider, Grid, Stack, Typography, useTheme } from "@mui/material"
import TwitterLoginButton from "./components/TwitterLoginButton"
import TwitterAssociationInfo from "./components/TwitterAssociationInfo"
import EmailResetPasswordForm from "./components/EmailResetPasswordForm"


function BeginAlt() {
    const theme = useTheme();
    return (
        <Grid
            container
            spacing={1}
            direction="column"
            alignItems="center"
            textAlign="center"
            justifyContent="center"
            // style={{ minHeight: "100vh" }}
            sx={{
                width: {
                    xs: '100%',
                    sm: '100%',
                    md: '80%',
                    lg: '70%',
                    xl: '60%',
                },
                margin: 'auto',
                minHeight: '100vh',
                padding: theme.spacing(1),
                backgroundColor: theme.palette.background.default,
                color: theme.palette.text.primary
            }}

        >
            <EmailResetPasswordForm />
            {/* Add a pretty horizontal line? */}
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}
                alignItems="center"
                justifyContent="center"
                sx={{
                    m: 3,
                }}
            >
                <Typography variant="caption">
                    You can also login with Twitter:
                </Typography>
                <Stack direction="row" spacing={2}
                    alignItems="center"
                    justifyContent="center"
                >
                    <TwitterLoginButton />
                    <TwitterAssociationInfo />
                </Stack>
            </Stack>
            <Stack spacing={1}>
                <Button
                    variant="text"
                    color="warning"
                    href="/"
                >Exit</Button>
            </Stack>

        </Grid>
    )
}

export default BeginAlt
