import { useState } from "react";

import {
  Dialog, DialogTitle, Button, DialogActions, Tooltip, IconButton, Box,
  List,
  ListItem,
  useMediaQuery,
  SwipeableDrawer,
  Accordion,
  AccordionSummary,
  Typography,
  AccordionDetails,
  AccordionActions,
  Stack,
  useTheme,
  Popover,
} from "@mui/material";
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CloseIcon from "@mui/icons-material/Close"
import { Diversity1, GroupAddOutlined } from "@mui/icons-material"

import TuziIcon from "../TuziIcon";
import ZcashIcon from "../ZcashIcon";
import { SimpleCreator } from "../MySubscribers";
import Donate2ZPanel from "../Donate2ZPanel";
import DonateZcashPanel from "../DonateZcashPanel";
import { CreatorSubscribeContent } from "../SubscribeToCreator";
import CreatorDonate from "../CreatorDonate";
import { ProfileBody } from "./ProfileLayout";
import DialogBackdrop from "../common/DialogBackdrop";
import { useGlobalState } from "../../state/global";
import YouAreSubscribed from "../YouAreSubscribed";

type Props = {
  creator: SimpleCreator,
  addr?: string,
  isButton?: boolean,
  initialPanel?: "panel-subscribe" | "panel-donate",
  isDialog?: boolean,
}

export default function CreatorSupport(props: Props) {
  const { creator, addr, isButton, initialPanel = "panel-subscribe", isDialog } = props;
  const [selectedMethod, setSelectedMethod] = useState(!(addr || creator.p2paddr) ? 1 : 0);
  const [open, setOpen] = useState(false);
  const theme = useTheme()
  const isXS = useMediaQuery('(max-width:330px)');
  const isSmall = useMediaQuery(theme.breakpoints.down('sm'))
  const isDarkMode = theme.palette.mode === "dark"
  const [expanded, setExpanded] = useState<string | false>(initialPanel)
  const [anchorEl, setAnchorEl] = useState(null)
  const isSmallHeight = useMediaQuery('(max-height:560px)')
  const [currentUser, _scu] = useGlobalState("creator")

  const is_subbed = currentUser.stars.indexOf(props.creator?.username) !== -1

  const handleClose = () => {
    setOpen(false);
    setAnchorEl(null);
  };

  const handleClick = (event: any) => {
    setOpen(true)
    setAnchorEl(event.currentTarget)
  };

  const handlePopoverClose = () => {
    setAnchorEl(null);
  };


  const handleChangeIndex = (index: number) => {
    setSelectedMethod(index);
  }

  const handleChange =
    (panel: string) => (event: React.SyntheticEvent, newExpanded: boolean) => {
      setExpanded(newExpanded ? panel : false);
    };

  const donatePanel = (
    <ProfileBody>
      <List
        sx={{
          display: "flex",
          flexDirection: "row",
          justifyContent: "center",
          py: 1,
        }}
      >
        {(addr || creator.p2paddr) &&
          <ListItem
            button
            onClick={() => setSelectedMethod(0)}
            selected={selectedMethod === 0}
            sx={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              width: "fit-content",
            }}
          >
            <ZcashIcon />
          </ListItem>
        }
        <ListItem
          button
          onClick={() => setSelectedMethod(1)}
          selected={selectedMethod === 1}
          sx={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            width: "fit-content",
          }}
        >
          <TuziIcon />
        </ListItem>
      </List>

      <Box
        component="div"
        sx={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          overflow: "auto",
          minHeight: 333,
          alignItems: "center",
          justifyContent: "center"
        }}
      >
        {selectedMethod === 0 &&
          <DonateZcashPanel
            creator={creator}
            value={1}
            addr={addr}
          />
        }
        {selectedMethod === 1 &&
          <Donate2ZPanel
            creator={creator}
            value={0}
            handleChangeIndex={handleChangeIndex}
          />
        }
      </Box>
    </ProfileBody>
  )
  const subscribePanel = (
    <ProfileBody>
      {is_subbed ? <YouAreSubscribed {...creator as any} handleClose={handleClose} />
        : <CreatorSubscribeContent showPay star={creator as any} setShowPay={handleClose} onCloseClick={handleClose} />
      }
    </ProfileBody>
  )

  return (
    <>
      {isSmall || isDialog ? (
        <Dialog
          sx={{
            '& .MuiBackdrop-root': {
              backdropFilter: 'blur(16px)',
            },
          }}
          open={open}
          onClose={handleClose}
          slots={{ backdrop: DialogBackdrop }}
          fullScreen={isXS}
          fullWidth={true}
          maxWidth="sm"
        >
          {Boolean(isXS || isSmallHeight) && (
            <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
              <CloseIcon sx={{ fontSize: 40 }} onClick={handleClose} />
            </div>
          )}
          <Stack p="20px" mt={Boolean(isXS || isSmallHeight) ? "40px" : undefined}>
            {initialPanel === "panel-donate" ? donatePanel : null}
            {initialPanel === "panel-subscribe" ? subscribePanel : null}
          </Stack>
        </Dialog>
      ) : (
        <Popover
          // id="simple-menu"
          anchorEl={anchorEl}
          keepMounted
          open={Boolean(anchorEl)}
          onClose={handlePopoverClose}
          style={{
            alignItems: 'center',
            justifyContent: 'center',
          }}
          anchorOrigin={{
            vertical: 'bottom',
            horizontal: 'left',
          }}
          transformOrigin={{
            vertical: 'top',
            horizontal: 'left',
          }}
        >
          <Stack p="20px" width="400px" minHeight="400px" justifyContent="center">
            {initialPanel === "panel-donate" ? donatePanel : null}
            {initialPanel === "panel-subscribe" ? subscribePanel : null}
          </Stack>
        </Popover>
      )}

      {isButton ? (
        <Button
          color={initialPanel === "panel-donate" ? "success" : "secondary"}
          variant="contained"
          onClick={handleClick}
          sx={{ color: isDarkMode ? "#121212" : "#fff", flex: isSmall ? 1 : undefined }}
          endIcon={{
            "panel-subscribe": is_subbed
              ? <Diversity1 style={{ color: isDarkMode ? "#121212" : "#fff" }} />
              : <GroupAddOutlined style={{ color: isDarkMode ? "#121212" : "#fff" }} />,
            "panel-donate": (
              <ZcashIcon
                variant="outlined"
                color={isDarkMode ? "#121212" : "#fff"}
                htmlColor={isDarkMode ? "#121212" : "#fff"}
              />
            )
          }[initialPanel] || null}
        >
          {{
            "panel-subscribe": is_subbed ? "SUBSCRIBED" : "SUBSCRIBE",
            "panel-donate": "DONATE",
          }[initialPanel] || null}
        </Button>
      ) : (
        <Tooltip title="Fund Creator" placement="left">
          <IconButton
            onClick={handleClick}
            sx={{ py: '0px' }}
          >
            <TuziIcon
              variant="outlined"
              color="success"
            />
          </IconButton>
        </Tooltip>
      )}
    </>
  );
}
