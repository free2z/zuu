import { useState } from "react";

import {
    Dialog, DialogTitle, Button, DialogActions, Tooltip, IconButton, Box,
    List,
    ListItem,
    useMediaQuery,
    SwipeableDrawer,
} from "@mui/material";

import TuziIcon from "./TuziIcon";
import ZcashIcon from "./ZcashIcon";
import { SimpleCreator } from "./MySubscribers";
import Donate2ZPanel from "./Donate2ZPanel";
import DonateZcashPanel from "./DonateZcashPanel";

type Props = {
    creator: SimpleCreator,
    addr?: string,
    isButton?: boolean,
}

export default function CreatorDonate(props: Props) {
    const { creator, addr, isButton } = props;
    const [selectedMethod, setSelectedMethod] = useState(0);
    const [open, setOpen] = useState(false);
    const isXS = useMediaQuery('(max-width:350px)')

    const handleClose = () => {
        setOpen(false);
    };

    const handleChangeIndex = (index: number) => {
        setSelectedMethod(index);
    }

    return (
        <>
            <SwipeableDrawer
                anchor="bottom"
                open={open}
                onOpen={() => { }}
                onClose={handleClose}
            >
                {/* <Dialog
                open={open}
                onClose={handleClose}
                aria-labelledby="responsive-dialog-title"
                fullWidth
                maxWidth="xs"
                fullScreen={isXS}
            > */}
                <DialogTitle
                    id="responsive-dialog-title"
                    style={{
                        wordWrap: "break-word",
                        wordBreak: "break-word",
                    }}
                >
                    Donate to {creator.username}
                </DialogTitle>

                <List
                    sx={{
                        display: "flex",
                        flexDirection: "row",
                        justifyContent: "center",
                        py: 1,
                    }}
                >
                    <ListItem
                        button
                        onClick={() => setSelectedMethod(0)}
                        selected={selectedMethod === 0}
                        sx={{
                            display: "flex",
                            justifyContent: "center",
                            alignItems: "center",
                            width: "fit-content",
                        }}
                    >
                        <TuziIcon />
                    </ListItem>
                    {(addr || creator.p2paddr) &&
                        <ListItem
                            button
                            onClick={() => setSelectedMethod(1)}
                            selected={selectedMethod === 1}
                            sx={{
                                display: "flex",
                                justifyContent: "center",
                                alignItems: "center",
                                width: "fit-content",
                            }}
                        >
                            <ZcashIcon />
                        </ListItem>
                    }
                </List>

                <Box
                    component="div"
                    sx={{
                        display: "flex",
                        flexDirection: "column",
                        flexGrow: 1,
                        overflow: "auto",
                        minHeight: 333,
                    }}
                >
                    {selectedMethod === 0 &&
                        <Donate2ZPanel
                            creator={creator}
                            value={0}
                            handleChangeIndex={handleChangeIndex}
                        />
                    }
                    {selectedMethod === 1 &&
                        <DonateZcashPanel
                            creator={creator}
                            value={1}
                            addr={addr}
                        />
                    }
                </Box>

                <DialogActions>
                    <Button onClick={handleClose} autoFocus>
                        Done
                    </Button>
                </DialogActions>
            </SwipeableDrawer>

            {isButton ? (
                <Button
                    color="success"
                    onClick={() => {
                        setOpen(true);
                    }}
                >
                    <TuziIcon
                        variant="outlined"
                        color="success"
                        sx={{ marginRight: "8px" }}
                    />
                    FUND CREATOR
                </Button>
            ) : (
                <Tooltip title="Fund Creator" placement="left">
                    <IconButton
                        onClick={() => {
                            setOpen(true);
                        }}
                        sx={{ py: '0px' }}
                    >
                        <TuziIcon
                            variant="outlined"
                            color="success"
                        />
                    </IconButton>
                </Tooltip>
            )}
        </>
    );
}
