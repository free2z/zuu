import { CheckCircleOutline, Email } from "@mui/icons-material";
import { Grid, Stack, Typography } from "@mui/material";
import { EmailStatus } from "./EmailConfirmationLink";
import EmailDeleteButton from "./EmailDeleteButton";
import EmailToggleNotifications from "./EmailToggleNotifications";
import EmailTogglePublic from "./EmailTogglePublic";


type EmailConfirmationConfirmedProps = {
    emailStatus: EmailStatus
    refetch: () => void
}

export function EmailConfirmationConfirmed(props: EmailConfirmationConfirmedProps) {
    const { emailStatus, refetch } = props;
    if (!emailStatus.email) return (<></>)
    return (
        <>
            <Grid item xs={12} sm={3}>
                <Stack direction="row" spacing={1}
                    alignItems="center"
                    justifyContent="center"
                    // overflow break word
                    sx={{ wordBreak: "break-word" }}
                >
                    <CheckCircleOutline color="success" />
                    <Typography>
                        Email
                    </Typography>
                </Stack>
            </Grid>
            <Grid item xs={12} sm={6}

            >
                <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    alignItems="center"
                    justifyContent="left"

                >
                    <Email color="primary" />
                    <Typography
                        variant="caption"
                        sx={{
                            wordWrap: 'break-word',
                            overflowWrap: 'break-word',
                            maxWidth: "82%",
                        }}
                    >
                        {emailStatus.email}
                    </Typography>
                </Stack>
            </Grid>
            <Grid item xs={12} sm={2}
            // alignItems="center"
            // justifyContent="center"
            >
                <Stack direction="column" spacing={0}
                    alignItems="center"
                    justifyContent="center"
                >
                    <EmailTogglePublic isPublic={emailStatus.is_public} />
                    <EmailToggleNotifications getNotifications={emailStatus.get_notifications} />
                </Stack>
            </Grid>
            <Grid item xs={12} sm={1}>
                <EmailDeleteButton onEmailStatusUpdate={refetch} />
            </Grid>
        </>
    )
}
