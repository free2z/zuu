import cuid from 'cuid'


/**
 * Abstract entity model with `gid` property initialization
 * and `equals` method for entity comparisons.
 */
export abstract class AbstractEntity {
    constructor(public gid?: string) {
        gid ? (this.gid = gid) : (this.gid = cuid());
    }
    equals(e1: AbstractEntity, e2: AbstractEntity) {
        return e1.gid == e2.gid
    }
}

export class Transaction extends AbstractEntity {
    constructor(
        public accountID: string,
        public height: number,
        public datetime: Date,
        public amount: string,
        public txid: string,
        public memo?: string,
        gid?: string,
    ) {
        super(gid)
    }
}

export class Note extends AbstractEntity {
    constructor(
        public accountID: string,
        public height: number,
        public datetime: Date,
        public amount: string,
        gid?: string,
    ) {
        super(gid)
    }
}

export class Account {
    transactions: Transaction[] = []
    notes: Note[] = []


    // CREATE TABLE accounts (
    //     id_account INTEGER PRIMARY KEY,
    //     name TEXT NOT NULL,
    //     seed TEXT,
    //     aindex INTEGER NOT NULL,
    //     sk TEXT,
    //     ivk TEXT NOT NULL UNIQUE,
    //     address TEXT NOT NULL);
    //     taddress TEXT NOT NULL);
    constructor(
        // public username: string,
        public id_account: number,
        public name: string,


        // Free2z?
        // public password: string,
        //
        // Birth, restore
        // public height: number,
        // public datetime: Date,
        //
        public seed: string,
        public sk: string,
        // Sapling
        public ivk: string,
        public address: string,
        // t-addr
        public taddress: string,
        // Orchard
        // public ua: string,

        // balances
        // public total: string,
        // public spendable: string,
        // public transparent: string,
    ) {

        // Define navigation properties.
        // Making them non-enumerable will prevent them from being handled by indexedDB
        // when doing put() or add().
        Object.defineProperties(this, {
            transactions: { value: [], enumerable: false, writable: true },
            notes: { value: [], enumerable: false, writable: true }
        });
    }
}

export interface Accounts extends Array<Account> { }
