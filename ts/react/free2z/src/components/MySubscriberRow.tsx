import { MoreVert } from "@mui/icons-material";
import {
  Avatar,
  Chip,
  IconButton,
  Link,
  ListItem,
  ListItemAvatar,
  ListItemSecondaryAction,
  ListItemText,
  Menu,
  Stack,
  Typography,
} from "@mui/material";
import moment from "moment";
import CreatorDonate from "./CreatorDonate";
import { Subscription } from "./MySubscribers";
import { useState } from "react";
import TransitionLink from "./TransitionLink";
import { getBrowserSubscriptionAvailabilityCopy } from "./subscriptionAvailability";

type MySubscriberRowProps = {
  index: number;
  sub: Subscription;
};

export default function MySubscriberRow(props: MySubscriberRowProps) {
  const { sub, index } = props;
  const inactive = sub.fan.is_active === false;
  const availabilityCopy = getBrowserSubscriptionAvailabilityCopy();
  const expires = moment(sub.expires);
  const now = moment();
  const ispast = expires.isBefore(now);
  const word = ispast ? "expired" : "renews";

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
        {inactive ? (
          <Avatar alt={sub.fan.username}>
            {sub.fan.username.charAt(0).toUpperCase()}
          </Avatar>
        ) : (
          <Link to={`/${sub.fan.username}`} component={TransitionLink}>
            <Avatar
              alt={sub.fan.username}
              src={sub.fan.avatar_image?.thumbnail}
            />
          </Link>
        )}
      </ListItemAvatar>
      <ListItemText
        primary={
          inactive ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography>{sub.fan.username}</Typography>
              <Chip
                size="small"
                variant="outlined"
                label={availabilityCopy.inactive}
              />
            </Stack>
          ) : (
            <Link to={`/${sub.fan.username}`} component={TransitionLink}>
              <Typography
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {sub.fan.username}
              </Typography>
            </Link>
          )
        }
        secondary={
          inactive
            ? availabilityCopy.subscriberUnavailable
            : sub.max_price > 0
            ? `Subscription ${word} ${expires.fromNow()} for up to ${
                sub.max_price
              }`
            : `Subscription ends ${expires.fromNow()}`
        }
      />
      {!inactive && (
        <ListItemSecondaryAction
        // style={{
        //     marginLeft: "1em",
        //     paddingLeft: "1em",
        // }}
        >
          <IconButton
            aria-label="subscriber actions"
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
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <ListItem
              style={{
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <CreatorDonate creator={sub.fan} />
            </ListItem>
          </Menu>
        </ListItemSecondaryAction>
      )}
    </ListItem>
  );
}
