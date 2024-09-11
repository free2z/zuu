import {
    Button, Stack, TextField, Grid, Typography
} from "@mui/material";
import { useState } from "react";


type EmailConfirmationNoEmailProps = {
    handleEmailSubmit: (email: string) => void;
    isAddingEmail: boolean;
}

export function EmailConfirmationNoEmail(props: EmailConfirmationNoEmailProps) {
    const { handleEmailSubmit, isAddingEmail } = props;
    const [email, setEmail] = useState("");
    return (
        <Grid item xs={12}>
            <Stack direction="column" spacing={1}>
                <Typography variant="caption">
                    Add an email to be able to reset your password.
                    You can choose to enable notifications once confirmed.
                </Typography>
                <Stack
                    direction={{
                        xs: "column", sm: "row"
                    }}
                    alignItems="center"
                    justifyContent="center"
                    spacing={2}
                >
                    <TextField
                        label="Email"
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        variant="outlined"
                        fullWidth
                        margin="normal"
                        size='small'
                    />
                    <Button
                        variant="contained"
                        color="primary"
                        onClick={() => handleEmailSubmit(email)}
                        disabled={isAddingEmail}
                    >
                        Confirm
                    </Button>
                </Stack>
            </Stack>
        </Grid>
    )
}