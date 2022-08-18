
class Transaction {
    constructor(db) {
        this.db = db
    }
    async all() {
        return this.db.all("SELECT * from transactions")
    }
}

module.exports = Transaction;
