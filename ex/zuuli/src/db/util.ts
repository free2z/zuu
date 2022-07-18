// Utilities and examples for working with async Dexie setup
// https://developer.fireflysemantics.com/tasks/tasks--dexie--one-to-many-relationships-with-dexie


import cuid from 'cuid'

import { AppDatabase } from './db'
import { Account, Transaction, Note } from './models'

//////////// DB ops

/**
 * Delete the entire database
 */
export async function deleteDatabase(db: AppDatabase) {
    await db.delete()
}

/**
 * Open a database
 */
export async function openDatabase(db: AppDatabase) {
    await db.open()
}

/**
 * Clear all tables
 */
export async function clearAllTables(db: AppDatabase) {
    await Promise.all([
        db.accounts.clear(),
        db.transactions.clear(),
        db.notes.clear(),
    ])
}

///////////// Account operations

/**
 * Read all Accounts
 */
export async function readAllAccounts(db: AppDatabase): Promise<Account[]> {
    return await db.accounts.toArray()
}

/**
 * Delete all Accounts
 */
export async function deleteAllAccounts(db: AppDatabase) {
    return await db.accounts.clear()
}

/**
 * Create or Update an Account
 *
 * Note that since the Account is guaranteed
 * to have a unique ID we are using `put`
 * to update the database.
 *
 * if a GID is on the object it will update,
 * if no GID, the object will be create
 */
export async function createAccount(
    db: AppDatabase,
    account: Account,
): Promise<string> {
    if (!account.gid) {
        account.gid = cuid()
    }
    return await db.accounts.put(account)
}


export const updateAccount = createAccount

/**
 * Read an Account
 * const acc:Account = await readAccount(db, arnold.gid)
 */
export async function readAccount(
    db: AppDatabase,
    GID: string,
): Promise<Account | undefined> {
    return await db.accounts.get(GID)
}

/**
 * Delete Account
 */
export async function deleteAccount(db: AppDatabase, account: Account) {
    if (!account.gid) {
        return 0
    }
    return await db.accounts.where('gid').equals(account.gid).delete()
}

/////////////// Transactions

/**
 * Create Transaction record
 */
export async function createTransaction(
    db: AppDatabase,
    transaction: Transaction,
) {
    return await db.transactions.put(transaction)
}
export const updateTransaction = createTransaction



/**
 * Load transactions for Account
 */
export async function loadAccountTransactions(
    db: AppDatabase,
    account: Account,
) {
    if (!account.gid) {
        throw new Error("No account.gid")
    }
    account.transactions =
        await db.transactions.where('accountID').equals(account.gid).toArray()
    return account.transactions
}

/////////////////// Notes

/**
 * Create Note record
 */
export async function createNote(
    db: AppDatabase,
    note: Note,
) {
    return await db.notes.put(note)
}
export const updateNote = createNote


/**
 * Load notes for Account
 */
export async function loadAccountNotes(
    db: AppDatabase,
    account: Account,
) {
    if (!account.gid) {
        throw new Error("No account.gid")
    }
    account.notes =
        await db.notes.where('accountID').equals(account.gid).toArray()
    return account.notes
}


//////////// Relations

/**
 * Load Account properties (Transactions and Notes)
 */
export async function loadAccountProperties(
    db: AppDatabase,
    account: Account,
) {
    [account.transactions, account.notes] = await Promise.all([
        loadAccountTransactions(db, account),
        loadAccountNotes(db, account),
    ]);
}

/**
 * Save an Account with all Transactions and Notes
 * this is probably not relevant in action but preserving
 * the example of `db.transaction` from the blog post for now.
 */
export async function saveAccountRelations(
    db: AppDatabase,
    account: Account,
) {
    return db.transaction(
        'rw', db.accounts, db.transactions, db.notes, async () => {

            // Add or update account. If add, record account.id.
            account.gid = await db.accounts.put(account);
            // Some may be new and some may be updates of existing objects.
            // put() will handle both cases.
            // record the result keys from the put() operations
            // into transactionIDs and noteIDs
            // so that we can find local deletes
            let [transactionIDs, noteIDs] = await Promise.all([
                Promise.all(account.transactions.map(transaction => updateTransaction(db, transaction))),
                Promise.all(account.notes.map(note => updateNote(db, note)))
            ]);

            // Was any email or phone number deleted from out navigation properties?
            // Delete any item in DB that reference us, but is not present
            // in our navigation properties:
            await Promise.all([
                db.transactions.where('accountID').equals(account.gid)
                    // Not anymore in our new array, delete
                    .and(transaction => transactionIDs.indexOf(transaction.gid || "") === -1)
                    .delete(),

                db.notes.where('accountID').equals(account.gid)
                    .and(note => noteIDs.indexOf(note.gid || "") === -1)
                    .delete()
            ])
        });
}