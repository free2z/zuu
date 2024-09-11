import { Link, Box, Stack } from "@mui/material"
import { useGlobalState } from "../state/global";


export default function Footer() {
    const [loading, _] = useGlobalState("loading");

    if (loading) { return <></> }

    return (
        <Box
            component="div"
            mt={2} mb={2}
        >
            <Stack direction="row" spacing={2}
                // textAlign="center"
                alignItems="center"
                justifyContent="center"
            >
                <Link color="inherit" variant="caption" href="/docs/">
                    Help
                </Link>
                <Link
                    color="inherit" variant="caption"
                    href="/docs/legal/"
                >
                    Terms of Service
                </Link>
                <Link
                    color="inherit"
                    variant="caption"
                    href="/docs/legal/privacy-policy"
                >
                    Privacy Policy
                </Link>
            </Stack>
        </Box>
    )
}
