import React from "react"

import {
    Button, Divider, Grid, Link, Paper, Typography,
    TextField
} from "@mui/material"
import ArrowCircleRightIcon from "@mui/icons-material/ArrowCircleRight"
import ContentCopyIcon from "@mui/icons-material/ContentCopy"
import AddCircleIcon from "@mui/icons-material/AddCircle"

import { Engineering, HelpCenter } from "@mui/icons-material"

import NewOrRestoreModal from "./components/NewOrRestoreModal"
import { z, Account, CURRENT_ACCOUNT_ID, setCurrentID, useGlobalState } from "./db/db"
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
    const [newAccount, setNewAccount] = React.useState({} as Account)
    const [currentAccount, setCurrentAccount] = useGlobalState("currentAccount")
    const [path, setPath] = useGlobalState("pathname")

    const [name, setName] = React.useState("")
    const [showSeed, setShowSeed] = React.useState(false)
    const [showNew, setShowNew] = React.useState(true)
    const [showRestore, setShowRestore] = React.useState(true)
    const [showSave, setShowSave] = React.useState(false)
    const [isRestore, setIsRestore] = React.useState(false)

    async function saveAccount() {
        // const gid = await createAccount(db, account)
        // z.newAccount(name)
        // const acc = await z.getAccountByName(name)
        setCurrentID(`${newAccount.id_account}`)
        setCurrentAccount(newAccount)
        // What about restore?
        setPath("/receive")
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
                    value={name}
                    placeholder="Account Name"
                    error={showSave && !name}
                    onChange={(ev) => {
                        // account.username = ev.target.value
                        setName(ev.target.value)
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
                                width: "38%",
                            }}
                            disabled={name === ""}
                            endIcon={<AddCircleIcon />}
                            onClick={async () => {

                                z.newAccount(name)
                                const newacc = await z.getAccountByName(name)
                                const height = await z.getServerHeight()
                                newacc.height = height
                                setNewAccount(newacc)

                                setShowSeed(true)
                                setShowNew(false)
                                setShowRestore(false)

                                // account.seed = fakeWords.join(" ")
                                // account.height = z.getServerHeight()
                                setShowSave(true)
                            }}
                        >
                            New
                        </Button>
                    }

                    {showRestore &&
                        <Button
                            variant="outlined"
                            color="warning"
                            style={{
                                margin: "1em",
                                width: "38%",
                            }}
                            disabled={!name}
                            endIcon={<Engineering />}
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
                                value={newAccount.seed}
                                multiline={true}
                                rows={7}
                            />
                            <TextField
                                label="Start Height"
                                value={newAccount.height}
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
                {showSave && newAccount.name &&
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
