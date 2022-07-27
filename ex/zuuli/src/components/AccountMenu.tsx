import * as React from 'react';
import { CircularProgress, Grid, Toolbar } from '@mui/material'

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

import {
    Account,
    getCurrentAccount, readAllAccounts,
    z, setCurrentID,
    useGlobalState,
} from "../db/db"
// import { Account, Accounts } from '../db/models';
import { useNavigate } from 'react-router-dom';


export default function AccountMenu() {

    const [account, setAccount] = useGlobalState('currentAccount')
    const [accounts, setAccounts] = useGlobalState('accounts')
    const [path, setPath] = useGlobalState('pathname')

    const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
    const open = Boolean(anchorEl);
    const handleClick = (event: React.MouseEvent<HTMLElement>) => {
        setAnchorEl(event.currentTarget);
    };
    const handleClose = () => {
        setAnchorEl(null);
    }
    const navigate = useNavigate()

    // const [account, setAccount] = React.useState({} as Account)
    // const [accounts, setAccounts] = React.useState([] as Account[])

    React.useEffect(() => {
        (async () => {
            const _accounts = await readAllAccounts()
            const _account = await getCurrentAccount()
            if (!_account || !_accounts || _accounts.length === 0 || !_account.name) {
                console.log("SKIPPING TO LAST HEIGHT")
                z.skipToLastHeight()
                setPath("/intro")
                navigate("/intro")
            }
            setAccounts(_accounts)
            setAccount(_account)
        })()
    }, [])

    if (!account || !accounts || accounts.length === 0 || !account.name) {
        // return <Typography>Loading...</Typography>
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
                    >{account.name.at(0)}</Avatar>
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
                                if (acc.id_account === account.id_account) {
                                    // settings
                                    setPath('/')
                                    navigate('/')
                                }
                                if (!acc.id_account) { return }
                                // console.log("Click user, SETID", acc)
                                setCurrentID(`${acc.id_account}`)
                                z.setActive(acc.id_account)
                                setAccount(acc)
                            }}
                            key={acc.id_account}
                            selected={acc.id_account === account.id_account}
                        >
                            <Avatar /> {acc.name}
                        </MenuItem>
                    )

                })}
                <Divider />
                <MenuItem
                    onClick={() => {
                        setPath("/intro")
                        navigate("/intro")
                    }}
                >
                    <ListItemIcon>
                        <PersonAdd fontSize="small" />
                    </ListItemIcon>
                    Add another account
                </MenuItem>
                <MenuItem
                    onClick={() => {
                        setPath('/')
                        navigate('/')
                    }}
                >
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
