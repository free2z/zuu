import React from "react"

import { Poll, SportsScore, ViewAgenda, Visibility } from "@mui/icons-material"
import { Modal, Box, Typography, Tooltip, IconButton, InputAdornment, Link, TextField, Button } from "@mui/material"
import ViewingKeyTextField from "./ViewingKeyTextField";
import { AxiosResponse } from "axios";

export interface VKProps {
    vk: string,
    setVK: (vk: string) => void,
    callback: () => Promise<void | AxiosResponse<any, any>>
}

export const modalBoxStyle = {
    position: 'absolute' as 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 380,
    bgcolor: 'background.paper',
    border: '2px solid #000',
    boxShadow: 24,
    p: 4,
};

export default function VKButton(props: VKProps) {
    const [open, setOpen] = React.useState(false);
    const handleOpen = () => setOpen(true);
    const handleClose = () => {
        props.callback()
        setOpen(false)
    }

    return (<>


        <Modal
            open={open}
            onClose={handleClose}
            aria-labelledby="modal-modal-title"
            aria-describedby="modal-modal-description"
        >
            <Box
                sx={modalBoxStyle}
                component="div"
            >
                <Typography id="modal-modal-title" variant="h6" component="h2">
                    Add Viewing Key
                </Typography>
                <ViewingKeyTextField
                    vk={props.vk} setVK={props.setVK}
                    handleClose={handleClose}
                    autoFocus={true}
                />
                <Button
                    variant="outlined"
                    onClick={handleClose}
                >Done</Button>
            </Box>
        </Modal>
        <Tooltip title="Add Viewing Key">
            <IconButton
                onClick={(ev) => {
                    // console.log(ev)
                    handleOpen()
                    // console.log(arguments)
                    // navigate("/profile")
                }}
            >
                <Visibility
                    fontSize="large"
                    color="secondary"
                />
            </IconButton>
        </Tooltip>
    </>)
}