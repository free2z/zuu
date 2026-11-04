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
import { useState } from "react";
import Unsubscribe, { UnsubscribeProps } from "./Unsubscribe";
import TransitionLink from "./TransitionLink";
import { getBrowserSubscriptionAvailabilityCopy } from "./subscriptionAvailability";

type MySubscriptionRowProps = UnsubscribeProps & {
  index: number;
};

export default function MySubscriptionRow(props: MySubscriptionRowProps) {
  const { sub, index, pageQuery, setPageQuery } = props;
  const inactive = sub.star.is_active === false;
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
  // console.log("FFFUKKKCC")

  return (
    <ListItem key={index}>
      <ListItemAvatar>
        {inactive ? (
          <Avatar alt={sub.star.username}>
            {sub.star.username.charAt(0).toUpperCase()}
          </Avatar>
        ) : (
          <Link to={`/${sub.star.username}`} component={TransitionLink}>
            <Avatar
              alt={sub.star.username}
              src={sub.star.avatar_image?.thumbnail}
            />
          </Link>
        )}
      </ListItemAvatar>
      <ListItemText
        primary={
          inactive ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography>{sub.star.username}</Typography>
              <Chip
                size="small"
                variant="outlined"
                label={availabilityCopy.inactive}
              />
            </Stack>
          ) : (
            <Link to={`/${sub.star.username}`} component={TransitionLink}>
              <Typography
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {sub.star.username}
              </Typography>
            </Link>
          )
        }
        secondary={
          inactive
            ? availabilityCopy.creatorUnavailable
            : sub.max_price > 0
            ? `Subscription ${word} ${expires.fromNow()} for up to ${
                sub.max_price
              }`
            : `Subscription ends ${expires.fromNow()}`
        }
      />
      <ListItemSecondaryAction>
        {inactive ? (
          sub.max_price > 0 && (
            <Unsubscribe
              sub={sub}
              pageQuery={pageQuery}
              setPageQuery={setPageQuery}
            />
          )
        ) : (
          <>
            <IconButton aria-label="subscription actions" onClick={handleClick}>
              <MoreVert />
            </IconButton>
            <Menu
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
                <CreatorDonate creator={sub.star} />
              </ListItem>
              {sub.max_price > 0 && (
                <ListItem>
                  <Unsubscribe
                    sub={sub}
                    pageQuery={pageQuery}
                    setPageQuery={setPageQuery}
                  />
                </ListItem>
              )}
            </Menu>
          </>
        )}
      </ListItemSecondaryAction>
    </ListItem>
  );
}
