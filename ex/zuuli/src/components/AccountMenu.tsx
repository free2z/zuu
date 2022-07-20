import * as React from 'react';
import { Grid, Toolbar } from '@mui/material'

import Box from '@mui/material/Box';
import Avatar from '@mui/material/Avatar';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import PersonAdd from '@mui/icons-material/PersonAdd';
import Settings from '@mui/icons-material/Settings';
import Logout from '@mui/icons-material/Logout';

import { useLiveQuery } from "dexie-react-hooks"
import { readAllAccounts } from "../db/util"
import { db, getCurrentAccount, getCurrentGID, setCurrentGID } from "../db/db"
import { Account, Accounts } from '../db/models';
import { useNavigate } from 'react-router-dom';
import { collapseTextChangeRangesAcrossMultipleVersions } from 'typescript';


export default function AccountMenu() {
    const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
    const open = Boolean(anchorEl);
    const handleClick = (event: React.MouseEvent<HTMLElement>) => {
        setAnchorEl(event.currentTarget);
    };
    const handleClose = () => {
        setAnchorEl(null);
    }

    const navigate = useNavigate()

    React.useEffect(() => {
        console.log("USE EFFECT")
        console.log(getCurrentGID())
        if (!getCurrentGID()) {
            navigate("/intro")
        }
    }, []);

    const [account, setAccount] = React.useState({} as Account)

    const accounts = useLiveQuery(async () => {
        console.log("ACCOUNTS USELIVEQUERY")
        const account = await getCurrentAccount(db)
        if (!account) {
            // throw new Error("NO ACCOUNT!!!");
            navigate("/intro")
            return
        }
        setAccount(account)
        return await readAllAccounts(db)
    })
    console.log(accounts)

    if (!account.username) {
        return <></>
    }

    return (
        <>
            <Tooltip title="Account settings">
                <IconButton
                    onClick={handleClick}
                    size="large"
                    // sx={{
                    //     ml: 2
                    // }}
                    aria-controls={open ? 'account-menu' : undefined}
                    aria-haspopup="true"
                    aria-expanded={open ? 'true' : undefined}
                >
                    <Avatar
                        sx={{ width: 32, height: 32 }}
                    >{account.username.at(0)?.toUpperCase()}</Avatar>
                </IconButton>
            </Tooltip>
            <Menu
                anchorEl={anchorEl}
                id="account-menu"
                open={open}
                onClose={handleClose}
                onClick={handleClose}
                PaperProps={{
                    elevation: 0,
                    sx: {
                        overflow: 'visible',
                        filter: 'drop-shadow(0px 2px 8px rgba(0,0,0,0.32))',
                        mt: 1.5,
                        '& .MuiAvatar-root': {
                            width: 32,
                            height: 32,
                            ml: -0.5,
                            mr: 1,
                        },
                        '&:before': {
                            content: '""',
                            display: 'block',
                            position: 'absolute',
                            top: 0,
                            // right: 14,
                            right: 23,
                            width: 10,
                            height: 10,
                            bgcolor: 'background.paper',
                            transform: 'translateY(-50%) rotate(45deg)',
                            zIndex: 0,
                        },
                    },
                }}
                transformOrigin={{ horizontal: 'right', vertical: 'top' }}
                anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
            >
                {/* <> */}
                {accounts?.map(acc => {

                    return (
                        <MenuItem
                            onClick={() => {
                                if (!acc.gid) { return }
                                setCurrentGID(acc.gid)
                            }}
                            key={acc.gid}
                        >
                            <Avatar /> {acc.username}
                        </MenuItem>
                    )

                })}
                <Divider />
                <MenuItem
                    onClick={() => {
                        navigate("/intro")
                    }}
                >
                    <ListItemIcon>
                        <PersonAdd fontSize="small" />
                    </ListItemIcon>
                    Add another account
                </MenuItem>
                <MenuItem>
                    <ListItemIcon>
                        <Settings fontSize="small" />
                    </ListItemIcon>
                    Settings
                </MenuItem>
                {/* </> */}
            </Menu>
        </>
    );
}
