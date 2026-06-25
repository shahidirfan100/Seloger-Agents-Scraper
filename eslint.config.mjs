import prettier from 'eslint-config-prettier';

import apify from '@apify/eslint-config/js.js';

// eslint-disable-next-line import-x/no-default-export -- ESLint flat config requires a default export
export default [{ ignores: ['**/dist', 'scripts/**'] }, ...apify, prettier];
