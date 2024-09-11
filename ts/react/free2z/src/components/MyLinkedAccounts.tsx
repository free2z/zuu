import {
    Paper, Grid, Link, Typography,
} from "@mui/material";
import EmailConfirmationLink from "./EmailConfirmationLink";
import { useGlobalState } from "../state/global";
import { MyLinkedAccountsTwitter } from "./MyLinkedAccountsTwitter";
import ChangePasswordForm from "./ChangePasswordForm";
import { RevenueShareLink } from "./RevenueShareLink";
import MFAManager from "./MFAManager";


export default function MyLinkedAccounts() {
    const [creator, setCreator] = useGlobalState("creator")

    return (
        <Paper style={{
            padding: "3%",
            width: "100%",

        }}>
            <Grid
                container
                direction="column"
                justifyContent="center"
                alignItems="center"
                textAlign="center"
            >
                <Paper
                    elevation={1}
                    sx={{
                        p: 3, mt: 1, mb: 1,
                        width: '100%',
                    }}
                >
                    <MFAManager />
                </Paper>

                <Paper
                    elevation={1}
                    sx={{
                        p: 3, mt: 1, mb: 1,
                        width: '100%',
                    }}
                >
                    <ChangePasswordForm />
                </Paper>

                <Paper
                    elevation={1}
                    sx={{
                        p: 2, mt: 1, mb: 1,
                        width: '100%',
                        '& .MuiTypography-root': { // Targeting all Typography components within Paper
                            fontSize: theme => `calc(${theme.typography.fontSize} * ${0.8})`
                        }
                    }}
                >
                    <EmailConfirmationLink />
                </Paper>
                <Paper
                    elevation={1}
                    sx={{
                        p: 2, mt: 1, mb: 1,
                        width: '100%',
                        '& .MuiTypography-root': { // Targeting all Typography components within Paper
                            fontSize: theme => `calc(${theme.typography.fontSize} * ${0.8})`
                        }
                    }}
                >
                    <MyLinkedAccountsTwitter />
                </Paper>
                {/* Link to /profile/kyc if the creator.tuzis is > 150 */}
                <Paper
                    elevation={1}
                    sx={{
                        p: 2, mt: 1, mb: 1,
                        width: '100%',
                        '& .MuiTypography-root': { // Targeting all Typography components within Paper
                            fontSize: theme => `calc(${theme.typography.fontSize} * ${0.8})`
                        }
                    }}
                >
                    <RevenueShareLink />
                </Paper>
            </Grid>
        </Paper>
    )
}
