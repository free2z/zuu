
import { AlertColor } from '@mui/material';
import { createGlobalState } from 'react-hooks-global-state';
import { Creator } from '../Begin'
import { FeaturedImage } from '../components/PageRenderer';

export const defaultCreator = {
    username: "",
    full_name: "",
    p2paddr: "",
    description: "",
    //
    email: "",
    first_name: "",
    last_name: "",
    total: 0,
    tuzis: "0",
    updateAll: false,
    stars: [],
    fans: [],
    is_verified: false,
    can_stream: false,
    member_price: "1",
    zpages: 0,
    avatar_image: null as FeaturedImage | null,
    banner_image: null as FeaturedImage | null,

} as Creator

export const { useGlobalState } = createGlobalState({
    creator: defaultCreator,
    snackbar: {
        open: false,
        severity: "success" as AlertColor,
        message: "",
        duration: undefined as number | undefined | null,
    },
    loading: false,
    loadingEmbed: false,
    // Someone trying to get somewhere but got sent to login
    // or buy 2Zs - try to get them where they are going.
    redirect: "",
    loginModal: false,
    authStatus: null as boolean | null,
    unreadCount: null,
});
