import fs from 'fs/promises';
import path from 'path';

const configPath = path.join(process.cwd(), 'data', 'mock_ivr_config.json');

// Ensure data dir exists
const ensureDataDir = async () => {
    try {
        await fs.mkdir(path.dirname(configPath), { recursive: true });
    } catch (err) {}
};

export const getConfig = async () => {
    await ensureDataDir();
    try {
        const data = await fs.readFile(configPath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return null;
    }
};

export const saveConfig = async (sixteenDigit, cvv) => {
    await ensureDataDir();
    const config = { sixteenDigit, cvv, updatedAt: new Date().toISOString() };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    return config;
};
