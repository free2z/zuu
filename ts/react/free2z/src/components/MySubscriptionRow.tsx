import { MoreVert } from "@mui/icons-material"
import { ListItem, ListItemAvatar, Avatar, ListItemText, ListItemSecondaryAction, IconButton, Popover, Link, Menu, Typography } from "@mui/material"
import moment from "moment"
import CreatorDonate from "./CreatorDonate"
import { useState } from "react"
import Unsubscribe, { UnsubscribeProps } from "./Unsubscribe"
import TransitionLink from "./TransitionLink"


type MySubscriptionRowProps = UnsubscribeProps & {
    index: number
}


export default function MySubscriptionRow(props: MySubscriptionRowProps) {
    const { sub, index, pageQuery, setPageQuery } = props
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
    // console.log("FFFUKKKCC")

    return (
        <ListItem key={index}>
            <ListItemAvatar>
                <Link
                    to={`/${sub.star.username}`}
                    component={TransitionLink}
                >
                    <Avatar alt={sub.star.username} src={sub.star.avatar_image?.thumbnail} />
                </Link>
            </ListItemAvatar>
            <ListItemText
                primary={
                    <Link
                        to={`/${sub.star.username}`}
                        component={TransitionLink}
                    >
                        <Typography
                            style={{
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                            }}>
                            {sub.star.username}
                        </Typography>
                    </Link>
                }
                secondary={
                    sub.max_price > 0 ?
                        `Subscription ${word} ${expires.fromNow()} for up to ${sub.max_price}`
                        : `Subscription ends ${expires.fromNow()}`
                }
            />
            <ListItemSecondaryAction>
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
                            creator={sub.star}
                        />
                    </ListItem>
                    {sub.max_price > 0 &&
                        <ListItem>
                            <Unsubscribe
                                sub={sub}
                                pageQuery={pageQuery}
                                setPageQuery={setPageQuery}
                            />
                        </ListItem>
                    }
                </Menu>
            </ListItemSecondaryAction>
        </ListItem>
    )
}