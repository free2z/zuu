import {
    Button,
    Grid,
    IconButton,
    Paper,
    Typography,
    Link,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import HelpIcon from "@mui/icons-material/Help";
import QRCode from "react-qr-code";
import CopyToClipboard from "./CopyToClipboard";

export interface QRAddressProps {
    addr: string;
    prompt?: string;
    size?: number;
    docs?: string;
    showHelp?: boolean;
}

function QRAddress(props: QRAddressProps) {
    const { addr, size, prompt, docs, showHelp } = props;

    const handleCopy = (copy: (text: string) => void) => {
        copy(addr);
    };

    return (
        <Grid
            direction="column"
            alignItems="center"
            textAlign="center"
            justifyContent="center"
            spacing={0}
            container
            sx={{ mt: 3, mb: 1 }}
        >
            <Grid item xs={12}>
                <Typography
                    color="warning"
                    variant="caption"
                    sx={{ color: "primary" }}
                >
                    {prompt}
                </Typography>
                {showHelp && (
                    <IconButton
                        size="small"
                        color="info"
                        href={docs || ""}
                        target="_blank"
                    >
                        <HelpIcon />
                    </IconButton>
                )}
            </Grid>
            <Grid item xs={12}>
                <Paper
                    sx={{
                        background: "white",
                        padding: "1em",
                        lineHeight: "0",
                        width: `${(size || 64) + 37}px`,
                        margin: "auto",
                    }}
                    elevation={10}
                >
                    <QRCode bgColor="white" size={size || 64} value={addr} />
                </Paper>
            </Grid>
            <Grid item xs={12}
                marginTop="0.5em"
            >
                <CopyToClipboard>
                    {({ copy }) => (
                        addr.startsWith("zcash:") ? (
                            <Link href={addr} onClick={() => handleCopy(copy)}>
                                {`${addr.slice(0, 15)}...`}
                                <Button
                                    size="small"
                                    variant="text"
                                    color="secondary"
                                    aria-label="copy donation address"
                                >
                                    <ContentCopyIcon sx={{ ml: 1 }} />
                                </Button>
                            </Link>
                        ) : (
                            <Button
                                size="small"
                                variant="text"
                                color="secondary"
                                aria-label="copy donation address"
                                onClick={() => handleCopy(copy)}
                            >
                                {`${addr.slice(0, 5)}...${addr.slice(-5)}`}
                                <ContentCopyIcon sx={{ ml: 1 }} />
                            </Button>
                        )
                    )}
                </CopyToClipboard>
            </Grid>
        </Grid>
    );
}

export default QRAddress;
