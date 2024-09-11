import { LocalFlorist } from "@mui/icons-material";
import {
    Dialog, DialogTitle, DialogContent,
    Divider, DialogActions,
    Button, Tooltip, useMediaQuery,
} from "@mui/material";
import { useState } from "react";
import { getURI, current_f2z_address } from "../Constants";
import { SBadge } from "./PageMetaFund";
import { PageInterface } from "./PageRenderer";
import QRAddress from "./QRAddress";


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
                    Donate to F2Z to boost this page!
                </DialogTitle>
                <DialogContent>
                    <Divider style={{ margin: "1em" }} />
                    <QRAddress
                        size={222}
                        addr={getURI(
                            current_f2z_address,
                            "0.01",
                            JSON.stringify({
                                act: "page_fund",
                                id: props.free2zaddr,
                            })
                        )}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleClose} autoFocus>
                        Done
                    </Button>
                </DialogActions>
            </Dialog>
            <Tooltip
                placement="left"
                title="Promote on F2Z"
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