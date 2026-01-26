const Datastore = require('nedb-promises');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'users.db');

const usersDb = Datastore.create({
    filename: dbPath,
    autoload: true
});

module.exports = { usersDb };
