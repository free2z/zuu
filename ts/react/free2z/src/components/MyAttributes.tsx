import { AccountCircle, QuestionMark, TravelExplore } from "@mui/icons-material"
import {
    Paper, TextField, InputAdornment, Badge, Tooltip, Typography, Stack,
    Divider, FormControlLabel, Checkbox, Button, Link, Chip, Grid, Fab
} from "@mui/material"
import axios from "axios"
import Cookies from "js-cookie"
import { useState } from "react"
import { useGlobalState } from "../state/global"
import { FileMetadata } from "./DragDropFiles"
import F2ZMarkdownField from "./F2ZMarkdownField"
import TuziIcon from "./TuziIcon"
import UploadOrSelect from "./UploadOrSelect"
import { FeaturedImage } from "./PageRenderer"
import TransitionLink from "./TransitionLink"
import { useTransitionNavigate } from "../hooks/useTransitionNavigate"


export default function MyAttributes() {
    const [creator, setCreator] = useGlobalState("creator")
    const setSnackbarState = useGlobalState("snackbar")[1]
    const navigate = useTransitionNavigate()

    const [selectedAvatar, setSelectedAvatar] = useState<FileMetadata | null>(creator.avatar_image)
    const [selectedBanner, setSelectedBanner] = useState<FileMetadata | null>(creator.banner_image)

    function handleSubmit() {
        return axios
            .patch(
                "/api/auth/user/",
                {
                    ...creator,
                    avatar_image: selectedAvatar?.id || null,
                    banner_image: selectedBanner?.id || null,
                },
                {
                    headers: {
                        "X-CSRFToken": Cookies.get("csrftoken") || "",
                    },
                })
            .then((res) => {
                setSnackbarState({
                    message: "Profile saved",
                    open: true,
                    severity: "success",
                    duration: null,
                })
            })
            .catch((res) => {
                setSnackbarState({
                    message: JSON.stringify(res.data),
                    open: true,
                    severity: "error",
                    duration: null,
                })
            })
    }

    const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        let newValue = event.target.value;

        // Convert to a number and back to string to remove any non-numeric characters
        newValue = Number(newValue).toString();

        // If the conversion results in 'NaN' (e.g., when the input is empty), set it to the minimum value
        if (newValue === 'NaN') {
            newValue = '';  // Default to the minimum positive value
        } else if (Number(newValue) <= 0) {
            newValue = '';
        } else if (Number(newValue) > 1000000) {
            newValue = '1000000';
        }

        newValue = newValue.toString()

        setCreator({
            ...creator,
            member_price: newValue,
        });
    };

    const calculatePriceInDollars = (priceIn2Z: number): string => {
        return `$${(priceIn2Z * 0.01).toFixed(2)}`;
    };

    return (
        <>
            {/* Click fab to view profile */}
            <Fab
                color="primary"
                aria-label="view profile"
                style={{
                    position: "fixed",
                    right: "5%",
                    // top: "8%",
                    top: "10%",
                    opacity: 0.8,
                }}
                onClick={() => {
                    handleSubmit().then(() => {
                        navigate(`/${creator.username}`)
                    })
                }}
            >
                <TravelExplore />
            </Fab>

            <Paper style={{ padding: "3%" }}>

                <Stack
                    direction="column"
                    width="100%"
                    alignItems="center"
                    justifyContent="center"
                    spacing={0}
                    style={{
                        margin: "1em 0 0.5em 0",
                    }}
                >
                    <Tooltip title="Commit Changes">
                        <Button
                            variant="contained"
                            onClick={() => {
                                handleSubmit()
                            }}
                            style={{
                                margin: "0.33em"
                            }}
                        >
                            Update Profile
                        </Button>
                    </Tooltip>
                </Stack>
                {/* username */}
                <TextField
                    // autoFocus={true}
                    margin="dense"
                    color="secondary"
                    id="name"
                    label="Username"
                    type="text"
                    helperText="This is your login name and identifier"
                    fullWidth
                    variant="standard"
                    value={creator.username || ""}
                    // helperText={}
                    onKeyDown={(v) => {
                        if (v.keyCode === 13) {
                            handleSubmit()
                        }
                    }}
                    onChange={(v) => {
                        setCreator({
                            ...creator,
                            username: v.target.value,
                        })
                    }}
                    InputProps={{
                        endAdornment: (
                            <InputAdornment position="start">
                                <AccountCircle color="primary" />
                            </InputAdornment>
                        ),
                    }}
                />
                {/* full name */}
                <TextField
                    // autoFocus={true}
                    margin="dense"
                    color="secondary"
                    id="fullname"
                    label="Full Name"
                    type="text"
                    helperText="Display Name"
                    fullWidth
                    variant="standard"
                    value={creator.full_name || ""}
                    // helperText={}
                    onKeyDown={(v) => {
                        if (v.keyCode === 13) {
                            handleSubmit()
                        }
                    }}
                    onChange={(v) => {
                        setCreator({
                            ...creator,
                            full_name: v.target.value,
                        })
                    }}
                    InputProps={{
                        endAdornment: (
                            <InputAdornment position="start">
                                <Badge color="secondary" />
                            </InputAdornment>
                        ),
                    }}
                />

                <Stack
                    direction="row"
                    width="100%"
                    alignItems="center"
                    // justifyContent="center"
                    // justifyContent="space-between"
                    justifyContent="space-around"
                    spacing={2}
                    style={{
                        margin: "0.5em 0"
                    }}
                >
                    <Stack direction="column">
                        <Chip label="Avatar" />
                        <UploadOrSelect
                            selectedImage={selectedAvatar}
                            setSelectedImage={setSelectedAvatar}
                            noPreview={true}
                            spacing={1}
                            cb={(image: FileMetadata | null) => {
                                setCreator({
                                    ...creator,
                                    avatar_image: image ? image as FeaturedImage : null,
                                })
                            }}
                        />
                    </Stack>
                    <Stack direction="column">
                        <Chip label="Banner" />
                        <UploadOrSelect
                            selectedImage={selectedBanner}
                            setSelectedImage={setSelectedBanner}
                            noPreview={true}
                            spacing={1}
                            cb={(image: FileMetadata | null) => {
                                // console.log("SLECT BAN", image)
                                setCreator({
                                    ...creator,
                                    banner_image: image ? image as FeaturedImage : null,
                                })
                            }}
                        />
                    </Stack>
                </Stack>

                <Typography>Description</Typography>
                <F2ZMarkdownField
                    content={creator.description}
                    cb={(v) => {
                        setCreator({
                            ...creator,
                            description: v || "",
                        })
                    }}
                    height={377}
                    placeholder={"Describe yourself here"}
                />

                <Divider
                    style={{ margin: "1em 0" }}
                />
                {/* MEMBER PRICE */}
                <Grid container spacing={2}
                    alignItems="center"
                >
                    <Grid item xs={12} md={4}>
                        <Stack
                            direction="row"
                            alignItems="center"
                            justifyContent="center"
                            justifyItems={"center"}
                            alignContent={"center"}
                        >
                            <Typography id="input-slider" gutterBottom>
                                Member Price
                            </Typography>
                            <Link target="_blank" to="/fans-and-stars" component={TransitionLink}>
                                <QuestionMark fontSize="small"
                                    color="info"
                                />
                            </Link>
                        </Stack>
                    </Grid>
                    <Grid item xs={12} md={8}>
                        <Stack direction="row" spacing={3}
                            alignItems="center"
                            justifyContent="center"
                        // justifyItems={"center"}
                        // alignContent={"center"}
                        >
                            <TextField
                                type="number"
                                value={creator.member_price}
                                onChange={handleInputChange}
                                InputProps={{
                                    endAdornment:
                                        <InputAdornment position="end">
                                            <TuziIcon />
                                        </InputAdornment>,
                                }}
                                inputProps={{
                                    min: 0,
                                    max: 1000000,
                                    step: 1,
                                }}
                            // maxWidth="100px"
                            // style={{
                            //     maxWidth: "200px"
                            // }}
                            />
                            {/* <Typography variant="body1" style={{ minWidth: '133px' }}> */}
                            <Typography
                                style={{
                                    minWidth: '133px',
                                }}
                            >
                                {calculatePriceInDollars(Number(creator.member_price))} / month
                            </Typography>
                        </Stack>
                    </Grid>
                </Grid>
                <Divider
                    style={{ margin: "1em 0" }}
                />

                {/* p2p address */}
                <TextField
                    // autoFocus={true}
                    // margin="dense"
                    color="secondary"
                    id="name"
                    label="Peer-to-Peer Address"
                    type="text"
                    helperText={
                        <Typography variant="caption">
                            Add your Zcash address for donations and tips
                        </Typography>

                    }
                    fullWidth
                    variant="standard"
                    value={creator.p2paddr || ""}
                    // helperText={}
                    onKeyDown={(v) => {
                        if (v.keyCode === 13) {
                            handleSubmit()
                        }
                    }}
                    onChange={(v) => {
                        setCreator({
                            ...creator,
                            p2paddr: v.target.value,
                        })
                    }}
                // InputProps={{
                //     endAdornment: (
                //         <InputAdornment position="start">
                //             <Money color="secondary" />
                //         </InputAdornment>
                //     ),
                // }}
                />

                <Stack
                    direction="column"
                    width="100%"
                    alignItems="center"
                    justifyContent="center"
                    spacing={0}
                    style={{
                        margin: "1em 0 0.5em 0",
                    }}
                >

                    {creator.zpages > 0 &&
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={creator.updateAll || false}
                                    onChange={(v) => {
                                        // console.log(v)
                                        setCreator({
                                            ...creator,
                                            // wth? backwards :/
                                            updateAll: v.target.checked,
                                        })
                                        // console.log(creator)
                                    }}
                                />
                            }
                            label={
                                <Typography variant="caption">
                                    Update zPage addresses?
                                </Typography>
                            }
                            labelPlacement="start"
                        />
                    }
                    <Button
                        variant="contained"
                        onClick={() => {
                            handleSubmit()
                        }}
                    >
                        Update Profile
                    </Button>
                </Stack>
            </Paper>
        </>
    )
}
