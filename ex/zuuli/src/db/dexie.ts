import Dexie from 'dexie'

import { Account, Transaction, Note } from './models'


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
