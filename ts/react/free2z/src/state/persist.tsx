// https://github.com/dai-shi/react-hooks-global-state/blob/main/examples/13_persistence/src/state.ts
// https://github.com/dai-shi/react-hooks-global-state/wiki/Persistence
import { Dispatch } from 'react'
import { applyMiddleware } from 'redux'
import { createStore } from 'react-hooks-global-state'

const storage = {
    getItem: (key: string) => {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            console.error("Error accessing local storage: ", e);
            return null;
        }
    },
    setItem: (key: string, value: string) => {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            console.error("Error accessing local storage: ", e);
        }
    }
};

const LOCAL_STORAGE_KEY = 'global'

type State = {
    darkmode: boolean
    profileTab: 0 | 1 | 2
    ppvPrice: number
    homeCreatorSort: "score" | "updated" | "random"
    homePageSort: "score" | "updated" | "random"
}

type Action =
    | { type: 'setDarkmode'; darkmode: boolean }
    | { type: 'setProfileTab'; profileTab: 0 | 1 | 2 }
    | { type: 'setHomeCreatorSort'; sort: "score" | "updated" | "random" }
    | { type: 'setHomePageSort'; sort: "score" | "updated" | "random" }
    | { type: 'setPpvPrice'; price: number }

let mediaQueryObj = window.matchMedia('(prefers-color-scheme: dark)');
let isDarkMode = mediaQueryObj.matches;

const defaultState: State = {
    darkmode: isDarkMode,
    profileTab: 0,
    ppvPrice: 0,
    homeCreatorSort: "score",
    homePageSort: "updated",
};

const parseState = (str: string | null): State | null => {
    try {
        const state = JSON.parse(str || '');
        return state as State;
    } catch (e) {
        return null;
    }
};
const stateFromStorage = parseState(storage.getItem(LOCAL_STORAGE_KEY));
const initialState: State = {
    ...defaultState,
    ...stateFromStorage,
}

const reducer = (state = initialState, action: Action) => {
    switch (action.type) {
        case 'setDarkmode': return {
            ...state,
            darkmode: action.darkmode,
        };
        case 'setProfileTab': return {
            ...state,
            profileTab: action.profileTab,
        };
        case 'setHomeCreatorSort': return {
            ...state,
            homeCreatorSort: action.sort,
        }
        case 'setHomePageSort': return {
            ...state,
            homePageSort: action.sort,
        }
        case 'setPpvPrice': return {
            ...state,
            ppvPrice: action.price,
        }
        default: return state;
    }
};

const saveStateToStorage = (
    { getState }: { getState: () => State },
) => (next: Dispatch<Action>) => (action: Action) => {
    const returnValue = next(action);
    storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(getState()));
    return returnValue;
};

export const { dispatch, useStoreState } = createStore(
    reducer,
    initialState,
    applyMiddleware(saveStateToStorage),
);
