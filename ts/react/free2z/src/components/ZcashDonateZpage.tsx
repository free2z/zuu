import { useState } from "react";
import {
    Dialog, DialogTitle, DialogContent, DialogContentText,
    Button, Divider, DialogActions, Tooltip, Badge, styled, useMediaQuery,
} from "@mui/material";
import { SBadge } from "./PageMetaFund";
import { PageInterface } from "./PageRenderer";
import QRAddress from "./QRAddress";
import ZcashIcon from "./ZcashIcon";

function trunc(str: string, num: number) {
    if (str.length <= num) {
        return str
    }
    return str.slice(0, num) + '...'
}

// TODO: badgelib
export const SBadgeTop = styled(Badge)(({ theme }) => ({
    "& .MuiBadge-badge": {
        right: -21,
        top: -23,
        // border: `1px solid ${theme.palette.background.paper}`,
        padding: "0 4px",
        zIndex: 100,
        fontWeight: "bolder",
        // color: "#000000",
        // fontSize: "37%",
        background: `linear-gradient(to left, violet 0%, indigo 10%, blue 11%, green 20%, yellow 50%, orange 51%, red 90%)`,
        backgroundSize: "200% auto",
        whiteSpace: "nowrap",

        // color: `${theme.palette.text.secondary}`,
        backgroundClip: "text",
        textFillColor: "transparent",
        animation: "shine 7s linear infinite",
        "@keyframes shine": {
            to: {
                backgroundPosition: "200% center",
            },
        },
    },

}))


export default function ZcashDonateZpage(props: PageInterface) {
    const [open, setOpen] = useState(false)
    const isXS = useMediaQuery('(max-width: 399px)')
    const handleOpen = () => {
        setOpen(true)
    }
    const handleClose = () => {
        setOpen(false)
    }
    return (
        <>
            <Dialog
                fullScreen={isXS}
                open={open}
                onClose={handleClose}
                aria-labelledby="responsive-dialog-title"
            >
                <DialogTitle id="responsive-dialog-title">
                    {`${props.creator.username}'s Peer-2-Peer Address`}
                </DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        {props.p2paddr
                            ? `All donations to this address go directly to ${props.creator.username}`
                            : "The creator has not yet configured a Peer-2-Peer address"}
                    </DialogContentText>

                    {props.p2paddr && (
                        <>
                            <Divider style={{ margin: "1.3em" }} />
                            <QRAddress size={192} addr={props.p2paddr} />
                        </>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleClose} autoFocus>
                        Done
                    </Button>
                </DialogActions>
            </Dialog>
            <Tooltip title={`Fund ${props.creator.username}`} placement="left">
                <>
                    <SBadgeTop
                        badgeContent="DONATE"
                        color={undefined}
                        variant={undefined}
                        onClick={() => handleOpen()}
                    ></SBadgeTop>
                    <SBadge
                        badgeContent={`${trunc(props.creator.username, 10)}`}
                        color="primary"
                        onClick={() => handleOpen()}
                    >
                        <ZcashIcon
                            fontSize="large"
                            style={{
                                opacity: 1,
                            }}
                            onClick={() => handleOpen()}
                        />
                    </SBadge>
                </>
            </Tooltip>
        </>
    )
}