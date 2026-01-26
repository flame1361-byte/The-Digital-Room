const { usersDb } = require('../db');

async function grantPremium(username) {
    try {
        console.log(`[UPGRADE] Attempting to grant premium to: ${username}...`);

        const user = await usersDb.findOne({ username });
        if (!user) {
            console.error(`[ERROR] User "${username}" not found.`);
            process.exit(1);
        }

        await usersDb.update({ username }, { $set: { hasPremiumPack: true } });
        console.log(`[SUCCESS] Premium pack granted to ${username}!`);

        // Final check
        const updated = await usersDb.findOne({ username });
        console.log('[DEBUG] Updated user record:', {
            username: updated.username,
            hasPremiumPack: updated.hasPremiumPack
        });

        process.exit(0);
    } catch (err) {
        console.error('[ERROR] Upgrade failed:', err);
        process.exit(1);
    }
}

grantPremium('kaid');
