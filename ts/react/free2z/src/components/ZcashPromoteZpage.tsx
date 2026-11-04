import { LocalFlorist } from "@mui/icons-material";
import {
    Dialog, DialogTitle, DialogContent,
    Divider, DialogActions, DialogContentText,
    Button, Tooltip, useMediaQuery,
} from "@mui/material";
import { useState } from "react";
import { SBadge } from "./PageMetaFund";
import { PageInterface } from "./PageRenderer";


// The score badge on the classic zPage speed dial. It used to open a
// "Donate to F2Z to boost this page" QR that sent ZEC to a Free2Z wallet with
// a `page_fund` memo. That protocol is retired: boosting is a 2Z
// action, and ZEC sent to Free2Z is only ever for buying 2Z.
export default function ZcashPromoteZpage(props: PageInterface) {
    const [open, setOpen] = useState(false)
    const isXS = useMediaQuery('(max-width: 399px)')

    const handleClickOpen = () => {
        setOpen(true)
    }

    const handleClose = () => {
        setOpen(false)
    }

    return (
        <>
            <Dialog
                open={open}
                onClose={handleClose}
                aria-labelledby="responsive-dialog-title"
                fullScreen={isXS}
            >
                <DialogTitle id="responsive-dialog-title">
                    Boost this page with 2Z
                </DialogTitle>
                <DialogContent>
                    <Divider style={{ margin: "1em" }} />
                    <DialogContentText>
                        Boosts use 2Z, Free2Z's platform credits. Use the
                        rocket button on the page to boost it. Need 2Z? Buy
                        them with Zcash or a card from your profile.
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleClose} autoFocus>
                        Done
                    </Button>
                </DialogActions>
            </Dialog>
            <Tooltip
                placement="left"
                title="Page score"
            >

                <SBadge
                    max={99999}
                    badgeContent={props.f2z_score.toString().slice(0, 6)}
                    color={
                        parseFloat(props.f2z_score) >= 0.001
                            ? "secondary"
                            : parseFloat(props.f2z_score) >= 0
                                ? "warning"
                                : "error"
                    }
                    onClick={handleClickOpen}
                >
                    <LocalFlorist
                        fontSize="large"
                        color="secondary"
                        onClick={handleClickOpen}
                    />
                </SBadge>
            </Tooltip>
        </>
    )
}
