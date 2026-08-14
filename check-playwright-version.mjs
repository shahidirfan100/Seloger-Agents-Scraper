import { readFileSync } from 'node:fs';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const dockerMatch = dockerfile.match(/actor-node-playwright-chrome:\d+-(\d+\.\d+\.\d+)/);
const dockerVersion = dockerMatch?.[1];
const packageVersion = packageJson.dependencies?.playwright;

if (!dockerVersion || !packageVersion) {
    throw new Error('Could not determine both Docker and package Playwright versions.');
}

if (dockerVersion !== packageVersion) {
    throw new Error(`Playwright version mismatch: Docker=${dockerVersion}, package=${packageVersion}.`);
}
