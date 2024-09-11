import { Button, Grid, Stack, Typography } from "@mui/material";
import { EmailStatus } from "./EmailConfirmationLink";
import EmailDeleteButton from "./EmailDeleteButton";


type EmailConfirmationPendingProps = {
    emailStatus: EmailStatus
    resend: () => void
    refetch: () => void
}


export default function EmailConfirmationPending(props: EmailConfirmationPendingProps) {
    const { emailStatus, resend, refetch } = props;
    return (
        <>
            <Grid item xs={12} sm={2}>
                <Typography>
                    Email
                </Typography>
            </Grid>
            <Grid item xs={12} sm={9}>
                <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={{ xs: 1, sm: 3 }}
                    alignItems="center"
                    justifyContent="center"
                >
                    <Typography>
                        Pending: {emailStatus.email}
                    </Typography>
                    <Button
                        variant="contained"
                        color="primary"
                        onClick={() => resend()}
                    >
                        Resend
                    </Button>
                </Stack>
            </Grid>
            <Grid item xs={12} sm={1}>
                <EmailDeleteButton onEmailStatusUpdate={refetch} />
            </Grid>
        </>
    )
}