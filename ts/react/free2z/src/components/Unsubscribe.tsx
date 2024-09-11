import { HeartBroken } from "@mui/icons-material";
import { Tooltip, IconButton } from "@mui/material";
import axios from "axios";
import { useGlobalState } from "../state/global";
import { Subscription } from "./MySubscribers";
import { MySubscriptionsPageQuery } from "./MySubscriptions";


export type UnsubscribeProps = {
    sub: Subscription
    pageQuery?: MySubscriptionsPageQuery
    setPageQuery?: React.Dispatch<React.SetStateAction<MySubscriptionsPageQuery>>
}

export default function Unsubscribe(props: UnsubscribeProps) {
    const { sub, pageQuery, setPageQuery } = props
    const [snack, setSnack] = useGlobalState('snackbar')

    function onClick() {
        axios.delete(`/api/tuzis/subscribe/${sub.star.username}`)
            .then(response => {
                // Handle successful response
                // console.log(response.data);
                setSnack({
                    duration: undefined,
                    open: true,
                    message: `Subscription will not renew for ${sub.star.username}`,
                    severity: 'info',
                })
                if (pageQuery && setPageQuery) {
                    setPageQuery({
                        ...pageQuery,
                        reload: !pageQuery.reload
                    })
                }
            })
            .catch(error => {
                console.error(error);
                setSnack({
                    duration: undefined,
                    open: true,
                    message: `Something went wrong: ${error}`,
                    severity: 'error',
                })
            });
    }
    return (
        <Tooltip
            title={`Unsubscribe from ${sub.star.username}`}
            placement="left"
        >
            <IconButton
                // edge="end"
                aria-label="unsubscribe"
                onClick={onClick}
            >
                <HeartBroken
                    // fontSize="small"
                    color="error"
                />
            </IconButton>
        </Tooltip>
    )
}
