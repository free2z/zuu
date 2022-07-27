// https://stackabuse.com/a-sqlite-tutorial-with-node-js/

const sqlite3 = require('sqlite3')
const Promise = require('bluebird')

class DB {
    constructor(dbFilePath) {
        this.sqlite = new sqlite3.Database(dbFilePath, (err) => {
            if (err) {
                console.log('Could not connect to database', err)
            } else {
                this.ready = true
                console.log('Connected to database')
            }
        })
    }

    connect() {

    }

    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.sqlite.run(sql, params, function (err) {
                if (err) {
                    console.log('Error running sql ' + sql)
                    console.log(err)
                    reject(err)
                } else {
                    resolve({ id: this.lastID })
                }
            })
        })
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.sqlite.get(sql, params, (err, result) => {
                if (err) {
                    console.log('Error running sql: ' + sql)
                    console.log(err)
                    reject(err)
                } else {
                    // console.log("GET RESULT", result)
                    resolve(result)
                }
            })
        })
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.sqlite.all(sql, params, (err, rows) => {
                if (err) {
                    console.log('Error running sql: ' + sql)
                    console.log(err)
                    reject(err)
                } else {
                    resolve(rows)
                }
            })
        })
    }
}

module.exports = DB
