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
// https://github.com/dai-shi/react-hooks-global-state

// Todo persist to localstorage?
const initialState = {
    pathname: window.location.pathname,
    // currentID: 1,
    currentAccount: {} as Account,
    accounts: [] as Account[],
    // More ... settings and such later
};

export const { useGlobalState } = createGlobalState(initialState)

//////////////////// warp / sqlite


// CREATE TABLE transactions (
//     id_tx INTEGER PRIMARY KEY,
//     account INTEGER NOT NULL,
//     txid BLOB NOT NULL,
//     height INTEGER NOT NULL,
//     timestamp INTEGER NOT NULL,
//     value INTEGER NOT NULL,
//     address TEXT,
//     memo TEXT,
//     tx_index INTEGER,
//     CONSTRAINT tx_account UNIQUE (height, tx_index, account));
// CREATE INDEX i_transaction ON transactions(account);
export interface Transaction {
    account: number
    txid: string
    height: number
    timestamp: number
    value: number
    address: string
    memo: string
    //
    id_tx: number // pk
    tx_index: number
}

// CREATE TABLE received_notes (
//     id_note INTEGER PRIMARY KEY,
//     account INTEGER NOT NULL,
//     position INTEGER NOT NULL,
//     tx INTEGER NOT NULL,
//     height INTEGER NOT NULL,
//     output_index INTEGER NOT NULL,
//     diversifier BLOB NOT NULL,
//     value INTEGER NOT NULL,
//     rcm BLOB NOT NULL,
//     nf BLOB NOT NULL UNIQUE,
//     spent INTEGER,
//     excluded BOOL,
//     CONSTRAINT tx_output UNIQUE (tx, output_index));
// CREATE INDEX i_received_notes ON received_notes(account);
export interface Note { }

// Combines what we get from warp-sync with our own local state

// CREATE TABLE accounts (
//     id_account INTEGER PRIMARY KEY,
//     name TEXT NOT NULL,
//     seed TEXT,
//     aindex INTEGER NOT NULL,
//     sk TEXT,
//     ivk TEXT NOT NULL UNIQUE,
//     address TEXT NOT NULL);
// CREATE INDEX i_account ON accounts(address);
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

// TODO: how to make a method?
export function getBalance(acc: Account): number {
    if (!acc.transactions) {
        return 0
    }
    const result = acc.transactions.reduce((accumulator, tx) => {
        return accumulator + tx.value;
    }, 0);
    return result
}

// Comes from preload.js
interface Z {
    newAccount: (name: string) => void
    getAllAccounts: () => Promise<Account[]>
    getAccount: (id: number) => Promise<Account>
    getAccountByName: (name: string) => Promise<Account>
    getTransactions: (id: number) => Promise<Transaction[]>
    getSyncHeight: () => Promise<number>
    getServerHeight: () => Promise<number>
    setActive: (id: number) => void
    send: (json: string) => string
    skipToLastHeight: () => void
    warp: (offset: number) => any
}

interface IPC {
    rewind: (height: number) => void
    // TODO: type this function!
    onIPCSnackbar: (fn: (event: any, arg: any) => void) => void
}

export const z = (window as any).z as Z

export const ipc = (window as any).ipc as IPC


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
