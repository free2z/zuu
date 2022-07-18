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

export class Account extends AbstractEntity {
    transactions: Transaction[] = []
    notes: Note[] = []

    constructor(
        public username: string,
        public password: string,
        public seed: string,
        public height: number,
        public datetime: Date,
        public ua: string,
        public za: string,
        public ta: string,
        // balances
        public total: string,
        public spendable: string,
        public transparent: string,
        gid?: string
    ) {
        super(gid)
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
