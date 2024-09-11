import React from "react"

import { Poll, SportsScore } from "@mui/icons-material"
import { Modal, Box, Typography, Tooltip, IconButton, InputAdornment, Link, TextField, Button, Divider } from "@mui/material"
import { modalBoxStyle } from "./VKButton";
import ViewingKeyTextField from "./ViewingKeyTextField";
import { AxiosResponse } from "axios";

export interface GoalProps {
    goal: string,
    setGoal: (goal: string) => void,
    vk: string,
    setVK: (vk: string) => void,
    callback: () => Promise<void | AxiosResponse<any, any>>
}

export default function GoalButton(props: GoalProps) {
    const [open, setOpen] = React.useState(false);
    const handleOpen = () => setOpen(true);
    const handleClose = () => {
        props.callback()
        setOpen(false);
    }

    const { goal, setGoal } = props

    return (<>


        <Modal
            open={open}
            onClose={handleClose}
            aria-labelledby="modal-modal-title"
            aria-describedby="modal-modal-description"
        >
            <Box
                component="div"
                sx={modalBoxStyle}
            >
                <Typography id="modal-modal-title" variant="h6" component="h2">
                    Add Zcash Goal (ZEC)
                </Typography>
                <Typography variant="caption">
                    Amount of ZEC you are seeking to raise
                </Typography>
                <TextField
                    fullWidth
                    type="number"
                    value={goal}
                    variant="outlined"
                    inputProps={{
                        maxLength: 13,
                        step: "0.01",
                    }}
                    helperText={
                        <Link
                            href="https://www.gemini.com/prices/zcash"
                            target="_blank"
                        >ZEC Price</Link>
                    }
                    onChange={(e) => setGoal(e.target.value.toString())}
                    onKeyDown={(v: any) => {
                        if (v.keyCode === 13) {
                            // handleSave()
                            handleClose()
                        }
                    }}
                    autoFocus={true}
                />
                <ViewingKeyTextField
                    vk={props.vk}
                    setVK={props.setVK}
                    autoFocus={false}
                    handleClose={handleClose}
                />

                <Button
                    variant="outlined"
                    onClick={handleClose}
                >Done</Button>
            </Box>
        </Modal>
        <Tooltip title="Add Goal">
            <IconButton
                onClick={(ev) => {
                    // console.log(ev)
                    handleOpen()
                    // console.log(arguments)
                    // navigate("/profile")
                }}
            >
                <SportsScore
                    fontSize="large"
                    color="secondary"
                />
            </IconButton>
        </Tooltip>
    </>)
}
