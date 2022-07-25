// TODO: rename to DTO or sth? Not really a model..
// https://stackabuse.com/a-sqlite-tutorial-with-node-js/

class Account {
    constructor(db) {
        this.db = db
    }

    // createTable() {
    //     const sql = `CREATE TABLE IF NOT EXISTS projects (
    //     id INTEGER PRIMARY KEY AUTOINCREMENT,
    //     name TEXT)`
    //     return this.db.run(sql)
    // }
    async all() {
        // console.log("Account.all")
        // console.log("THIS.db", this.db)
        return this.db.all("SELECT * from accounts")
    }

    async getAccount(id) {
        // Could do query but this is easy and there aren't many
        return this.db.get(`
        SELECT accounts.*,
        taddrs.address as taddress
        from accounts
        INNER JOIN taddrs on taddrs.account = accounts.id_account
        WHERE id_account=?
        `, [id])
    }

    async getByName(name) {
        return this.db.get("SELECT * from accounts WHERE name=?", [name])
    }

    async getTransparent(id) {
        return this.db.get("SELECT * from taddrs WHERE account=?", [id])
    }

    // https://www.techonthenet.com/sqlite/alias.php
    // https://github.com/TryGhost/node-sqlite3/issues/443
    // https://learnsql.com/blog/how-to-use-aliases-with-sql-join/
    async allWithT() {
        // taddrs.sk as tsk
        // SK is the same as tsk!
        return this.db.all(`
        SELECT accounts.*,
        taddrs.address as taddress
        from accounts
        INNER JOIN taddrs on taddrs.account = accounts.id_account;`)
    }
}

module.exports = Account;
