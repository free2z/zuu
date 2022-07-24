import { createGlobalState } from 'react-hooks-global-state';

/////// Localstorage stuff

export const CURRENT_ACCOUNT_ID = 'currentAccountID'

// // Get the GID from localstorage
export function getCurrentID() {
    return localStorage.getItem(CURRENT_ACCOUNT_ID)
}

// Set the GID to localstorage
export function setCurrentID(id: string) {
    localStorage.setItem(CURRENT_ACCOUNT_ID, id)
}

///////////// reaxt-hooks-global-state

// Todo persist to localstorage?
const initialState = {
    // currentID: 1,
    currentAccount: {} as Account,
    accounts: [] as Account[],
    // More ... settings and such later
};

export const { useGlobalState } = createGlobalState(initialState)

//////////////////// warp / sqlite

interface Transaction { }

interface Note { }

// Combines what we get from warp-sync with our own local state?
export interface Account {
    id_account: number,
    name: string,
    // Free2z?
    // public password: string,
    //
    // Birth, restore
    height?: number,
    // public datetime: Date,
    //
    seed: string,
    sk: string,
    // Sapling
    ivk: string,
    address: string,
    // t-addr
    taddress: string,
    // Orchard
    // public ua: string,

    // balances
    // public total: string,
    // public spendable: string,
    // public transparent: string,

    transactions: Transaction[],
    notes: Note[],
}

// Comes from preload.js
interface Z {
    newAccount: (name: string) => void
    getAllAccounts: () => Promise<Account[]>
    getAccount: (id: number) => Promise<Account>
    getAccountByName: (name: string) => Promise<Account>
    getServerHeight: () => number
    setActive: (id: number) => void
}

export const z = (window as any).z as Z


// return the current account
export async function getCurrentAccount(): Promise<Account> {
    // const [id, _] = useLocalStorage(CURRENT_ACCOUNT_ID)
    const id = getCurrentID()
    if (!id) {
        const accs = await z.getAllAccounts()
        return accs[0]
    }
    return await z.getAccount(parseInt(id))
}

export async function setCurrentAccount(acc: Account) {
    setCurrentID(`${acc.id_account}`)
    return await z.getAccount(acc.id_account)
}

export async function readAllAccounts(): Promise<Account[]> {
    return z.getAllAccounts()
}
