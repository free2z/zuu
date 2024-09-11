import React, {
    createContext, useContext, useEffect, useRef, useState
} from 'react';
import { SimpleCreator } from '../components/MySubscribers';
import { useQueryClient } from 'react-query';
import { useGlobalState } from '../state/global';


// Sent from push_events management command from events/signals.py
// Event.to_dict
// This is the same event whether through API response or websocket
export interface EventData {
    id: string;
    type: string;
    amount: number;
    receiving_user: SimpleCreator;
    contributor?: SimpleCreator;
    payee?: SimpleCreator;
    message: string;
    content_url: string;
    created_at: string;
    read: boolean;
}


type WebSocketContextValue = {
    lastEvent: EventData | null;
};

const WebSocketContext = createContext<WebSocketContextValue>({ lastEvent: null });

export const useWebSocket = () => {
    return useContext(WebSocketContext);
};

type WebSocketProviderProps = {
    wsUrl: string;
    children: React.ReactNode;
};

export const WebSocketProvider: React.FC<WebSocketProviderProps> = ({ wsUrl, children }) => {
    const [lastEvent, setLastEvent] = useState<EventData | null>(null);
    const queryClient = useQueryClient();
    const [creator, setCreator] = useGlobalState('creator');
    const wsRef = useRef<WebSocket | null>(null); // Using a ref for the WebSocket

    useEffect(() => {
        if (creator.username === '') {
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            return;
        }

        let reconnectTimeoutId: NodeJS.Timeout | null = null;
        const maxReconnectAttempts = 10;
        let reconnectAttempts = 0;

        const connect = () => {
            wsRef.current = new WebSocket(wsUrl);

            wsRef.current.onopen = () => {
                console.log("WS OPEN");
                reconnectAttempts = 0;
            };

            wsRef.current.onmessage = (message) => {
                console.log("ON MESSAGE", message);
                const event: EventData = JSON.parse(message.data).content;
                setLastEvent(event);
                queryClient.invalidateQueries('creatorData');
                queryClient.invalidateQueries('hasEvents');
                queryClient.invalidateQueries('events');
            };

            wsRef.current.onclose = () => {
                if (creator.username === '') {
                    reconnectAttempts += maxReconnectAttempts;
                    return;
                }
                console.log('ws closed, reconnecting...', creator.username);
                reconnectAttempts++;
                if (reconnectAttempts < maxReconnectAttempts) {
                    const backoffTime = Math.min(30000, (Math.pow(2, reconnectAttempts) - 1) * 1000) + Math.random() * 1000;
                    reconnectTimeoutId = setTimeout(connect, backoffTime);
                } else {
                    console.log('Max reconnection attempts reached');
                }
            };
        };

        connect();

        return () => {
            // Clean-up function that closes the WebSocket connection and clears timeout
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            // Clear any pending reconnection timeout to prevent unnecessary reconnects.
            if (reconnectTimeoutId) {
                clearTimeout(reconnectTimeoutId);
                // Reset the timeout ID after clearing.
                reconnectTimeoutId = null;
            }
        };
    }, [wsUrl, creator.username]);

    return (
        <WebSocketContext.Provider value={{ lastEvent }}>
            {children}
        </WebSocketContext.Provider>
    );
};
