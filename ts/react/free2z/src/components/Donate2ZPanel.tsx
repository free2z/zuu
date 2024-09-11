import { LoginTwoTone } from "@mui/icons-material";
import {
    Stack, Tooltip, TextField, InputAdornment, Button,
    Typography, IconButton, useTheme, Link,
} from "@mui/material";
import { SUCCESS_MESSAGES, getRando } from "./RandomSuccess";
import TuziIcon from "./TuziIcon";
import { useGlobalState } from "../state/global";
import TuzisButton from "./TuzisButton";
import { useState } from "react";
import axios from "axios";
import { SimpleCreator } from "./MySubscribers";
import { TabPanel } from "./TabPanel";


type Donate2ZPanelProps = {
    value: number,
    creator: SimpleCreator,
    handleChangeIndex: (index: number) => void,
}

export default function Donate2ZPanel(props: Donate2ZPanelProps) {
    const { value, creator, handleChangeIndex } = props;
    const [current, setCurrent] = useGlobalState("creator")
    const [snackbar, setSnackbar] = useGlobalState("snackbar")
    const [loginModal, setLoginModal] = useGlobalState("loginModal")
    const [num2z, setNum2z] = useState(10 as number | null)
    const [error, setError] = useState(false)
    const theme = useTheme()

    const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const tuzisInput = event.target.value;

        if (tuzisInput === "") {
            setError(true);
            setNum2z(null);  // Set num2z to null when the field is empty
            return;
        }

        const tuzis = Number(tuzisInput);
        if (isNaN(tuzis) || tuzis < 1 || tuzis > Number(current.tuzis)) {
            setError(true);
        } else {
            setError(false);
            setNum2z(tuzis);
        }
    }
    const handleDonate = (anon: boolean) => {
        axios.post(
            `/api/tuzis/donate/${creator.username}`, {
            amount: num2z,
            anon: anon,
        }).then((res) => {
            // console.log("DONATE SUCCESS", res)
            setSnackbar({
                ...snackbar,
                severity: "success",
                message: getRando(SUCCESS_MESSAGES),
                open: true,
                duration: undefined,
            })
            setCurrent({
                ...current,
                tuzis: res.data,
            })
        }).catch((res) => {
            // console.log("DONATE ERROR", res)
            setSnackbar({
                ...snackbar,
                severity: "warning",
                message: "Backend Error :(",
                open: true,
                duration: undefined,
            })
        })
    }


    return (
        <TabPanel value={value} index={0}>
            <Stack
                direction="column" spacing={3}
                alignItems="center"
            >
                {/* <Typography>Donate 2Zs</Typography> */}
                {current.username &&
                    <TuzisButton {...current} />
                }
                {current.username && Number(current.tuzis) > 1 &&
                    <Stack direction="column" spacing={2}>

                        <TextField
                            value={num2z !== null ? num2z : ''}
                            style={{
                                maxWidth: "200px",
                            }}
                            size="small"
                            helperText={error ? "Invalid amount" : "Number of 2Zs to donate"}
                            // fullWidth
                            error={error}
                            onChange={handleInputChange}
                            type="text"
                            InputProps={{
                                endAdornment: (
                                    <InputAdornment position="start">
                                        <TuziIcon />
                                    </InputAdornment>
                                ),
                            }}
                        />

                        <Button
                            size="small"
                            color="success"
                            variant="outlined"
                            onClick={() => {
                                handleDonate(false);
                            }}
                            disabled={error}
                        >
                            Donate
                        </Button>
                        <Button
                            size="small"
                            color="secondary"
                            variant="outlined"
                            onClick={() => {
                                handleDonate(true);
                            }}
                            disabled={error}
                        >
                            Donate Anon
                        </Button>
                    </Stack>
                }
                {!current.username &&
                    <>

                        <Typography>
                            Login to donate 2Zs.
                        </Typography>
                        <Tooltip title="Login to donate 2Zs">
                            <IconButton
                                onClick={() => {
                                    setLoginModal(true)
                                }}
                            >
                                <LoginTwoTone />
                            </IconButton>
                        </Tooltip>
                        <Typography>
                            Or, you can <Link
                                component={"span"}
                                onClick={(e) => {
                                    e.preventDefault()
                                    handleChangeIndex(0)
                                }}
                                style={{
                                    cursor: "pointer",
                                }}
                            >use Zcash</Link>
                        </Typography>
                    </>
                }
            </Stack>
        </TabPanel>
    )
}
