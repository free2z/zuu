import React from "react"

import { useTheme } from "@mui/styles"
import { margin } from "@mui/system"
import {
    Button,
    Divider,
    Grid,
    IconButton,
    Paper,
    TextField,
    Typography,
    Link,
} from "@mui/material"
import ContentCopyIcon from "@mui/icons-material/ContentCopy"
import HelpIcon from "@mui/icons-material/Help"

import QRCode from "react-qr-code"
import CopyToClipboard from "./CopyToClipboard"
// import { Link, Navigate } from 'react-router-dom';

export interface QRDisplayProps {
    addr: string
    prompt?: string
    size?: number
    docs?: string
    showHelp?: boolean
}

export default function QRDisplay(props: QRDisplayProps) {
    const { addr, size, prompt, docs, showHelp } = props

    return (
        <Grid
            direction="column"
            alignItems="center"
            textAlign="center"
            justifyContent="center"
            spacing={0}
            container
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

                <QRCode bgColor="white" size={size} value={addr} />
            </Grid>
            <Grid item xs={12}>
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
                                {addr.slice(0, 5)}...{addr.slice(addr.length - 5, addr.length)}
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
            </Grid>
        </Grid>
    )
}
