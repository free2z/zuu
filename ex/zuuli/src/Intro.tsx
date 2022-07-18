import React from "react"

import {
    Button, Divider, Grid, Link, Paper, Typography,
    TextField
} from "@mui/material"
import ArrowCircleRightIcon from "@mui/icons-material/ArrowCircleRight"
import ContentCopyIcon from "@mui/icons-material/ContentCopy"
import AddCircleIcon from "@mui/icons-material/AddCircle"

import { HelpCenter } from "@mui/icons-material"

import { Biotech } from "@mui/icons-material"
import { Account } from "./db/models"
import NewOrRestoreModal from "./components/NewOrRestoreModal"
import { createAccount, saveAccountRelations } from "./db/util"
import { db, setCurrentGID } from "./db/db"
import { useNavigate } from "react-router-dom"


const fakeWords = [
    "proclaim",
    "therapist",
    "section",
    "studio",
    "replace",
    "edition",
    "nonsense",
    "tragedy",
    "electron",
    "variety",
    "reflect",
    "object",
    "attraction",
    "return",
    "presentation",
    "engine",
    "humanity",
    "sunday",
    "ballet",
    "fiction",
    "passage",
    "earthflax",
    "muscle",
    "commission",
]

export default function Intro() {
    const navigate = useNavigate()

    const [account, setAccount] = React.useState({
        username: ""
    } as Account)
    const [showSeed, setShowSeed] = React.useState(false)
    const [showNew, setShowNew] = React.useState(true)
    const [showRestore, setShowRestore] = React.useState(true)
    const [showSave, setShowSave] = React.useState(false)
    const [isRestore, setIsRestore] = React.useState(false)

    async function saveAccount() {
        console.log(account)
        const gid = await createAccount(db, account)
        setCurrentGID(gid)
        navigate("/receive")
    }

    return (
        <Grid
            container
            spacing={1}
            direction="column"
            alignItems="center"
            textAlign="center"
            justifyContent="center"
            style={{ minHeight: "100vh" }}
        >
            <Grid item xs={12}>
                <Typography variant="h6" color="secondary">
                    Create a Zcash Account
                </Typography>
                <Typography variant="subtitle1">No intermediaries</Typography>
                <Typography variant="subtitle2">No personal data stored</Typography>
            </Grid>

            <Divider
            // variant="inset"
            // style={{ width: "100%" }}
            >

            </Divider>
            <Grid item xs={6}>
                <TextField
                    fullWidth
                    label="Account Name"
                    value={account.username}
                    placeholder="Account Name"
                    error={showSave && !account.username}
                    onChange={(ev) => {
                        // account.username = ev.target.value
                        setAccount({
                            ...account,
                            username: ev.target.value,
                        } as Account)
                    }}
                // style={{ textAlign: "center" }}
                />
            </Grid>

            <Grid
                container
                item
                xs={10}
                style={{
                    // maxWidth: "80%",
                    width: "100%",
                }}
            >
                <Grid
                    item xs={10} sm={8} md={6} lg={5} xl={4}
                    style={{ margin: "0 auto" }}
                >
                    <Divider style={{
                        margin: "0.5em",
                        // width: "100%",
                    }} >
                        <NewOrRestoreModal />
                    </Divider>

                    {showNew &&
                        <Button
                            variant="outlined"
                            color="success"
                            style={{
                                margin: "1em",
                                width: "39%",
                            }}
                            endIcon={<AddCircleIcon />}
                            onClick={() => {
                                account.seed = fakeWords.join(" ")
                                account.height = 1730000
                                setAccount(account)
                                setShowSeed(true)
                                setShowNew(false)
                                setShowRestore(false)
                                setShowSave(true)
                            }}
                        >
                            New
                        </Button>
                    }

                    {showRestore &&
                        <Button
                            variant="outlined"
                            color="success"
                            style={{
                                margin: "1em",
                                width: "39%",
                            }}
                            endIcon={<AddCircleIcon />}
                            onClick={() => {
                                setShowSeed(true)
                                setShowNew(false)
                                setShowRestore(false)
                                setShowSave(true)
                                setIsRestore(true)
                            }}
                        >
                            Restore
                        </Button>
                    }

                    {showSeed &&
                        <>
                            <TextField
                                fullWidth
                                label="24 word seed phrase"
                                placeholder="24 word seed phrase to restore (optional)"
                                value={account.seed}
                                multiline={true}
                                rows={7}
                            />
                            <TextField
                                label="Start Height"
                                value={account.height}
                                style={{ margin: "1em" }}
                            />
                        </>

                    }
                </Grid>
            </Grid>
            <Grid
                item
                xs={12}
            // style={{ minWidth: 400 }}
            >
                {showSave && account.username &&
                    <Button
                        variant="outlined"
                        color="success"
                        style={{ margin: "1em 0 0.5em 0" }}
                        endIcon={<AddCircleIcon />}
                        onClick={() => {
                            saveAccount()
                        }}
                    >
                        Save
                    </Button>
                }
            </Grid>

            <Grid item xs={12}></Grid>
            <Grid item xs={12}></Grid>
            <Grid item xs={12}></Grid>
            <Grid item xs={12}></Grid>
        </Grid>
    )
}
