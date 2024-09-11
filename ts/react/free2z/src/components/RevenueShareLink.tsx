import { Link, Stack, Typography } from "@mui/material";
import { useGlobalState } from "../state/global";
import axios from "axios";
import { useTransitionNavigate } from "../hooks/useTransitionNavigate";
import { useQuery } from "react-query";

export function RevenueShareLink() {
    const [creator, setCreator] = useGlobalState("creator");
    const navigate = useTransitionNavigate()
    const [snackbar, setSnackBar] = useGlobalState("snackbar")

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

    const tuzisCount = parseInt(creator.tuzis);
    const applicationStatus = userData?.data?.application_status;

    if (applicationStatus === "REJECTED") {
        // Hide the entire component for "REJECTED" status
        return <Typography>
            Sorry, you are not eligible for revenue share at this time.
        </Typography>;
    }

    if (applicationStatus === "PENDING") {
        return (
            <Typography variant="caption">
                Your application for revenue share is under review.
            </Typography>
        );
    }

    if (applicationStatus === "APPROVED") {
        return (
            <Stack direction="column" spacing={1}>
                <Typography variant="caption">
                    You are approved for the revenue sharing program!
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

    // Default case: Link to /profile/kyc if the creator has enough tuzis and status is "NEW"
    return tuzisCount < 1000 ? (
        <Typography variant="caption">
            You need at least 1000 tuzis to apply for revenue share.
            You currently have {tuzisCount} tuzis.
        </Typography>
    ) : (
        <Link href="/profile/kyc" underline="hover">
            Apply for Revenue Share
        </Link>
    )
}
