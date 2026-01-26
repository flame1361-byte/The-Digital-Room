const Datastore = require('nedb-promises');
const path = require('path');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'users.db');

const usersDb = Datastore.create({
    filename: dbPath,
    autoload: true
});

module.exports = { usersDb };
