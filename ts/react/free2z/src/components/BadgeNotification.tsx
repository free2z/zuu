import React from 'react';
import { useQuery, useQueryClient } from 'react-query';
import axios from 'axios';
import { Badge, styled } from '@mui/material';
import { useGlobalState } from '../state/global';


const StyledBadge = styled(Badge)(({ theme }) => ({
    // variant: 'outlined',
    // padding: '8px',
    // position: 'relative', // Added this to establish positioning context.
    style: {
        opacity: 1,
    },
    "& .MuiBadge-badge": {
        opacity: 0.9,
        fontSize: '0.65rem',
        fontWeight: '130%',
        minWidth: '22px',
        height: '22px',
        // padding: '8px',
        // position: 'absolute',
        transform: 'translate(-50%, -50%)',
        top: '50%',
        left: '50%', // Changed right to left to center along the x-axis.
    },
}))

// Function to fetch unread notifications count
async function fetchUnreadNotifications() {
    const response = await axios.get('/api/events/unread_count/')
    return response.data;
}

interface BadgeNotificationProps {
    children: React.ReactNode;
}

const BadgeNotification: React.FC<BadgeNotificationProps> = ({ children }) => {
    const [creator, setCreator] = useGlobalState("creator");
    const queryClient = useQueryClient()

    const {
        data: unreadCount,
    } = useQuery("unreadNotifications", fetchUnreadNotifications, {
        enabled: !!creator.username,
        onSuccess: (data) => {
            queryClient.invalidateQueries("hasEvents")
        }
    });

    return (
        <StyledBadge
            badgeContent={unreadCount || null}
            color="info"
        >
            {children}
        </StyledBadge>
    )
}

export default BadgeNotification;
