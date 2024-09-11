import { MoreVert } from "@mui/icons-material"
import { ListItem, ListItemAvatar, Avatar, ListItemText, ListItemSecondaryAction, IconButton, Popover, Link, Menu, Typography } from "@mui/material"
import moment from "moment"
import CreatorDonate from "./CreatorDonate"
import { Subscription } from "./MySubscribers"
import { useState } from "react"
import TransitionLink from "./TransitionLink"


type MySubscriberRowProps = {
    index: number
    sub: Subscription
}


export default function MySubscriberRow(props: MySubscriberRowProps) {
    const { sub, index } = props
    const expires = moment(sub.expires)
    const now = moment()
    const ispast = expires.isBefore(now)
    const word = ispast ? "expired" : "renews"

    const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        setAnchorEl(event.currentTarget);
    };

    const handleClose = () => {
        setAnchorEl(null);
    };

    return (
        <ListItem key={index}>
            <ListItemAvatar>
                <Link
                    to={`/${sub.fan.username}`}
                    component={TransitionLink}
                >
                    <Avatar alt={sub.fan.username} src={sub.fan.avatar_image?.thumbnail} />
                </Link>
            </ListItemAvatar>
            <ListItemText

                primary={
                    <Link

                        to={`/${sub.fan.username}`}
                        component={TransitionLink}
                    >
                        <Typography
                            style={{
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                            }}>
                            {sub.fan.username}
                        </Typography>
                    </Link>
                }
                secondary={
                    sub.max_price > 0 ?
                        `Subscription ${word} ${expires.fromNow()} for up to ${sub.max_price}`
                        : `Subscription ends ${expires.fromNow()}`
                }
            />
            <ListItemSecondaryAction
            // style={{
            //     marginLeft: "1em",
            //     paddingLeft: "1em",
            // }}
            >
                <IconButton
                    // aria-label="more"
                    // aria-controls="subscription-actions"
                    // aria-haspopup="true"
                    onClick={handleClick}
                >
                    <MoreVert />
                </IconButton>
                <Menu
                    // id="simple-menu"
                    anchorEl={anchorEl}
                    keepMounted
                    open={Boolean(anchorEl)}
                    onClose={handleClose}
                    style={{
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <ListItem
                        style={{
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <CreatorDonate
                            creator={sub.fan}
                        />
                    </ListItem>
                </Menu>
            </ListItemSecondaryAction>
        </ListItem>
    )
}