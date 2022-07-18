
import Dexie from 'dexie'

import { Account, Transaction, Note } from './models'
import { readAccount } from './util';

// Take 1: do all of the personas in the same database

export class AppDatabase extends Dexie {

    public accounts!: Dexie.Table<Account, string>
    public notes!: Dexie.Table<Note, string>
    public transactions!: Dexie.Table<Transaction, string>

    constructor() {

        super("ZUULI")
        const db = this

        // Declare tables, IDs and indexes
        db.version(1).stores({
            // password (for f2z) could be a hash of the seed phrase?
            accounts: '&gid, username, password, seed, height, datetime, ua, za, ta, total, spendable, transparent',
            transactions: '&gid, accountID, height, datetime, amount, txid, memo',
            notes: '&gid, accountID, height, datetime, amount',
        });

        db.accounts.mapToClass(Account)
        db.notes.mapToClass(Note)
        db.transactions.mapToClass(Transaction)
    }
}
export const db = new AppDatabase()

export const CURRENT_ACCOUNT_ID = 'currentAccountID'


// Get the GID from localstorage
export function getCurrentGID() {
    return localStorage.getItem(CURRENT_ACCOUNT_ID)
}

// Set the GID to localstorage
export function setCurrentGID(gid: string) {
    return localStorage.setItem(CURRENT_ACCOUNT_ID, gid)
}

// return the current account
export async function getCurrentAccount(
    db: AppDatabase,
): Promise<Account | undefined> {
    const gid = getCurrentGID()
    if (!gid) {
        return undefined
    }
    return await readAccount(db, gid)
}
