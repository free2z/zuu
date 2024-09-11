
import {
    Badge,
    SpeedDial,
    SpeedDialAction,
    Tooltip,
    keyframes,
    styled,
} from "@mui/material"
import { PageInterface } from "./PageRenderer"
import ShareButton from "./ShareButton"
import ZcashPromoteZpage from "./ZcashPromoteZpage"
import ZcashDonateZpage from "./ZcashDonateZpage"
// import ZpageGoToCreator from "./ZpageGoToCreator"
import { useState } from "react"
// import ScrolltoComments from "./ScrolltoComments"
import { useGlobalState } from "../state/global"
import { Edit, VolunteerActivism } from "@mui/icons-material"
import { useTransitionNavigate } from "../hooks/useTransitionNavigate"

export const SBadge = styled(Badge)(({ theme }) => ({
    "& .MuiBadge-badge": {
        right: 18.5,
        top: 38,
        border: `2px solid ${theme.palette.background.paper}`,
        padding: "0 4px",
        whiteSpace: "nowrap",
        textTransform: "none",
    },
}))


export const SBadgeNB = styled(Badge)(({ theme }) => ({
    "& .MuiBadge-badge": {
        right: 17.5,
        top: 38,
        // border: `2px solid ${theme.palette.background.paper}`,
        padding: "0 4px",
        whiteSpace: "nowrap",
    },
}))


const rotateOpen = keyframes`
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(-30deg);
  }
`;

const rotateClose = keyframes`
  0% {
    transform: rotate(-30deg);
  }
  100% {
    transform: rotate(0deg);
  }
`;

const OpenIcon = styled(VolunteerActivism)(({ theme }) => ({
    animation: `${rotateOpen} 0.3s forwards`,
}));

const CloseIcon = styled(VolunteerActivism)(({ theme }) => ({
    animation: `${rotateClose} 0.3s forwards`,
}));


export default function PageMetaFund(props: PageInterface) {
    const [open, setOpen] = useState(false)
    const [user, setUser] = useGlobalState("creator")
    const navigate = useTransitionNavigate()

    return (
        <SpeedDial
            ariaLabel="Actions"
            // icon={<SpeedDialIcon />}
            // icon={<RotatingVolunteerActivismIcon />}
            icon={open ? <OpenIcon /> : <CloseIcon />}
            // onClose={handleClose}
            // onOpen={handleOpen}
            open={open}
            direction="up"
            style={{
                position: "fixed",
                right: "7%",
                // top: "8%",
                bottom: "5%",
                opacity: 0.9,
            }}
            onClick={() => {
                setOpen(!open)
            }}
        >
            {/* TODO: scroll to comments! */}
            {/* <SpeedDialAction
                icon={<ScrolltoComments />}
            /> */}
            {/* <SpeedDialAction
                icon={<ZpageGoToCreator {...props} />}
            /> */}
            {/* <SpeedDialAction
                icon={<AvatarLink {...props.creator} />}
            /> */}
            <SpeedDialAction
                icon={<ShareButton {...props} />}
            />
            <SpeedDialAction
                icon={<ZcashPromoteZpage {...props} />}
            />
            {user.username === props.creator.username ?
                <SpeedDialAction
                    icon={
                        <Tooltip title="Edit" placement="left">
                            <Edit />
                        </Tooltip>
                    }
                    onClick={() => {
                        navigate(`/edit/${props.vanity || props.free2zaddr}`)
                    }}
                />
                :
                <SpeedDialAction
                    icon={<ZcashDonateZpage {...props} />}
                />
            }
        </SpeedDial >

    )
}
