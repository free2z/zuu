import { Link, Stack, Typography } from "@mui/material";
import { useGlobalState } from "../state/global";
import axios from "axios";
import { useTransitionNavigate } from "../hooks/useTransitionNavigate";
import { useQuery } from "react-query";

export function RevenueShareLink() {
    const navigate = useTransitionNavigate()
    const [, setSnackBar] = useGlobalState("snackbar")

    const { data: userData, isLoading, isError } = useQuery(
        'userInfo', () => axios.get('/api/kyc/user-profile'), {
        staleTime: 0,
        cacheTime: 0,
    });

    if (isLoading) {
        return <Typography>Loading...</Typography>;
    }

    if (isError) {
        return <Typography>Error loading data</Typography>;
    }

    const applicationStatus = userData?.data?.application_status;

    if (applicationStatus === "REJECTED") {
        // Hide the entire component for "REJECTED" status
        return <Typography>
            Your verification application was not approved. Contact support for next steps.
        </Typography>;
    }

    if (applicationStatus === "PENDING") {
        return (
            <Typography variant="caption">
                Your verification application is under review.
            </Typography>
        );
    }

    if (applicationStatus === "APPROVED") {
        return (
            <Stack direction="column" spacing={1}>
                <Typography variant="caption">
                    Your verification application is approved. Compensation agreement acceptance and future eligibility are separate.
                </Typography>
                <Link href=""
                    onClick={() => {
                        // automatically knows APPROVED -> NEW
                        axios.post('/api/kyc/change-status').then((res) => {
                            navigate('/profile/kyc');
                        }).catch((err) => {
                            console.error(err);
                            setSnackBar({
                                open: true,
                                severity: 'error',
                                message: 'Error changing status. Please try again.',
                                duration: null,
                            })
                        })
                    }}
                    underline="hover"
                >
                    You can revise to your application and resubmit here
                </Link>
            </Stack>
        );
    }

    return (
        <Link href="/profile/kyc" underline="hover">
            Creator verification application
        </Link>
    );
}
