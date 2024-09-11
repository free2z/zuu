// hooks/useMarkAsRead.js
import { useMutation, useQueryClient } from 'react-query';
import axios from 'axios';
import { EventAPIResponse } from '../components/EventFeed';
import { EventData } from './useWebSocket';

const markEventAsRead = async (eventId: string) => {
    axios.defaults.withCredentials = true;
    await axios.post(`/api/events/read/${eventId}/`);
}

export const useMarkAsRead = () => {
    const queryClient = useQueryClient();
    return useMutation(markEventAsRead, {
        onMutate: async (eventId) => {
            await queryClient.cancelQueries('events');
            const previousData = queryClient.getQueryData<{ pages: EventAPIResponse[] }>('events');

            if (previousData) {
                queryClient.setQueryData<{ pages: EventAPIResponse[] }>('events', {
                    pages: previousData.pages.map(page => ({
                        ...page,
                        results: page.results.map((event: EventData) => event.id === eventId ? { ...event, read: true } : event)
                    }))
                });
            }

            return { previousData }
        },
        onError: (err, variables, context) => {
            if (context?.previousData) {
                queryClient.setQueryData('events', context.previousData);
            }
        },
        onSuccess: async () => {
            // queryClient.invalidateQueries('events');
            await queryClient.invalidateQueries('unreadNotifications');
        },
    });
}
