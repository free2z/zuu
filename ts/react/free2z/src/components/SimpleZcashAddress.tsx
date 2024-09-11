import { Stack, Paper, Button, Link, Typography } from "@mui/material"
import ContentCopyIcon from "@mui/icons-material/ContentCopy"
import QRCode from "react-qr-code"
import CopyToClipboard from "./CopyToClipboard"


export type SimpleZcashAddressProps = {
    addr: string,
    size: number,
    bgColor?: string,
    fgColor?: string,
}

export default function SimpleZcashAddress(props: SimpleZcashAddressProps) {
    const { addr, size, bgColor = "white", fgColor = "black" } = props
    return (
        <Stack
            direction="column"
            alignContent="center"
            alignItems="center"
        >
            <Stack
                sx={{
                    background: bgColor,
                    padding: "1.25em",
                    lineHeight: "0",
                    borderRadius: "4px"
                }}
            // elevation={10}
            >
                <QRCode bgColor={bgColor} fgColor={fgColor} size={size} value={addr} />
            </Stack>
            <CopyToClipboard>
                {({ copy }) =>
                    addr.startsWith("zcash:") ? (
                        <Link
                            href={addr}
                            onClick={() => {
                                copy(addr)
                                // navigate(addr)
                            }}
                        >
                            <Stack
                                direction="row"
                                alignItems="center"
                                justifyContent="center"
                                spacing={0}
                            >
                                <Typography>
                                    {addr.slice(0, 15)}...
                                </Typography>
                                <Button
                                    size="small"
                                    variant="text"
                                    color="secondary"
                                    aria-label="copy donation address"
                                    onClick={() => {
                                        copy(addr)
                                        // navigate(addr)
                                    }}
                                >
                                    <ContentCopyIcon />
                                </Button>
                            </Stack>
                        </Link>
                    ) : (
                        <Button
                            size="small"
                            variant="text"
                            color="secondary"
                            aria-label="copy donation address"
                            onClick={() => {
                                copy(addr)
                                // navigate(addr)
                            }}
                        >
                            {addr.slice(0, 5)}...{addr.slice(addr.length - 5, addr.length)}
                            <ContentCopyIcon />
                        </Button>
                    )
                }
            </CopyToClipboard>
        </Stack>
    )
}