import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import {
  ManageAccounts,
  AddCircle,
  LiveTv,
  TravelExplore,
  Upload,
  Diversity2Outlined,
  Home,
  Search,
  Login,
  HelpOutline,
  Code,
} from "@mui/icons-material";
import {
  IconButton,
  Avatar,
  Menu,
  Tooltip,
  MenuItem,
  Typography,
  Box,
  MenuItemProps,
} from "@mui/material";
import { alpha } from "@mui/system";

import LogoutButton from "./LogoutButton";
import TuziMenuItem from "./TuzisMenuItem";
import { useGlobalState } from "../state/global";
import TransitionLink from "./TransitionLink";
import DarkMode from "./DarkMode";
import DarkModeMenuItem from "./DarkModeMenuItem";
import StartLiveStreamDialog from "./StartLiveStreamDialog";

const menuItemStyle = {
  padding: "0.5em 1em",
};

interface MenuItemWithIconProps<T extends React.ElementType = React.ElementType>
  extends Omit<MenuItemProps, "component"> {
  component?: T;
  to?: string;
  tip: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  active?: boolean;
  onBeforeNavigate?: () => void;
}

export function MenuItemWithIcon<
  T extends React.ElementType = React.ElementType
>({ icon, label, tip, active, ...props }: MenuItemWithIconProps<T>) {
  return (
    <Tooltip title={tip} placement="left">
      <MenuItem
        style={menuItemStyle}
        {...props}
        sx={{
          backgroundColor: (theme) =>
            active ? alpha(theme.palette.primary.main, 0.1) : "transparent",
          color: (theme) =>
            active ? theme.palette.primary.main : theme.palette.text.primary,
          pointerEvents: active ? "none" : undefined,
          "&:hover": {
            backgroundColor: (theme) => alpha(theme.palette.primary.main, 0.05),
            // color: (theme) => theme.palette.primary.main,
          },
        }}
        // disabled={active}
      >
        <Box
          component="div"
          display="flex"
          width="100%"
          alignItems="center"
          justifyContent="flex-start"
        >
          <Box component="div" display="flex" alignItems="center" mr={2}>
            {icon}
          </Box>
          <Box
            component="div"
            display="flex"
            alignItems="center"
            paddingTop="2px"
          >
            <Typography>{label}</Typography>
          </Box>
        </Box>
      </MenuItem>
    </Tooltip>
  );
}

export default function AvatarMenu() {
  const [creator, setCreator] = useGlobalState("creator");
  const [loginModal, setLoginModal] = useGlobalState("loginModal");
  const [authStatus, setAuthStatus] = useGlobalState("authStatus");

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const location = useLocation();

  const [isActive, setIsActive] = useState(
    location.pathname.startsWith("/edit/new")
  );
  const [isLiveStreamDialogOpen, setLiveStreamDialogOpen] = useState(false);

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
  };

  useEffect(() => {
    setIsActive(location.pathname.startsWith("/edit/new"));
  }, [location.pathname]);

  const avatarTool = creator.username
    ? `Logged in as ${creator.username}`
    : "Not logged in";

  if (authStatus === null) {
    return <></>;
  }

  if (authStatus === false) {
    return (
      <Box component="div" display="flex">
        <Tooltip title="Login">
          <IconButton
            onClick={() => {
              setLoginModal(true);
            }}
            size="large"
          >
            <Login color="primary" />
          </IconButton>
        </Tooltip>
      </Box>
    );
  }
  const isAIInterface =
    location.pathname.startsWith("/ai") &&
    !location.pathname.startsWith("/ai/public") &&
    !location.pathname.startsWith("/ai/conversation/");
  // console.log("AvatarMenu: location.pathname", location.pathname)

  const noMoreNew = creator.zpages > 0 && Number(creator.tuzis) < 1;
  const newzpageLabel = noMoreNew ? "Reviewing..." : "New zPage";

  return (
    <>
      <Tooltip title={avatarTool}>
        <IconButton onClick={handleMenuOpen}>
          <Avatar src={creator.avatar_image?.thumbnail} color="info" />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleMenuClose}
      >
        {isAIInterface && (
          <MenuItemWithIcon
            onBeforeNavigate={handleMenuClose}
            component={TransitionLink}
            to={"/"}
            icon={<Home color="primary" />}
            label="Home"
            tip="Home"
          />
        )}
        {isAIInterface && (
          <MenuItemWithIcon
            onBeforeNavigate={handleMenuClose}
            component={TransitionLink}
            to={"/find"}
            icon={<Search color="secondary" />}
            label="Find"
            tip="Find"
          />
        )}
        <MenuItemWithIcon
          onBeforeNavigate={handleMenuClose}
          component={TransitionLink}
          to={"/profile"}
          icon={<ManageAccounts color="primary" />}
          label="Profile"
          tip="Manage"
          active={location.pathname === "/profile"}
        />
        <MenuItemWithIcon
          onBeforeNavigate={handleMenuClose}
          component={TransitionLink}
          to="/edit/new"
          icon={<AddCircle color="success" />}
          label={newzpageLabel}
          tip="Create zPage"
          active={isActive}
          disabled={noMoreNew}
        />
        <TuziMenuItem {...creator} />
        <MenuItemWithIcon
          onBeforeNavigate={handleMenuClose}
          component={TransitionLink}
          to="/profile/uploads"
          icon={<Upload color="info" />}
          label="Media"
          tip="Upload Files"
          active={location.pathname.startsWith("/profile/uploads")}
        />
        <MenuItemWithIcon
          // onBeforeNavigate={handleMenuClose}
          onClick={() => setLiveStreamDialogOpen(true)} // Add the onClick handler here
          icon={<LiveTv color="success" />}
          label="Stream"
          tip="Live Stream"
        />
        <StartLiveStreamDialog
          open={isLiveStreamDialogOpen}
          onClose={() => setLiveStreamDialogOpen(false)}
          creatorUsername={creator.username}
        />
        <MenuItemWithIcon
          onBeforeNavigate={handleMenuClose}
          component={TransitionLink}
          to="/ai/public"
          icon={<Diversity2Outlined color="secondary" />}
          label="Chat2Z"
          tip="AI Chat"
          active={location.pathname === "/ai/public"}
        />
        <DarkModeMenuItem />
        <MenuItemWithIcon
          onClick={() => {
            window.open("/docs/", "_blank");
          }}
          icon={<HelpOutline color="info" />}
          label="Docs"
          tip="Learn More"
        />
        <MenuItemWithIcon
          onClick={() => {
            window.open(
              "https://github.com/free2z/zuu/blob/main/ts/react/free2z",
              "_blank"
            );
          }}
          icon={<Code color="success" />}
          label="Contribute"
          tip="Get involved"
        />
        <LogoutButton
          onClick={() => {
            handleMenuClose();
          }}
        />
      </Menu>
    </>
  );
}
