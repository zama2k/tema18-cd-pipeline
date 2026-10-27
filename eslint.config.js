'use strict';

// The assignment asks for .eslintrc.json, but ESLint >= 9 only reads flat
// config. FlatCompat loads the legacy file so the rules stay in one place.
const { FlatCompat } = require('@eslint/eslintrc');
const js = require('@eslint/js');
const legacy = require('./.eslintrc.json');

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});

module.exports = [
  { ignores: ['node_modules/', 'coverage/', '.vercel/', 'evidencias/'] },
  ...compat.config(legacy),
];
