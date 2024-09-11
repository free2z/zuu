import { useEffect, useState } from "react";
import axios from "axios";

import { Diversity1 } from "@mui/icons-material";
import {
    Tooltip, IconButton, Button, Dialog, DialogActions, DialogTitle,
    Stack, Slider, Divider, Chip, InputAdornment, TextField,
    useMediaQuery, DialogContent, Box,
} from "@mui/material";

import { PublicCreator } from "../CreatorDetail";
import { useGlobalState } from "../state/global";
import Tuzis from "./TuzisButton";
import TuziIcon from "./TuziIcon";
import { getRando } from "./RandomSuccess";

export const STOKED = [
    "stoked",
    "incredibly excited",
    "muy emocionado",
    "grateful",
    "thankful",
]

type SubDetails = {
    max_price: string
}

export type PublicCreatorPlaced = PublicCreator & {
    placement?: "bottom" | "bottom-end" | "bottom-start" | "left-end" | "left-start" | "left" | "right-end" | "right-start" | "right" | "top-end" | "top-start" | "top" | undefined
    isButton?: boolean,
    handleClose: () => void,
};

export default function YouAreSubscribed(props: PublicCreatorPlaced) {
    const [current, _setCurrent] = useGlobalState("creator")
    const [snack, setSnack] = useGlobalState("snackbar")
    const [changed, setChanged] = useState(false)
    const [error, setError] = useState("")
    const [subDetails, setSubDetails] = useState({
        max_price: "10"
    } as SubDetails)
    const { isButton } = props;

    const isXS = useMediaQuery('(max-width:399px)')

    useEffect(() => {
        // console.log("USE - GET SUB DETAILS")
        axios.get(`/api/tuzis/subscribe/${props.username}`).then((res) => {
            // console.log(res)
            setSubDetails(res.data)
        }).catch((res) => {
            setSnack({
                open: true,
                severity: "error",
                message: `Failed to get ${props.username}`,
                duration: undefined,
            })
        })
    }, [])

    useEffect(() => {
        if (Number(subDetails.max_price) > Number(current.tuzis)) {
            setError(`More than you have (${current.tuzis})`)
        } else if (Number(subDetails.max_price) < Number(props.member_price)) {
            setError(`Less than the current price (${props.member_price})`)
        } else {
            setError("")
        }
        if (Number(current.tuzis) < Number(props.member_price)) {
            setError("You don't have enough 2Zs! Click the tractor above!")
        }
    }, [subDetails])

    return (
        <>
            <DialogTitle id="responsive-dialog-title">
                You are subscribed to {props.full_name || props.username}
            </DialogTitle>
            <DialogContent>
                <Stack
                    direction="column" spacing={1}
                    alignItems="center"
                >

                    <Tuzis {...current} />
                    <Divider style={{ width: "80%" }}>
                        <Chip
                            label="Max"
                            // color="secondary"
                            color="primary"
                        />
                    </Divider>
                    <Stack
                        direction="column" spacing={1}
                        style={{
                            padding: "0 1em",
                        }}
                        alignItems="center"
                        justifyContent="center"
                    >

                        <Box
                            component="div"
                            style={{
                                width: "250px",
                            }}
                        >
                            <Slider
                                min={Number(props.member_price)}
                                max={Number(current.tuzis)}
                                step={1}
                                value={Number(subDetails.max_price)}
                                onChange={(_, val) => {
                                    setSubDetails({
                                        ...subDetails,
                                        max_price: val.toString(),
                                    })
                                    setChanged(true)
                                }}
                            />
                            <TextField
                                // margin="dense"
                                // fullWidth={true}
                                size="small"
                                type="number"
                                label="2Zs"
                                helperText={error || `per month for ${(props.username).substring(0, 23)}`}
                                error={Boolean(error)}
                                value={Number(subDetails.max_price)}
                                onChange={(ev) => {
                                    setSubDetails({
                                        ...subDetails,
                                        max_price: ev.target.value.toString(),
                                    })
                                    setChanged(true)
                                }}
                                InputProps={{
                                    endAdornment: (
                                        <InputAdornment position="end">
                                            <TuziIcon />
                                        </InputAdornment>
                                    ),
                                }}
                            />
                        </Box>
                        {/* </Stack> */}
                        <Button
                            disabled={Boolean(error) || !changed}
                            color="success"
                            variant="contained"
                            onClick={() => {
                                axios.patch(
                                    `/api/tuzis/subscribe/${props.username}`,
                                    subDetails,
                                ).then((res) => {
                                    setSnack({
                                        message: `${props.full_name || props.username} is going to be ${getRando(STOKED)}`,
                                        open: true,
                                        severity: "success",
                                        duration: undefined,
                                    })
                                    setChanged(false)
                                    setError("")
                                }).catch((res) => {
                                    setSnack({
                                        message: "Failed to Update!",
                                        open: true,
                                        severity: "error",
                                        duration: undefined,
                                    })
                                })
                            }}
                        >
                            Update
                        </Button>
                    </Stack>
                </Stack>
            </DialogContent>
            {/* TODO: how much does it recur for? */}
            {/* TODO: when does it expire? */}
            {/* TODO: can I extend it now? */}
            {/* TODO: cancel */}

            <DialogActions>
                <Button onClick={props.handleClose} autoFocus>
                    Done
                </Button>
            </DialogActions>
        </>
    )
}
