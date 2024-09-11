import { useState } from "react"
import { RocketLaunch } from "@mui/icons-material"
import { Tooltip, IconButton } from "@mui/material"
import { PageInterface } from "./PageRenderer"
import BoostPageDialog from "./BoostPageDialog"


export interface EditFundPageProps {
    page: PageInterface
    setPage: React.Dispatch<React.SetStateAction<PageInterface>>
}

export default function BoostPageButton(props: EditFundPageProps) {
    const { page, setPage } = props
    const [openDialog, setOpenDialog] = useState(false)

    return (
        <>
            <Tooltip title="Boost page with 2Zs or Zcash">
                <IconButton
                    onClick={() => setOpenDialog(true)}
                >
                    <RocketLaunch color="success" />
                </IconButton>
            </Tooltip>
            <BoostPageDialog
                page={page}
                setPage={setPage}
                open={openDialog}
                onClose={() => setOpenDialog(false)}
            />
        </>
    )
}
