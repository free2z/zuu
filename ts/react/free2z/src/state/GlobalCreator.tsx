import { useEffect } from 'react';
import { useQuery } from 'react-query';
import axios from 'axios';
import { useGlobalState } from './global';

function fetchUserData() {
    // console.log('[GET auth/user] fetchUserData');
    return axios.get('/api/auth/user/').then(res => res.data);
}

export default function GlobalCreator() {
    // const queryClient = useQueryClient();
    const [creator, setCreator] = useGlobalState('creator');
    const [authStatus, setAuthStatus] = useGlobalState('authStatus');

    const { data, error } = useQuery('creatorData', fetchUserData, {
        // no retry so we get the error on the first try
        retry: 0,
    });

    useEffect(() => {
        if (data) {
            // console.log("GLOBAL authstatus true")
            setAuthStatus(true);
            setCreator(data);
        }
        if (error) {
            // console.log("GLOBAL authstatus false", error)
            setAuthStatus(false);
        }
        // console.log("GLOBAL CREATOR USEEFFECT")
        // console.log("data", data)
        // console.log("error", error)
    }, [data, error]);

    return null;
}
