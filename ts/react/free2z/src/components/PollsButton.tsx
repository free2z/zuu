import React from "react"

import { Poll } from "@mui/icons-material"
import { Modal, Box, Typography, Tooltip, IconButton, InputAdornment, Link, TextField, Button } from "@mui/material"
import { modalBoxStyle } from "./VKButton";
import ViewingKeyTextField from "./ViewingKeyTextField";
import { AxiosResponse } from "axios";

export interface PollInterface {
    question: string,
    viewing_key: string,
    option1: string,
    option2: string,
    option3: string,
    option4: string,
    option5: string,
    option1_votes: number,
    option2_votes: number,
    option3_votes: number,
    option4_votes: number,
    option5_votes: number,
    option1_total: string,
    option2_total: string,
    option3_total: string,
    option4_total: string,
    option5_total: string,
}

export interface PollProps {
    poll: PollInterface,
    setPoll: (poll: PollInterface) => void,
    vk: string,
    setVK: (vk: string) => void,
    callback: () => Promise<void | AxiosResponse<any, any>>

}

export default function PollsButton(props: PollProps) {
    const [open, setOpen] = React.useState(false);
    const handleOpen = () => setOpen(true);
    const handleClose = () => {
        props.callback()
        setOpen(false);
    }
    const { poll, setPoll } = props

    // console.log("poll:", poll)
    if (!poll) {
        // console.log("noPoll!")
        setPoll({
            question: "",
            option1: "",
            option2: "",
            option3: "",
            option4: "",
            option5: "",
            viewing_key: "",
            option1_votes: 0,
            option2_votes: 0,
            option3_votes: 0,
            option4_votes: 0,
            option5_votes: 0,
            option1_total: "",
            option2_total: "",
            option3_total: "",
            option4_total: "",
            option5_total: "",
        })
        return <></>
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
                    Create Poll
                </Typography>
                <Typography variant="caption">
                    Add a question and up to 5 options.
                    Leave extra options blank if you don't need all 5.
                </Typography>
                {/* Question */}
                <TextField
                    id="question"
                    label="question"
                    type="text"
                    autoFocus={true}
                    margin="normal"
                    // margin="dense"
                    // color={page.title ? "primary" : "error"}
                    color="primary"
                    // error={page.title.length < 1}
                    fullWidth
                    variant="standard"
                    placeholder="Question"
                    value={poll.question}
                    onKeyDown={(v: any) => {
                        if (v.keyCode === 13) {
                            // handleSave()
                            handleClose()
                        }
                    }}
                    onChange={(v) => {
                        setPoll({
                            ...poll,
                            question: v.target.value,
                        })
                    }}
                    required={true}
                />

                {/* Option 1 */}
                <TextField
                    id="option1"
                    label="Option 1"
                    type="text"
                    // autoFocus={true}
                    margin="normal"
                    // margin="dense"
                    // color={page.title ? "primary" : "error"}
                    color="primary"
                    // error={page.title.length < 1}
                    fullWidth
                    variant="standard"
                    placeholder="Option 1"
                    value={poll.option1}
                    onKeyDown={(v: any) => {
                        if (v.keyCode === 13) {
                            // handleSave()
                            handleClose()
                        }
                    }}
                    onChange={(v) => {
                        setPoll({
                            ...poll,
                            option1: v.target.value,
                        })
                    }}
                    required={false}
                />

                <TextField
                    id="option2"
                    label="Option 2"
                    type="text"
                    // autoFocus={true}
                    margin="normal"
                    // margin="dense"
                    // color={page.title ? "primary" : "error"}
                    color="primary"
                    // error={page.title.length < 1}
                    fullWidth
                    variant="standard"
                    placeholder="Option 2"
                    value={poll.option2}
                    onKeyDown={(v: any) => {
                        if (v.keyCode === 13) {
                            // handleSave()
                            handleClose()
                        }
                    }}
                    onChange={(v) => {
                        setPoll({
                            ...poll,
                            option2: v.target.value,
                        })
                    }}
                    required={false}
                />

                <TextField
                    id="option3"
                    label="Option 3"
                    type="text"
                    // autoFocus={true}
                    margin="normal"
                    // margin="dense"
                    // color={page.title ? "primary" : "error"}
                    color="primary"
                    // error={page.title.length < 1}
                    fullWidth
                    variant="standard"
                    placeholder="Option 3"
                    value={poll.option3}
                    onKeyDown={(v: any) => {
                        if (v.keyCode === 13) {
                            // handleSave()
                            handleClose()
                        }
                    }}
                    onChange={(v) => {
                        setPoll({
                            ...poll,
                            option3: v.target.value,
                        })
                    }}
                    required={false}
                />

                <TextField
                    id="option4"
                    label="Option 4"
                    type="text"
                    // autoFocus={true}
                    margin="normal"
                    // margin="dense"
                    // color={page.title ? "primary" : "error"}
                    color="primary"
                    // error={page.title.length < 1}
                    fullWidth
                    variant="standard"
                    placeholder="Option 4"
                    value={poll.option4}
                    onKeyDown={(v: any) => {
                        if (v.keyCode === 13) {
                            // handleSave()
                            handleClose()
                        }
                    }}
                    onChange={(v) => {
                        setPoll({
                            ...poll,
                            option4: v.target.value,
                        })
                    }}
                    required={false}
                />

                <TextField
                    id="option5"
                    label="Option 5"
                    type="text"
                    // autoFocus={true}
                    margin="normal"
                    // margin="dense"
                    // color={page.title ? "primary" : "error"}
                    color="primary"
                    // error={page.title.length < 1}
                    fullWidth
                    variant="standard"
                    placeholder="Option 5"
                    value={poll.option5}
                    onKeyDown={(v: any) => {
                        if (v.keyCode === 13) {
                            // handleSave()
                            handleClose()
                        }
                    }}
                    onChange={(v) => {
                        setPoll({
                            ...poll,
                            option5: v.target.value,
                        })
                    }}
                    required={false}
                />

                <ViewingKeyTextField
                    vk={props.vk}
                    setVK={props.setVK}
                    handleClose={handleClose}
                    autoFocus={false}
                />
                <Button
                    variant="outlined"
                    onClick={handleClose}
                >Done</Button>
            </Box>
        </Modal>
        <Tooltip title="Add Poll">
            <IconButton
                onClick={(ev) => {
                    // console.log(ev)
                    handleOpen()
                    // console.log(arguments)
                    // navigate("/profile")
                }}
            >
                <Poll
                    fontSize="large"
                    color="secondary"
                />
            </IconButton>
        </Tooltip>
    </>)
}
