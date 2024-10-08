// Define the participant without redundant connection states
export type Participant = {
    uuid: string;                          // Unique identifier for the participant
    name: string;                          // Name of the participant
    websocketState?: boolean;              // WebSocket connection state
    peerConnection?: RTCPeerConnection;    // Associated peer connection object
    dataChannel?: RTCDataChannel;          // Associated data channel object
    error?: string;                        // Optional error message for the participant
};

// Message type represents a message sent by a participant
export type Message = {
    sender: Participant;  // The participant who sent the message
    content: string;      // The content of the message
    timestamp: Date;      // When the message was sent
};

// The overall state for managing participants and messages
export type State = {
    k: number;  // Threshold value for DKG
    n: number;  // Number of participants
    name: string;  // The name of the current participant
    participant_uuid: string;  // The current participant's UUID
    webauthn_credential_id: string;  // WebAuthn credential ID for authentication
    token: string;  // Auth token
    participants: Record<string, Participant>;  // A map of participants by UUID
    messages: Message[];  // List of messages exchanged in the session
};

// Define the actions for updating state
export type Action =
    | { type: 'SET_WEBSOCKET_STATE'; payload: { uuid: string; state: boolean } }
    | { type: 'SET_NAME'; payload: string }
    | { type: 'SET_K'; payload: number }
    | { type: 'SET_N'; payload: number }
    | { type: 'SET_PARTICIPANT_UUID'; payload: string }
    | { type: 'SET_PARTICIPANT_NAME'; payload: { uuid: string; name: string } }
    | { type: 'SET_SERVER_PARTICIPANTS'; payload: Record<string, Participant> }
    | { type: 'UPDATE_PARTICIPANT_P2P_STATE'; payload: { uuid: string; pc?: RTCPeerConnection; dc?: RTCDataChannel } }
    | { type: 'UPDATE_PARTICIPANT_PEER_CONNECTION'; payload: { uuid: string; pc?: RTCPeerConnection } }
    | { type: 'UPDATE_PARTICIPANT_DATA_CHANNEL'; payload: { uuid: string; dc?: RTCDataChannel } }
    | { type: 'CLOSE_DATA_CHANNELS' }
    | { type: 'ADD_OR_UPDATE_PARTICIPANT'; payload: Participant }
    | { type: 'ADD_MESSAGE'; payload: Message }
    | { type: 'SET_TOKEN'; payload: string }
    | { type: 'SET_ERROR'; payload: { uuid: string; error: string } }
    | { type: 'REMOVE_ERROR'; payload: { uuid: string } };

// Reducer function for managing state transitions
export const reducer = (state: State, action: Action): State => {
    switch (action.type) {
        case 'SET_PARTICIPANT_NAME':
            return {
                ...state,
                participants: {
                    ...state.participants,
                    [action.payload.uuid]: {
                        ...state.participants[action.payload.uuid],
                        name: action.payload.name,
                    },
                },
            };
        case 'UPDATE_PARTICIPANT_P2P_STATE':
            return {
                ...state,
                participants: {
                    ...state.participants,
                    [action.payload.uuid]: {
                        ...state.participants[action.payload.uuid],
                        peerConnection: action.payload.pc,
                        dataChannel: action.payload.dc,
                    },
                },
            };
        case 'UPDATE_PARTICIPANT_PEER_CONNECTION':
            return {
                ...state,
                participants: {
                    ...state.participants,
                    [action.payload.uuid]: {
                        ...state.participants[action.payload.uuid],
                        peerConnection: action.payload.pc,
                    },
                },
            };
        case "UPDATE_PARTICIPANT_DATA_CHANNEL":
            return {
                ...state,
                participants: {
                    ...state.participants,
                    [action.payload.uuid]: {
                        ...state.participants[action.payload.uuid],
                        dataChannel: action.payload.dc,
                    },
                },
            };
        case 'CLOSE_DATA_CHANNELS':
            // set .dataChannel undefined for each participant
            return {
                ...state,
                participants: Object.fromEntries(
                    Object.entries(state.participants).map(([key, participant]) => [
                        key,
                        { ...participant, dataChannel: undefined }
                    ])
                )
            };

        case 'SET_WEBSOCKET_STATE':
            return {
                ...state,
                participants: {
                    ...state.participants,
                    [action.payload.uuid]: {
                        ...state.participants[action.payload.uuid],
                        websocketState: action.payload.state, // Track the websocket state only
                    },
                },
            };
        case 'SET_NAME':
            return { ...state, name: action.payload };
        case 'SET_K':
            return { ...state, k: action.payload };
        case 'SET_N':
            return { ...state, n: action.payload };
        case 'SET_SERVER_PARTICIPANTS':
            // make sure we have the UUID for all participants
            // but don't overwrite the dataChannel or peerConnection
            // return {
            //     ...state,
            //     participants: action.payload.reduce((acc, participant) => {
            //         acc[participant.uuid] = participant;
            //         return acc;
            //     });
            // };

            return {
                ...state,
                participants: Object.fromEntries(
                    Object.entries(action.payload).map(([key, participant]) => [
                        key,
                        {
                            ...state.participants[key],
                            ...participant,
                        },
                    ])
                ),
            };

        case 'ADD_OR_UPDATE_PARTICIPANT':
            return {
                ...state,
                participants: {
                    ...state.participants,
                    [action.payload.uuid]: {
                        ...state.participants[action.payload.uuid],
                        ...action.payload, // Update the participant details
                    },
                },
            };
        case 'ADD_MESSAGE':
            return { ...state, messages: [...state.messages, action.payload] };
        case 'SET_PARTICIPANT_UUID':
            return { ...state, participant_uuid: action.payload };
        case 'SET_TOKEN':
            return { ...state, token: action.payload };
        case 'SET_ERROR':
            return {
                ...state,
                participants: {
                    ...state.participants,
                    [action.payload.uuid]: {
                        ...state.participants[action.payload.uuid],
                        error: action.payload.error, // Track participant errors
                    },
                },
            };
        case 'REMOVE_ERROR':
            return {
                ...state,
                participants: {
                    ...state.participants,
                    [action.payload.uuid]: {
                        ...state.participants[action.payload.uuid],
                        error: undefined, // Clear errors
                    },
                },
            };
        default:
            return state;
    }
};

// Initial state for the application
export const initialState: State = {
    k: 0,
    n: 0,
    name: '',
    participant_uuid: '',
    webauthn_credential_id: '',
    token: '',
    participants: {},
    messages: [],
};
