// Utilities and examples for working with async Dexie setup
// https://developer.fireflysemantics.com/tasks/tasks--dexie--one-to-many-relationships-with-dexie


import cuid from 'cuid'

import { AppDatabase } from './dexie'
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
 * Read an Account
 * const acc:Account = await readAccount(db, arnold.gid)
 */
export async function readAccount(
    db: AppDatabase,
    GID: string,
): Promise<Account | undefined> {
    return await db.accounts.get(GID)
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
