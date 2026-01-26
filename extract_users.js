const fs = require('fs');
const path = require('path');

const usersDbPath = path.join(__dirname, 'data', 'users.db');
const outputPath = path.join(__dirname, 'staffData.js');

const targetUsers = ['mummy', 'kaid', 'mayne'];
const foundUsers = [];

const fileStream = fs.createReadStream(usersDbPath, { encoding: 'utf8' });
let buffer = '';

fileStream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    // iterate over all lines except the last one (which might be incomplete)
    for (let i = 0; i < lines.length - 1; i++) {
        processLine(lines[i]);
    }
    // keep the last line in the buffer
    buffer = lines[lines.length - 1];
});

fileStream.on('end', () => {
    if (buffer) {
        processLine(buffer);
    }
    writeOutput();
});

function processLine(line) {
    if (!line.trim()) return;
    try {
        const user = JSON.parse(line);
        if (targetUsers.includes(user.username)) {
            foundUsers.push(user);
        }
    } catch (e) {
        console.error('Error parsing line:', e);
    }
}

function writeOutput() {
    const content = `module.exports = ${JSON.stringify(foundUsers, null, 2)};`;
    fs.writeFileSync(outputPath, content);
    console.log(`Extracted ${foundUsers.length} users to ${outputPath}`);
    console.log('Users found:', foundUsers.map(u => u.username));
}
